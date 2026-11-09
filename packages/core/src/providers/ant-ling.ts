import type { ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface AntLingProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly declaredInput: readonly 'text'[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap?: Readonly<Record<PublishedThinkingLevel, string | null>>;
}
export const ANT_LING_MODELS: readonly AntLingProfile[] = Object.freeze([
  { id: 'Ling-2.6-1T', name: 'Ling 2.6 1T', reasoning: false, input: 0.06, output: 0.25 },
  { id: 'Ling-2.6-flash', name: 'Ling 2.6 Flash', reasoning: false, input: 0.01, output: 0.02 },
  { id: 'Ring-2.6-1T', name: 'Ring 2.6 1T', reasoning: true, input: 0.06, output: 0.25 },
].map(row => Object.freeze({ id: row.id, name: row.name, reasoning: row.reasoning, api: 'openai-completions' as const,
  contextWindow: 262144, maxOutputTokens: 65536, declaredInput: Object.freeze(['text'] as const),
  pricing: Object.freeze({ inputPerMillion: row.input, outputPerMillion: row.output, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }),
  ...(row.reasoning ? { thinkingLevelMap: Object.freeze({ off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: 'xhigh', max: null }) } : {}),
})));
const profiles = new Map(ANT_LING_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function antLingProfile(model: string): AntLingProfile { const profile = profiles.get(model); if (!profile) throw new Error('Ant Ling chat model is not supported.'); return profile; }
export function prepareAntLingChat(body: Record<string, unknown>, options?: ChatOptions): Record<string, unknown> {
  const profile = antLingProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Ant Ling thinking level.');
  delete body.reasoning_effort; delete body.reasoning; delete body.store; delete body.max_completion_tokens;
  delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (profile.thinkingLevelMap) { const map = profile.thinkingLevelMap, selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => map[level] !== null)); body.reasoning = { effort: map[selected] }; }
  if (options?.maxTokens !== undefined) { if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid Ant Ling output limit.'); body.max_tokens = options.maxTokens; }
  else delete body.max_tokens;
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message)) {
    if (message.role === 'developer') message.role = 'system';
    if (Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Ant Ling chat model does not support images.');
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  return body;
}
export function antLingUsage(value: unknown, model: string): ChatResponse['usage'] {
  const usage = openRouterUsage(value, antLingProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), costUsd: usage.costUsd };
}
export function antLingReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Ant Ling chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !nativeReplay && value.reasoning_details.length)) throw new Error('Unsupported Ant Ling reasoning replay.');
  return fields.map(field => value[field]).find((text): text is string => typeof text === 'string' && text.length > 0);
}
const validFinish = (value: unknown) => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateAntLingChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message) || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)) throw new Error('Invalid Ant Ling chat response.');
  antLingReasoning(value.choices[0].message, nativeReplay);
}
export function antLingStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Ant Ling chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Ant Ling chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Ant Ling chat response.');
    antLingReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Ant Ling chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Ant Ling chat response.'); finished = true; }
  };
}
