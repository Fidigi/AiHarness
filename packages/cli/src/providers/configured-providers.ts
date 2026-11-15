import {
  azureEnvironmentConfig,
  vertexEnvironmentConfig,
  bedrockCredentialConfig,
  buildProviderModelCatalog,
  collectProviderModelCatalog,
  flattenModelCatalog,
  getPublishedProviders,
  getProviderPublishedModels,
  PUBLISHED_THINKING_LEVELS,
  ProviderFactory,
  OpenAiMixedProvider,
  AnthropicProvider, AnthropicOAuthProvider, MetaOAuthProvider, XaiOAuthProvider,
  DeepSeekProvider,
  GroqProvider,
  ZaiProvider,
  NvidiaProvider,
  MiniMaxProvider,
  MiniMaxCnProvider,
  KimiCodingProvider,
  KimiCodingOAuthProvider,
  MoonshotProvider,
  MoonshotCnProvider,
  AntLingProvider,
  BasetenProvider,
  TogetherProvider,
  HuggingFaceProvider,
  XiaomiProvider,
  MetaProvider,
  XaiProvider,
  FireworksProvider,
  OpenCodeProvider,
  OpenCodeGoProvider,
  OpenRouterProvider,
  OPENROUTER_COMPLETION_MODELS, OPENROUTER_MESSAGE_MODELS,
  CloudflareWorkersAiMixedProvider,
  TypesafeProvider,
  RadiusProvider,
  CloudflareAiGatewayProvider, VercelAiGatewayProvider,
  discoverProviderModelIds,
  QwenTokenPlanProvider, QwenTokenPlanCnProvider, QwenTokenPlanIndividualProvider,
  XiaomiTokenPlanAmsProvider, XiaomiTokenPlanCnProvider, XiaomiTokenPlanSgpProvider, ZaiCodingCnProvider,
  GitHubCopilotProvider,
  OpenAICodexProvider,
  providerCredentialEnvironmentKeys,
  resolveModelReference,
  resolveModelScope,
  type AiProvider,
  type AgentProviderNetworkSettings,
  type AgentSettings,
  type ProviderConfig,
  type ExtensionProvider,
  type ThinkingLevel,
  type ModelScopeDiagnostic,
  type VirtualModelRegistry,
} from '@ai-harness/core';

import type { CliGitHubCopilotSubscription, CliSubscription, CliRadiusOAuth, CliKimiOAuth, CliAnthropicOAuth, CliProviderRuntime } from './provider-runtime.js';

export interface StartupProviderSelection {
  offline?: boolean;
  provider?: string;
  model?: string;
  models?: string[];
  apiKey?: string;
  /** Settings default considered only when resolving a model scope. */
  preferredProvider?: string;
  preferredModel?: string;
}

export interface EffectiveStartupProviderSelection {
  selection: StartupProviderSelection;
  modelPatterns?: string[];
}

/** Apply settings below explicit CLI values without turning a saved default into an invocation override. */
export function applyAgentModelSettings(
  selection: StartupProviderSelection,
  settings: AgentSettings,
): EffectiveStartupProviderSelection {
  const modelPatterns = selection.models ?? settings.enabledModels;
  if (selection.model) return { selection: { ...selection, models: modelPatterns }, modelPatterns };
  if (modelPatterns?.length) {
    return {
      selection: {
        ...selection,
        models: [...modelPatterns],
        preferredProvider: settings.defaultProvider,
        preferredModel: settings.defaultModel,
      },
      modelPatterns: [...modelPatterns],
    };
  }
  if (settings.defaultModel) {
    return {
      selection: {
        ...selection,
        provider: selection.provider ?? settings.defaultProvider,
        model: settings.defaultModel,
      },
    };
  }
  return { selection };
}

export interface ResolvedStartupProvider {
  provider: AiProvider;
  providerName: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Nonfatal scope failures; adapters warn on stderr without protocol records. */
  scopeDiagnostics?: ModelScopeDiagnostic[];
}

