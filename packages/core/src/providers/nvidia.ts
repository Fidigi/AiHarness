import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface NvidiaProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly declaredPricing: Readonly<Required<ModelPricing>>;
  readonly pricing?: Readonly<Required<ModelPricing>>;
  readonly thinkingFormat?: 'deepseek';
  readonly requiresReasoningContent: boolean;
  readonly supportsReasoningEffort: false;
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Reviewed nvidia.json catalogue projection; nineteen zero-only tables remain unpriced.
const reviewed: readonly NvidiaProfile[] = [{"id":"deepseek-ai/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","api":"openai-completions","contextWindow":1000000,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"thinkingFormat":"deepseek","requiresReasoningContent":true,"supportsReasoningEffort":false,"thinkingLevelMap":{"minimal":null,"low":null,"medium":null,"high":"high","max":"max"},"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"google/diffusiongemma-26b-a4b-it","name":"DiffusionGemma 26B A4B IT","api":"openai-completions","contextWindow":250000,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"google/gemma-3-12b-it","name":"Gemma 3 12B IT","api":"openai-completions","contextWindow":131072,"maxOutputTokens":16384,"reasoning":false,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"google/gemma-3-4b-it","name":"Gemma 3 4B IT","api":"openai-completions","contextWindow":131072,"maxOutputTokens":16384,"reasoning":false,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"meta/llama-3.2-11b-vision-instruct","name":"Llama 3.2 11b Vision Instruct","api":"openai-completions","contextWindow":128000,"maxOutputTokens":4096,"reasoning":false,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"meta/llama-3.2-90b-vision-instruct","name":"Llama-3.2-90B-Vision-Instruct","api":"openai-completions","contextWindow":128000,"maxOutputTokens":8192,"reasoning":false,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"meta/muse-glimmer-30b","name":"Muse Glimmer 30B","api":"openai-completions","contextWindow":131072,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"mistralai/mistral-7b-instruct-v0.3","name":"Mistral-7B-Instruct-v0.3","api":"openai-completions","contextWindow":65536,"maxOutputTokens":65536,"reasoning":false,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"moonshotai/kimi-k2.6","name":"Kimi K2.6","api":"openai-completions","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"moonshotai/kimi-k3","name":"Kimi K3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"nvidia/cosmos-reason2-8b","name":"Cosmos Reason2 8B","api":"openai-completions","contextWindow":131072,"maxOutputTokens":16384,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"nvidia/llama-3.1-nemotron-70b-instruct","name":"Llama 3.1 Nemotron 70B Instruct","api":"openai-completions","contextWindow":128000,"maxOutputTokens":8192,"reasoning":false,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"nvidia/llama-3.1-nemotron-ultra-253b-v1","name":"Llama 3.1 Nemotron Ultra 253B","api":"openai-completions","contextWindow":128000,"maxOutputTokens":16384,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning","name":"Nemotron 3 Nano Omni","api":"openai-completions","contextWindow":256000,"maxOutputTokens":65536,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},{"id":"nvidia/nemotron-3-super-120b-a12b","name":"Nemotron 3 Super","api":"openai-completions","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0.2,"outputPerMillion":0.8,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"pricing":{"inputPerMillion":0.2,"outputPerMillion":0.8,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"nvidia/nemotron-3-ultra-550b-a55b","name":"Nemotron 3 Ultra 550B A55B","api":"openai-completions","contextWindow":1000000,"maxOutputTokens":65536,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0.5,"outputPerMillion":2.5,"cacheReadPerMillion":0.15,"cacheWritePerMillion":0},"pricing":{"inputPerMillion":0.5,"outputPerMillion":2.5,"cacheReadPerMillion":0.15,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"nvidia/nemotron-3.5-lightning-30b-a3b","name":"Nemotron 3.5 Lightning 30B A3B","api":"openai-completions","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"openai/gpt-oss-20b","name":"GPT OSS 20B","api":"openai-completions","contextWindow":131072,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"poolside/laguna-xs-2.1","name":"Laguna XS 2.1","api":"openai-completions","contextWindow":262144,"maxOutputTokens":16384,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"z-ai/glm-5.3","name":"GLM-5.3","api":"openai-completions","contextWindow":1000000,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false},{"id":"z-ai/glm-5.3-flash","name":"GLM-5.3-Flash","api":"openai-completions","contextWindow":1000000,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"declaredPricing":{"inputPerMillion":0,"outputPerMillion":0,"cacheReadPerMillion":0,"cacheWritePerMillion":0},"requiresReasoningContent":false,"supportsReasoningEffort":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}}];
export const NVIDIA_MODELS: readonly NvidiaProfile[] = Object.freeze(reviewed.map(row => Object.freeze({ ...row,
  declaredInput: Object.freeze([...row.declaredInput]), declaredPricing: Object.freeze({ ...row.declaredPricing }),
  ...(row.pricing ? { pricing: Object.freeze({ ...row.pricing }) } : {}),
  ...(row.thinkingLevelMap ? { thinkingLevelMap: Object.freeze({ ...row.thinkingLevelMap }) } : {}),
  ...(row.declaredInputLimits ? { declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ ...row.declaredInputLimits.images.resize }) }) }) } : {}),
})));
const profiles = new Map(NVIDIA_MODELS.map(profile => [profile.id, profile]));
const levels: readonly PublishedThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function nvidiaProfile(model: string): NvidiaProfile {
  const profile = profiles.get(model); if (!profile) throw new Error('Nvidia chat model is not supported.'); return profile;
}
export function prepareNvidiaChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const profile = nvidiaProfile(String(body.model)), requested = options?.thinking ?? 'off';
  if (!levels.includes(requested)) throw new Error('Invalid Nvidia thinking level.');
  const selected = clampPublishedThinkingLevel(requested, levels.filter(level => (profile.reasoning || level === 'off') && profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined)));
  delete body.thinking;
  if (profile.thinkingFormat === 'deepseek') body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
  delete body.reasoning_effort;
  const maxTokens = options?.maxTokens ?? profile.maxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > profile.maxOutputTokens) throw new Error('Invalid Nvidia output limit.');
  delete body.max_completion_tokens; body.max_tokens = maxTokens;
  delete body.store; delete body.prompt_cache_key; delete body.prompt_cache_retention; delete body.tool_stream;
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.messages)) {
    const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
    for (const message of body.messages) {
      if (!record(message)) continue;
      if (message.role === 'developer') message.role = 'system';
      if (message.role === 'assistant') {
        const reasoning = history[assistant++]?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).filter(text => text.trim()).join('\n');
        if (reasoning || profile.requiresReasoningContent) message.reasoning_content = reasoning ?? '';
      }
      if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Nvidia chat model does not support images.');
    }
    body.messages = body.messages.filter(message => !record(message) || message.role !== 'assistant' || message.content || message.tool_calls);
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) delete tool.function.strict;
  if (body.tools === undefined && messages.some(message => message.role === 'assistant' && message.toolCalls?.length)) body.tools = [];
  return body;
}
export function nvidiaUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value) || typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number' || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined;
  const usage = openRouterUsage(value, nvidiaProfile(model).pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) };
}
export function nvidiaReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined;
  const fields = nativeReplay ? ['reasoning_content', 'reasoning', 'reasoning_text'] : ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_summary'];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string')
    || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Nvidia chat response.');
  if (!nativeReplay && value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)) throw new Error('Unsupported Nvidia reasoning replay.');
  return fields.map(field => value[field]).find((value): value is string => typeof value === 'string' && value.length > 0);
}
const validFinish = (value: unknown): boolean => ['stop', 'end', 'length', 'tool_calls', 'function_call'].includes(String(value));
export function validateNvidiaChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !validFinish(value.choices[0].finish_reason)
    || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Nvidia chat response.');
  nvidiaReasoning(value.choices[0].message, nativeReplay);
}
export function nvidiaStreamValidator(nativeReplay = false): (value?: unknown) => void {
  let finished = false;
  return value => {
    if (value === undefined) { if (!finished) throw new Error('Invalid Nvidia chat response.'); return; }
    if (!record(value) || !Array.isArray(value.choices)) throw new Error('Invalid Nvidia chat response.');
    const choice = value.choices[0]; if (choice === undefined) return;
    if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Nvidia chat response.');
    nvidiaReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Nvidia chat response.');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!validFinish(choice.finish_reason)) throw new Error('Invalid Nvidia chat response.'); finished = true; }
  };
}
