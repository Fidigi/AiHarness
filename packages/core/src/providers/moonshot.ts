import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface MoonshotProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingFormat: 'deepseek' | 'openai';
  readonly requiresReasoningContent: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Reviewed Pi 1.2.0 moonshotai.json projection; image resize limits remain declarative.
export const MOONSHOT_MODELS: readonly MoonshotProfile[] = Object.freeze(([
{"id":"kimi-k2.6","name":"Kimi K2.6","api":"openai-completions","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.95,"outputPerMillion":4,"cacheReadPerMillion":0.16,"cacheWritePerMillion":0},"thinkingFormat":"deepseek","requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
{"id":"kimi-k2.7-code","name":"Kimi K2.7 Code","api":"openai-completions","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.95,"outputPerMillion":4,"cacheReadPerMillion":0.19,"cacheWritePerMillion":0},"thinkingFormat":"deepseek","requiresReasoningContent":false,"supportsReasoningEffort":false,"thinkingLevelMap":{"off":null},"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
{"id":"kimi-k2.7-code-highspeed","name":"Kimi K2.7 Code HighSpeed","api":"openai-completions","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":1.9,"outputPerMillion":8,"cacheReadPerMillion":0.38,"cacheWritePerMillion":0},"thinkingFormat":"deepseek","requiresReasoningContent":false,"supportsReasoningEffort":false,"thinkingLevelMap":{"off":null},"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
{"id":"kimi-k3","name":"Kimi K3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":1048576,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3,"cacheWritePerMillion":0},"thinkingFormat":"openai","requiresReasoningContent":true,"supportsReasoningEffort":true,"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}}
] as const).map(row => Object.freeze({ ...row,
  declaredInput: Object.freeze([...row.declaredInput]), pricing: Object.freeze({ ...row.pricing }),
  ...('thinkingLevelMap' in row ? { thinkingLevelMap: Object.freeze({ ...row.thinkingLevelMap }) } : {}),
  declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ ...row.declaredInputLimits.images.resize }) }) }),
})));
const profiles = new Map(MOONSHOT_MODELS.map(profile => [profile.id, profile]));
const levels: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function moonshotProfile(model: string): MoonshotProfile {
  const profile = profiles.get(model); if (!profile) throw new Error('Moonshot chat model is not supported.'); return profile;
}
export function prepareMoonshotChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const profile = moonshotProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!levels.includes(requested)) throw new Error('Invalid Moonshot thinking level.');
  const selected = clampPublishedThinkingLevel(requested, levels.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined)));
  delete body.thinking;
  if (profile.thinkingFormat === 'deepseek') body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
  delete body.reasoning_effort;
  if (selected !== 'off' && profile.supportsReasoningEffort) body.reasoning_effort = profile.thinkingLevelMap?.[selected] ?? selected;
  const maxTokens = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new Error('Invalid Moonshot output limit.');
  delete body.max_completion_tokens; body.max_tokens = maxTokens;
  delete body.store; delete body.prompt_cache_key; delete body.prompt_cache_retention; delete body.tool_stream;
  if (body.stream) body.stream_options = { include_usage: true };
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) {
      if (typeof options.sessionId !== 'string' || Buffer.byteLength(options.sessionId) > 500 || /[\u0000-\u001f\u007f]/u.test(options.sessionId)) throw new Error('Invalid Moonshot session identity.');
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
        if (reasoning || profile.requiresReasoningContent) message.reasoning_content = reasoning ?? '';
      }
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Moonshot chat model does not support images.');
    }
    body.messages = body.messages.filter(message => !record(message) || message.role !== 'assistant' || message.content || message.tool_calls);
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) delete tool.function.strict;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function moonshotUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value) || typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number' || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined;
  const usage = openRouterUsage(value, moonshotProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) };
}
export function moonshotReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = nativeReplay ? ['reasoning_content', 'reasoning', 'reasoning_text'] : ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_summary'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Moonshot chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !nativeReplay && value.reasoning_details.length)) throw new Error('Unsupported Moonshot reasoning replay.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validFinish = (value: unknown): boolean => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateMoonshotChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Moonshot chat response.');
  moonshotReasoning(value.choices[0].message, nativeReplay);
}
export function moonshotStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Moonshot chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Moonshot chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Moonshot chat response.');
    moonshotReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Moonshot chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Moonshot chat response.'); finished = true; }
  };
}
