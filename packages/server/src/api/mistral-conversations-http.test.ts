import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('saves/reloads a native Mistral custom dialect, uses encrypted replacement credentials and persists authentic streamed output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mistral-http-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'private'), model = 'magistral-medium-latest';
  const keys = ['disposable-http-mistral-key-one', 'disposable-http-mistral-key-two'];
  const calls: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  let fixtureError: unknown;
  const upstream = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') { expect(request.url).toBe('/proxy/v1/models'); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: model }] })); return; }
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { model, choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'native reasoning' }] }, { type: 'text', text: 'native-mistral-http-ok' }] } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 2 } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.writeHead(500); response.end('Invalid Mistral fixture'); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-mistral-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'mistral-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'mistral-admin');
  try {
    await mkdir(cwd);
    for (let index = 0; index < keys.length; index++) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer mistral-admin' };
      const post = (route: string, body: unknown, token = 'mistral-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'mistral', name: 'Native Mistral', dialect: 'mistral-conversations',
        baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/proxy`, apiKey: keys[index] };
      expect((await post('/api/provider-registry/custom', definition, 'mistral-user')).status).toBe(403);
      expect((await post('/api/provider-registry/custom', { ...definition, dialect: 'mistral' })).status).toBe(400);
      if (index) {
        const restored = await fetch(`${base}/api/provider-registry/custom`, { headers }).then(result => result.json());
        expect(restored).toContainEqual(expect.objectContaining({ id: 'mistral', configured: true, dialect: 'mistral-conversations' }));
      }
      const saved = index ? await fetch(`${base}/api/provider-registry/custom/mistral`, { method: 'PUT', headers, body: JSON.stringify(definition) })
        : await post('/api/provider-registry/custom', definition);
      expect(saved.status).toBe(index ? 200 : 201);
      expect(await saved.text()).not.toContain(keys[index]);
      const aliasDefinition = { ...definition, id: 'operator-mistral' };
      const aliasSaved = index ? await fetch(`${base}/api/provider-registry/custom/operator-mistral`, { method: 'PUT', headers, body: JSON.stringify(aliasDefinition) })
        : await post('/api/provider-registry/custom', aliasDefinition);
      expect(aliasSaved.status).toBe(index ? 200 : 201);
      const catalog = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const aliasModels = catalog.providers.find((provider: { provider: string }) => provider.provider === 'operator-mistral')?.models;
      expect(aliasModels).toHaveLength(40);
      expect(aliasModels).toContainEqual(expect.objectContaining({ id: model, name: 'Magistral Medium (latest)',
        api: 'mistral-conversations', available: true, contextWindow: 262144, maxOutputTokens: 16384,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 2, outputPerMillion: 5, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0 } }));
      expect(JSON.stringify(catalog)).not.toContain(keys[index]);
      const imported = await post('/api/provider-registry/custom/operator-mistral/import-models', {});
      expect(imported.status).toBe(200);
      expect(await imported.json()).toEqual([expect.objectContaining({ provider: 'operator-mistral', id: model,
        name: 'Magistral Medium (latest)', contextWindow: 262144, maxOutputTokens: 16384,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 2, outputPerMillion: 5, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0 } })]);
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      const response = await post('/api/agent/runs', { cwd, provider: 'mistral', model, thinking: 'high', input: 'hello' });
      expect(response.status).toBe(202);
      const { run } = await response.json() as { run: { id: string; sessionId: string } };
      await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(result => result.json())).toMatchObject({ phase: 'completed' }));
      const text = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(result => result.text());
      expect(text).toContain('native-mistral-http-ok'); expect(text).toContain('native reasoning');
      expect(text).toContain('"api":"mistral-conversations"');
      const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
      expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'mistral', model, api: 'mistral-conversations',
        usage: expect.objectContaining({ inputTokens: 7, cacheReadTokens: 3, outputTokens: 2, totalTokens: 12 }) }));
      for (const key of keys) { expect(text).not.toContain(key); expect(journal).not.toContain(key); }
      await stop();
    }
    expect(fixtureError).toBeUndefined();
    expect(calls).toEqual(keys.map(key => expect.objectContaining({ url: '/proxy/v1/chat/completions', authorization: `Bearer ${key}`,
      body: expect.objectContaining({ model, stream: true, reasoning_effort: 'high' }) })));
    for (const file of ['providers.json', 'provider-secrets.enc']) {
      const text = await readFile(path.join(dataDir, file), 'utf8'); for (const key of keys) expect(text).not.toContain(key);
    }
  } finally {
    await stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
