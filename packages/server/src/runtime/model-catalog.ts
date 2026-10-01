import type {
  ModelCapabilities,
  ModelCatalogEntry,
  ModelCatalogSource,
  ProviderModelCatalog,
  CustomModelDefinition,
  ModelPricing,
} from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';

export interface PublishedModel {
  id: string;
  name: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
}

const TEXT_TOOLS: ModelCapabilities = { reasoning: false, imageInput: false, toolCalls: true };
const VISION_TOOLS: ModelCapabilities = { reasoning: false, imageInput: true, toolCalls: true };
const REASONING_VISION_TOOLS: ModelCapabilities = { reasoning: true, imageInput: true, toolCalls: true };

/** Versioned-in-code fallback catalogue; provider discovery can augment it at runtime. */
export const PUBLISHED_MODEL_METADATA_VERSION = 2 as const;
const PUBLISHED_MODELS: Readonly<Record<string, readonly PublishedModel[]>> = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', capabilities: VISION_TOOLS, contextWindow: 128_000, maxOutputTokens: 16_384, pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 } },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 10, outputPerMillion: 30 } },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', capabilities: TEXT_TOOLS, pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5 } },
    { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 } },
    { id: 'o3', name: 'o3', capabilities: REASONING_VISION_TOOLS, contextWindow: 200_000, maxOutputTokens: 100_000, pricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 } },
  ],
  anthropic: [
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 15, outputPerMillion: 75 } },
    { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 } },
    { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet', capabilities: REASONING_VISION_TOOLS, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 } },
    { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 } },
  ],
  google: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: REASONING_VISION_TOOLS, pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125 } },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 } },
  ],
  azure: [
    { id: 'gpt-4o', name: 'GPT-4o deployment', capabilities: VISION_TOOLS },
  ],
  vertex: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', capabilities: REASONING_VISION_TOOLS, pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125 } },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 } },
  ],
  bedrock: [
    { id: 'anthropic.claude-3-haiku-20240307-v1:0', name: 'Claude 3 Haiku (Bedrock)', capabilities: VISION_TOOLS },
  ],
  local: [
    { id: 'local-model', name: 'Local server model', capabilities: { reasoning: false, imageInput: false, toolCalls: false } },
  ],
  mock: [
    { id: 'mock-model', name: 'Mock model', capabilities: { reasoning: false, imageInput: false, toolCalls: true } },
    { id: 'mock-model-v1', name: 'Mock model v1', capabilities: { reasoning: false, imageInput: false, toolCalls: true } },
  ],
};

