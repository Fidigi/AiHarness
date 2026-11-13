import {
  azureEnvironmentConfig,
  bedrockCredentialConfig,
  buildProviderModelCatalog,
  collectProviderModelCatalog,
  flattenModelCatalog,
  getPublishedProviders,
  getProviderPublishedModels,
  PUBLISHED_THINKING_LEVELS,
  ProviderFactory,
  DeepSeekProvider,
  GroqProvider,
  ZaiProvider,
  NvidiaProvider,
  MiniMaxProvider,
  MiniMaxCnProvider,
  KimiCodingProvider,
  MoonshotProvider,
  MoonshotCnProvider,
  AntLingProvider,
  BasetenProvider,
  TogetherProvider,
  HuggingFaceProvider,
  XiaomiProvider,
  MetaProvider,
  XaiProvider,
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

import type { CliGitHubCopilotSubscription, CliSubscription } from './provider-runtime.js';

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
  deepseek: DeepSeekProvider, groq: GroqProvider, zai: ZaiProvider, nvidia: NvidiaProvider,
  minimax: MiniMaxProvider, 'minimax-cn': MiniMaxCnProvider, 'kimi-coding': KimiCodingProvider,
  moonshotai: MoonshotProvider, 'moonshotai-cn': MoonshotCnProvider, 'ant-ling': AntLingProvider,
  baseten: BasetenProvider, together: TogetherProvider, huggingface: HuggingFaceProvider,
  xiaomi: XiaomiProvider, meta: MetaProvider, xai: XaiProvider,
};

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
  const anthropicKey = configuredCredential('anthropic', env.ANTHROPIC_API_KEY, options.credentials);
  const googleKey = configuredCredential('google', env.GEMINI_API_KEY || env.GOOGLE_API_KEY, options.credentials);
  const cerebrasKey = configuredCredential('cerebras', providerCredentialEnvironmentKeys('cerebras').map(name => env[name]).find(Boolean), options.credentials);
  const mistralKey = configuredCredential('mistral-conversations', providerCredentialEnvironmentKeys('mistral-conversations').map(name => env[name]).find(Boolean), options.credentials);
  const azureKey = configuredCredential('azure', env.AZURE_OPENAI_API_KEY, options.credentials);
  const vertexKey = configuredCredential('vertex', env.GOOGLE_VERTEX_ACCESS_TOKEN, options.credentials);
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
  attempt(providers, 'anthropic', anthropicKey
    ? { ...network, type: 'anthropic', apiKey: anthropicKey, model: env.ANTHROPIC_MODEL }
    : undefined);
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
    const prefix = name.toUpperCase().replace(/-/g, '_');
    const key = configuredCredential(name, providerCredentialEnvironmentKeys(name).map(key => env[key]).find(Boolean), options.credentials);
    attempt(providers, name, key ? { ...network, type: name, apiKey: key,
      model: env[`${prefix}_MODEL`], baseUrl: env[`${prefix}_BASE_URL`],
      ...(name === 'kimi-coding' ? { kimiAuthMode: providerCredentialEnvironmentKeys(name).some(key => env[key]) ? 'api-key' : options.kimiCodingAuthMode ?? 'api-key' } : {}),
    } : undefined);
  }
  const azure = azureEnvironmentConfig(env, azureKey);
  attempt(providers, 'azure', azure ? { ...network, ...azure } : undefined);
  attempt(providers, 'vertex', vertexKey && env.GOOGLE_CLOUD_PROJECT
    ? {
        ...network,
        type: 'vertex',
        apiKey: vertexKey,
        project: env.GOOGLE_CLOUD_PROJECT,
        location: env.GOOGLE_CLOUD_LOCATION,
        model: env.VERTEX_MODEL || 'gemini-2.0-flash',
      }
    : undefined);
  attempt(providers, 'bedrock', bedrockCredential
    ? { ...network, ...bedrockCredential, type: 'bedrock', region: env.AWS_REGION, model: env.BEDROCK_MODEL }
    : undefined);
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

  let providerName = requestedProvider;
  let model = requestedModel;
  let thinkingLevel: ThinkingLevel | undefined;
  let scopeDiagnostics: ModelScopeDiagnostic[] = [];

  if (requestedModel || selection.models?.length) {
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
      : await collectProviderModelCatalog(providers, {
          includePublishedProviders: true,
          discover: selection.offline !== true,
          timeoutMs: 2_000,
          retries: 0,
        })));
    const providerNames = new Map(catalog.map(item => [item.provider.toLowerCase(), item.provider]));
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
        const rawModel = inferredPrefix && !requestedProvider
          ? requestedModel.slice(requestedModel.indexOf('/') + 1)
          : requestedModel;
        const custom = splitCustomThinking(rawModel);
        model = custom.model;
        thinkingLevel = custom.thinkingLevel;
      }
    } else {
      const selectable = selection.apiKey
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
  if (selection.apiKey) {
    const prefix = providerName.toUpperCase().replace(/-/g, '_');
    const base = provider ? providerConfig(provider) : {
      type: providerName as ProviderConfig['type'],
      ...(Object.hasOwn(NATIVE_PROVIDERS, providerName) ? {
        model: env[`${prefix}_MODEL`], baseUrl: env[`${prefix}_BASE_URL`],
      } : {}),
    };
    try {
      provider = createProvider({
        ...base,
        type: providerName as ProviderConfig['type'],
        apiKey: selection.apiKey,
        ...(providerName === 'kimi-coding' ? { kimiAuthMode: 'api-key' } : {}),
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
  if (model) provider.setConfiguredModel(model);
  return {
    provider,
    providerName,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(scopeDiagnostics.length ? { scopeDiagnostics } : {}),
  };
}
