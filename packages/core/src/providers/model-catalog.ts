import type { AiProvider } from './index.js';
import {
  getPublishedModelMetadata,
  getPublishedModels,
  getPublishedProviders,
  inferModelCapabilities,
  PUBLISHED_THINKING_LEVELS,
  type PublishedThinkingLevel,
} from './model-metadata.js';
import type {
  CustomModelDefinition,
  ModelCatalogEntry,
  ModelCatalogSource,
  ProviderModelCatalog,
} from '../types/index.js';

export interface ProviderModelState {
  provider: string;
  configured: boolean;
  configuredModel?: string;
  discoveredModels?: readonly string[];
}

export interface ModelIdentity {
  provider: string;
  id: string;
  name?: string;
  available?: boolean;
}

export interface ResolvedModel<T extends ModelIdentity = ModelIdentity> {
  model?: T;
  thinkingLevel?: PublishedThinkingLevel;
  code?: 'ambiguous' | 'no-match';
  message?: string;
}

export interface ScopedModel<T extends ModelIdentity = ModelIdentity> {
  model: T;
  thinkingLevel?: PublishedThinkingLevel;
}

export interface ModelScopeDiagnostic {
  code: 'ambiguous' | 'no-match';
  pattern: string;
  message: string;
}

export interface ModelScopeResult<T extends ModelIdentity = ModelIdentity> {
  models: ScopedModel<T>[];
  diagnostics: ModelScopeDiagnostic[];
}

export interface ModelDiscoveryOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  maxModels?: number;
}

export interface CollectModelCatalogOptions extends ModelDiscoveryOptions {
  includePublishedProviders?: boolean;
}

export interface ProtocolModelDescriptor extends Record<string, unknown> {
  provider: string;
  id: string;
  name: string;
}

/** Reject control characters and unbounded provider responses before catalogue use. */
export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function catalogEntry(
  provider: string,
  model: {
    id: string;
    name: string;
    capabilities: ModelCatalogEntry['capabilities'];
    contextWindow?: number;
    maxOutputTokens?: number;
    pricing?: ModelCatalogEntry['pricing'];
    compatibility?: ModelCatalogEntry['compatibility'];
  },
  configured: boolean,
  source: ModelCatalogSource,
  key = `${provider}:${model.id}`,
): ModelCatalogEntry {
  return {
    key,
    provider,
    id: model.id,
    name: model.name,
    available: configured,
    enabled: true,
    source,
    capabilities: { ...model.capabilities },
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
    ...(model.compatibility ? { compatibility: { ...model.compatibility } } : {}),
  };
}

