import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type ModelCatalog, type Session } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('owns native Codex HTTP login, encrypted restart/refresh, CX private tool/final replay and account withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-codex-http-master', model = 'gpt-6.1-sol', account = 'codex-http-account';
  const token = (signature: string) => 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url') + '.' + signature;
  let access = token('c2ln'), refreshes = 0;
  const events = JSON.parse(await readFile(new URL('../../../../tests/fixtures/openai-codex-reference.json', import.meta.url), 'utf8')).responseEvents as unknown[];
  const replay = JSON.parse(await readFile(new URL('../../../../tests/fixtures/codex-continuation-reference.json', import.meta.url), 'utf8')) as {
    events: Array<Record<string, unknown>>; finalEvents: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
    rows: Array<{ model: string; firstObserved: { content: Array<Record<string, unknown>> }; projections: Array<{ case: string; expected: Array<Record<string, unknown>> }> }>;
  };
  const row = replay.rows.find(row => row.model === model)!;
  const redacted = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('opaque-sensitive-tail', 'opaque-[REDACTED]-tail'));
  const exact = redacted(row.projections.find(projection => projection.case === 'exact')!.expected), toolInput = exact.slice(0, -1);
  const finalInput = exact.slice(1, -2).filter(item => item.type !== 'function_call');
  const blocks = redacted(row.firstObserved.content.map(block => block.type === 'thinking'
    ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
    : block.type === 'text' ? block : { type: 'tool_call', id: block.id, name: block.name, input: block.arguments }));
  const finalEvents = replay.events.filter(event => !String(event.type).includes('function_call_arguments') && (event.item as { type?: string } | undefined)?.type !== 'function_call')
    .map(event => event.type === 'response.completed' ? { ...event, response: { ...(event.response as object), output: replay.items.filter(item => item.type !== 'function_call') } } : event);
  let privateActive = false, privateTurns = 0, sessionId: string | undefined;
  const marker = path.join(cwd, 'echo-effects');
  const calls: Array<{ url: string; method: string; body: string; authorization: string | null; account: string | null; apiKey: string | null }> = [];
  const responses = () => calls.filter(call => call.url.endsWith('/responses'));
  const originalFetch = globalThis.fetch;
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'codex-http-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'codex-http-admin');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    if (!['auth.openai.com', 'chatgpt.com'].includes(target.hostname)) return originalFetch(url, init);
    const headers = new Headers(init?.headers), body = String(init?.body ?? '');
    calls.push({ url: target.href, method: init?.method ?? 'GET', body, authorization: headers.get('authorization'), account: headers.get('chatgpt-account-id'), apiKey: headers.get('x-api-key') });
    if (target.pathname.endsWith('/usercode')) return Response.json({ device_auth_id: 'private-http-device', user_code: 'HTTP-CODE', interval: 1 });
    if (target.pathname.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'private-http-code', code_verifier: 'private-http-verifier' });
    if (target.pathname === '/oauth/token') {
      if (new URLSearchParams(body).get('grant_type') === 'refresh_token') { refreshes++; access = token('cm90YXRlZA'); }
      return Response.json({ access_token: access, refresh_token: 'private-http-refresh-' + refreshes, expires_in: 3600 });
    }
    expect(headers.get('authorization')).toBe(`Bearer ${access}`); expect(headers.get('chatgpt-account-id')).toBe(account); expect(headers.get('x-api-key')).toBeNull();
    if (target.pathname.endsWith('/models')) return Response.json({ models: [{ slug: model, visibility: 'list' }, { slug: 'gpt-5.5', visibility: 'hide' }] });
    expect(target.href).toBe('https://chatgpt.com/backend-api/codex/responses'); expect(JSON.parse(body)).toMatchObject({ model, stream: true, store: false });
    const selected = !privateActive ? events : privateTurns++ === 0 ? replay.events : privateTurns === 2 ? finalEvents : replay.finalEvents;
    const frames = JSON.stringify(selected).replaceAll('opaque-sensitive-tail', 'opaque-' + access + '-tail');
    return new Response((JSON.parse(frames) as unknown[]).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const extensions = path.join(cwd, '.ai-harness', 'extensions'); await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, 'echo.mjs'), `import { appendFile } from 'node:fs/promises';
      export default api => api.registerTool({ ...${JSON.stringify(replay.tools[0])}, execute: async input => {
        if (input.x !== 1) throw new Error('Invalid fixture input.');
        await appendFile(${JSON.stringify(marker)}, 'effect\\n'); return { content: 'result' };
      } });`);
    const file = path.join(dataDir, 'credentials.enc'), reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); await reader.load();
    for (const generation of [0, 1, 2]) {
      const restart = generation > 0; privateActive = false;
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { authorization: 'Bearer codex-http-admin', 'content-type': 'application/json' };
      const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!restart) {
        const auth = await fetch(base + '/api/provider-registry/auth', { headers }).then(response => response.json());
        expect(auth).toContainEqual(expect.objectContaining({ type: 'openai-codex', method: 'oauth', configured: false }));
        for (const denied of [{ authorization: 'Bearer codex-http-user' }, { origin: 'https://unrelated.example' }]) {
          expect((await fetch(base + '/api/provider-registry/auth/openai-codex/oauth', { method: 'POST', headers: { ...headers, ...denied } })).status).toBe(403);
        }
        expect(calls).toEqual([]);
        expect((await post('/api/provider-registry/auth/openai-codex/oauth', { method: 'unknown' })).status).toBe(400);
        const browserResponse = await post('/api/provider-registry/auth/openai-codex/oauth', { method: 'browser', redirectUri: 'https://unrelated.example/callback' });
        expect(browserResponse.status).toBe(201); expect(browserResponse.headers.get('cache-control')).toBe('no-store');
        const browser = await browserResponse.json() as { id: string; authorizationUrl: string };
        const authorization = new URL(browser.authorizationUrl); expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
        const redirectRoute = '/api/provider-registry/auth/oauth/' + browser.id + '/redirect';
        for (const denied of [{ authorization: 'Bearer codex-http-user' }, { origin: 'https://unrelated.example' }]) {
          expect((await fetch(base + redirectRoute, { method: 'POST', headers: { ...headers, ...denied }, body: JSON.stringify({ redirectUrl: 'bare-code' }) })).status).toBe(403);
        }
        expect((await post(redirectRoute, { redirectUrl: 'bare-code' })).status).toBe(400);
        expect((await post(redirectRoute, { redirectUrl: 'bare-code', tokenUrl: 'https://unrelated.example/token' })).status).toBe(400);
        expect(await fetch(base + '/api/provider-registry/auth/oauth/' + browser.id, { headers }).then(response => response.json())).toMatchObject({ state: 'pending' });
        expect(calls).toEqual([]);
        const response = await post('/api/provider-registry/auth/openai-codex/oauth', {}); expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
        const flow = await response.json() as { id: string; state: string; userCode: string; verificationUri: string };
        expect(flow).toMatchObject({ state: 'pending', userCode: 'HTTP-CODE', verificationUri: 'https://auth.openai.com/codex/device' });
        expect(JSON.stringify(flow)).not.toContain('private-http-device');
        await vi.waitFor(async () => expect(await fetch(base + '/api/provider-registry/auth/oauth/' + flow.id, { headers }).then(response => response.json())).toMatchObject({ state: 'connected' }));
        expect(calls).toHaveLength(3); // Login is not catalogue discovery or inference.
        expect(await fetch(base + '/api/provider-registry/auth/oauth/' + browser.id, { headers }).then(response => response.json())).toMatchObject({ state: 'cancelled' });
        expect((await post(redirectRoute, { redirectUrl: 'bare-code' })).status).toBe(409);
        const replacement = await post('/api/provider-registry/auth/openai-codex/oauth', { method: 'browser' }).then(response => response.json()) as { id: string; authorizationUrl: string };
        const returned = 'http://localhost:1455/auth/callback?code=private-http-browser-code&state=' + new URL(replacement.authorizationUrl).searchParams.get('state');
        const completed = await post('/api/provider-registry/auth/oauth/' + replacement.id + '/redirect', { redirectUrl: returned });
        expect(completed.status).toBe(200); expect(completed.headers.get('cache-control')).toBe('no-store');
        expect(await completed.json()).toMatchObject({ state: 'connected' }); expect(calls).toHaveLength(4);
        expect(Object.fromEntries(new URLSearchParams(calls[3]!.body))).toMatchObject({ grant_type: 'authorization_code', code: 'private-http-browser-code', redirect_uri: 'http://localhost:1455/auth/callback' });
      }
      const catalog = await fetch(base + '/api/models', { headers }).then(response => response.json()) as ModelCatalog;
      if (restart) expect(refreshes).toBe(1);
      expect(catalog.providers.find(row => row.provider === 'openai-codex')?.models.filter(row => row.available).map(row => row.id)).toEqual([model]);
      expect((await post('/api/config', { type: 'openai-codex', apiKey: 'forbidden-key' })).status).toBe(400);
      expect((await post('/api/provider-registry/custom', { id: 'openai-codex', name: 'Forged native', dialect: 'openai', baseUrl: 'https://unrelated.example', apiKey: 'forbidden-key' })).status).toBe(400);
      const reply = await post('/api/chat', { provider: 'openai-codex', messages: [{ role: 'user', content: 'probe' }], options: { model, stream: false } });
      expect(reply.status).toBe(200); expect(await reply.text()).toContain('ok');
      if (restart) {
        expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
        if (generation === 1) {
          expect((await post('/api/plugins/reload', { cwd })).status).toBe(200);
        } else {
          const saved = await fetch(base + '/api/sessions/' + sessionId, { headers }).then(response => response.json()) as Session;
          expect(saved.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([blocks, blocks.filter(block => block.type !== 'tool_call')]);
        }
        privateActive = true; const before = responses().length;
        const response = await post('/api/agent/runs', { cwd, provider: 'openai-codex', model, input: generation === 1 ? 'probe' : 'continue',
          ...(sessionId ? { sessionId } : {}), thinking: 'off', autoCompaction: false });
        expect(response.status).toBe(202); const { run } = await response.json() as { run: { id: string; sessionId: string } }; sessionId = run.sessionId;
        await vi.waitFor(async () => expect(await fetch(base + '/api/agent/runs/' + run.id, { headers }).then(response => response.json())).toMatchObject({ phase: 'completed' }));
        expect(await readFile(marker, 'utf8')).toBe('effect\n');
        expect(responses()).toHaveLength(before + (generation === 1 ? 2 : 1));
        if (generation === 1) {
          expect(JSON.parse(responses()[before]!.body).tools).toContainEqual(expect.objectContaining({ type: 'function', name: 'echo' }));
          expect(JSON.parse(responses().at(-1)!.body).input).toEqual(toolInput);
        } else expect(JSON.parse(responses().at(-1)!.body).input).toEqual([...toolInput, ...finalInput, exact.at(-1)]);
        const sessionFile = path.join(dataDir, 'sessions', run.sessionId + '.jsonl'), journal = await readFile(sessionFile, 'utf8');
        const messages = journal.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message');
        expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', provider: 'openai-codex', api: 'openai-codex-responses', model, blocks }));
        expect(messages).toContainEqual(expect.objectContaining({ role: 'tool', toolCallId: 'call_native|fc_native', content: 'result' }));
        expect(messages.filter(message => message.role === 'assistant')).toHaveLength(generation === 1 ? 2 : 3);
        expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
        expect(journal).not.toContain(access); expect(journal).toContain('opaque-[REDACTED]-tail');
        for (const complete of [false, true]) {
          const exported = await fetch(base + '/api/sessions/' + sessionId + '/export?format=json' + (complete ? '&includeOpaqueContinuations=true' : ''), { headers });
          expect(exported.status).toBe(200); expect(exported.headers.get('cache-control')).toBe('no-store');
          expect(Boolean(exported.headers.get('x-aiharness-export-warning'))).toBe(!complete);
          const text = await exported.text(); expect(text).not.toContain(access); expect(text.includes('opaque-')).toBe(complete);
          expect(text.includes('textSignature')).toBe(complete); expect(text).toContain('visible thought');
          expect(await readFile(sessionFile, 'utf8')).toBe(journal);
        }
        if (generation === 1) { await stop(); continue; }
        await reader.delete('openai-codex');
        const withdrawn = await fetch(base + '/api/models', { headers }).then(response => response.json()) as ModelCatalog;
        expect(withdrawn.providers.find(row => row.provider === 'openai-codex')?.models.every(row => !row.available)).toBe(true);
        const count = calls.length, denied = await post('/api/chat', { provider: 'openai-codex', messages: [{ role: 'user', content: 'probe' }], options: { model } });
        const text = await denied.text(); expect(text).toContain('event: error'); expect(text).not.toContain('event: message_end'); expect(calls).toHaveLength(count);
        const failed = await post('/api/agent/runs', { sessionId, cwd, provider: 'openai-codex', model, input: 'withdrawn', autoCompaction: false, maxRetries: 0 });
        expect(failed.status).toBe(202); const { run: deniedRun } = await failed.json() as { run: { id: string } };
        await vi.waitFor(async () => expect(await fetch(base + '/api/agent/runs/' + deniedRun.id, { headers }).then(response => response.json())).toMatchObject({ phase: 'failed' }));
        expect(calls).toHaveLength(count); expect(await readFile(marker, 'utf8')).toBe('effect\n');
        expect((await fetch(base + '/api/provider-registry/auth/openai-codex', { method: 'DELETE', headers })).status).toBe(200);
        expect(await fetch(base + '/api/provider-registry/auth', { headers }).then(response => response.json())).toContainEqual(expect.objectContaining({ type: 'openai-codex', connected: false }));
      } else {
        const current = await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' });
        expect(current?.credential.type).toBe('oauth');
        if (current?.credential.type !== 'oauth') throw new Error('Missing fixture OAuth record.');
        await reader.setOAuth('openai-codex', { ...current.credential, expiresAt: 1 });
      }
      await stop();
    }
    expect(responses()).toHaveLength(6); expect(privateTurns).toBe(3);
    expect((await stat(file)).mode & 0o777).toBe(0o600); expect(await readFile(file, 'utf8')).not.toContain('private-http-refresh');
  } finally { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);

