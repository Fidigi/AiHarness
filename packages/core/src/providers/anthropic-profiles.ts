import type { AnthropicChatOptions, ChatResponse } from './index.js';
import type { Message } from '../types/index.js';
import { makeStrictToolSchema, UnsupportedStrictToolSchema } from './strict-tool-schema.js';
import type { PublishedModelMetadata, PublishedThinkingLevel } from './model-metadata.js';

// Pi 1.2.0 / 06a466935536f8c9bcacb2d5efc0fc021be1bdff, generated catalogue
// The anthropic.json digest is checked against the pinned manifest in the independent fixture.
// These are owned declarations and observed prices, not complete request/media policies.
type Row = readonly [id: string, name: string, context: number, output: number,
  inputPrice: number, outputPrice: number, cacheReadPrice: number, cacheWritePrice: number];
const rows: readonly Row[] = [
  ['claude-fable-5', 'Claude Fable 5', 1000000, 128000, 10, 50, 1, 12.5],
  ['claude-fable-5-1', 'Claude Fable 5.1', 1000000, 128000, 10, 50, 0.25, 12.5],
  ['claude-haiku-4-5', 'Claude Haiku 4.5 (latest)', 200000, 64000, 1, 5, 0.1, 1.25],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200000, 64000, 1, 5, 0.1, 1.25],
  ['claude-haiku-5-5', 'Claude Haiku 5.5', 1000000, 128000, 0.1, 0.5, 0.01, 0.125],
  ['claude-opus-4-5', 'Claude Opus 4.5 (latest)', 200000, 64000, 5, 25, 0.5, 6.25],
  ['claude-opus-4-5-20251101', 'Claude Opus 4.5', 200000, 64000, 5, 25, 0.5, 6.25],
  ['claude-opus-4-6', 'Claude Opus 4.6', 1000000, 128000, 5, 25, 0.5, 6.25],
  ['claude-opus-4-7', 'Claude Opus 4.7', 1000000, 128000, 5, 25, 0.5, 6.25],
  ['claude-opus-4-8', 'Claude Opus 4.8', 1000000, 128000, 5, 25, 0.5, 6.25],
  ['claude-opus-5', 'Claude Opus 5', 1000000, 128000, 5, 25, 0.5, 6.25],
  ['claude-opus-5-5', 'Claude Opus 5.5', 1000000, 128000, 4, 20, 0.2, 5],
  ['claude-sonnet-4-5', 'Claude Sonnet 4.5 (latest)', 200000, 64000, 3, 15, 0.3, 3.75],
  ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 200000, 64000, 3, 15, 0.3, 3.75],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, 128000, 3, 15, 0.3, 3.75],
  ['claude-sonnet-5', 'Claude Sonnet 5', 1000000, 128000, 2, 10, 0.2, 2.5],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 128000, 2, 10, 0.1, 2.5],
];
const profiles = new Map(rows.map(([id, name, contextWindow, maxOutputTokens, inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion]) =>
  [id, { id, name, api: 'anthropic-messages', contextWindow, maxOutputTokens,
    capabilities: { reasoning: true, imageInput: true, toolCalls: true },
    pricing: { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion } }]));
// Native reasoning maps remain independent of mutable public metadata.
interface AdaptivePolicy {
  readonly maxTokens: number;
  readonly thinkingLevelMap: Readonly<Record<PublishedThinkingLevel, string | null>>;
  readonly supportsTemperature: boolean;
  readonly managed: boolean;
}
// ID, native xhigh, supports temperature, supports off, managed effort, supports minimal.
const adaptivePolicies = new Map<string, AdaptivePolicy>(([
  ['claude-fable-5', true, true, false, false, true],
  ['claude-opus-4-6', false, true, true, false, true],
  ['claude-opus-4-7', true, false, true, false, true],
  ['claude-opus-4-8', true, false, true, false, true],
  ['claude-sonnet-4-6', false, true, true, false, true],
  ['claude-sonnet-5', true, true, true, false, true],
  ['claude-fable-5-1', true, true, false, true, true],
  ['claude-haiku-5-5', true, false, false, true, false],
  ['claude-opus-5', true, false, false, true, true],
  ['claude-opus-5-5', true, false, false, true, false],
  ['claude-sonnet-5-5', true, false, false, true, false],
] as const).map(([id, xhigh, supportsTemperature, off, managed, minimal]) => [id, Object.freeze({ maxTokens: profiles.get(id)!.maxOutputTokens, supportsTemperature, managed,
  thinkingLevelMap: Object.freeze({ off: off ? 'off' : null, minimal: minimal ? 'low' : null, low: 'low', medium: 'medium', high: 'high',
    xhigh: xhigh ? 'xhigh' : null, max: 'max' }) })] as const));
