import type { ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, PUBLISHED_THINKING_LEVELS, type PublishedThinkingLevel } from './model-metadata.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';

export interface KimiCodingProfile {
  readonly id: string; readonly name: string; readonly api: 'anthropic-messages';
  readonly contextWindow: number; readonly maxOutputTokens: number; readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly declaredPricing: Readonly<Required<ModelPricing>>; readonly pricing?: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly allowEmptySignature: boolean;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
const sparse = Object.freeze({ off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
const images = Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) });
const rows = [
  { id: 'k3', name: 'Kimi K3', contextWindow: 1048576, maxOutputTokens: 131072, thinkingLevelMap: sparse, allowEmptySignature: true,
    declaredPricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 } },
  { id: 'k3-256k', name: 'Kimi K3-256K', contextWindow: 262144, maxOutputTokens: 131072, thinkingLevelMap: sparse, allowEmptySignature: false,
    declaredPricing: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: 'kimi-for-coding', name: 'kimi-for-coding', contextWindow: 1048576, maxOutputTokens: 32768, thinkingLevelMap: sparse, allowEmptySignature: true,
    declaredPricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.19, cacheWritePerMillion: 0 } },
  { id: 'kimi-for-coding-highspeed', name: 'Kimi For Coding HighSpeed', contextWindow: 262144, maxOutputTokens: 32768, allowEmptySignature: false,
    declaredPricing: { inputPerMillion: 1.9, outputPerMillion: 8, cacheReadPerMillion: 0.38, cacheWritePerMillion: 0 } },
];
/** Pinned API-key A declarations;zero-only prices are unknown and resize remains declarative. */
export const KIMI_CODING_MODELS: readonly KimiCodingProfile[] = Object.freeze(rows.map(row => {
  const pricing = Object.freeze({ ...row.declaredPricing });
  return Object.freeze({ ...row, api: 'anthropic-messages' as const, reasoning: true as const,
    declaredInput: Object.freeze(['text', 'image'] as const), declaredInputLimits: images, declaredPricing: pricing,
    ...(Object.values(pricing).some(value => value > 0) ? { pricing } : {}) });
}));
const profiles = new Map(KIMI_CODING_MODELS.map(profile => [profile.id, profile]));
const ordinary: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function kimiCodingProfile(model: string): KimiCodingProfile {
  const profile = profiles.get(model); if (!profile) throw new Error('Kimi Coding chat model is not supported.'); return profile;
}
export function kimiCodingEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    const path = url.pathname.replace(/\/+$/u, ''); url.pathname = path.endsWith('/messages') ? path : /\/v\d+$/u.test(path) ? path + '/messages' : path + '/v1/messages'; return url.href;
  } catch { throw new Error('Invalid Kimi Coding endpoint.'); }
}
export function kimiCodingThinking(model: string, options?: ChatOptions): PublishedThinkingLevel {
  const requested = options?.thinking ?? 'off'; if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Kimi Coding thinking level.');
  const map = kimiCodingProfile(model).thinkingLevelMap, levels = map ? PUBLISHED_THINKING_LEVELS.filter(level => map[level] !== null) : ordinary;
  return clampPublishedThinkingLevel(requested, levels);
}
function outputLimit(model: string, options?: ChatOptions): number {
  const profile = kimiCodingProfile(model), maximum = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > profile.maxOutputTokens) throw new Error('Invalid Kimi Coding output limit.'); return maximum;
}
export function prepareKimiCodingOutputBudget(owned: ChatOptions, configuredModel: string): Readonly<PreparedNativeOutputBudget> {
  const options: ChatOptions = { ...owned, model: owned.model || configuredModel };
  try { const maxTokens = outputLimit(options.model!, options); kimiCodingThinking(options.model!, options); options.maxTokens = maxTokens; return Object.freeze({ options, maxTokens }); }
  catch { throw new ProviderOutputBudgetError(); }
}
export function prepareKimiCodingMessage(body: Record<string, unknown>, options?: ChatOptions): Record<string, unknown> {
  const model = String(body.model), profile = kimiCodingProfile(model), selected = kimiCodingThinking(model, options);
  body.max_tokens = outputLimit(model, options); delete body.output_config;
  for (const key of ['reasoning_effort', 'reasoning', 'store', 'max_completion_tokens', 'prompt_cache_key', 'prompt_cache_retention', 'tool_stream']) delete body[key];
  if (selected === 'off') body.thinking = { type: 'disabled' };
  else { body.thinking = { type: 'adaptive', display: 'summarized' }; body.output_config = { effort: profile.thinkingLevelMap?.[selected] ?? (selected === 'minimal' ? 'low' : selected) }; delete body.temperature; }
  const control = options?.cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(options?.cacheRetention === 'long' ? { ttl: '1h' } : {}) };
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system, ...(control ? { cache_control: control } : {}) }];
  if (Array.isArray(body.tools)) body.tools = body.tools.map((tool: Record<string, unknown>, index: number) => {
    const result = { ...tool, eager_input_streaming: true }; delete (result as Record<string, unknown>).strict; delete (result as Record<string, unknown>).cache_control;
    return { ...result, ...(control && index === (body.tools as unknown[]).length - 1 ? { cache_control: control } : {}) };
  });
  if (Array.isArray(body.messages)) {
    const messages = body.messages as Array<Record<string, unknown>>;
    for (const message of messages) if (Array.isArray(message.content)) message.content = message.content.map((block: Record<string, unknown>) => {
      const result = { ...block }; delete result.cache_control;
      return result.type === 'thinking' && result.signature === '' && !profile.allowEmptySignature ? { type: 'text', text: result.thinking } : result;
    });
    if (control) for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user' || messages[index].role === 'system') {
      const message = messages[index];
      if (typeof message.content === 'string' && message.content) message.content = [{ type: 'text', text: message.content, cache_control: control }];
      else if (Array.isArray(message.content) && message.content.length) message.content = message.content.map((block: Record<string, unknown>, position: number) => position === (message.content as unknown[]).length - 1 ? { ...block, cache_control: control } : block);
      break;
    }
  }
  return body;
}
export function mergeKimiCodingUsage(previous: unknown, value: unknown, start: boolean): unknown {
  if (!record(value)) return previous;
  const merged: Record<string, unknown> = start ? { ...value } : record(previous) ? { ...previous } : {};
  if (!start) for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) if (value[field] !== undefined && value[field] !== null) merged[field] = value[field];
  if (value.cache_creation !== undefined && value.cache_creation !== null) {
    if (!record(value.cache_creation)) merged.cache_creation = value.cache_creation;
    else if (value.cache_creation.ephemeral_1h_input_tokens !== undefined && value.cache_creation.ephemeral_1h_input_tokens !== null) merged.cache_creation = { ...(record(merged.cache_creation) ? merged.cache_creation : {}), ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens };
  }
  return merged;
}
export function kimiCodingUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = token(value.input_tokens), output = token(value.output_tokens), read = value.cache_read_input_tokens === undefined ? 0 : token(value.cache_read_input_tokens), write = value.cache_creation_input_tokens === undefined ? 0 : token(value.cache_creation_input_tokens);
  const creation = value.cache_creation, long = creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens === undefined ? 0 : token(creation.ephemeral_1h_input_tokens) : undefined;
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined || long > write || !Number.isSafeInteger(input + output + read + write)) return undefined;
  const pricing = kimiCodingProfile(model).pricing;
  return { promptTokens: input, completionTokens: output, totalTokens: input + output + read + write,
    ...(value.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: read }), ...(value.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: write }),
    ...(pricing ? { costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1e6 } : {}) };
}
const validFinish = (value: unknown): boolean => ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn'].includes(String(value));
export function validateKimiCodingMessage(value: unknown): void {
  if (!record(value) || value.error || value.type === 'error' || !Array.isArray(value.content) || !validFinish(value.stop_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Kimi Coding chat response.');
  for (const block of value.content) {
    if (!record(block)) throw new Error('Invalid Kimi Coding chat response.');
    if (block.type === 'text') { if (typeof block.text !== 'string') throw new Error('Invalid Kimi Coding chat response.'); }
    else if (block.type === 'thinking') { if (typeof block.thinking !== 'string' || (block.signature !== undefined && block.signature !== '')) throw new Error('Unsupported Kimi Coding reasoning replay.'); }
    else if (block.type === 'tool_use') { if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !record(block.input)) throw new Error('Invalid Kimi Coding chat response.'); }
    else throw new Error('Unsupported Kimi Coding message content.');
  }
}
export function kimiCodingMessageText(content: unknown): string { return Array.isArray(content) ? content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : ''; }
export function kimiCodingStreamValidator(): (value?: unknown) => void {
  let started = false, stopped = false, finish = false;
  return value => {
    if (value === undefined) { if (!started || !stopped || !finish) throw new Error('Invalid Kimi Coding chat response.'); return; }
    if (!record(value) || typeof value.type !== 'string' || (stopped && value.type !== 'ping')) throw new Error('Invalid Kimi Coding chat response.');
    if (value.type === 'message_start') { if (started || !record(value.message)) throw new Error('Invalid Kimi Coding chat response.'); started = true; }
    else if (value.type === 'message_delta') { if (!started || !record(value.delta)) throw new Error('Invalid Kimi Coding chat response.'); if (value.delta.stop_reason !== undefined && value.delta.stop_reason !== null) { if (!validFinish(value.delta.stop_reason)) throw new Error('Invalid Kimi Coding chat response.'); finish = true; } }
    else if (value.type === 'message_stop') { if (!started || !finish) throw new Error('Invalid Kimi Coding chat response.'); stopped = true; }
    else if (value.type === 'content_block_start') { const block = value.content_block; if (!started || !record(block) || !['text', 'thinking', 'tool_use'].includes(String(block.type))) throw new Error('Invalid Kimi Coding chat response.'); if (block.type === 'thinking' && block.signature !== undefined && block.signature !== '') throw new Error('Unsupported Kimi Coding reasoning replay.'); }
    else if (value.type === 'content_block_delta') { const delta = value.delta; if (!started || !record(delta) || !['text_delta', 'thinking_delta', 'input_json_delta'].includes(String(delta.type))) throw new Error('Unsupported Kimi Coding message content.'); const key = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : 'partial_json'; if (typeof delta[key] !== 'string') throw new Error('Invalid Kimi Coding chat response.'); }
    else if (!['ping', 'content_block_stop'].includes(value.type)) throw new Error('Invalid Kimi Coding chat response.');
  };
}
