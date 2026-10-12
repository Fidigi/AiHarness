import { describe, expect, it } from 'vitest';
import {
  calculatePublishedModelCost,
  clampPublishedThinkingLevel,
  getPublishedModelMetadata,
  getPublishedModels,
  getSupportedThinkingLevels,
  inferModelCapabilities,
} from './model-metadata.js';

describe('shared model metadata', () => {
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
