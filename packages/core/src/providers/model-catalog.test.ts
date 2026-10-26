import { describe, expect, it, vi } from 'vitest';
import { MockProvider, MistralProvider, OpenAiProvider, OpenAiMixedProvider, OpenRouterProvider, CloudflareWorkersAiMixedProvider, OpenAiResponsesProvider, AzureResponsesProvider,
  AnthropicProvider, GeminiProvider, VertexGeminiProvider, BedrockProvider, type AiProvider } from './index.js';
import {
  buildProviderModelCatalog,
  createProtocolModelDescriptor,
  collectProviderModelCatalog,
  toProtocolModelDescriptor,
  discoverProviderModelIds,
  filterModels,
  flattenModelCatalog,
  resolveModelReference,
  resolveModelScope,
} from './model-catalog.js';
import type { ModelIdentity } from './model-catalog.js';
import type { PublishedModelMetadata } from './model-metadata.js';

const models: ModelIdentity[] = [
  { provider: 'openai', id: 'shared', name: 'Shared OpenAI', available: false },
  { provider: 'anthropic', id: 'shared', name: 'Shared Anthropic', available: true },
  { provider: 'anthropic', id: 'claude-sonnet-4-20250101', name: 'Claude dated', available: true },
  { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude alias', available: true },
  { provider: 'openrouter', id: 'openai/gpt-4o:exacto', name: 'Routed GPT', available: true },
  { provider: 'bedrock', id: 'anthropic.claude-v1:0', name: 'Bedrock Claude', available: true },
];

describe('shared model catalogue and resolution', () => {
  it('publishes native R metadata offline without borrowing the operator alias catalogue or adding D conversations', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    try {
      const provider = new OpenAiMixedProvider({ type: 'mistral', apiKey: 'fixture-private', model: 'gpt-6-luna' });
      const collect = () => collectProviderModelCatalog(new Map([['mistral', provider]]), { discover: false });
      const entries = flattenModelCatalog(await collect());
      expect(entries).toHaveLength(44); expect(new Set(entries.map(model => model.id)).size).toBe(44);
      expect(entries.every(model => model.api === 'openai-responses' && model.source === 'published')).toBe(true);
      expect(entries.find(model => model.id === 'gpt-6-luna')).toMatchObject({ name: 'GPT-6 Luna', contextWindow: 272000, maxOutputTokens: 128000,
        capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 } });
      expect(entries.find(model => model.id === 'o3-mini')?.capabilities.imageInput).toBe(false);
      expect(entries.filter(model => model.capabilities.imageInput)).toHaveLength(42); expect(entries.filter(model => model.capabilities.reasoning)).toHaveLength(32);
      entries[0]!.name = 'mutated'; entries[0]!.capabilities.imageInput = !entries[0]!.capabilities.imageInput;
      expect(flattenModelCatalog(await collect())[0]).not.toMatchObject({ name: 'mutated' });
      const legacy = flattenModelCatalog(await collectProviderModelCatalog(new Map([['operator-openai', new OpenAiProvider({ type: 'operator-openai', apiKey: 'fixture-private', model: 'gpt-6-luna' })]]), { discover: false }));
      expect(legacy).toHaveLength(1); expect(legacy[0]).toMatchObject({ name: 'gpt-6-luna', api: 'openai-completions' }); expect(legacy[0]?.contextWindow).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(entries)).not.toContain('fixture-private');
    } finally { fetch.mockRestore(); }
  });
  it.each([
    { kind: 'OpenRouter', create: () => new OpenRouterProvider({ type: 'mistral', apiKey: 'fixture-private' }), count: 393, images: 273, reasoning: 314,
      id: 'anthropic/claude-sonnet-4.6', name: 'Anthropic: Claude Sonnet 4.6', api: 'anthropic-messages', contextWindow: 1000000, maxOutputTokens: 128000,
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }, specialized: 83 },
    { kind: 'Cloudflare', create: () => new CloudflareWorkersAiMixedProvider({ type: 'mistral', apiKey: 'fixture-private', accountId: 'explicit' }), count: 18, images: 7, reasoning: 14,
      id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', api: 'openai-completions', contextWindow: 256000, maxOutputTokens: 16384,
      pricing: { inputPerMillion: 0.1, outputPerMillion: 0.3, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0 }, specialized: 4 },
  ])('publishes $kind conversation profiles offline without foreign alias or specialized-model expansion', async scenario => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    try {
      const provider = scenario.create(), collect = () => collectProviderModelCatalog(new Map<string, AiProvider>([['mistral', provider]]), { discover: false });
      const models = flattenModelCatalog(await collect());
      expect(models).toHaveLength(scenario.count); expect(new Set(models.map(model => model.id)).size).toBe(scenario.count);
      expect(models.every(model => model.source === 'published' && model.api === provider.getModelApi(model.id))).toBe(true);
      expect(models.filter(model => model.capabilities.imageInput)).toHaveLength(scenario.images); expect(models.filter(model => model.capabilities.reasoning)).toHaveLength(scenario.reasoning);
      expect(models.find(model => model.id === scenario.id)).toMatchObject({ id: scenario.id, name: scenario.name, api: scenario.api,
        contextWindow: scenario.contextWindow, maxOutputTokens: scenario.maxOutputTokens, capabilities: { reasoning: true, imageInput: true, toolCalls: true } });
      expect(models.find(model => model.id === scenario.id)?.pricing).toEqual(scenario.pricing);
      expect(models.every(model => !model.pricing || !('tiers' in model.pricing))).toBe(true);
      if (scenario.kind === 'OpenRouter') {
        expect(models.filter(model => model.pricing === undefined)).toHaveLength(21);
        expect(models.find(model => model.id === 'openrouter/auto')?.pricing).toBeUndefined();
        expect(models.find(model => model.id === 'google/gemini-3-pro-image')?.api).toBe('openai-completions');
      }
      models[0]!.name = 'mutated'; models[0]!.capabilities.imageInput = !models[0]!.capabilities.imageInput;
      expect(flattenModelCatalog(await collect())[0]?.name).not.toBe('mutated');
      expect(provider.getSpecializedModels()).toHaveLength(scenario.specialized);
      expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(models)).not.toContain('fixture-private');
    } finally { fetch.mockRestore(); }
  });

  it('owns bounded static declarations, skips getters and refuses metadata from a different physical API', () => {
    let getterCalls = 0;
    const profile = { id: 'gpt-6-luna', name: 'Luna', api: 'openai-responses', contextWindow: 272000, maxOutputTokens: 128000,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.1 }, apiKey: 'private-catalogue-value' };
    const accessor = Object.defineProperty({}, 'id', { get() { getterCalls++; throw new Error('private-catalogue-value'); } });
    Object.defineProperty(profile, 'endpoint', { get() { getterCalls++; throw new Error('private-catalogue-value'); } });
    const declared = [ { ...profile, api: 'openai-decisions', contextWindow: 922000 }, accessor, profile, { ...profile, name: 'duplicate' },
      Object.create(profile), { ...profile, id: 'partial', contextWindow: -1, maxOutputTokens: Infinity, pricing: { inputPerMillion: NaN, outputPerMillion: -1, cacheReadPerMillion: Infinity, cacheWritePerMillion: 0 } } ] as unknown as PublishedModelMetadata[];
    const catalog = flattenModelCatalog(buildProviderModelCatalog([{ provider: 'mistral', configured: true, publishedModels: declared, getModelApi: () => 'openai-responses' }]));
    expect(catalog).toHaveLength(2); expect(catalog.find(model => model.id === profile.id)).toMatchObject({ name: 'Luna', api: 'openai-responses', contextWindow: 272000 });
    expect(catalog.find(model => model.id === 'partial')?.pricing).toEqual({ cacheWritePerMillion: 0 });
    expect(catalog.find(model => model.id === 'partial')?.contextWindow).toBeUndefined(); expect(catalog.find(model => model.id === 'partial')?.maxOutputTokens).toBeUndefined();
    profile.capabilities.imageInput = false; profile.pricing.inputPerMillion = 999;
    expect(catalog.find(model => model.id === profile.id)).toMatchObject({ capabilities: { imageInput: true }, pricing: { inputPerMillion: 0.1 } });
    expect(JSON.stringify(catalog)).not.toContain('private-catalogue-value'); expect(getterCalls).toBe(0);
    const oversized = Array.from({ length: 501 }, (_, index) => ({ ...profile, id: `model-${index}` }));
    expect(flattenModelCatalog(buildProviderModelCatalog([{ provider: 'operator', configured: true, publishedModels: oversized }]))).toHaveLength(500);
  });

  it('merges published, configured, discovered, and custom metadata without secrets', () => {
    const catalog = buildProviderModelCatalog([
      {
        provider: 'openai',
        configured: true,
        configuredModel: 'configured-only',
        discoveredModels: ['gpt-4o', 'discovered-only', 'discovered-only', '\u0000unsafe'],
      },
    ], [{
      key: 'openai:custom-one',
      provider: 'openai',
      id: 'custom-one',
      name: 'Custom One',
      capabilities: { reasoning: true, imageInput: false, toolCalls: true },
      contextWindow: 42_000,
      compatibility: { strictTools: true },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }]);

    expect(catalog).toHaveLength(1);
    const entries = flattenModelCatalog(catalog);
    expect(entries.find(model => model.id === 'gpt-4o')).toMatchObject({ source: 'discovered', available: true });
    expect(entries.find(model => model.id === 'configured-only')).toMatchObject({ source: 'configured' });
    expect(entries.filter(model => model.id === 'discovered-only')).toHaveLength(1);
    expect(entries.find(model => model.id === 'custom-one')).toMatchObject({
      source: 'custom', contextWindow: 42_000, compatibility: { strictTools: true },
    });
    expect(JSON.stringify(catalog)).not.toContain('apiKey');
  });

  it('binds model APIs to the actual dialect instead of the operator-selected provider ID', async () => {
    const catalog = await collectProviderModelCatalog(new Map<string, AiProvider>([
      ['operator-mistral', new MistralProvider({ type: 'operator-mistral', apiKey: 'fixture', model: 'magistral-medium-latest' })],
      ['mistral', new OpenAiProvider({ type: 'mistral', apiKey: 'fixture', model: 'legacy-compatible' })],
      ['operator-responses', new OpenAiResponsesProvider({ type: 'operator-responses', apiKey: 'fixture', model: 'model' })],
      ['operator-azure', new AzureResponsesProvider({ type: 'azure', apiKey: 'fixture', baseUrl: 'https://azure.example', model: 'model' })],
      ['operator-anthropic', new AnthropicProvider({ type: 'anthropic', apiKey: 'fixture', model: 'model' })],
      ['operator-google', new GeminiProvider({ type: 'google', apiKey: 'fixture', model: 'model' })],
      ['operator-vertex', new VertexGeminiProvider({ type: 'vertex', apiKey: 'fixture', project: 'project', model: 'model' })],
      ['operator-bedrock', new BedrockProvider({ type: 'bedrock', accessKeyId: 'fixture', secretAccessKey: 'fixture', model: 'model' })],
    ]), { discover: false });
    const models = flattenModelCatalog(catalog);
    const native = models.find(model => model.provider === 'operator-mistral')!;
    expect(native).toMatchObject({ api: 'mistral-conversations' });
    expect(toProtocolModelDescriptor(native).api).toBe('mistral-conversations');
    expect(toProtocolModelDescriptor({ ...native, provider: 'anthropic' }).baseUrl).toBeUndefined();
    expect(createProtocolModelDescriptor('anthropic', 'legacy-model').baseUrl).toBe('https://api.anthropic.com');
    expect(models.filter(model => model.provider === 'mistral').every(model => model.api === 'openai-completions')).toBe(true);
    for (const [provider, api] of Object.entries({ 'operator-responses': 'openai-responses', 'operator-azure': 'azure-openai-responses',
      'operator-anthropic': 'anthropic-messages', 'operator-google': 'google-generative-ai', 'operator-vertex': 'google-vertex',
      'operator-bedrock': 'bedrock-converse-stream' })) {
      expect(models.find(model => model.provider === provider)?.api).toBe(api);
    }
    expect(JSON.stringify(catalog)).not.toContain('fixture');
    for (const getModelApi of [undefined, () => undefined, () => 'https://private.example/token', () => { throw new Error('private'); }]) {
      const legacy = flattenModelCatalog(buildProviderModelCatalog([{ provider: 'mistral', configured: true, getModelApi }]));
      expect(legacy.every(model => model.api === undefined)).toBe(true);
      expect(toProtocolModelDescriptor(legacy[0]!).api).toBe('openai-completions');
    }
    const unavailable = flattenModelCatalog(buildProviderModelCatalog([{ provider: 'mistral', configured: false }]));
    expect(unavailable.every(model => model.api === 'mistral-conversations')).toBe(true);
    expect(createProtocolModelDescriptor('mistral', 'magistral-medium-latest').api).toBe('openai-completions');
    expect(createProtocolModelDescriptor('mistral', 'magistral-medium-latest', 'mistral-conversations').api).toBe('mistral-conversations');
  });

  it('bounds and deduplicates live provider discovery', async () => {
    class DiscoveryProvider extends MockProvider {
      attempts = 0;
      override async getAvailableModels(): Promise<string[]> {
        this.attempts++;
        if (this.attempts === 1) throw new Error('temporary');
        return [' one ', 'one', 'two', 'three', '\u0000bad'];
      }
    }
    const provider = new DiscoveryProvider({ type: 'mock' as any });
    await expect(discoverProviderModelIds(provider, {
      retries: 1, retryDelayMs: 0, timeoutMs: 100, maxModels: 2,
    })).resolves.toEqual(['one', 'two']);
    expect(provider.attempts).toBe(2);
    const stalled = new DiscoveryProvider({ type: 'mock' as any });
    stalled.getAvailableModels = async () => new Promise<string[]>(() => {});
    await expect(discoverProviderModelIds(stalled, { retries: 0, timeoutMs: 5 }))
      .rejects.toThrow('Model discovery timed out.');
    await expect(discoverProviderModelIds(provider, { maxModels: 0 })).rejects.toThrow(/positive safe integer/i);
  });

  it('resolves provider-qualified, ambiguous, slash-bearing, and colon-bearing IDs safely', () => {
    expect(resolveModelReference('shared', models).model).toMatchObject({ provider: 'anthropic' });
    expect(resolveModelReference('openai/shared', models).model).toMatchObject({ provider: 'openai' });
    expect(resolveModelReference('openai/gpt-4o:exacto', models).model)
      .toMatchObject({ provider: 'openrouter', id: 'openai/gpt-4o:exacto' });
    expect(resolveModelReference('bedrock/anthropic.claude-v1:0', models).model)
      .toMatchObject({ provider: 'bedrock', id: 'anthropic.claude-v1:0' });

    const ambiguous = models.map(model => ({ ...model, available: undefined }));
    expect(resolveModelReference('shared', ambiguous)).toMatchObject({ code: 'ambiguous' });
  });

  it('prefers aliases for fuzzy lookup and parses a valid thinking suffix only after full-ID lookup', () => {
    expect(resolveModelReference('sonnet-4', models).model?.id).toBe('claude-sonnet-4');
    expect(resolveModelReference('sonnet-4:high', models)).toMatchObject({
      model: { id: 'claude-sonnet-4' }, thinkingLevel: 'high',
    });
    expect(resolveModelReference('openai/gpt-4o:exacto', models).thinkingLevel).toBeUndefined();
    expect(resolveModelReference('sonnet-4:not-a-level', models).model).toBeUndefined();
  });

  it('resolves ordered glob scopes with thinking levels, brackets, diagnostics, and deduplication', () => {
    const result = resolveModelScope([
      'anthropic/*sonnet*:high',
      'openai/shar[e]d',
      'anthropic/claude-sonnet-4',
      'missing*',
    ], models);
    expect(result.models.map(item => `${item.model.provider}/${item.model.id}`)).toEqual([
      'anthropic/claude-sonnet-4-20250101',
      'anthropic/claude-sonnet-4',
      'openai/shared',
    ]);
    expect(result.models[0]?.thinkingLevel).toBe('high');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'no-match', pattern: 'missing*' }),
    ]);
    expect(resolveModelScope(['openai/*'], models).models.map(item => `${item.model.provider}/${item.model.id}`))
      .toEqual(['openai/shared', 'openrouter/openai/gpt-4o:exacto']);
    expect(resolveModelScope(['[z-a]'], models).diagnostics).toEqual([
      expect.objectContaining({ code: 'no-match', pattern: '[z-a]' }),
    ]);
    expect(resolveModelScope(['x'.repeat(501)], models).diagnostics[0]?.message).toMatch(/exceeds 500/i);
  });

  it('filters list output deterministically and creates bounded protocol metadata', () => {
    expect(filterModels(models, 'anthropic sonnet').map(model => model.id)).toEqual([
      'claude-sonnet-4', 'claude-sonnet-4-20250101',
    ]);
    expect(filterModels(models, 'anth sn4').map(model => model.id)).toEqual([
      'claude-sonnet-4', 'claude-sonnet-4-20250101',
    ]);
    expect(createProtocolModelDescriptor('openai', 'gpt-4o')).toMatchObject({
      provider: 'openai', id: 'gpt-4o', api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1', input: ['text', 'image'], contextWindow: 128_000,
    });
    expect(createProtocolModelDescriptor('unknown', 'new-model')).not.toHaveProperty('cost');
  });
});
