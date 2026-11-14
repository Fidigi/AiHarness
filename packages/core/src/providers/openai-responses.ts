import type { ChatOptions, ChatResponse, ResponsesChatOptions } from './index.js';
import { makeStrictToolSchema, UnsupportedStrictToolSchema } from './strict-tool-schema.js';
import { OPENAI_RESPONSE_MODELS, type OpenAiResponseProfile } from './openai-responses-metadata.js';
import { PUBLISHED_THINKING_LEVELS, clampPublishedThinkingLevel } from './model-metadata.js';
import type { Message } from '../types/index.js';

const profiles = new Map(OPENAI_RESPONSE_MODELS.map(profile => [profile.id, profile]));
const grammarProperties = new WeakMap<object, ReadonlyMap<string, string>>();
const imageInputBodies = new WeakMap<object, boolean>();
export function nativeResponsesGrammarProperty(body: object, name: string): string | undefined {
  return grammarProperties.get(body)?.get(name);
}
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

export type NativeResponsesProfile = Pick<OpenAiResponseProfile, 'reasoning' | 'thinkingLevelMap' | 'declaredInput' | 'maxOutputTokens' | 'pricing' | 'pricingTiers'>;

/** Stable supplied IDs only; absent IDs retain the owning transport's existing fallback. */
export function nativeResponsesToolId(item: Record<string, unknown>): string | undefined {
  return typeof item.call_id === 'string' && item.call_id.length > 0 && typeof item.id === 'string' && item.id.length > 0
    ? `${item.call_id}|${item.id}` : undefined;
}

// Pinned Responses foreign item IDs use this deterministic, non-cryptographic hash.
export function responseItemHash(value: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/** Only private native owners call this on freshly converted bodies, before deployment rewriting. */
export function applyNativeResponsesToolHistory(body: Record<string, unknown>, messages: Message[],
  provider: 'openai' | 'azure' | 'openai-codex' | 'cloudflare-ai-gateway', model: string, api: string, physicalProvider = provider as string): void {
  if (!Array.isArray(body.input)) return;
  const ids = new Map<string, { callId: string; itemId?: string; customInput?: string }>();
  const results = new Map(messages.filter(message => message.role === 'tool').map(message => [message.toolCallId ?? message.id, message]));
  const normalize = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64).replace(/_+$/, '');
  for (const message of messages) if (message.role === 'assistant') for (const call of [
    ...(message.toolCalls ?? []), ...(message.blocks?.flatMap(block => block.type === 'tool_call' ? [block] : []) ?? []),
  ]) {
    const parts = call.id.split('|');
    let callId = parts[0]!, itemId: string | undefined = parts[1];
    const sameProviderApi = message.provider === (message.blocks ? physicalProvider : provider) && message.api === api;
    if (!sameProviderApi || message.model !== model) {
      callId = normalize(callId);
      if (itemId !== undefined) {
        itemId = sameProviderApi ? normalize(itemId) : `fc_${responseItemHash(itemId)}`;
        if (!itemId.startsWith('fc_')) itemId = normalize(`fc_${itemId}`);
      }
    }
    const property = nativeResponsesGrammarProperty(body, call.name);
    if ((sameProviderApi && message.model !== model) || !itemId?.startsWith(property === undefined ? 'fc_' : 'ctc_')) itemId = undefined;
    const customInput = property === undefined ? undefined : record(call.input) ? call.input[property] : undefined;
    if (property !== undefined && typeof customInput !== 'string') throw new Error('Invalid Responses grammar tool input.');
    ids.set(call.id, { callId, itemId, ...(typeof customInput === 'string' ? { customInput } : {}) });
  }
  for (const item of body.input) {
    if (!record(item) || typeof item.call_id !== 'string') continue;
    const id = ids.get(item.call_id);
    if (!id) continue;
    if (item.type === 'function_call') {
      item.call_id = id.callId;
      if (id.itemId !== undefined) item.id = id.itemId;
      if (id.customInput !== undefined) { item.type = 'custom_tool_call'; item.input = id.customInput; delete item.arguments; }
    } else if (item.type === 'function_call_output') {
      const message = results.get(item.call_id), images = message?.blocks?.filter(block => block.type === 'image') ?? [];
      if (images.length) item.output = imageInputBodies.get(body)
        ? [...(message!.content ? [{ type: 'input_text', text: message!.content }] : []), ...images.map(image => ({ type: 'input_image', detail: 'auto', image_url: image.url }))]
        : [message!.content, '(tool image omitted: model does not support images)'].filter(Boolean).join('\n');
      item.call_id = id.callId;
      if (id.customInput !== undefined) item.type = 'custom_tool_call_output';
      if (item.output === '') item.output = '(no tool output)';
    }
  }
}

