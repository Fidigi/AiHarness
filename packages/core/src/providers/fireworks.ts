import type { Message, ModelPricing, ProviderConfig } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { copyThinkingBudgets, resolveThinkingBudget } from './thinking-budgets.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';
import { ProviderContextOverflowError } from './context-overflow.js';
import { openRouterUsage } from './openrouter-usage.js';

export interface FireworksProfile {
  readonly id: string;
  readonly name: string;
  readonly api: 'anthropic-messages' | 'openai-completions';
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: true;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly pricing: Readonly<Required<ModelPricing>>;
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly thinkingMode: 'adaptive' | 'numeric' | 'effort';
  readonly requiresReasoningContent: boolean;
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
// Pinned Fireworks A/C policy; image resize is declarative, not normalized-media acceptance.
export const FIREWORKS_MODELS: readonly FireworksProfile[] = Object.freeze(([
  {"id":"accounts/fireworks/models/deepseek-v4p1-flash","name":"DeepSeek V4.1 Flash","api":"anthropic-messages","contextWindow":1000000,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.006,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"adaptive","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/models/ember-1","name":"Ember-1","api":"anthropic-messages","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":"max"},"thinkingMode":"adaptive","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/models/gpt-oss-120b","name":"GPT OSS 120B","api":"anthropic-messages","contextWindow":131072,"maxOutputTokens":32768,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.15,"outputPerMillion":0.6,"cacheReadPerMillion":0.015,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"adaptive","requiresReasoningContent":false},
  {"id":"accounts/fireworks/models/inkling","name":"Inkling","api":"anthropic-messages","contextWindow":1048576,"maxOutputTokens":1048576,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":1,"outputPerMillion":4.05,"cacheReadPerMillion":0.17,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"numeric","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/models/minimax-m3","name":"MiniMax-M3","api":"anthropic-messages","contextWindow":512000,"maxOutputTokens":512000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.06,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"adaptive","requiresReasoningContent":false},
  {"id":"accounts/fireworks/models/nemotron-3-ultra-nvfp4","name":"Nemotron 3 Ultra 550B A55B","api":"anthropic-messages","contextWindow":262144,"maxOutputTokens":128000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.6,"outputPerMillion":2.4,"cacheReadPerMillion":0.12,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"numeric","requiresReasoningContent":false},
  {"id":"accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b","name":"Nemotron 3.5 Lightning 30B A3B","api":"anthropic-messages","contextWindow":262144,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.05,"outputPerMillion":0.2,"cacheReadPerMillion":0.01,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"numeric","requiresReasoningContent":false},
  {"id":"accounts/fireworks/models/qwen3p8-2p4t-a95b","name":"Qwen3.8 2.4T A95B","api":"anthropic-messages","contextWindow":262144,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":2,"outputPerMillion":6,"cacheReadPerMillion":0.25,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":null,"xhigh":"xhigh","max":null},"thinkingMode":"adaptive","requiresReasoningContent":false},
  {"id":"accounts/fireworks/models/qwen3p8-max","name":"Qwen3.8 Max","api":"anthropic-messages","contextWindow":262144,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":2,"outputPerMillion":6,"cacheReadPerMillion":0.25,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":null,"xhigh":"xhigh","max":null},"thinkingMode":"adaptive","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/routers/deepseek-flash-latest","name":"DeepSeek Flash Latest","api":"anthropic-messages","contextWindow":1000000,"maxOutputTokens":384000,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.006,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"adaptive","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/routers/kimi-fast-latest","name":"Kimi Fast Latest","api":"anthropic-messages","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":4.5,"outputPerMillion":22.5,"cacheReadPerMillion":0.45,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":"max"},"thinkingMode":"adaptive","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/routers/kimi-latest","name":"Kimi Latest","api":"anthropic-messages","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"none","minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":"max"},"thinkingMode":"adaptive","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/routers/minimax-latest","name":"MiniMax Latest","api":"anthropic-messages","contextWindow":512000,"maxOutputTokens":512000,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":0.3,"outputPerMillion":1.2,"cacheReadPerMillion":0.06,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"adaptive","requiresReasoningContent":false},
  {"id":"accounts/fireworks/routers/qwen-max-latest","name":"Qwen Max Latest (Qwen3.8 Max)","api":"anthropic-messages","contextWindow":262144,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":2,"outputPerMillion":6,"cacheReadPerMillion":0.25,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":"off","minimal":"minimal","low":"low","medium":"medium","high":"high","xhigh":null,"max":null},"thinkingMode":"numeric","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/models/glm-5p3","name":"GLM 5.3","api":"openai-completions","contextWindow":1048573,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.4,"outputPerMillion":4.4,"cacheReadPerMillion":0.26,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":false},
  {"id":"accounts/fireworks/models/glm-5p3-flash","name":"GLM 5.3 Flash","api":"openai-completions","contextWindow":1048573,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.15,"outputPerMillion":0.5,"cacheReadPerMillion":0.03,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/models/kimi-k3","name":"Kimi K3","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":3,"outputPerMillion":15,"cacheReadPerMillion":0.3,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/routers/glm-5p3-fast","name":"GLM 5.3 Fast","api":"openai-completions","contextWindow":1048572,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":2.1,"outputPerMillion":6.6,"cacheReadPerMillion":0.39,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":false},
  {"id":"accounts/fireworks/routers/glm-fast-latest","name":"GLM 5.3 Fast (Latest)","api":"openai-completions","contextWindow":1048572,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":2.1,"outputPerMillion":6.6,"cacheReadPerMillion":0.39,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":false},
  {"id":"accounts/fireworks/routers/glm-flash-latest","name":"GLM Flash Latest (GLM 5.3 Flash)","api":"openai-completions","contextWindow":1048573,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":0.15,"outputPerMillion":0.5,"cacheReadPerMillion":0.03,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":false,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
  {"id":"accounts/fireworks/routers/glm-latest","name":"GLM Latest","api":"openai-completions","contextWindow":1048573,"maxOutputTokens":262144,"reasoning":true,"declaredInput":["text"],"pricing":{"inputPerMillion":1.4,"outputPerMillion":4.4,"cacheReadPerMillion":0.26,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":false},
  {"id":"accounts/fireworks/routers/kimi-k3-fast","name":"Kimi K3 Fast","api":"openai-completions","contextWindow":1048576,"maxOutputTokens":131072,"reasoning":true,"declaredInput":["text","image"],"pricing":{"inputPerMillion":4.5,"outputPerMillion":22.5,"cacheReadPerMillion":0.45,"cacheWritePerMillion":0},"thinkingLevelMap":{"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"},"thinkingMode":"effort","requiresReasoningContent":true,"declaredInputLimits":{"images":{"resize":{"maxWidth":2000,"maxHeight":2000,"maxBytes":4718592,"jpegQuality":80}}}},
] satisfies FireworksProfile[]).map((row: FireworksProfile) => Object.freeze({ ...row, declaredInput: Object.freeze([...row.declaredInput]), pricing: Object.freeze({ ...row.pricing }),
  thinkingLevelMap: Object.freeze({ ...row.thinkingLevelMap }), ...(row.declaredInputLimits ? { declaredInputLimits: Object.freeze({ images: Object.freeze({ resize: Object.freeze({ ...row.declaredInputLimits.images.resize }) }) }) } : {}) })));
const profiles = new Map(FIREWORKS_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaults = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;
export function fireworksProfile(model: string): FireworksProfile { const profile = profiles.get(model); if (!profile) throw new Error('Fireworks chat model is not supported.'); return profile; }
export function fireworksBase(baseUrl: string): string {
  try { const url = new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    let path = url.pathname.replace(/\/+$/u, '').replace(/\/(?:messages|chat\/completions)$/u, '');
    if (!/\/v\d+$/u.test(path)) path += '/v1'; url.pathname = path; return url.href;
  } catch { throw new Error('Invalid Fireworks endpoint.'); }
}
export function fireworksThinking(model: string, options?: ChatOptions): PublishedThinkingLevel {
  const requested = options?.thinking ?? 'off', profile = fireworksProfile(model);
  if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid Fireworks thinking level.');
  return clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap[level] !== null));
}
function explicitLimit(profile: FireworksProfile, options?: ChatOptions): number | undefined {
  const maximum = options?.maxTokens; if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > profile.maxOutputTokens)) throw new Error('Invalid Fireworks output limit.'); return maximum;
}
export function prepareFireworksMessage(body: Record<string, unknown>, options?: ChatOptions, nativeReplay = false): Record<string, unknown> {
  const model = String(body.model), profile = fireworksProfile(model), level = fireworksThinking(model, options);
  if (profile.api !== 'anthropic-messages') throw new Error('Fireworks chat model is not supported.');
  const maximum = explicitLimit(profile, options) ?? profile.maxOutputTokens; body.max_tokens = maximum; delete body.output_config;
  if (level === 'off') body.thinking = { type: 'disabled' };
  else if (profile.thinkingMode === 'adaptive') { body.thinking = { type: 'adaptive', display: 'summarized' }; body.output_config = { effort: profile.thinkingLevelMap[level] ?? level }; }
  else { const numericLevel = level as keyof typeof defaults, budget = Math.min(resolveThinkingBudget(numericLevel, options?.thinkingBudgets, defaults[numericLevel], 1024, profile.maxOutputTokens), maximum - 1024); if (budget < 1024) throw new Error('Invalid Fireworks output limit.'); body.thinking = { type: 'enabled', budget_tokens: budget, display: 'summarized' }; }
  if (level !== 'off') delete body.temperature;
  for (const field of ['max_completion_tokens','reasoning_effort','reasoning','store','prompt_cache_key','prompt_cache_retention','chat_template_args','chat_template_kwargs','tool_stream']) delete body[field];
  const control = options?.cacheRetention === 'none' ? undefined : { type: 'ephemeral' };
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system, ...(control ? { cache_control: control } : {}) }];
  else if (Array.isArray(body.system)) for (const block of body.system) if (record(block)) { delete block.cache_control; if (control) block.cache_control = control; }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool)) {
    if (nativeReplay) { const schema = record(tool.input_schema) ? tool.input_schema : {}; tool.input_schema = { type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] }; }
    for (const field of ['strict','eager_input_streaming','cache_control']) delete tool[field];
  }
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message) && Array.isArray(message.content)) for (const block of message.content) if (record(block) && block.cache_control) { if (control) block.cache_control = control; else delete block.cache_control; }
  return body;
}
/** Exact SDK caps and conservative native admission; not Pi context estimation or cap-expansion equivalence. */
export function prepareFireworksOutputBudget(owned: ChatOptions, configuredModel: string): Readonly<PreparedNativeOutputBudget> {
  const options: ChatOptions = { ...owned, model: owned.model ?? configuredModel };
  try { const profile = fireworksProfile(options.model!); if (profile.thinkingMode === 'numeric' && fireworksThinking(profile.id, options) !== 'off') {
      try { options.thinkingBudgets = copyThinkingBudgets(options.thinkingBudgets); } catch { throw new ProviderOutputBudgetError('thinking'); }
    }
    if (profile.api === 'anthropic-messages') { const body = prepareFireworksMessage({ model: profile.id }, options); options.maxTokens = body.max_tokens as number; }
    return Object.freeze({ options, maxTokens: explicitLimit(profile, options) ?? profile.maxOutputTokens });
  } catch (error) { if (error instanceof ProviderOutputBudgetError) throw error; throw new ProviderOutputBudgetError(); }
}
export function prepareFireworksChat(body: Record<string, unknown>, options?: ChatOptions, messages: Message[] = []): Record<string, unknown> {
  const model = String(body.model), profile = fireworksProfile(model), level = fireworksThinking(model, options);
  if (profile.api !== 'openai-completions') throw new Error('Fireworks chat model is not supported.');
  for (const field of ['max_tokens','max_completion_tokens','thinking','output_config','reasoning','store','prompt_cache_key','prompt_cache_retention','chat_template_args','chat_template_kwargs','tool_stream']) delete body[field];
  const maximum = explicitLimit(profile, options); if (maximum !== undefined) body.max_completion_tokens = maximum;
  body.reasoning_effort = profile.thinkingLevelMap[level] ?? level;
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  const history = messages.filter(message => message.role === 'assistant'); let assistant = 0;
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message)) {
    if (message.role === 'developer') message.role = 'system';
    if (message.role === 'assistant') { const reasoning = history[assistant++]?.blocks?.flatMap(block => block.type === 'reasoning' ? [block.text] : []).filter(text => text.trim()).join('\n'); if (reasoning || profile.requiresReasoningContent) message.reasoning_content = reasoning ?? ''; }
    if (!profile.declaredInput.includes('image') && Array.isArray(message.content) && message.content.some(part => record(part) && part.type === 'image_url')) throw new Error('Fireworks chat model does not support images.');
  }
  return body;
}
export function fireworksHeaders(config: ProviderConfig, options: ChatOptions | undefined, api: FireworksProfile['api']): Record<string, string> {
  const identity = options?.cacheRetention === 'none' ? undefined : options?.sessionId;
  if (identity !== undefined && (typeof identity !== 'string' || identity.length > 500 || /[^\u0020-\u007e]/u.test(identity))) throw new Error('Invalid Fireworks session identity.');
  try { const headers = new Headers(), descriptor = Object.getOwnPropertyDescriptor(config, 'customHeaders');
    if (identity) for (const name of api === 'anthropic-messages' ? ['x-session-affinity'] : ['session_id','x-client-request-id','x-session-affinity']) headers.set(name, identity);
    if (descriptor) { if (!('value' in descriptor)) throw new Error(); const raw: unknown = descriptor.value;
      if (raw !== undefined) { if (!record(raw)) throw new Error(); const entries = Object.entries(Object.getOwnPropertyDescriptors(raw)); if (entries.length > 256 || Reflect.ownKeys(raw).length !== entries.length) throw new Error(); let bytes = 0;
        for (const [name, value] of entries) { if (!('value' in value) || typeof value.value !== 'string' || value.value.length > 8000 || /[\r\n]/u.test(value.value) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u.test(name)) throw new Error(); bytes += Buffer.byteLength(name) + Buffer.byteLength(value.value); if (bytes > 64 * 1024) throw new Error(); headers.set(name, value.value); }
      }
    }
    headers.set('content-type', 'application/json'); headers.delete('api-key');
    if (api === 'anthropic-messages') { headers.delete('authorization'); headers.set('x-api-key', String(config.apiKey)); headers.set('anthropic-version', '2023-06-01'); const model = options?.model ?? config.model ?? FIREWORKS_MODELS[0].id; if (fireworksProfile(model).thinkingMode === 'numeric' && fireworksThinking(model, options) !== 'off' && !headers.has('anthropic-beta')) headers.set('anthropic-beta', 'interleaved-thinking-2025-05-14'); }
    else { headers.delete('x-api-key'); headers.delete('anthropic-version'); headers.delete('anthropic-beta'); headers.set('authorization', `Bearer ${config.apiKey}`); }
    return Object.fromEntries(headers.entries());
  } catch { throw new Error('Invalid Fireworks request headers.'); }
}
export function mergeFireworksUsage(previous: unknown, value: unknown, start: boolean): unknown {
  if (!record(value)) return previous;
  const merged: Record<string, unknown> = start ? { ...value } : record(previous) ? { ...previous } : {};
  if (!start) for (const field of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']) if (value[field] !== undefined && value[field] !== null) merged[field] = value[field];
  if (value.cache_creation !== undefined && value.cache_creation !== null) { if (!record(value.cache_creation)) merged.cache_creation = value.cache_creation; else if (value.cache_creation.ephemeral_1h_input_tokens !== undefined && value.cache_creation.ephemeral_1h_input_tokens !== null) merged.cache_creation = { ...(record(merged.cache_creation) ? merged.cache_creation : {}), ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens }; }
  return merged;
}
export function fireworksUsage(value: unknown, model: string): ChatResponse['usage'] {
  const profile = fireworksProfile(model); if (!record(value)) return undefined;
  if (profile.api === 'openai-completions') { if (typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number' || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) return undefined; const usage = openRouterUsage(value, profile.pricing, 'openai-completions'); if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined; return { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens, totalTokens: usage.totalTokens!, ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }), ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }), ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }) }; }
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = token(value.input_tokens), output = token(value.output_tokens), read = value.cache_read_input_tokens === undefined ? 0 : token(value.cache_read_input_tokens), write = value.cache_creation_input_tokens === undefined ? 0 : token(value.cache_creation_input_tokens), creation = value.cache_creation, long = creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens === undefined ? 0 : token(creation.ephemeral_1h_input_tokens) : undefined;
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined || long > write || !Number.isSafeInteger(input + output + read + write)) return undefined;
  const pricing = profile.pricing; return { promptTokens: input, completionTokens: output, totalTokens: input + output + read + write, ...(value.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: read }), ...(value.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: write }), costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1e6 };
}
export function fireworksReasoning(value: unknown, nativeReplay = false): string | undefined {
  if (!record(value)) return undefined; const fields = ['reasoning_content','reasoning','reasoning_text', ...(nativeReplay ? [] : ['reasoning_summary'])];
  if (fields.some(field => value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') || (value.content !== undefined && value.content !== null && typeof value.content !== 'string')) throw new Error('Invalid Fireworks chat response.');
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !nativeReplay && value.reasoning_details.length)) throw new Error('Unsupported Fireworks reasoning replay.');
  return fields.map(field => value[field]).find((field): field is string => typeof field === 'string' && field.length > 0);
}
const aFinish = (value: unknown): boolean => ['end_turn','stop_sequence','tool_use','max_tokens'].includes(String(value));
const cFinish = (value: unknown): boolean => ['stop','end','length','tool_calls','function_call'].includes(String(value));
export function validateFireworksMessage(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || value.type === 'error' || !Array.isArray(value.content) || !aFinish(value.stop_reason) || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Fireworks chat response.');
  for (const block of value.content) { if (!record(block)) throw new Error('Invalid Fireworks chat response.'); if (block.type === 'text') { if (typeof block.text !== 'string') throw new Error('Invalid Fireworks chat response.'); } else if (block.type === 'thinking') { if (typeof block.thinking !== 'string' || (block.signature !== undefined && (typeof block.signature !== 'string' || !nativeReplay && block.signature !== ''))) throw new Error('Unsupported Fireworks reasoning replay.'); } else if (block.type === 'redacted_thinking' && nativeReplay) { if (typeof block.data !== 'string') throw new Error('Invalid Fireworks chat response.'); } else if (block.type === 'tool_use') { if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !record(block.input)) throw new Error('Invalid Fireworks chat response.'); } else throw new Error('Unsupported Fireworks reasoning replay.'); }
}
export function fireworksMessageText(content: unknown): string { return Array.isArray(content) ? content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : ''; }
export function validateFireworksChat(value: unknown, nativeReplay = false): void {
  if (!record(value) || value.error || !Array.isArray(value.choices) || !record(value.choices[0]) || !record(value.choices[0].message) || value.choices[0].message.refusal || !cFinish(value.choices[0].finish_reason) || (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model)))) throw new Error('Invalid Fireworks chat response.'); fireworksReasoning(value.choices[0].message, nativeReplay);
}
export function fireworksStreamValidator(api: FireworksProfile['api'], nativeReplay = false): (value?: unknown) => void {
  let started = false, stopped = false, finished = false;
  return value => {
    if (value === undefined) { if (!finished || (api === 'anthropic-messages' && (!started || !stopped))) throw new Error('Invalid Fireworks chat response.'); return; }
    if (!record(value)) throw new Error('Invalid Fireworks chat response.');
    if (api === 'openai-completions') { if (!Array.isArray(value.choices)) throw new Error('Invalid Fireworks chat response.'); const choice = value.choices[0]; if (choice === undefined) return; if (!record(choice) || finished || (choice.delta !== undefined && !record(choice.delta))) throw new Error('Invalid Fireworks chat response.'); fireworksReasoning(choice.delta, nativeReplay); if (record(choice.delta) && choice.delta.refusal) throw new Error('Invalid Fireworks chat response.'); if (choice.finish_reason !== undefined && choice.finish_reason !== null) { if (!cFinish(choice.finish_reason)) throw new Error('Invalid Fireworks chat response.'); finished = true; } return; }
    if (typeof value.type !== 'string' || (stopped && value.type !== 'ping')) throw new Error('Invalid Fireworks chat response.');
    if (value.type === 'message_start') { if (started || !record(value.message)) throw new Error('Invalid Fireworks chat response.'); started = true; }
    else if (value.type === 'message_delta') { if (!started || !record(value.delta)) throw new Error('Invalid Fireworks chat response.'); if (value.delta.stop_reason !== undefined && value.delta.stop_reason !== null) { if (!aFinish(value.delta.stop_reason)) throw new Error('Invalid Fireworks chat response.'); finished = true; } }
    else if (value.type === 'message_stop') { if (!started || !finished) throw new Error('Invalid Fireworks chat response.'); stopped = true; }
    else if (value.type === 'content_block_start') { const block = value.content_block; if (!started || !record(block) || !['text','thinking','tool_use'].includes(String(block.type)) && !(nativeReplay && block.type === 'redacted_thinking')) throw new Error('Invalid Fireworks chat response.'); if (block.type === 'thinking' && block.signature !== undefined && (typeof block.signature !== 'string' || !nativeReplay && block.signature !== '')) throw new Error('Unsupported Fireworks reasoning replay.'); }
    else if (value.type === 'content_block_delta') { const delta = value.delta; if (!started || !record(delta) || !['text_delta','thinking_delta','input_json_delta'].includes(String(delta.type)) && !(nativeReplay && delta.type === 'signature_delta')) throw new Error('Unsupported Fireworks reasoning replay.'); const field = delta.type === 'text_delta' ? 'text' : delta.type === 'thinking_delta' ? 'thinking' : delta.type === 'signature_delta' ? 'signature' : 'partial_json'; if (typeof delta[field] !== 'string') throw new Error('Invalid Fireworks chat response.'); }
    else if (!['ping','content_block_stop'].includes(value.type)) throw new Error('Invalid Fireworks chat response.');
  };
}
export function fireworksFailure(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new Error('Fireworks request aborted.'); if (error instanceof ProviderContextOverflowError) return new ProviderContextOverflowError();
  const fixed = ['Fireworks API key is required.','Fireworks chat model is not supported.','Invalid Fireworks thinking level.','Invalid Fireworks output limit.','Fireworks chat model does not support images.','Invalid Fireworks image input.','Invalid Fireworks request headers.','Invalid Fireworks session identity.','Invalid Fireworks chat response.','Unsupported Fireworks reasoning replay.'];
  return new Error(error instanceof Error && fixed.includes(error.message) ? error.message : 'Fireworks chat request failed.');
}
