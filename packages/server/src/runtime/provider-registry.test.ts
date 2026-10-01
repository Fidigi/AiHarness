import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