/** Assemble one deterministic non-secret catalogue for CLI, RPC, and Web consumers. */
export function buildProviderModelCatalog(
  providerStates: readonly ProviderModelState[],
  customModels: readonly CustomModelDefinition[] = [],
): ProviderModelCatalog[] {
  const states = new Map<string, ProviderModelState>();
  for (const state of providerStates) {
    const provider = state.provider.trim();
    if (!provider || states.has(provider)) continue;
    states.set(provider, { ...state, provider });
  }
  for (const model of customModels) {
    if (!states.has(model.provider)) {
      states.set(model.provider, { provider: model.provider, configured: false });
    }
  }

  return [...states.values()].map(state => {
    const models = new Map<string, ModelCatalogEntry>();
    for (const published of getPublishedModels(state.provider)) {
      models.set(published.id, catalogEntry(state.provider, published, state.configured, 'published'));
    }

    if (isValidModelId(state.configuredModel) && !models.has(state.configuredModel.trim())) {
      const id = state.configuredModel.trim();
      models.set(id, catalogEntry(state.provider, {
        id,
        name: id,
        capabilities: inferModelCapabilities(state.provider, id),
      }, state.configured, 'configured'));
    }

    for (const value of state.discoveredModels ?? []) {
      if (!isValidModelId(value)) continue;
      const id = value.trim();
      const existing = models.get(id);
      models.set(id, existing
        ? { ...existing, source: 'discovered', available: state.configured }
        : catalogEntry(state.provider, {
            id,
            name: id,
            capabilities: inferModelCapabilities(state.provider, id),
          }, state.configured, 'discovered'));
    }

    for (const custom of customModels.filter(model => model.provider === state.provider)) {
      models.set(custom.id, catalogEntry(state.provider, custom, state.configured, 'custom', custom.key));
    }

    return { provider: state.provider, configured: state.configured, models: [...models.values()] };
  });
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs === 0) return operation;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Model discovery timed out.')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded provider discovery shared by the Server catalogue and CLI/RPC catalogues. */
export async function discoverProviderModelIds(
  provider: AiProvider,
  options: ModelDiscoveryOptions = {},
): Promise<string[]> {
  const timeoutMs = nonNegativeInteger(options.timeoutMs ?? 8_000, 'timeoutMs');
  const retries = nonNegativeInteger(options.retries ?? 2, 'retries');
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? 100, 'retryDelayMs');
  const maxModels = positiveInteger(options.maxModels ?? 500, 'maxModels');
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const values = await withTimeout(provider.getAvailableModels(), timeoutMs);
      const models: string[] = [];
      const seen = new Set<string>();
      for (const value of values) {
        if (!isValidModelId(value)) continue;
        const id = value.trim();
        if (seen.has(id)) continue;
        seen.add(id);
        models.push(id);
        if (models.length >= maxModels) break;
      }
      return models;
    } catch (error) {
      lastError = error;
      if (attempt < retries && retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Model discovery failed.'));
}

/** Discover configured providers and return the shared catalogue, retaining no credentials. */
export async function collectProviderModelCatalog(
  providers: ReadonlyMap<string, AiProvider>,
  options: CollectModelCatalogOptions = {},
): Promise<ProviderModelCatalog[]> {
  const states: ProviderModelState[] = await Promise.all([...providers].map(async ([providerName, provider]) => {
    let configured = false;
    try { configured = provider.validateConfig(); } catch { /* Treat invalid providers as unavailable. */ }
    let discoveredModels: string[] = [];
    if (configured) {
      try {
        discoveredModels = await discoverProviderModelIds(provider, options);
      } catch {
        // Live discovery is optional; published/configured metadata remains usable offline.
      }
    }
    return {
      provider: providerName,
      configured,
      configuredModel: provider.getConfiguredModel(),
      discoveredModels,
    } satisfies ProviderModelState;
  }));

  if (options.includePublishedProviders) {
    const known = new Set(states.map(state => state.provider.toLowerCase()));
    for (const provider of getPublishedProviders()) {
      if (!known.has(provider.toLowerCase())) states.push({ provider, configured: false, discoveredModels: [] });
    }
  }
  return buildProviderModelCatalog(states);
}

export function flattenModelCatalog(catalog: readonly ProviderModelCatalog[]): ModelCatalogEntry[] {
  return catalog.flatMap(provider => provider.models.map(model => ({
    ...model,
    capabilities: { ...model.capabilities },
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
    ...(model.compatibility ? { compatibility: { ...model.compatibility } } : {}),
  })));
}

function modelKey(model: ModelIdentity): string {
  return `${model.provider.toLowerCase()}\u0000${model.id.toLowerCase()}`;
}

function exactChoice<T extends ModelIdentity>(
  matches: T[],
  reference: string,
): ResolvedModel<T> {
  if (matches.length === 1) return { model: matches[0] };
  const available = matches.filter(model => model.available === true);
  if (available.length === 1) return { model: available[0] };
  const names = matches.map(model => `${model.provider}/${model.id}`).sort().join(', ');
  return {
    code: 'ambiguous',
    message: `Model "${reference}" is ambiguous across providers: ${names}. Use provider/model.`,
  };
}

function isAlias(id: string): boolean {
  return id.endsWith('-latest') || !/-\d{8}$/.test(id);
}

function bestPartial<T extends ModelIdentity>(matches: T[]): T | undefined {
  const available = matches.filter(model => model.available === true);
  const candidates = available.length ? available : matches;
  const aliases = candidates.filter(model => isAlias(model.id));
  return [...(aliases.length ? aliases : candidates)]
    .sort((left, right) => right.id.localeCompare(left.id))[0];
}

function resolvePlainModel<T extends ModelIdentity>(
  rawReference: string,
  models: readonly T[],
  explicitProvider?: string,
): ResolvedModel<T> {
  let reference = rawReference.trim();
  const providerNames = new Map<string, string>();
  for (const model of models) providerNames.set(model.provider.toLowerCase(), model.provider);

  let provider = explicitProvider ? providerNames.get(explicitProvider.toLowerCase()) ?? explicitProvider : undefined;
  let inferredProvider = false;
  if (provider) {
    const prefix = `${provider}/`;
    if (reference.toLowerCase().startsWith(prefix.toLowerCase())) reference = reference.slice(prefix.length);
  } else {
    const canonical = models.filter(model => `${model.provider}/${model.id}`.toLowerCase() === reference.toLowerCase());
    if (canonical.length) {
      const choice = exactChoice(canonical, rawReference);
      if (choice.model?.available === false) {
        const rawAvailable = models.filter(model => model.id.toLowerCase() === reference.toLowerCase() && model.available === true);
        if (rawAvailable.length === 1) return { model: rawAvailable[0] };
      }
      return choice;
    }
    const slash = reference.indexOf('/');
    if (slash > 0) {
      const inferred = providerNames.get(reference.slice(0, slash).toLowerCase());
      if (inferred) {
        provider = inferred;
        reference = reference.slice(slash + 1);
        inferredProvider = true;
      }
    }
  }

  const candidates = provider
    ? models.filter(model => model.provider.toLowerCase() === provider!.toLowerCase())
    : [...models];
  const normalized = reference.toLowerCase();
  const exactIds = candidates.filter(model => model.id.toLowerCase() === normalized);
  if (exactIds.length) return exactChoice(exactIds, rawReference);
  const exactNames = candidates.filter(model => (model.name ?? model.id).toLowerCase() === normalized);
  if (exactNames.length) return exactChoice(exactNames, rawReference);

  const partial = candidates.filter(model => (
    model.id.toLowerCase().includes(normalized)
    || (model.name ?? '').toLowerCase().includes(normalized)
  ));
  const model = bestPartial(partial);
  if (model) return { model };

  if (inferredProvider) {
    const rawNormalized = rawReference.toLowerCase();
    const rawExact = models.filter(candidate => candidate.id.toLowerCase() === rawNormalized);
    if (rawExact.length) return exactChoice(rawExact, rawReference);
    const rawPartial = models.filter(candidate => (
      candidate.id.toLowerCase().includes(rawNormalized)
      || (candidate.name ?? '').toLowerCase().includes(rawNormalized)
    ));
    const fallback = bestPartial(rawPartial);
    if (fallback) return { model: fallback };
  }
  return { code: 'no-match', message: `Model "${rawReference}" not found.` };
}

/** Resolve exact, provider-qualified, fuzzy, and optional :thinking model references. */
export function resolveModelReference<T extends ModelIdentity>(
  reference: string,
  models: readonly T[],
  options: { provider?: string } = {},
): ResolvedModel<T> {
  const trimmed = reference.trim();
  if (!trimmed) return { code: 'no-match', message: 'Model reference cannot be empty.' };
  if (trimmed.length > 500) return { code: 'no-match', message: 'Model reference exceeds 500 characters.' };

  const whole = resolvePlainModel(trimmed, models, options.provider);
  if (whole.model || whole.code === 'ambiguous') return whole;

  const separator = trimmed.lastIndexOf(':');
  if (separator > 0) {
    const suffix = trimmed.slice(separator + 1).toLowerCase() as PublishedThinkingLevel;
    if (PUBLISHED_THINKING_LEVELS.includes(suffix)) {
      const withoutThinking = resolvePlainModel(trimmed.slice(0, separator), models, options.provider);
      return withoutThinking.model
        ? { model: withoutThinking.model, thinkingLevel: suffix }
        : withoutThinking;
    }
  }
  return whole;
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  const escape = (character: string): string => /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      const body = end === -1 ? '' : pattern.slice(index + 1, end);
      if (!body) expression += '\\[';
      else {
        const negated = body.startsWith('!') ? '^' : '';
        const content = (negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&');
        expression += `[${negated}${content}]`;
        index = end;
      }
    } else expression += escape(character);
  }
  try {
    return new RegExp(`${expression}$`, 'i');
  } catch {
    return new RegExp(`^${[...pattern].map(escape).join('')}$`, 'i');
  }
}

