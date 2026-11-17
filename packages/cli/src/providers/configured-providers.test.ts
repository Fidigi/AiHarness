import { describe, expect, it, vi } from 'vitest';
import type { ProviderOAuthCredential } from '@ai-harness/core';
import { OpenAiProvider, OpenAiMixedProvider, BedrockProvider, CerebrasProvider, DeepSeekProvider, GroqProvider, ZaiProvider, NvidiaProvider, MiniMaxProvider, MiniMaxCnProvider, KimiCodingProvider, KimiCodingOAuthProvider, MoonshotProvider, MoonshotCnProvider, AntLingProvider, BasetenProvider, TogetherProvider, HuggingFaceProvider, XiaomiProvider, MetaProvider, XaiProvider, FireworksProvider, OpenCodeProvider, OpenCodeGoProvider, OpenRouterProvider, CloudflareWorkersAiMixedProvider, QwenTokenPlanProvider, QwenTokenPlanCnProvider, QwenTokenPlanIndividualProvider,
  XiaomiTokenPlanAmsProvider, XiaomiTokenPlanCnProvider, XiaomiTokenPlanSgpProvider, ZaiCodingCnProvider, MistralProvider, MockProvider, ProviderFactory, TypesafeProvider, CloudflareAiGatewayProvider, VercelAiGatewayProvider, collectProviderModelCatalog, SpecializedModels } from '@ai-harness/core';
import {
  applyAgentModelSettings,
  createConfiguredProviders,
  getConfiguredSpecializedProviders,
  resolveStartupProvider,
} from './configured-providers.js';

