import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('reloads encrypted explicit DeepSeek hosts and preserves native C policy across retired-chat rejection, agent and virtual guests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ds-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const chats = ['deepseek-flash', 'deepseek-v4-pro'], keys = ['disposable-ds-http-one', 'disposable-ds-http-two'];
  const headerSecret = 'disposable-ds-http-header';
  const code = `const result=await models.classify({model:"deepseek-flash:classifier",input:"Approved",labels:["safe","review"]}); text("routed virtual C"); store("label",result.label); return result.label;`;
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
      expect(request.url).toBe('/proxy%2Fowned/v1/chat/completions'); expect(chats).toContain(body.model);
      const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
      if (!body.stream) {
        expect(body.model).toBe(chats[0]);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify({ label: 'safe', confidence: 0.8, probabilities: { safe: 0.8, review: 0.2 } }) }, finish_reason: 'stop' }], usage })); return;
      }
      const finished = body.messages.some((message: Record<string, unknown>) => message.role === 'tool');
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ model: body.model, choices: [{ index: 0, delta: finished ? { content: 'native-ds-http-ok' }
        : { tool_calls: [{ index: 0, id: 'script-1', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }], usage },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid DeepSeek HTTP fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-ds-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'ds-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'ds-admin');
  try {
    await mkdir(cwd);
    for (const [index, key] of keys.entries()) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ds-admin' };
      const post = (route: string, body: unknown, token = 'ds-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'ds-native', name: 'Native DeepSeek', dialect: 'deepseek', apiKey: key, headers: { 'x-operator-fixture': headerSecret },
        baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy%2Fowned/v1${index ? '/chat/completions/' : ''}` };
      expect((await post('/api/provider-registry/custom', definition, 'ds-user')).status).toBe(403);
      expect((await fetch(`${base}/api/provider-registry/custom`, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: JSON.stringify(definition) })).status).toBe(403);
      if (index) expect(await fetch(`${base}/api/provider-registry/custom`, { headers }).then(result => result.json()))
        .toContainEqual(expect.objectContaining({ id: 'ds-native', dialect: 'deepseek', configured: true }));
      const saved = index ? await fetch(`${base}/api/provider-registry/custom/ds-native`, { method: 'PUT', headers, body: JSON.stringify(definition) })
        : await post('/api/provider-registry/custom', definition);
      expect(saved.status).toBe(index ? 200 : 201); const savedText = await saved.text(); expect(savedText).not.toContain(key); expect(savedText).not.toContain(headerSecret);
      const before = calls.length;
      const fresh = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const profiles = fresh.providers.find((provider: { provider: string }) => provider.provider === 'ds-native').models;
      expect(profiles).toHaveLength(2);
      expect(profiles).toContainEqual(expect.objectContaining({ id: chats[1], api: 'openai-completions', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxOutputTokens: 384000,
        capabilities: { reasoning: true, imageInput: false, toolCalls: true } }));
      for (const id of ['future/private', 'deepseek-chat']) expect((await post('/api/provider-registry/models', { provider: 'ds-native', id })).status).toBe(400);
      expect((await post('/api/provider-registry/auth/ds-native/test', {})).status).toBe(409);
      const imported = await post('/api/provider-registry/custom/ds-native/import-models', {}); expect(imported.status).toBe(200);
      const importedModels = await imported.json(); expect(importedModels).toHaveLength(2);
      expect(importedModels).toContainEqual(expect.objectContaining({ id: chats[0], name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutputTokens: 384000,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006, cacheWritePerMillion: 0 } }));
      expect(importedModels).toContainEqual(expect.objectContaining({ id: chats[1], pricing: { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheReadPerMillion: 0.044, cacheWritePerMillion: 0 } }));
      expect(calls).toHaveLength(before); expect(JSON.stringify(fresh)).not.toContain(key); expect(JSON.stringify(fresh)).not.toContain(headerSecret);
      const model = chats[index]!;
      const legacy = await post('/api/chat', { provider: 'ds-native', messages: [{ role: 'user', content: 'Legacy probe' }], options: { model, thinking: 'off', maxTokens: 64 } });
      expect(legacy.status).toBe(404); expect(await legacy.json()).toEqual({ error: 'Not found' });
      expect(calls).toHaveLength(before);
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      expect((await fetch(`${base}/api/tools`, { method: 'PATCH', headers, body: JSON.stringify({ enabledTools: ['codemode'], toolPreset: 'default',
        powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }) })).status).toBe(200);
      const response = await post('/api/agent/runs', { cwd, provider: 'ds-native', model, input: 'Exercise native DeepSeek', autoCompaction: false, thinking: 'off' });
      expect(response.status).toBe(202);
      const { run } = await response.json() as { run: { id: string; sessionId: string } };
      await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(result => result.json())).toMatchObject({ phase: 'completed' }));
      const state = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(result => result.json());
      const tool = state.session.messages.find((message: { role: string }) => message.role === 'tool');
      expect(tool.isError).not.toBe(true); expect(tool.usage.totalTokens).toBe(12);
      expect(tool.metadata.codemode.store).toEqual({ label: 'safe' });
      expect(tool.metadata.codemode.nestedCalls.map((call: { kind: string }) => call.kind)).toEqual(['classifier']);
      expect(state.session.usage.totalTokens).toBe(36);
      const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
      expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'ds-native', model,
        api: 'openai-completions', content: 'native-ds-http-ok', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }) }));
      for (const secret of [...keys, headerSecret]) { expect(JSON.stringify(state)).not.toContain(secret); expect(journal).not.toContain(secret); }
      await stop();
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(6);
    for (const [index, key] of keys.entries()) for (const call of calls.slice(index * 3, (index + 1) * 3)) {
      expect(call.headers.authorization).toBe(`Bearer ${key}`); expect(call.headers['x-operator-fixture']).toBe(headerSecret);
      expect(call.body.thinking).toEqual({ type: 'disabled' }); expect(call.body.reasoning_effort).toBeUndefined();
      expect(call.body.max_completion_tokens).toBeUndefined(); expect(call.body.max_tokens).toBeGreaterThan(0); expect(call.body.store).toBeUndefined();
      for (const tool of call.body.tools ?? []) expect(tool.function.strict).toBe(false);
      for (const message of call.body.messages) { expect(message.role).not.toBe('developer'); if (message.role === 'assistant') expect(typeof message.reasoning_content).toBe('string'); }
      for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(call.headers[name]).toBeUndefined();
    }
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const secret of [...keys, headerSecret]) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(secret);
  } finally {
    await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