// CLI composition only: explicit extension factories keep precedence and names remain unreserved.
const NATIVE_PROVIDERS = {
  anthropic: AnthropicProvider,
  deepseek: DeepSeekProvider, groq: GroqProvider, zai: ZaiProvider, nvidia: NvidiaProvider,
  minimax: MiniMaxProvider, 'minimax-cn': MiniMaxCnProvider, 'kimi-coding': KimiCodingProvider,
  moonshotai: MoonshotProvider, 'moonshotai-cn': MoonshotCnProvider, 'ant-ling': AntLingProvider,
  baseten: BasetenProvider, together: TogetherProvider, huggingface: HuggingFaceProvider,
  xiaomi: XiaomiProvider, meta: MetaProvider, xai: XaiProvider,
  fireworks: FireworksProvider, opencode: OpenCodeProvider, 'opencode-go': OpenCodeGoProvider,
  openrouter: OpenRouterProvider, 'cloudflare-workers-ai': CloudflareWorkersAiMixedProvider,
  'qwen-token-plan': QwenTokenPlanProvider, 'qwen-token-plan-cn': QwenTokenPlanCnProvider,
  'qwen-token-plan-individual': QwenTokenPlanIndividualProvider,
  'xiaomi-token-plan-ams': XiaomiTokenPlanAmsProvider, 'xiaomi-token-plan-cn': XiaomiTokenPlanCnProvider,
  'xiaomi-token-plan-sgp': XiaomiTokenPlanSgpProvider, 'zai-coding-cn': ZaiCodingCnProvider,
  typesafe: TypesafeProvider, 'openai-native': OpenAiMixedProvider, radius: RadiusProvider,
  'cloudflare-ai-gateway': CloudflareAiGatewayProvider, 'vercel-ai-gateway': VercelAiGatewayProvider,
};

/** Existing native specialized services only; names/Mock factories never grant auxiliary authority. */
export function getConfiguredSpecializedProviders(providers: ReadonlyMap<string, AiProvider>): ReadonlyMap<string, AiProvider> {
  return new Map([...providers].filter(([, provider]) => provider instanceof TypesafeProvider
    || provider instanceof OpenRouterProvider || provider instanceof OpenAiMixedProvider || provider instanceof OpenCodeProvider
    || provider instanceof CloudflareWorkersAiMixedProvider || provider instanceof VercelAiGatewayProvider));
}

function createProvider(config: ProviderConfig): AiProvider {
  if (ProviderFactory.has(config.type)) return ProviderFactory.create(config);
  const Adapter = NATIVE_PROVIDERS[config.type as keyof typeof NATIVE_PROVIDERS];
  return Adapter ? new Adapter(config) : ProviderFactory.create(config);
}

function attempt(
  providers: Map<string, AiProvider>,
  name: string,
  config: ProviderConfig | undefined,
): void {
  if (!config) return;
  try { providers.set(name, createProvider(config)); }
  catch { /* Ignore providers whose environment configuration is incomplete. */ }
}

export interface CreateConfiguredProvidersOptions {
  githubCopilot?: CliGitHubCopilotSubscription;
  openaiCodex?: CliSubscription;
  kimiCodingAuthMode?: 'api-key' | 'oauth';
  anthropicAuthMode?: 'api-key' | 'oauth';
  anthropicOAuth?: CliAnthropicOAuth;
  anthropicFederation?: CliProviderRuntime['anthropicFederation'];
  vertexAdc?: CliProviderRuntime['vertexAdc'];
  vertexAuthMode?: CliProviderRuntime['vertexAuthMode'];
  bedrockProfile?: CliProviderRuntime['bedrockProfile'];
  radiusCatalogueDirectory?: string;
  radiusOAuth?: CliRadiusOAuth;
  kimiOAuth?: CliKimiOAuth;
  metaOAuth?: CliProviderRuntime['metaOAuth'];
  xaiOAuth?: CliProviderRuntime['xaiOAuth'];
  /** Process-local resolved secrets. They are never copied into descriptors or sessions. */
  credentials?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  network?: AgentProviderNetworkSettings;
  extensionProviders?: ReadonlyArray<{ type: string; definition: ExtensionProvider }>;
}

function configuredCredential(
  provider: string,
  envValue: string | undefined,
  credentials: CreateConfiguredProvidersOptions['credentials'],
): string | undefined {
  if (envValue) return envValue;
  if (!credentials) return undefined;
  if (typeof (credentials as ReadonlyMap<string, string>).get === 'function') {
    return (credentials as ReadonlyMap<string, string>).get(provider);
  }
  return (credentials as Readonly<Record<string, string>>)[provider];
}

