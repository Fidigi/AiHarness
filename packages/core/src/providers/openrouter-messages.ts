import type { Message, ModelPricing } from '../types/index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import { OPENROUTER_MESSAGE_MODELS, type OpenRouterMessageProfile } from './openrouter-messages-metadata.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel } from './model-metadata.js';
import { resolveThinkingBudget } from './thinking-budgets.js';
import { applyAnthropicManagedHistory } from './anthropic-thinking.js';
import { openRouterUserPricing, type OpenRouterUserModel } from './openrouter-user-models.js';

const profiles = new Map(OPENROUTER_MESSAGE_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function openRouterMessageProfile(model: string): OpenRouterMessageProfile {
  const profile = profiles.get(model);
  if (!profile) throw new Error('OpenRouter message model is not supported.');
  return profile;
}

export function openRouterMessagesEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    const pathname = url.pathname.replace(/\/+$/u, '');
    url.pathname = pathname.endsWith('/messages') ? pathname : /\/v\d+$/u.test(pathname) ? `${pathname}/messages` : `${pathname}/v1/messages`;
    return url.href;
  } catch { throw new Error('Invalid OpenRouter messages endpoint.'); }
}

export function prepareOpenRouterMessage(body: Record<string, unknown>, options?: ChatOptions, native?: { messages: readonly Message[]; owner: string }, personal?: OpenRouterUserModel): Record<string, unknown> {
  const profile = openRouterMessageProfile(String(body.model));
  if (options?.thinking !== undefined && !PUBLISHED_THINKING_LEVELS.includes(options.thinking)) throw new Error('Invalid OpenRouter thinking level.');
  const cap = personal?.maxOutputTokens ?? profile.maxOutputTokens, maximum = options?.maxTokens ?? cap;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > cap) throw new Error('Invalid OpenRouter output limit.');
  body.max_tokens = maximum; delete body.thinking; delete body.output_config;
  const control = options?.cacheRetention === 'none' ? undefined
    : { type: 'ephemeral', ...(options?.cacheRetention === 'long' ? { ttl: '1h' } : {}) };
  if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system, ...(control ? { cache_control: control } : {}) }];
  if (control && Array.isArray(body.tools)) body.tools = body.tools.map((tool: Record<string, unknown>, index: number) =>
    index === (body.tools as unknown[]).length - 1 ? { ...tool, cache_control: control } : tool);
  const managed = profile.compat?.supportsMidConvoEffort === true;
  const adaptive = profile.compat?.forceAdaptiveThinking === true;
  const levels = PUBLISHED_THINKING_LEVELS.filter(level => profile.thinkingLevelMap?.[level] !== null
    && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
  const selected = options?.thinking === undefined ? undefined : clampPublishedThinkingLevel(options.thinking, levels);
  const active = selected !== undefined && selected !== 'off';
  if (managed) {
    const effort = selected === undefined ? 'high' : profile.thinkingLevelMap?.[selected] ?? selected;
    body.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
    body.output_config = { effort: 'high' };
    if (native) {
      if (effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'xhigh' && effort !== 'max') throw new Error('Invalid OpenRouter thinking level.');
      applyAnthropicManagedHistory(body, options, native.messages.filter(message => message.role !== 'system'), native.owner, effort);
    } else if (Array.isArray(body.messages)) body.messages.push({ role: 'system', content: [], output_config: { effort } });
  } else if (active && adaptive) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort: profile.thinkingLevelMap?.[selected] ?? selected };
  } else if (active) {
    const defaults = { minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
    const budget = resolveThinkingBudget(selected, options?.thinkingBudgets, defaults[selected], 1024, 32768);
    if (budget + 1024 > maximum) throw new Error('Invalid OpenRouter output limit.');
    body.thinking = { type: 'enabled', budget_tokens: budget, display: 'summarized' };
  } else if (profile.thinkingLevelMap?.off !== null) body.thinking = { type: 'disabled' };
  if (active || managed || profile.compat?.supportsTemperature === false) delete body.temperature;
  if (native && Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool)) {
    const schema = record(tool.input_schema) ? tool.input_schema : {};
    tool.input_schema = { type: 'object', properties: schema.properties ?? {}, required: schema.required ?? [] }; tool.eager_input_streaming = true;
  }
  return body;
}

