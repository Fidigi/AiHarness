import type { ModelPricing } from '../types/index.js';
import type { PublishedThinkingLevel } from './model-metadata.js';

export interface CloudflareChatProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly compat: Readonly<{ supportsStore: false; supportsDeveloperRole: false; supportsStrictMode: true;
    supportsLongCacheRetention: false; sendSessionAffinityHeaders: true; thinkingFormat?: 'deepseek'; requiresReasoningContentOnAssistantMessages?: true }>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}

// Reviewed cloudflare-workers-ai.json C projection, not account access or an effective resizer.
const rows: readonly (Omit<CloudflareChatProfile, 'api' | 'compat' | 'declaredInputLimits'> & { deepseek?: true })[] = [
  { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731', contextWindow: 1048576, maxOutputTokens: 1048576, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 0.44, outputPerMillion: 1.32, cacheReadPerMillion: 0.014, cacheWritePerMillion: 0 }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' }, deepseek: true },
  { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro 0813', contextWindow: 1048576, maxOutputTokens: 1048576, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 1.32, outputPerMillion: 3.96, cacheReadPerMillion: 0.044, cacheWritePerMillion: 0 }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' }, deepseek: true },
  { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', contextWindow: 256000, maxOutputTokens: 16384, reasoning: true, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.1, outputPerMillion: 0.3, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
  { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0 H Micro', contextWindow: 131000, maxOutputTokens: 131000, reasoning: false, declaredInput: ['text'], pricing: { inputPerMillion: 0.017, outputPerMillion: 0.112, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct fp8 Fast', contextWindow: 24000, maxOutputTokens: 24000, reasoning: false, declaredInput: ['text'], pricing: { inputPerMillion: 0.293, outputPerMillion: 2.253, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B 16E Instruct', contextWindow: 131000, maxOutputTokens: 16384, reasoning: false, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.27, outputPerMillion: 0.85, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B Instruct', contextWindow: 128000, maxOutputTokens: 128000, reasoning: false, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.351, outputPerMillion: 0.555, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262144, maxOutputTokens: 256000, reasoning: true, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } },
  { id: '@cf/moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262144, maxOutputTokens: 262144, reasoning: true, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.19, cacheWritePerMillion: 0 } },
  { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron 3 Super 120B', contextWindow: 256000, maxOutputTokens: 256000, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  { id: '@cf/openai/gpt-oss-120b', name: 'GPT OSS 120B', contextWindow: 128000, maxOutputTokens: 16384, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 0.35, outputPerMillion: 0.75, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT OSS 20B', contextWindow: 128000, maxOutputTokens: 16384, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 0.2, outputPerMillion: 0.3, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen3 30B A3b fp8', contextWindow: 32768, maxOutputTokens: 32768, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 0.0509, outputPerMillion: 0.335, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen3.8 27B', contextWindow: 262144, maxOutputTokens: 262144, reasoning: true, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.45, outputPerMillion: 3.2, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null } },
  { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM-4.7-Flash', contextWindow: 131072, maxOutputTokens: 131072, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 0.0605, outputPerMillion: 0.4, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: '@cf/zai-org/glm-5.2', name: 'Glm 5.2', contextWindow: 262144, maxOutputTokens: 256000, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } },
  { id: '@cf/zai-org/glm-5.3', name: 'Glm 5.3', contextWindow: 1048576, maxOutputTokens: 1048576, reasoning: true, declaredInput: ['text'], pricing: { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
  { id: '@cf/zai-org/glm-5.3-flash', name: 'Glm 5.3 Flash', contextWindow: 1048576, maxOutputTokens: 1048576, reasoning: true, declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0 }, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
];
const declaredInputLimits = Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) });
export const CLOUDFLARE_CHAT_MODELS: readonly CloudflareChatProfile[] = Object.freeze(rows.map(({ deepseek, ...row }) => Object.freeze({
  ...row, api: 'openai-completions' as const, declaredInput: Object.freeze([...row.declaredInput]), pricing: Object.freeze({ ...row.pricing }),
  ...(row.thinkingLevelMap ? { thinkingLevelMap: Object.freeze({ ...row.thinkingLevelMap }) } : {}),
  compat: Object.freeze({ supportsStore: false as const, supportsDeveloperRole: false as const, supportsStrictMode: true as const,
    supportsLongCacheRetention: false as const, sendSessionAffinityHeaders: true as const,
    ...(deepseek ? { thinkingFormat: 'deepseek' as const, requiresReasoningContentOnAssistantMessages: true as const } : {}) }),
  ...(row.declaredInput.includes('image') ? { declaredInputLimits } : {}),
})));