function nativeEnvironmentHints(name: string, env: NodeJS.ProcessEnv, catalogueDirectory?: string): Partial<ProviderConfig> {
  if (name === 'bedrock') return { region: env.AWS_REGION || env.AWS_DEFAULT_REGION, baseUrl: env.BEDROCK_BASE_URL, model: env.BEDROCK_MODEL };
  if (name === 'vertex') return { project: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT, location: env.GOOGLE_CLOUD_LOCATION,
    baseUrl: env.VERTEX_BASE_URL, model: env.VERTEX_MODEL, vertexAuthMode: env.GOOGLE_VERTEX_ACCESS_TOKEN || !env.GOOGLE_CLOUD_API_KEY ? 'bearer' : 'api-key' };
  if (!Object.hasOwn(NATIVE_PROVIDERS, name)) return {};
  const prefix = name.toUpperCase().replace(/-/g, '_');
  return { model: env[`${prefix}_MODEL`], baseUrl: env[`${prefix}_BASE_URL`],
    ...(name === 'cloudflare-workers-ai' || name === 'cloudflare-ai-gateway' ? { accountId: env.CLOUDFLARE_ACCOUNT_ID } : {}),
    ...(name === 'cloudflare-ai-gateway' ? { gatewayId: env.CLOUDFLARE_GATEWAY_ID } : {}),
    ...(name === 'radius' ? { gateway: env.RADIUS_GATEWAY, catalogueDirectory } : {}) };
}

function networkConfig(network?: AgentProviderNetworkSettings): Partial<ProviderConfig> {
  return network ? {
    transport: network.transport,
    ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
    httpIdleTimeoutMs: network.httpIdleTimeoutMs,
    websocketConnectTimeoutMs: network.websocketConnectTimeoutMs,
    requestTimeoutMs: network.requestTimeoutMs,
    providerMaxRetries: network.maxRetries,
    providerMaxRetryDelayMs: network.maxRetryDelayMs,
  } : {};
}

