import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AiProxyServer } from '../api/proxy.js';
import { ProviderRegistryService } from './provider-registry.js';
import { ModelCatalogService } from './model-catalog.js';

const roots: string[] = [];
const servers: Server[] = [];
const key = 'test-only-master-key-provider-lifecycle';
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(masterKey = key) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-lifecycle-'));
  roots.push(root);
  const requests: Array<{ url: string; auth?: string; private?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, auth: request.headers.authorization, private: request.headers['x-private'] as string | undefined });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'bad\nvalue' }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = new AiProxyServer();
  const file = path.join(root, 'providers.json');
  const secrets = path.join(root, 'secrets.enc');
  const service = new ProviderRegistryService(file, proxy, secrets, masterKey);
  await service.load();
  const definition = { id: 'acme', name: 'Acme', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway/v1/chat/completions`, dialect: 'openai-completions' };
  return { root, proxy, file, secrets, service, definition, requests };
}
const commitOnly = (commit: () => Promise<void>) => commit();

describe('provider lifecycle', () => {
  it('discovers and imports a no-key configured endpoint through real HTTP', async () => {
    const { service, definition, proxy, requests } = await fixture('');
    await service.upsertProvider(definition);
    expect(service.hasCredentials('acme')).toBe(false);
    expect(await service.testProvider('acme')).toMatchObject({ ok: true, models: ['model-a'] });
    expect((await service.importProviderModels('acme')).map(model => model.key)).toEqual(['acme:model-a']);
    const catalog = new ModelCatalogService(proxy, () => service.getModels());
    expect((await catalog.getCatalog()).find(provider => provider.provider === 'acme')?.models)
      .toContainEqual(expect.objectContaining({ id: 'model-a', available: true }));
    expect(requests.every(request => request.url === '/gateway/v1/models' && !request.auth)).toBe(true);
  });
  it('binds discovery cache to source instances across reload, rename and old-ID reuse', async () => {
    const { service, definition, proxy, requests } = await fixture('');
    await service.upsertProvider(definition);
    const catalog = new ModelCatalogService(proxy);
    await catalog.getCatalog();
    const firstCount = requests.length;
    await service.reload();
    await catalog.getCatalog();
    expect(requests.length).toBeGreaterThan(firstCount);
    await service.renameProvider('acme', 'fresh', service.getRevision(), commitOnly);
    const renamed = await catalog.getCatalog();
    expect(renamed.some(provider => provider.provider === 'acme')).toBe(false);
    expect(renamed.find(provider => provider.provider === 'fresh')?.models)
      .toContainEqual(expect.objectContaining({ key: 'fresh:model-a', source: 'discovered' }));
    await service.upsertProvider(definition);
    const reused = await catalog.getCatalog();
    expect(reused.find(provider => provider.provider === 'acme')?.models)
      .toContainEqual(expect.objectContaining({ key: 'acme:model-a', source: 'discovered' }));
  });
  it('renames models and runtime identity without touching encrypted bytes, retaining API key and private headers', async () => {
    const { service, definition, proxy, secrets, requests, file } = await fixture();
    await service.upsertProvider({ ...definition, apiKey: 'test-private-key', headers: { 'X-Private': 'test-private-header' } });
    await service.upsertModel({ provider: 'acme', id: 'model-a' });
    const encryptedBefore = await readFile(secrets, 'utf8');
    const credentialId = JSON.parse(await readFile(file, 'utf8')).providers[0].credentialId;
    const renamed = await service.renameProvider('acme', 'renamed', service.getRevision(), commitOnly);
    expect(renamed).toMatchObject({ id: 'renamed', modelCount: 1, configured: true });
    expect(JSON.stringify(renamed)).not.toMatch(/test-private|credentialId/);
    expect(await readFile(secrets, 'utf8')).toBe(encryptedBefore);
    expect(service.getModels()[0]).toMatchObject({ key: 'renamed:model-a', provider: 'renamed' });
    expect(proxy.getAgentProvider('acme')).toBeUndefined();
    await service.testProvider('renamed');
    expect(requests.at(-1)).toMatchObject({ auth: 'Bearer test-private-key', private: 'test-private-header' });
    const restored = new ProviderRegistryService(file, new AiProxyServer(), secrets, key);
    await restored.load(); await restored.testProvider('renamed');
    expect(requests.at(-1)?.auth).toBe('Bearer test-private-key');
    // Reusing the public old ID must never adopt or delete the renamed identity's credentials.
    await service.upsertProvider({ ...definition, apiKey: 'new-provider-key' });
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.providers.find((provider: { id: string }) => provider.id === 'acme').credentialId).not.toBe(credentialId);
    await service.deleteProvider('acme');
    await service.testProvider('renamed');
    expect(requests.at(-1)?.auth).toBe('Bearer test-private-key');
  });
  it('refuses collisions, stale revisions and unknown fields before any credential or reference mutation', async () => {
    const { service, definition, secrets, file } = await fixture();
    await service.upsertProvider({ ...definition, apiKey: 'first-key' });
    const revision = service.getRevision();
    await service.upsertProvider({ ...definition, id: 'other', apiKey: 'second-key' });
    const encrypted = await readFile(secrets, 'utf8');
    const metadata = await readFile(file, 'utf8');
    let called = false;
    const rebind = async (commit: () => Promise<void>) => { called = true; await commit(); };
    await expect(service.renameProvider('acme', 'other', service.getRevision(), rebind)).rejects.toMatchObject({ code: 'PROVIDER_EXISTS' });
    await expect(service.renameProvider('acme', 'fresh', revision, rebind)).rejects.toMatchObject({ code: 'PROVIDER_REGISTRY_STALE' });
    await expect(service.renameProvider('acme', 'openai', service.getRevision(), rebind)).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({ ...definition, id: 'other', apiKey: 'attack-key' })).rejects.toMatchObject({ code: 'PROVIDER_EXISTS' });
    await expect(service.upsertProvider({ ...definition, id: 'fresh', credentialId: 'other' })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({ id: 'renamed' }, 'acme')).rejects.toMatchObject({ code: 'PROVIDER_RENAME_REQUIRED' });
    expect(called).toBe(false);
    expect(await readFile(secrets, 'utf8')).toBe(encrypted);
    expect(await readFile(file, 'utf8')).toBe(metadata);
  });
  it('rolls metadata back on host failures before and after commit without secret changes', async () => {
    const { service, definition, file, secrets } = await fixture();
    await service.upsertProvider({ ...definition, apiKey: 'private-key' });
    const before = await readFile(file, 'utf8');
    const encrypted = await readFile(secrets, 'utf8');
    await expect(service.renameProvider('acme', 'fresh', service.getRevision(), async () => { throw new Error('reference refusal'); })).rejects.toThrow('reference refusal');
    await expect(service.renameProvider('acme', 'fresh', service.getRevision(), async commit => { await commit(); throw new Error('reference failure'); })).rejects.toThrow('reference failure');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readFile(secrets, 'utf8')).toBe(encrypted);
    expect(service.listProviders()[0]?.id).toBe('acme');
  });
  it('reports uncertain rollback without overwriting external metadata or moving private credentials, then reconciles', async () => {
    const { service, definition, file, secrets, requests } = await fixture();
    await service.upsertProvider({ ...definition, apiKey: 'private-key' });
    const encrypted = await readFile(secrets, 'utf8');
    let external = '';
    await expect(service.renameProvider('acme', 'fresh', service.getRevision(), async commit => {
      await commit();
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.providers[0].name = 'External update';
      external = JSON.stringify(metadata);
      await writeFile(file, external);
      throw new Error('host commit failure');
    })).rejects.toMatchObject({ code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true });
    expect(await readFile(file, 'utf8')).toBe(external);
    expect(await readFile(secrets, 'utf8')).toBe(encrypted);
    await service.reload();
    expect(service.listProviders()[0]).toMatchObject({ id: 'fresh', name: 'External update' });
    await service.testProvider('fresh');
    expect(requests.at(-1)?.auth).toBe('Bearer private-key');
  });
  it('refuses a same-byte registry replacement before rename without calling the reference transaction', async () => {
    const { service, definition, file } = await fixture();
    await service.upsertProvider(definition);
    const bytes = await readFile(file, 'utf8');
    await writeFile(`${file}.external`, bytes); await rename(`${file}.external`, file);
    const external = await lstat(file);
    let called = false;
    await expect(service.renameProvider('acme', 'fresh', service.getRevision(), async commit => {
      called = true; await commit();
    })).rejects.toMatchObject({ code: 'PROVIDER_REGISTRY_STALE' });
    expect(called).toBe(false); expect((await lstat(file)).ino).toBe(external.ino);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it.each(['replacement', 'in-place ABA'])('refuses registry rollback over %s with identical published bytes', async variant => {
    const { service, definition, file, secrets } = await fixture();
    await service.upsertProvider({ ...definition, apiKey: 'private-key' });
    const encrypted = await readFile(secrets, 'utf8');
    let externalBytes = ''; let externalIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
    await expect(service.renameProvider('acme', 'fresh', service.getRevision(), async commit => {
      await commit(); externalBytes = await readFile(file, 'utf8');
      if (variant === 'replacement') {
        await writeFile(`${file}.external`, externalBytes); await rename(`${file}.external`, file);
      } else {
        await writeFile(file, `${externalBytes} `); await writeFile(file, externalBytes);
      }
      externalIdentity = await lstat(file);
      throw new Error('host failure after external publication');
    })).rejects.toMatchObject({ code: 'PROVIDER_RENAME_UNCERTAIN', uncertain: true });
    const after = await lstat(file);
    expect(after.ino).toBe(externalIdentity!.ino); expect(after.ctimeMs).toBe(externalIdentity!.ctimeMs);
    expect(await readFile(file, 'utf8')).toBe(externalBytes); expect(await readFile(secrets, 'utf8')).toBe(encrypted);
    await service.reload(); expect(service.listProviders()[0]?.id).toBe('fresh');
  });
  it('refuses stale discovery imports when a based-path HTTP source changes while discovery is in flight', async () => {
    const { service, definition, file } = await fixture();
    let released = false;
    const pending: Array<() => void> = [];
    const release = () => { released = true; for (const respond of pending.splice(0)) respond(); };
    let seen: () => void = () => undefined;
    const requested = new Promise<void>(resolve => { seen = resolve; });
    const server = createServer((_request, response) => {
      const respond = () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'stale-model' }] })); };
      if (released) respond(); else pending.push(respond);
      seen();
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await service.upsertProvider({ ...definition, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/source/v1` });
    const importing = service.importProviderModels('acme');
    await requested;
    const updating = service.upsertProvider({ baseUrl: definition.baseUrl }, 'acme');
    // Replacement aborts this runtime's old request. Discovery may retry at
    // that old source, so release every subsequent fixture request too.
    await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).providers[0].baseUrl,
      { timeout: 1_000 }).toBe(definition.baseUrl);
    const refusal = expect(importing).rejects.toMatchObject({ code: 'PROVIDER_REGISTRY_STALE' });
    release();
    await updating;
    await refusal;
    expect(service.getModels()).toEqual([]);
  });
  it('keeps an explicitly disconnected endpoint disabled after reconciliation and restart', async () => {
    const { service, definition, proxy, file, secrets } = await fixture();
    await service.upsertProvider(definition);
    await service.disconnect('acme');
    await service.reload();
    expect(proxy.isConfigured('acme')).toBe(false);
    const restoredProxy = new AiProxyServer();
    const restored = new ProviderRegistryService(file, restoredProxy, secrets, key);
    await restored.load();
    expect(restoredProxy.isConfigured('acme')).toBe(false);
    await restored.upsertProvider({ name: 'Reconnect' }, 'acme');
    expect(restoredProxy.isConfigured('acme')).toBe(true);
  });
  it('refuses external stale metadata and never overwrites external edits or another service credentials', async () => {
    const { service, definition, file, secrets } = await fixture();
    await service.upsertProvider({ ...definition, apiKey: 'original-key' });
    const second = new ProviderRegistryService(file, new AiProxyServer(), secrets, key);
    await second.load();
    await service.upsertProvider({ name: 'Updated', apiKey: 'updated-key' }, 'acme');
    const encrypted = await readFile(secrets, 'utf8');
    await expect(second.upsertProvider({ apiKey: 'stale-key' }, 'acme')).rejects.toMatchObject({ code: 'PROVIDER_REGISTRY_STALE' });
    expect(await readFile(secrets, 'utf8')).toBe(encrypted);
    const external = `${await readFile(file, 'utf8')} `;
    await writeFile(file, external);
    await expect(service.renameProvider('acme', 'fresh', service.getRevision(), commitOnly)).rejects.toMatchObject({ code: 'PROVIDER_REGISTRY_STALE' });
    expect(await readFile(file, 'utf8')).toBe(external);
  });
});
