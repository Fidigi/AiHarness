import type { ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';

interface XaiTier extends Readonly<Required<ModelPricing>> { readonly inputTokensAbove: number }
export interface XaiProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-responses';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly pricingTiers: readonly XaiTier[];
  readonly declaredInputLimits: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
const declarations = [
  { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 1000000, maxOutputTokens: 30000, off: 'none', xhigh: null, input: 1.25, output: 2.5, read: 0.2 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 500000, maxOutputTokens: 500000, off: null, xhigh: null, input: 2, output: 6, read: 0.3 },
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500000, maxOutputTokens: 500000, off: null, xhigh: 'xhigh', input: 2, output: 6, read: 0.5 },
  { id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 500000, maxOutputTokens: 500000, off: null, xhigh: 'xhigh', input: 2, output: 6, read: 0.5 },
] as const;
export const XAI_MODELS: readonly XaiProfile[] = Object.freeze(declarations.map(row => Object.freeze({
  id: row.id, name: row.name, api: 'openai-responses' as const, contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens, reasoning: true as const,
  declaredInput: Object.freeze(['text', 'image'] as const),
  thinkingLevelMap: Object.freeze({ off: row.off, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: row.xhigh, max: null }),
  pricing: Object.freeze({ inputPerMillion: row.input, outputPerMillion: row.output, cacheReadPerMillion: row.read, cacheWritePerMillion: 0 }),
  pricingTiers: Object.freeze([Object.freeze({ inputTokensAbove: 200000, inputPerMillion: row.input * 2, outputPerMillion: row.output * 2, cacheReadPerMillion: row.read * 2, cacheWritePerMillion: 0 })]),
  declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) }),
})));
const profiles = new Map(XAI_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function xaiProfile(model: string): XaiProfile { const profile = profiles.get(model); if (!profile) throw new Error('xAI response model is not supported.'); return profile; }
export function xaiBase(value: string | undefined): string {
  try {
    const url = new URL(value ?? 'https://api.x.ai/v1');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/responses$/u, '') || '/';
    return url.href.replace(/\/+$/u, '');
  } catch { throw new Error('Invalid xAI endpoint.'); }
}
export function prepareXaiResponse(body: Record<string, unknown>, options?: ChatOptions): void {
  const profile = xaiProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid xAI thinking level.');
  const selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
  body.reasoning = { effort: profile.thinkingLevelMap[selected], ...(selected === 'off' ? {} : { summary: 'auto' }) };
  body.include = ['reasoning.encrypted_content'];
  if (Array.isArray(body.input)) {
    for (const item of body.input) if (record(item) && item.role === 'system') item.role = 'developer';
    if (typeof body.instructions === 'string') { body.input.unshift({ role: 'developer', content: body.instructions }); delete body.instructions; }
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool)) tool.strict = false;
  if (options?.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid xAI output limit.');
    body.max_output_tokens = Math.max(16, options.maxTokens);
  }
  if (options?.cacheRetention !== 'none' && options?.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
  delete body.prompt_cache_retention; delete body.prompt_cache_options;
}
/** Native primary input is inclusive; canonical prompt excludes its disjoint read/write counters. */
export function xaiUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const gross = token(value.input_tokens), output = token(value.output_tokens);
  if (gross === undefined || output === undefined || !Number.isSafeInteger(gross + output)) return undefined;
  if (value.input_tokens_details !== undefined && !record(value.input_tokens_details)) return undefined;
  const details = record(value.input_tokens_details) ? value.input_tokens_details : {}, read = token(details.cached_tokens), write = token(details.cache_write_tokens);
  if ((details.cached_tokens !== undefined && read === undefined) || (details.cache_write_tokens !== undefined && write === undefined) || (read ?? 0) + (write ?? 0) > gross) return undefined;
  const input = gross - (read ?? 0) - (write ?? 0), profile = xaiProfile(model);
  let pricing: Readonly<Required<ModelPricing>> = profile.pricing;
  for (const tier of profile.pricingTiers) if (gross > tier.inputTokensAbove) pricing = tier;
  return { promptTokens: input, completionTokens: output, totalTokens: gross + output,
    ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }),
    costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + (read ?? 0) * pricing.cacheReadPerMillion + (write ?? 0) * pricing.cacheWritePerMillion) / 1000000 };
}