function splitGlobThinking(pattern: string): { pattern: string; thinkingLevel?: PublishedThinkingLevel } {
  const separator = pattern.lastIndexOf(':');
  if (separator <= 0) return { pattern };
  const suffix = pattern.slice(separator + 1).toLowerCase() as PublishedThinkingLevel;
  return PUBLISHED_THINKING_LEVELS.includes(suffix)
    ? { pattern: pattern.slice(0, separator), thinkingLevel: suffix }
    : { pattern };
}

/** Resolve ordered, deduplicated model scopes for startup and cycling. */
export function resolveModelScope<T extends ModelIdentity>(
  patterns: readonly string[],
  availableModels: readonly T[],
): ModelScopeResult<T> {
  const models: ScopedModel<T>[] = [];
  const diagnostics: ModelScopeDiagnostic[] = [];
  const seen = new Set<string>();

  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim();
    if (!trimmed) continue;
    if (trimmed.length > 500) {
      diagnostics.push({ code: 'no-match', pattern: trimmed, message: 'Model pattern exceeds 500 characters.' });
      continue;
    }
    const hasGlob = /[*?[\]]/.test(trimmed);
    if (hasGlob) {
      const parsed = splitGlobThinking(trimmed);
      const expression = globExpression(parsed.pattern);
      const matches = availableModels.filter(model => [
        `${model.provider}/${model.id}`,
        model.id,
        `${model.provider}/${model.name ?? model.id}`,
        model.name ?? model.id,
      ].some(value => expression.test(value)));
      if (!matches.length) {
        diagnostics.push({ code: 'no-match', pattern: trimmed, message: `No models match pattern "${trimmed}".` });
      }
      for (const model of matches) {
        const key = modelKey(model);
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({ model, thinkingLevel: parsed.thinkingLevel });
      }
      continue;
    }

    const resolved = resolveModelReference(trimmed, availableModels);
    if (!resolved.model) {
      diagnostics.push({
        code: resolved.code ?? 'no-match',
        pattern: trimmed,
        message: resolved.message ?? `No models match pattern "${trimmed}".`,
      });
      continue;
    }
    const key = modelKey(resolved.model);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ model: resolved.model, thinkingLevel: resolved.thinkingLevel });
  }
  return { models, diagnostics };
}

