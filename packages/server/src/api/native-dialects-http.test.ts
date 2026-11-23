import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { start, stop } from '../index.js';

it('uses newly composed A/G/C/R dialects through authenticated HTTP, rotation and encrypted restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-native-dialects-http-'));
  const cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const profiles = [
    { dialect: 'minimax', model: 'MiniMax-M2.7', api: 'a', count: 3 },
    { dialect: 'opencode', model: 'gemini-3.1-pro', api: 'g', count: 83 },
    { dialect: 'huggingface', model: 'Qwen/Qwen3.8-2.4T-A95B', api: 'c', count: 78 },
    { dialect: 'meta', model: 'muse-spark-1.3', api: 'r', count: 6 },
    { dialect: 'qwen-token-plan', model: 'qwen3.8-flash', api: 'c', count: 20 },
    { dialect: 'xiaomi-token-plan-cn', model: 'mimo-v2.5', api: 'c', count: 4 },
    { dialect: 'zai-coding-cn', model: 'glm-5.3', api: 'c', count: 4 },
    { dialect: 'cloudflare-ai-gateway', model: 'claude-fable-5', api: 'a', count: 57 },
    { dialect: 'vercel-ai-gateway', model: 'alibaba/qwen-3-14b', api: 'a', count: 245 },
  ];
  const calls: Array<{ model: string; key: string | undefined; url: string | undefined }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text), google = request.url?.includes(':streamGenerateContent');
      const model = google ? decodeURIComponent(request.url!.split('/models/')[1]!.split(':streamGenerateContent')[0]!) : body.model;
      const profile = profiles.find(row => row.model === model)!; expect(profile).toBeDefined();
      if (profile.dialect === 'qwen-token-plan') expect(body).toMatchObject({ enable_thinking: true, reasoning_effort: 'low' });
      if (profile.dialect === 'xiaomi-token-plan-cn') expect(body).toMatchObject({ thinking: { type: 'disabled' }, store: false });
      if (profile.dialect === 'zai-coding-cn') expect(body).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'low', tool_stream: true });
      const header = profile.dialect === 'cloudflare-ai-gateway' ? request.headers['cf-aig-authorization'] : profile.api === 'a' ? request.headers['x-api-key'] : profile.api === 'g' ? request.headers['x-goog-api-key'] : request.headers.authorization;
      expect(typeof header).toBe('string');
      if (profile.dialect === 'cloudflare-ai-gateway') { expect(request.headers.authorization).toBeUndefined(); expect(request.headers['x-api-key']).toBeUndefined(); }
      calls.push({ model, key: String(header).replace(/^Bearer /, ''), url: request.url });
      const a = [{ type: 'message_start', message: { id: 'answer', model, usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'native-http-ok' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
      const g = [{ candidates: [{ content: { role: 'model', parts: [{ text: 'native-http-ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } }];
      const r = [{ type: 'response.output_text.delta', delta: 'native-http-ok' }, { type: 'response.completed', response: { id: 'answer', model, usage: { input_tokens: 4, output_tokens: 1 } } }];
      const c = [{ model, choices: [{ delta: { content: 'native-http-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }];
      const events = profile.api === 'a' ? a : profile.api === 'g' ? g : profile.api === 'r' ? r : c;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (profile.api === 'c' ? 'data: [DONE]\n\n' : ''));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid native HTTP fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'synthetic-native-http-master-key');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'native-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'native-admin');
  const secrets = profiles.flatMap(profile => [`synthetic-${profile.dialect}-first`, `synthetic-${profile.dialect}-rotated`]);
  try {
    for (const restart of [false, true]) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'content-type': 'application/json', authorization: 'Bearer native-admin' };
      const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      for (const profile of profiles) {
        const id = `native-${profile.dialect}`, definition = { id, name: id, dialect: profile.dialect,
          apiKey: `synthetic-${profile.dialect}-first`, baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/owned` };
        if (!restart) {
          expect((await fetch(base + '/api/provider-registry/custom', { method: 'POST', headers: { ...headers, authorization: 'Bearer native-user' }, body: JSON.stringify(definition) })).status).toBe(403);
          expect((await post('/api/provider-registry/custom', definition)).status).toBe(201);
        }
        const before = calls.length;
        const imported = await post(`/api/provider-registry/custom/${id}/import-models`, {});
        expect(imported.status).toBe(200); expect(await imported.json()).toHaveLength(profile.count);
        expect((await post(`/api/provider-registry/auth/${id}/test`, {})).status).toBe(409);
        expect((await post('/api/provider-registry/models', { provider: id, id: 'future/private' })).status).toBe(400);
        expect(calls).toHaveLength(before);
        const chat = async () => {
          // The retired raw maxTokens option is not an agent HTTP capability.
          const result = await post('/api/agent/runs', { cwd, provider: id, model: profile.model,
            input: 'Native probe', thinking: 'off', toolPreset: 'chat-only', autoCompaction: false });
          expect(result.status).toBe(202);
          const { run } = await result.json() as { run: { id: string; sessionId: string } };
          await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(response => response.json()))
            .toMatchObject({ phase: 'completed' }));
          const state = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(response => response.json());
          expect(state.session.messages.at(-1)).toMatchObject({ content: 'native-http-ok', provider: id, model: profile.model });
        };
        await chat();
        expect(calls.at(-1)).toMatchObject({ model: profile.model, key: `synthetic-${profile.dialect}-${restart ? 'rotated' : 'first'}` });
        if (!restart) {
          expect((await fetch(`${base}/api/provider-registry/custom/${id}`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: `synthetic-${profile.dialect}-rotated` }) })).status).toBe(200);
          await chat(); expect(calls.at(-1)?.key).toBe(`synthetic-${profile.dialect}-rotated`);
        }
      }
      await stop();
    }
    expect(calls).toHaveLength(27); expect(fixtureError).toBeUndefined();
    expect(calls.some(call => call.url?.endsWith('/v1/messages'))).toBe(true);
    expect(calls.some(call => call.url?.includes(':streamGenerateContent?alt=sse'))).toBe(true);
    expect(calls.some(call => call.url?.endsWith('/chat/completions'))).toBe(true);
    expect(calls.some(call => call.url?.endsWith('/responses'))).toBe(true);
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const secret of secrets) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(secret);
  } finally {
    await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
