import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type Session } from '@ai-harness/core';
import { start, stop } from '../index.js';
it('binds native custom Kimi OAuth through real HTTP to signed tools, passive restart/refresh and held-token disconnect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-oauth-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), id = 'native-kimi', master = 'synthetic-kimi-http-master'; await mkdir(cwd);
  const issuer = 'https://synthetic-issuer.kimi.test', inference = 'https://synthetic-inference.kimi.test/coding', originalFetch = globalThis.fetch;
  let turns = 0, refreshes = 0, hold = false, reached!: () => void, cancel = 0; const ready = new Promise<void>(resolve => { reached = resolve; }), calls: string[] = [];
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'kimi-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'kimi-admin'); vi.stubEnv('KIMI_CODE_OAUTH_HOST', issuer); vi.stubEnv('KIMI_OAUTH_HOST', undefined);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url); if (!target.startsWith(issuer) && !target.startsWith(inference)) return originalFetch(url, init); calls.push(target);
    if (target.startsWith(issuer)) {
      expect(new Headers(init?.headers).get('authorization')).toBeNull(); expect(new Headers(init?.headers).get('x-tenant')).toBeNull(); const form = Object.fromEntries(init!.body as URLSearchParams);
      expect(form.client_id).toBe('17e5f671-d194-4dfb-9706-5516cb48c098');
      if (target.endsWith('/device_authorization')) { expect(form).toEqual({ client_id: '17e5f671-d194-4dfb-9706-5516cb48c098' }); return Response.json({ device_code: 'private-kimi-device', user_code: 'PUBLIC-CODE', verification_uri: issuer + '/verify', verification_uri_complete: issuer + '/verify?code=PUBLIC-CODE', expires_in: 600, interval: 0.001 }); }
      expect(target).toBe(issuer + '/api/oauth/token');
      if (hold) { reached(); return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel() { cancel++; return new Promise(() => undefined); } })); }
      if (form.grant_type === 'refresh_token') { refreshes++; expect(form.refresh_token).toBe('private-kimi-refresh'); } else expect(form.device_code).toBe('private-kimi-device');
      return Response.json({ access_token: refreshes ? 'private-kimi-rotated' : 'private-kimi-access', refresh_token: 'private-kimi-refresh', expires_in: 3600 });
    }
    expect(target).toBe(inference + '/v1/messages'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + (refreshes ? 'private-kimi-rotated' : 'private-kimi-access')); expect(new Headers(init?.headers).get('x-api-key')).toBeNull(); expect(new Headers(init?.headers).get('x-tenant')).toBe('private-kimi-tenant');
    const body = JSON.parse(String(init!.body)); expect(body.model).toBe('k3'); turns++; const old = body.messages.filter((message: Record<string, any>) => message.role === 'assistant');
    expect(old).toHaveLength(turns - 1); for (let index = 0; index < turns - 1; index++) expect(old[index].content).toContainEqual({ type: 'thinking', thinking: 'thought', signature: `private-kimi-thought-${index + 1}` }); expect(JSON.stringify(body)).not.toContain('ai-harness:kimi-oauth');
    const code = "store('nativeKimi', true); return 'native';", events: Record<string, any>[] = [
      { type: 'message_start', message: { id: 'native', type: 'message', role: 'assistant', model: 'k3', content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `private-kimi-thought-${turns}` } }, { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: turns === 1 ? { type: 'tool_use', id: 'native-call', name: 'codemode', input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: turns === 1 ? { type: 'input_json_delta', partial_json: JSON.stringify({ code }) } : { type: 'text_delta', text: 'native-kimi-http-ok' } }, { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: turns === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    let application = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd] }), base = `http://127.0.0.1:${application.port}`;
    const headers = { authorization: 'Bearer kimi-admin', 'content-type': 'application/json' }, request = (route: string, body?: unknown, method = 'POST') => originalFetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await request('/api/provider-registry/custom', { id, name: 'Native Kimi', dialect: 'kimi-coding', baseUrl: inference, headers: { 'x-tenant': 'private-kimi-tenant' } })).status).toBe(201);
    expect((await request('/api/provider-registry/auth', undefined, 'GET').then(result => result.json()) as Array<{ type: string; connected: boolean }>).find(provider => provider.type === id)?.connected).toBe(false);
    expect((await originalFetch(base + `/api/provider-registry/auth/${id}/oauth`, { method: 'POST', headers: { ...headers, authorization: 'Bearer kimi-user' }, body: '{}' })).status).toBe(403);
    expect((await request(`/api/provider-registry/auth/${id}/oauth`, { method: 'browser' })).status).toBe(400); expect(calls).toEqual([]);
    const flow = await request(`/api/provider-registry/auth/${id}/oauth`, {}).then(result => result.json()) as { id: string };
    await vi.waitFor(async () => expect(await request(`/api/provider-registry/auth/oauth/${flow.id}`, undefined, 'GET').then(result => result.json())).toMatchObject({ state: 'connected' }));
    expect((await request(`/api/provider-registry/auth/${id}/test`, {})).status).toBe(409); expect((await request(`/api/provider-registry/custom/${id}/import-models`, {})).status).toBe(200);
    expect((await request('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200); expect((await request('/api/tools', { enabledTools: ['codemode'], toolPreset: 'default', powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }, 'PATCH')).status).toBe(200);
    const run = async (sessionId?: string) => {
      const result = await request('/api/agent/runs', { cwd, provider: id, model: 'k3', input: 'Native Kimi probe', thinking: 'off', autoCompaction: false, ...(sessionId ? { sessionId } : {}) }); expect(result.status).toBe(202);
      const { run } = await result.json() as { run: { id: string; sessionId: string } }; await vi.waitFor(async () => expect(await request(`/api/agent/runs/${run.id}`, undefined, 'GET').then(response => response.json())).toMatchObject({ phase: 'completed' }), { timeout: 5000 }); return run;
    };
    const first = await run(); expect(turns).toBe(2); const reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(dataDir, 'provider-secrets.enc'), master) }); await reader.load();
    const stored = (await reader.resolve(id, { env: {}, subscriptionProvider: 'kimi-coding' }))!.credential; if (stored.type !== 'oauth') throw new Error('Expected native Kimi'); await reader.setOAuth(id, { ...stored, expiresAt: 1 }); await stop(); vi.stubEnv('KIMI_CODE_OAUTH_HOST', undefined);
    application = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd] }); base = `http://127.0.0.1:${application.port}`; expect(refreshes).toBe(0); await run(first.sessionId); expect(turns).toBe(3); expect(refreshes).toBe(1);
    expect((await request(`/api/provider-registry/custom/${id}`, { name: 'Edited Kimi' }, 'PUT')).status).toBe(200); await reader.load(); expect((await reader.resolve(id, { env: {}, subscriptionProvider: 'kimi-coding' }))?.credential).toMatchObject({ accessToken: 'private-kimi-rotated', subscription: stored.subscription });
    const state = await request(`/api/agent/sessions/${first.sessionId}/state`, undefined, 'GET').then(result => result.json()) as { session: Session }; expect(state.session.usage?.totalTokens).toBe(30); expect(state.session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
    hold = true; const pending = await request(`/api/provider-registry/auth/${id}/oauth`, {}).then(result => result.json()) as { id: string }; await ready;
    const inventory = await request('/api/provider-registry/custom', undefined, 'GET').then(result => result.json()) as Array<{ id: string; revision: string }>;
    const renamed = await request(`/api/provider-registry/custom/${id}/rename`, { id: 'renamed-kimi', revision: inventory.find(provider => provider.id === id)!.revision }); expect(renamed.status).toBe(409); expect(await renamed.json()).toMatchObject({ code: 'PROVIDER_OAUTH_PENDING' });
    expect((await request(`/api/provider-registry/auth/${id}`, undefined, 'DELETE')).status).toBe(200); await vi.waitFor(() => expect(cancel).toBe(1)); expect(await request(`/api/provider-registry/auth/oauth/${pending.id}`, undefined, 'GET').then(result => result.json())).toMatchObject({ state: 'cancelled' });
    await reader.load(); expect(await reader.resolve(id, { env: {}, subscriptionProvider: 'kimi-coding' })).toBeUndefined(); expect((await request('/api/agent/runs', { cwd, provider: id, model: 'k3', input: 'Refuse', sessionId: first.sessionId })).status).not.toBe(202); expect(turns).toBe(3);
    const journal = await readFile(path.join(dataDir, 'sessions', first.sessionId + '.jsonl'), 'utf8'); for (const secret of ['private-kimi-access', 'private-kimi-rotated', 'private-kimi-refresh', 'private-kimi-device', 'private-kimi-tenant']) expect(journal + JSON.stringify(state) + await readFile(path.join(dataDir, 'providers.json'), 'utf8') + await readFile(path.join(dataDir, 'provider-secrets.enc'), 'utf8')).not.toContain(secret);
  } finally { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);
