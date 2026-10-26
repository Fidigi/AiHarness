import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface TogetherProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly thinkingFormat: 'openai' | 'together';
  readonly supportsReasoningEffort: boolean;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Reviewed Together policy, including detected format and supported-level defaults; resize remains declarative.
export const TOGETHER_MODELS: readonly TogetherProfile[] = Object.freeze([
  {"id":"deepseek-ai/DeepSeek-V4-Flash-0731","name":"DeepSeek V4 Flash 0731","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.14,"outputPerMillion":0.28,"cacheReadPerMillion":0.03,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"deepseek-ai/DeepSeek-V4-Pro-0813","name":"DeepSeek V4 Pro 0813","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.32,"outputPerMillion":3.96,"cacheReadPerMillion":0.13,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":true},
  {"id":"deepseek-ai/DeepSeek-V4.1-Flash","name":"DeepSeek V4.1 Flash","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.006,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"meta-llama/Llama-3.3-70B-Instruct-Turbo","name":"Llama 3.3 70B","api":"openai-completions","contextWindow":131072,"maxOutputTokens":131072,"reasoning":false,"declaredInput":["text"],"pricing":{"inputPerMillion":1.04,"outputPerMillion":1.04,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":null,"xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"MiniMaxAI/MiniMax-M2.7","name":"MiniMax-M2.7","api":"openai-completions","contextWindow":196608,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.06,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"MiniMaxAI/MiniMax-M3","name":"MiniMax-M3","api":"openai-completions","contextWindow":524288,"maxOutputTokens":250000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.06,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"moonshotai/Kimi-K3","name":"Kimi K3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"nvidia/nemotron-3-ultra-550b-a55b","name":"Nemotron 3 Ultra 550B A55B","api":"openai-completions","contextWindow":512300,"maxOutputTokens":512300,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.6,"outputPerMillion":3.6,"cacheReadPerMillion":0.2,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"openai/gpt-oss-120b","name":"GPT OSS 120B","api":"openai-completions","contextWindow":131072,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.15,"outputPerMillion":0.6,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingFormat":"openai","supportsReasoningEffort":true},
  {"id":"Qwen/Qwen2.5-7B-Instruct-Turbo","name":"Qwen 2.5 7B Instruct Turbo","api":"openai-completions","contextWindow":32768,"maxOutputTokens":32768,"reasoning":false,"declaredInput":["text"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":0.3,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":null,"xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"Qwen/Qwen3.5-9B","name":"Qwen3.5 9B","api":"openai-completions","contextWindow":262144,"maxOutputTokens":65536,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.17,"outputPerMillion":0.25,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"Qwen/Qwen3.6-Plus","name":"Qwen3.6 Plus","api":"openai-completions","contextWindow":1000000,"maxOutputTokens":500000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.5,"outputPerMillion":3,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"Qwen/Qwen3.7-Max","name":"Qwen3.7 Max","api":"openai-completions","contextWindow":1000000,"maxOutputTokens":500000,"reasoning":false,"declaredInput":["text"],"pricing":{"inputPerMillion":1.25,"outputPerMillion":3.75,"cacheReadPerMillion":0.125,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":null,"xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"thinkingmachines/Inkling","name":"Inkling","api":"openai-completions","contextWindow":524288,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":1,"outputPerMillion":4.05,"cacheReadPerMillion":0.17,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"zai-org/GLM-5.2","name":"GLM-5.2","api":"openai-completions","contextWindow":1048575,"maxOutputTokens":164000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.4,"outputPerMillion":4.4,"cacheReadPerMillion":0.26,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"zai-org/GLM-5.3","name":"GLM-5.3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.4,"outputPerMillion":4.4,"cacheReadPerMillion":0.26,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false},
  {"id":"zai-org/GLM-5.3-Flash","name":"GLM-5.3-Flash","api":"openai-completions","contextWindow":1048575,"maxOutputTokens":400000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.15,"outputPerMillion":0.5,"cacheReadPerMillion":0.03,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"together","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
].map(row => Object.freeze({ ...row, api: 'openai-completions' as const, thinkingFormat: row.thinkingFormat as TogetherProfile['thinkingFormat'],
  declaredInput: Object.freeze(row.declaredInput as ('text' | 'image')[]), pricing: Object.freeze(row.pricing), thinkingLevelMap: Object.freeze(row.thinkingLevelMap),
  ...(row.declaredInputLimits ? { declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze(row.declaredInputLimits.images.resize) }) }) } : {}),
})));
const profiles = new Map(TOGETHER_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function togetherProfile(model: string): TogetherProfile { const profile = profiles.get(model); if (!profile) throw new Error('Together chat model is not supported.'); return profile; }
export function prepareTogetherChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const profile = togetherProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Together thinking level.');
  const selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
  delete body.reasoning_effort; delete body.reasoning; delete body.thinking; delete body.store; delete body.tool_stream; delete body.max_completion_tokens;
  delete body.prompt_cache_key; delete body.prompt_cache_retention; delete body.chat_template_args; delete body.chat_template_kwargs;
  if (profile.reasoning && profile.thinkingFormat === 'together') body.reasoning = { enabled: selected !== 'off' };
  if (profile.reasoning && profile.supportsReasoningEffort && selected !== 'off') body.reasoning_effort = profile.thinkingLevelMap[selected];
  if (options?.maxTokens !== undefined) { if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid Together output limit.'); body.max_tokens = options.maxTokens; }
  else delete body.max_tokens;
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message)) {
    if (message.role === 'developer') message.role = 'system';
    if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Together chat model does not support images.');
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) delete tool.function.strict;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function togetherUsage(value: unknown, model: string): ChatResponse['usage'] {
  const usage = openRouterUsage(value, togetherProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), costUsd: usage.costUsd };
}
export function togetherReasoning(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Together chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)) throw new Error('Unsupported Together reasoning replay.');
  return fields.map(field => value[field]).find((text): text is string => typeof text === 'string' && text.length > 0);
}
const validFinish = (value: unknown) => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateTogetherChat(value: unknown): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message) || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)) throw new Error('Invalid Together chat response.');
  togetherReasoning(value.choices[0].message);
}
export function togetherStreamValidator(): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Together chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Together chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Together chat response.');
    togetherReasoning(choice.delta); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Together chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Together chat response.'); finished = true; }
  };
}
