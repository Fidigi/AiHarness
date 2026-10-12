import type { ModelCapabilities, ModelPricing } from '../types/index.js';

export type PublishedThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const PUBLISHED_THINKING_LEVELS: readonly PublishedThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];
const STANDARD_REASONING_LEVELS: readonly PublishedThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high',
];

export interface PublishedModelMetadata {
  id: string;
  name: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  /** Per-level overrides; a null map explicitly marks thinking as unsupported. */
  thinkingLevelMap?: Partial<Record<PublishedThinkingLevel, string | null>> | null;
}

export interface PricedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const TEXT_TOOLS: ModelCapabilities = { reasoning: false, imageInput: false, toolCalls: true };
const VISION_TOOLS: ModelCapabilities = { reasoning: false, imageInput: true, toolCalls: true };
const REASONING_VISION_TOOLS: ModelCapabilities = { reasoning: true, imageInput: true, toolCalls: true };

/** Versioned non-secret metadata shared by CLI and Web catalogues. */
export const PUBLISHED_MODEL_METADATA_VERSION = 3 as const;

const PUBLISHED_MODELS: Readonly<Record<string, readonly PublishedModelMetadata[]>> = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', capabilities: VISION_TOOLS, contextWindow: 128_000, maxOutputTokens: 16_384, pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 }, thinkingLevelMap: null },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 10, outputPerMillion: 30 } },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', capabilities: TEXT_TOOLS, pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5 } },
    { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 } },
    { id: 'o3', name: 'o3', capabilities: REASONING_VISION_TOOLS, contextWindow: 200_000, maxOutputTokens: 100_000, pricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
    { id: 'o4-mini', name: 'o4-mini', capabilities: REASONING_VISION_TOOLS, contextWindow: 200_000, maxOutputTokens: 100_000, pricing: { inputPerMillion: 1.1, outputPerMillion: 4.4, cacheReadPerMillion: 0.275 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  ],
  anthropic: [
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 15, outputPerMillion: 75 } },
    { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
    { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 } },
    { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet', capabilities: REASONING_VISION_TOOLS, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 } },
    { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', capabilities: VISION_TOOLS, pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1 } },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', capabilities: REASONING_VISION_TOOLS, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }, thinkingLevelMap: { max: 'max' } },
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

function cloneMetadata(model: PublishedModelMetadata): PublishedModelMetadata {
  return {
    ...model,
    capabilities: { ...model.capabilities },
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: model.thinkingLevelMap === null ? null : { ...model.thinkingLevelMap } }),
  };
}

export function getPublishedProviders(): string[] {
  return Object.keys(PUBLISHED_MODELS);
}

export function getPublishedModels(provider: string): PublishedModelMetadata[] {
  return (PUBLISHED_MODELS[provider] ?? []).map(cloneMetadata);
}

export function getPublishedModelMetadata(provider: string, id: string): PublishedModelMetadata | undefined {
  const model = PUBLISHED_MODELS[provider]?.find(candidate => candidate.id === id);
  return model ? cloneMetadata(model) : undefined;
}

/** Calculate a cost only when versioned pricing exists; unknown models remain unpriced. */
export function calculatePublishedModelCost(
  provider: string,
  id: string,
  usage: PricedTokenUsage,
): number | undefined {
  const pricing = PUBLISHED_MODELS[provider]?.find(candidate => candidate.id === id)?.pricing;
  if (!pricing) return undefined;
  const tokens = (value: number | undefined): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  );
  return (
    tokens(usage.inputTokens) * (pricing.inputPerMillion ?? 0)
    + tokens(usage.outputTokens) * (pricing.outputPerMillion ?? 0)
    + tokens(usage.cacheReadTokens) * (pricing.cacheReadPerMillion ?? 0)
    + tokens(usage.cacheWriteTokens) * (pricing.cacheWritePerMillion ?? 0)
  ) / 1_000_000;
}

export function getSupportedThinkingLevels(
  provider: string,
  model: string | undefined,
): PublishedThinkingLevel[] {
  if (!model) return [...PUBLISHED_THINKING_LEVELS];
  const metadata = getPublishedModelMetadata(provider, model);
  if (metadata?.thinkingLevelMap === null) return ['off'];
  const capabilities = metadata?.capabilities ?? inferModelCapabilities(provider, model);
  const levels = new Set<PublishedThinkingLevel>(capabilities.reasoning ? STANDARD_REASONING_LEVELS : ['off']);
  for (const level of PUBLISHED_THINKING_LEVELS) {
    const mapped = metadata?.thinkingLevelMap?.[level];
    if (mapped === null) levels.delete(level);
    else if (mapped !== undefined) levels.add(level);
  }
  const ordered = PUBLISHED_THINKING_LEVELS.filter(level => levels.has(level));
  return ordered.length > 0 ? ordered : ['off'];
}

/** Clamp by searching upward from the request first, then downward. */
export function clampPublishedThinkingLevel(
  level: PublishedThinkingLevel,
  available: readonly PublishedThinkingLevel[],
): PublishedThinkingLevel {
  if (available.includes(level)) return level;
  const requestedIndex = PUBLISHED_THINKING_LEVELS.indexOf(level);
  for (let index = requestedIndex; index < PUBLISHED_THINKING_LEVELS.length; index++) {
    if (available.includes(PUBLISHED_THINKING_LEVELS[index]!)) return PUBLISHED_THINKING_LEVELS[index]!;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    if (available.includes(PUBLISHED_THINKING_LEVELS[index]!)) return PUBLISHED_THINKING_LEVELS[index]!;
  }
  return 'off';
}

/** Conservative capabilities for configured or discovered models absent from the published table. */
export function inferModelCapabilities(provider: string, model: string): ModelCapabilities {
  const normalized = model.toLowerCase();
  const reasoning = /(?:^|[-_.])(o[134]|r1|reason(?:ing)?|thinking)(?:$|[-_.])/.test(normalized)
    || normalized.includes('gemini-2.5-pro')
    || normalized.includes('claude-3-7');
  const imageInput = ['openai', 'anthropic', 'google', 'azure', 'vertex'].includes(provider)
    || /vision|llava|vl(?:-|$)/.test(normalized);
  const toolCalls = provider !== 'local' || /tool|function|qwen|llama3|mistral/.test(normalized);
  return { reasoning, imageInput, toolCalls };
}
