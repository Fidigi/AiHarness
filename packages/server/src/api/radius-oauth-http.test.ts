import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type ProviderAuthStatus, type Session } from '@ai-harness/core';
import { start, stop } from '../index.js';
it('binds custom Radius OAuth over real HTTP to private P tools, refresh/restart, leases and pending-body disconnect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-oauth-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data');
  const id = 'radius-account', model = 'account-only', master = 'synthetic-radius-http-oauth-master', header = 'private-http-tenant';
  const calls: Array<{ url?: string; auth?: string; body?: Record<string, any>; form?: Record<string, string> }> = []; let failure: unknown, turns = 0, refreshes = 0;
  let hold = false, tokenReached!: () => void, bodyClosed!: () => void;
  const reached = new Promise<void>(resolve => { tokenReached = resolve; }), closed = new Promise<void>(resolve => { bodyClosed = resolve; });
  const wire = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) { text += chunk; expect(Buffer.byteLength(text)).toBeLessThan(2000000); }
      const form = req.url?.startsWith('/v1/oauth/') ? Object.fromEntries(new URLSearchParams(text)) : undefined, body = text && !form ? JSON.parse(text) : undefined;
      calls.push({ url: req.url, auth: req.headers.authorization, form, body }); const gateway = `http://127.0.0.1:${(wire.address() as { port: number }).port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/oauth') { res.end(JSON.stringify({ authorizationEndpoint: gateway + '/authorize' })); return; }
      if (req.url === '/v1/oauth/device') { expect(req.headers.authorization).toBeUndefined(); expect(form).toEqual({ client_id: 'pi-gateway', scope: 'gateway offline_access' });
        res.end(JSON.stringify({ device_code: 'private-http-device', user_code: 'PUBLIC-CODE', verification_uri: gateway + '/verify', expires_in: 600, interval: 1 })); return; }
      if (req.url === '/v1/oauth/token') {
        expect(req.headers.authorization).toBeUndefined(); expect(req.headers['x-tenant']).toBeUndefined(); expect(form?.client_id).toBe('pi-gateway');
        if (hold) { tokenReached(); res.once('close', bodyClosed); res.write('{'); return; }
        if (form?.grant_type === 'refresh_token') { expect(form.refresh_token).toBe('private-http-refresh'); refreshes++; }
        else expect(form?.device_code).toBe('private-http-device');
        res.end(JSON.stringify({ access_token: refreshes ? 'private-http-rotated' : 'private-http-access', refresh_token: 'private-http-refresh', expires_in: 3600 })); return;
      }
      expect(req.headers.authorization).toBe('Bearer ' + (refreshes ? 'private-http-rotated' : 'private-http-access')); expect(req.headers['x-tenant']).toBe(header);
      if (req.url === '/v1/config') { res.end(JSON.stringify({ baseUrl: gateway + '/p/v1', models: [{ id: model, name: 'Native account', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 131072, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] })); return; }
      expect(req.url).toBe('/p/v1/messages'); expect(body?.model).toBe(model); turns++;
      const history: Array<Record<string, any>> = body!.context.messages, tool = history.find(message => message.role === 'toolResult');
      if (tool) {
        expect(history.find(message => message.role === 'assistant')?.content).toContainEqual(expect.objectContaining({ type: 'toolCall', thoughtSignature: 'private-http-tool-signature' }));
        if (turns === 3) expect(history.flatMap(message => message.content)).toContainEqual({ type: 'thinking', thinking: 'thought', thinkingSignature: 'private-http-thought-signature' });
      }
      const events = tool ? [{ type: 'thinking_start', contentIndex: 0 }, { type: 'thinking_delta', contentIndex: 0, delta: 'thought' }, { type: 'thinking_end', contentIndex: 0, content: 'thought', contentSignature: 'private-http-thought-signature' },
        { type: 'text_start', contentIndex: 1 }, { type: 'text_delta', contentIndex: 1, delta: 'radius-oauth-http-ok' }, { type: 'text_end', contentIndex: 1, content: 'radius-oauth-http-ok', contentSignature: 'private-http-text-signature' }] : [
        { type: 'toolcall_start', contentIndex: 0, id: 'native-call', toolName: 'codemode' }, { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify({ code: "store('native', true); return 'native';" }) },
        { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'native-call', name: 'codemode', arguments: { code: "store('native', true); return 'native';" }, thoughtSignature: 'private-http-tool-signature' } }];
      res.setHeader('content-type', 'text/event-stream'); res.end([{ type: 'start' }, ...events, { type: 'done', reason: tool ? 'stop' : 'toolUse', usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { failure = error; res.statusCode = 500; res.end('Invalid native Radius HTTP fixture'); }
  });
  await mkdir(cwd); await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'radius-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'radius-admin'); vi.stubEnv('RADIUS_GATEWAY', 'https://not-selected.test');
  try {
    let application = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd }), base = `http://127.0.0.1:${application.port}`;
    const headers = { authorization: 'Bearer radius-admin', 'content-type': 'application/json' }, request = (route: string, body?: unknown, method = 'POST') => fetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const definition = { id, name: 'Radius account', dialect: 'radius', baseUrl: `http://127.0.0.1:${(wire.address() as { port: number }).port}`, headers: { 'x-tenant': header } };
    expect((await request('/api/provider-registry/custom', definition)).status).toBe(201);
    expect((await request('/api/provider-registry/auth', undefined, 'GET').then(result => result.json()) as ProviderAuthStatus[]).find(provider => provider.type === id)).toMatchObject({ connected: false });
    expect((await fetch(base + `/api/provider-registry/auth/${id}/oauth`, { method: 'POST', headers: { ...headers, authorization: 'Bearer radius-user' }, body: '{}' })).status).toBe(403);
    const login = await request(`/api/provider-registry/auth/${id}/oauth`, {}); expect(login.status).toBe(201); const flow = await login.json() as { id: string };
    await vi.waitFor(async () => expect(await request(`/api/provider-registry/auth/oauth/${flow.id}`, undefined, 'GET').then(result => result.json())).toMatchObject({ state: 'connected' }), { timeout: 5000 });
    expect(await request(`/api/provider-registry/auth/${id}/test`, {}).then(result => result.json())).toMatchObject({ models: [model] });
    expect((await request(`/api/provider-registry/custom/${id}/import-models`, {})).status).toBe(200);
    expect((await request('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200);
    expect((await request('/api/tools', { enabledTools: ['codemode'], toolPreset: 'default', powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }, 'PATCH')).status).toBe(200);
    const run = async (sessionId?: string) => {
      const result = await request('/api/agent/runs', { cwd, provider: id, model, input: 'Native OAuth probe', thinking: 'off', autoCompaction: false, ...(sessionId ? { sessionId } : {}) });
      expect(result.status).toBe(202); const { run } = await result.json() as { run: { id: string; sessionId: string } };
      await vi.waitFor(async () => expect(await request(`/api/agent/runs/${run.id}`, undefined, 'GET').then(response => response.json())).toMatchObject({ phase: 'completed' }), { timeout: 5000 }); return run;
    };
    const first = await run(); expect(turns).toBe(2);
    const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(dataDir, 'provider-secrets.enc'), master) }); await service.load();
    const stored = (await service.resolve(id, { env: {}, subscriptionProvider: 'radius' }))!.credential; if (stored.type !== 'oauth') throw new Error('Expected native OAuth');
    await service.setOAuth(id, { ...stored, expiresAt: 1 }); await stop();
    application = await start({ port: 0, host: '127.0.0.1', dataDir, allowedRoots: [cwd], defaultCwd: cwd, providerRenameExclusiveHost: true }); base = `http://127.0.0.1:${application.port}`;
    expect(await request(`/api/provider-registry/auth/${id}/test`, {}).then(result => result.json())).toMatchObject({ models: [model] }); expect(refreshes).toBe(1);
    expect((await request(`/api/provider-registry/custom/${id}`, { name: 'Updated visible name' }, 'PUT')).status).toBe(200); await run(first.sessionId); expect(turns).toBe(3);
    const state = await request(`/api/agent/sessions/${first.sessionId}/state`, undefined, 'GET').then(result => result.json()) as { session: Session };
    expect(state.session.usage?.totalTokens).toBe(30); expect(state.session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
    await service.load(); expect((await service.resolve(id, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: 'private-http-rotated', subscription: stored.subscription });
    expect((await request('/api/provider-registry/custom', { ...definition, id: 'pending-radius' })).status).toBe(201);
    const browser = await request('/api/provider-registry/auth/pending-radius/oauth', { method: 'browser' }).then(result => result.json()) as { id: string; authorizationUrl: string };
    const inventory = await request('/api/provider-registry/custom', undefined, 'GET').then(result => result.json()) as Array<{ id: string; revision: string }>;
    const renamed = await request('/api/provider-registry/custom/pending-radius/rename', { id: 'renamed-radius', revision: inventory.find(provider => provider.id === 'pending-radius')!.revision });
    expect(renamed.status).toBe(409); expect(await renamed.json()).toMatchObject({ code: 'PROVIDER_OAUTH_PENDING' });
    expect((await request('/api/provider-registry/auth/pending-radius', undefined, 'DELETE')).status).toBe(200);
    const redirect = `http://127.0.0.1:1456/oauth/callback?state=${new URL(browser.authorizationUrl).searchParams.get('state')}&code=private-code`;
    expect((await request(`/api/provider-registry/auth/oauth/${browser.id}/redirect`, { redirectUrl: redirect })).status).toBe(409);
    const cache = path.join(dataDir, 'radius-models', id), files = await readdir(cache), snapshots = await Promise.all(files.map(file => readFile(path.join(cache, file))));
    hold = true; const pending = await request(`/api/provider-registry/auth/${id}/oauth`, {}).then(result => result.json()) as { id: string }; await reached;
    expect((await request(`/api/provider-registry/auth/${id}`, undefined, 'DELETE')).status).toBe(200); await closed;
    expect(await request(`/api/provider-registry/auth/oauth/${pending.id}`, undefined, 'GET').then(result => result.json())).toMatchObject({ state: 'cancelled' });
    await service.load(); expect(await service.resolve(id, { env: {}, subscriptionProvider: 'radius' })).toBeUndefined();
    expect(await Promise.all(files.map(file => readFile(path.join(cache, file))))).toEqual(snapshots); expect(files).toHaveLength(1);
    expect((await request('/api/agent/runs', { cwd, provider: id, model, input: 'Must refuse', sessionId: first.sessionId })).status).not.toBe(202); expect(turns).toBe(3); expect(failure).toBeUndefined();
    const journal = await readFile(path.join(dataDir, 'sessions', `${first.sessionId}.jsonl`), 'utf8');
    for (const secret of ['private-http-access', 'private-http-rotated', 'private-http-refresh', 'private-http-device', header]) expect(journal + JSON.stringify(state) + await readFile(path.join(dataDir, 'providers.json'), 'utf8') + await readFile(path.join(dataDir, 'provider-secrets.enc'), 'utf8')).not.toContain(secret);
  } finally { await stop(); wire.closeAllConnections(); await new Promise<void>(resolve => wire.close(() => resolve())); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);
