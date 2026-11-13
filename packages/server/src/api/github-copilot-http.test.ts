import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type MessageContentBlock, type ModelCatalog, type Session } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('logs in through HTTP, restarts private A/C/R tool/final histories and observes account withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-copilot-http-master-key', token = 'disposable-copilot-http-token';
  const models = ['claude-fable-5', 'gemini-3.5-flash', 'gpt-5-mini'];
  const fixture = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
    rows: Array<{ model: string; api: string; case: string; expectedPath: string; responseEvents: Array<{ type?: string }> }>;
  };
  type Item = Record<string, unknown>;
  type PrivateRow = { model: string; api: string; lane: string; seed: { events: Item[]; blocks: MessageContentBlock[] }; cases: Array<{ name: string; body: Item }> };
  const continuation = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-continuation-reference.json', import.meta.url), 'utf8')) as {
    tools: Item[]; rows: PrivateRow[];
  };
  const rows = models.map(model => continuation.rows.find(row => row.model === model && (row.api !== 'openai-completions' || row.lane === 'details'))!);
  const credentialPayload = <T>(value: T, secret: string): T => JSON.parse(JSON.stringify(value)
    .replace(/opaque-copilot-(redacted|c-sensitive-one|sensitive-tail)/gu, (_match, suffix: string) => `opaque-${secret}-copilot-${suffix}`));
  const redacted = <T>(value: T): T => credentialPayload(value, '[REDACTED]');
  const history = (body: Item, api: string): Item[] => {
    const items = body[api === 'openai-responses' ? 'input' : 'messages'] as Item[];
    if (api === 'anthropic-messages') return items;
    // Bind the whole conversational array, not the independently generated host instructions.
    expect(items[0]).toMatchObject({ role: api === 'openai-responses' ? 'developer' : 'system', content: expect.any(String) });
    return items.slice(1);
  };
  const finalEvents = (row: PrivateRow): Item[] => row.seed.events
    .filter(event => row.api === 'anthropic-messages' ? event.index !== row.seed.blocks.findIndex(block => block.type === 'tool_call')
      : row.api !== 'openai-responses' || event.output_index !== row.seed.blocks.findIndex(block => block.type === 'tool_call'))
    .map(event => {
      if (event.type === 'message_delta') return { ...event, delta: { ...(event.delta as Item), stop_reason: 'end_turn' } };
      if (Array.isArray(event.choices)) return { ...event, choices: (event.choices as Item[]).map(choice => {
        const delta = { ...(choice.delta as Item) }; delete delta.tool_calls;
        return { ...choice, delta, finish_reason: choice.finish_reason === 'tool_calls' ? 'stop' : choice.finish_reason };
      }) };
      if (event.type === 'response.completed') return { ...event, response: { ...(event.response as Item),
        output: ((event.response as Item).output as Item[]).filter(item => item.type !== 'function_call') } };
      return event;
    });
  let privateActive = false;
  const turns = new Map<string, number>(), sessions = new Map<string, string>(), marker = path.join(cwd, 'echo-effects');
  const calls: Array<{ url: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> }> = [];
  const oauthRequests: string[] = [];
  const originalFetch = globalThis.fetch;
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master);
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'copilot-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'copilot-admin');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url);
    if (['github.com', 'api.github.com'].includes(new URL(target).hostname) || target.endsWith('githubcopilot.com/models')) {
      oauthRequests.push(target);
      expect(init?.redirect).toBe('manual');
      if (target === 'https://github.com/login/device/code') return Response.json({ device_code: 'private-http-device', user_code: 'HTTP-CODE', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 });
      if (target === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'disposable-github-grant' });
      if (target === 'https://api.github.com/copilot_internal/v2/token') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer disposable-github-grant');
        return Response.json({ token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      expect(target).toBe('https://api.individual.githubcopilot.com/models');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Response.json({ data: models.map(id => ({ id, model_picker_enabled: true })) });
    }
    if (new URL(target).hostname !== 'api.individual.githubcopilot.com') return originalFetch(url, init);
    const body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization'), apiKey: headers.get('x-api-key'), body });
    const row = fixture.rows.find(row => row.model === body.model && row.case === 'user')!;
    let events: Array<{ type?: unknown }> = row.responseEvents;
    if (privateActive) {
      const selected = rows.find(row => row.model === body.model)!;
      const turn = (turns.get(selected.model) ?? 0) + 1; turns.set(selected.model, turn);
      if (turn < 3) events = credentialPayload(turn === 1 ? selected.seed.events : finalEvents(selected), token);
    }
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (events[0].type ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const extensions = path.join(cwd, '.ai-harness', 'extensions'); await mkdir(extensions, { recursive: true });
    await writeFile(path.join(extensions, 'echo.mjs'), `import { appendFile } from 'node:fs/promises';
      export default api => api.registerTool({ ...${JSON.stringify(continuation.tools[0])}, execute: async input => {
        if (input.x !== 1) throw new Error('Invalid fixture input.');
        await appendFile(${JSON.stringify(marker)}, 'effect\\n'); return { content: 'result' };
      } });`);
    const file = path.join(dataDir, 'credentials.enc');
    const credentials = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
    await credentials.load();
    for (const generation of [0, 1, 2]) {
      privateActive = false;
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'content-type': 'application/json', authorization: 'Bearer copilot-admin' };
      const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
      if (generation === 0) {
        const authBefore = await fetch(base + '/api/provider-registry/auth', { headers }).then(response => response.json());
        expect(authBefore).toContainEqual(expect.objectContaining({ type: 'github-copilot', method: 'oauth', configured: false }));
        expect((await fetch(base + '/api/provider-registry/auth/github-copilot/oauth', { method: 'POST', headers: { ...headers, authorization: 'Bearer copilot-user' } })).status).toBe(403);
        expect((await fetch(base + '/api/provider-registry/auth/github-copilot/oauth', { method: 'POST', headers: { ...headers, origin: 'https://unrelated.example' } })).status).toBe(403);
        expect(oauthRequests).toEqual([]);
        const login = await post('/api/provider-registry/auth/github-copilot/oauth', {});
        expect(login.status).toBe(201); expect(login.headers.get('cache-control')).toBe('no-store');
        const flow = await login.json() as { id: string; state: string; userCode: string };
        expect(flow).toMatchObject({ state: 'pending', userCode: 'HTTP-CODE' });
        expect(JSON.stringify(flow)).not.toContain('private-http-device');
        await vi.waitFor(async () => {
          const status = await fetch(base + '/api/provider-registry/auth/oauth/' + flow.id, { headers }).then(response => response.json()) as { state: string };
          expect(status.state).toBe('connected'); expect(JSON.stringify(status)).not.toContain(token);
        }, { timeout: 2500 });
        const reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); await reader.load();
        expect((await reader.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' }))?.credential).toMatchObject({
          accessToken: token, refreshToken: 'disposable-github-grant', subscription: { provider: 'github-copilot', availableModelIds: models },
        });
      }
      const catalog = await fetch(base + '/api/models', { headers }).then(response => response.json()) as ModelCatalog;
      const copilot = catalog.providers.find(row => row.provider === 'github-copilot')!;
      expect(copilot).toBeDefined();
      expect(copilot.models.filter((row: { available: boolean }) => row.available).map((row: { id: string }) => row.id)).toEqual(models);
      expect(JSON.stringify(copilot)).not.toContain(token);
      const auth = await fetch(base + '/api/provider-registry/auth', { headers }).then(response => response.json());
      expect(auth).toContainEqual(expect.objectContaining({ type: 'github-copilot', method: 'oauth', configured: true, connected: true }));
      expect(JSON.stringify(auth)).not.toContain(token);
      expect((await post('/api/config', { type: 'github-copilot', apiKey: 'disposable-forbidden-api-key' })).status).toBe(400);
      expect((await post('/api/provider-registry/custom', { id: 'github-copilot', name: 'Forged subscription', dialect: 'openai',
        baseUrl: 'https://unrelated.example', apiKey: 'disposable-forbidden-api-key' })).status).toBe(400);
      expect((await fetch(base + '/api/provider-registry/auth/github-copilot', { method: 'DELETE', headers: { ...headers, authorization: 'Bearer copilot-user' } })).status).toBe(403);
      if (generation < 2) for (const model of models) {
        const response = await post('/api/chat', { provider: 'github-copilot', messages: [{ role: 'user', content: 'probe' }], options: { model, maxTokens: 64, stream: false } });
        expect(response.status).toBe(200); expect(await response.text()).toContain('ok');
        expect(calls.at(-1)).toMatchObject({ url: 'https://api.individual.githubcopilot.com' + fixture.rows.find(row => row.model === model)!.expectedPath,
          authorization: `Bearer ${token}`, apiKey: null, body: { model, stream: true } });
      }
      if (generation === 1) {
        expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
        const response = await post('/api/agent/runs', { cwd, provider: 'github-copilot', model: 'gpt-5-mini', input: 'probe', autoCompaction: false, thinking: 'off' });
        expect(response.status).toBe(202);
        const { run } = await response.json() as { run: { id: string; sessionId: string } };
        await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(response => response.json())).toMatchObject({ phase: 'completed' }));
        const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
        expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'github-copilot', model: 'gpt-5-mini', api: 'openai-responses' }));
        expect(journal).not.toContain(token);
      }
      if (generation > 0) {
        expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
        if (generation === 1) expect((await post('/api/plugins/reload', { cwd })).status).toBe(200);
        privateActive = true;
        for (const row of rows) {
          const blocks = redacted(row.seed.blocks), finalBlocks = blocks.filter(block => block.type !== 'tool_call');
          const sessionId = sessions.get(row.model);
          if (generation === 2) {
            const loaded = await fetch(base + '/api/sessions/' + sessionId, { headers }).then(response => response.json()) as Session;
            expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([blocks, finalBlocks]);
          }
          const before = calls.length;
          const response = await post('/api/agent/runs', { cwd, provider: 'github-copilot', model: row.model,
            input: generation === 1 ? 'probe' : 'continue', ...(sessionId ? { sessionId } : {}), autoCompaction: false, thinking: 'off' });
          expect(response.status).toBe(202);
          const { run } = await response.json() as { run: { id: string; sessionId: string } }; sessions.set(row.model, run.sessionId);
          await vi.waitFor(async () => expect(await fetch(base + '/api/agent/runs/' + run.id, { headers }).then(response => response.json())).toMatchObject({ phase: 'completed' }));
          expect(calls).toHaveLength(before + (generation === 1 ? 2 : 1));
          const expected = redacted(history(row.cases.find(item => item.name === 'same')!.body, row.api));
          const assistant = structuredClone(expected.find(item => item.role === 'assistant') ?? {});
          if (row.api === 'anthropic-messages') assistant.content = (assistant.content as Item[]).filter(item => item.type !== 'tool_use');
          else delete assistant.tool_calls;
          const final = row.api === 'openai-responses' ? expected.slice(1, -1).filter(item => item.type !== 'function_call') : [assistant];
          const user = { ...expected[0], content: row.api === 'openai-responses' ? [{ type: 'input_text', text: 'continue' }] : 'continue' };
          const expectedHistory = structuredClone(generation === 1 ? expected : [...expected, ...final, user]);
          if (row.api === 'anthropic-messages') {
            // The reference uses cache:none; the unmodified host adds short cache to its final user block.
            const last = expectedHistory.at(-1)!;
            if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
            (last.content as Item[]).at(-1)!.cache_control = { type: 'ephemeral' };
          }
          expect(history(calls.at(-1)!.body, row.api)).toEqual(expectedHistory);
          for (const call of calls.slice(before)) expect(call).toMatchObject({ authorization: `Bearer ${token}`, apiKey: null,
            url: 'https://api.individual.githubcopilot.com' + fixture.rows.find(item => item.model === row.model)!.expectedPath });
          const sessionFile = path.join(dataDir, 'sessions', run.sessionId + '.jsonl'), journal = await readFile(sessionFile, 'utf8');
          const messages = journal.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message');
          expect(messages.filter(message => message.role === 'assistant').map(message => message.blocks).slice(0, 2)).toEqual([blocks, finalBlocks]);
          expect(messages.filter(message => message.role === 'assistant')).toHaveLength(generation === 1 ? 2 : 3);
          if (generation === 2) expect(messages.filter(message => message.role === 'assistant').at(-1)).toMatchObject({
            content: 'ok', provider: 'github-copilot', api: row.api, model: row.model,
          });
          expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', provider: 'github-copilot', api: row.api, model: row.model, blocks }));
          expect(messages).toContainEqual(expect.objectContaining({ role: 'tool', name: 'echo', content: 'result', toolCallId: row.seed.blocks.find(block => block.type === 'tool_call')!.id }));
          expect(journal).not.toContain(token); expect(journal).toContain('opaque-[REDACTED]-copilot'); expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
          for (const complete of [false, true]) {
            const exported = await fetch(base + '/api/sessions/' + run.sessionId + '/export?format=json' + (complete ? '&includeOpaqueContinuations=true' : ''), { headers });
            expect(exported.status).toBe(200); expect(exported.headers.get('cache-control')).toBe('no-store');
            expect(Boolean(exported.headers.get('x-aiharness-export-warning'))).toBe(!complete);
            const text = await exported.text(); expect(text).not.toContain(token); expect(text.includes('opaque-')).toBe(complete);
            expect(await readFile(sessionFile, 'utf8')).toBe(journal);
          }
        }
        expect(await readFile(marker, 'utf8')).toBe('effect\neffect\neffect\n');
      }
      if (generation === 2) {
        // A different store writer withdraws access; a cached successful catalogue is not authority.
        await credentials.delete('github-copilot');
        const withdrawn = await fetch(base + '/api/models', { headers }).then(response => response.json()) as ModelCatalog;
        expect(withdrawn.providers.find(row => row.provider === 'github-copilot')!.models.every(row => !row.available)).toBe(true);
        const before = calls.length;
        const denied = await post('/api/chat', { provider: 'github-copilot', messages: [{ role: 'user', content: 'probe' }], options: { model: 'gpt-5-mini', stream: false } });
        // This legacy route always uses SSE: failure is terminal error, not an HTTP status after headers.
        expect(denied.status).toBe(200);
        const deniedEvents = await denied.text();
        expect(deniedEvents).toContain('event: error');
        expect(deniedEvents).not.toContain('event: message_end');
        expect(deniedEvents).not.toContain(token);
        expect(calls).toHaveLength(before);
        for (const row of rows) {
          const response = await post('/api/agent/runs', { cwd, sessionId: sessions.get(row.model), provider: 'github-copilot', model: row.model,
            input: 'withdrawn', autoCompaction: false, maxRetries: 0 });
          expect(response.status).toBe(202); const { run } = await response.json() as { run: { id: string } };
          await vi.waitFor(async () => expect(await fetch(base + '/api/agent/runs/' + run.id, { headers }).then(response => response.json())).toMatchObject({ phase: 'failed' }));
          const journal = await readFile(path.join(dataDir, 'sessions', sessions.get(row.model)! + '.jsonl'), 'utf8');
          expect(journal.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.role === 'assistant')).toHaveLength(3);
        }
        expect(calls).toHaveLength(before); expect(await readFile(marker, 'utf8')).toBe('effect\neffect\neffect\n');
        const disconnected = await fetch(base + '/api/provider-registry/auth/github-copilot', { method: 'DELETE', headers });
        expect(disconnected.status).toBe(200);
        const status = await fetch(base + '/api/provider-registry/auth', { headers }).then(response => response.json());
        expect(status).toContainEqual(expect.objectContaining({ type: 'github-copilot', method: 'oauth', configured: false, connected: false }));
      }
      await stop();
    }
    expect(calls).toHaveLength(16);
    expect(oauthRequests).toEqual(['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token',
      'https://api.github.com/copilot_internal/v2/token', 'https://api.individual.githubcopilot.com/models']);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain(token);
  } finally { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);

