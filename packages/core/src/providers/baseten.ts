import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface BasetenProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly thinkingFormat: 'openai' | 'baseten';
  readonly supportsReasoningEffort: boolean;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Reviewed pinned Baseten declarations; image limits do not implement a resizing pipeline.
export const BASETEN_MODELS: readonly BasetenProfile[] = Object.freeze([
  {"id":"deepseek-ai/DeepSeek-V4-Flash-0731","name":"DeepSeek V4 Flash 0731","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.13,"outputPerMillion":0.26,"cacheReadPerMillion":0.028,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true},
  {"id":"deepseek-ai/DeepSeek-V4-Pro","name":"DeepSeek V4 Pro","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.74,"outputPerMillion":3.48,"cacheReadPerMillion":0.145,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true},
  {"id":"deepseek-ai/DeepSeek-V4-Pro-0813","name":"DeepSeek V4 Pro 0813","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.32,"outputPerMillion":3.96,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true},
  {"id":"deepseek-ai/DeepSeek-V4.1-Flash","name":"DeepSeek V4.1 Flash","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.03,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"deepseek-ai/DeepSeek-V4.1-Flash-Fast","name":"DeepSeek V4.1 Flash Fast","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.6,"outputPerMillion":2.4,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"moonshotai/Kimi-K2.5","name":"Kimi K2.5","api":"openai-completions","contextWindow":262000,"maxOutputTokens":262000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.6,"outputPerMillion":3,"cacheReadPerMillion":0.12,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"moonshotai/Kimi-K2.6","name":"Kimi K2.6","api":"openai-completions","contextWindow":262000,"maxOutputTokens":262000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.95,"outputPerMillion":4,"cacheReadPerMillion":0.16,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"moonshotai/Kimi-K2.7-Code","name":"Kimi K2.7 Code","api":"openai-completions","contextWindow":262000,"maxOutputTokens":262000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.95,"outputPerMillion":4,"cacheReadPerMillion":0.16,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"moonshotai/Kimi-K3","name":"Kimi K3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"nvidia/Nemotron-120B-A12B","name":"Nemotron Super","api":"openai-completions","contextWindow":202800,"maxOutputTokens":202800,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":0.75,"cacheReadPerMillion":0.06,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false},
  {"id":"nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B","name":"Nemotron Ultra","api":"openai-completions","contextWindow":202800,"maxOutputTokens":202800,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.6,"outputPerMillion":2.4,"cacheReadPerMillion":0.12,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false},
  {"id":"openai/gpt-oss-120b","name":"OpenAI GPT 120B","api":"openai-completions","contextWindow":128072,"maxOutputTokens":128072,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.1,"outputPerMillion":0.5,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true},
  {"id":"thinkingmachines/inkling","name":"Inkling","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":1,"outputPerMillion":4.05,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"thinkingmachines/inkling-small","name":"Inkling Small","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.5,"outputPerMillion":1.2,"cacheReadPerMillion":0.1,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"zai-org/GLM-4.7","name":"GLM 4.7","api":"openai-completions","contextWindow":200000,"maxOutputTokens":200000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.6,"outputPerMillion":2.2,"cacheReadPerMillion":0.12,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false},
  {"id":"zai-org/GLM-5","name":"GLM 5","api":"openai-completions","contextWindow":202800,"maxOutputTokens":202800,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.95,"outputPerMillion":3.15,"cacheReadPerMillion":0.2,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false},
  {"id":"zai-org/GLM-5.1","name":"GLM 5.1","api":"openai-completions","contextWindow":202800,"maxOutputTokens":202800,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.3,"outputPerMillion":4.3,"cacheReadPerMillion":0.26,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":null},"thinkingFormat":"baseten","supportsReasoningEffort":false},
  {"id":"zai-org/GLM-5.2","name":"GLM 5.2","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.4,"outputPerMillion":4.4,"cacheReadPerMillion":0.3,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"baseten","supportsReasoningEffort":true},
  {"id":"zai-org/GLM-5.2-Fast","name":"GLM 5.2 Fast","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":2.1,"outputPerMillion":6.6,"cacheReadPerMillion":0.21,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":null,"medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"baseten","supportsReasoningEffort":true},
  {"id":"zai-org/GLM-5.3","name":"GLM 5.3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":1.4,"outputPerMillion":4.4,"cacheReadPerMillion":0.14,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"zai-org/GLM-5.3-Fast","name":"GLM 5.3 Fast","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":2.1,"outputPerMillion":6.6,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"zai-org/GLM-5.3-Flash","name":"GLM 5.3 Flash","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.15,"outputPerMillion":0.5,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingFormat":"openai","supportsReasoningEffort":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
].map(row => Object.freeze({ ...row, api: 'openai-completions' as const, thinkingFormat: row.thinkingFormat as BasetenProfile['thinkingFormat'],
  declaredInput: Object.freeze(row.declaredInput as ('text' | 'image')[]), pricing: Object.freeze(row.pricing), thinkingLevelMap: Object.freeze(row.thinkingLevelMap),
  ...(row.declaredInputLimits ? { declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze(row.declaredInputLimits.images.resize) }) }) } : {}),
})));
const profiles = new Map(BASETEN_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function basetenProfile(model: string): BasetenProfile { const profile = profiles.get(model); if (!profile) throw new Error('Baseten chat model is not supported.'); return profile; }
export function prepareBasetenChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const profile = basetenProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Baseten thinking level.');
  const selected = clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
  delete body.reasoning_effort; delete body.reasoning; delete body.thinking; delete body.store; delete body.tool_stream; delete body.max_completion_tokens;
  delete body.prompt_cache_key; delete body.prompt_cache_retention; delete body.chat_template_args; delete body.chat_template_kwargs;
  if (profile.thinkingFormat === 'baseten') body.chat_template_args = { enable_thinking: selected !== 'off' };
  if (profile.supportsReasoningEffort) body.reasoning_effort = profile.thinkingLevelMap[selected];
  if (options?.maxTokens !== undefined) { if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid Baseten output limit.'); body.max_tokens = options.maxTokens; }
  else delete body.max_tokens;
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message)) {
    if (message.role === 'developer') message.role = 'system';
    if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Baseten chat model does not support images.');
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function basetenUsage(value: unknown, model: string): ChatResponse['usage'] {
  const usage = openRouterUsage(value, basetenProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), costUsd: usage.costUsd };
}
export function basetenReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = ['reasoning_content', 'reasoning', 'reasoning_text'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Baseten chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !nativeReplay && value.reasoning_details.length)) throw new Error('Unsupported Baseten reasoning replay.');
  return fields.map(field => value[field]).find((text): text is string => typeof text === 'string' && text.length > 0);
}
const validFinish = (value: unknown) => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateBasetenChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message) || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)) throw new Error('Invalid Baseten chat response.');
  basetenReasoning(value.choices[0].message, nativeReplay);
}
export function basetenStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Baseten chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Baseten chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Baseten chat response.');
    basetenReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Baseten chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Baseten chat response.'); finished = true; }
  };
}
