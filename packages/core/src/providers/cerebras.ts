import type { ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface CerebrasProfile {
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

// Reviewed Pi 1.2.0 cerebras.json projection; resize declarations are not an effective resizer.
export const CEREBRAS_MODELS: readonly CerebrasProfile[] = Object.freeze([
  { id: 'gpt-oss-120b', name: 'GPT OSS 120B', declaredInput: Object.freeze(['text'] as const),
    pricing: Object.freeze({ inputPerMillion: 0.35, outputPerMillion: 0.75, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }),
    thinkingLevelMap: Object.freeze({ off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }) },
  { id: 'qwen-3.8-27b', name: 'Qwen3.8 27B', declaredInput: Object.freeze(['text', 'image'] as const),
    pricing: Object.freeze({ inputPerMillion: 0.99, outputPerMillion: 1.49, cacheReadPerMillion: 0.99, cacheWritePerMillion: 0 }),
    thinkingLevelMap: Object.freeze({ off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }),
    declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) }) },
].map(row => Object.freeze({ ...row, api: 'openai-completions' as const, contextWindow: 131072, maxOutputTokens: 40960, reasoning: true as const })));
const profiles = new Map(CEREBRAS_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function cerebrasProfile(model: string): CerebrasProfile {
  const profile = profiles.get(model);
  if (!profile) throw new Error('Cerebras chat model is not supported.');
  return profile;
}

export function prepareCerebrasChat(body: Record<string, unknown>, options?: ChatOptions): Record<string, unknown> {
  const profile = cerebrasProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Cerebras thinking level.');
  const selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
  body.reasoning_effort = profile.thinkingLevelMap[selected];
  const maxTokens = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new Error('Invalid Cerebras output limit.');
  delete body.max_tokens; body.max_completion_tokens = maxTokens;
  delete body.store; delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (body.stream) body.stream_options = { include_usage: true };
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) {
      if (typeof options.sessionId !== 'string' || Buffer.byteLength(options.sessionId) > 500 || /[\u0000-\u001f\u007f]/u.test(options.sessionId)) throw new Error('Invalid Cerebras session identity.');
      if (options.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
    }
  }
  if (Array.isArray(body.messages)) for (const message of body.messages) {
    if (!record(message)) continue;
    if (message.role === 'developer') message.role = 'system';
    if (!profile.declaredInput.includes('image') && Array.isArray(message.content)
      && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Cerebras chat model does not support images.');
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) delete tool.function.strict;
  return body;
}

export function cerebrasUsage(value: unknown, model: string): ChatResponse['usage'] {
  // The pinned Cerebras C API uses the same disjoint read/write counter semantics as native C.
  const usage = openRouterUsage(value, cerebrasProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), costUsd: usage.costUsd };
}

export function cerebrasReasoning(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Cerebras chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)) throw new Error('Unsupported Cerebras reasoning replay.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validFinish = (value: unknown): boolean => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateCerebrasChat(value: unknown): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Cerebras chat response.');
  cerebrasReasoning(value.choices[0].message);
}

/** Per-request state; parallel or nested streams cannot lend one another a finish witness. */
export function cerebrasStreamValidator(): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Cerebras chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Cerebras chat response.');
    const choice = value.choices[0];
    if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Cerebras chat response.');
    cerebrasReasoning(choice.delta);
    if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Cerebras chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (!validFinish(choice.finish_reason)) throw new Error('Invalid Cerebras chat response.');
      finished = true;
    }
  };
}
