import { describe, expect, it } from 'vitest';
import { MockProvider } from '@ai-harness/core';
import {
  applyAgentModelSettings,
  createConfiguredProviders,
  resolveStartupProvider,
} from './configured-providers.js';

describe('configured CLI providers', () => {
  it('shares one bounded environment resolver across CLI modes', () => {
    const providers = createConfiguredProviders({
      OPENAI_API_KEY: 'test-openai',
      OPENAI_MODEL: 'gpt-test',
      ANTHROPIC_API_KEY: 'test-anthropic',
      GEMINI_API_KEY: 'test-google',
      LOCAL_BASE_URL: 'http://127.0.0.1:11434/v1',
    });

    expect([...providers.keys()]).toEqual(['mock', 'openai', 'anthropic', 'google', 'local']);
    expect([...providers.values()].every(provider => provider.validateConfig())).toBe(true);
    expect((providers.get('local') as unknown as { config: { apiKey?: string } }).config.apiKey)
      .toBeUndefined();
  });

  it('applies process-local stored credentials and one shared network policy', () => {
    const providers = createConfiguredProviders({}, {
      credentials: new Map([['openai', 'stored-secret']]),
      network: {
        transport: 'sse', httpProxy: 'http://proxy.test/', httpIdleTimeoutMs: 12,
        websocketConnectTimeoutMs: 34, requestTimeoutMs: 56, maxRetries: 2, maxRetryDelayMs: 78,
      },
    });
    const provider = providers.get('openai');
    expect(provider?.validateConfig()).toBe(true);
    expect(provider?.getNetworkSettings()).toEqual({
      transport: 'sse', httpIdleTimeoutMs: 12, websocketConnectTimeoutMs: 34,
      requestTimeoutMs: 56, maxRetries: 2, maxRetryDelayMs: 78, proxyConfigured: true,
    });
    expect(JSON.stringify(provider?.getNetworkSettings())).not.toContain('proxy.test');
    expect(JSON.stringify(provider?.getNetworkSettings())).not.toContain('stored-secret');
  });

  it('resolves qualified and fuzzy models with thinking suffixes and rejects conflicts', async () => {
    const providers = createConfiguredProviders({ OPENAI_API_KEY: 'test-openai' });
    await expect(resolveStartupProvider(providers, { model: 'openai/gpt-test' }))
      .resolves.toMatchObject({ providerName: 'openai', model: 'gpt-test' });
    await expect(resolveStartupProvider(providers, { model: '4o:high' }))
      .resolves.toMatchObject({ providerName: 'openai', model: 'gpt-4o', thinkingLevel: 'high' });

    await expect(resolveStartupProvider(providers, {
      provider: 'anthropic', model: 'openai/gpt-test',
    })).rejects.toThrow(/conflicts/i);
  });

  it('supports non-persistent API-key overrides and validates option dependencies', async () => {
    const providers = createConfiguredProviders({});
    await expect(resolveStartupProvider(providers, {
      provider: 'openai', model: 'gpt-test', apiKey: 'temporary-key',
    })).resolves.toMatchObject({ providerName: 'openai', model: 'gpt-test' });
    await expect(resolveStartupProvider(providers, {
      model: '4o:high', apiKey: 'temporary-key',
    })).resolves.toMatchObject({ providerName: 'openai', model: 'gpt-4o', thinkingLevel: 'high' });
    await expect(resolveStartupProvider(providers, { provider: 'openai' })).rejects.toThrow(/requires --model/i);
    await expect(resolveStartupProvider(providers, { apiKey: 'temporary-key' })).rejects.toThrow(/requires --model/i);
    await expect(resolveStartupProvider(providers, { model: 'anthropic/model' })).rejects.toThrow(/unavailable/i);
  });

  it('uses scopes and prefers a saved default that remains in scope', async () => {
    const providers = createConfiguredProviders({ MOCK_MODEL: 'mock-model' });
    await expect(resolveStartupProvider(providers, { models: ['mock/*-v1:low'] }))
      .resolves.toMatchObject({ providerName: 'mock', model: 'mock-model-v1', thinkingLevel: 'low' });
    await expect(resolveStartupProvider(providers, {
      models: ['mock/mock-model-v1:low', 'mock/mock-model:high'],
      preferredProvider: 'mock',
      preferredModel: 'mock-model',
    })).resolves.toMatchObject({ providerName: 'mock', model: 'mock-model', thinkingLevel: 'high' });
    await expect(resolveStartupProvider(providers, {
      models: ['openai/gpt-4o:high'], apiKey: 'temporary-key',
    })).resolves.toMatchObject({ providerName: 'openai', model: 'gpt-4o', thinkingLevel: 'high' });
  });

  it('applies model settings below explicit CLI selections', () => {
    expect(applyAgentModelSettings({}, {
      defaultProvider: 'mock',
      defaultModel: 'mock-model',
      enabledModels: ['mock/*'],
    })).toEqual({
      selection: {
        models: ['mock/*'],
        preferredProvider: 'mock',
        preferredModel: 'mock-model',
      },
      modelPatterns: ['mock/*'],
    });
    expect(applyAgentModelSettings({ model: 'explicit', provider: 'mock' }, {
      defaultProvider: 'other', defaultModel: 'saved', enabledModels: ['mock/*'],
    })).toMatchObject({ selection: { model: 'explicit', provider: 'mock' } });
  });

  it('preserves slash- and colon-bearing IDs when an explicit provider disambiguates them', async () => {
    const providers = createConfiguredProviders({});
    const routed = new MockProvider({ type: 'mock' as any, model: 'openai/gpt-4o:exacto' });
    providers.set('openrouter', routed);

    const selected = await resolveStartupProvider(providers, {
      provider: 'openrouter', model: 'openai/gpt-4o:exacto',
    });
    expect(selected).toMatchObject({ providerName: 'openrouter', model: 'openai/gpt-4o:exacto' });
    expect(selected.thinkingLevel).toBeUndefined();
  });
});