export function getPublishedModelMetadata(provider: string, id: string): PublishedModel | undefined {
  const model = PUBLISHED_MODELS[provider]?.find(candidate => candidate.id === id);
  return model ? {
    ...model,
    capabilities: { ...model.capabilities },
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
  } : undefined;
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function inferredCapabilities(provider: string, model: string): ModelCapabilities {
  const normalized = model.toLowerCase();
  const reasoning = /(?:^|[-_.])(o[134]|r1|reason|thinking)(?:$|[-_.])/.test(normalized)
    || normalized.includes('gemini-2.5-pro')
    || normalized.includes('claude-3-7');
  const imageInput = ['openai', 'anthropic', 'google', 'azure', 'vertex'].includes(provider)
    || /vision|llava|vl(?:-|$)/.test(normalized);
  const toolCalls = provider !== 'local' || /tool|function|qwen|llama3|mistral/.test(normalized);
  return { reasoning, imageInput, toolCalls };
}

function entry(
  provider: string,
  model: Pick<PublishedModel, 'id' | 'name' | 'capabilities' | 'contextWindow' | 'maxOutputTokens' | 'pricing'>,
  configured: boolean,
  source: ModelCatalogSource,
): ModelCatalogEntry {
  return {
    key: `${provider}:${model.id}`,
    provider,
    id: model.id,
    name: model.name,
    available: configured,
    enabled: true,
    source,
    capabilities: { ...model.capabilities },
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
  };
}

/** Cached, non-secret catalogue assembled from published metadata and live provider discovery. */
export class ModelCatalogService {
  private readonly discovered = new Map<string, string[]>();
  private updatedAt?: string;
  private refreshedAt = 0;
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly proxy: AiProxyServer,
    private readonly customModels: () => CustomModelDefinition[] = () => [],
    private readonly cacheTtlMs = 5 * 60_000,
  ) {}

  async getCatalog(refresh = false): Promise<ProviderModelCatalog[]> {
    if (refresh || !this.updatedAt || Date.now() - this.refreshedAt >= this.cacheTtlMs) await this.refresh();
    return this.buildCatalog();
  }

  getUpdatedAt(): string {
    return this.updatedAt ?? new Date(0).toISOString();
  }

  getCapabilities(provider: string, model: string | undefined): ModelCapabilities | undefined {
    if (!model) return undefined;
    const custom = this.customModels().find(candidate => candidate.provider === provider && candidate.id === model);
    if (custom) return { ...custom.capabilities };
    const published = getPublishedModelMetadata(provider, model);
    return published ? { ...published.capabilities } : inferredCapabilities(provider, model);
  }

  getPricing(provider: string, model: string | undefined): ModelPricing | undefined {
    if (!model) return undefined;
    const custom = this.customModels().find(candidate => candidate.provider === provider && candidate.id === model);
    if (custom?.pricing) return { ...custom.pricing };
    const published = getPublishedModelMetadata(provider, model);
    return published?.pricing ? { ...published.pricing } : undefined;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const configuredProviders = this.proxy.getProviders().filter(provider => provider.configured);
      await Promise.all(configuredProviders.map(async ({ type }) => {
        const provider = this.proxy.getAgentProvider(type);
        if (!provider) return;
        try {
          let models: string[] | undefined;
          let lastError: unknown;
          for (let attempt = 0; attempt < 3 && !models; attempt++) {
            try {
              models = await Promise.race([
                provider.getAvailableModels(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Model discovery timed out.')), 8_000)),
              ]);
            } catch (error) {
              lastError = error;
              if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
            }
          }
          if (!models) throw lastError;
          this.discovered.set(type, [...new Set(models
            .filter(validModelId)
            .map(model => model.trim()))].slice(0, 500));
        } catch {
          // Discovery is optional. Keep the last successful bounded cache.
        }
      }));
      this.updatedAt = new Date().toISOString();
      this.refreshedAt = Date.now();
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private buildCatalog(): ProviderModelCatalog[] {
    const providerStates = new Map(this.proxy.getProviders().map(provider => [provider.type, provider.configured]));
    for (const model of this.customModels()) {
      if (!providerStates.has(model.provider)) providerStates.set(model.provider, this.proxy.isConfigured(model.provider));
    }
    const providers = [...providerStates].map(([type, configured]) => ({ type, configured }));
    return providers.map(({ type, configured }) => {
      const models = new Map<string, ModelCatalogEntry>();
      for (const published of PUBLISHED_MODELS[type] ?? []) {
        models.set(published.id, entry(type, published, configured, 'published'));
      }

      const configuredModel = this.proxy.getAgentProvider(type)?.getConfiguredModel();
      if (validModelId(configuredModel) && !models.has(configuredModel)) {
        models.set(configuredModel, entry(type, {
          id: configuredModel,
          name: configuredModel,
          capabilities: inferredCapabilities(type, configuredModel),
        }, configured, 'configured'));
      }

      for (const discoveredModel of this.discovered.get(type) ?? []) {
        const existing = models.get(discoveredModel);
        models.set(discoveredModel, existing
          ? { ...existing, source: 'discovered', available: configured }
          : entry(type, {
              id: discoveredModel,
              name: discoveredModel,
              capabilities: inferredCapabilities(type, discoveredModel),
            }, configured, 'discovered'));
      }

      for (const custom of this.customModels().filter(model => model.provider === type)) {
        models.set(custom.id, {
          key: custom.key,
          provider: custom.provider,
          id: custom.id,
          name: custom.name,
          available: configured,
          enabled: true,
          source: 'custom',
          capabilities: { ...custom.capabilities },
          ...(custom.contextWindow ? { contextWindow: custom.contextWindow } : {}),
          ...(custom.maxOutputTokens ? { maxOutputTokens: custom.maxOutputTokens } : {}),
          ...(custom.pricing ? { pricing: { ...custom.pricing } } : {}),
          ...(custom.compatibility ? { compatibility: { ...custom.compatibility } } : {}),
        });
      }

      return {
        provider: type,
        configured,
        models: [...models.values()],
      };
    });
  }
}
