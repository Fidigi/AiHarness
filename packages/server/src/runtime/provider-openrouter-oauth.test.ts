import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, OpenRouterProvider, ProviderCredentialService } from '@ai-harness/core';
import { ProviderRegistryService } from './provider-registry.js';
import { AiProxyServer } from '../api/proxy.js';
const roots: string[] = [], id = 'custom-router', key = 'synthetic-router-key', newest = 'synthetic-newer-router-key', master = 'synthetic-router-server-master';
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-router-oauth-server-')); roots.push(root);
  const proxy = new AiProxyServer(), file = path.join(root, 'secrets.enc'), registry = new ProviderRegistryService(path.join(root, 'providers.json'), proxy, file, master); await registry.load();
  await registry.upsertProvider({ id, name: 'Router', dialect: 'openrouter', baseUrl: 'https://synthetic-inference.test/proxy', headers: { 'x-tenant': 'synthetic-private-header' } });
  const reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) }); return { root, proxy, file, registry, reader };
}
it('publishes a custom OpenRouter key without false credentialless connection, refresh metadata or early admission', async () => {
  const f = await fixture(); expect(f.registry.listProviders()[0].configured).toBe(false); expect(f.proxy.isConfigured(id)).toBe(false);
  const owner = new AbortController(), context = await f.registry.prepareNativeOAuth(id, owner.signal); expect(context).toMatchObject({ issuer: 'openrouter', realm: 'https://openrouter.ai' });
  const admit = await context.publish({ apiKey: key }); expect(f.proxy.isConfigured(id)).toBe(false); admit(); owner.abort(); expect(f.proxy.getAgentProvider(id)).toBeInstanceOf(OpenRouterProvider);
  await f.reader.load(); expect((await f.reader.resolve(id, { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: key }); expect(f.reader.list()).toMatchObject([{ refreshable: false }]); expect(f.registry.hasNativeOAuth(id)).toBe(false);
  await f.registry.reload(); expect(f.registry.listProviders()[0].configured).toBe(true);
});
it('retires pending OpenRouter publication on disconnect/rename and refuses its late admission', async () => {
  const f = await fixture(), context = await f.registry.prepareNativeOAuth(id, new AbortController().signal);
  await expect(f.registry.renameProvider(id, 'renamed-router', f.registry.getRevision(), commit => commit())).rejects.toMatchObject({ code: 'PROVIDER_OAUTH_PENDING' });
  await f.registry.disconnect(id); expect(context.signal.aborted).toBe(true); await expect(context.publish({ apiKey: key })).rejects.toThrow();
  const replacement = await f.registry.prepareNativeOAuth(id, new AbortController().signal), admit = await replacement.publish({ apiKey: key }); await f.registry.disconnect(id); expect(() => admit()).toThrow();
  await f.reader.load(); expect(await f.reader.resolve(id, { env: {} })).toBeUndefined();
});
it.each(['commit', 'rollback', 'replace'] as const)('preserves a newer OpenRouter key across metadata/header %s without rewriting its slot', async action => {
  const f = await fixture(); await f.reader.load(); const publish = await f.reader.prepareApiKeyLogin(id); await publish(key); await f.registry.reload();
  if (action === 'commit') {
    const update = EncryptedCredentialStore.prototype.update; let injected = false;
    vi.spyOn(EncryptedCredentialStore.prototype, 'update').mockImplementation(async function(this: EncryptedCredentialStore, values) {
      if (!injected && `provider-headers:${id}` in values) { injected = true; await f.reader.setApiKey(id, newest); }
      return update.call(this, values);
    });
    await f.registry.upsertProvider({ name: 'Edited', headers: { 'x-tenant': 'synthetic-next-header' } }, id); expect(injected).toBe(true);
  } else {
    vi.spyOn(f.registry as unknown as { persist(): Promise<void> }, 'persist').mockImplementationOnce(async () => { await f.reader.setApiKey(id, newest); throw new Error('Synthetic metadata refusal'); });
    const pending = f.registry.upsertProvider({ name: 'Edited', ...(action === 'replace' ? { apiKey: 'synthetic-replaced-key' } : {}) }, id);
    if (action === 'replace') await expect(pending).rejects.toMatchObject({ uncertain: true }); else await expect(pending).rejects.toThrow('Synthetic metadata refusal');
  }
  await f.reader.load(); expect((await f.reader.resolve(id, { env: {} }))?.credential).toMatchObject({ type: 'api-key', apiKey: newest }); await f.registry.reload();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { expect(String(url)).toBe('https://synthetic-inference.test/proxy/v1/chat/completions'); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${newest}`); expect(new Headers(init?.headers).get('x-tenant')).toBe(action === 'commit' ? 'synthetic-next-header' : 'synthetic-private-header'); return Response.json({ choices: [{ message: { role: 'assistant', content: 'newer-key-kept' }, finish_reason: 'stop' }] }); });
  expect(await f.proxy.getAgentProvider(id)!.chat([{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }])).toMatchObject({ content: 'newer-key-kept' }); expect(fetcher).toHaveBeenCalledOnce();
});
