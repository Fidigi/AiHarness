import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { ProviderRegistryService } from './provider-registry.js';
import { ProviderOAuthService, customRadiusOAuthContext } from './provider-oauth.js';
import { AiProxyServer } from '../api/proxy.js';
const roots: string[] = [], oauth: ProviderOAuthService[] = [], gateway = 'https://synthetic-server-radius.test', id = 'custom-radius', master = 'synthetic-radius-service-master';
const tokens = () => Response.json({ access_token: 'private-radius-access', refresh_token: 'private-radius-refresh', expires_in: 3600 });
const device = () => Response.json({ device_code: 'private-radius-device', user_code: 'VISIBLE-CODE', verification_uri: gateway + '/verify', expires_in: 600, interval: 1 });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
afterEach(async () => { for (const service of oauth.splice(0)) service.close(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(hold = false, closeOnPublish = false, persistent = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-oauth-service-')); roots.push(root); const proxy = new AiProxyServer();
  const registry = new ProviderRegistryService(path.join(root, 'providers.json'), proxy, path.join(root, 'secrets.enc'), persistent ? master : ''); await registry.load();
  await registry.upsertProvider({ id, name: 'Radius', baseUrl: gateway, dialect: 'radius' });
  const held = deferred<Response>(), reached = deferred<void>(), invalidate = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).endsWith('/device')) return device();
    if (String(url).endsWith('/v1/oauth')) return Response.json({ authorizationEndpoint: 'https://synthetic-navigation.test/authorize' });
    expect(String(url)).toBe(gateway + '/v1/oauth/token'); reached.resolve(undefined); return hold ? held.promise : tokens();
  });
  const prepare = customRadiusOAuthContext(Promise.resolve({ providerRegistry: registry, modelCatalog: { invalidateProvider: invalidate } }));
  const service = new ProviderOAuthService(proxy, () => undefined, fetcher, undefined, async (provider, signal) => {
    const context = await prepare(provider, signal); return { ...context, publish: async credential => { const admit = await context.publish(credential); if (closeOnPublish) service.close(); return admit; } };
  }); oauth.push(service);
  const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(path.join(root, 'secrets.enc'), master) });
  return { root, proxy, registry, service, held, reached, fetcher, reader, invalidate };
}
it('requires the custom encrypted store before native Radius issuer work', async () => {
  const f = await fixture(false, false, false); await expect(f.service.start(id)).rejects.toMatchObject({ status: 409 }); expect(f.fetcher).not.toHaveBeenCalled();
});
it('owns native Radius device login in the existing custom encrypted slot, without API-key flattening or account discovery', async () => {
  const f = await fixture(), flow = await f.service.start(id);
  expect(flow).toMatchObject({ provider: id, state: 'pending', userCode: 'VISIBLE-CODE', verificationUri: gateway + '/verify' });
  await f.registry.reload();
  await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('connected'), { timeout: 5000 });
  expect(f.proxy.isConfigured(id)).toBe(true); expect(f.invalidate).toHaveBeenCalledWith(id);
  expect(f.proxy.getAgentProvider(id)!.getPublishedModels?.()).toEqual([]); expect(f.fetcher).toHaveBeenCalledTimes(2);
  const reader = f.reader(); await reader.load(); expect((await reader.resolve(id, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: 'private-radius-access', subscription: { provider: 'radius', gateway } });
  expect(await reader.resolve(id, { env: {} })).toBeUndefined(); expect(JSON.stringify(f.service.get(flow.id))).not.toContain('private-radius');
});
it('does not retire an existing browser flow for a pre-aborted replacement request', async () => {
  const f = await fixture(), flow = await f.service.start(id, undefined, 'browser'), caller = new AbortController(); caller.abort();
  await expect(f.service.start(id, caller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.service.get(flow.id)?.state).toBe('pending'); expect(f.fetcher).toHaveBeenCalledOnce();
});
it('keeps browser state and fixed full-redirect ownership while allowing a valid retry after malformed input', async () => {
  const f = await fixture(), flow = await f.service.start(id, undefined, 'browser'), url = new URL(flow.authorizationUrl!);
  expect(url.origin).toBe('https://synthetic-navigation.test'); expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1456/oauth/callback');
  await expect(f.service.redirect(flow.id, 'http://127.0.0.1:1456/oauth/callback?state=wrong&code=private-code')).rejects.toMatchObject({ status: 400 });
  expect(f.service.get(flow.id)?.state).toBe('pending'); expect(f.fetcher).toHaveBeenCalledOnce();
  expect(await f.service.redirect(flow.id, `http://127.0.0.1:1456/oauth/callback?state=${url.searchParams.get('state')}&code=private-code`)).toMatchObject({ state: 'connected', provider: id });
  expect(f.fetcher.mock.calls.map(call => call[0])).toEqual([gateway + '/v1/oauth', gateway + '/v1/oauth/token']); expect(f.proxy.isConfigured(id)).toBe(true);
});
it.each(['replace', 'disconnect', 'shutdown'] as const)('retires a held native token response on %s without a late encrypted grant or mount', async action => {
  const f = await fixture(true), flow = await f.service.start(id); await f.reached.promise;
  if (action === 'replace') await f.registry.upsertProvider({ apiKey: 'private-replacement' }, id);
  else if (action === 'disconnect') await f.registry.disconnect(id); else f.service.close();
  if (action !== 'shutdown') await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('cancelled'));
  const cancelled = vi.fn(); f.held.resolve(new Response(new ReadableStream({ cancel: cancelled }))); await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  const reader = f.reader(); await reader.load(); expect(await reader.resolve(id, { env: {}, subscriptionProvider: 'radius' })).toBeUndefined(); expect(f.registry.hasRadiusOAuth(id)).toBe(false);
  expect(f.proxy.isConfigured(id)).toBe(action === 'replace'); expect(f.invalidate).not.toHaveBeenCalled();
});
it('cancels the initial native device request and abandons its late body without publishing a flow', async () => {
  const f = await fixture(), caller = new AbortController(), held = deferred<Response>(), reached = deferred<void>(), cancel = vi.fn();
  f.fetcher.mockImplementationOnce(() => { reached.resolve(undefined); return held.promise; });
  const pending = f.service.start(id, caller.signal).catch(error => error); await reached.promise; caller.abort(); expect(await pending).toBeInstanceOf(Error);
  held.resolve(new Response(new ReadableStream({ cancel }))); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(f.registry.hasRadiusOAuth(id)).toBe(false);
});
it('does not mount after an already committed native grant returns to a retired OAuth owner', async () => {
  const f = await fixture(false, true); await f.service.start(id);
  await vi.waitFor(() => expect(f.registry.hasRadiusOAuth(id)).toBe(true), { timeout: 5000 });
  expect(f.proxy.isConfigured(id)).toBe(false); expect(f.invalidate).not.toHaveBeenCalled();
  const reader = f.reader(); await reader.load(); expect((await reader.resolve(id, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: 'private-radius-access' });
});
