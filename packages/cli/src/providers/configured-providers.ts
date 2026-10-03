import {
  buildProviderModelCatalog,
  collectProviderModelCatalog,
  flattenModelCatalog,
  getPublishedProviders,
  PUBLISHED_THINKING_LEVELS,
  ProviderFactory,
  resolveModelReference,
  resolveModelScope,
  type AiProvider,
  type PiSettings,
  type ProviderConfig,
  type ThinkingLevel,
} from '@ai-harness/core';

export interface StartupProviderSelection {
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
export function applyPiModelSettings(
  selection: StartupProviderSelection,
  settings: PiSettings,
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
}

function attempt(
  providers: Map<string, AiProvider>,
  name: string,
  config: ProviderConfig | undefined,
): void {
  if (!config) return;
  try { providers.set(name, ProviderFactory.create(config)); }
  catch { /* Ignore providers whose environment configuration is incomplete. */ }
}

/** One environment resolver shared by interactive, print, and RPC CLI paths. */
export function createConfiguredProviders(env: NodeJS.ProcessEnv = process.env): Map<string, AiProvider> {
  const providers = new Map<string, AiProvider>();
  attempt(providers, 'mock', { type: 'mock' as any, apiKey: '', model: env.MOCK_MODEL || 'mock-model' });
  attempt(providers, 'openai', env.OPENAI_API_KEY
    ? { type: 'openai' as any, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }
    : undefined);
  attempt(providers, 'anthropic', env.ANTHROPIC_API_KEY
    ? { type: 'anthropic' as any, apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL }
    : undefined);
  const googleKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  attempt(providers, 'google', googleKey
    ? { type: 'google' as any, apiKey: googleKey, model: env.GEMINI_MODEL || 'gemini-2.0-flash' }
    : undefined);
  attempt(providers, 'azure', env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT
    ? {
        type: 'azure' as any,
        apiKey: env.AZURE_OPENAI_API_KEY,
        baseUrl: env.AZURE_OPENAI_ENDPOINT,
        deployment: env.AZURE_OPENAI_DEPLOYMENT,
        model: env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
        apiVersion: env.AZURE_OPENAI_API_VERSION,
      }
    : undefined);
  attempt(providers, 'vertex', env.GOOGLE_VERTEX_ACCESS_TOKEN && env.GOOGLE_CLOUD_PROJECT
    ? {
        type: 'vertex' as any,
        apiKey: env.GOOGLE_VERTEX_ACCESS_TOKEN,
        project: env.GOOGLE_CLOUD_PROJECT,
        location: env.GOOGLE_CLOUD_LOCATION,
        model: env.VERTEX_MODEL || 'gemini-2.0-flash',
      }
    : undefined);
  attempt(providers, 'bedrock', env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { type: 'bedrock' as any, region: env.AWS_REGION, model: env.BEDROCK_MODEL }
    : undefined);
  attempt(providers, 'local', {
    type: 'local' as any,
    apiKey: env.LOCAL_API_KEY || env.LLAMA_API_KEY || 'local',
    baseUrl: env.LOCAL_BASE_URL || env.LLAMA_BASE_URL || 'http://localhost:11434/v1',
    model: env.LOCAL_MODEL || env.LLAMA_MODEL || 'local-model',
  });
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

  if (requestedModel || selection.models?.length) {
    const catalog = flattenModelCatalog(requestedModel
      ? buildProviderModelCatalog([
          ...[...providers].map(([provider, instance]) => ({
            provider,
            configured: instance.validateConfig(),
            configuredModel: instance.getConfiguredModel(),
          })),
          ...getPublishedProviders()
            .filter(provider => !providers.has(provider))
            .map(provider => ({ provider, configured: false })),
        ])
      : await collectProviderModelCatalog(providers, {
          includePublishedProviders: true,
          timeoutMs: 2_000,
          retries: 0,
        }));
    const providerNames = new Map(catalog.map(item => [item.provider.toLowerCase(), item.provider]));

    if (requestedModel) {
      const prefix = requestedModel.slice(0, requestedModel.indexOf('/')).toLowerCase();
      const resolved = resolveModelReference(requestedModel, catalog, { provider: requestedProvider });
      if (resolved.model) {
        providerName = resolved.model.provider;
        model = resolved.model.id;
        thinkingLevel = resolved.thinkingLevel;
      } else {
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
      const candidates = requestedProvider
        ? catalog.filter(item => item.provider.toLowerCase() === requestedProvider)
        : catalog;
      const scope = resolveModelScope(selection.models ?? [], candidates);
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
    const base = provider ? providerConfig(provider) : { type: providerName as ProviderConfig['type'] };
    try {
      provider = ProviderFactory.create({
        ...base,
        type: providerName as ProviderConfig['type'],
        apiKey: selection.apiKey,
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
  };
}