function fuzzyScore(query: string, text: string): number | undefined {
  const normalizedText = text.toLowerCase();
  const scoreQuery = (normalizedQuery: string): number | undefined => {
    if (!normalizedQuery) return 0;
    if (normalizedQuery.length > normalizedText.length) return undefined;
    let queryIndex = 0;
    let lastMatch = -1;
    let consecutive = 0;
    let score = 0;
    while (queryIndex < normalizedQuery.length) {
      const index = normalizedText.indexOf(normalizedQuery[queryIndex]!, lastMatch + 1);
      if (index === -1) return undefined;
      if (lastMatch === index - 1) {
        consecutive++;
        score -= consecutive * 5;
      } else {
        consecutive = 0;
        if (lastMatch >= 0) score += (index - lastMatch - 1) * 2;
      }
      if (index === 0 || /[\s\-_./:]/.test(normalizedText[index - 1]!)) score -= 10;
      score += index * 0.1;
      lastMatch = index;
      queryIndex++;
    }
    if (normalizedQuery === normalizedText) score -= 100;
    return score;
  };

  const normalizedQuery = query.toLowerCase();
  const direct = scoreQuery(normalizedQuery);
  if (direct !== undefined) return direct;
  const alphaNumeric = normalizedQuery.match(/^([a-z]+)([0-9]+)$/);
  const numericAlpha = normalizedQuery.match(/^([0-9]+)([a-z]+)$/);
  const swapped = alphaNumeric ? `${alphaNumeric[2]}${alphaNumeric[1]}`
    : numericAlpha ? `${numericAlpha[2]}${numericAlpha[1]}` : undefined;
  const swappedScore = swapped ? scoreQuery(swapped) : undefined;
  return swappedScore === undefined ? undefined : swappedScore + 5;
}

