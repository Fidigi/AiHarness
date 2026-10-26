import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('reloads encrypted mixed OpenRouter configuration and executes native A/C plus guest T/I without metadata connection claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const a = 'anthropic/claude-sonnet-4.6', c = 'google/gemini-3-pro-image', t = '~typesafe/jev-latest';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=';
  const keys = ['disposable-router-http-one', 'disposable-router-http-two'];
  const code = `const q=await models.classifyQuestions({model:${JSON.stringify(t)},state:{},questions:{approved:{type:"boolean",prompt:"Approved?"}}}); const result=await models.generateImages({model:${JSON.stringify(c)},prompt:"Generate"}); text("routed native T/I"); await image(result.images[0]); store("approved",q.answers.approved.value); return q.answers.approved.value;`;
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
      if (request.url?.endsWith('/systemone')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ answers: { approved: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 2 } })); return;
      }
      const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
      if (body.modalities) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }], usage })); return;
      }
      const finished = body.messages.some((message: Record<string, any>) => message.role === 'tool'
        || Array.isArray(message.content) && message.content.some((part: Record<string, unknown>) => part.type === 'tool_result'));
      response.setHeader('content-type', 'text/event-stream');
      if (request.url?.endsWith('/messages')) {
        const events: unknown[] = [{ type: 'message_start', message: { model: body.model, usage: { input_tokens: 5, output_tokens: 2,
          cache_read_input_tokens: 4, cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 1 } } } }];
        if (finished) events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native-router-http-ok' } });
        else events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'script-1', name: 'codemode', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ code }) } });
        events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: finished ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      } else response.end([{ model: body.model, choices: [{ index: 0, delta: finished ? { content: 'native-router-http-ok' }
        : { tool_calls: [{ index: 0, id: 'script-1', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }], usage },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid OpenRouter fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-router-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'router-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'router-admin');
  try {
    await mkdir(cwd);
    for (const [index, key] of keys.entries()) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer router-admin' };
      const post = (route: string, body: unknown, token = 'router-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'router-native', name: 'Native router', dialect: 'openrouter', apiKey: key,
        baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy/api/v1` };
      expect((await post('/api/provider-registry/custom', definition, 'router-user')).status).toBe(403);
      if (index) expect(await fetch(`${base}/api/provider-registry/custom`, { headers }).then(result => result.json()))
        .toContainEqual(expect.objectContaining({ id: 'router-native', dialect: 'openrouter', configured: true }));
      const saved = index ? await fetch(`${base}/api/provider-registry/custom/router-native`, { method: 'PUT', headers, body: JSON.stringify(definition) })
        : await post('/api/provider-registry/custom', definition);
      expect(saved.status).toBe(index ? 200 : 201); expect(await saved.text()).not.toContain(key);
      if (!index) {
        const fresh = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
        const profiles = fresh.providers.find((provider: { provider: string }) => provider.provider === 'router-native').models;
        expect(profiles).toHaveLength(393); expect(profiles).toContainEqual(expect.objectContaining({ id: a, api: 'anthropic-messages', name: 'Anthropic: Claude Sonnet 4.6', contextWindow: 1000000, maxOutputTokens: 128000 }));
        expect(calls).toHaveLength(0);
      }
      expect((await post('/api/provider-registry/models', { provider: 'router-native', id: 'future/private' })).status).toBe(400);
      for (const model of [a, c]) expect((await post('/api/provider-registry/models', { provider: 'router-native', id: model,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, contextWindow: 128000, maxOutputTokens: 2048 })).status).toBe(201);
      const before = calls.length;
      expect((await post('/api/provider-registry/auth/router-native/test', {})).status).toBe(409); expect(calls).toHaveLength(before);
      const imported = await post('/api/provider-registry/custom/router-native/import-models', {}); expect(imported.status).toBe(200);
      const importedModels = await imported.json(); expect(importedModels).toHaveLength(393);
      expect(importedModels).toContainEqual(expect.objectContaining({ id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', contextWindow: 128000, maxOutputTokens: 16384,
        capabilities: { reasoning: false, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, cacheWritePerMillion: 0 } }));
      for (const id of [a, c]) expect(importedModels).toContainEqual(expect.objectContaining({ id, contextWindow: 128000, maxOutputTokens: 2048 }));
      expect(importedModels.find((model: { id: string }) => model.id === 'openrouter/auto').pricing).toBeUndefined(); expect(calls).toHaveLength(before);
      const catalog = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const models = catalog.providers.find((provider: { provider: string }) => provider.provider === 'router-native').models;
      expect(models).toContainEqual(expect.objectContaining({ id: a, api: 'anthropic-messages', available: true }));
      expect(models).toContainEqual(expect.objectContaining({ id: c, api: 'openai-completions', available: true }));
      expect(JSON.stringify(catalog)).not.toContain(key);
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      expect((await fetch(`${base}/api/tools`, { method: 'PATCH', headers, body: JSON.stringify({ enabledTools: ['codemode'], toolPreset: 'default',
        powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }) })).status).toBe(200);
      for (const model of [a, c]) {
        const response = await post('/api/agent/runs', { cwd, provider: 'router-native', model, input: 'Exercise native operations', autoCompaction: false });
        expect(response.status).toBe(202);
        const { run } = await response.json() as { run: { id: string; sessionId: string } };
        await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(result => result.json())).toMatchObject({ phase: 'completed' }));
        const state = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(result => result.json());
        const tool = state.session.messages.find((message: { role: string }) => message.role === 'tool');
        expect(tool.isError).not.toBe(true); expect(tool.usage.totalTokens).toBe(24);
        expect(tool.metadata.codemode.store).toEqual({ approved: true });
        expect(tool.metadata.codemode.nestedCalls.map((call: { kind: string }) => call.kind)).toEqual(['classifier', 'image']);
        expect(state.session.usage.totalTokens).toBe(48);
        const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
        expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'router-native', model,
          api: model === a ? 'anthropic-messages' : 'openai-completions', content: 'native-router-http-ok', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }) }));
        for (const secret of keys) { expect(JSON.stringify(state)).not.toContain(secret); expect(journal).not.toContain(secret); }
      }
      await stop();
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(16);
    for (const [index, key] of keys.entries()) for (const call of calls.slice(index * 8, (index + 1) * 8)) {
      if (call.url?.endsWith('/messages')) { expect(call.headers['x-api-key']).toBe(key); expect(call.headers.authorization).toBeUndefined(); }
      else { expect(call.headers.authorization).toBe(`Bearer ${key}`); expect(call.headers['x-api-key']).toBeUndefined(); }
    }
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const key of keys) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
  } finally {
    await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(resolve)); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
