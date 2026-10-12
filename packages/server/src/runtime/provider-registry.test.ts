import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore } from '@ai-harness/core';
import { AiProxyServer } from '../api/proxy.js';
import { ProviderRegistryService } from './provider-registry.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-registry-'));
  roots.push(root);
  const proxy = new AiProxyServer();
  const service = new ProviderRegistryService(
    path.join(root, 'providers.json'), proxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters',
  );
  await service.load();
  return { root, proxy, service };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('ProviderRegistryService', () => {
  it('persists only non-secret metadata and restores encrypted custom providers', async () => {
    const { root, proxy, service } = await fixture();
    const saved = await service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-completions',
      apiKey: 'super-secret-token', headers: { 'X-Private-Token': 'header-secret' },
    });

    expect(saved).toMatchObject({ id: 'acme', configured: true, headerNames: ['X-Private-Token'] });
    expect(proxy.isConfigured('acme')).toBe(true);
    const metadata = await readFile(path.join(root, 'providers.json'), 'utf8');
    expect(metadata).not.toContain('super-secret-token');
    expect(metadata).not.toContain('header-secret');
    expect(await readFile(path.join(root, 'secrets.enc'), 'utf8')).not.toContain('super-secret-token');

    const restoredProxy = new AiProxyServer();
    const restored = new ProviderRegistryService(
      path.join(root, 'providers.json'), restoredProxy, path.join(root, 'secrets.enc'), 'test-master-key-with-32-characters',
    );
    await restored.load();
    expect(restored.listProviders()).toEqual([expect.objectContaining({ id: 'acme', configured: true })]);
    expect(restoredProxy.isConfigured('acme')).toBe(true);
  });

  it('refuses volatile custom credentials when encrypted persistence is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-registry-volatile-'));
    roots.push(root);
    const service = new ProviderRegistryService(
      path.join(root, 'providers.json'),
      new AiProxyServer(),
      path.join(root, 'secrets.enc'),
      '',
    );
    await service.load();

    await expect(service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1',
      dialect: 'openai-completions', apiKey: 'must-not-be-volatile',
    })).rejects.toMatchObject({ status: 503, message: 'Credential storage is unavailable.' });
    expect(service.listProviders()).toEqual([]);
  });

  it('migrates the legacy combined secret payload to the shared credential namespace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-registry-legacy-'));
    roots.push(root);
    const metadataPath = path.join(root, 'providers.json');
    const secretsPath = path.join(root, 'secrets.enc');
    const key = 'test-master-key-with-32-characters';
    await writeFile(metadataPath, JSON.stringify({
      version: 1,
      providers: [{
        id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-responses',
        headerNames: ['X-Private'], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }],
      models: [],
    }));
    const legacy = new EncryptedCredentialStore(secretsPath, key);
    await legacy.load();
    await legacy.set('provider:acme', JSON.stringify({
      apiKey: 'legacy-api-secret', headers: { 'X-Private': 'legacy-header-secret' },
    }));
    const proxy = new AiProxyServer();
    const service = new ProviderRegistryService(metadataPath, proxy, secretsPath, key);

    await service.load();

    expect(service.listProviders()).toEqual([expect.objectContaining({ id: 'acme', configured: true })]);
    expect(proxy.isConfigured('acme')).toBe(true);
    expect(proxy.redactText('legacy-api-secret legacy-header-secret')).toBe('[REDACTED] [REDACTED]');
    const migrated = new EncryptedCredentialStore(secretsPath, key);
    await migrated.load();
    expect(JSON.parse(migrated.get('provider:acme')!)).toMatchObject({
      version: 1, type: 'api-key', apiKey: 'legacy-api-secret',
    });
    expect(JSON.parse(migrated.get('provider-headers:acme')!)).toEqual({ 'X-Private': 'legacy-header-secret' });
  });

  it('restores provider credentials when metadata deletion cannot be persisted', async () => {
    const { root, service } = await fixture();
    const key = 'test-master-key-with-32-characters';
    await service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-completions',
      apiKey: 'rollback-api-secret', headers: { 'X-Private': 'rollback-header-secret' },
    });
    const metadataPath = path.join(root, 'providers.json');
    await rm(metadataPath);
    await mkdir(metadataPath);

    await expect(service.deleteProvider('acme')).rejects.toThrow();

    expect(service.listProviders()).toEqual([expect.objectContaining({ id: 'acme', configured: true })]);
    const stored = new EncryptedCredentialStore(path.join(root, 'secrets.enc'), key);
    await stored.load();
    expect(JSON.parse(stored.get('provider:acme')!)).toMatchObject({ apiKey: 'rollback-api-secret' });
    expect(JSON.parse(stored.get('provider-headers:acme')!)).toEqual({ 'X-Private': 'rollback-header-secret' });
  });

  it('validates provider input, discovers models, and cascades provider deletion', async () => {
    const { service } = await fixture();
    await expect(service.upsertProvider({
      id: 'openai', name: 'Reserved', baseUrl: 'https://example.test', dialect: 'openai-completions',
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({
      id: 'bad-provider', name: 'Bad', baseUrl: 'https://user:pass@example.test', dialect: 'openai-completions',
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({
      id: 'bad-provider', name: 'Bad', baseUrl: 'https://example.test', dialect: 'openai-completions',
      headers: { Host: 'internal' },
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.upsertProvider({
      id: 'bad-provider', name: 'Bad', baseUrl: 'https://example.test', dialect: 'openai-completions',
      headers: { Authorization: 'Bearer untrusted' },
    })).rejects.toMatchObject({ status: 400 });

    await service.upsertProvider({
      id: 'acme', name: 'Acme', baseUrl: 'https://models.example/v1', dialect: 'openai-completions', apiKey: 'token',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-a' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const imported = await service.importProviderModels('acme');
    expect(imported.map(model => model.id)).toEqual(['model-a', 'model-b']);
    expect(service.getModels()).toHaveLength(2);
    expect(await service.deleteProvider('acme')).toBe(true);
    expect(service.getModels()).toEqual([]);
  });

  it('auto-fills versioned published metadata and preserves full custom pricing', async () => {
    const { service } = await fixture();
    const model = await service.upsertModel({
      provider: 'openai', id: 'gpt-4o',
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, cacheWritePerMillion: 3 },
      compatibility: { supportsDeveloperRole: true, maxParallelCalls: 8 },
    });
    expect(model).toMatchObject({
      name: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384,
      capabilities: { reasoning: false, imageInput: true, toolCalls: true },
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25, cacheWritePerMillion: 3 },
      compatibility: { supportsDeveloperRole: true, maxParallelCalls: 8 },
    });
  });
});
