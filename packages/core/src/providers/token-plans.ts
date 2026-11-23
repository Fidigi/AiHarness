import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { clampPublishedThinkingLevel, PUBLISHED_THINKING_LEVELS, type PublishedThinkingLevel } from './model-metadata.js';
import { openRouterUsage } from './openrouter-usage.js';

export type TokenPlanId = 'qwen-token-plan' | 'qwen-token-plan-cn' | 'qwen-token-plan-individual'
  | 'xiaomi-token-plan-ams' | 'xiaomi-token-plan-cn' | 'xiaomi-token-plan-sgp' | 'zai-coding-cn';
type Efforts = Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
export interface TokenPlanProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly pricing?: Readonly<Required<ModelPricing>>;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly thinkingLevelMap?: Efforts;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
const high: Efforts = Object.freeze({ off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' });
const lowHigh: Efforts = Object.freeze({ ...high, low: 'low' });
const optionalOff: Efforts = Object.freeze({ minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' });
const qwenEfforts: Efforts = Object.freeze({ off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null });
const resize = Object.freeze({ images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 }) }) });
function profile(id: string, name: string, contextWindow: number, maxOutputTokens: number, image: boolean, thinkingLevelMap?: Efforts, pricing?: Required<ModelPricing>): TokenPlanProfile {
  return Object.freeze({ id, name, api: 'openai-completions', contextWindow, maxOutputTokens, reasoning: true,
    declaredInput: Object.freeze(image ? ['text', 'image'] as const : ['text'] as const),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}), ...(image ? { declaredInputLimits: resize } : {}),
    ...(pricing ? { pricing: Object.freeze({ ...pricing }) } : {}) });
}
// Pinned1.2.0 declarations. Zero-only subscription price tables stay unknown, not free.
const qwen = Object.freeze([
  profile('deepseek-v3.2', 'DeepSeek V3.2', 131072, 65536, false),
  profile('deepseek-v4-flash', 'DeepSeek V4 Flash', 1000000, 384000, false, high),
  profile('deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731', 1000000, 384000, false, high),
  profile('deepseek-v4-pro', 'DeepSeek V4 Pro', 1000000, 384000, false, high),
  profile('deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', 1000000, 384000, false, high),
  profile('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 1000000, 384000, true, lowHigh),
  profile('glm-5', 'GLM-5', 202752, 16384, false, optionalOff),
  profile('glm-5.1', 'GLM-5.1', 202752, 128000, false, optionalOff),
  profile('glm-5.2', 'GLM-5.2', 1000000, 131072, false, high),
  profile('glm-5.3', 'GLM-5.3', 1000000, 131072, false, lowHigh),
  profile('kimi-k2.5', 'Kimi K2.5', 262144, 98304, true),
  profile('kimi-k2.6', 'Kimi K2.6', 262144, 262144, true),
  profile('kimi-k2.7-code', 'Kimi K2.7 Code', 262144, 262144, true),
  profile('MiniMax-M2.5', 'MiniMax-M2.5', 196608, 32768, false),
  profile('qwen3.6-flash', 'Qwen3.6 Flash', 1000000, 65536, true),
  profile('qwen3.6-plus', 'Qwen3.6 Plus', 1000000, 65536, true),
  profile('qwen3.7-max', 'Qwen3.7 Max', 1000000, 131072, false),
  profile('qwen3.7-plus', 'Qwen3.7 Plus', 1000000, 65536, true),
  profile('qwen3.8-flash', 'Qwen3.8 Flash', 1000000, 131072, true, qwenEfforts),
  profile('qwen3.8-max', 'Qwen3.8 Max', 1000000, 131072, true, qwenEfforts),
]);
const individual = new Set(['deepseek-v4-flash-0731', 'deepseek-v4-pro', 'deepseek-v4-pro-0813', 'glm-5.2',
  'qwen3.6-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max']);
const xiaomi = Object.freeze([
  profile('mimo-v2.5', 'MiMo-V2.5', 1048576, 131072, true),
  profile('mimo-v2.5-pro', 'MiMo-V2.5-Pro', 1048576, 131072, false),
  profile('mimo-v2.6-flash', 'MiMo-V2.6-Flash', 1048576, 131072, true),
  profile('mimo-v2.6-pro', 'MiMo-V2.6-Pro', 1048576, 131072, true),
]);
const zai = Object.freeze([
  profile('glm-4.6v', 'GLM-4.6V', 128000, 32768, true, undefined, { inputPerMillion: 0.3, outputPerMillion: 0.9, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }),
  profile('glm-5.3', 'GLM-5.3', 1000000, 131072, false, lowHigh, { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 }),
  profile('glm-5.3-flash', 'GLM-5.3-Flash', 1000000, 131072, true, lowHigh, { inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0 }),
  profile('glm-5.3-highspeed', 'GLM-5.3 Highspeed', 1000000, 131072, false, lowHigh),
]);
export const TOKEN_PLAN_MODELS: Readonly<Record<TokenPlanId, readonly TokenPlanProfile[]>> = Object.freeze({
  'qwen-token-plan': qwen, 'qwen-token-plan-cn': qwen,
  'qwen-token-plan-individual': Object.freeze(qwen.filter(row => individual.has(row.id))),
  'xiaomi-token-plan-ams': xiaomi, 'xiaomi-token-plan-cn': xiaomi, 'xiaomi-token-plan-sgp': xiaomi, 'zai-coding-cn': zai,
});
export const TOKEN_PLAN_BASE_URLS: Readonly<Record<TokenPlanId, string>> = Object.freeze({
  'qwen-token-plan': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'qwen-token-plan-individual': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'qwen-token-plan-cn': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  'xiaomi-token-plan-ams': 'https://token-plan-ams.xiaomimimo.com/v1',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
  'xiaomi-token-plan-sgp': 'https://token-plan-sgp.xiaomimimo.com/v1',
  'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
});
export function tokenPlanProfile(plan: TokenPlanId, model: string): TokenPlanProfile {
  const found = TOKEN_PLAN_MODELS[plan]?.find(row => row.id === model);
  if (!found) throw new Error('Token-plan chat model is not supported.');
  return found;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function prepareTokenPlanChat(body: Record<string, unknown>, plan: TokenPlanId, options?: ChatOptions): Record<string, unknown> {
  const profile = tokenPlanProfile(plan, String(body.model)), requested = options?.thinking ?? 'off';
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid token-plan thinking level.');
  const levels = PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap ? profile.thinkingLevelMap[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap[level] !== undefined) : !['xhigh', 'max'].includes(level));
  const selected = clampPublishedThinkingLevel(requested, levels), on = selected !== 'off';
  const qwen = plan.startsWith('qwen-'), xiaomi = plan.startsWith('xiaomi-');
  delete body.reasoning_effort; delete body.thinking; delete body.store; delete body.max_tokens; delete body.max_completion_tokens;
  delete body.prompt_cache_key; delete body.prompt_cache_retention;
  if (xiaomi) body.store = false;
  if (qwen) body.enable_thinking = on;
  else body.thinking = { type: on ? 'enabled' : 'disabled', ...(!xiaomi && on ? { clear_thinking: false } : {}) };
  if (on && (xiaomi || profile.thinkingLevelMap)) body.reasoning_effort = profile.thinkingLevelMap?.[selected] ?? selected;
  if (!qwen && !xiaomi) body.tool_stream = true;
  if (options?.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid token-plan output limit.');
    body[!qwen && !xiaomi ? 'max_tokens' : 'max_completion_tokens'] = options.maxTokens;
  }
  if (body.stream) body.stream_options = { include_usage: true };
  if (options?.cacheRetention === 'long') {
    body.prompt_cache_retention = '24h';
    if (options.sessionId !== undefined) {
      if (typeof options.sessionId !== 'string' || Buffer.byteLength(options.sessionId) > 500 || /[\u0000-\u001f\u007f]/u.test(options.sessionId)) throw new Error('Invalid token-plan session identity.');
      if (options.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
    }
  }
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message)) {
    if (xiaomi && message.role === 'system') message.role = 'developer';
    if (!xiaomi && message.role === 'developer') message.role = 'system';
    if (message.reasoning_details !== undefined) throw new Error('Opaque token-plan replay is not supported.');
    if (xiaomi && message.role === 'assistant' && message.reasoning_content === undefined) message.reasoning_content = '';
    if (!profile.declaredInput.includes('image') && Array.isArray(message.content)
      && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Token-plan model does not support images.');
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  return body;
}
export function tokenPlanReasoning(value: unknown): string | undefined {
  if (!record(value) || value.refusal || value.content !== undefined && value.content !== null && typeof value.content !== 'string'
    || value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || value.reasoning_details.length)
    || ['reasoning_content', 'reasoning', 'reasoning_text'].some(key => value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string')) throw new Error('Invalid token-plan response.');
  return ['reasoning_content', 'reasoning', 'reasoning_text'].map(key => value[key]).find((item): item is string => typeof item === 'string' && item.length > 0);
}
export function validateTokenPlanResponse(value: unknown): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message)
    || value.choices[0].message.refusal || !['stop', 'length', 'tool_calls', 'function_call'].includes(String(value.choices[0].finish_reason))) throw new Error('Invalid token-plan response.');
  tokenPlanReasoning(value.choices[0].message);
}
export function tokenPlanStreamValidator(): (value?: unknown) => void {
  let terminal = false;
  return value => {
    if (value === undefined) { if (!terminal) throw new Error('Invalid token-plan response.'); return; }
    if (!record(value) || value.error) throw new Error('Invalid token-plan response.');
    if (Array.isArray(value.choices) && record(value.choices[0])) {
      const choice = value.choices[0];
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (!['stop', 'length', 'tool_calls', 'function_call'].includes(String(choice.finish_reason))) throw new Error('Invalid token-plan response.');
        terminal = true;
      }
      if (choice.delta !== undefined) tokenPlanReasoning(choice.delta);
    }
  };
}
export function tokenPlanUsage(value: unknown, profile: TokenPlanProfile): ChatResponse['usage'] {
  const usage = openRouterUsage(value, profile.pricing, 'openai-completions');
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined || usage.totalTokens === undefined) return undefined;
  return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }) };
}
export function tokenPlanHistory(messages: Message[], provider: string, model: string): void {
  for (const message of messages) if (message.role === 'assistant' && message.provider === provider && message.api === 'openai-completions' && message.model === model
    && message.blocks?.some(block => block.type === 'reasoning' && block.thinkingSignature
      && !['reasoning_content', 'reasoning', 'reasoning_text'].includes(block.thinkingSignature))) throw new Error('Opaque token-plan replay is not supported.');
}
