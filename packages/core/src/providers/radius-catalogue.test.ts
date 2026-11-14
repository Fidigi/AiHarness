import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadiusProvider } from './index.js';
import { ProviderCredentialService, type ProviderOAuthCredential } from './credentials.js';
import { createProviderNetworkScope, closeProviderNetworkDispatchers, PROVIDER_NETWORK_SCOPE } from './provider-network.js';
import type { RadiusProviderConfig } from './radius-catalogue.js';
import { collectProviderModelCatalog, discoverProviderModelIds } from './model-catalog.js';
import type { Message } from '../types/index.js';

const key = 'synthetic-radius-catalogue-a';
const user = (): Message => ({ id: 'user', role: 'user', content: 'probe', timestamp: new Date(0) });
const model = (id = 'account-only') => ({ id, name: 'Account model', reasoning: false, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 });
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(signature?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-catalogue-')); roots.push(root);
  const directory = path.join(root, 'catalogue');
  const calls: Array<{ method?: string; url?: string; auth?: string; body: Record<string, any> | undefined }> = [];
  let snapshot: Record<string, unknown>;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ method: request.method, url: request.url, auth: request.headers.authorization, body: text ? JSON.parse(text) : undefined });
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(snapshot)); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'allowed' },
      { type: 'text_end', contentIndex: 0, content: 'allowed', ...(signature ? { contentSignature: signature } : {}) },
      { type: 'done', reason: 'stop', usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.001 } } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const gateway = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  snapshot = { baseUrl: `${gateway}/account/v1`, models: [model()] };
  const config: RadiusProviderConfig = { type: 'owned-radius', apiKey: key, gateway, catalogueDirectory: directory };
  return { root, directory, config, gateway, calls, provider: new RadiusProvider(config), set: (value: Record<string, unknown>) => { snapshot = value; } };
}