describe('configured CLI providers', () => {
  it.each([['cloudflare-ai-gateway', 'CLOUDFLARE_AI_GATEWAY', 'CLOUDFLARE_API_KEY', CloudflareAiGatewayProvider, 'gpt-4.1'],
    ['vercel-ai-gateway', 'VERCEL_AI_GATEWAY', 'AI_GATEWAY_API_KEY', VercelAiGatewayProvider, 'alibaba/qwen-3-14b']] as const)(
    'composes native %s gateway hints/aliases without vendor credentials, discovery or factory reservation', async (name, prefix, alias, Adapter, model) => {
      expect(createConfiguredProviders({ ANTHROPIC_API_KEY: 'synthetic-vendor', OPENAI_API_KEY: 'synthetic-other' }).has(name)).toBe(false);
      const env = { [alias]: 'synthetic-alias', [`${prefix}_API_KEY`]: 'synthetic-second', [`AI_HARNESS_${prefix}_API_KEY`]: 'synthetic-first',
        [`${prefix}_MODEL`]: model, [`${prefix}_BASE_URL`]: 'http://127.0.0.1/owned', CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', CLOUDFLARE_GATEWAY_ID: 'synthetic-gateway' };
      const providers = createConfiguredProviders(env); expect(providers.get(name)).toBeInstanceOf(Adapter);
      expect((providers.get(name) as unknown as { config: object }).config).toMatchObject({ apiKey: 'synthetic-first', model, baseUrl: 'http://127.0.0.1/owned' });
      expect(providers.get(name)!.canDiscoverModels()).toBe(false);
      const scoped = await resolveStartupProvider(createConfiguredProviders({}), { provider: name, models: [`${name}/${model}`], apiKey: 'synthetic-cold', offline: true }, env);
      expect(scoped.provider).toBeInstanceOf(Adapter); expect(scoped.model).toBe(model);
      expect((scoped.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'synthetic-cold', baseUrl: 'http://127.0.0.1/owned' });
      expect(getConfiguredSpecializedProviders(providers).has(name)).toBe(name === 'vercel-ai-gateway');
      expect(ProviderFactory.has(name)).toBe(false);
      const unregister = ProviderFactory.register(name, config => new MockProvider({ ...config, model: 'operator-chat' }));
      try { expect(createConfiguredProviders(env).get(name)).toBeInstanceOf(MockProvider); } finally { unregister(); }
    });

  it('composes native Kimi issuer state while preserving key/ephemeral overrides and factory authority', async () => {
    const credential: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'private-configured-kimi', refreshToken: 'private-kimi-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'kimi-coding', oauthHost: 'https://issuer.kimi.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    const source = vi.fn(async () => credential), options = { kimiOAuth: { credential, credentialSource: source } }, env = { KIMI_CODING_BASE_URL: 'https://inference.kimi.test/coding' };
    const native = createConfiguredProviders(env, options); expect(native.get('kimi-coding')).toBeInstanceOf(KimiCodingOAuthProvider);
    const override = await resolveStartupProvider(native, { provider: 'kimi-coding', model: 'k3', apiKey: 'private-invocation', offline: true }, {});
    expect(override.provider).not.toBeInstanceOf(KimiCodingOAuthProvider); expect((override.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'private-invocation', kimiAuthMode: 'api-key', baseUrl: 'https://inference.kimi.test/coding/v1/messages' });
    expect(createConfiguredProviders({ ...env, KIMI_CODING_API_KEY: 'private-env-key' }, options).get('kimi-coding')).not.toBeInstanceOf(KimiCodingOAuthProvider); expect(source).not.toHaveBeenCalled();
    const unregister = ProviderFactory.register('kimi-coding', config => new MockProvider({ ...config, model: 'operator-chat' }));
    try { const provider = createConfiguredProviders(env, options).get('kimi-coding')!; expect(provider).toBeInstanceOf(MockProvider); expect((provider as unknown as { config: { apiKey?: string } }).config.apiKey).toBeUndefined(); expect(source).not.toHaveBeenCalled(); } finally { unregister(); }
  });
  it('ignores retired gateway credentials without disabling the remaining providers', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    try {
      const providers = createConfiguredProviders({ RADIUS_API_KEY: 'synthetic-retired', RADIUS_GATEWAY: 'http://127.0.0.1:1',
        OPENAI_API_KEY: 'synthetic-openai', ANTHROPIC_API_KEY: 'synthetic-anthropic', GOOGLE_API_KEY: 'synthetic-google' });
      expect(providers.has('radius')).toBe(false);
      expect(providers.get('openai')).toBeInstanceOf(OpenAiProvider);
      expect(providers.get('anthropic')?.getModelApi()).toBe('anthropic-messages');
      expect(providers.get('google')?.getModelApi()).toBe('google-generative-ai');
      await expect(resolveStartupProvider(providers, { provider: 'radius', model: 'balanced', apiKey: 'synthetic-retired', offline: true }, {})).rejects.toThrow('Provider unavailable');
      expect(transport).not.toHaveBeenCalled();
    } finally { transport.mockRestore(); }
  });
  it('keeps explicit native OpenAI R/D separate from legacy C, subscription labels and registered factories', async () => {
    const legacy = createConfiguredProviders({ OPENAI_API_KEY: 'synthetic-legacy', OPENAI_CODEX_API_KEY: 'synthetic-foreign' });
    expect(legacy.get('openai')).toBeInstanceOf(OpenAiProvider); expect(legacy.has('openai-native')).toBe(false);
    const native = createConfiguredProviders({ OPENAI_NATIVE_API_KEY: 'synthetic-native' });
    expect(native.has('openai')).toBe(false); expect(native.has('openai-codex')).toBe(false);
    expect(native.get('openai-native')).toBeInstanceOf(OpenAiMixedProvider);
    const catalog = await collectProviderModelCatalog(native, { discover: false, includePublishedProviders: false });
    const models = catalog.find(provider => provider.provider === 'openai-native')!.models;
    expect(models).toHaveLength(44); expect(models.every(model => model.api === 'openai-responses')).toBe(true);
    expect(native.get('openai-native')?.getSpecializedModels()).toEqual(expect.arrayContaining([expect.objectContaining({ api: 'openai-decisions', type: 'classifier' })]));
    expect(createConfiguredProviders({ OPENAI_NATIVE_API_KEY: 'synthetic-native', OPENAI_NATIVE_MODEL: 'unknown' }).has('openai-native')).toBe(false);
    expect(ProviderFactory.has('openai-native')).toBe(false);
    const unregister = ProviderFactory.register('openai-native', config => new MockProvider({ ...config, model: 'operator-chat' }));
    try {
      const overridden = createConfiguredProviders({ OPENAI_NATIVE_API_KEY: 'synthetic-native' });
      expect(overridden.get('openai-native')).toBeInstanceOf(MockProvider);
      expect(getConfiguredSpecializedProviders(overridden).size).toBe(0);
    } finally { unregister(); }
  });

  it('composes TypeSafe as an explicit native auxiliary source, never a chat catalogue or name-based grant', async () => {
    expect(createConfiguredProviders({}).has('typesafe')).toBe(false);
    const providers = createConfiguredProviders({ TYPESAFE_API_KEY: 'synthetic-typesafe', TYPESAFE_BASE_URL: 'http://127.0.0.1/v1' },
      { network: { transport: 'sse', requestTimeoutMs: 123, maxRetries: 0, httpIdleTimeoutMs: 100,
        websocketConnectTimeoutMs: 100, maxRetryDelayMs: 100 } });
    expect(providers.get('typesafe')).toBeInstanceOf(TypesafeProvider);
    expect(providers.get('typesafe')?.getNetworkSettings()).toMatchObject({ requestTimeoutMs: 123, maxRetries: 0 });
    expect([...getConfiguredSpecializedProviders(providers).keys()]).toEqual(['typesafe']);
    expect((await collectProviderModelCatalog(providers, { discover: false, includePublishedProviders: false }))
      .find(provider => provider.provider === 'typesafe')?.models).toEqual([]);
    expect(createConfiguredProviders({}, { credentials: { typesafe: 'synthetic-stored' } }).get('typesafe')).toBeInstanceOf(TypesafeProvider);
    expect(ProviderFactory.has('typesafe')).toBe(false);
    const unregister = ProviderFactory.register('typesafe', config => new MockProvider({ ...config, model: 'operator-chat' }));
    try {
      const overridden = createConfiguredProviders({ TYPESAFE_API_KEY: 'synthetic-typesafe' });
      expect(overridden.get('typesafe')).toBeInstanceOf(MockProvider);
      expect(getConfiguredSpecializedProviders(overridden).size).toBe(0);
    } finally { unregister(); }
  });

  it('admits configured native specialized services without adding an auxiliary Mock image fallback', () => {
    const providers = createConfiguredProviders({ DEEPSEEK_API_KEY: 'synthetic-chat', TYPESAFE_API_KEY: 'synthetic-t',
      OPENROUTER_API_KEY: 'synthetic-router', OPENCODE_API_KEY: 'synthetic-zen',
      CLOUDFLARE_WORKERS_AI_API_KEY: 'synthetic-cf', CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', OPENAI_NATIVE_API_KEY: 'synthetic-rd' });
    const source = getConfiguredSpecializedProviders(providers);
    expect([...source.keys()]).toEqual(['opencode', 'openrouter', 'cloudflare-workers-ai', 'typesafe', 'openai-native']);
    const bridge = new SpecializedModels(providers.get('deepseek')!, undefined, undefined, () => source);
    const images = bridge.getAvailableOfType('image');
    expect(images).toHaveLength(61); expect(images.every(model => model.provider === 'openrouter' && model.api === 'openrouter-images')).toBe(true);
    expect(bridge.getModelOfType('image')).toMatchObject({ provider: 'openrouter', api: 'openrouter-images' });
    expect(bridge.getAvailableOfType('classifier').map(model => model.api))
      .toEqual(expect.arrayContaining(['typesafe-system-one', 'cloudflare-workers-ai-system-one', 'openai-decisions']));
    expect(providers.get('deepseek')?.getConfiguredModel()).toBe('deepseek-flash');
  });

  it.each([
    ['deepseek', DeepSeekProvider, 'deepseek-flash'],
    ['groq', GroqProvider, 'qwen/qwen3.6-27b'],
    ['zai', ZaiProvider, 'glm-5.3-flash'],
    ['nvidia', NvidiaProvider, 'deepseek-ai/deepseek-v4.1-flash'],
  ] as const)('composes native %s without reserving extension authority', async (name, Adapter, model) => {
    const prefix = name.toUpperCase();
    expect(createConfiguredProviders({}).has(name)).toBe(false);
    const providers = createConfiguredProviders({
      [`${prefix}_API_KEY`]: 'environment', [`AI_HARNESS_${prefix}_API_KEY`]: 'first',
      [`${prefix}_MODEL`]: model, [`${prefix}_BASE_URL`]: 'http://127.0.0.1/owned/v1',
    }, { credentials: { [name]: 'stored' }, network: { transport: 'sse', httpIdleTimeoutMs: 12,
      websocketConnectTimeoutMs: 34, requestTimeoutMs: 56, maxRetries: 0, maxRetryDelayMs: 78 } });
    const provider = providers.get(name);
    expect(provider).toBeInstanceOf(Adapter);
    expect((provider as unknown as { config: object }).config).toMatchObject({
      apiKey: 'first', model, baseUrl: 'http://127.0.0.1/owned/v1/chat/completions',
    });
    expect(provider?.getNetworkSettings()).toMatchObject({ requestTimeoutMs: 56, maxRetries: 0 });
    const stored = createConfiguredProviders({}, { credentials: new Map([[name, 'stored']]) });
    expect(stored.get(name)).toBeInstanceOf(Adapter);
    expect(stored.get(name)?.validateConfig()).toBe(true);
    const { selection } = applyAgentModelSettings({}, { defaultProvider: name, defaultModel: model });
    await expect(resolveStartupProvider(stored, selection, {})).resolves.toMatchObject({ providerName: name, model });
    await expect(resolveStartupProvider(providers, { models: [`${name}/*:high`], preferredProvider: name, preferredModel: model, offline: true }, {}))
      .resolves.toMatchObject({ providerName: name, model, thinkingLevel: 'high' });
    const temporary = await resolveStartupProvider(providers, { provider: name, model, apiKey: 'temporary' }, {});
    expect(temporary.provider).toBeInstanceOf(Adapter);
    expect((temporary.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'temporary', baseUrl: 'http://127.0.0.1/owned/v1/chat/completions' });
    const cold = await resolveStartupProvider(createConfiguredProviders({}), { provider: name, model, apiKey: 'cold-key' }, { [`${prefix}_BASE_URL`]: 'http://127.0.0.1/cold' });
    expect(cold.provider).toBeInstanceOf(Adapter);
    expect((cold.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'cold-key', baseUrl: 'http://127.0.0.1/cold/chat/completions' });
    expect(createConfiguredProviders({ [`${prefix}_API_KEY`]: 'synthetic', [`${prefix}_MODEL`]: 'unknown' }).has(name)).toBe(false);
    expect(ProviderFactory.has(name)).toBe(false);
    const unregister = ProviderFactory.register(name, config => new MockProvider({ ...config, model: 'operator-model' }));
    try {
      const overridden = createConfiguredProviders({ [`${prefix}_API_KEY`]: 'synthetic' });
      expect(overridden.get(name)).toBeInstanceOf(MockProvider);
      expect((await resolveStartupProvider(overridden, { provider: name, model: 'operator-model', apiKey: 'override' }, {})).provider).toBeInstanceOf(MockProvider);
    } finally { unregister(); }
  });

  it.each([
    ['minimax', MiniMaxProvider, 'MINIMAX', 'https://api.minimax.io/anthropic/v1/messages'],
    ['minimax-cn', MiniMaxCnProvider, 'MINIMAX_CN', 'https://api.minimaxi.com/anthropic/v1/messages'],
    ['kimi-coding', KimiCodingProvider, 'KIMI_CODING', 'https://api.kimi.com/coding/v1/messages'],
  ] as const)('composes native %s with independent credentials and physical endpoints', async (name, Adapter, prefix, endpoint) => {
    const providers = createConfiguredProviders({ [`${prefix}_API_KEY`]: 'synthetic-region-key' });
    const provider = providers.get(name);
    expect(provider).toBeInstanceOf(Adapter);
    expect((provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'synthetic-region-key', baseUrl: endpoint });
    for (const other of ['minimax', 'minimax-cn', 'kimi-coding']) if (other !== name) expect(providers.has(other)).toBe(false);
    expect(ProviderFactory.has(name)).toBe(false);
    const model = provider!.getConfiguredModel()!;
    await expect(resolveStartupProvider(providers, { models: [`${name}/*:high`], preferredProvider: name, preferredModel: model, offline: true }, {}))
      .resolves.toMatchObject({ providerName: name, model, thinkingLevel: 'high' });
    expect(createConfiguredProviders({}, { credentials: new Map([[name, 'stored-key']]) }).get(name)).toBeInstanceOf(Adapter);
    const override = await resolveStartupProvider(providers, { provider: name, model, apiKey: 'override' }, {});
    expect(override.provider).toBeInstanceOf(Adapter);
    expect((override.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'override', baseUrl: endpoint });
  });

  it.each([
    ['openai-native', OpenAiMixedProvider], ['moonshotai', MoonshotProvider], ['moonshotai-cn', MoonshotCnProvider],
    ['ant-ling', AntLingProvider], ['baseten', BasetenProvider], ['together', TogetherProvider],
    ['huggingface', HuggingFaceProvider], ['xiaomi', XiaomiProvider], ['meta', MetaProvider], ['xai', XaiProvider],
    ['qwen-token-plan', QwenTokenPlanProvider], ['qwen-token-plan-cn', QwenTokenPlanCnProvider],
    ['qwen-token-plan-individual', QwenTokenPlanIndividualProvider], ['xiaomi-token-plan-ams', XiaomiTokenPlanAmsProvider],
    ['xiaomi-token-plan-cn', XiaomiTokenPlanCnProvider], ['xiaomi-token-plan-sgp', XiaomiTokenPlanSgpProvider], ['zai-coding-cn', ZaiCodingCnProvider],
  ] as const)('admits supplied-key %s through the existing native CLI mechanism', async (name, Adapter) => {
    const prefix = name.toUpperCase().replace(/-/g, '_');
    expect(createConfiguredProviders({}).has(name)).toBe(false);
    const providers = createConfiguredProviders({ [`${prefix}_API_KEY`]: 'environment', [`AI_HARNESS_${prefix}_API_KEY`]: 'first',
      [`${prefix}_BASE_URL`]: 'http://127.0.0.1/native/v1' }, { credentials: { [name]: 'stored' } });
    const provider = providers.get(name);
    expect(provider).toBeInstanceOf(Adapter);
    expect((provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'first' });
    expect(createConfiguredProviders({}, { credentials: new Map([[name, 'stored']]) }).get(name)).toBeInstanceOf(Adapter);
    const model = provider!.getConfiguredModel()!;
    const { selection } = applyAgentModelSettings({}, { defaultProvider: name, defaultModel: model });
    await expect(resolveStartupProvider(providers, selection, {})).resolves.toMatchObject({ providerName: name, model });
    const selected = await resolveStartupProvider(providers, { provider: name, model, apiKey: 'ephemeral' }, {});
    expect(selected.provider).toBeInstanceOf(Adapter);
    expect((selected.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'ephemeral' });
    expect(ProviderFactory.has(name)).toBe(false);
    if (name.startsWith('moonshotai')) expect(providers.has(name === 'moonshotai' ? 'moonshotai-cn' : 'moonshotai')).toBe(false);
  });

  it.each([
    ['fireworks', FireworksProvider], ['opencode', OpenCodeProvider], ['opencode-go', OpenCodeGoProvider],
    ['openrouter', OpenRouterProvider], ['cloudflare-workers-ai', CloudflareWorkersAiMixedProvider],
  ] as const)('composes native mixed %s without converting specialized operations into chat', async (name, Adapter) => {
    const prefix = name.toUpperCase().replace(/-/g, '_');
    expect(createConfiguredProviders({}).has(name)).toBe(false);
    const env = { [`${prefix}_API_KEY`]: 'synthetic-mixed-key', [`${prefix}_BASE_URL`]: 'http://127.0.0.1/owned/v1' };
    const providers = createConfiguredProviders(env);
    const provider = providers.get(name);
    expect(provider).toBeInstanceOf(Adapter);
    expect(provider?.getPublishedModels?.()?.length).toBeGreaterThan(0);
    const model = provider!.getConfiguredModel()!;
    await expect(resolveStartupProvider(providers, { provider: name, model, offline: true }, {})).resolves.toMatchObject({ providerName: name, model });
    const fetch = name === 'openrouter' ? vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1/owned/v1/models/user'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ephemeral'); return new Response('', { status: 404 });
    }) : undefined;
    try {
      const override = await resolveStartupProvider(providers, { provider: name, model, apiKey: 'ephemeral' }, {});
      expect(override.provider).toBeInstanceOf(Adapter);
      expect((override.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'ephemeral' });
      expect(ProviderFactory.has(name)).toBe(false); if (fetch) expect(fetch).toHaveBeenCalledOnce();
    } finally { fetch?.mockRestore(); }
  });

  it('requires explicit Workers AI account or endpoint and preserves account configuration with an ephemeral key', async () => {
    expect(createConfiguredProviders({ CLOUDFLARE_WORKERS_AI_API_KEY: 'key' }).has('cloudflare-workers-ai')).toBe(false);
    const env = { CLOUDFLARE_WORKERS_AI_API_KEY: 'key', CLOUDFLARE_ACCOUNT_ID: 'synthetic-account' };
    const providers = createConfiguredProviders(env);
    expect(providers.get('cloudflare-workers-ai')).toBeInstanceOf(CloudflareWorkersAiMixedProvider);
    const model = providers.get('cloudflare-workers-ai')!.getConfiguredModel()!;
    const selected = await resolveStartupProvider(createConfiguredProviders({}), { provider: 'cloudflare-workers-ai', model, apiKey: 'explicit' }, env);
    expect((selected.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'explicit', accountId: 'synthetic-account' });
  });

  it('does not borrow plan credentials or import the full Qwen catalogue into the Individual plan', () => {
    const providers = createConfiguredProviders({ QWEN_TOKEN_PLAN_API_KEY: 'synthetic-global' });
    expect(providers.get('qwen-token-plan')).toBeInstanceOf(QwenTokenPlanProvider);
    for (const id of ['qwen-token-plan-cn', 'qwen-token-plan-individual', 'xiaomi-token-plan-cn', 'zai-coding-cn']) expect(providers.has(id)).toBe(false);
    const individual = createConfiguredProviders({ QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY: 'synthetic-individual' }).get('qwen-token-plan-individual')!;
    expect(individual.getPublishedModels?.()).toHaveLength(9);
    expect(() => individual.setConfiguredModel('deepseek-v3.2')).toThrow('Token-plan chat model is not supported.');
  });

  it('uses credential type, not label or token shape, for Kimi auth and overrides OAuth with explicit keys', async () => {
    const oauth = createConfiguredProviders({}, { credentials: { 'kimi-coding': 'synthetic-oauth' }, kimiCodingAuthMode: 'oauth' });
    const config = (provider: unknown) => (provider as { config: Record<string, unknown> }).config;
    expect(config(oauth.get('kimi-coding')).kimiAuthMode).toBe('oauth');
    expect(config(createConfiguredProviders({ KIMI_CODING_API_KEY: 'env-key' }, { credentials: { 'kimi-coding': 'synthetic-oauth' }, kimiCodingAuthMode: 'oauth' }).get('kimi-coding')))
      .toMatchObject({ kimiAuthMode: 'api-key', apiKey: 'env-key' });
    const selected = await resolveStartupProvider(oauth, { provider: 'kimi-coding', model: 'k3', apiKey: 'explicit-key' }, {});
    expect(config(selected.provider)).toMatchObject({ kimiAuthMode: 'api-key', apiKey: 'explicit-key' });
  });

  it('composes native Cerebras credentials, defaults and scoped settings without an extension', async () => {
    expect(createConfiguredProviders({}).has('cerebras')).toBe(false);
    const providers = createConfiguredProviders({
      CEREBRAS_API_KEY: 'cerebras-environment',
      AI_HARNESS_CEREBRAS_API_KEY: 'cerebras-conventional-first',
      CEREBRAS_MODEL: 'qwen-3.8-27b', CEREBRAS_BASE_URL: 'http://127.0.0.1/owned/v1',
    }, { credentials: { cerebras: 'cerebras-stored' } });
    const provider = providers.get('cerebras');
    expect(provider).toBeInstanceOf(CerebrasProvider);
    expect((provider as unknown as { config: Record<string, unknown> }).config).toMatchObject({
      apiKey: 'cerebras-conventional-first', model: 'qwen-3.8-27b', baseUrl: 'http://127.0.0.1/owned/v1/chat/completions',
    });
    const stored = createConfiguredProviders({}, { credentials: new Map([['cerebras', 'cerebras-stored']]) });
    expect(stored.get('cerebras')).toBeInstanceOf(CerebrasProvider);
    expect(stored.get('cerebras')?.getConfiguredModel()).toBe('gpt-oss-120b');
    expect(stored.get('cerebras')?.validateConfig()).toBe(true);
    const { selection } = applyAgentModelSettings({}, { defaultProvider: 'cerebras', defaultModel: 'qwen-3.8-27b' });
    await expect(resolveStartupProvider(stored, selection, {})).resolves.toMatchObject({ providerName: 'cerebras', model: 'qwen-3.8-27b' });
    await expect(resolveStartupProvider(providers, { models: ['cerebras/*:high'], preferredProvider: 'cerebras', preferredModel: 'qwen-3.8-27b' }, {}))
      .resolves.toMatchObject({ providerName: 'cerebras', model: 'qwen-3.8-27b', thinkingLevel: 'high' });
    expect(createConfiguredProviders({ CEREBRAS_API_KEY: 'synthetic', CEREBRAS_MODEL: 'unknown' }).has('cerebras')).toBe(false);
  });

  it('composes native Mistral without reserving the bare extension name', async () => {
    expect(createConfiguredProviders({}).has('mistral-conversations')).toBe(false);
    expect(ProviderFactory.has('mistral')).toBe(false);
    const providers = createConfiguredProviders({ MISTRAL_API_KEY: 'environment',
      AI_HARNESS_MISTRAL_CONVERSATIONS_API_KEY: 'first', MISTRAL_MODEL: 'magistral-medium-latest',
      MISTRAL_BASE_URL: 'http://127.0.0.1/owned/v1',
    }, { credentials: { 'mistral-conversations': 'stored' } });
    const provider = providers.get('mistral-conversations');
    expect(provider).toBeInstanceOf(MistralProvider);
    expect((provider as unknown as { config: Record<string, unknown> }).config).toMatchObject({
      apiKey: 'first', model: 'magistral-medium-latest', baseUrl: 'http://127.0.0.1/owned/v1',
    });
    const stored = createConfiguredProviders({}, { credentials: new Map([['mistral-conversations', 'stored']]) });
    expect(stored.get('mistral-conversations')?.getConfiguredModel()).toBe('mistral-small-latest');
    expect(stored.get('mistral-conversations')?.validateConfig()).toBe(true);
    const { selection } = applyAgentModelSettings({}, { defaultProvider: 'mistral-conversations', defaultModel: 'magistral-medium-latest' });
    await expect(resolveStartupProvider(stored, selection, {})).resolves.toMatchObject({ providerName: 'mistral-conversations', model: 'magistral-medium-latest' });
    await expect(resolveStartupProvider(providers, { models: ['mistral-conversations/*:high'],
      preferredProvider: 'mistral-conversations', preferredModel: 'magistral-medium-latest', offline: true }, {}))
      .resolves.toMatchObject({ providerName: 'mistral-conversations', model: 'magistral-medium-latest', thinkingLevel: 'high' });
  });

  it('composes explicit Codex WebSocket without selecting it or borrowing ordinary credentials', async () => {
    let resolutions = 0;
    const providers = createConfiguredProviders({ OPENAI_API_KEY: 'ordinary-key' }, { openaiCodex: {
      model: 'gpt-6.1-sol', credentialSource: async () => { resolutions++; return undefined; },
    }, network: { transport: 'websocket', httpIdleTimeoutMs: 12, websocketConnectTimeoutMs: 34,
      requestTimeoutMs: 56, maxRetries: 0, maxRetryDelayMs: 78 } });
    expect(providers.has('openai-codex')).toBe(true); expect(providers.has('openai')).toBe(true);
    expect((await resolveStartupProvider(providers, {}, {})).providerName).toBe('mock');
    expect(resolutions).toBe(0);
    await expect(providers.get('openai-codex')!.chat([])).rejects.toThrow('OpenAI Codex request failed.');
    expect(resolutions).toBe(1);
  });

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

  it('selects Bedrock Bearers by source while preserving stored SigV4 and refusing malformed selected credentials', () => {
    const token = 'ACCESS:opaque:token';
    const config = (provider: unknown) => (provider as { config: Record<string, unknown> }).config;
    const fromEnvironment = createConfiguredProviders({ AWS_BEARER_TOKEN_BEDROCK: token, AWS_ACCESS_KEY_ID: 'OLD', AWS_SECRET_ACCESS_KEY: 'old' }).get('bedrock');
    expect(fromEnvironment).toBeInstanceOf(BedrockProvider);
    expect(config(fromEnvironment).apiKey).toBe(token);
    expect(fromEnvironment?.validateConfig()).toBe(true);
    const stored = createConfiguredProviders({}, { credentials: { bedrock: JSON.stringify({ bearerToken: token }) } }).get('bedrock');
    expect(config(stored).apiKey).toBe(token);
    expect(stored?.validateConfig()).toBe(true);
    const legacy = createConfiguredProviders({}, { credentials: { bedrock: 'ACCESS:secret:session' } }).get('bedrock');
    expect(config(legacy)).toMatchObject({ accessKeyId: 'ACCESS', secretAccessKey: 'secret', sessionToken: 'session' });
    expect(config(legacy).apiKey).toBeUndefined(); expect(legacy?.validateConfig()).toBe(true);
    const sigv4 = createConfiguredProviders({ AWS_ACCESS_KEY_ID: 'EXPLICIT', AWS_SECRET_ACCESS_KEY: 'explicit', AWS_SESSION_TOKEN: 'session' }).get('bedrock');
    expect(config(sigv4)).toMatchObject({ accessKeyId: 'EXPLICIT', secretAccessKey: 'explicit', sessionToken: 'session' });
    expect(createConfiguredProviders({ AWS_ACCESS_KEY_ID: 'OLD', AWS_SECRET_ACCESS_KEY: 'old' }, { credentials: { bedrock: 'ACCESS:' } }).has('bedrock')).toBe(false);
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
