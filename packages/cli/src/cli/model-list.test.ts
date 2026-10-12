import { describe, expect, it } from 'vitest';
import { MockProvider, ProviderType } from '@ai-harness/core';
import { formatConfiguredModelList } from './model-list.js';

describe('configured model listing', () => {
  it('prints shared catalogue metadata and applies fuzzy filtering', async () => {
    const providers = new Map([
      ['mock', new MockProvider({ type: ProviderType.MOCK, model: 'mock-model' })],
    ]);
    const output = await formatConfiguredModelList(providers, 'v1');
    expect(output).toContain('provider');
    expect(output).toContain('max-out');
    expect(output).toContain('mock-model-v1');
    expect(output).not.toContain('mock-model  ');
    await expect(formatConfiguredModelList(providers, 'missing-value'))
      .resolves.toBe('No models matching "missing-value"');
  });
});
