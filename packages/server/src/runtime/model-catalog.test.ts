import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiMixedProvider, OpenAiProvider, OpenRouterProvider, CloudflareWorkersAiMixedProvider, type CustomModelDefinition } from '@ai-harness/core';
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

  it('uses current adapter-owned R metadata for catalogue and runtime lookups while preserving custom overrides', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected network request')); vi.stubGlobal('fetch', fetch);
    const proxy = new AiProxyServer();
    proxy.setCustomProvider('mistral', new OpenAiMixedProvider({ type: 'mistral', apiKey: 'private-profile-token', model: 'gpt-6-luna' }));
    const overrides: CustomModelDefinition[] = [];
    const catalog = new ModelCatalogService(proxy, () => overrides);
    const models = (await catalog.getCatalog()).find(provider => provider.provider === 'mistral')!.models;
    expect(models).toHaveLength(44); expect(models.every(model => model.api === 'openai-responses')).toBe(true);
    expect(models.find(model => model.id === 'gpt-6-luna')).toMatchObject({ name: 'GPT-6 Luna', contextWindow: 272000, maxOutputTokens: 128000 });
    expect(catalog.getCapabilities('mistral', 'gpt-6-luna')).toEqual({ reasoning: true, imageInput: true, toolCalls: true });
    expect(catalog.getPricing('mistral', 'gpt-6-luna')).toEqual({ inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 });
    overrides.push({ key: 'mistral:gpt-6-luna', provider: 'mistral', id: 'gpt-6-luna', name: 'Operator Luna', contextWindow: 777,
      capabilities: { reasoning: false, imageInput: false, toolCalls: false }, pricing: { inputPerMillion: 999 }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    expect((await catalog.getCatalog()).find(provider => provider.provider === 'mistral')?.models.find(model => model.id === 'gpt-6-luna')).toMatchObject({ name: 'Operator Luna', contextWindow: 777, pricing: { inputPerMillion: 999 } });
    expect(catalog.getCapabilities('mistral', 'gpt-6-luna')).toEqual(overrides[0]!.capabilities); expect(catalog.getPricing('mistral', 'gpt-6-luna')).toEqual({ inputPerMillion: 999 });
    overrides.length = 0;
    proxy.setCustomProvider('mistral', new OpenAiProvider({ type: 'mistral', apiKey: 'private-profile-token', model: 'gpt-6-luna' }));
    expect(catalog.getCapabilities('mistral', 'gpt-6-luna')).toEqual({ reasoning: false, imageInput: false, toolCalls: true });
    expect(catalog.getPricing('mistral', 'gpt-6-luna')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(models)).not.toContain('private-profile-token');
  });

  it.each([
    { kind: 'OpenRouter', create: () => new OpenRouterProvider({ type: 'mistral', apiKey: 'private-profile-token' }), count: 393,
      id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6', api: 'anthropic-messages', contextWindow: 1000000, maxOutputTokens: 128000,
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 } },
    { kind: 'Cloudflare', create: () => new CloudflareWorkersAiMixedProvider({ type: 'mistral', apiKey: 'private-profile-token', accountId: 'explicit' }), count: 18,
      id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', api: 'openai-completions', contextWindow: 256000, maxOutputTokens: 16384,
      pricing: { inputPerMillion: 0.1, outputPerMillion: 0.3, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0 } },
  ])('uses current $kind profile fields for static catalogue/runtime lookups with operator overrides first', async scenario => {
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected network request')); vi.stubGlobal('fetch', fetch);
    const proxy = new AiProxyServer(); proxy.setCustomProvider('mistral', scenario.create());
    const overrides: CustomModelDefinition[] = [], catalog = new ModelCatalogService(proxy, () => overrides);
    const models = (await catalog.getCatalog()).find(provider => provider.provider === 'mistral')!.models;
    expect(models).toHaveLength(scenario.count); expect(models.find(model => model.id === scenario.id)).toMatchObject({ name: scenario.name, api: scenario.api,
      contextWindow: scenario.contextWindow, maxOutputTokens: scenario.maxOutputTokens });
    expect(catalog.getCapabilities('mistral', scenario.id)).toEqual({ reasoning: true, imageInput: true, toolCalls: true }); expect(catalog.getPricing('mistral', scenario.id)).toEqual(scenario.pricing);
    if (scenario.kind === 'OpenRouter') expect(catalog.getPricing('mistral', 'openrouter/auto')).toBeUndefined();
    overrides.push({ key: `mistral:${scenario.id}`, provider: 'mistral', id: scenario.id, name: 'Operator profile', contextWindow: 777,
      capabilities: { reasoning: false, imageInput: false, toolCalls: false }, pricing: { inputPerMillion: 999 }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    expect((await catalog.getCatalog()).find(provider => provider.provider === 'mistral')?.models.find(model => model.id === scenario.id)).toMatchObject({ name: 'Operator profile', contextWindow: 777 });
    expect(catalog.getCapabilities('mistral', scenario.id)).toEqual(overrides[0]!.capabilities); expect(catalog.getPricing('mistral', scenario.id)).toEqual({ inputPerMillion: 999 });
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(models)).not.toContain('private-profile-token');
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
