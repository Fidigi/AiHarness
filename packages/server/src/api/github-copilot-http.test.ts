import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type ModelCatalog } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('logs in through HTTP without API-key flattening, restarts A/C/R, and observes account withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-copilot-http-master-key', token = 'disposable-copilot-http-token';
  const models = ['claude-fable-5', 'gemini-3.5-flash', 'gpt-5-mini'];
  const fixture = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
    rows: Array<{ model: string; api: string; case: string; expectedPath: string; responseEvents: Array<{ type?: string }> }>;
  };
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
    return new Response(row.responseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (row.responseEvents[0].type ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const file = path.join(dataDir, 'credentials.enc');
    const credentials = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
    await credentials.load();
    for (const reload of [false, true]) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'content-type': 'application/json', authorization: 'Bearer copilot-admin' };
      const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!reload) {
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
      for (const model of models) {
        const response = await post('/api/chat', { provider: 'github-copilot', messages: [{ role: 'user', content: 'probe' }], options: { model, maxTokens: 64, stream: false } });
        expect(response.status).toBe(200); expect(await response.text()).toContain('ok');
        expect(calls.at(-1)).toMatchObject({ url: 'https://api.individual.githubcopilot.com' + fixture.rows.find(row => row.model === model)!.expectedPath,
          authorization: `Bearer ${token}`, apiKey: null, body: { model, stream: true } });
      }
      if (reload) {
        expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
        const response = await post('/api/agent/runs', { cwd, provider: 'github-copilot', model: 'gpt-5-mini', input: 'probe', autoCompaction: false, thinking: 'off' });
        expect(response.status).toBe(202);
        const { run } = await response.json() as { run: { id: string; sessionId: string } };
        await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(response => response.json())).toMatchObject({ phase: 'completed' }));
        const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
        expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'github-copilot', model: 'gpt-5-mini', api: 'openai-responses' }));
        expect(journal).not.toContain(token);
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
        const disconnected = await fetch(base + '/api/provider-registry/auth/github-copilot', { method: 'DELETE', headers });
        expect(disconnected.status).toBe(200);
        const status = await fetch(base + '/api/provider-registry/auth', { headers }).then(response => response.json());
        expect(status).toContainEqual(expect.objectContaining({ type: 'github-copilot', method: 'oauth', configured: false, connected: false }));
      }
      await stop();
    }
    expect(calls).toHaveLength(7);
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
