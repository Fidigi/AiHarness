import { describe, expect, it } from 'vitest';
import { MockProvider } from './index.js';
import {
  buildProviderModelCatalog,
  createProtocolModelDescriptor,
  discoverProviderModelIds,
  filterModels,
  flattenModelCatalog,
  resolveModelReference,
  resolveModelScope,
} from './model-catalog.js';
import type { ModelIdentity } from './model-catalog.js';

const models: ModelIdentity[] = [
  { provider: 'openai', id: 'shared', name: 'Shared OpenAI', available: false },
  { provider: 'anthropic', id: 'shared', name: 'Shared Anthropic', available: true },
  { provider: 'anthropic', id: 'claude-sonnet-4-20250101', name: 'Claude dated', available: true },
  { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude alias', available: true },
  { provider: 'openrouter', id: 'openai/gpt-4o:exacto', name: 'Routed GPT', available: true },
  { provider: 'bedrock', id: 'anthropic.claude-v1:0', name: 'Bedrock Claude', available: true },
];

describe('shared model catalogue and resolution', () => {
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