/** Called only after private native profile admission; generic/derived/unknown R policy stays legacy. */
export function applyNativeResponsesToolPolicy(body: Record<string, unknown>, options: ResponsesChatOptions | undefined,
  supportsGrammar: boolean, defaultStrict: false | null = false): void {
  const invalid = (): never => { throw new Error('Invalid Responses tool policy.'); };
  const choice: unknown = options?.toolChoice;
  if (choice !== undefined && !((typeof choice === 'string' && ['auto', 'none', 'required'].includes(choice))
    || (record(choice) && choice.type === 'function' && typeof choice.name === 'string'))) invalid();
  const properties = new Map<string, string>();
  if (Array.isArray(body.tools)) body.tools = body.tools.map((tool, index) => {
    if (!record(tool)) return invalid();
    const sampling = options?.tools?.[index]?.constrainedSampling;
    let parameters = tool.parameters, strict: boolean | null = defaultStrict;
    if (sampling !== undefined && sampling !== false) {
      if (!record(sampling)) return invalid();
      if (sampling.type === 'grammar') {
        if (!supportsGrammar) return { ...tool, parameters, strict };
        if (!record(sampling.variants)) return invalid();
        const lark = sampling.variants.openai_lark, regex = sampling.variants.openai_regex;
        const syntax = typeof lark === 'string' && lark.trim() ? 'lark' : 'regex';
        const definition = syntax === 'lark' ? lark : regex;
        const schema = record(parameters) ? parameters : {};
        const property = Array.isArray(schema.required) && schema.required.length === 1 ? schema.required[0] : undefined;
        if (typeof definition !== 'string' || !definition.trim() || schema.type !== 'object' || typeof property !== 'string'
          || !record(schema.properties) || !record(schema.properties[property]) || schema.properties[property].type !== 'string') {
          throw new Error('Responses tool requires unsupported grammar sampling.');
        }
        properties.set(String(tool.name), property);
        return { type: 'custom', name: tool.name, description: tool.description, format: { type: 'grammar', syntax, definition } };
      }
      if (sampling.type !== 'json_schema' || !['prefer', 'require'].includes(sampling.strict)) return invalid();
      try { parameters = makeStrictToolSchema(parameters as Record<string, unknown>); strict = true; }
      catch (error) {
        if (!(error instanceof UnsupportedStrictToolSchema)) return invalid();
        if (sampling.strict === 'require') throw new Error('Responses tool requires unsupported constrained sampling.');
      }
    }
    return { ...tool, parameters, strict };
  });
  grammarProperties.set(body, properties);
  if (choice === undefined) delete body.tool_choice;
  else body.tool_choice = record(choice) ? { type: 'function', name: choice.name } : choice;
}

/** Shared R protocol, with private profile authority supplied by the owning adapter. */
export function prepareNativeResponses(body: Record<string, unknown>, options: ChatOptions | undefined,
  profile: NativeResponsesProfile, provider: 'OpenAI' | 'Azure', supportsGrammar = false): void {
  imageInputBodies.set(body, profile.declaredInput.includes('image'));
  const requested = options?.thinking;
  if (requested !== undefined && !PUBLISHED_THINKING_LEVELS.includes(requested)) throw new Error(`Invalid ${provider} thinking level.`);
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
  const systemRole = profile.reasoning ? 'developer' : 'system';
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!record(item)) continue;
      if (item.role === 'system') item.role = systemRole;
      if (!profile.declaredInput.includes('image') && Array.isArray(item.content)
        && item.content.some(part => record(part) && part.type === 'input_image')) throw new Error(`${provider} response model does not support images.`);
    }
    if (typeof body.instructions === 'string') { body.input.unshift({ role: systemRole, content: body.instructions }); delete body.instructions; }
  }
  applyNativeResponsesToolPolicy(body, options, supportsGrammar);
  if (options?.maxTokens !== undefined) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > profile.maxOutputTokens) throw new Error(`Invalid ${provider} output limit.`);
    body.max_output_tokens = Math.max(16, options.maxTokens);
  }
}

export function prepareOpenAiResponse(body: Record<string, unknown>, options?: ChatOptions): void {
  const profile = openAiResponseProfile(String(body.model));
  prepareNativeResponses(body, options, profile, 'OpenAI', profile.compat.supportsOpenAIGrammarTools === true);
  if (options?.cacheRetention !== 'none' && options?.sessionId) body.prompt_cache_key = Array.from(options.sessionId).slice(0, 64).join('');
  if (profile.compat.supportsExplicitPromptCacheMode) {
    if (options?.cacheRetention === 'none') body.prompt_cache_options = { mode: 'explicit' };
    else if (options?.cacheRetention === 'long') body.prompt_cache_options = { ttl: '30m' };
  } else if (options?.cacheRetention === 'long') body.prompt_cache_retention = '24h';
}

/** Native R primary input includes disjoint cache reads and writes; tiers use the genuine gross count. */
export function openAiResponseUsage(value: unknown, model: string): ChatResponse['usage'] {
  return nativeResponsesUsage(value, openAiResponseProfile(model));
}

export function nativeResponsesUsage(value: unknown, profile: Pick<NativeResponsesProfile, 'pricing' | 'pricingTiers'>): ChatResponse['usage'] {
  if (!record(value)) return undefined;
  const counter = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const prompt = counter(value.input_tokens), output = counter(value.output_tokens), total = counter(value.total_tokens);
  if (prompt === undefined || output === undefined || total === undefined || !Number.isSafeInteger(prompt + output) || total < prompt + output) return undefined;
  if (value.input_tokens_details !== undefined && !record(value.input_tokens_details)) return undefined;
  const details = record(value.input_tokens_details) ? value.input_tokens_details : {};
  const read = counter(details.cached_tokens), write = counter(details.cache_write_tokens);
  if ((details.cached_tokens !== undefined && read === undefined) || (details.cache_write_tokens !== undefined && write === undefined)
    || (read ?? 0) + (write ?? 0) > prompt) return undefined;
  const input = prompt - (read ?? 0) - (write ?? 0);
  const usage = { promptTokens: input, completionTokens: output, totalTokens: total,
    ...(read === undefined ? {} : { cacheReadTokens: read }), ...(write === undefined ? {} : { cacheWriteTokens: write }) };
  if (total !== prompt + output) return usage;
  let pricing = profile.pricing, threshold = -1;
  for (const tier of profile.pricingTiers ?? []) if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
    pricing = tier; threshold = tier.inputTokensAbove;
  }
  return { ...usage,
    costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + (read ?? 0) * pricing.cacheReadPerMillion + (write ?? 0) * pricing.cacheWritePerMillion) / 1_000_000 };
}
