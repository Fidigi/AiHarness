import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProxyServer } from '../api/proxy.js';
import { ModelCatalogService } from './model-catalog.js';

describe('ModelCatalogService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('groups published models and augments a configured provider with live discovery', async () => {
    vi.stubEnv('LOCAL_BASE_URL', 'http://models.test/v1');
    vi.stubEnv('LOCAL_MODEL', 'configured-local');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'qwen-tool' }, { id: 'vision-reasoning' }, { id: 'qwen-tool' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const catalog = new ModelCatalogService(new AiProxyServer());

    const providers = await catalog.getCatalog(true);
    const local = providers.find(provider => provider.provider === 'local');

    expect(local).toMatchObject({ configured: true });
    expect(local?.models.map(model => model.id)).toEqual(expect.arrayContaining([
      'local-model', 'configured-local', 'qwen-tool', 'vision-reasoning',
    ]));
    expect(local?.models.find(model => model.id === 'qwen-tool')).toMatchObject({
      source: 'discovered', available: true,
      capabilities: { toolCalls: true },
    });
    expect(catalog.getUpdatedAt()).not.toBe(new Date(0).toISOString());

    fetchMock.mockRejectedValueOnce(new Error('local server offline'));
    const cachedAfterFailure = await catalog.getCatalog(true);
    expect(cachedAfterFailure.find(provider => provider.provider === 'local')?.models)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'qwen-tool', source: 'discovered' })]));
  });

  it('marks published models unavailable when their provider is not configured', async () => {
    const catalog = new ModelCatalogService(new AiProxyServer());
    const providers = await catalog.getCatalog();

    const openai = providers.find(provider => provider.provider === 'openai');
    expect(openai).toMatchObject({ configured: false });
    expect(openai?.models.find(model => model.id === 'gpt-4o')).toMatchObject({
      available: false, source: 'published',
    });
  });
});