export function anthropicAdaptivePolicy(model: string): AdaptivePolicy | undefined { return adaptivePolicies.get(model); }
const numericIds = new Set(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5',
  'claude-opus-4-5-20251101', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']);
const numericPolicy = Object.freeze({ maxTokens: 64000, contextWindow: 200000, thinkingLevelMap: Object.freeze({
  off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
}) });
export function anthropicNumericPolicy(model: string): typeof numericPolicy | undefined { return numericIds.has(model) ? numericPolicy : undefined; }
export function hasAnthropicProfile(model: string): boolean { return profiles.has(model); }
const strictUnsupportedKeys = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems',
  'uniqueItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties']);
const strictFormats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);
const unsupportedStrictKeyword = (key: string, value: unknown): boolean => strictUnsupportedKeys.has(key)
  || (key === 'minItems' && value !== 0 && value !== 1) || (key === 'format' && (typeof value !== 'string' || !strictFormats.has(value)));
/** Caller declarations only; native deferred/inline tool changes remain a separate policy. */
export function applyAnthropicProfileToolDeclarations(body: Record<string, unknown>, owned: boolean, options?: AnthropicChatOptions): void {
  const admitted = owned && typeof body.model === 'string' && profiles.has(body.model), choice = options?.toolChoice;
  const invalid = (): never => { throw new Error('Invalid Anthropic tool policy.'); };
  const unsupported = (): never => { throw new Error('Anthropic tool requires unsupported constrained sampling.'); };
  if (choice !== undefined) {
    if (!admitted) invalid();
    if (typeof choice === 'string' && ['auto', 'none', 'any'].includes(choice)) body.tool_choice = { type: choice };
    else if (choice && typeof choice === 'object' && choice.type === 'tool' && typeof choice.name === 'string' && choice.name.trim()) {
      body.tool_choice = { type: 'tool', name: choice.name };
    } else invalid();
  }
  if (!Array.isArray(body.tools)) return;
  body.tools = body.tools.map((tool, index) => {
    let parameters = tool.input_schema, strict = false;
    const sampling = options?.tools?.[index]?.constrainedSampling;
    if (sampling !== undefined && sampling !== false) {
      if (!sampling || sampling.type !== 'json_schema' || !['prefer', 'require'].includes(sampling.strict)) return invalid();
      if (!admitted) { if (sampling.strict === 'require') unsupported(); }
      else {
        try { parameters = makeStrictToolSchema(parameters, unsupportedStrictKeyword); strict = true; }
        catch (error) {
          if (!(error instanceof UnsupportedStrictToolSchema)) return invalid();
          if (sampling.strict === 'require') unsupported();
        }
      }
    }
    if (!admitted) return tool;
    return { ...tool, eager_input_streaming: true, ...(strict ? { strict: true } : {}),
      input_schema: { ...(strict ? parameters : {}), type: 'object', properties: parameters.properties ?? {}, required: parameters.required ?? [] } };
  });
}
const systemUpdateModels = new Set(['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-4-8',
  'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
/** Plain Core system messages only; preserve updates before the next assistant, never inside a tool pair. */
export function applyAnthropicSystemHistory(body: Record<string, unknown>, messages: readonly Message[], systemPrompt?: string): void {
  if (!systemUpdateModels.has(String(body.model)) || !Array.isArray(body.messages)) return;
  const converted = body.messages, result: unknown[] = [], pending: unknown[] = [], initial = [systemPrompt];
  let index = 0;
  for (const message of messages) {
    if (message.role === 'system') {
      if (!index) initial.push(message.content);
      else if (message.content) pending.push({ role: 'system', content: [{ type: 'text', text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') { result.push(...pending); pending.length = 0; }
    result.push(converted[index++]);
  }
  result.push(...pending);
  if (index) body.messages = result;
  const leading = initial.filter(Boolean).join('\n\n');
  if (leading) body.system = leading; else delete body.system;
}
/** Correlate paired tool results without changing surrounding native content order. */
export function applyAnthropicToolHistory(body: Record<string, unknown>, messages: readonly Message[], owner: string,
  toolImageParts: (message: Message) => Array<Record<string, unknown>>): void {
  if (typeof body.model !== 'string' || !profiles.has(body.model) || !Array.isArray(body.messages)) return;
  const original = messages.filter(message => message.role !== 'system'), ids = new Map<string, string>();
  const result: Array<{ role: string; content: unknown }> = [];
  let index = 0, previousTool = false;
  for (const message of body.messages as Array<{ role: string; content: unknown }>) {
    // Managed effort controls have already been inserted; they consume no source turn.
    if (message.role === 'system') { result.push(message); previousTool = false; continue; }
    const source = original[index++];
    if (source?.role === 'assistant' && Array.isArray(message.content)) {
      const same = source.provider === owner && source.model === body.model && source.api === 'anthropic-messages';
      message.content = message.content.map(block => {
        if (block.type !== 'tool_use') return block;
        const id = same ? block.id : block.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        ids.set(block.id, id); return { ...block, id };
      });
    }
    if (source?.role === 'tool' && Array.isArray(message.content)) {
      const images = toolImageParts(source);
      const content = message.content.map(block => ({ ...block, tool_use_id: ids.get(block.tool_use_id) ?? block.tool_use_id,
        ...(source.isError !== undefined ? { is_error: source.isError } : {}),
        ...(images.length ? { content: [{ type: 'text', text: source.content || '(see attached image)' }, ...images] } : {}),
      }));
      message.content = content;
      if (previousTool) {
        (result[result.length - 1]!.content as unknown[]).push(...content);
        continue;
      }
    }
    result.push(message); previousTool = source?.role === 'tool';
  }
  body.messages = result;
}
export function anthropicPublishedProfiles(): PublishedModelMetadata[] {
  return [...profiles.values()].map(profile => ({ ...profile, capabilities: { ...profile.capabilities }, pricing: { ...profile.pricing },
    thinkingLevelMap: { ...(adaptivePolicies.get(profile.id)?.thinkingLevelMap ?? anthropicNumericPolicy(profile.id)!.thinkingLevelMap) } }));
}
/** Direct native owner only: reject invalid caller/effective ceilings without truncating explicit requests. */
export function validateAnthropicProfileOutput(body: Record<string, unknown>, requested: unknown): void {
  const profile = typeof body.model === 'string' ? profiles.get(body.model) : undefined;
  if (!profile) return;
  const valid = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 1 && value <= profile.maxOutputTokens;
  if ((requested !== undefined && !valid(requested)) || !valid(body.max_tokens)) throw new Error('Invalid Anthropic output limit.');
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Anthropic deltas replace observed counters; nullable fields do not erase a prior observation. */
export function mergeAnthropicProfileUsage(previous: unknown, value: unknown, start: boolean): unknown {
  if (!record(value)) return previous;
  const merged: Record<string, unknown> = start ? { ...value } : record(previous) ? { ...previous } : {};
  if (!start) for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (value[key] !== undefined && value[key] !== null) merged[key] = value[key];
  }
  if (!start && value.iterations !== undefined && value.iterations !== null) merged.iterations = value.iterations;
  if (value.cache_creation !== undefined && value.cache_creation !== null) {
    if (!record(value.cache_creation)) merged.cache_creation = value.cache_creation;
    else if (value.cache_creation.ephemeral_1h_input_tokens !== undefined && value.cache_creation.ephemeral_1h_input_tokens !== null) {
      merged.cache_creation = { ...(record(merged.cache_creation) ? merged.cache_creation : {}), ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens };
    }
  }
  return merged;
}

/** Exact pinned nomination; public metadata and similar IDs cannot add targets or reorder them. */
export function anthropicFallbackModels(model: string): string[] {
  return model === 'claude-fable-5' ? ['claude-opus-4-8', 'claude-opus-5'] : [];
}
export function anthropicFallbackValidator(model: string): ((value: Record<string, unknown>) => boolean) | undefined {
  const targets = anthropicFallbackModels(model);
  if (!targets.length) return undefined;
  let current = model, position = -1;
  return value => {
    if (!record(value.from) || value.from.model !== current || !record(value.to) || typeof value.to.model !== 'string') return false;
    const next = targets.indexOf(value.to.model);
    if (next <= position) return false;
    current = value.to.model; position = next;
    return true;
  };
}

const unpricedFallbackUsage = new WeakSet<object>();
/** Internal attribution refusal; never inferred from public model/response metadata. */
export function isUnpricedAnthropicFallbackUsage(value: unknown): boolean { return record(value) && unpricedFallbackUsage.has(value); }

/** Requested pricing except exact owned fallback targets; arbitrary response aliases stay inert. */
export function anthropicProfileUsage(value: unknown, model: string, responseModel?: string, fallback = false): ChatResponse['usage'] {
  const profile = profiles.get(model);
  if (!profile || !record(value)) return undefined;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = token(value.input_tokens), output = token(value.output_tokens);
  const read = value.cache_read_input_tokens === undefined ? 0 : token(value.cache_read_input_tokens);
  const write = value.cache_creation_input_tokens === undefined ? 0 : token(value.cache_creation_input_tokens);
  const creation = model === 'claude-fable-5' && value.cache_creation === null ? undefined : value.cache_creation;
  const long = creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens === undefined ? 0 : token(creation.ephemeral_1h_input_tokens) : undefined;
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined
    || long > write || !Number.isSafeInteger(input + output + read + write)) return undefined;
  const gross = input + read + write;
  const targets = anthropicFallbackModels(model), served = responseModel && targets.includes(responseModel) ? profiles.get(responseModel) : undefined;
  const pricing = served?.pricing ?? (model === 'claude-haiku-5-5' && gross > 100000
    ? { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625 } : profile.pricing);
  let costUsd: number | undefined = fallback && !served ? undefined : (input * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion
    + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1000000;
  // Never price a multi-model aggregate as though every token used the last model.
  if (targets.length && value.iterations !== undefined && value.iterations !== null) {
    costUsd = undefined;
    if (Array.isArray(value.iterations) && value.iterations.length > 0 && value.iterations.length <= 128) {
      const totals = [0, 0, 0, 0, 0]; let cost = 0, valid = true;
      for (const item of value.iterations) {
        if (!record(item) || !['message', 'fallback_message'].includes(String(item.type)) || typeof item.model !== 'string'
          || item.model !== model && !targets.includes(item.model)) { valid = false; break; }
        const part = anthropicProfileUsage({ ...item, iterations: undefined, cache_creation: item.cache_creation ?? undefined }, item.model);
        if (!part || part.costUsd === undefined) { valid = false; break; }
        const hour = record(item.cache_creation) ? item.cache_creation.ephemeral_1h_input_tokens ?? 0 : 0;
        totals[0] += part.promptTokens; totals[1] += part.completionTokens; totals[2] += part.cacheReadTokens ?? 0;
        totals[3] += part.cacheWriteTokens ?? 0; totals[4] += Number(hour); cost += part.costUsd;
      }
      if (valid && totals.every((total, index) => Number.isSafeInteger(total) && total === [input, output, read, write, long][index]) && Number.isFinite(cost)) costUsd = cost;
    }
  }
  const result = { promptTokens: input, completionTokens: output, totalTokens: gross + output,
    ...(value.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: read }),
    ...(value.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: write }),
    ...(costUsd === undefined ? {} : { costUsd }) };
  if (targets.length && costUsd === undefined) unpricedFallbackUsage.add(result);
  return result;
}