/** One credential/network resolver shared by interactive, print, JSON, and RPC CLI paths. */
export function createConfiguredProviders(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateConfiguredProvidersOptions = {},
): Map<string, AiProvider> {
  const providers = new Map<string, AiProvider>();
  const network = networkConfig(options.network);
  if (options.githubCopilot) providers.set('github-copilot', new GitHubCopilotProvider(
    { ...network, type: 'github-copilot', model: options.githubCopilot.model }, options.githubCopilot.credentialSource));
  if (options.openaiCodex) {
    try { providers.set('openai-codex', new OpenAICodexProvider(
      { ...network, type: 'openai-codex', model: options.openaiCodex.model }, options.openaiCodex.credentialSource)); }
    catch { /* Unsupported subscription configuration must not disable other providers. */ }
  }
  const openAiKey = configuredCredential('openai', env.OPENAI_API_KEY, options.credentials);
  const anthropicKey = configuredCredential('anthropic', providerCredentialEnvironmentKeys('anthropic').map(name => env[name]).find(Boolean), options.credentials);
  const googleKey = configuredCredential('google', env.GEMINI_API_KEY || env.GOOGLE_API_KEY, options.credentials);
  const cerebrasKey = configuredCredential('cerebras', providerCredentialEnvironmentKeys('cerebras').map(name => env[name]).find(Boolean), options.credentials);
  const mistralKey = configuredCredential('mistral-conversations', providerCredentialEnvironmentKeys('mistral-conversations').map(name => env[name]).find(Boolean), options.credentials);
  const azureKey = configuredCredential('azure', env.AZURE_OPENAI_API_KEY, options.credentials);
  const vertexKey = configuredCredential('vertex', env.GOOGLE_VERTEX_ACCESS_TOKEN || env.GOOGLE_CLOUD_API_KEY, options.credentials);
  const localKey = configuredCredential('local', env.LOCAL_API_KEY || env.LLAMA_API_KEY, options.credentials);
  const bedrockKey = configuredCredential('bedrock', env.AWS_BEARER_TOKEN_BEDROCK, options.credentials);
  const bedrockCredential = bedrockKey !== undefined
    ? env.AWS_BEARER_TOKEN_BEDROCK ? { apiKey: bedrockKey } : bedrockCredentialConfig(bedrockKey)
    : env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN }
      : undefined;

  attempt(providers, 'mock', { ...network, type: 'mock', apiKey: '', model: env.MOCK_MODEL || 'mock-model' });
  attempt(providers, 'openai', openAiKey
    ? { ...network, type: 'openai', apiKey: openAiKey, model: env.OPENAI_MODEL }
    : undefined);
  const anthropicConfig = { ...network, ...nativeEnvironmentHints('anthropic', env), type: 'anthropic' };
  if (anthropicKey) attempt(providers, 'anthropic', { ...anthropicConfig, apiKey: anthropicKey,
    anthropicAuthMode: env.ANTHROPIC_API_KEY ? 'api-key' : env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_OAUTH_TOKEN ? 'oauth' : options.anthropicAuthMode ?? 'api-key' });
  else if (options.anthropicOAuth) {
    // Anthropic is an existing reserved Core built-in, not a newly reserved extension name.
    try { providers.set('anthropic', new AnthropicOAuthProvider(anthropicConfig, options.anthropicOAuth.credentialSource)); }
    catch { /* A retired native source must not disable unrelated providers. */ }
  } else if (options.anthropicFederation) attempt(providers, 'anthropic', { ...anthropicConfig, anthropicFederation: options.anthropicFederation });
  attempt(providers, 'google', googleKey
    ? { ...network, type: 'google', apiKey: googleKey, model: env.GEMINI_MODEL || 'gemini-2.0-flash' }
    : undefined);
  attempt(providers, 'cerebras', cerebrasKey
    ? { ...network, type: 'cerebras', apiKey: cerebrasKey, model: env.CEREBRAS_MODEL, baseUrl: env.CEREBRAS_BASE_URL }
    : undefined);
  attempt(providers, 'mistral-conversations', mistralKey
    ? { ...network, type: 'mistral-conversations', apiKey: mistralKey, model: env.MISTRAL_MODEL, baseUrl: env.MISTRAL_BASE_URL }
    : undefined);
  for (const name of Object.keys(NATIVE_PROVIDERS)) {
    if (name === 'anthropic') continue; // Preserve existing built-in insertion/default-selection order above.
    const key = configuredCredential(name, providerCredentialEnvironmentKeys(name).map(key => env[key]).find(Boolean), options.credentials);
    if (name === 'xai' && !key && options.xaiOAuth) {
      const config = { ...network, ...nativeEnvironmentHints(name, env), type: name };
      try { providers.set(name, ProviderFactory.has(name) ? createProvider(config) : new XaiOAuthProvider(config, options.xaiOAuth.credentialSource)); }
      catch { /* A retired xAI source does not disable unrelated providers. */ }
      continue;
    }
    if (name === 'meta' && !key && options.metaOAuth) {
      const config = { ...network, ...nativeEnvironmentHints(name, env), type: name };
      try { providers.set(name, ProviderFactory.has(name) ? createProvider(config) : new MetaOAuthProvider(config, options.metaOAuth.credentialSource)); }
      catch { /* A retired Meta source does not disable unrelated providers. */ }
      continue;
    }
    if (name === 'kimi-coding' && !key && options.kimiOAuth) {
      const config = { ...network, ...nativeEnvironmentHints(name, env), type: name,
        oauthHost: env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST || (options.kimiOAuth.credential.subscription?.provider === 'kimi-coding' ? options.kimiOAuth.credential.subscription.oauthHost : undefined) };
      try { providers.set(name, ProviderFactory.has(name) ? createProvider(config) : new KimiCodingOAuthProvider(config, options.kimiOAuth.credentialSource)); }
      catch { /* Invalid or foreign issuer state does not disable other providers. */ }
      continue;
    }
    if (name === 'radius' && !key && options.radiusOAuth) {
      const config = { ...network, ...nativeEnvironmentHints(name, env, options.radiusCatalogueDirectory), type: name,
        gateway: env.RADIUS_GATEWAY ?? (options.radiusOAuth.credential.subscription?.provider === 'radius' ? options.radiusOAuth.credential.subscription.gateway : undefined) };
      try { providers.set(name, ProviderFactory.has(name) ? createProvider(config) : new RadiusProvider(config, options.radiusOAuth.credentialSource, options.radiusOAuth.credential)); }
      catch { /* Invalid or foreign issuer state does not disable other providers. */ }
      continue;
    }
    attempt(providers, name, key ? { ...network, type: name, apiKey: key,
      ...nativeEnvironmentHints(name, env, options.radiusCatalogueDirectory),
      ...(name === 'kimi-coding' ? { kimiAuthMode: providerCredentialEnvironmentKeys(name).some(key => env[key]) ? 'api-key' : options.kimiCodingAuthMode ?? 'api-key' } : {}),
    } : undefined);
  }
  const azure = azureEnvironmentConfig(env, azureKey);
  attempt(providers, 'azure', azure ? { ...network, ...azure } : undefined);
  const vertex = vertexEnvironmentConfig(env, vertexKey, options.vertexAuthMode);
  attempt(providers, 'vertex', vertex ? { ...network, ...vertex } : options.vertexAdc ? { ...network, ...options.vertexAdc } : undefined);
  attempt(providers, 'bedrock', bedrockCredential
    ? { ...network, ...bedrockCredential, ...nativeEnvironmentHints('bedrock', env), type: 'bedrock' }
    : options.bedrockProfile ? { ...network, ...options.bedrockProfile } : undefined);
  attempt(providers, 'local', {
    ...network,
    type: 'local',
    ...(localKey ? { apiKey: localKey } : {}),
    baseUrl: env.LOCAL_BASE_URL || env.LLAMA_BASE_URL || 'http://localhost:11434/v1',
    model: env.LOCAL_MODEL || env.LLAMA_MODEL || 'local-model',
  });
  for (const { type, definition } of options.extensionProviders ?? []) {
    if (providers.has(type)) continue;
    const key = configuredCredential(type, undefined, options.credentials);
    attempt(providers, type, { ...definition.defaultConfig, ...network, type,
      ...(key ? { apiKey: key } : {}) });
  }
  return providers;
}

