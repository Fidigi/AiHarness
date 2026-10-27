import type { ChatResponse } from './index.js';
import type { PublishedModelMetadata } from './model-metadata.js';

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
export function hasAnthropicProfile(model: string): boolean { return profiles.has(model); }
export function anthropicPublishedProfiles(): PublishedModelMetadata[] {
  return [...profiles.values()].map(profile => ({ ...profile, capabilities: { ...profile.capabilities }, pricing: { ...profile.pricing } }));
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Anthropic deltas replace observed counters; nullable fields do not erase a prior observation. */
export function mergeAnthropicProfileUsage(previous: unknown, value: unknown, start: boolean): unknown {
  if (!record(value)) return previous;
  const merged: Record<string, unknown> = start ? { ...value } : record(previous) ? { ...previous } : {};
  if (!start) for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (value[key] !== undefined && value[key] !== null) merged[key] = value[key];
  }
  if (value.cache_creation !== undefined && value.cache_creation !== null) {
    if (!record(value.cache_creation)) merged.cache_creation = value.cache_creation;
    else if (value.cache_creation.ephemeral_1h_input_tokens !== undefined && value.cache_creation.ephemeral_1h_input_tokens !== null) {
      merged.cache_creation = { ...(record(merged.cache_creation) ? merged.cache_creation : {}), ephemeral_1h_input_tokens: value.cache_creation.ephemeral_1h_input_tokens };
    }
  }
  return merged;
}

/** Price the captured requested model, never the response alias, request TTL or output-token tier. */
export function anthropicProfileUsage(value: unknown, model: string): ChatResponse['usage'] {
  const profile = profiles.get(model);
  if (!profile || !record(value)) return undefined;
  const token = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = token(value.input_tokens), output = token(value.output_tokens);
  const read = value.cache_read_input_tokens === undefined ? 0 : token(value.cache_read_input_tokens);
  const write = value.cache_creation_input_tokens === undefined ? 0 : token(value.cache_creation_input_tokens);
  const creation = value.cache_creation;
  const long = creation === undefined ? 0 : record(creation) ? creation.ephemeral_1h_input_tokens === undefined ? 0 : token(creation.ephemeral_1h_input_tokens) : undefined;
  if (input === undefined || output === undefined || read === undefined || write === undefined || long === undefined
    || long > write || !Number.isSafeInteger(input + output + read + write)) return undefined;
  const gross = input + read + write;
  const pricing = model === 'claude-haiku-5-5' && gross > 100000
    ? { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0.625 } : profile.pricing;
  return { promptTokens: input, completionTokens: output, totalTokens: gross + output,
    ...(value.cache_read_input_tokens === undefined ? {} : { cacheReadTokens: read }),
    ...(value.cache_creation_input_tokens === undefined ? {} : { cacheWriteTokens: write }),
    costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion + read * pricing.cacheReadPerMillion
      + (write - long) * pricing.cacheWritePerMillion + long * pricing.inputPerMillion * 2) / 1000000 };
}
