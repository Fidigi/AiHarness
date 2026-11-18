import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectProviderModelCatalog, EncryptedCredentialStore, ProviderCredentialService, ProviderFactory } from '../index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-offline-policy-')); roots.push(root); return root; }

describe('explicit passive Core provider policies', () => {
  it('skips discovery capability/callbacks, preserving published and configured metadata', async () => {
    const provider = ProviderFactory.create({ type: 'mock', model: 'private-configured-model' });
    const capability = vi.spyOn(provider, 'canDiscoverModels').mockReturnValue(true);
    const discovery = vi.spyOn(provider, 'getAvailableModels').mockResolvedValue(['live-only-model']);
    const providers = new Map([['mock', provider]]);
    const offline = await collectProviderModelCatalog(providers, Object.freeze({ discover: false, includePublishedProviders: true }));
    expect(offline.find(item => item.provider === 'mock')?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'private-configured-model', source: 'configured', available: true }),
      expect.objectContaining({ id: 'mock-model', source: 'published', available: true }),
    ]));
    expect(offline.flatMap(item => item.models).some(item => item.id === 'live-only-model')).toBe(false);
    expect(offline.some(item => item.provider === 'anthropic' && !item.configured)).toBe(true);
    expect(capability).not.toHaveBeenCalled(); expect(discovery).not.toHaveBeenCalled();
    const online = await collectProviderModelCatalog(providers);
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(online[0].models.some(item => item.id === 'live-only-model' && item.source === 'discovered')).toBe(true);
  });
  it('does not turn an unavailable provider into an available offline provider', async () => {
    const provider = ProviderFactory.create({ type: 'mock' }); vi.spyOn(provider, 'validateConfig').mockReturnValue(false);
    const discovery = vi.spyOn(provider, 'getAvailableModels').mockRejectedValue(new Error('must not be called'));
    expect((await collectProviderModelCatalog(new Map([['mock', provider]]), { discover: false }))[0])
      .toMatchObject({ configured: false, models: expect.arrayContaining([expect.objectContaining({ available: false })]) });
    expect(discovery).not.toHaveBeenCalled();
  });
  it('denies a selected command without execution, cache use, or lower-priority fallback', async () => {
    const root = await fixture(), marker = path.join(root, 'command');
    const service = new ProviderCredentialService(); await service.setApiKey('openai', 'stored-fallback', false);
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write('command-value')`)}`;
    const env = { AI_HARNESS_OPENAI_API_KEY_COMMAND: command };
    expect(await service.resolve('openai', { env, allowCommands: false })).toBeUndefined();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await service.resolve('openai', { env }))?.descriptor.source).toBe('command');
    expect(await readFile(marker, 'utf8')).toBe('executed');
    expect(await service.resolve('openai', { env, allowCommands: false })).toBeUndefined();
    expect((await service.resolve('openai', { env: {}, allowCommands: false }))?.credential).toMatchObject({ apiKey: 'stored-fallback' });
    expect((await service.resolve('openai', { env: { ...env, OPENAI_API_KEY: 'explicit-environment' }, allowCommands: false }))?.descriptor.source).toBe('environment');
  });
  for (const persistent of [false, true]) {
    it(`${persistent ? 'encrypted' : 'memory'}: refuses expired OAuth without refresh/config getters or mutation, retaining explicit refresh`, async () => {
      const root = await fixture(), filename = path.join(root, 'credentials.enc');
      const store = persistent ? new EncryptedCredentialStore(filename, 'a sufficiently long offline fixture key') : undefined;
      const service = new ProviderCredentialService({ store }); await service.load();
      await service.setOAuth('openai', { accessToken: 'expired-access', refreshToken: 'held-refresh', expiresAt: 1 }, persistent);
      const bytes = persistent ? await readFile(filename) : undefined;
      const descriptors = service.list(); let getterCalls = 0;
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), { status: 200 }));
      expect(await service.resolve('openai', { env: {}, allowRefresh: false, fetcher, get oauth(): never { getterCalls++; throw new Error('Must not read refresh settings'); } })).toBeUndefined();
      expect(getterCalls).toBe(0); expect(fetcher).not.toHaveBeenCalled(); expect(service.list()).toEqual(descriptors);
      if (persistent) expect(await readFile(filename)).toEqual(bytes);
      expect(await service.reveal('openai', { env: {}, allowRefresh: false })).toBeUndefined();
      const refreshed = await service.resolve('openai', { env: {}, fetcher, oauth: { tokenUrl: 'https://oauth.example.test/token', clientId: 'fixture-client' } });
      expect(fetcher).toHaveBeenCalledTimes(1); expect(refreshed?.credential).toMatchObject({ accessToken: 'fresh-access' });
      if (persistent) expect(await readFile(filename)).not.toEqual(bytes);
      expect((await service.resolve('openai', { env: {}, allowRefresh: false }))?.credential).toMatchObject({ accessToken: 'fresh-access' });
    });
  }
  it('retains missing-refresh diagnostics by default but permits passive inspection without configuration', async () => {
    const service = new ProviderCredentialService(); await service.setOAuth('openai', { accessToken: 'expired-access', expiresAt: 1 }, false);
    await expect(service.resolve('openai', { env: {} })).rejects.toMatchObject({ code: 'refresh-unavailable' });
    expect(await service.resolve('openai', { env: {}, allowRefresh: false })).toBeUndefined();
    expect(service.list()).toEqual([expect.objectContaining({ expiresAt: 1, refreshable: false })]);
  });
});
