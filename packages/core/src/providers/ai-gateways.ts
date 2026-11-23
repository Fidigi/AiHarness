import cloudflare from './data/cloudflare-ai-gateway.json' with { type: 'json' };
import vercel from './data/vercel-ai-gateway.json' with { type: 'json' };
import type { Message, ModelPricing, ProviderConfig } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel, type PublishedThinkingLevel } from './model-metadata.js';
import { numericContextTokens } from './anthropic-thinking.js';
import { copyThinkingBudgets } from './thinking-budgets.js';
import { ProviderOutputBudgetError, type PreparedNativeOutputBudget } from './provider-output-budget.js';

export type AiGatewayId = 'cloudflare-ai-gateway' | 'vercel-ai-gateway';
export type AiGatewayApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'typesafe-system-one';
export interface AiGatewayConfig extends ProviderConfig { accountId?: string; gatewayId?: string }
export interface AiGatewayProfile {
  readonly id: string; readonly name: string; readonly api: AiGatewayApi; readonly type: 'chat' | 'classifier';
  readonly reasoning: boolean; readonly contextWindow: number; readonly maxOutputTokens?: number;
  readonly declaredInput: readonly ('text' | 'image')[];
  readonly thinkingLevelMap?: Readonly<Partial<Record<PublishedThinkingLevel, string | null>>>;
  readonly compat: Readonly<Record<string, unknown>>;
  readonly pricing?: Readonly<Required<ModelPricing>>;
  readonly pricingTiers: readonly Readonly<Required<ModelPricing> & { inputTokensAbove: number }>[];
  readonly declaredInputLimits?: Readonly<{ images: Readonly<{ resize: Readonly<{ maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }> }> }>;
}
type RawCost = { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<RawCost & { inputTokensAbove: number }> };
type Raw = { id: string; name: string; api: AiGatewayApi; type: 'chat' | 'classifier'; reasoning?: boolean; input: ('text' | 'image')[];
  cost: RawCost; contextWindow: number; maxTokens?: number; compat?: Record<string, unknown>; thinkingLevelMap?: AiGatewayProfile['thinkingLevelMap']; inputLimits?: AiGatewayProfile['declaredInputLimits'] };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const price = (cost: RawCost): Required<ModelPricing> => ({ inputPerMillion: cost.input, outputPerMillion: cost.output, cacheReadPerMillion: cost.cacheRead, cacheWritePerMillion: cost.cacheWrite });
function profiles(data: unknown): readonly AiGatewayProfile[] {
  return freeze(Object.values(data as Record<string, Record<string, Raw>>).flatMap(rows => Object.values(rows)).map(row => ({ id: row.id, name: row.name, api: row.api, type: row.type,
    reasoning: row.reasoning === true, contextWindow: row.contextWindow, ...(row.maxTokens === undefined ? {} : { maxOutputTokens: row.maxTokens }),
    declaredInput: [...row.input], ...(row.thinkingLevelMap ? { thinkingLevelMap: { ...row.thinkingLevelMap } } : {}), compat: { ...row.compat },
    ...(Object.values(price(row.cost)).some(value => value > 0) ? { pricing: price(row.cost) } : {}),
    pricingTiers: (row.cost.tiers ?? []).map(tier => ({ inputTokensAbove: tier.inputTokensAbove, ...price(tier) })),
    ...(row.inputLimits ? { declaredInputLimits: structuredClone(row.inputLimits) } : {}) })));
}
const cf = profiles(cloudflare), vc = profiles(vercel);
export const CLOUDFLARE_AI_GATEWAY_MODELS = Object.freeze(cf.filter(model => model.type === 'chat'));
export const VERCEL_AI_GATEWAY_MODELS = Object.freeze(vc.filter(model => model.type === 'chat'));
export const VERCEL_AI_GATEWAY_CLASSIFIER_MODELS = Object.freeze(vc.filter(model => model.type === 'classifier').map(model => ({ id: model.id, name: model.name,
  type: 'classifier' as const, api: 'typesafe-system-one' as const, contextWindow: model.contextWindow, ...(model.pricing ? { pricing: model.pricing } : {}), imageInput: model.declaredInput.includes('image') })));
