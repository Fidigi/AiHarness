import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface GroqProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
const gptThinking = Object.freeze({ off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null });
const resize = Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) });
// Reviewed Pi 1.2.0 groq.json projection; resize declarations are not an effective resizer.
export const GROQ_MODELS: readonly GroqProfile[] = Object.freeze([
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 131072, maxOutputTokens: 131072, reasoning: false, declaredInput: ['text'] as const,
    pricing: { inputPerMillion: 0.05, outputPerMillion: 0.08, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 131072, maxOutputTokens: 32768, reasoning: false, declaredInput: ['text'] as const,
    pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', contextWindow: 131072, maxOutputTokens: 65536, reasoning: true, declaredInput: ['text'] as const, thinkingLevelMap: gptThinking,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075, cacheWritePerMillion: 0 } },
  { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B', contextWindow: 131072, maxOutputTokens: 65536, reasoning: true, declaredInput: ['text'] as const, thinkingLevelMap: gptThinking,
    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.3, cacheReadPerMillion: 0.0375, cacheWritePerMillion: 0 } },
  { id: 'openai/gpt-oss-safeguard-20b', name: 'Safety GPT OSS 20B', contextWindow: 131072, maxOutputTokens: 65536, reasoning: true, declaredInput: ['text'] as const, thinkingLevelMap: gptThinking,
    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.3, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: 'qwen/qwen3.6-27b', name: 'Qwen3.6 27B', contextWindow: 131072, maxOutputTokens: 16384, reasoning: true, declaredInput: ['text','image'] as const,
    thinkingLevelMap: Object.freeze({ off: 'none', minimal: null, low: null, medium: null, high: 'default', xhigh: null, max: null }), declaredInputLimits: resize,
    pricing: { inputPerMillion: 0.6, outputPerMillion: 3, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 } },
  { id: 'qwen/qwen3.8-27b', name: 'Qwen3.8 27B', contextWindow: 131042, maxOutputTokens: 16384, reasoning: true, declaredInput: ['text','image'] as const,
    thinkingLevelMap: Object.freeze({ off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }), declaredInputLimits: resize,
    pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
].map(row => Object.freeze({ ...row, api: 'openai-completions' as const, declaredInput: Object.freeze(row.declaredInput), pricing: Object.freeze(row.pricing) })));
const profiles = new Map(GROQ_MODELS.map(profile => [profile.id, profile]));
const levels: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function groqProfile(model: string): GroqProfile {
  const profile = profiles.get(model); if (!profile) throw new Error('Groq chat model is not supported.'); return profile;
}
export function prepareGroqChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const profile = groqProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!levels.includes(requested)) throw new Error('Invalid Groq thinking level.');
  const selected = clampPublishedThinkingLevel(requested, profile.reasoning ? levels.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh','max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined)) : ['off']);
  delete body.reasoning_effort;
  if (profile.reasoning && (selected !== 'off' || typeof profile.thinkingLevelMap?.off === 'string')) body.reasoning_effort = profile.thinkingLevelMap?.[selected] ?? selected;
  const maxTokens = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new Error('Invalid Groq output limit.');
  delete body.max_tokens; body.max_completion_tokens = maxTokens; body.store = false;
  delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (body.stream) body.stream_options = { include_usage: true };
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) {
      if (typeof options.sessionId !== 'string' || Buffer.byteLength(options.sessionId) > 500 || /[\u0000-\u001f\u007f]/u.test(options.sessionId)) throw new Error('Invalid Groq session identity.');
      if (options.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0,64).join('');
    }
  }
  if (Array.isArray(body.messages)) for (const message of body.messages) {
    if (!record(message)) continue;
    if (message.role === 'developer' || message.role === 'system') message.role = profile.reasoning ? 'developer' : 'system';
    if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Groq chat model does not support images.');
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = true;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function groqUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value) || typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number' || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined;
  const usage = openRouterUsage(value, groqProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), costUsd: usage.costUsd };
}
export function groqReasoning(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content','reasoning','reasoning_text','reasoning_summary'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Groq chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)) throw new Error('Unsupported Groq reasoning replay.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validFinish = (value: unknown): boolean => ['stop','end','length','tool_calls','function_call'].includes(String(value));
export function validateGroqChat(value: unknown): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Groq chat response.');
  groqReasoning(value.choices[0].message);
}
export function groqStreamValidator(): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Groq chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Groq chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Groq chat response.');
    groqReasoning(choice.delta); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Groq chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Groq chat response.'); finished = true; }
  };
}
