import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService, type RadiusOAuthCredential } from '@ai-harness/core';
import { ProviderRegistryService } from './provider-registry.js';
import { AiProxyServer } from '../api/proxy.js';
const roots: string[] = [], gateway = 'https://synthetic-radius.test', id = 'owned-radius', master = 'synthetic-registry-radius-master';
const credential = (): RadiusOAuthCredential => ({ accessToken: 'private-radius-access', refreshToken: 'private-radius-refresh', expiresAt: Date.now() + 3600000,
  subscription: { provider: 'radius', gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-registry-')); roots.push(root);
  const file = path.join(root, 'providers.json'), secretFile = path.join(root, 'secrets.enc'), proxy = new AiProxyServer();
  const service = new ProviderRegistryService(file, proxy, secretFile, master); await service.load();
  await service.upsertProvider({ id, name: 'Owned Radius', baseUrl: gateway, dialect: 'radius', headers: { 'x-tenant': 'private-header' } });
  const reader = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(secretFile, master) });
  const login = async () => { const controller = new AbortController(), context = await service.prepareRadiusOAuth(id, controller.signal), admit = await context.publish(credential()); admit(); controller.abort(); return context; };
  return { root, file, secretFile, proxy, service, reader, login };
}
it('keeps native refresh live, header edits credential-preserving, metadata private and account caches owned across reload', async () => {
  const f = await fixture(); await f.login(); expect(f.service.hasRadiusOAuth(id)).toBe(true);
  const writer = f.reader(); await writer.load(); await writer.setOAuth(id, { ...credential(), expiresAt: 1 });
  const calls: Array<{ url: string; key: string | null; tenant: string | null }> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const headers = new Headers(init?.headers); calls.push({ url: String(url), key: headers.get('authorization'), tenant: headers.get('x-tenant') });
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'private-radius-rotated', refresh_token: 'private-refresh-rotated', expires_in: 3600 });
    return Response.json({ baseUrl: gateway + '/v1', models: [{ id: 'account-only', name: 'Owned', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 65536, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
  });
  const originalProvider = f.proxy.getAgentProvider(id)!;
  expect(await originalProvider.getAvailableModels()).toEqual(['account-only']);
  expect(calls).toEqual([{ url: gateway + '/v1/oauth/token', key: null, tenant: null }, { url: gateway + '/v1/config', key: 'Bearer private-radius-rotated', tenant: 'private-header' }]);
  await f.service.upsertProvider({ name: 'Edited name', headers: { 'x-tenant': 'private-next-header' } }, id); expect(fetch).toHaveBeenCalledTimes(2);
  await expect(originalProvider.getAvailableModels()).rejects.toThrow('Radius'); expect(fetch).toHaveBeenCalledTimes(2);
  await writer.load(); expect((await writer.resolve(id, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: 'private-radius-rotated', refreshToken: 'private-refresh-rotated', subscription: credential().subscription });
  expect(f.proxy.getAgentProvider(id)!.getCachedAvailableModelIds?.()).toEqual([]);
  expect(await f.proxy.getAgentProvider(id)!.getAvailableModels()).toEqual(['account-only']); expect(calls.at(-1)?.tenant).toBe('private-next-header');
  const restoredProxy = new AiProxyServer(), restored = new ProviderRegistryService(f.file, restoredProxy, f.secretFile, master); await restored.load();
  expect(restored.hasRadiusOAuth(id)).toBe(true); expect(restoredProxy.getAgentProvider(id)!.getCachedAvailableModelIds?.()).toEqual(['account-only']); expect(fetch).toHaveBeenCalledTimes(3);
  const metadata = JSON.stringify(f.service.listProviders()) + await readFile(f.file, 'utf8') + await readFile(f.secretFile, 'utf8');
  for (const secret of ['private-radius-access', 'private-radius-rotated', 'private-radius-refresh', 'private-refresh-rotated', 'private-header', 'private-next-header']) expect(metadata).not.toContain(secret);
  await f.service.upsertProvider({ baseUrl: 'https://foreign-radius.test' }, id); expect(f.proxy.isConfigured(id)).toBe(false); expect(fetch).toHaveBeenCalledTimes(3);
});
it.each(['update', 'disconnect', 'delete'] as const)('withdraws a reserved native login on %s without late credential resurrection', async action => {
  const f = await fixture(), parent = new AbortController(), context = await f.service.prepareRadiusOAuth(id, parent.signal);
  if (action === 'update') await f.service.upsertProvider({ name: 'Replacement' }, id);
  else if (action === 'disconnect') await f.service.disconnect(id); else await f.service.deleteProvider(id);
  expect(context.signal.aborted).toBe(true); await expect(context.publish(credential())).rejects.toBeDefined();
  const reader = f.reader(); await reader.load(); expect(await reader.resolve(id, { env: {}, subscriptionProvider: 'radius' })).toBeUndefined();
});
it('does not cancel a valid pending grant or leak its replacement when the new caller was already aborted', async () => {
  const f = await fixture(), owner = new AbortController(), pending = await f.service.prepareRadiusOAuth(id, owner.signal), cancelled = new AbortController(); cancelled.abort();
  await expect(f.service.prepareRadiusOAuth(id, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(pending.signal.aborted).toBe(false); expect(f.service.hasPendingRadiusOAuth(id)).toBe(true); owner.abort(); expect(f.service.hasPendingRadiusOAuth(id)).toBe(false);
});
it('keeps an unchanged canonical reload eligible but excludes rename while the native grant is pending', async () => {
  const f = await fixture(), parent = new AbortController(), context = await f.service.prepareRadiusOAuth(id, parent.signal);
  await f.service.reload(); expect(context.signal.aborted).toBe(false);
  await expect(f.service.renameProvider(id, 'renamed-radius', f.service.getRevision(), commit => commit())).rejects.toMatchObject({ status: 409, code: 'PROVIDER_OAUTH_PENDING' });
  const admit = await context.publish(credential()); admit(); parent.abort(); expect(f.proxy.isConfigured(id)).toBe(true);
});
it('preflights unsafe native catalogue storage before credential mutation and checks the final admission owner', async () => {
  const f = await fixture(), parent = new AbortController(), context = await f.service.prepareRadiusOAuth(id, parent.signal);
  const before = await readFile(f.secretFile), metadata = await readFile(f.file), directory = path.join(f.root, 'radius-models'); await mkdir(directory);
  await symlink(f.root, path.join(directory, id)); await expect(context.publish(credential())).rejects.toThrow('Radius catalogue');
  expect(await readFile(f.secretFile)).toEqual(before); expect(await readFile(f.file)).toEqual(metadata); parent.abort();
  await rm(path.join(directory, id)); const next = new AbortController(), eligible = await f.service.prepareRadiusOAuth(id, next.signal), admit = await eligible.publish(credential()); next.abort();
  expect(() => admit()).toThrow(); expect(f.proxy.isConfigured(id)).toBe(false);
  const reader = f.reader(); await reader.load(); expect((await reader.resolve(id, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: credential().accessToken });
});
it.each(['upsert', 'disconnect', 'delete'] as const)('restores native OAuth rather than flattening it on failed %s metadata persistence', async action => {
  const f = await fixture(); await f.login();
  vi.spyOn(f.service as unknown as { persist(): Promise<void> }, 'persist').mockRejectedValueOnce(new Error('Synthetic registry write refusal'));
  const operation = action === 'upsert' ? f.service.upsertProvider({ apiKey: 'private-replacement' }, id) : action === 'disconnect' ? f.service.disconnect(id) : f.service.deleteProvider(id);
  await expect(operation).rejects.toThrow('Synthetic registry write refusal');
  const reader = f.reader(); await reader.load(); expect((await reader.resolve(id, { env: {}, subscriptionProvider: 'radius' }))?.credential).toMatchObject({ accessToken: credential().accessToken, subscription: credential().subscription });
  expect(await reader.resolve(id, { env: {} })).toBeUndefined(); expect(f.proxy.isConfigured(id)).toBe(true);
});
it('does not resurrect an old native grant over another encrypted owner during rollback', async () => {
  const f = await fixture(); await f.login(); const writer = f.reader(); await writer.load();
  vi.spyOn(f.service as unknown as { persist(): Promise<void> }, 'persist').mockImplementationOnce(async () => { await writer.setApiKey(id, 'private-newer-owner'); throw new Error('Synthetic write refusal'); });
  await expect(f.service.upsertProvider({ apiKey: 'private-attempt' }, id)).rejects.toMatchObject({ status: 500, uncertain: true });
  await writer.load(); expect((await writer.resolve(id, { env: {} }))?.credential).toMatchObject({ apiKey: 'private-newer-owner' }); expect(await writer.resolve(id, { env: {}, subscriptionProvider: 'radius' })).toBeUndefined();
});