export function gatewayModels(gateway: AiGatewayId): readonly AiGatewayProfile[] { return gateway === 'cloudflare-ai-gateway' ? cf : vc; }
export function gatewayProfile(gateway: AiGatewayId, model: string): AiGatewayProfile {
  const profile = gatewayModels(gateway).find(profile => profile.id === model);
  if (!profile) throw new Error('Gateway model is not supported.'); return profile;
}
export function gatewayBase(gateway: AiGatewayId, config: AiGatewayConfig): string {
  let value = config.baseUrl;
  if (!value && gateway === 'cloudflare-ai-gateway') {
    if (!config.accountId || !config.gatewayId || ![config.accountId, config.gatewayId].every(value => /^[a-zA-Z0-9_-]{1,128}$/u.test(value))) throw new Error('Cloudflare account and gateway IDs are required.');
    value = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}`;
  }
  value ??= 'https://ai-gateway.vercel.sh';
  try {
    const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/u, '');
  } catch { throw new Error('Invalid gateway base URL.'); }
}
export function gatewayEndpoint(gateway: AiGatewayId, base: string, api: AiGatewayApi): string {
  if (gateway === 'cloudflare-ai-gateway') {
    if (api === 'anthropic-messages') return `${base}/anthropic/v1/messages`;
    if (api === 'openai-completions') return `${base}/compat/chat/completions`;
    if (api === 'openai-responses') return `${base}/openai/responses`;
  } else {
    if (api === 'anthropic-messages') return `${base}/v1/messages`;
    if (api === 'typesafe-system-one') return `${base}/typesafe/v1/systemone`;
  }
  throw new Error('Gateway API is not supported.');
}
export function gatewayThinking(profile: AiGatewayProfile, options?: ChatOptions): PublishedThinkingLevel {
  const requested = options?.thinking ?? 'off'; if (!PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid gateway thinking level.');
  if (!profile.reasoning || requested === 'off') return 'off';
  return clampPublishedThinkingLevel(requested, PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined)));
}
const defaults = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;
export function gatewayOutput(profile: AiGatewayProfile, options: ChatOptions = {}, messages: readonly Message[] = []): { maximum: number; budget?: number } {
  if (!profile.maxOutputTokens || profile.type !== 'chat') throw new Error('Gateway chat model is not supported.');
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens)) throw new Error('Invalid gateway output limit.');
  const available = Math.max(1, profile.contextWindow - numericContextTokens(messages, options) - 4096);
  let maximum = Math.min(options.maxTokens ?? profile.maxOutputTokens, available), budget: number | undefined;
  const level = gatewayThinking(profile, options);
  if (profile.api === 'anthropic-messages' && level !== 'off' && !profile.compat.forceAdaptiveThinking) {
    const numeric = level === 'xhigh' || level === 'max' ? 'high' : level;
    budget = copyThinkingBudgets(options.thinkingBudgets)?.[numeric] ?? defaults[numeric];
    maximum = Math.min(maximum + budget, profile.maxOutputTokens, available); budget = Math.min(budget, Math.max(0, maximum - 1024));
  }
  if (profile.api === 'openai-responses') maximum = Math.max(16, maximum);
  return { maximum, ...(budget === undefined ? {} : { budget }) };
}
export function prepareGatewayOutputBudget(gateway: AiGatewayId, configured: string, owned: ChatOptions, messages?: readonly Message[]): Readonly<PreparedNativeOutputBudget> {
  const options = { ...owned, model: owned.model || configured };
  try {
    if (options.thinkingBudgets) options.thinkingBudgets = copyThinkingBudgets(options.thinkingBudgets);
    return Object.freeze({ options, maxTokens: gatewayOutput(gatewayProfile(gateway, options.model), options, messages).maximum });
  } catch (error) { if (error instanceof ProviderOutputBudgetError) throw error; throw new ProviderOutputBudgetError(); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function prepareGatewayMessage(body: Record<string, unknown>, profile: AiGatewayProfile, options: ChatOptions | undefined, messages: readonly Message[]): Record<string, unknown> {
  const level = gatewayThinking(profile, options), output = gatewayOutput(profile, options, messages);
  body.max_tokens = output.maximum; delete body.thinking; delete body.output_config;
  if (profile.reasoning && level !== 'off') {
    body.thinking = profile.compat.forceAdaptiveThinking ? { type: 'adaptive', display: 'summarized' } : { type: 'enabled', budget_tokens: output.budget, display: 'summarized' };
    if (profile.compat.forceAdaptiveThinking) body.output_config = { effort: profile.thinkingLevelMap?.[level] ?? (level === 'minimal' ? 'low' : level) };
  } else if (profile.reasoning && profile.thinkingLevelMap?.off !== null) body.thinking = { type: 'disabled' };
  if (level !== 'off' || profile.compat.supportsTemperature === false) delete body.temperature;
  const system = [options?.systemPrompt, ...messages.filter(message => message.role === 'system').map(message => message.content)].filter(value => value?.trim()).join('\n\n');
  if (system) body.system = system; else delete body.system;
  const control = options?.cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(options?.cacheRetention === 'long' ? { ttl: '1h' } : {}) };
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system, ...(control ? { cache_control: control } : {}) }];
  if (Array.isArray(body.tools)) body.tools = body.tools.map((tool: Record<string, unknown>, index: number) => {
    const schema = record(tool.input_schema) ? tool.input_schema : {};
    const copy = { ...tool, input_schema: { type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] }, eager_input_streaming: true };
    delete (copy as Record<string, unknown>).strict;
    return { ...copy, ...(control && index === (body.tools as unknown[]).length - 1 ? { cache_control: control } : {}) };
  });
  if (control && Array.isArray(body.messages)) for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index]; if (!record(message) || message.role !== 'user') continue;
    if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content, cache_control: control }];
    else if (Array.isArray(message.content) && message.content.length) message.content = message.content.map((block, position, blocks) => position === blocks.length - 1 ? { ...block, cache_control: control } : block);
    break;
  }
  return body;
}
export function prepareGatewayCompletion(body: Record<string, unknown>, profile: AiGatewayProfile, options: ChatOptions | undefined, messages: readonly Message[]): Record<string, unknown> {
  const level = gatewayThinking(profile, options); for (const key of ['store', 'max_completion_tokens', 'reasoning_effort', 'thinking', 'prompt_cache_key', 'prompt_cache_retention']) delete body[key];
  body.max_tokens = gatewayOutput(profile, options, messages).maximum;
  if (profile.compat.thinkingFormat === 'deepseek') body.thinking = { type: level === 'off' ? 'disabled' : 'enabled' };
  if (body.stream) body.stream_options = { include_usage: true };
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool) && record(tool.function)) tool.function.strict = false;
  if (Array.isArray(body.messages)) for (const message of body.messages) if (record(message) && message.role === 'developer') message.role = 'system';
  return body;
}
export function prepareGatewayResponse(body: Record<string, unknown>, profile: AiGatewayProfile, options: ChatOptions | undefined, messages: readonly Message[]): void {
  const level = gatewayThinking(profile, options); body.max_output_tokens = gatewayOutput(profile, options, messages).maximum; body.store = false;
  delete body.reasoning; delete body.include;
  if (profile.reasoning && level !== 'off') { body.reasoning = { effort: profile.thinkingLevelMap?.[level] ?? level, summary: 'auto' }; body.include = ['reasoning.encrypted_content']; }
  else if (profile.reasoning && profile.thinkingLevelMap?.off !== null) body.reasoning = { effort: profile.thinkingLevelMap?.off ?? 'none' };
  const role = profile.reasoning ? 'developer' : 'system';
  if (Array.isArray(body.input)) for (const item of body.input) if (record(item) && item.role === 'system') item.role = role;
  if (typeof body.instructions === 'string' && Array.isArray(body.input)) { body.input.unshift({ role, content: body.instructions }); delete body.instructions; }
  if (options?.cacheRetention !== 'none' && options?.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join(''); else delete body.prompt_cache_key;
  if (options?.cacheRetention === 'long') body.prompt_cache_retention = '24h'; else delete body.prompt_cache_retention;
}
/** API counters and the gateway's own tiers/prices, never a guessed underlying vendor label. */
export function gatewayUsage(profile: AiGatewayProfile, value: unknown): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const token = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const anthropic = profile.api === 'anthropic-messages', completions = profile.api === 'openai-completions';
  const input = token(anthropic ? value.input_tokens : completions ? value.prompt_tokens : value.input_tokens);
  const output = token(anthropic ? value.output_tokens : completions ? value.completion_tokens : value.output_tokens);
  const details = completions ? value.prompt_tokens_details : value.input_tokens_details;
  if (!anthropic && details !== undefined && !record(details)) return undefined;
  const read = token(anthropic ? value.cache_read_input_tokens ?? 0 : record(details) ? details.cached_tokens ?? 0 : 0);
  const write = token(anthropic ? value.cache_creation_input_tokens ?? 0 : record(details) ? details.cache_write_tokens ?? 0 : 0);
  const creation = value.cache_creation;
  const long = token(!anthropic || creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens ?? 0 : undefined);
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined || long > write || !anthropic && read + write > input) return undefined;
  const fresh = anthropic ? input : input - read - write, total = fresh + read + write + output;
  if (!Number.isSafeInteger(total)) return undefined;
  let pricing = profile.pricing; for (const tier of profile.pricingTiers) if (fresh + read + write > tier.inputTokensAbove) pricing = tier;
  const observed = typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : undefined;
  const cost = observed ?? (pricing ? (fresh * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1_000_000 : undefined);
  return { promptTokens: fresh, completionTokens: output, cacheReadTokens: read, cacheWriteTokens: write, totalTokens: total, ...(cost === undefined ? {} : { costUsd: cost }) };
}
