import type { ModelCapabilities } from '../types/index.js';
import type { AiProvider } from './index.js';
import { getDeclaredProviderPublishedModel } from './provider-model-metadata.js';
import { getPublishedModelMetadata, PUBLISHED_THINKING_LEVELS, type PublishedThinkingLevel } from './published-models.js';

// Preserve the existing module/root contracts while declarations remain a lower-level leaf.
export {
  PUBLISHED_MODEL_METADATA_VERSION,
  PUBLISHED_THINKING_LEVELS,
  getPublishedProviders,
  getPublishedModels,
  getPublishedModelMetadata,
  calculatePublishedModelCost,
  calculateModelCost,
  type PublishedThinkingLevel,
  type PublishedModelMetadata,
  type PricedTokenUsage,
} from './published-models.js';

const STANDARD_REASONING_LEVELS: readonly PublishedThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high',
];

export function getSupportedThinkingLevels(
  provider: string,
  model: string | undefined,
  virtualModels?: { get(provider: string, id: string | undefined): { thinkingLevels?: readonly PublishedThinkingLevel[] } | undefined },
  source?: Pick<AiProvider, 'getPublishedModels' | 'getModelApi'>,
): PublishedThinkingLevel[] {
  const virtual = virtualModels?.get(provider, model);
  if (virtual) return [...virtual.thinkingLevels ?? ['off']];
  if (!model) return [...PUBLISHED_THINKING_LEVELS];
  const declared = source ? getDeclaredProviderPublishedModel(source, model) : undefined;
  const metadata = declared === undefined ? getPublishedModelMetadata(provider, model) : declared.find(row => row.id === model);
  if (declared !== undefined && !metadata) return ['off'];
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
