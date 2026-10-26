import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('reloads encrypted explicit Moonshot hosts and preserves native C policy across legacy chat, agent and virtual guests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ms-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const chats = ['kimi-k2.6', 'kimi-k3'], keys = ['disposable-ms-http-one', 'disposable-ms-http-two'];
  const headerSecret = 'disposable-ms-http-header';
  const code = `const result=await models.classify({model:"kimi-k2.6:classifier",input:"Approved",labels:["safe","review"]}); text("routed virtual C"); store("label",result.label); return result.label;`;
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
      const legacy = body.messages.some((message: Record<string, unknown>) => message.content === 'Legacy probe');
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ model: body.model, choices: [{ index: 0, delta: finished || legacy ? { content: 'native-ms-http-ok' }
        : { tool_calls: [{ index: 0, id: 'script-1', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: finished || legacy ? 'stop' : 'tool_calls' }], usage },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Moonshot HTTP fixture'); }
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-ms-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'ms-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'ms-admin');
  try {
    await mkdir(cwd);
    for (const [index, key] of keys.entries()) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ms-admin' };
      const post = (route: string, body: unknown, token = 'ms-admin') => fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'ms-native', name: 'Native Moonshot', dialect: 'moonshot', apiKey: key, headers: { 'x-operator-fixture': headerSecret },
        baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/proxy%2Fowned/v1${index ? '/chat/completions/' : ''}` };
      expect((await post('/api/provider-registry/custom', definition, 'ms-user')).status).toBe(403);
      expect((await fetch(`${base}/api/provider-registry/custom`, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: JSON.stringify(definition) })).status).toBe(403);
      if (index) expect(await fetch(`${base}/api/provider-registry/custom`, { headers }).then(result => result.json()))
        .toContainEqual(expect.objectContaining({ id: 'ms-native', dialect: 'moonshot', configured: true }));
      const saved = index ? await fetch(`${base}/api/provider-registry/custom/ms-native`, { method: 'PUT', headers, body: JSON.stringify(definition) })
        : await post('/api/provider-registry/custom', definition);
      expect(saved.status).toBe(index ? 200 : 201); const savedText = await saved.text(); expect(savedText).not.toContain(key); expect(savedText).not.toContain(headerSecret);
      const before = calls.length;
      const fresh = await fetch(`${base}/api/models`, { headers }).then(result => result.json());
      const profiles = fresh.providers.find((provider: { provider: string }) => provider.provider === 'ms-native').models;
      expect(profiles).toHaveLength(4);
      expect(profiles).toContainEqual(expect.objectContaining({ id: chats[1], api: 'openai-completions', name: 'Kimi K3', contextWindow: 1048576, maxOutputTokens: 1048576,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true } }));
      for (const id of ['future/private', 'kimi-old']) expect((await post('/api/provider-registry/models', { provider: 'ms-native', id })).status).toBe(400);
      expect((await post('/api/provider-registry/auth/ms-native/test', {})).status).toBe(409);
      const imported = await post('/api/provider-registry/custom/ms-native/import-models', {}); expect(imported.status).toBe(200);
      const importedModels = await imported.json(); expect(importedModels).toHaveLength(4);
      expect(importedModels).toContainEqual(expect.objectContaining({ id: chats[0], name: 'Kimi K2.6', contextWindow: 262144, maxOutputTokens: 262144,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16, cacheWritePerMillion: 0 } }));
      expect(importedModels).toContainEqual(expect.objectContaining({ id: chats[1], pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 } }));
      expect(calls).toHaveLength(before); expect(JSON.stringify(fresh)).not.toContain(key); expect(JSON.stringify(fresh)).not.toContain(headerSecret);
      const model = chats[index]!;
      const legacy = await post('/api/chat', { provider: 'ms-native', messages: [{ role: 'user', content: 'Legacy probe' }], options: { model, thinking: 'off', maxTokens: 64 } });
      expect(legacy.status).toBe(200); expect(await legacy.text()).toContain('native-ms-http-ok');
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      expect((await fetch(`${base}/api/tools`, { method: 'PATCH', headers, body: JSON.stringify({ enabledTools: ['codemode'], toolPreset: 'default',
        powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }) })).status).toBe(200);
      const response = await post('/api/agent/runs', { cwd, provider: 'ms-native', model, input: 'Exercise native Moonshot', autoCompaction: false, thinking: 'off' });
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
      expect(journal.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'message', role: 'assistant', provider: 'ms-native', model,
        api: 'openai-completions', content: 'native-ms-http-ok', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }) }));
      for (const secret of [...keys, headerSecret]) { expect(JSON.stringify(state)).not.toContain(secret); expect(journal).not.toContain(secret); }
      await stop();
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(8);
    for (const [index, key] of keys.entries()) for (const call of calls.slice(index * 4, (index + 1) * 4)) {
      expect(call.headers.authorization).toBe(`Bearer ${key}`); expect(call.headers['x-operator-fixture']).toBe(headerSecret);
      const k3 = call.body.model === chats[1];
      expect(call.body.thinking).toEqual(k3 ? undefined : { type: 'disabled' }); expect(call.body.reasoning_effort).toBe(k3 ? 'low' : undefined);
      expect(call.body.max_completion_tokens).toBeUndefined(); expect(call.body.max_tokens).toBeGreaterThan(0); expect(call.body.store).toBeUndefined();
      expect(call.body.tool_stream).toBeUndefined();
      for (const tool of call.body.tools ?? []) expect(tool.function.strict).toBeUndefined();
      for (const message of call.body.messages) { expect(message.role).not.toBe('developer'); if (k3 && message.role === 'assistant') expect(typeof message.reasoning_content).toBe('string'); }
      for (const name of ['x-api-key', 'api-key', 'anthropic-version', 'cf-aig-authorization']) expect(call.headers[name]).toBeUndefined();
    }
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const secret of [...keys, headerSecret]) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(secret);
  } finally {
    await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(resolve)); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('keeps the explicit CN endpoint across authenticated HTTP key rotation and server restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cn-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const id = 'regional-http', baseUrl = 'https://api.moonshot.cn/v1', model = 'kimi-k2.6';
  const keys = ['disposable-cn-http-first', 'disposable-cn-http-rotated'];
  const calls: Array<{ url: string; authorization: string | null; model: unknown }> = [];
  const actualFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('http://127.0.0.1:')) return actualFetch(input, init);
    if (url !== `${baseUrl}/chat/completions`) throw new Error('Unexpected outbound request in CN HTTP control');
    const body = JSON.parse(String(init?.body));
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), model: body.model });
    return new Response([
      { model, choices: [{ index: 0, delta: { content: 'cn-http-fixture' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'disposable-cn-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'cn-http-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'cn-http-admin');
  try {
    await mkdir(cwd);
    let server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    let base = `http://127.0.0.1:${server.port}`;
    const request = (route: string, method: string, body?: unknown, token = 'cn-http-admin', origin?: string) => fetch(`${base}${route}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const definition = { id, name: 'Explicit CN endpoint', baseUrl, dialect: 'moonshot', apiKey: keys[0] };
    expect((await request('/api/provider-registry/custom', 'POST', definition, 'cn-http-user')).status).toBe(403);
    expect((await request('/api/provider-registry/custom', 'POST', definition, 'cn-http-admin', 'https://foreign.example')).status).toBe(403);
    const saved = await request('/api/provider-registry/custom', 'POST', definition);
    expect(saved.status).toBe(201); expect(await saved.text()).not.toContain(keys[0]);
    const imported = await request(`/api/provider-registry/custom/${id}/import-models`, 'POST', {});
    expect(imported.status).toBe(200);
    expect((await imported.json()).map((entry: { id: string }) => entry.id).sort())
      .toEqual(['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3']);
    expect((await request(`/api/provider-registry/custom/${id}/test`, 'POST', {})).status).toBe(409);
    expect(calls).toHaveLength(0);
    for (let phase = 0; phase < 3; phase++) {
      if (phase === 1) {
        const rotated = await request(`/api/provider-registry/custom/${id}`, 'PUT', { apiKey: keys[1] });
        expect(rotated.status).toBe(200); expect(await rotated.text()).not.toContain(keys[1]);
      } else if (phase === 2) {
        await stop();
        server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
        base = `http://127.0.0.1:${server.port}`;
      }
      const listing = await request('/api/provider-registry/custom', 'GET');
      expect(listing.status).toBe(200); const listed = await listing.json();
      expect(listed).toContainEqual(expect.objectContaining({ id, baseUrl, dialect: 'moonshot', configured: true, modelCount: 4 }));
      for (const key of keys) expect(JSON.stringify(listed)).not.toContain(key);
      expect(calls).toHaveLength(phase);
      const chat = await request('/api/chat', 'POST', { provider: id, messages: [{ role: 'user', content: 'CN HTTP control' }], options: { model, thinking: 'off', maxTokens: 64 } });
      expect(chat.status).toBe(200); expect(await chat.text()).toContain('cn-http-fixture');
    }
    expect(calls).toEqual([keys[0], keys[1], keys[1]].map(key => ({ url: `${baseUrl}/chat/completions`, authorization: `Bearer ${key}`, model })));
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const key of keys)
      expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(key);
  } finally {
    await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
