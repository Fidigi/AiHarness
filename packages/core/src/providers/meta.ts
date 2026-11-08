import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';

export interface MetaProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-responses';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly declaredPricing: Readonly<Required<ModelPricing>>;
  readonly pricing?: Readonly<Required<ModelPricing>>;
  readonly declaredInputLimits: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
const declarations = [
  { id: 'muse-spark-1.1', name: 'Muse Spark 1.1', input: 1.25, output: 4.25, read: 0.15, max: null },
  { id: 'muse-spark-1.2', name: 'Muse Spark 1.2', input: 1.25, output: 4.25, read: 0.15, max: null },
  { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor', input: 0.1, output: 0.2, read: 0.002, max: null },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', input: 1.25, output: 4.25, read: 0.15, max: 'max' },
  { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor', input: 0.1, output: 0.2, read: 0.002, max: null },
  { id: 'muse-wonder-1.0', name: 'Muse Wonder', input: 0, output: 0, read: 0, max: 'max' },
] as const;
export const META_MODELS: readonly MetaProfile[] = Object.freeze(declarations.map(row => {
  const declaredPricing = Object.freeze({ inputPerMillion: row.input, outputPerMillion: row.output, cacheReadPerMillion: row.read, cacheWritePerMillion: 0 });
  return Object.freeze({ id: row.id, name: row.name, api: 'openai-responses' as const, contextWindow: 1048576, maxOutputTokens: 131072, reasoning: true as const,
    declaredInput: Object.freeze(['text', 'image'] as const),
    thinkingLevelMap: Object.freeze({ off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: row.max }),
    declaredPricing, ...(row.input || row.output || row.read ? { pricing: declaredPricing } : {}),
    declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) }),
  });
}));
const profiles = new Map(META_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function metaProfile(model: string): MetaProfile { const profile = profiles.get(model); if (!profile) throw new Error('Meta response model is not supported.'); return profile; }
export function metaBase(value: string | undefined): string {
  try {
    const url = new URL(value ?? 'https://api.meta.ai/v1');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/responses$/u, '') || '/';
    return url.href.replace(/\/+$/u, '');
  } catch { throw new Error('Invalid Meta endpoint.'); }
}
export function prepareMetaResponse(body: Record<string, unknown>, options?: ChatOptions): void {
  const profile = metaProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Meta thinking level.');
  const selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
  body.reasoning = { effort: profile.thinkingLevelMap[selected], summary: 'auto' }; body.include = ['reasoning.encrypted_content'];
  if (Array.isArray(body.input)) {
    for (const item of body.input) if (record(item) && item.role === 'system') item.role = 'developer';
    if (typeof body.instructions === 'string') { body.input.unshift({ role: 'developer', content: body.instructions }); delete body.instructions; }
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool)) tool.strict = false;
  if (options?.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid Meta output limit.');
    body.max_output_tokens = Math.max(16, options.maxTokens);
  }
  if (options?.cacheRetention !== 'none' && options?.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
  if (options?.cacheRetention === 'long') body.prompt_cache_retention = '24h'; else delete body.prompt_cache_retention;
  delete body.prompt_cache_options;
}
/** Meta preserves exact-owner composite IDs but normalizes the whole foreign ID, unlike original OpenAI. */
export function applyMetaToolHistory(body: Record<string, unknown>, messages: Message[], provider: string, model: string): void {
  if (!Array.isArray(body.input)) return;
  const ids = new Map<string, { callId: string; itemId?: string }>();
  for (const message of messages) if (message.role === 'assistant') for (const call of [
    ...(message.toolCalls ?? []), ...(message.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []) ?? []),
  ]) {
    const same = message.provider === provider && message.api === 'openai-responses' && message.model === model;
    const [callId, itemId] = same ? call.id.split('|') : [call.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64).replace(/_+$/, '')];
    ids.set(call.id, { callId, ...(itemId?.startsWith('fc_') ? { itemId } : {}) });
  }
  for (const item of body.input) {
    if (!record(item) || typeof item.call_id !== 'string' || !['function_call', 'function_call_output'].includes(String(item.type))) continue;
    const id = ids.get(item.call_id); if (!id) continue;
    item.call_id = id.callId;
    if (item.type === 'function_call') { if (id.itemId) item.id = id.itemId; else delete item.id; }
    else if (item.output === '') item.output = '(no tool output)';
  }
}
/** Native primary input includes its cache counters; zero-only price declarations do not establish free requests. */
export function metaUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const gross = token(value.input_tokens), output = token(value.output_tokens);
  if (gross === undefined || output === undefined || !Number.isSafeInteger(gross + output)) return undefined;
  if (value.input_tokens_details !== undefined && !record(value.input_tokens_details)) return undefined;
  const details = record(value.input_tokens_details) ? value.input_tokens_details : {}, read = token(details.cached_tokens), write = token(details.cache_write_tokens);
  if ((details.cached_tokens !== undefined && read === undefined) || (details.cache_write_tokens !== undefined && write === undefined) || (read ?? 0) + (write ?? 0) > gross) return undefined;
  const input = gross - (read ?? 0) - (write ?? 0), pricing = metaProfile(model).pricing;
  return { promptTokens: input, completionTokens: output, totalTokens: gross + output,
    ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }),
    ...(pricing ? { costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + (read ?? 0) * pricing.cacheReadPerMillion + (write ?? 0) * pricing.cacheWritePerMillion) / 1000000 } : {}) };
}
