import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type ModelCatalog } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('owns native Codex HTTP login, encrypted restart/refresh, CX inference/journal and account withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-codex-http-master', model = 'gpt-6.1-sol', account = 'codex-http-account';
  const token = (signature: string) => 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url') + '.' + signature;
  let access = token('c2ln'), refreshes = 0;
  const events = JSON.parse(await readFile(new URL('../../../../tests/fixtures/openai-codex-reference.json', import.meta.url), 'utf8')).responseEvents as unknown[];
  const calls: Array<{ url: string; method: string; body: string; authorization: string | null; account: string | null; apiKey: string | null }> = [];
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
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    await mkdir(cwd); await mkdir(dataDir);
    const file = path.join(dataDir, 'credentials.enc'), reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); await reader.load();
    for (const restart of [false, true]) {
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
        const response = await post('/api/provider-registry/auth/openai-codex/oauth', {}); expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
        const flow = await response.json() as { id: string; state: string; userCode: string; verificationUri: string };
        expect(flow).toMatchObject({ state: 'pending', userCode: 'HTTP-CODE', verificationUri: 'https://auth.openai.com/codex/device' });
        expect(JSON.stringify(flow)).not.toContain('private-http-device');
        await vi.waitFor(async () => expect(await fetch(base + '/api/provider-registry/auth/oauth/' + flow.id, { headers }).then(response => response.json())).toMatchObject({ state: 'connected' }));
        expect(calls).toHaveLength(3); // Login is not catalogue discovery or inference.
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
        const response = await post('/api/agent/runs', { cwd, provider: 'openai-codex', model, input: 'probe', thinking: 'off', autoCompaction: false });
        expect(response.status).toBe(202); const { run } = await response.json() as { run: { id: string; sessionId: string } };
        await vi.waitFor(async () => expect(await fetch(base + '/api/agent/runs/' + run.id, { headers }).then(response => response.json())).toMatchObject({ phase: 'completed' }));
        const journal = await readFile(path.join(dataDir, 'sessions', run.sessionId + '.jsonl'), 'utf8');
        expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'openai-codex', api: 'openai-codex-responses', model }));
        expect(journal).not.toContain(access);
        await reader.delete('openai-codex');
        const withdrawn = await fetch(base + '/api/models', { headers }).then(response => response.json()) as ModelCatalog;
        expect(withdrawn.providers.find(row => row.provider === 'openai-codex')?.models.every(row => !row.available)).toBe(true);
        const count = calls.length, denied = await post('/api/chat', { provider: 'openai-codex', messages: [{ role: 'user', content: 'probe' }], options: { model } });
        const text = await denied.text(); expect(text).toContain('event: error'); expect(text).not.toContain('event: message_end'); expect(calls).toHaveLength(count);
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
    expect(calls.filter(call => call.url.endsWith('/responses'))).toHaveLength(3);
    expect((await stat(file)).mode & 0o777).toBe(0o600); expect(await readFile(file, 'utf8')).not.toContain('private-http-refresh');
  } finally { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);
