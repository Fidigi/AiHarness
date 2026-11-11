import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('loads a subscription without API-key flattening, routes A/C/R through HTTP, and observes account withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-copilot-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const master = 'disposable-copilot-http-master-key', token = 'disposable-copilot-http-token';
  const models = ['claude-fable-5', 'gemini-3.5-flash', 'gpt-5-mini'];
  const fixture = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
    rows: Array<{ model: string; api: string; case: string; expectedPath: string; responseEvents: Array<{ type?: string }> }>;
  };
  const calls: Array<{ url: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master);
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'copilot-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'copilot-admin');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (new URL(String(url)).hostname !== 'api.individual.githubcopilot.com') return originalFetch(url, init);
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
    await credentials.setOAuth('github-copilot', { accessToken: token, refreshToken: 'disposable-github-grant', expiresAt: Date.now() + 120000,
      subscription: { provider: 'github-copilot', availableModelIds: models } });
    for (const reload of [false, true]) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'content-type': 'application/json', authorization: 'Bearer copilot-admin' };
      const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const catalog = await fetch(base + '/api/models', { headers }).then(response => response.json());
      const copilot = catalog.providers.find((row: { provider: string }) => row.provider === 'github-copilot');
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
        const withdrawn = await fetch(base + '/api/models', { headers }).then(response => response.json());
        expect(withdrawn.providers.find((row: { provider: string }) => row.provider === 'github-copilot').models.every((row: { available: boolean }) => !row.available)).toBe(true);
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
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain(token);
  } finally { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);
