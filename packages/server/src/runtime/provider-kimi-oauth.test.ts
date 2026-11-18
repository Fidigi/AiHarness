import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, KimiCodingOAuthProvider, ProviderCredentialService, type KimiCodingOAuthCredential } from '@ai-harness/core';
import { ProviderRegistryService } from './provider-registry.js';
import { AiProxyServer } from '../api/proxy.js';
const roots: string[] = [], issuer = 'https://synthetic-server-kimi.test', id = 'custom-kimi', master = 'synthetic-kimi-server-master';
const credential = (): KimiCodingOAuthCredential => ({ accessToken: 'private-kimi-access', refreshToken: 'private-kimi-refresh', expiresAt: Date.now() + 3600000,
  subscription: { provider: 'kimi-coding', oauthHost: issuer, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-oauth-server-')); roots.push(root); vi.stubEnv('KIMI_CODE_OAUTH_HOST', issuer);
  const proxy = new AiProxyServer(), file = path.join(root, 'secrets.enc'), registry = new ProviderRegistryService(path.join(root, 'providers.json'), proxy, file, master); await registry.load();
  await registry.upsertProvider({ id, name: 'Kimi', dialect: 'kimi-coding', baseUrl: 'https://inference.kimi.test/coding', headers: { 'x-tenant': 'private-tenant' } });
  const reader = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  return { root, proxy, file, registry, reader };
}
it('prepares native custom Kimi in its existing encrypted slot, keeps the source live and preserves a refresh through metadata edits', async () => {
  const f = await fixture(); expect(f.registry.listProviders()[0].configured).toBe(false);
  const owner = new AbortController(), context = await f.registry.prepareNativeOAuth(id, owner.signal); expect(context).toMatchObject({ issuer: 'kimi-coding', realm: issuer });
  const admit = await context.publish(credential()); admit(); owner.abort(); expect(f.proxy.getAgentProvider(id)).toBeInstanceOf(KimiCodingOAuthProvider);
  await f.reader.load(); const stored = (await f.reader.resolve(id, { env: {}, subscriptionProvider: 'kimi-coding' }))!.credential; if (stored.type !== 'oauth') throw new Error('Expected native Kimi'); await f.reader.setOAuth(id, { ...stored, expiresAt: 1 });
  const calls: Array<{ url: string; auth: string | null }> = []; vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'private-kimi-rotated', refresh_token: 'private-kimi-rotated-refresh', expires_in: 3600 });
    expect(new Headers(init?.headers).get('x-tenant')).toBe('private-tenant'); return Response.json({ content: [{ type: 'text', text: 'native-kimi-server' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } });
  });
  const original = f.proxy.getAgentProvider(id)!; expect(await original.chat([{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }])).toMatchObject({ content: 'native-kimi-server', provider: id, api: 'anthropic-messages' });
  expect(calls).toEqual([{ url: issuer + '/api/oauth/token', auth: null }, { url: 'https://inference.kimi.test/coding/v1/messages', auth: 'Bearer private-kimi-rotated' }]);
  await f.registry.upsertProvider({ name: 'Edited', headers: { 'x-tenant': 'private-new-tenant' } }, id); await f.reader.load(); expect((await f.reader.resolve(id, { env: {}, subscriptionProvider: 'kimi-coding' }))?.credential).toMatchObject({ accessToken: 'private-kimi-rotated', subscription: stored.subscription });
  await expect(original.chat([])).rejects.toThrow('Kimi'); expect(calls).toHaveLength(2); expect(await f.reader.resolve(id, { env: {} })).toBeUndefined();
  expect(JSON.stringify(f.registry.listProviders()) + await readFile(path.join(f.root, 'providers.json'), 'utf8')).not.toContain('private-');
  vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://foreign.kimi.test'); await f.registry.reload(); expect(f.proxy.isConfigured(id)).toBe(false); expect(calls).toHaveLength(2);
});
it('retires pending native Kimi on disconnect and refuses final late admission', async () => {
  const f = await fixture(), owner = new AbortController(), context = await f.registry.prepareNativeOAuth(id, owner.signal);
  await expect(f.registry.renameProvider(id, 'renamed', f.registry.getRevision(), commit => commit())).rejects.toMatchObject({ code: 'PROVIDER_OAUTH_PENDING' });
  await f.registry.disconnect(id); expect(context.signal.aborted).toBe(true); await expect(context.publish(credential())).rejects.toThrow(); expect(f.registry.hasNativeOAuth(id)).toBe(false);
  const replacement = await f.registry.prepareNativeOAuth(id, new AbortController().signal), admit = await replacement.publish(credential());
  await f.registry.disconnect(id); expect(() => admit()).toThrow(); await f.reader.load(); expect(await f.reader.resolve(id, { env: {}, subscriptionProvider: 'kimi-coding' })).toBeUndefined();
});