it.each(['token', 'catalogue'] as const)('retires Codex HTTP refresh at held %s without undoing committed credentials', async stage => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-http-cancel-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-codex-http-cancel-master', model = 'gpt-6.1-sol', account = 'codex-http-cancel-account', initialRefresh = 'disposable-codex-refresh-original';
  const token = (generation: number) => 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url') + '.' + Buffer.from('rotation-' + generation).toString('base64url');
  const tokenUrl = 'https://auth.openai.com/oauth/token', modelsUrl = 'https://chatgpt.com/backend-api/codex/models?client_version=0.167.2', responsesUrl = 'https://chatgpt.com/backend-api/codex/responses';
  const events = JSON.parse(await readFile(new URL('../../../../tests/fixtures/openai-codex-reference.json', import.meta.url), 'utf8')).responseEvents as unknown[];
  let reached!: () => void, release!: (response: Response) => void;
  const started = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
  let hold = false, refreshes = 0, issuerSignal: AbortSignal | null | undefined;
  const calls: string[] = [], originalFetch = globalThis.fetch;
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'codex-http-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'codex-http-admin');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url);
    if (!['auth.openai.com', 'chatgpt.com'].includes(new URL(target).hostname)) return originalFetch(url, init);
    calls.push(target);
    if (target === tokenUrl) {
      expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', refresh_token: initialRefresh });
      refreshes++;
      if (hold && stage === 'token') { issuerSignal = init?.signal; reached(); return held; }
      return Response.json({ access_token: token(refreshes), refresh_token: 'disposable-codex-refresh-' + refreshes, expires_in: 3600 });
    }
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + token(refreshes)); expect(headers.get('chatgpt-account-id')).toBe(account); expect(headers.get('x-api-key')).toBeNull();
    if (target === modelsUrl) {
      expect(init?.method).toBe('GET');
      if (hold && stage === 'catalogue') { issuerSignal = init?.signal; reached(); return held; }
      return Response.json({ models: [{ slug: model, visibility: 'list' }] });
    }
    expect(target).toBe(responsesUrl); expect(JSON.parse(String(init?.body))).toMatchObject({ model, stream: true, store: false });
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const file = path.join(dataDir, 'credentials.enc'), reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
    await reader.setOAuth('openai-codex', { accessToken: token(0), refreshToken: initialRefresh, expiresAt: Date.now() + 3_600_000,
      subscription: { provider: 'openai-codex', accountId: account } });
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    const base = `http://127.0.0.1:${server.port}`, headers = { authorization: 'Bearer codex-http-admin', 'content-type': 'application/json' };
    expect((await fetch(base + '/api/models', { headers })).status).toBe(200); expect(refreshes).toBe(0); expect(calls.length).toBeGreaterThan(0); expect(calls.every(url => url === modelsUrl)).toBe(true);
    const initialCalls = calls.length, current = await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex', now: 0 });
    if (current?.credential.type !== 'oauth') throw new Error('Missing fixture credential.');
    await reader.setOAuth('openai-codex', { ...current.credential, expiresAt: Date.now() - 1000 });
    const expired = await readFile(file), caller = new AbortController(); hold = true;
    const chat = (signal?: AbortSignal) => fetch(base + '/api/chat', { method: 'POST', headers, signal,
      body: JSON.stringify({ provider: 'openai-codex', messages: [{ role: 'user', content: 'probe' }], options: { model } }) });
    const response = await chat(caller.signal); expect(response.status).toBe(200);
    const output = response.text().catch((error: unknown) => error); await started;
    const boundary = await readFile(file), committed = await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex', now: 0 });
    expect(committed?.credential).toMatchObject({ type: 'oauth', accessToken: token(stage === 'token' ? 0 : 1),
      refreshToken: stage === 'token' ? initialRefresh : 'disposable-codex-refresh-1', subscription: { provider: 'openai-codex', accountId: account } });
    if (stage === 'token') expect(boundary).toEqual(expired); else expect(boundary).not.toEqual(expired);
    caller.abort(); expect(await output).toMatchObject({ name: 'AbortError' }); await vi.waitFor(() => expect(issuerSignal?.aborted).toBe(true));
    const late = Response.json(stage === 'token' ? { access_token: token(1), refresh_token: 'disposable-codex-refresh-1', expires_in: 3600 }
      : { models: [{ slug: model, visibility: 'list' }] });
    const cancelled = vi.spyOn(late.body!, 'cancel'); release(late);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1)); expect(await readFile(file)).toEqual(boundary);
    expect(calls.slice(initialCalls)).toEqual(stage === 'token' ? [tokenUrl] : [tokenUrl, modelsUrl]);
    hold = false;
    const resumed = await chat(); expect(resumed.status).toBe(200); const text = await resumed.text();
    expect(text).toContain('event: message_end'); expect(text).toContain('"content":"ok"'); expect(text).not.toContain('event: error');
    expect(refreshes).toBe(stage === 'token' ? 2 : 1);
    expect(calls.slice(initialCalls)).toEqual(stage === 'token' ? [tokenUrl, tokenUrl, modelsUrl, responsesUrl] : [tokenUrl, modelsUrl, modelsUrl, responsesUrl]);
    const durable = await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex', now: 0 });
    expect(durable?.credential).toMatchObject({ type: 'oauth', accessToken: token(refreshes), refreshToken: 'disposable-codex-refresh-' + refreshes, subscription: { provider: 'openai-codex', accountId: account } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    for (const secret of [token(0), token(1), token(2), initialRefresh, 'disposable-codex-refresh-1', 'disposable-codex-refresh-2']) {
      expect(text).not.toContain(secret); expect(await readFile(file, 'utf8')).not.toContain(secret);
    }
  } finally {
    release(Response.json({})); await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 15000);
