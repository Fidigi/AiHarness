import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type Session } from '@ai-harness/core';
import { start, stop } from '../index.js';
it('binds custom OpenRouter browser PKCE through real HTTP to permanent-key tools/restart and held-key withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-oauth-http-')), cwd = path.join(root, 'work'), dataDir = path.join(root, 'data'), id = 'native-router', master = 'synthetic-router-http-master'; await mkdir(cwd);
  const issuer = 'https://openrouter.ai/api/v1/auth/keys', inference = 'https://synthetic-inference.router.test/proxy', originalFetch = globalThis.fetch, key = 'private-router-generated-key';
  let turns = 0, hold = false, reached!: () => void, cancel = 0; const ready = new Promise<void>(resolve => { reached = resolve; }), calls: string[] = [];
  vi.stubEnv('AI_HARNESS_MASTER_KEY', master); vi.stubEnv('AI_HARNESS_AUTH_TOKEN', 'router-user'); vi.stubEnv('AI_HARNESS_ADMIN_TOKEN', 'router-admin');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = String(url); if (target !== issuer && !target.startsWith(inference)) { if (new URL(target).hostname === '127.0.0.1') return originalFetch(url, init); throw new Error('Outside synthetic OpenRouter transport'); } calls.push(target);
    const body = JSON.parse(String(init!.body));
    if (target === issuer) {
      expect(new Headers(init?.headers).get('authorization')).toBeNull(); expect(new Headers(init?.headers).get('x-tenant')).toBeNull(); expect(init?.redirect).toBe('manual'); expect(body).toMatchObject({ code: 'private-router-code', code_challenge_method: 'S256' });
      if (hold) { reached(); return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel() { cancel++; return new Promise(() => undefined); } })); }
      return Response.json({ key });
    }
    expect(target).toBe(inference + '/v1/chat/completions'); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`); expect(new Headers(init?.headers).get('x-tenant')).toBe('private-router-tenant'); expect(body.model).toBe('openai/gpt-4o');
    expect(body.messages.filter((message: { role: string }) => message.role === 'assistant')).toHaveLength(turns); turns++;
    const delta = turns === 1 ? { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code: "store('nativeRouter', true); return 'native';" }) } }] } : { content: 'native-router-http-ok' };
    return new Response('data: ' + JSON.stringify({ id: 'native-router', choices: [{ delta, finish_reason: turns === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    let application = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd] }), base = `http://127.0.0.1:${application.port}`;
    const headers = { authorization: 'Bearer router-admin', 'content-type': 'application/json' }, request = (route: string, body?: unknown, method = 'POST') => originalFetch(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await request('/api/provider-registry/custom', { id, name: 'Native Router', dialect: 'openrouter', baseUrl: inference, headers: { 'x-tenant': 'private-router-tenant' } })).status).toBe(201);
    expect((await request('/api/provider-registry/auth', undefined, 'GET').then(result => result.json()) as Array<{ type: string; connected: boolean }>).find(provider => provider.type === id)?.connected).toBe(false);
    expect((await originalFetch(base + `/api/provider-registry/auth/${id}/oauth`, { method: 'POST', headers: { ...headers, authorization: 'Bearer router-user' }, body: '{"method":"browser"}' })).status).toBe(403);
    expect((await request(`/api/provider-registry/auth/${id}/oauth`, { method: 'device' })).status).toBe(400); expect(calls).toEqual([]);
    const begin = async () => { const response = await request(`/api/provider-registry/auth/${id}/oauth`, { method: 'browser' }); expect(response.status).toBe(201); const flow = await response.json() as { id: string; authorizationUrl: string }; const authorization = new URL(flow.authorizationUrl); expect(authorization.origin + authorization.pathname).toBe('https://openrouter.ai/auth'); expect(authorization.searchParams.has('state')).toBe(false); return { ...flow, callback: authorization.searchParams.get('callback_url')! }; };
    const flow = await begin(); expect(calls).toEqual([]); expect((await request(`/api/provider-registry/auth/oauth/${flow.id}/redirect`, { redirectUrl: flow.callback + '-wrong?code=private-router-code' })).status).toBe(400);
    expect((await request(`/api/provider-registry/auth/oauth/${flow.id}/redirect`, { redirectUrl: flow.callback + '?code=private-router-code' })).status).toBe(200);
    expect((await request('/api/provider-registry/auth', undefined, 'GET').then(result => result.json()) as Array<{ type: string; connected: boolean; method: string }>).find(provider => provider.type === id)).toMatchObject({ connected: true, method: 'api-key' });
    expect((await request(`/api/provider-registry/auth/${id}/test`, {})).status).toBe(409); expect((await request(`/api/provider-registry/custom/${id}/import-models`, {})).status).toBe(200);
    expect((await request('/api/workspaces/trust', { cwd, confirm: true })).status).toBe(200); expect((await request('/api/tools', { enabledTools: ['codemode'], toolPreset: 'default', powershellEnabled: false, codemodeEnabled: true, codemodeMode: 'only' }, 'PATCH')).status).toBe(200);
    const run = async (sessionId?: string) => { const result = await request('/api/agent/runs', { cwd, provider: id, model: 'openai/gpt-4o', input: 'Native Router probe', autoCompaction: false, ...(sessionId ? { sessionId } : {}) }); expect(result.status).toBe(202); const { run } = await result.json() as { run: { id: string; sessionId: string } }; await vi.waitFor(async () => expect(await request(`/api/agent/runs/${run.id}`, undefined, 'GET').then(response => response.json())).toMatchObject({ phase: 'completed' }), { timeout: 5000 }); return run; };
    const first = await run(); expect(turns).toBe(2); const reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(dataDir, 'provider-secrets.enc'), master) }); await reader.load(); expect((await reader.resolve(id, { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: key }); expect(reader.list()).toMatchObject([{ refreshable: false }]); await stop();
    application = await start({ port: 0, host: '127.0.0.1', dataDir, defaultCwd: cwd, allowedRoots: [cwd] }); base = `http://127.0.0.1:${application.port}`; expect(calls).toHaveLength(3); await run(first.sessionId); expect(turns).toBe(3); expect(calls.filter(call => call === issuer)).toHaveLength(1);
    expect((await request(`/api/provider-registry/custom/${id}`, { name: 'Edited Router' }, 'PUT')).status).toBe(200); await reader.load(); expect((await reader.resolve(id, { env: {} }))?.credential).toMatchObject({ apiKey: key });
    const state = await request(`/api/agent/sessions/${first.sessionId}/state`, undefined, 'GET').then(result => result.json()) as { session: Session }; expect(state.session.usage?.totalTokens).toBe(30); expect(state.session.messages.filter(message => message.role === 'tool')).toHaveLength(1); for (const message of state.session.messages.filter(message => message.role === 'assistant')) expect(message.usage).toMatchObject({ totalTokens: 10, costUsd: 0.00004 });
    hold = true; const pending = await begin(), completion = request(`/api/provider-registry/auth/oauth/${pending.id}/redirect`, { redirectUrl: pending.callback + '?code=private-router-code' }); await ready;
    const inventory = await request('/api/provider-registry/custom', undefined, 'GET').then(result => result.json()) as Array<{ id: string; revision: string }>;
    const renamed = await request(`/api/provider-registry/custom/${id}/rename`, { id: 'renamed-router', revision: inventory.find(provider => provider.id === id)!.revision }); expect(renamed.status).toBe(409); expect(await renamed.json()).toMatchObject({ code: 'PROVIDER_OAUTH_PENDING' });
    expect((await request(`/api/provider-registry/auth/${id}`, undefined, 'DELETE')).status).toBe(200); expect((await completion).status).toBe(409); await vi.waitFor(() => expect(cancel).toBe(1)); expect(await request(`/api/provider-registry/auth/oauth/${pending.id}`, undefined, 'GET').then(result => result.json())).toMatchObject({ state: 'cancelled' });
    await reader.load(); expect(await reader.resolve(id, { env: {} })).toBeUndefined(); expect((await request('/api/agent/runs', { cwd, provider: id, model: 'openai/gpt-4o', input: 'Refuse', sessionId: first.sessionId })).status).not.toBe(202); expect(turns).toBe(3);
    const journal = await readFile(path.join(dataDir, 'sessions', first.sessionId + '.jsonl'), 'utf8'); for (const secret of [key, 'private-router-code', 'private-router-tenant']) expect(journal + JSON.stringify(state) + await readFile(path.join(dataDir, 'providers.json'), 'utf8') + await readFile(path.join(dataDir, 'provider-secrets.enc'), 'utf8')).not.toContain(secret);
  } finally { await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);