it.each(['logout', 'shutdown', 'request-cancel'] as const)('retires held HTTP login on %s without a late encrypted publication', async mutation => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-http-retire-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-copilot-retirement-master';
  let reached!: () => void, release!: (response: Response) => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<Response>(resolve => { release = resolve; });
  const originalFetch = globalThis.fetch;
  let issuerSignal: AbortSignal | null | undefined;
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master);
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'copilot-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'copilot-admin');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url);
    if (target === 'https://github.com/login/device/code') {
      if (mutation === 'request-cancel') { issuerSignal = init?.signal; reached(); return held; }
      return Response.json({ device_code: 'private-held-device', user_code: 'HELD-CODE', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 });
    }
    if (target === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'disposable-held-grant' });
    if (target === 'https://api.github.com/copilot_internal/v2/token') return Response.json({ token: 'disposable-held-token', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (target === 'https://api.individual.githubcopilot.com/models') { reached(); return held; }
    return originalFetch(url, init);
  });
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    const base = `http://127.0.0.1:${server.port}`, headers = { authorization: 'Bearer copilot-admin' };
    const caller = new AbortController();
    const pending = fetch(base + '/api/provider-registry/auth/github-copilot/oauth', { method: 'POST', headers, signal: caller.signal });
    let flow: { id: string } | undefined;
    if (mutation === 'request-cancel') {
      await started;
      caller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(issuerSignal?.aborted).toBe(true));
    } else {
      const login = await pending; expect(login.status).toBe(201);
      flow = await login.json() as { id: string };
      await started;
    }
    if (mutation === 'logout') {
      const logout = await fetch(base + '/api/provider-registry/auth/github-copilot', { method: 'DELETE', headers });
      expect(logout.status).toBe(200);
      expect(await logout.json()).toMatchObject({ connected: false });
      const cancelled = await fetch(base + '/api/provider-registry/auth/oauth/' + flow!.id, { headers }).then(response => response.json()) as { state: string };
      expect(cancelled.state).toBe('cancelled');
    } else if (mutation === 'shutdown') await stop();
    release(Response.json(mutation === 'request-cancel'
      ? { device_code: 'private-held-device', user_code: 'HELD-CODE', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 }
      : { data: [{ id: 'gpt-5-mini', model_picker_enabled: true }] }));
    // Restart through the real composition root, not a cached service descriptor.
    await stop();
    const restarted = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    const statuses = await fetch(`http://127.0.0.1:${restarted.port}/api/provider-registry/auth`, { headers }).then(response => response.json());
    expect(statuses).toContainEqual(expect.objectContaining({ type: 'github-copilot', configured: false, connected: false }));
    const reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(dataDir, 'credentials.enc'), master) });
    await reader.load();
    expect(await reader.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
  } finally {
    release(Response.json({ data: [] }));
    await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 15000);