function providerConfig(provider: AiProvider): ProviderConfig {
  return { ...(provider as unknown as { config: ProviderConfig }).config };
}

function splitCustomThinking(model: string): { model: string; thinkingLevel?: ThinkingLevel } {
  const separator = model.lastIndexOf(':');
  if (separator <= 0) return { model };
  const suffix = model.slice(separator + 1).toLowerCase() as ThinkingLevel;
  return PUBLISHED_THINKING_LEVELS.includes(suffix)
    ? { model: model.slice(0, separator), thinkingLevel: suffix }
    : { model };
}

/** Resolve startup provider/model overrides through Core's shared catalogue and matcher. */
export async function resolveStartupProvider(
  providers: Map<string, AiProvider>,
  selection: StartupProviderSelection,
  env: NodeJS.ProcessEnv = process.env,
  virtualModels?: VirtualModelRegistry,
  nativeOptions: Pick<CreateConfiguredProvidersOptions, 'radiusCatalogueDirectory' | 'network'> & { signal?: AbortSignal } = {},
): Promise<ResolvedStartupProvider> {
  const requestedProvider = selection.provider?.trim().toLowerCase();
  const requestedModel = selection.model?.trim();
  if (selection.provider && !requestedModel && !selection.models?.length) {
    throw new Error('--provider requires --model or --models.');
  }
  if (selection.apiKey && !requestedModel && !selection.models?.length) {
    throw new Error('--api-key requires --model or --models.');
  }
  if (!requestedModel && selection.model !== undefined) throw new Error('--model requires a non-empty value.');

  // These native scopes must start with the invocation key, not a cached account or missing static source.
  let scopedKeyProvider: AiProvider | undefined;
  const scopedNames = [...new Set(selection.models?.map(pattern => pattern.trim().split('/')[0]!.toLowerCase()) ?? [])];
  let scopedKeyName = requestedProvider ?? (scopedNames.length === 1 ? scopedNames[0] : undefined);
  if (selection.apiKey && scopedKeyName && /[*?[\]]/u.test(scopedKeyName)) {
    const names = [...new Set([...Object.keys(NATIVE_PROVIDERS), ...providers.keys()])];
    const matched = resolveModelScope([`${scopedKeyName}/*`], names.map(provider => ({ provider, id: '_scope_' }))).models;
    const unique = [...new Set(matched.map(item => item.model.provider))]; scopedKeyName = unique.length === 1 ? unique[0] : undefined;
  }
  if (selection.apiKey && selection.models?.length && scopedKeyName && (['anthropic', 'radius', 'cloudflare-ai-gateway', 'vercel-ai-gateway', 'openrouter'].includes(scopedKeyName) || providers.get(scopedKeyName) instanceof OpenRouterProvider)) {
    const previous = providers.get(scopedKeyName);
    scopedKeyProvider = createProvider({ ...(previous ? providerConfig(previous) : {
      ...networkConfig(nativeOptions.network), ...nativeEnvironmentHints(scopedKeyName, env, nativeOptions.radiusCatalogueDirectory),
    }), type: scopedKeyName, apiKey: selection.apiKey, ...(scopedKeyName === 'anthropic' ? { anthropicAuthMode: 'api-key' } : {}) });
    providers.set(scopedKeyName, scopedKeyProvider);
  }

  let providerName = requestedProvider;
  let model = requestedModel;
  let thinkingLevel: ThinkingLevel | undefined;
  let scopeDiagnostics: ModelScopeDiagnostic[] = [];

  const personalized = new Set<AiProvider>();
  if (requestedModel || selection.models?.length) {
    if (selection.models?.length && !selection.offline) for (const [name, instance] of providers) {
      if (requestedProvider && name !== requestedProvider || !(instance instanceof OpenRouterProvider) || !instance.validateConfig()) continue;
      if (selection.apiKey && instance !== scopedKeyProvider) continue; // Never resolve the invocation's catalogue with a stored key.
      const declarations = [...OPENROUTER_COMPLETION_MODELS, ...OPENROUTER_MESSAGE_MODELS].map(profile => ({ provider: name, id: profile.id, name: profile.name }));
      if (!resolveModelScope(selection.models, declarations).models.length) continue;
      await instance.refreshUserModels({ signal: nativeOptions.signal }); personalized.add(instance);
    }
    const catalog = flattenModelCatalog((catalog => virtualModels?.overlayCatalog(catalog) ?? catalog)(requestedModel
      ? buildProviderModelCatalog([
          ...[...providers].map(([provider, instance]) => ({
            provider,
            configured: instance.validateConfig(),
            configuredModel: instance.getConfiguredModel(),
            publishedModels: getProviderPublishedModels(instance),
            discoveryAuthoritative: instance.isModelDiscoveryAuthoritative?.() === true,
            getModelApi: (model: string) => instance.getModelApi?.(model),
          })),
          ...getPublishedProviders()
            .filter(provider => !providers.has(provider))
            .map(provider => ({ provider, configured: false })),
        ])
      : await collectProviderModelCatalog(scopedKeyProvider instanceof AnthropicProvider || scopedKeyProvider instanceof RadiusProvider || scopedKeyProvider instanceof CloudflareAiGatewayProvider || scopedKeyProvider instanceof VercelAiGatewayProvider || scopedKeyProvider instanceof OpenRouterProvider
        ? new Map([[scopedKeyName!, scopedKeyProvider]]) : providers, {
          includePublishedProviders: true,
          discover: selection.offline !== true,
          timeoutMs: 2_000,
          retries: 0,
          signal: nativeOptions.signal,
        })));
    // A fresh account gateway may intentionally publish no models before discovery.
    const providerNames = new Map([
      ...[...providers.keys(), ...(selection.apiKey ? Object.keys(NATIVE_PROVIDERS) : [])].map(name => [name.toLowerCase(), name] as const),
      ...catalog.map(item => [item.provider.toLowerCase(), item.provider] as const),
    ]);
    const candidates = requestedProvider
      ? catalog.filter(item => item.provider.toLowerCase() === requestedProvider)
      : catalog;
    const scope = resolveModelScope(selection.models ?? [], candidates);
    scopeDiagnostics = scope.diagnostics;

    if (requestedModel) {
      const prefix = requestedModel.slice(0, requestedModel.indexOf('/')).toLowerCase();
      const resolved = resolveModelReference(requestedModel, catalog, { provider: requestedProvider });
      if (resolved.model) {
        providerName = resolved.model.provider;
        model = resolved.model.id;
        thinkingLevel = resolved.thinkingLevel;
      } else {
        if (resolved.code === 'ambiguous') throw new Error(resolved.message ?? 'Model reference is ambiguous. Use provider/model.');
        if (requestedProvider && requestedModel.includes('/') && providerNames.has(prefix) && prefix !== requestedProvider) {
          throw new Error(`Provider ${requestedProvider} conflicts with qualified model ${requestedModel}.`);
        }
        const inferredPrefix = requestedModel.includes('/') ? providerNames.get(prefix) : undefined;
        const customProvider = requestedProvider ?? inferredPrefix
          ?? (env.AI_HARNESS_DEFAULT_PROVIDER?.trim().toLowerCase() || undefined);
        if (!customProvider) throw new Error(resolved.message ?? `Model "${requestedModel}" not found.`);
        providerName = customProvider;
        const rawModel = inferredPrefix && (!requestedProvider || inferredPrefix === requestedProvider)
          ? requestedModel.slice(requestedModel.indexOf('/') + 1)
          : requestedModel;
        const custom = splitCustomThinking(rawModel);
        model = custom.model;
        thinkingLevel = custom.thinkingLevel;
      }
    } else {
      const selectable = selection.apiKey && !scopedKeyProvider
        ? scope.models
        : scope.models.filter(item => item.model.available);
      let first = selectable[0];
      if (selection.preferredModel) {
        const preferredReference = selection.preferredProvider
          ? `${selection.preferredProvider}/${selection.preferredModel}`
          : selection.preferredModel;
        const preferred = resolveModelReference(
          preferredReference,
          selectable.map(item => item.model),
          { provider: selection.preferredProvider },
        ).model;
        if (preferred) {
          first = selectable.find(item => item.model.provider === preferred.provider && item.model.id === preferred.id)
            ?? first;
        }
      }
      if (!first) {
        const details = scope.diagnostics.map(diagnostic => diagnostic.message).join(' ');
        throw new Error(details || 'No models match the active model scope.');
      }
      providerName = first.model.provider;
      model = first.model.id;
      thinkingLevel = first.thinkingLevel;
    }
  }

  providerName = providerName
    ?? (env.AI_HARNESS_DEFAULT_PROVIDER?.trim().toLowerCase() || undefined)
    ?? 'mock';
  let provider = providers.get(providerName);
  if (selection.apiKey && (!scopedKeyProvider || provider !== scopedKeyProvider)) {
    const base = provider ? providerConfig(provider) : {
      ...networkConfig(nativeOptions.network), type: providerName as ProviderConfig['type'],
      ...nativeEnvironmentHints(providerName, env, nativeOptions.radiusCatalogueDirectory),
    };
    try {
      provider = createProvider({
        ...base,
        type: providerName as ProviderConfig['type'],
        apiKey: selection.apiKey,
        ...(providerName === 'kimi-coding' ? { kimiAuthMode: 'api-key' } : {}),
        ...(providerName === 'anthropic' ? { anthropicAuthMode: 'api-key' } : {}),
        ...(model ? { model } : {}),
      });
      providers.set(providerName, provider);
    } catch {
      throw new Error(`Provider unavailable: ${providerName}.`);
    }
  }
  if (!provider) {
    throw new Error(`Provider unavailable: ${providerName}. Configured providers: ${[...providers.keys()].join(', ')}.`);
  }
  if (provider instanceof RadiusProvider && !selection.offline && (!selection.models?.length || selection.apiKey && provider !== scopedKeyProvider)) {
    await discoverProviderModelIds(provider, { timeoutMs: 2_000, retries: 0, signal: nativeOptions.signal });
  }
  if (provider instanceof OpenRouterProvider && !selection.offline && !personalized.has(provider)) await provider.refreshUserModels({ signal: nativeOptions.signal });
  if (model) provider.setConfiguredModel(model);
  return {
    provider,
    providerName,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(scopeDiagnostics.length ? { scopeDiagnostics } : {}),
  };
}
