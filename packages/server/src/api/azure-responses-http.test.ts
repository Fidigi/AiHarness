import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('preserves Azure Responses environment metadata through credential initialization and rotation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-azure-http-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const keys = ['disposable-http-azure-key-one', 'disposable-http-azure-key-two'];
  const calls: Array<{ url?: string; apiKey?: string | string[]; authorization?: string; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const upstream = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      calls.push({ url: request.url, apiKey: request.headers['api-key'], authorization: request.headers.authorization, body: JSON.parse(text) });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.output_text.delta', delta: 'native-azure-http-ok' },
        { type: 'response.completed', response: { id: 'azure-http-response', model: 'physical-deployment',
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 2, total_tokens: 12 } } },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Azure fixture'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-azure-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', ''); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', '');
  vi.stubEnv('AZURE_OPENAI_API_KEY', keys[0]);
  vi.stubEnv('AZURE_OPENAI_BASE_URL', `http://127.0.0.1:${(upstream.address() as { port: number }).port}`);
  vi.stubEnv('AZURE_OPENAI_RESOURCE_NAME', ''); vi.stubEnv('AZURE_OPENAI_ENDPOINT', '');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', ''); vi.stubEnv('AZURE_OPENAI_MODEL', 'logical-model');
  vi.stubEnv('AZURE_OPENAI_API_VERSION', '2025-04-01-preview');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT_NAME_MAP', 'logical-model=physical-deployment');
  try {
    await mkdir(cwd);
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json' };
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
    for (let index = 0; index < keys.length; index++) {
      if (index) expect((await post('/api/config', { type: 'azure', apiKey: keys[index] })).status).toBe(200);
      const response = await post('/api/agent/runs', { cwd, provider: 'azure', input: 'hello' });
      expect(response.status).toBe(202);
      const { run } = await response.json() as { run: { id: string; sessionId: string } };
      await vi.waitFor(async () => {
        expect(await fetch(`${base}/api/agent/runs/${run.id}`).then(result => result.json())).toMatchObject({ phase: 'completed' });
      });
      const history = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`);
      expect(history.status).toBe(200); const text = await history.text();
      expect(text).toContain('native-azure-http-ok'); expect(text).toContain('physical-deployment');
      const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
      const entries = journal.trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'azure', model: 'physical-deployment',
        usage: expect.objectContaining({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12 }) }));
      for (const key of keys) { expect(text).not.toContain(key); expect(journal).not.toContain(key); }
    }
    expect(fixtureError).toBeUndefined();
    expect(calls).toEqual(keys.map(apiKey => expect.objectContaining({ url: '/openai/v1/responses?api-version=2025-04-01-preview',
      apiKey, authorization: undefined, body: expect.objectContaining({ model: 'physical-deployment', stream: true, store: false }) })));
    const encrypted = await readFile(path.join(dataDir, 'credentials.enc'), 'utf8');
    for (const key of keys) expect(encrypted).not.toContain(key);
  } finally {
    await stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
