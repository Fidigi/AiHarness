import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { copyThinkingBudgets } from './thinking-budgets.js';
import { simpleContextTokens } from './simple-context-estimate.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';

interface MiniMaxTier extends Readonly<Required<ModelPricing>> { readonly inputTokensAbove: number }
export interface MiniMaxProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'anthropic-messages';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly declaredPricing: Readonly<Required<ModelPricing> & { tiers?: readonly MiniMaxTier[] }>;
  readonly pricing: Readonly<Required<ModelPricing> & { tiers?: readonly MiniMaxTier[] }>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Pinned MiniMax declarations; image resize is declarative, not normalized-media acceptance.
const rows: readonly Omit<MiniMaxProfile, 'pricing'>[] = [
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', api: 'anthropic-messages', contextWindow: 204800, maxOutputTokens: 131072,
    reasoning: true, declaredInput: ['text'], declaredPricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.06, cacheWritePerMillion: 0.375 } },
  { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed', api: 'anthropic-messages', contextWindow: 204800, maxOutputTokens: 131072,
    reasoning: true, declaredInput: ['text'], declaredPricing: { inputPerMillion: 0.6, outputPerMillion: 2.4, cacheReadPerMillion: 0.06, cacheWritePerMillion: 0.375 } },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', api: 'anthropic-messages', contextWindow: 1000000, maxOutputTokens: 512000,
    reasoning: true, declaredInput: ['text', 'image'], declaredPricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.06, cacheWritePerMillion: 0,
      tiers: [{ inputTokensAbove: 512000, inputPerMillion: 0.6, outputPerMillion: 2.4, cacheReadPerMillion: 0.12, cacheWritePerMillion: 0 }] },
    declaredInputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } } },
];
export const MINIMAX_MODELS: readonly MiniMaxProfile[] = Object.freeze(rows.map(row => {
  const pricing = Object.freeze({ ...row.declaredPricing, ...(row.declaredPricing.tiers ? { tiers: Object.freeze(row.declaredPricing.tiers.map(tier => Object.freeze({ ...tier }))) } : {}) });
  return Object.freeze({ ...row, declaredInput: Object.freeze([...row.declaredInput]), declaredPricing: pricing, pricing,
    ...(row.declaredInputLimits ? { declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ ...row.declaredInputLimits.images.resize }) }) }) } : {}) });
}));
const profiles = new Map(MINIMAX_MODELS.map(profile => [profile.id, profile]));
const levels: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];
const defaults = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function miniMaxProfile(model: string): MiniMaxProfile {
  const profile = profiles.get(model); if (!profile) throw new Error('MiniMax chat model is not supported.'); return profile;
}
export function miniMaxEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    const path = url.pathname.replace(/\/+$/u, '');
    url.pathname = path.endsWith('/messages') ? path : /\/v\d+$/u.test(path) ? `${path}/messages` : `${path}/v1/messages`;
    return url.href;
  } catch { throw new Error('Invalid MiniMax endpoint.'); }
}
export function miniMaxThinking(options?: ChatOptions): PublishedThinkingLevel {
  const requested = options?.thinking ?? 'off';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(requested)) throw new Error('Invalid MiniMax thinking level.');
  return clampPublishedThinkingLevel(requested, levels);
}
export function prepareMiniMaxMessage(body: Record<string, unknown>, options?: ChatOptions, messages: readonly Message[] = []): Record<string, unknown> {
  const profile = miniMaxProfile(String(body.model)), selected = miniMaxThinking(options);
  const requestedMax = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > profile.maxOutputTokens) throw new Error('Invalid MiniMax output limit.');
  const available = Math.max(1, profile.contextWindow - simpleContextTokens(messages, options) - 4096);
  let maximum = Math.min(requestedMax, available);
  delete body.output_config;
  if (selected === 'off') body.thinking = { type: 'disabled' };
  else {
    const level = selected as keyof typeof defaults;
    const requested = copyThinkingBudgets(options?.thinkingBudgets)?.[level] ?? defaults[level];
    maximum = Math.min(requested >= profile.maxOutputTokens - maximum ? profile.maxOutputTokens : maximum + requested, available);
    const budget = Math.min(requested, Math.max(0, maximum - 1024)) || 1024;
    if (budget < 1024 || maximum - budget < 1024) throw new Error('Invalid MiniMax thinking allocation.');
    body.thinking = { type: 'enabled', budget_tokens: budget, display: 'summarized' }; delete body.temperature;
  }
  body.max_tokens = maximum;
  const control = options?.cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(options?.cacheRetention === 'long' ? { ttl: '1h' } : {}) };
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system, ...(control ? { cache_control: control } : {}) }];
  if (Array.isArray(body.tools)) body.tools = body.tools.map((tool: Record<string, unknown>, index: number) => {
    const result = { ...tool, eager_input_streaming: true }; delete (result as Record<string, unknown>).strict;
    return { ...result, ...(control && index === (body.tools as unknown[]).length - 1 ? { cache_control: control } : {}) };
  });
  if (!profile.declaredInput.includes('image') && Array.isArray(body.messages) && body.messages.some(message => record(message)
    && Array.isArray(message.content) && message.content.some(block => record(block) && block.type === 'image'))) throw new Error('MiniMax chat model does not support images.');
  return body;
}
/** Preflight the selected simple allocation without replacing the caller cap and expanding it twice. */
export function prepareMiniMaxOutputBudget(owned: ChatOptions, configuredModel: string, messages: readonly Message[] = []): Readonly<PreparedNativeOutputBudget> {
  const options: ChatOptions = { ...owned, model: owned.model || configuredModel };
  if (miniMaxThinking(options) !== 'off') {
    try { options.thinkingBudgets = copyThinkingBudgets(options.thinkingBudgets); }
    catch { throw new ProviderOutputBudgetError('thinking'); }
  }
  try {
    const body = prepareMiniMaxMessage({ model: options.model }, options, messages);
    return Object.freeze({ options, maxTokens: body.max_tokens as number });
  } catch { throw new ProviderOutputBudgetError(); }
}
export function mergeMiniMaxUsage(previous: unknown, value: unknown, start: boolean): unknown {
  if (!record(value)) return previous;
  const merged: Record<string, unknown> = start ? { ...value } : record(previous) ? { ...previous } : {};
  if (!start) for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (value[field] !== undefined && value[field] !== null) merged[field] = value[field];
  }
  if (value.cache_creation !== undefined && value.cache_creation !== null) {
    if (!record(value.cache_creation)) merged.cache_creation = value.cache_creation;
    else if (value.cache_creation.ephemeral_1h_input_tokens !== undefined && value.cache_creation.ephemeral_1h_input_tokens !== null) {
      merged.cache_creation = { ...(record(merged.cache_creation) ? merged.cache_creation : {}), ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens };
    }
  }
  return merged;
}
export function miniMaxUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = token(value.input_tokens), output = token(value.output_tokens);
  const read = value.cache_read_input_tokens === undefined ? 0 : token(value.cache_read_input_tokens);
  const write = value.cache_creation_input_tokens === undefined ? 0 : token(value.cache_creation_input_tokens);
  const creation = value.cache_creation;
  const long = creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens === undefined ? 0 : token(creation.ephemeral_1h_input_tokens) : undefined;
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined || long > write
    || !Number.isSafeInteger(input + output + read + write)) return undefined;
  const profile = miniMaxProfile(model); let pricing: Readonly<Required<ModelPricing>> = profile.pricing, threshold = -1;
  for (const tier of profile.pricing.tiers ?? []) if (input + read + write > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { pricing = tier; threshold = tier.inputTokensAbove; }
  return { promptTokens: input, completionTokens: output, totalTokens: input + output + read + write,
    ...(value.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: read }),
    ...(value.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: write }),
    costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion
      + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1000000 };
}
const validFinish = (value: unknown): boolean => ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(String(value));
export function validateMiniMaxMessage(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || value.type === 'error' || !Array.isArray(value.content) || !validFinish(value.stop_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid MiniMax chat response.');
  for (const block of value.content) {
    if (!record(block)) throw new Error('Invalid MiniMax chat response.');
    if (block.type === 'text') { if (typeof block.text !== 'string') throw new Error('Invalid MiniMax chat response.'); }
    else if (block.type === 'thinking') { if (typeof block.thinking !== 'string' || (block.signature !== undefined && (typeof block.signature !== 'string' || !nativeReplay && block.signature !== ''))) throw new Error('Unsupported MiniMax reasoning replay.'); }
    else if (block.type === 'redacted_thinking' && nativeReplay) { if (typeof block.data !== 'string') throw new Error('Invalid MiniMax chat response.'); }
    else if (block.type === 'tool_use') { if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !record(block.input)) throw new Error('Invalid MiniMax chat response.'); }
    else throw new Error('Unsupported MiniMax message content.');
  }
}
export function miniMaxMessageText(content: unknown): string {
  return Array.isArray(content) ? content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : '';
}
export function miniMaxStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let started = false, stopped = false, finish = false;
  return value => {
    if (value === undefined) { if (!started || !stopped || !finish) throw new Error('Invalid MiniMax chat response.'); return; }
    if (!record(value) || typeof value.type !== 'string' || (stopped && value.type !== 'ping')) throw new Error('Invalid MiniMax chat response.');
    if (value.type === 'message_start') { if (started || !record(value.message)) throw new Error('Invalid MiniMax chat response.'); started = true; }
    else if (value.type === 'message_delta') {
      if (!started || !record(value.delta)) throw new Error('Invalid MiniMax chat response.');
      if (value.delta.stop_reason !== undefined && value.delta.stop_reason !== null) {
        if (!validFinish(value.delta.stop_reason)) throw new Error('Invalid MiniMax chat response.'); finish = true;
      }
    }
    else if (value.type === 'message_stop') { if (!started || !finish) throw new Error('Invalid MiniMax chat response.'); stopped = true; }
    else if (value.type === 'content_block_start') {
      const block = value.content_block;
      if (!started || !record(block) || !['text', 'thinking', 'tool_use'].includes(String(block.type)) && !(nativeReplay && block.type === 'redacted_thinking')) throw new Error('Invalid MiniMax chat response.');
      if (block.type === 'thinking' && block.signature !== undefined && (typeof block.signature !== 'string' || !nativeReplay && block.signature !== '')) throw new Error('Unsupported MiniMax reasoning replay.');
    } else if (value.type === 'content_block_delta') {
      const delta = value.delta;
      if (!started || !record(delta) || !['text_delta', 'thinking_delta', 'input_json_delta'].includes(String(delta.type)) && !(nativeReplay && delta.type === 'signature_delta')) throw new Error('Unsupported MiniMax message content.');
      const key = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : delta.type === 'signature_delta' ? 'signature' : 'partial_json';
      if (typeof delta[key] !== 'string') throw new Error('Invalid MiniMax chat response.');
    } else if (!['ping', 'content_block_stop'].includes(value.type)) throw new Error('Invalid MiniMax chat response.');
  };
}
