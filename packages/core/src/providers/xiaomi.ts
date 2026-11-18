import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface XiaomiProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Reviewed direct Xiaomi catalogue declarations,not regional token-plan or routed profiles.
const reviewed: readonly Pick<XiaomiProfile, 'id' | 'name' | 'declaredInput' | 'pricing'>[] = [
  { id: 'mimo-v2.5', name: 'MiMo-V2.5', declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028, cacheWritePerMillion: 0 } },
  { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', declaredInput: ['text'], pricing: { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.0036, cacheWritePerMillion: 0 } },
  { id: 'mimo-v2.5-pro-ultraspeed', name: 'MiMo-V2.5-Pro-UltraSpeed', declaredInput: ['text'], pricing: { inputPerMillion: 1.305, outputPerMillion: 2.61, cacheReadPerMillion: 0.0108, cacheWritePerMillion: 0 } },
  { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028, cacheWritePerMillion: 0 } },
  { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', declaredInput: ['text', 'image'], pricing: { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.0036, cacheWritePerMillion: 0 } },
  { id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo-V2.6-Pro-UltraSpeed', declaredInput: ['text', 'image'], pricing: { inputPerMillion: 4.35, outputPerMillion: 8.7, cacheReadPerMillion: 0.036, cacheWritePerMillion: 0 } },
];
const thinkingLevelMap = Object.freeze({ off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null });
const imageLimits = Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) });
export const XIAOMI_MODELS: readonly XiaomiProfile[] = Object.freeze(reviewed.map(row => Object.freeze({ ...row,
  api: 'openai-completions' as const, contextWindow: 1048576, maxOutputTokens: 131072, reasoning: true as const,
  declaredInput: Object.freeze([...row.declaredInput]), pricing: Object.freeze({ ...row.pricing }), thinkingLevelMap,
  ...(row.declaredInput.includes('image') ? { declaredInputLimits: imageLimits } : {}),
})));
const profiles = new Map(XIAOMI_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function xiaomiProfile(model: string): XiaomiProfile { const profile = profiles.get(model); if (!profile) throw new Error('Xiaomi chat model is not supported.'); return profile; }
export function prepareXiaomiChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = [], nativeReplay = false): Record<string, unknown> {
  const profile = xiaomiProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Xiaomi thinking level.');
  const selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
  delete body.reasoning_effort; delete body.reasoning; delete body.enable_thinking; delete body.tool_stream;
  delete body.chat_template_args; delete body.chat_template_kwargs; delete body.max_tokens;
  body.store = false; body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
  if (selected !== 'off') body.reasoning_effort = profile.thinkingLevelMap[selected];
  if (options?.maxTokens !== undefined) { if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid Xiaomi output limit.'); body.max_completion_tokens = options.maxTokens; }
  else delete body.max_completion_tokens;
  delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) { if (typeof options.sessionId !== 'string') throw new Error('Invalid Xiaomi session identity.'); body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join(''); }
  }
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) {
    const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
    for (const message of body.messages) if (record(message)) {
      if (message.role === 'system') message.role = 'developer';
      if (message.role === 'assistant' && !nativeReplay) message.reasoning_content = history[assistant++]?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n') ?? '';
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Xiaomi chat model does not support images.');
    }
    body.messages = body.messages.filter(message => !record(message) || message.role !== 'assistant' || message.content || message.tool_calls);
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function xiaomiUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value) || typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number' || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined;
  const usage = openRouterUsage(value, xiaomiProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) };
}
export function xiaomiReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Xiaomi chat response.');
  if (!nativeReplay && value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)) throw new Error('Unsupported Xiaomi reasoning replay.');
  return fields.map(field => value[field]).find((text): text is string => typeof text === 'string' && text.length > 0);
}
const validFinish = (value: unknown) => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateXiaomiChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message) || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)) throw new Error('Invalid Xiaomi chat response.');
  xiaomiReasoning(value.choices[0].message, nativeReplay);
}
export function xiaomiStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Xiaomi chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Xiaomi chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Xiaomi chat response.');
    xiaomiReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Xiaomi chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Xiaomi chat response.'); finished = true; }
  };
}
