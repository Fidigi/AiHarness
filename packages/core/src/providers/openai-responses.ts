import type { ChatOptions, ChatResponse } from './index.js';
import { OPENAI_RESPONSE_MODELS, type OpenAiResponseProfile } from './openai-responses-metadata.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel } from './model-metadata.js';

const profiles = new Map(OPENAI_RESPONSE_MODELS.map(profile => [profile.id, profile]));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function openAiResponseProfile(model: string): OpenAiResponseProfile {
  const profile = profiles.get(model);
  if (!profile) throw new Error('OpenAI response model is not supported.');
  return profile;
}

/** Explicit Responses/Decisions base; operator aliases do not select a service or authentication policy. */
export function openAiMixedBase(value: string | undefined): string {
  try {
    const url = new URL(value || 'https://api.openai.com/v1');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/u, '').replace(/\/(?:responses|decisions)$/u, '') || '/';
    return url.href.replace(/\/+$/u, '');
  } catch { throw new Error('Invalid OpenAI endpoint.'); }
}

export function prepareOpenAiResponse(body: Record<string, unknown>, options?: ChatOptions): void {
  const profile = openAiResponseProfile(String(body.model)), requested = options?.thinking;
  if (requested !== undefined && !PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error('Invalid OpenAI thinking level.');
  const levels = PUBLISHED_THINKING_LEVELS.filter(level => !profile.reasoning ? level === 'off'
    : profile.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
  const selected = clampPublishedThinkingLevel(requested ?? 'off', levels);
  delete body.reasoning; delete body.include;
  if (profile.reasoning) {
    const enabled = requested !== undefined && selected !== 'off';
    const effort = enabled ? profile.thinkingLevelMap?.[selected] ?? selected
      : profile.thinkingLevelMap?.off === null ? undefined : profile.thinkingLevelMap?.off ?? 'none';
    if (effort !== undefined) {
      body.reasoning = { effort, ...(enabled ? { summary: 'auto' } : {}) };
      if (enabled) body.include = ['reasoning.encrypted_content'];
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!record(item)) continue;
      if (item.role === 'system') item.role = 'developer';
      if (!profile.declaredInput.includes('image') && Array.isArray(item.content)
        && item.content.some(part => record(part) && part.type === 'input_image')) throw new Error('OpenAI response model does not support images.');
    }
    if (typeof body.instructions === 'string') { body.input.unshift({ role: 'developer', content: body.instructions }); delete body.instructions; }
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) if (record(tool)) tool.strict = false;
  if (options?.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error('Invalid OpenAI output limit.');
    body.max_output_tokens = Math.max(16, options.maxTokens);
  }
  if (options?.cacheRetention !== 'none' && options?.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
  if (profile.compat.supportsExplicitPromptCacheMode) {
    if (options?.cacheRetention === 'none') body.prompt_cache_options = { mode: 'explicit' };
    else if (options?.cacheRetention === 'long') body.prompt_cache_options = { ttl: '30m' };
  } else if (options?.cacheRetention === 'long') body.prompt_cache_retention = '24h';
}

/** Native R primary input includes disjoint cache reads and writes; tiers use the genuine gross count. */
export function openAiResponseUsage(value: unknown, model: string): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const counter = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const prompt = counter(value.input_tokens), output = counter(value.output_tokens);
  if (prompt === undefined || output === undefined || !Number.isSafeInteger(prompt + output)) return undefined;
  if (value.input_tokens_details !== undefined && !record(value.input_tokens_details)) return undefined;
  const details = record(value.input_tokens_details) ? value.input_tokens_details : {};
  const read = counter(details.cached_tokens), write = counter(details.cache_write_tokens);
  if ((details.cached_tokens !== undefined && read === undefined) || (details.cache_write_tokens !== undefined && write === undefined)
    || (read ?? 0) + (write ?? 0) > prompt) return undefined;
  const input = prompt - (read ?? 0) - (write ?? 0), profile = openAiResponseProfile(model);
  let pricing = profile.pricing;
  for (const tier of profile.pricingTiers ?? []) if (prompt > tier.inputTokensAbove) pricing = tier;
  return { promptTokens: input, completionTokens: output, totalTokens: prompt + output,
    ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }),
    costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + (read ?? 0) * pricing.cacheReadPerMillion + (write ?? 0) * pricing.cacheWritePerMillion) / 1_000_000 };
}
