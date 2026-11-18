import { describe, expect, it, vi } from 'vitest';
import {
  calculatePublishedModelCost,
  clampPublishedThinkingLevel,
  getPublishedModelMetadata,
  getPublishedModels,
  getSupportedThinkingLevels,
  inferModelCapabilities,
} from './model-metadata.js';

import { CerebrasProvider, MistralProvider, OpenAiMixedProvider, OpenRouterProvider, CloudflareWorkersAiMixedProvider } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';

describe('shared model metadata', () => {
  it('projects one original-owner row, not a full catalogue, without borrowing the optimization for derived owners', () => {
    class Derived extends OpenRouterProvider {}
    const counts: number[] = [];
    for (const Provider of [OpenRouterProvider, Derived]) {
      const source = new Provider({ type: 'operator', apiKey: 'synthetic-metadata' });
      const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
      let row: ReturnType<typeof getProviderPublishedModel>;
      try {
        row = getProviderPublishedModel('operator', 'anthropic/claude-sonnet-4.6', source);
        counts.push(descriptor.mock.calls.length);
      } finally { descriptor.mockRestore(); }
      expect(row?.id).toBe('anthropic/claude-sonnet-4.6');
      row!.capabilities.reasoning = false;
      expect(getProviderPublishedModel('operator', row!.id, source)?.capabilities.reasoning).toBe(true);
    }
    expect(counts[0]).toBeLessThan(100);
    expect(counts[1]).toBeGreaterThan(500);
  });

  it('revalidates replacement, withdrawal and API binding rather than caching a native-owner snapshot', async () => {
    const source = new OpenRouterProvider({ type: 'operator', apiKey: 'synthetic-metadata' });
    const id = 'anthropic/claude-sonnet-4.6', original = source.getPublishedModels;
    const row = getProviderPublishedModel('operator', id, source)!;
    source.getPublishedModels = () => [row];
    row.contextWindow = 1234;
    expect(getProviderPublishedModel('operator', id, source)?.contextWindow).toBe(1234);
    await Promise.resolve();
    source.getPublishedModels = () => [];
    expect(getProviderPublishedModel('openai', id, source)).toBeUndefined();
    expect(getSupportedThinkingLevels('openai', id, undefined, source)).toEqual(['off']);
    let getters = 0;
    Object.defineProperty(source, 'getPublishedModels', { configurable: true, get() { getters++; return () => []; } });
    expect(getProviderPublishedModel('operator', id, source)).toBeUndefined();
    expect(getters).toBe(1);
    Object.defineProperty(source, 'getPublishedModels', { configurable: true, writable: true, value: original });
    expect(getProviderPublishedModel('operator', id, source)?.contextWindow).not.toBe(1234);
    source.getModelApi = () => 'openai-completions';
    expect(getProviderPublishedModel('operator', id, source)).toBeUndefined();
    const changed = new OpenRouterProvider({ type: 'operator', apiKey: 'synthetic-metadata' });
    Object.setPrototypeOf(changed, new Proxy(Object.getPrototypeOf(changed), {
      get(target, key, receiver) {
        return key === 'getPublishedModels' ? () => [] : Reflect.get(target, key, receiver);
      },
    }));
    expect(changed.getPublishedModels()).toEqual([]);
    expect(getProviderPublishedModel('operator', id, changed)).toBeUndefined();
    expect(getSupportedThinkingLevels('operator', id, undefined, changed)).toEqual(['off']);
  });

  it('keeps mutable adapter arrays fresh across calls and awaits, including duplicate and withdrawn rows', async () => {
    const row = { id: 'owned', name: 'Owned', capabilities: { reasoning: true, imageInput: false, toolCalls: true } };
    const rows = [row], source = { getPublishedModels: () => rows };
    expect(getProviderPublishedModel('openai', 'owned', source)?.capabilities.reasoning).toBe(true);
    row.capabilities.reasoning = false;
    expect(getSupportedThinkingLevels('openai', 'owned', undefined, source)).toEqual(['off']);
    await Promise.resolve(); rows.length = 0;
    expect(getProviderPublishedModel('openai', 'o3', source)).toBeUndefined();
    expect(getSupportedThinkingLevels('openai', 'o3', undefined, source)).toEqual(['off']);
    rows.push({ ...row, name: '' }, row);
    expect(getProviderPublishedModel('openai', 'owned', source)?.name).toBe('Owned');
  });

  it('uses the actual native effort map across operator and conflicting aliases', () => {
    for (const alias of ['operator-window', 'mistral', 'anthropic', 'openai']) {
      const scenarios = [
        { provider: new MistralProvider({ type: alias, apiKey: 'private-fixture', model: 'magistral-medium-latest' }), id: 'magistral-medium-latest', expected: ['off', 'high'] },
        { provider: new CerebrasProvider({ type: alias, apiKey: 'private-fixture', model: 'qwen-3.8-27b' }), id: 'qwen-3.8-27b', expected: ['off', 'low', 'medium', 'high'] },
        { provider: new OpenAiMixedProvider({ type: alias, apiKey: 'private-fixture', model: 'gpt-6-luna' }), id: 'gpt-6-luna', expected: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { provider: new OpenRouterProvider({ type: alias, apiKey: 'private-fixture', model: 'anthropic/claude-sonnet-4.6' }), id: 'anthropic/claude-sonnet-4.6', expected: ['off', 'low', 'medium', 'high', 'max'] },
        { provider: new CloudflareWorkersAiMixedProvider({ type: alias, apiKey: 'private-fixture', accountId: 'explicit' }), id: '@cf/google/gemma-4-26b-a4b-it', expected: ['off', 'high'] },
      ];
      for (const { provider, id, expected } of scenarios) {
        expect(getSupportedThinkingLevels(alias, id, undefined, provider)).toEqual(expected);
        const owned = getProviderPublishedModel(alias, id, provider)!;
        expect(owned.thinkingLevelMap?.high).toBe('high');
        owned.thinkingLevelMap!.high = null;
        expect(getSupportedThinkingLevels(alias, id, undefined, provider)).toEqual(expected);
        expect(getSupportedThinkingLevels('anthropic', 'claude-sonnet-4-6', undefined, provider)).toEqual(['off']);
      }
    }
  });

  it('preserves undeclared legacy and virtual authority, but cannot borrow through empty or failing declarations', () => {
    expect(getSupportedThinkingLevels('openai', 'o3', undefined, {})).toEqual(['low', 'medium', 'high']);
    for (const source of [{ getPublishedModels: () => [] }, { getPublishedModels: () => { throw Error('private-fixture'); } }, { getPublishedModels: () => ({ secret: 'private-fixture' }) as never }]) {
      expect(getSupportedThinkingLevels('openai', 'o3', undefined, source)).toEqual(['off']);
      expect(getSupportedThinkingLevels('openai', 'o3', { get: () => ({ thinkingLevels: ['max'] as const }) }, source)).toEqual(['max']);
    }
    const source = { getPublishedModels: () => [{ id: 'o3', name: 'No thinking', thinkingLevelMap: null, capabilities: { reasoning: true, imageInput: false, toolCalls: true } }] };
    expect(getSupportedThinkingLevels('openai', 'o3', undefined, source)).toEqual(['off']);
  });

  it('copies only bounded own thinking-map data without invoking map or row accessors', () => {
    let getters = 0;
    const map = Object.assign(Object.create({ xhigh: 'max' }), { off: null, minimal: null, low: null, medium: null, high: 'high', max: 'max', secret: 'private-fixture' });
    const row = { id: 'owned', name: 'Owned', capabilities: { reasoning: true, imageInput: false, toolCalls: true }, thinkingLevelMap: map };
    const source = { getPublishedModels: () => [row] };
    expect(getSupportedThinkingLevels('openai', 'owned', undefined, source)).toEqual(['high', 'max']);
    expect(getProviderPublishedModel('openai', 'owned', source)?.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: 'high', max: 'max' });
    Object.defineProperty(map, 'high', { get() { getters++; throw Error('private-fixture'); } });
    expect(getProviderPublishedModel('openai', 'owned', source)?.thinkingLevelMap).not.toHaveProperty('high');
    Object.defineProperty(row, 'thinkingLevelMap', { get() { getters++; throw Error('private-fixture'); } });
    expect(getProviderPublishedModel('openai', 'owned', source)?.thinkingLevelMap).toBeUndefined();
    expect(getters).toBe(0);
  });
  it('returns non-secret capability, limit, and pricing metadata as defensive copies', () => {
    const first = getPublishedModelMetadata('openai', 'o3');
    expect(first).toMatchObject({
      name: 'o3',
      capabilities: { reasoning: true, imageInput: true, toolCalls: true },
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
    });
    expect(first?.thinkingLevelMap).toMatchObject({ off: null, low: 'low', max: null });
    first!.capabilities.reasoning = false;
    first!.thinkingLevelMap!.low = null;
    expect(getPublishedModelMetadata('openai', 'o3')?.capabilities.reasoning).toBe(true);
    expect(getPublishedModelMetadata('openai', 'o3')?.thinkingLevelMap?.low).toBe('low');
  });

  it('lists provider metadata and infers conservative capabilities for discovered models', () => {
    expect(getPublishedModels('mock').map(model => model.id)).toEqual(['mock-model', 'mock-model-v1']);
    expect(inferModelCapabilities('local', 'reasoning-tool-model')).toEqual({
      reasoning: true, imageInput: false, toolCalls: true,
    });
    expect(getPublishedModels('missing')).toEqual([]);
  });

  it('applies explicit thinking maps and upward-then-downward clamping', () => {
    const o3 = getSupportedThinkingLevels('openai', 'o3');
    expect(o3).toEqual(['low', 'medium', 'high']);
    expect(clampPublishedThinkingLevel('minimal', o3)).toBe('low');
    expect(clampPublishedThinkingLevel('max', o3)).toBe('high');
    expect(getPublishedModelMetadata('openai', 'gpt-4o')?.thinkingLevelMap).toBeNull();
    expect(getSupportedThinkingLevels('openai', 'gpt-4o')).toEqual(['off']);
    expect(getSupportedThinkingLevels('anthropic', 'claude-sonnet-4-6'))
      .toEqual(['off', 'minimal', 'low', 'medium', 'high', 'max']);
  });

  it('publishes the pinned forty-model Mistral projection with owned exact effort/media/price fields', () => {
    const models = getPublishedModels('mistral');
    expect(models).toHaveLength(40); expect(new Set(models.map(model => model.id)).size).toBe(40);
    expect(models.every(model => model.api === 'mistral-conversations')).toBe(true);
    expect(models.filter(model => model.capabilities.imageInput)).toHaveLength(21);
    expect(models.filter(model => model.capabilities.reasoning)).toHaveLength(11);
    expect(getPublishedModelMetadata('mistral', 'magistral-medium-latest')).toMatchObject({ contextWindow: 262144, maxOutputTokens: 16384,
      capabilities: { imageInput: true, reasoning: true }, pricing: { inputPerMillion: 2, outputPerMillion: 5, cacheReadPerMillion: 0.2 } });
    expect(getSupportedThinkingLevels('mistral', 'magistral-medium-latest')).toEqual(['off', 'high']);
    expect(getSupportedThinkingLevels('mistral', 'zai-glm-5-3')).toEqual(['low', 'high', 'max']);
    models.find(model => model.id === 'magistral-medium-latest')!.thinkingLevelMap!.high = null;
    expect(getSupportedThinkingLevels('mistral', 'magistral-medium-latest')).toEqual(['off', 'high']);
    expect(calculatePublishedModelCost('mistral', 'magistral-medium-latest', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000 })).toBe(2.54);
  });

  it('prices normalized cache-aware usage only for published models', () => {
    expect(calculatePublishedModelCost('openai', 'o3', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 200_000,
    })).toBe(6.1);
    expect(calculatePublishedModelCost('openai', 'unknown', { inputTokens: 1_000_000 })).toBeUndefined();
    expect(calculatePublishedModelCost('openai', 'o3', {
      inputTokens: -1,
      outputTokens: Number.NaN,
    })).toBe(0);
  });
});
