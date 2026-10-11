import {
  buildProviderModelCatalog,
  discoverProviderModelIds,
  getPublishedModelMetadata,
  inferModelCapabilities,
  type PublishedModelMetadata,
  type AiProvider,
} from '@ai-harness/core';
import type {
  ModelCapabilities,
  ModelPricing,
  ProviderModelCatalog,
  CustomModelDefinition,
} from '@ai-harness/core';
import type { AiProxyServer } from '../api/proxy.js';

export {
  PUBLISHED_MODEL_METADATA_VERSION,
  getPublishedModelMetadata,
} from '@ai-harness/core';
export type PublishedModel = PublishedModelMetadata;

/** Cached, non-secret catalogue assembled from published metadata and live provider discovery. */
export class ModelCatalogService {
  private readonly discovered = new Map<string, string[]>();
  private readonly discoverySources = new Map<string, AiProvider>();
  private updatedAt?: string;
  private refreshedAt = 0;
  private refreshPromise?: Promise<void>;

  constructor(
    private readonly proxy: AiProxyServer,
    private readonly customModels: () => CustomModelDefinition[] = () => [],
    private readonly cacheTtlMs = 5 * 60_000,
  ) {}

  async getCatalog(refresh = false): Promise<ProviderModelCatalog[]> {
    const changedSource = this.proxy.getProviders().some(({ type }) => {
      const provider = this.proxy.getAgentProvider(type);
      return provider?.canDiscoverModels() && this.discoverySources.get(type) !== provider;
    });
    if (refresh || changedSource || !this.updatedAt || Date.now() - this.refreshedAt >= this.cacheTtlMs) await this.refresh();
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
    return published ? { ...published.capabilities } : inferModelCapabilities(provider, model);
  }

  getPricing(provider: string, model: string | undefined): ModelPricing | undefined {
    if (!model) return undefined;
    const custom = this.customModels().find(candidate => candidate.provider === provider && candidate.id === model);
    if (custom?.pricing) return { ...custom.pricing };
    const published = getPublishedModelMetadata(provider, model);
    return published?.pricing ? { ...published.pricing } : undefined;
  }

  /** Drop source-bound discovery after provider replacement/removal/rename. */
  invalidateProvider(provider: string): void {
    this.discovered.delete(provider);
    this.discoverySources.delete(provider);
    this.refreshedAt = 0;
    this.updatedAt = undefined;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      for (const [type, source] of this.discoverySources) {
        if (this.proxy.getAgentProvider(type) !== source) {
          this.discoverySources.delete(type);
          this.discovered.delete(type);
        }
      }
      const configuredProviders = this.proxy.getProviders().filter(({ type }) =>
        this.proxy.getAgentProvider(type)?.canDiscoverModels());
      await Promise.all(configuredProviders.map(async ({ type }) => {
        const provider = this.proxy.getAgentProvider(type);
        if (!provider) return;
        if (this.discoverySources.get(type) !== provider) this.discovered.delete(type);
        this.discoverySources.set(type, provider);
        try {
          const models = await discoverProviderModelIds(provider);
          if (this.proxy.getAgentProvider(type) === provider) this.discovered.set(type, models);
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
    return buildProviderModelCatalog([...providerStates].map(([provider, configured]) => ({
      provider,
      configured,
      configuredModel: this.proxy.getAgentProvider(provider)?.getConfiguredModel(),
      discoveredModels: this.discoverySources.get(provider) === this.proxy.getAgentProvider(provider)
        ? this.discovered.get(provider) : undefined,
    })), this.customModels());
  }
}
