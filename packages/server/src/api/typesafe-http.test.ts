import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CodemodeDetails, ProviderModelCatalog, Session } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('executes native auxiliary classifiers/images across guarded configuration, rotation, encrypted restart and disconnect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-typesafe-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const chatKey = 'synthetic-typesafe-http-chat', keys = ['synthetic-typesafe-http-first', 'synthetic-typesafe-http-rotated'];
  const imageKey = 'synthetic-http-images-key', imageModel = 'google/gemini-2.5-flash-image';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
  const imageCode = `const model = (await models.getAvailableOfType('image')).find(model => model.id === 'images-native::${imageModel}');
    const result = await models.generateImages({model:model.id,prompt:'pixel'}); store('mediaType',result.images[0].mediaType); return result.images[0].mediaType;`;
  const classifyCode = `const model = (await models.getAvailableOfType('classifier')).find(model => model.id === 'safe-native::jev-latest');
    if (!model) throw new Error('TypeSafe unavailable');
    const result = await models.classify({model:model.id,input:'reviewed',labels:['safe','review']}); store('label',result.label); return result;`;
  const calls: Array<{ url?: string; auth?: string; body: Record<string, any> }> = [];
  let fixtureError: unknown;
  const wire = createServer(async (request, response) => {
    try {
      expect(request.method).toBe('POST');
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const body = JSON.parse(text); calls.push({ url: request.url, auth: request.headers.authorization, body });
      if (request.url === '/images%2Fowner/v1/chat/completions') {
        expect(body).toMatchObject({ model: imageModel, stream: false, modalities: ['image', 'text'], messages: [{ role: 'user', content: [{ type: 'text', text: 'pixel' }] }] });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }] })); return;
      }
      if (request.url === '/typesafe%2Fowner/v1/systemone') {
        expect(body).toMatchObject({ model: 'jev-latest', state: { input: 'reviewed' }, questions: { label: { type: 'choice', criteria: { safe: 'safe', review: 'review' } } } });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ answers: { label: { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.8, review: 0.2 } } }, usage: { input_tokens: 10, output_tokens: 2 } })); return;
      }
      expect(request.url).toBe('/chat%2Fowner/v1/chat/completions'); expect(body.model).toBe('deepseek-flash');
      const tool = body.messages.find((message: { role: string }) => message.role === 'tool');
      const generating = body.messages.some((message: { role: string; content: unknown }) => message.role === 'user' && message.content === 'Generate image');
      const withdrawn = tool?.content.includes('TypeSafe unavailable');
      if (tool && !withdrawn) expect(tool.content).toContain(generating ? 'image/png' : '"label":"safe"');
      const delta = tool ? { content: withdrawn ? 'auxiliary-unavailable' : 'native-typesafe-http-ok' }
        : { tool_calls: [{ index: 0, id: 'specialized', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: generating ? imageCode : classifyCode }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 2 } }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid auxiliary HTTP fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'synthetic-typesafe-http-master');
  vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'typesafe-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'typesafe-admin');
  try {
    for (const restart of [false, true]) {
      const server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
      const base = `http://127.0.0.1:${server.port}`, headers = { 'content-type': 'application/json', authorization: 'Bearer typesafe-admin' };
      const post = (route: string, body: unknown, token = 'typesafe-admin') => fetch(base + route, { method: 'POST', headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const definition = { id: 'safe-native', name: 'TypeSafe classifier', dialect: 'typesafe', apiKey: keys[0],
        baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/typesafe%2Fowner/v1` };
      if (!restart) {
        expect((await post('/api/provider-registry/custom', definition, 'typesafe-user')).status).toBe(403);
        expect((await post('/api/provider-registry/custom', definition)).status).toBe(201);
        expect((await post('/api/provider-registry/custom', { id: 'chat-native', name: 'Conversation', dialect: 'deepseek', apiKey: chatKey,
          baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/chat%2Fowner/v1` })).status).toBe(201);
      }
      const before = calls.length;
      expect((await post('/api/provider-registry/auth/safe-native/test', {})).status).toBe(409);
      const imported = await post('/api/provider-registry/custom/safe-native/import-models', {});
      expect(imported.status).toBe(200); expect(await imported.json()).toEqual([]);
      expect((await post('/api/provider-registry/models', { provider: 'safe-native', id: 'jev-latest' })).status).toBe(400);
      const catalog = await fetch(base + '/api/models', { headers }).then(response => response.json()) as { providers: ProviderModelCatalog[] };
      expect(catalog.providers.find(provider => provider.provider === 'safe-native')?.models).toEqual([]);
      expect(calls).toHaveLength(before);
      expect((await post('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
      expect((await fetch(base + '/api/tools', { method: 'PATCH', headers, body: JSON.stringify({ enabledTools: ['codemode'], toolPreset: 'default',
        powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }) })).status).toBe(200);
      const run = async (available = true, kind: 'classifier' | 'image' = 'classifier') => {
        const before = calls.length;
        const response = await post('/api/agent/runs', { cwd, provider: 'chat-native', model: 'deepseek-flash', input: kind === 'image' ? 'Generate image' : 'Review', autoCompaction: false, thinking: 'off' });
        expect(response.status).toBe(202);
        const { run } = await response.json() as { run: { id: string; sessionId: string } };
        await vi.waitFor(async () => expect(await fetch(`${base}/api/agent/runs/${run.id}`, { headers }).then(response => response.json())).toMatchObject({ phase: 'completed' }));
        const state = await fetch(`${base}/api/agent/sessions/${run.sessionId}/state`, { headers }).then(response => response.json()) as { session: Session };
        const tool = state.session.messages.find(message => message.role === 'tool')!;
        expect(tool).toBeDefined();
        const details = tool.metadata?.codemode as CodemodeDetails | undefined;
        expect(details).toBeDefined();
        if (available) {
          expect(tool.isError).not.toBe(true); expect(tool.usage?.totalTokens).toBe(12);
          const cost = kind === 'image' ? expect.closeTo(0.000008, 12) : 0;
          expect(details).toMatchObject({ store: kind === 'image' ? { mediaType: 'image/png' } : { label: 'safe' }, costComplete: true, usage: { totalTokens: 12, costUsd: cost },
            nestedCalls: [{ kind, state: 'completed', usage: { totalTokens: 12, costUsd: cost } }] });
          expect(state.session.usage?.totalTokens).toBe(28);
        } else { expect(tool.isError).toBe(true); expect(details?.store).toBeUndefined(); expect(state.session.usage?.totalTokens).toBe(16); }
        expect(state.session.messages.at(-1)).toMatchObject({ provider: 'chat-native', model: 'deepseek-flash', api: 'openai-completions', content: available ? 'native-typesafe-http-ok' : 'auxiliary-unavailable' });
        expect(calls.slice(before).map(call => call.auth)).toEqual(available ? [`Bearer ${chatKey}`, `Bearer ${kind === 'image' ? imageKey : keys[restart || before > 0 ? 1 : 0]}`, `Bearer ${chatKey}`] : [`Bearer ${chatKey}`, `Bearer ${chatKey}`]);
        const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8');
        for (const secret of [chatKey, ...keys, imageKey]) { expect(JSON.stringify(state)).not.toContain(secret); expect(journal).not.toContain(secret); }
      };
      await run();
      if (!restart) {
        expect((await fetch(base + '/api/provider-registry/custom/safe-native', { method: 'PUT', headers, body: JSON.stringify({ apiKey: keys[1] }) })).status).toBe(200);
        await run();
        expect((await post('/api/provider-registry/custom', { id: 'images-native', name: 'Native images', dialect: 'openrouter', apiKey: imageKey,
          baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/images%2Fowner/v1` })).status).toBe(201);
        await run(true, 'image');
      } else {
        expect((await fetch(base + '/api/provider-registry/auth/safe-native', { method: 'DELETE', headers })).status).toBe(200);
        await run(false);
      }
      await stop();
    }
    expect(fixtureError).toBeUndefined(); expect(calls).toHaveLength(14);
    for (const file of ['providers.json', 'provider-secrets.enc']) for (const secret of [chatKey, ...keys, imageKey]) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(secret);
  } finally { await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
