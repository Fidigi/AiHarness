import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('reloads encrypted native OpenAI hosts with operation-owned R/D guests and no static connection certificate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-oa-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const chats = ['gpt-6-luna', 'gpt-4o'], keys = ['disposable-oa-http-one', 'disposable-oa-http-two'];
  const code = (index: number) => `const q=await models.classifyQuestions({model:"gpt-6-luna",state:{},questions:{approved:{type:"boolean",prompt:"Approved?"}}}); const label=await models.classify({model:"gpt-6-luna",input:"Approved",labels:["safe","review"]}); const r=await models.classifyQuestions({model:${JSON.stringify(`${index ? 'gpt-4' : chats[0]}:classifier`)},state:{},questions:{approved:{type:"boolean",prompt:"Approved?"}}}); const rl=await models.classify({model:${JSON.stringify(`${index ? 'gpt-4' : chats[0]}:classifier`)},input:"Approved",labels:["safe","review"]}); text("routed native R/D"); store("approved",q.answers.approved.value); store("label",label.label); store("rApproved",r.answers.approved.value); store("rLabel",rl.label); return r.answers.approved.value;`;
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
      const index = request.headers.authorization === `Bearer ${keys[1]}` ? 1 : 0;
      if (request.url === '/proxy%2Fowned/v1/decisions') {
        expect(body.model).toBe('gpt-6-luna');
        const answers = body.questions.map((question: { name: string; type: string }) => question.type === 'predicate'
          ? { name: question.name, type: 'predicate', probability: 0.8 }
          : { name: question.name, type: 'choice', choice: 'safe', confidence: 0.8, probabilities: [{ value: 'safe', probability: 0.8 }, { value: 'review', probability: 0.2 }] });
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 2 } })); return;
      }
      expect(request.url).toBe('/proxy%2Fowned/v1/responses'); expect(body.stream).toBe(true);
      const system = body.input.filter((item: { role?: string }) => item.role === 'developer').map((item: { content: string }) => item.content).join('\n');
      const classification = system.includes('Classify the user input') || system.includes('Answer these finite-domain questions');
      const finished = body.input.some((item: { type?: string }) => item.type === 'function_call_output');
      const content = system.includes('Classify the user input') ? JSON.stringify({ label: 'safe' })
        : classification ? JSON.stringify({ answers: { approved: { value: true, probabilities: [{ value: false, probability: 0.2 }, { value: true, probability: 0.8 }] } } }) : 'native-oa-http-ok';
      if (classification) expect(body.model).toBe(index ? 'gpt-4' : chats[0]); else expect(body.model).toBe(chats[index]);
      const output = classification || finished ? [] : [{ type: 'function_call', call_id: 'script-1', name: 'codemode', arguments: JSON.stringify({ code: code(index) }) }];
      const events = classification || finished ? [{ type: 'response.output_text.delta', delta: content }] : [];
      response.setHeader('content-type', 'text/event-stream');
      response.end([...events, { type: 'response.completed', response: { id: 'native-oa-http-response', model: body.model, output,
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } } }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid OpenAI HTTP fixture'); }
  });
  // Exercise the existing HTTP path without pretending to implement the WebSocket protocol.
  wire.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-oa-http-master'); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'oa-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'oa-admin');
  try {
    await mkdir(cwd);
    for (const [index, key] of keys.entries()) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer oa-admin' };
      const post = (route: string, body: unknown, token = 'oa-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'oa-native', name: 'Native OpenAI', dialect: 'openai', apiKey: key,
        baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy%2Fowned/v1/${index ? 'decisions' : 'responses'}` };
      expect((await post('/api/provider-registry/custom', definition, 'oa-user')).status).toBe(403);
      if (index) expect(await fetch(`${base}/api/provider-registry/custom`, { headers }).then(result => result.json()))
        .toContainEqual(expect.objectContaining({ id: 'oa-native', dialect: 'openai', configured: true }));
      const saved = index ? await fetch(`${base}/api/provider-registry/custom/oa-native`, { method: 'PUT', headers, body: JSON.stringify(definition) }) : await post('/api/provider-registry/custom', definition);
      expect(saved.status).toBe(index ? 200 : 201); expect(await saved.text()).not.toContain(key);
      if (!index) {
        const fresh = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
        const native = fresh.providers.find((provider: { provider: string }) => provider.provider === 'oa-native').models;
        expect(native).toHaveLength(44); expect(native.find((model: { id: string }) => model.id === 'gpt-6-luna')).toMatchObject({ name: 'GPT-6 Luna', api: 'openai-responses', contextWindow: 272000, maxOutputTokens: 128000 });
        expect(calls).toHaveLength(0);
      }
      for (const id of ['future/private', 'gpt-6-luna-decisions']) expect((await post('/api/provider-registry/models', { provider: 'oa-native', id })).status).toBe(400);
      for (const model of chats) {
        expect((await post('/api/provider-registry/models', { provider: 'oa-native', id: model, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, contextWindow: 128000, maxOutputTokens: 2048 })).status).toBe(201);
        // Recomposition while Luna is the only saved model binds both physical operations to its shared ID.
        if (!index && model === chats[0]) expect((await fetch(`${base}/api/provider-registry/custom/oa-native`, { method: 'PUT', headers, body: JSON.stringify(definition) })).status).toBe(200);
      }
      const before = calls.length;
      expect((await post('/api/provider-registry/auth/oa-native/test', {})).status).toBe(409);
      const imported = await post('/api/provider-registry/custom/oa-native/import-models', {}); expect(imported.status).toBe(200); expect(await imported.json()).toHaveLength(44); expect(calls).toHaveLength(before);
      const catalog = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const models = catalog.providers.find((provider: { provider: string }) => provider.provider === 'oa-native').models;
      for (const id of chats) expect(models).toContainEqual(expect.objectContaining({ id, api: 'openai-responses', available: true, contextWindow: 128000, maxOutputTokens: 2048 }));
      expect(models).toContainEqual(expect.objectContaining({ id: 'o3-mini', api: 'openai-responses', contextWindow: 200000, maxOutputTokens: 100000,
        capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadPerMillion: 0.55, cacheWritePerMillion: 0 } }));
      expect(JSON.stringify(catalog)).not.toContain(key);
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      expect((await fetch(`${base}/api/tools`, { method: 'PATCH', headers, body: JSON.stringify({ enabledTools: ['codemode'], toolPreset: 'default', powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }) })).status).toBe(200);
      const model = chats[index]!;
      const response = await post('/api/agent/runs', { cwd, provider: 'oa-native', model, input: 'Exercise native operations', autoCompaction: false }); expect(response.status).toBe(202);
      const { run } = await response.json() as { run: { id: string; sessionId: string } };
      await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(result => result.json())).toMatchObject({ phase: 'completed' }));
      const state = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(result => result.json());
      const tool = state.session.messages.find((message: { role: string }) => message.role === 'tool');
      expect(tool.isError).not.toBe(true); expect(tool.usage.totalTokens).toBe(48); expect(tool.metadata.codemode.store).toEqual({ approved: true, label: 'safe', rApproved: true, rLabel: 'safe' });
      expect(tool.metadata.codemode.nestedCalls.map((call: { kind: string }) => call.kind)).toEqual(['classifier', 'classifier', 'classifier', 'classifier']);
      expect(tool.metadata.codemode.nestedCalls.map((call: { usage: { costUsd: number } }) => call.usage.costUsd)).toEqual([0.000001, 0.000001, ...(index ? [0.00027, 0.00027] : [0.000001665, 0.000001665])]);
      expect(state.session.usage.totalTokens).toBe(72);
      const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
      expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'oa-native', model, api: 'openai-responses', content: 'native-oa-http-ok', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }) }));
      for (const secret of keys) { expect(JSON.stringify(state)).not.toContain(secret); expect(journal).not.toContain(secret); }
      await stop();
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(12);
    expect(calls.filter(call => call.url?.endsWith('/decisions'))).toHaveLength(4);
    for (const [index, key] of keys.entries()) for (const call of calls.slice(index * 6, (index + 1) * 6)) {
      expect(call.headers.authorization).toBe(`Bearer ${key}`); for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(call.headers[name]).toBeUndefined();
    }
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const key of keys) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
  } finally {
    await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(resolve)); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