describe('Radius account-owned catalogue', () => {
  it('keeps live native OAuth distinct from API keys, preserves grant-owned replay/cache across token rotation and isolates reauthentication', async () => {
    const f = await fixture('private-oauth-text'), service = new ProviderCredentialService();
    const initial: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-oauth-initial', refreshToken: 'private-oauth-refresh', expiresAt: Date.now() + 3600000,
      subscription: { provider: 'radius', gateway: f.gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    await service.setOAuth('team-radius', initial, false);
    const source = async (signal?: AbortSignal, allowRefresh?: boolean) => (await service.resolve('team-radius', { env: {}, subscriptionProvider: 'radius', signal, allowRefresh }))?.credential as ProviderOAuthCredential | undefined;
    const config = { ...f.config, apiKey: 'must-not-borrow-api-key' }, provider = new RadiusProvider(config, source, initial);
    const first = await provider.chat([user()]);
    expect(f.calls.map(call => [call.method, call.url, call.auth])).toEqual([
      ['GET', '/v1/config', 'Bearer private-oauth-initial'], ['POST', '/account/v1/messages', 'Bearer private-oauth-initial'],
    ]);
    const history: Message[] = [user(), { id: 'assistant', role: 'assistant', content: first.content, blocks: first.blocks, provider: first.provider, model: first.model, api: first.api, timestamp: new Date(1) }];
    const rotated = { ...initial, accessToken: 'private-oauth-rotated' }; await service.setOAuth('team-radius', rotated, false);
    const restored = new RadiusProvider(config, source, rotated), before = f.calls.length;
    expect(restored.getCachedAvailableModelIds()).toEqual(['account-only']);
    expect(await restored.getAvailableModels({ allowNetwork: false })).toEqual(['account-only']); expect(f.calls).toHaveLength(before);
    await restored.chat(history); await provider.chat(history);
    for (const call of f.calls.slice(-2)) {
      expect(call.auth).toBe('Bearer private-oauth-rotated'); expect(call.body!.context.messages[1].content).toEqual([{ type: 'text', text: 'allowed', textSignature: 'private-oauth-text' }]);
    }
    expect(await readdir(f.directory)).toHaveLength(1);
    const apiKey = new RadiusProvider({ ...config, apiKey: rotated.accessToken }); await apiKey.getAvailableModels(); await apiKey.chat(history);
    expect(f.calls.at(-1)!.body!.context.messages[1].content).toEqual([{ type: 'text', text: 'allowed' }]);
    const next = { ...rotated, subscription: { ...initial.subscription!, provider: 'radius' as const, gateway: f.gateway, grantId: '533fa824-4f8b-4d80-84b9-e542c22215eb' } };
    await service.setOAuth('team-radius', next, false); const nextReply = await new RadiusProvider(config, source, next).chat(history);
    expect(f.calls.at(-1)!.body!.context.messages[1].content).toEqual([{ type: 'text', text: 'allowed' }]);
    const nextHistory: Message[] = [user(), { id: 'assistant-next', role: 'assistant', content: nextReply.content, blocks: nextReply.blocks, provider: nextReply.provider, model: nextReply.model, api: nextReply.api, timestamp: new Date(1) }];
    class Derived extends RadiusProvider {} const derived = new Derived(config, source, next); await derived.chat(nextHistory);
    expect(f.calls.at(-1)!.body!.context.messages[1].content).toEqual([{ type: 'text', text: 'allowed' }]);
    f.set({ baseUrl: `${f.gateway}/account/v1`, models: [] }); const empty = new RadiusProvider(config, source, next); expect(await empty.getAvailableModels()).toEqual([]);
    const newer = { ...next, accessToken: 'private-oauth-newer' }; await service.setOAuth('team-radius', newer, false);
    const offline = new RadiusProvider(config, source, newer), requests = f.calls.length; expect(offline.getPublishedModels()).toEqual([]);
    expect(await offline.getAvailableModels({ allowNetwork: false })).toEqual([]); expect(f.calls).toHaveLength(requests); expect(await readdir(f.directory)).toHaveLength(3);
    await service.delete('team-radius'); await expect(restored.chat(history)).rejects.toThrow('Radius request aborted.');
    expect(restored.getPublishedModels()).toEqual([]); expect(f.calls).toHaveLength(requests);
  });

  it('refuses a foreign issuer/gateway or a withdrawn grant before metadata/inference publication', async () => {
    const f = await fixture(), credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-native-access', refreshToken: 'private-native-refresh', expiresAt: Date.now() + 3600000,
      subscription: { provider: 'radius', gateway: f.gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    expect(() => new RadiusProvider({ ...f.config, gateway: 'https://foreign.test' }, async () => credential, credential)).toThrow('unavailable');
    let current: ProviderOAuthCredential | undefined = credential;
    const provider = new RadiusProvider(f.config, async () => current, credential);
    let complete = false, error: Error | undefined;
    await provider.streamChat([user()], () => { current = undefined; }, () => { complete = true; }, failure => { error = failure; });
    expect(complete).toBe(false); expect(error).toMatchObject({ usage: { totalTokens: 10, costUsd: 0.001 } });
    expect(provider.getCachedAvailableModelIds()).toEqual([]); expect(f.calls).toHaveLength(2);
    const other = new RadiusProvider(f.config, async () => ({ ...credential, subscription: undefined }));
    await expect(other.chat([user()])).rejects.toThrow('Radius request aborted.'); expect(f.calls).toHaveLength(2);
  });

  it('keeps another native OAuth turn and cached availability alive when only one resolver caller cancels', async () => {
    const f = await fixture(), credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-native-access', refreshToken: 'private-native-refresh', expiresAt: Date.now() + 3600000,
      subscription: { provider: 'radius', gateway: f.gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    let hold = false, sourceReached!: () => void, chunkReached!: () => void, release!: () => void;
    const sourceStarted = new Promise<void>(resolve => { sourceReached = resolve; }), chunkStarted = new Promise<void>(resolve => { chunkReached = resolve; }), heldChunk = new Promise<void>(resolve => { release = resolve; });
    const provider = new RadiusProvider(f.config, async () => { if (hold) { hold = false; sourceReached(); return new Promise(() => undefined); } return credential; }, credential);
    await provider.getAvailableModels(); hold = true; const caller = new AbortController();
    const cancelled = provider.chat([user()], { signal: caller.signal }).catch(error => error); await sourceStarted;
    let complete = false, failure: Error | undefined;
    const other = provider.streamChat([user()], async () => { chunkReached(); await heldChunk; }, () => { complete = true; }, error => { failure = error; }); await chunkStarted;
    caller.abort(); expect(await cancelled).toBeInstanceOf(Error);
    const stillAvailable = provider.getCachedAvailableModelIds(), stillConfigured = provider.validateConfig(); release(); await other;
    expect(stillConfigured).toBe(true); expect(stillAvailable).toEqual(['account-only']); expect(complete).toBe(true); expect(failure).toBeUndefined();
    expect(f.calls).toHaveLength(2);
  });

  it('does not persist an authenticated catalogue after the live OAuth source is withdrawn', async () => {
    const f = await fixture(), credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-native-access', refreshToken: 'private-native-refresh', expiresAt: Date.now() + 3600000,
      subscription: { provider: 'radius', gateway: f.gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    let reads = 0; const provider = new RadiusProvider(f.config, async () => ++reads === 1 ? credential : undefined, credential);
    await expect(provider.getAvailableModels()).rejects.toThrow('Radius catalogue request aborted.');
    expect(f.calls).toHaveLength(1); expect(provider.getPublishedModels()).toEqual([]); await expect(readdir(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['caller', 'scope'] as const)('retires a pending native OAuth resolver on %s cancellation before any transport', async owner => {
    const f = await fixture(), caller = new AbortController(), scope = createProviderNetworkScope(); let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const provider = new RadiusProvider({ ...f.config, [PROVIDER_NETWORK_SCOPE]: scope }, () => { reached(); return new Promise(() => undefined); });
    const result = provider.chat([user()], { signal: caller.signal }).catch(error => error); await started;
    if (owner === 'caller') caller.abort(); else await closeProviderNetworkDispatchers(scope);
    expect(await result).toBeInstanceOf(Error); expect(f.calls).toHaveLength(0); await closeProviderNetworkDispatchers(scope);
  });
  it('admits dynamic P models only after authenticated discovery, persists exact account state and reloads offline without a baseline overlay', async () => {
    const { config, provider, directory, gateway, calls, set } = await fixture();
    expect(provider.getPublishedModels()).toEqual([]); await expect(provider.chat([user()])).rejects.toThrow('Radius request failed.'); expect(calls).toHaveLength(0);
    expect(await provider.getAvailableModels()).toEqual(['account-only']);
    expect(calls[0]).toEqual({ method: 'GET', url: '/v1/config', auth: `Bearer ${key}`, body: undefined });
    expect(provider.getPublishedModels()).toMatchObject([{ id: 'account-only', api: 'pi-messages', contextWindow: 4096, maxOutputTokens: 1024, capabilities: { reasoning: false, imageInput: false, toolCalls: true } }]);
    expect(await provider.chat([user()])).toMatchObject({ content: 'allowed', model: 'account-only', api: 'pi-messages', usage: { totalTokens: 10, costUsd: 0.001 } });
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/account/v1/messages', auth: `Bearer ${key}`, body: { model: 'account-only' } });
    const files = await readdir(directory); expect(files).toHaveLength(1);
    const file = path.join(directory, files[0]!); expect((await stat(file)).mode & 0o777).toBe(0o600); expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(file, 'utf8')).not.toContain(key);
    const restored = new RadiusProvider(config), before = calls.length;
    expect(await restored.getAvailableModels({ allowNetwork: false })).toEqual(['account-only']);
    const offline = await collectProviderModelCatalog(new Map([['owned-radius', restored]]), { discover: false });
    expect(offline[0]!.models).toMatchObject([{ id: 'account-only', available: true, api: 'pi-messages' }]); expect(calls).toHaveLength(before);
    set({ baseUrl: `${gateway}/account/v1`, models: [] }); expect(await provider.getAvailableModels()).toEqual([]);
    expect(provider.getPublishedModels()).toEqual([]); expect(new RadiusProvider(config).getCachedAvailableModelIds()).toEqual([]);
    await expect(provider.chat([user()])).rejects.toThrow('Radius request failed.'); expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('replaces the shipped29 baseline with known-empty and never revives it on offline reload or another account cache write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-baseline-')); roots.push(root);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => Response.json({ baseUrl: 'https://radius.pi.dev/v1',
      models: new Headers(init?.headers).get('authorization') === `Bearer ${key}` ? [] : [model('account-b')] }));
    const config = { type: 'radius', apiKey: key, catalogueDirectory: root };
    const first = new RadiusProvider(config); expect(first.getPublishedModels()).toHaveLength(29); expect(await first.getAvailableModels()).toEqual([]);
    expect(new RadiusProvider(config).getPublishedModels()).toEqual([]);
    const second = new RadiusProvider({ ...config, apiKey: 'synthetic-account-b' }); expect(await second.getAvailableModels()).toEqual(['account-b']);
    expect(new RadiusProvider(config).getPublishedModels()).toEqual([]); expect(await readdir(root)).toHaveLength(2);
    const offline = await collectProviderModelCatalog(new Map([['radius', new RadiusProvider(config)]]), { discover: false });
    expect(offline[0]!.models).toEqual([]); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps keys, gateway origins and explicit proxy overrides in distinct cache scopes', async () => {
    const { provider, config, gateway, calls } = await fixture(); await provider.getAvailableModels();
    for (const isolated of [new RadiusProvider({ ...config, apiKey: 'synthetic-other-key' }),
      new RadiusProvider({ ...config, gateway: gateway.replace('127.0.0.1', 'localhost') }),
      new RadiusProvider({ ...config, baseUrl: `${gateway}/explicit/v1` }),
      new RadiusProvider({ ...config, customHeaders: { 'x-tenant': 'synthetic-other-tenant' } })]) {
      expect(await isolated.getAvailableModels({ allowNetwork: false })).toEqual([]); expect(isolated.getPublishedModels()).toEqual([]);
    }
    expect(calls).toHaveLength(1);
  });

  it.each(['origin', 'url-credentials', 'duplicate', 'price', 'window', 'input', 'count'] as const)('rejects invalid %s configuration without retargeting a Bearer or persisting partial models', async kind => {
    const { provider, gateway, set, calls, directory } = await fixture();
    const value: Record<string, any> = { baseUrl: `${gateway}/account/v1`, models: [model()] };
    if (kind === 'origin') value.baseUrl = 'https://never-send.test/v1';
    if (kind === 'url-credentials') value.baseUrl = gateway.replace('http://', 'http://synthetic@') + '/v1';
    if (kind === 'duplicate') value.models.push(model());
    if (kind === 'price') value.models[0].cost.input = -1;
    if (kind === 'window') value.models[0].contextWindow = 0;
    if (kind === 'input') value.models[0].input = ['audio'];
    if (kind === 'count') value.models = Array.from({ length: 501 }, (_value, index) => model(`model-${index}`));
    set(value); await expect(provider.getAvailableModels()).rejects.toThrow('Radius catalogue is unavailable.');
    expect(provider.getPublishedModels()).toEqual([]); expect(calls).toHaveLength(1); expect(calls[0]!.method).toBe('GET');
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses only an explicit caller proxy when discovery advertises another inference origin', async () => {
    const { config, gateway, set, calls } = await fixture();
    const provider = new RadiusProvider({ ...config, baseUrl: `${gateway}/explicit/v1` });
    set({ baseUrl: 'https://never-send.test/v1', models: [model()] });
    await provider.getAvailableModels(); await provider.chat([user()]);
    expect(calls.map(call => call.url)).toEqual(['/v1/config', '/explicit/v1/messages']);
    expect(calls.every(call => call.auth === `Bearer ${key}`)).toBe(true);
  });

  it('rejects a superseded late refresh without replacing the newer known-empty cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-superseded-')); roots.push(root);
    let entered!: () => void, release!: (response: Response) => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => { entered(); return held; })
      .mockResolvedValueOnce(Response.json({ baseUrl: 'https://radius.pi.dev/v1', models: [] }));
    const config = { type: 'radius', apiKey: key, catalogueDirectory: root }, provider = new RadiusProvider(config);
    const previous = provider.getAvailableModels().catch(error => error); await reached;
    expect(await provider.getAvailableModels()).toEqual([]);
    release(Response.json({ baseUrl: 'https://radius.pi.dev/v1', models: [model('stale')] }));
    expect(await previous).toMatchObject({ message: 'Radius catalogue request aborted.' });
    expect(provider.getPublishedModels()).toEqual([]); expect(new RadiusProvider(config).getPublishedModels()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps ambiguous zero catalogue prices unknown while preserving genuinely reported P cost', async () => {
    const { provider, gateway, set } = await fixture();
    set({ baseUrl: `${gateway}/account/v1`, models: [{ ...model(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    await provider.getAvailableModels(); expect(provider.getPublishedModels()[0]!.pricing).toBeUndefined();
    expect((await provider.chat([user()])).usage?.costUsd).toBe(0.001);
  });

  it.each([false, true])('retires active inference only for a changed catalogue (withdraw=%s)', async withdraw => {
    const { provider, gateway, set, calls } = await fixture(); await provider.getAvailableModels();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const completed = vi.fn(), failed = vi.fn();
    const pending = provider.streamChat([user()], async () => { entered(); await held; }, completed, failed);
    await reached;
    if (withdraw) set({ baseUrl: `${gateway}/account/v1`, models: [] });
    await provider.getAvailableModels(); release(); await pending;
    if (withdraw) { expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); }
    else { expect(completed).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled(); }
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it.each(['deadline', 'owner'] as const)('propagates shared discovery %s cancellation into an uncooperative config body without late cache publication', async lifetime => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-timeout-')); roots.push(root);
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    const cancel = vi.fn(() => new Promise<never>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"baseUrl":"https://radius.pi.dev/v1","models":[')); },
      pull() { entered(); return new Promise<never>(() => undefined); }, cancel });
    let requestSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { requestSignal = init?.signal; return new Response(body, { headers: { 'content-type': 'application/json' } }); });
    const provider = new RadiusProvider({ type: 'radius', apiKey: key, catalogueDirectory: root });
    const owner = new AbortController();
    const pending = discoverProviderModelIds(provider, { timeoutMs: lifetime === 'deadline' ? 25 : 8_000, retries: 0, signal: owner.signal }).catch(error => error);
    await reached; if (lifetime === 'owner') owner.abort(new Error(key));
    expect((await pending).message).toBe(lifetime === 'deadline' ? 'Model discovery timed out.' : 'Model discovery aborted.');
    expect(requestSignal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1); expect(await readdir(root)).toEqual([]);
    expect(provider.getPublishedModels()).toHaveLength(29);
  });

  it('refuses malformed or linked private cache files without reading or modifying a synthetic credential target', async () => {
    const { provider, directory, root, config } = await fixture(); await provider.getAvailableModels();
    const file = path.join(directory, (await readdir(directory))[0]!);
    const invalidUtf8 = await readFile(file); invalidUtf8[invalidUtf8.indexOf('Account model')] = 0xff;
    await writeFile(file, invalidUtf8); expect(() => new RadiusProvider(config)).toThrow('Radius catalogue is unavailable.');
    await writeFile(file, '{invalid', { mode: 0o600 }); expect(() => new RadiusProvider(config)).toThrow('Radius catalogue is unavailable.');
    await unlink(file); const target = path.join(root, 'synthetic-credential-target'); const contents = '{"apiKey":"synthetic-unrelated"}';
    await writeFile(target, contents, { mode: 0o600 }); await symlink(target, file);
    expect(() => new RadiusProvider(config)).toThrow('Radius catalogue is unavailable.'); expect(await readFile(target, 'utf8')).toBe(contents);
  });
});