export function openRouterMessageBetas(model: string, options?: ChatOptions): string[] {
  const profile = openRouterMessageProfile(model);
  if (profile.compat?.supportsMidConvoEffort) return ['mid-conversation-output-config-2026-07-01', 'thinking-binding-controls-2026-08-01'];
  return options?.thinking && options.thinking !== 'off' && !profile.compat?.forceAdaptiveThinking ? ['interleaved-thinking-2025-05-14'] : [];
}

/** Native A observes all start counters and preserves prior values on nullable partial deltas. */
export function mergeOpenRouterMessageUsage(previous: unknown, value: unknown, start: boolean): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  const merged: Record<string, unknown> = start ? { ...value } : record(previous) ? { ...previous } : {};
  if (!start) for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (value[field] !== undefined && value[field] !== null) merged[field] = value[field];
  }
  const creation = value.cache_creation;
  if (creation !== undefined && creation !== null) {
    if (!record(creation)) merged.cache_creation = creation;
    else if (creation.ephemeral_1h_input_tokens !== undefined && creation.ephemeral_1h_input_tokens !== null) {
      merged.cache_creation = { ...(record(merged.cache_creation) ? merged.cache_creation : {}), ephemeral_1h_input_tokens: creation.ephemeral_1h_input_tokens };
    }
  }
  return merged;
}

export function validateOpenRouterMessage(value: unknown, native = false): void {
  const invalid = (): never => { throw new Error('Invalid OpenRouter message response.'); };
  if (!record(value) || value.error || value.type === 'error' || !Array.isArray(value.content)) return invalid();
  if (value.model !== undefined && (typeof value.model !== 'string' || Buffer.byteLength(value.model) > 500
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value.model))) return invalid();
  for (const block of value.content) {
    if (!record(block)) return invalid();
    if (block.type === 'text') { if (typeof block.text !== 'string') return invalid(); }
    else if (block.type === 'thinking') { if (typeof block.thinking !== 'string' || native && block.signature !== undefined && typeof block.signature !== 'string') return invalid(); }
    else if (block.type === 'redacted_thinking' && native) { if (typeof block.data !== 'string') return invalid(); }
    else if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !record(block.input)) return invalid();
    } else throw new Error('Unsupported OpenRouter message content.');
  }
}

export function openRouterMessageText(content: unknown): string {
  return Array.isArray(content) ? content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : '';
}

export function openRouterMessageUsage(value: unknown, model: string, personal?: OpenRouterUserModel): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const token = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const input = token(value.input_tokens), output = token(value.output_tokens);
  const read = value.cache_read_input_tokens === undefined ? 0 : token(value.cache_read_input_tokens);
  const write = value.cache_creation_input_tokens === undefined ? 0 : token(value.cache_creation_input_tokens);
  const creation = value.cache_creation;
  const long = creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens === undefined ? 0 : token(creation.ephemeral_1h_input_tokens) : undefined;
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined || long > write
    || !Number.isSafeInteger(input + read + write + output)) return undefined;
  const profile = openRouterMessageProfile(model);
  let pricing: Readonly<Required<ModelPricing>> | undefined = personal?.prices ? openRouterUserPricing(personal.prices, input + read + write) : profile.pricing, threshold = -1;
  if (!personal?.prices) for (const tier of profile.declaredPricing.tiers ?? []) {
    if (input + read + write > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { pricing = tier; threshold = tier.inputTokensAbove; }
  }
  return { promptTokens: input, completionTokens: output, totalTokens: input + read + write + output,
    ...(value.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: read }),
    ...(value.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: write }),
    ...(pricing ? { costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion
      + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1_000_000 } : {}) };
}