/** Deterministic Pi-compatible subsequence filtering used by --list-models. */
export function filterModels<T extends ModelIdentity>(models: readonly T[], search?: string): T[] {
  const terms = search?.trim().split(/[\s/]+/).filter(Boolean) ?? [];
  if (!terms.length) return [...models];
  const scored = models.flatMap(model => {
    const haystack = `${model.provider} ${model.id} ${model.name ?? ''}`;
    let score = 0;
    for (const term of terms) {
      const termScore = fuzzyScore(term, haystack);
      if (termScore === undefined) return [];
      score += termScore;
    }
    return [{ model, score }];
  });
  return scored.sort((left, right) => left.score - right.score
    || left.model.provider.localeCompare(right.model.provider)
    || left.model.id.localeCompare(right.model.id)).map(item => item.model);
}

/** Convert shared catalogue metadata to Pi-shaped RPC model metadata. */
export function toProtocolModelDescriptor(
  model: Pick<ModelCatalogEntry, 'provider' | 'id' | 'name' | 'capabilities' | 'contextWindow' | 'maxOutputTokens' | 'pricing'>,
): ProtocolModelDescriptor {
  const standardBaseUrl = model.provider === 'openai' ? 'https://api.openai.com/v1'
    : model.provider === 'anthropic' ? 'https://api.anthropic.com'
      : model.provider === 'google' ? 'https://generativelanguage.googleapis.com/v1beta'
        : undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.provider === 'anthropic' ? 'anthropic-messages'
      : model.provider === 'google' || model.provider === 'vertex' ? 'google-generative-ai'
        : 'openai-completions',
    ...(standardBaseUrl ? { baseUrl: standardBaseUrl } : {}),
    reasoning: model.capabilities.reasoning,
    input: model.capabilities.imageInput ? ['text', 'image'] : ['text'],
    ...(model.pricing ? {
      cost: {
        ...(model.pricing.inputPerMillion === undefined ? {} : { input: model.pricing.inputPerMillion }),
        ...(model.pricing.outputPerMillion === undefined ? {} : { output: model.pricing.outputPerMillion }),
        ...(model.pricing.cacheReadPerMillion === undefined ? {} : { cacheRead: model.pricing.cacheReadPerMillion }),
        ...(model.pricing.cacheWritePerMillion === undefined ? {} : { cacheWrite: model.pricing.cacheWritePerMillion }),
      },
    } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens }),
  };
}

export function createProtocolModelDescriptor(provider: string, id: string): ProtocolModelDescriptor {
  const published = getPublishedModelMetadata(provider, id);
  return toProtocolModelDescriptor({
    provider,
    id,
    name: published?.name ?? id,
    capabilities: published?.capabilities ?? inferModelCapabilities(provider, id),
    ...(published?.contextWindow === undefined ? {} : { contextWindow: published.contextWindow }),
    ...(published?.maxOutputTokens === undefined ? {} : { maxOutputTokens: published.maxOutputTokens }),
    ...(published?.pricing ? { pricing: published.pricing } : {}),
  });
}
