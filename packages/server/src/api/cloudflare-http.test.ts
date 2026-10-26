import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('reloads encrypted explicit Cloudflare hosts and executes native C with S guests without static connection claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cf-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const chats = ['@cf/deepseek-ai/deepseek-v4-flash-0731', '@cf/google/gemma-4-26b-a4b-it'];
  const native = '@cf/cloudflare/clef', flash = '@cf/cloudflare/clef-flash';
  const keys = ['disposable-cf-http-one', 'disposable-cf-http-two'];
  const code = `const q=await models.classifyQuestions({model:${JSON.stringify(native)},state:{},questions:{approved:{type:"boolean",prompt:"Approved?"}}}); const label=await models.classify({model:${JSON.stringify(flash)},input:"Approved",labels:["safe","review"]}); text("routed native S"); store("approved",q.answers.approved.value); store("label",label.label); return q.answers.approved.value;`;
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
      if (request.url === '/proxy/accounts/explicit/ai/run') {
        expect([native, flash]).toContain(body.model);
        const answers = Object.fromEntries(Object.entries(body.input.questions).map(([id, question]) => [id,
          (question as { type: string }).type === 'noul' ? { type: 'noul', noul: 0.8 }
            : { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.8, review: 0.2 } }]));
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ success: true, result: { state: 'Completed', result: { answers, usage: { input_tokens: 10, output_tokens: 2 } } } })); return;
      }
      expect(request.url).toBe('/proxy/accounts/explicit/ai/v1/chat/completions'); expect(chats).toContain(body.model);
      const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
      if (!body.stream) {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'native-cf-http-ok' } }], usage })); return;
      }
      const finished = body.messages.some((message: Record<string, unknown>) => message.role === 'tool');
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ model: body.model, choices: [{ index: 0, delta: finished ? { content: 'native-cf-http-ok' }
        : { tool_calls: [{ index: 0, id: 'script-1', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }], usage },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Cloudflare HTTP fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-cf-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'cf-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'cf-admin');
  try {
    await mkdir(cwd);
    for (const [index, key] of keys.entries()) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer cf-admin' };
      const post = (route: string, body: unknown, token = 'cf-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'cf-native', name: 'Native Cloudflare', dialect: 'cloudflare-workers-ai', apiKey: key,
        baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/accounts/explicit/ai/${index ? 'run' : 'v1'}` };
      expect((await post('/api/provider-registry/custom', definition, 'cf-user')).status).toBe(403);
      if (index) expect(await fetch(`${base}/api/provider-registry/custom`, { headers }).then(result => result.json()))
        .toContainEqual(expect.objectContaining({ id: 'cf-native', dialect: 'cloudflare-workers-ai', configured: true }));
      const saved = index ? await fetch(`${base}/api/provider-registry/custom/cf-native`, { method: 'PUT', headers, body: JSON.stringify(definition) })
        : await post('/api/provider-registry/custom', definition);
      expect(saved.status).toBe(index ? 200 : 201); expect(await saved.text()).not.toContain(key);
      if (!index) {
        const fresh = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
        const profiles = fresh.providers.find((provider: { provider: string }) => provider.provider === 'cf-native').models;
        expect(profiles).toHaveLength(18); expect(profiles).toContainEqual(expect.objectContaining({ id: chats[1], name: 'Gemma 4 26B A4B IT',
          contextWindow: 256000, maxOutputTokens: 16384, capabilities: { reasoning: true, imageInput: true, toolCalls: true } }));
        expect(calls).toHaveLength(0);
      }
      for (const id of ['future/private', native]) expect((await post('/api/provider-registry/models', { provider: 'cf-native', id })).status).toBe(400);
      for (const model of chats) expect((await post('/api/provider-registry/models', { provider: 'cf-native', id: model,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, contextWindow: 128000, maxOutputTokens: 2048 })).status).toBe(201);
      const before = calls.length;
      expect((await post('/api/provider-registry/auth/cf-native/test', {})).status).toBe(409);
      const imported = await post('/api/provider-registry/custom/cf-native/import-models', {}); expect(imported.status).toBe(200);
      const importedModels = await imported.json(); expect(importedModels).toHaveLength(18);
      expect(importedModels).toContainEqual(expect.objectContaining({ id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0 H Micro', contextWindow: 131000, maxOutputTokens: 131000,
        capabilities: { reasoning: false, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.017, outputPerMillion: 0.112, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } }));
      for (const id of chats) expect(importedModels).toContainEqual(expect.objectContaining({ id, contextWindow: 128000, maxOutputTokens: 2048 }));
      expect(calls).toHaveLength(before);
      const catalog = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const models = catalog.providers.find((provider: { provider: string }) => provider.provider === 'cf-native').models;
      for (const id of chats) expect(models).toContainEqual(expect.objectContaining({ id, api: 'openai-completions', available: true }));
      expect(JSON.stringify(catalog)).not.toContain(key);
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      expect((await fetch(`${base}/api/tools`, { method: 'PATCH', headers, body: JSON.stringify({ enabledTools: ['codemode'], toolPreset: 'default',
        powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }) })).status).toBe(200);
      const model = chats[index]!;
      const response = await post('/api/agent/runs', { cwd, provider: 'cf-native', model, input: 'Exercise native operations', autoCompaction: false });
      expect(response.status).toBe(202);
      const { run } = await response.json() as { run: { id: string; sessionId: string } };
      await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(result => result.json())).toMatchObject({ phase: 'completed' }));
      const state = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(result => result.json());
      const tool = state.session.messages.find((message: { role: string }) => message.role === 'tool');
      expect(tool.isError).not.toBe(true); expect(tool.usage.totalTokens).toBe(24);
      expect(tool.metadata.codemode.store).toEqual({ approved: true, label: 'safe' });
      expect(tool.metadata.codemode.nestedCalls.map((call: { kind: string }) => call.kind)).toEqual(['classifier', 'classifier']);
      expect(state.session.usage.totalTokens).toBe(48);
      const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
      expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'cf-native', model,
        api: 'openai-completions', content: 'native-cf-http-ok', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }) }));
      for (const secret of keys) { expect(JSON.stringify(state)).not.toContain(secret); expect(journal).not.toContain(secret); }
      await stop();
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(8);
    for (const [index, key] of keys.entries()) for (const call of calls.slice(index * 4, (index + 1) * 4)) {
      expect(call.headers.authorization).toBe(`Bearer ${key}`);
      for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(call.headers[name]).toBeUndefined();
    }
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const key of keys) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
  } finally {
    await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(resolve)); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
