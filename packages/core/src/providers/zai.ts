import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface ZaiProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly declaredPricing: Readonly<Required<ModelPricing>>;
  readonly pricing?: Readonly<Required<ModelPricing>>;
  readonly supportsReasoningEffort: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
const thinking52 = Object.freeze({ off: 'none', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' });
const thinking53 = Object.freeze({ off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
const resize = Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) });
// Reviewed zai.json catalogue projection. Zero-only highspeed prices stay unknown; resize is declarative.
export const ZAI_MODELS: readonly ZaiProfile[] = Object.freeze([
  { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204800, supportsReasoningEffort: false, declaredInput: ['text'] as const,
    declaredPricing: { inputPerMillion: 0.6, outputPerMillion: 2.2, cacheReadPerMillion: 0.11, cacheWritePerMillion: 0 } },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo', contextWindow: 200000, supportsReasoningEffort: false, declaredInput: ['text'] as const,
    declaredPricing: { inputPerMillion: 1.2, outputPerMillion: 4, cacheReadPerMillion: 0.24, cacheWritePerMillion: 0 } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, supportsReasoningEffort: true, declaredInput: ['text'] as const, thinkingLevelMap: thinking52,
    declaredPricing: { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 } },
  { id: 'glm-5.2-highspeed', name: 'GLM-5.2 Highspeed', contextWindow: 1000000, supportsReasoningEffort: true, declaredInput: ['text'] as const, thinkingLevelMap: thinking52,
    declaredPricing: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, supportsReasoningEffort: true, declaredInput: ['text'] as const, thinkingLevelMap: thinking53,
    declaredPricing: { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1000000, supportsReasoningEffort: true, declaredInput: ['text', 'image'] as const, thinkingLevelMap: thinking53, declaredInputLimits: resize,
    declaredPricing: { inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0 } },
  { id: 'glm-5.3-highspeed', name: 'GLM-5.3 Highspeed', contextWindow: 1000000, supportsReasoningEffort: true, declaredInput: ['text'] as const, thinkingLevelMap: thinking53,
    declaredPricing: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
].map(row => Object.freeze({ ...row, api: 'openai-completions' as const, maxOutputTokens: 131072, reasoning: true as const,
  declaredInput: Object.freeze(row.declaredInput), declaredPricing: Object.freeze(row.declaredPricing),
  ...(Object.values(row.declaredPricing).some(value => value !== 0) ? { pricing: Object.freeze({ ...row.declaredPricing }) } : {}) })));
const profiles = new Map(ZAI_MODELS.map(profile => [profile.id, profile]));
const levels: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function zaiProfile(model: string): ZaiProfile {
  const profile = profiles.get(model); if (!profile) throw new Error('Z.ai chat model is not supported.'); return profile;
}
export function prepareZaiChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = [], nativeReplay = false): Record<string, unknown> {
  const profile = zaiProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!levels.includes(requested)) throw new Error('Invalid Z.ai thinking level.');
  const selected = clampPublishedThinkingLevel(requested, levels.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined)));
  body.thinking = selected === 'off' ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false };
  delete body.reasoning_effort;
  if (selected !== 'off' && profile.supportsReasoningEffort) body.reasoning_effort = profile.thinkingLevelMap?.[selected] ?? selected;
  const maxTokens = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new Error('Invalid Z.ai output limit.');
  delete body.max_completion_tokens; body.max_tokens = maxTokens;
  delete body.store; delete body.prompt_cache_key; delete body.prompt_cache_retention; delete body.tool_stream;
  if (body.stream) body.stream_options = { include_usage: true };
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) {
      if (typeof options.sessionId !== 'string' || Buffer.byteLength(options.sessionId) > 500 || /[\u0000-\u001f\u007f]/u.test(options.sessionId)) throw new Error('Invalid Z.ai session identity.');
      if (options.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
    }
  }
  if (Array.isArray(body.messages)) {
    const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
    for (const message of body.messages) {
      if (!record(message)) continue;
      if (message.role === 'developer') message.role = 'system';
      if (message.role === 'assistant') {
        const reasoning = history[assistant++]?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).filter(text => text.trim()).join('\n');
        if (reasoning) message.reasoning_content = reasoning;
      }
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Z.ai chat model does not support images.');
    }
    body.messages = body.messages.filter(message => !record(message) || message.role !== 'assistant' || message.content || message.tool_calls);
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = !nativeReplay;
    body.tool_stream = true;
  }
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function zaiUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value) || typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number' || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined;
  const usage = openRouterUsage(value, zaiProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) };
}
export function zaiReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = nativeReplay ? ['reasoning_content', 'reasoning', 'reasoning_text'] : ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_summary'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Z.ai chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !nativeReplay && value.reasoning_details.length)) throw new Error('Unsupported Z.ai reasoning replay.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validFinish = (value: unknown): boolean => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateZaiChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Z.ai chat response.');
  zaiReasoning(value.choices[0].message, nativeReplay);
}
export function zaiStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Z.ai chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Z.ai chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Z.ai chat response.');
    zaiReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Z.ai chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Z.ai chat response.'); finished = true; }
  };
}
