import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface DeepSeekProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}

// Reviewed Pi 1.2.0 deepseek.json projection; image resize declarations are not an effective resizer.
export const DEEPSEEK_MODELS: readonly DeepSeekProfile[] = Object.freeze([
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', declaredInput: Object.freeze(['text', 'image'] as const),
    pricing: Object.freeze({ inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006, cacheWritePerMillion: 0 }),
    thinkingLevelMap: Object.freeze({ minimal: null, low: 'low', medium: null, high: 'high', max: 'max' }),
    declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) }) },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', declaredInput: Object.freeze(['text'] as const),
    pricing: Object.freeze({ inputPerMillion: 1.32, outputPerMillion: 3.96, cacheReadPerMillion: 0.044, cacheWritePerMillion: 0 }),
    thinkingLevelMap: Object.freeze({ minimal: null, low: null, medium: null, high: 'high', max: 'max' }) },
].map(row => Object.freeze({ ...row, api: 'openai-completions' as const, contextWindow: 1000000, maxOutputTokens: 384000, reasoning: true as const })));
const profiles = new Map(DEEPSEEK_MODELS.map(profile => [profile.id, profile]));
const levels: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function deepSeekProfile(model: string): DeepSeekProfile {
  const profile = profiles.get(model);
  if (!profile) throw new Error('DeepSeek chat model is not supported.');
  return profile;
}

export function prepareDeepSeekChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = [], nativeReplay = false): Record<string, unknown> {
  const profile = deepSeekProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!levels.includes(requested)) throw new Error('Invalid DeepSeek thinking level.');
  const selected = clampPublishedThinkingLevel(requested, levels.filter(level => profile.thinkingLevelMap[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap[level] !== undefined)));
  body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
  delete body.reasoning_effort;
  if (selected !== 'off') body.reasoning_effort = profile.thinkingLevelMap[selected] ?? selected;
  const maxTokens = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new Error('Invalid DeepSeek output limit.');
  delete body.max_completion_tokens; body.max_tokens = maxTokens;
  delete body.store; delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (body.stream) body.stream_options = { include_usage: true };
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) {
      if (typeof options.sessionId !== 'string' || Buffer.byteLength(options.sessionId) > 500 || /[\u0000-\u001f\u007f]/u.test(options.sessionId)) throw new Error('Invalid DeepSeek session identity.');
      if (options.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
    }
  }
  if (Array.isArray(body.messages)) {
    const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
    for (const message of body.messages) {
      if (!record(message)) continue;
      if (message.role === 'developer') message.role = 'system';
      if (message.role === 'assistant') message.reasoning_content = history[assistant++]?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n') ?? '';
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content)
        && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('DeepSeek chat model does not support images.');
    }
    body.messages = body.messages.filter(message => !record(message) || message.role !== 'assistant' || message.content || message.tool_calls);
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = !nativeReplay;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}

export function deepSeekUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value) || typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number'
    || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined;
  const usage = openRouterUsage(value, deepSeekProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), costUsd: usage.costUsd };
}

export function deepSeekReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = nativeReplay ? ['reasoning_content', 'reasoning', 'reasoning_text'] : ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_summary'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid DeepSeek chat response.');
  if (!nativeReplay && value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)) throw new Error('Unsupported DeepSeek reasoning replay.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validFinish = (value: unknown): boolean => ['stop', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateDeepSeekChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid DeepSeek chat response.');
  deepSeekReasoning(value.choices[0].message, nativeReplay);
}
export function deepSeekStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid DeepSeek chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid DeepSeek chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid DeepSeek chat response.');
    deepSeekReasoning(choice.delta, nativeReplay);
    if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid DeepSeek chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (!validFinish(choice.finish_reason)) throw new Error('Invalid DeepSeek chat response.'); finished = true;
    }
  };
}
