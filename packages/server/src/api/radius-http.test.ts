import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CustomProviderDefinition, ProviderModelCatalog, Session } from '@ai-harness/core';
import { start, stop } from '../index.js';

it('uses account-owned P through native HTTP, encrypted rotation/restart, guarded model refresh and disconnect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'private');
  const keys = ['synthetic-radius-http-a', 'synthetic-radius-http-b'], models = ['account-a', 'account-b'];
  const headerSecret = 'synthetic-radius-gateway-header';
  const code = `store('native', true); return 'native';`;
  const calls: Array<{ method?: string; key?: string; url?: string; body?: Record<string, any> }> = [];
  let empty = false, fixtureError: unknown, entered: (() => void) | undefined, held: Promise<void> | undefined, release: (() => void) | undefined;
  const wire = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; expect(text.length).toBeLessThan(2_000_000); }
      const key = request.headers.authorization?.replace(/^Bearer /u, ''), index = keys.indexOf(key!); expect(index).toBeGreaterThanOrEqual(0);
      expect(request.headers['x-native-gateway']).toBe(headerSecret);
      const body = text ? JSON.parse(text) : undefined; calls.push({ method: request.method, key, url: request.url, body });
      if (request.method === 'GET') {
        expect(request.url).toBe('/v1/config'); entered?.(); if (held) await held;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}/p/v1`,
          models: empty ? [] : [{ id: models[index], name: 'Account P', reasoning: true, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 131072 }] })); return;
      }
      expect(request.url).toBe('/p/v1/messages'); expect(body.model).toBe(models[index]); expect(body.messages).toBeUndefined();
      const history: Array<Record<string, any>> = body.context.messages;
      const tool = history.find(message => message.role === 'toolResult');
      const legacy = history.some(message => message.content?.some((block: Record<string, unknown>) => block.text === 'Legacy probe'));
      const scripted = !legacy && !tool;
      if (tool) {
        expect(tool).toMatchObject({ toolName: 'codemode', toolCallId: 'native-tool', isError: false });
        expect(history.find(message => message.role === 'assistant')?.content).toContainEqual(expect.objectContaining({ type: 'toolCall', thoughtSignature: 'private-radius-http-tool' }));
      }
      const events = scripted ? [{ type: 'toolcall_start', contentIndex: 0, id: 'native-tool', toolName: 'codemode' },
        { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify({ code }) },
        { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'native-tool', name: 'codemode', arguments: { code }, thoughtSignature: 'private-radius-http-tool' } }] : [
        { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'native-radius-http-ok' }, { type: 'text_end', contentIndex: 0, content: 'native-radius-http-ok' }];
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ type: 'start' }, ...events, { type: 'done', reason: scripted ? 'toolUse' : 'stop',
        usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { fixtureError = error; response.statusCode = 500; response.end('Invalid Radius HTTP fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', 'synthetic-radius-http-master'); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'radius-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'radius-admin');
  try {
    let server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd });
    let base = `http://127.0.0.1:${server.port}`;
    const headers = { 'content-type': 'application/json', authorization: 'Bearer radius-admin' };
    const request = (route: string, body?: unknown, method = 'POST') => fetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const definition = { id: 'radius-owned', name: 'Owned Radius', dialect: 'radius', baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}`, apiKey: keys[0], headers: { 'X-Native-Gateway': headerSecret } };
    expect((await fetch(base + '/api/provider-registry/custom', { method: 'POST', headers: { ...headers, authorization: 'Bearer radius-user' }, body: JSON.stringify(definition) })).status).toBe(403);
    expect((await request('/api/provider-registry/custom', definition)).status).toBe(201); expect(calls).toHaveLength(0);
    const test = await request('/api/provider-registry/auth/radius-owned/test', {}); expect(test.status).toBe(200); expect(await test.json()).toMatchObject({ ok: true, models: [models[0]] });
    const imported = await request('/api/provider-registry/custom/radius-owned/import-models', {}); expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject([{ id: models[0], contextWindow: 1000000, maxOutputTokens: 131072 }]);
    const metadata = await readFile(path.join(dataDir, 'providers.json')), secrets = await readFile(path.join(dataDir, 'provider-secrets.enc'));
    expect((await request('/api/provider-registry/models', { provider: 'radius-owned', id: 'unlisted' })).status).toBe(400);
    const directory = path.join(dataDir, 'radius-models', 'radius-owned'), cache = path.join(directory, (await readdir(directory))[0]!);
    const original = await readFile(cache); await writeFile(cache, '{invalid');
    expect((await request('/api/provider-registry/custom/radius-owned', { name: 'Must not publish' }, 'PUT')).status).toBe(500);
    expect(await readFile(path.join(dataDir, 'providers.json'))).toEqual(metadata); expect(await readFile(path.join(dataDir, 'provider-secrets.enc'))).toEqual(secrets);
    await writeFile(cache, original);
    const chat = async (model: string) => {
      const result = await request('/api/chat', { provider: 'radius-owned', messages: [{ role: 'user', content: 'Legacy probe' }], options: { model, maxTokens: 64, thinking: 'off' } });
      expect(result.status).toBe(200); expect(await result.text()).toContain('native-radius-http-ok');
    };
    await chat(models[0]!);
    expect((await request('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
    expect((await request('/api/tools', { enabledTools: ['codemode'], toolPreset: 'default', powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }, 'PATCH')).status).toBe(200);
    const started = await request('/api/agent/runs', { cwd, provider: 'radius-owned', model: models[0], input: 'Native P tool loop', autoCompaction: false, thinking: 'off' });
    expect(started.status).toBe(202); const { run } = await started.json() as { run: { id: string; sessionId: string } };
    await vi.waitFor(async () => expect(await request(`/api/agent/runs/${run.id}`, undefined, 'GET').then(result => result.json())).toMatchObject({ phase: 'completed' }));
    const state = await request(`/api/agent/sessions/${run.sessionId}/state`, undefined, 'GET').then(result => result.json()) as { session: Session };
    expect(state.session.messages.find(message => message.role === 'tool')?.isError).not.toBe(true);
    expect(state.session.messages.filter(message => message.role === 'assistant').every(message => message.api === 'pi-messages')).toBe(true);
    expect(state.session.usage?.totalTokens).toBe(20);
    const journal = await readFile(path.join(dataDir, 'sessions', `${run.sessionId}.jsonl`), 'utf8'); expect(journal).toContain('native-radius-http-ok');
    expect((await request('/api/provider-registry/custom/radius-owned', { apiKey: keys[1] }, 'PUT')).status).toBe(200);
    expect(await request('/api/provider-registry/auth/radius-owned/test', {}).then(result => result.json())).toMatchObject({ models: [models[1]] });
    await chat(models[1]!); empty = true;
    expect(await request('/api/provider-registry/auth/radius-owned/test', {}).then(result => result.json())).toMatchObject({ models: [] });
    await stop();
    server = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd, providerRenameExclusiveHost: true }); base = `http://127.0.0.1:${server.port}`;
    const providers = await request('/api/provider-registry/custom', undefined, 'GET').then(result => result.json()) as Array<CustomProviderDefinition & { revision: string }>;
    const revision = providers.find(provider => provider.id === 'radius-owned')!.revision;
    const latch = () => { const reached = new Promise<void>(resolve => { entered = resolve; }); held = new Promise<void>(resolve => { release = resolve; }); return reached; };
    let reached = latch(); const inventory = request('/api/models', undefined, 'GET'); await reached;
    const refused = await request('/api/provider-registry/custom/radius-owned/rename', { id: 'radius-renamed', revision });
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: 'PROVIDER_ADMINISTRATION_BUSY' });
    release!(); held = undefined; entered = undefined;
    const catalogue = await (await inventory).json() as { providers: ProviderModelCatalog[] };
    expect(catalogue.providers.find(provider => provider.provider === 'radius-owned')!.models.every(model => !model.available)).toBe(true);
    reached = latch(); const pendingTest = request('/api/provider-registry/auth/radius-owned/test', {}); await reached;
    const filesBefore = await readdir(directory), snapshotsBefore = await Promise.all(filesBefore.map(file => readFile(path.join(directory, file))));
    expect((await request('/api/provider-registry/auth/radius-owned', undefined, 'DELETE')).status).toBe(200);
    release!(); held = undefined; entered = undefined; expect((await pendingTest).ok).toBe(false);
    expect(await Promise.all(filesBefore.map(file => readFile(path.join(directory, file))))).toEqual(snapshotsBefore);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(4); expect(fixtureError).toBeUndefined();
    for (const secret of [...keys, headerSecret]) {
      expect(journal + JSON.stringify(state)).not.toContain(secret);
      for (const file of ['providers.json', 'provider-secrets.enc']) expect(await readFile(path.join(dataDir, file), 'utf8')).not.toContain(secret);
    }
  } finally {
    release?.(); await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
