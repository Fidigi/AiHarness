import type { ModelPricing } from '../types/index.js';
import { OPENROUTER_COMPLETION_MODELS } from './openrouter-completions-metadata.js';
import { OPENROUTER_MESSAGE_MODELS } from './openrouter-messages-metadata.js';
import { readProviderJson } from './oauth-device.js';
type Rates = Readonly<Required<ModelPricing>>;
interface Tier extends Required<ModelPricing> { inputTokensAbove: number; known: boolean }
export interface OpenRouterUserPrices { readonly rates: Rates; readonly known: boolean; readonly tiers: readonly Tier[] }
export interface OpenRouterUserModel { readonly id: string; readonly contextWindow?: number; readonly maxOutputTokens?: number; readonly prices?: OpenRouterUserPrices }
const knownIds = new Set([...OPENROUTER_COMPLETION_MODELS, ...OPENROUTER_MESSAGE_MODELS].map(model => model.id));
const scoped = new WeakMap<object, OpenRouterUserModel>();
export function bindOpenRouterUserModel(owner: object, model: OpenRouterUserModel): void { scoped.set(owner, model); }
export function openRouterUserModel(owner: object, model: string): OpenRouterUserModel | undefined { const value = scoped.get(owner); return value?.id === model ? value : undefined; }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new Error('Invalid OpenRouter user catalogue.'); }
function limit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === 0) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100_000_000) invalid(); return value;
}
function rate(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) return undefined;
  const number = Number((Number(value) * 1_000_000).toFixed(6)); return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000_000 ? number : undefined;
}
function prices(value: unknown): OpenRouterUserPrices | undefined {
  if (value === undefined || value === null) return undefined; if (!record(value)) invalid();
  const input = rate(value.prompt), output = rate(value.completion), read = value.input_cache_read === undefined ? 0 : rate(value.input_cache_read), write = value.input_cache_write === undefined ? 0 : rate(value.input_cache_write);
  const rates = Object.freeze({ inputPerMillion: input ?? 0, outputPerMillion: output ?? 0, cacheReadPerMillion: read ?? 0, cacheWritePerMillion: write ?? 0 });
  const known = [input, output, read, write].every(number => number !== undefined) && Object.values(rates).some(number => number > 0);
  if (value.overrides !== undefined && (!Array.isArray(value.overrides) || value.overrides.length > 64)) invalid();
  const tiers: Tier[] = [];
  for (const override of (value.overrides as unknown[] | undefined) ?? []) {
    if (!record(override)) invalid();
    if (override.min_prompt_tokens === undefined || override.utc_start !== undefined || override.utc_end !== undefined || override.utc_days !== undefined) continue;
    const threshold = override.min_prompt_tokens; if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 0 || threshold > 100_000_000) invalid();
    const tier = { inputTokensAbove: threshold, inputPerMillion: rate(override.prompt) ?? rates.inputPerMillion, outputPerMillion: rate(override.completion) ?? rates.outputPerMillion,
      cacheReadPerMillion: rate(override.input_cache_read) ?? rates.cacheReadPerMillion, cacheWritePerMillion: rate(override.input_cache_write) ?? rates.cacheWritePerMillion };
    tiers.push(Object.freeze({ ...tier, known: known && [tier.inputPerMillion, tier.outputPerMillion, tier.cacheReadPerMillion, tier.cacheWritePerMillion].some(number => number > 0) }));
  }
  return Object.freeze({ rates, known, tiers: Object.freeze(tiers) });
}
export function openRouterUserPricing(value: OpenRouterUserPrices, prompt: unknown): Rates | undefined {
  let result: Rates | undefined = value.known ? value.rates : undefined, threshold = -1;
  if (typeof prompt === 'number') for (const tier of value.tiers) if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { result = tier.known ? tier : undefined; threshold = tier.inputTokensAbove; }
  return result;
}
/** Key's chat intersection only: no new model/API/capability is admitted from remote labels. */
export async function readOpenRouterUserModels(response: Response, signal: AbortSignal): Promise<ReadonlyMap<string, OpenRouterUserModel>> {
  const body = await readProviderJson(response, signal, 4 * 1024 * 1024); if (!Array.isArray(body.data) || body.data.length > 2048) invalid();
  const models = new Map<string, OpenRouterUserModel>();
  for (const entry of body.data) {
    if (!record(entry) || typeof entry.id !== 'string') continue;
    if (Buffer.byteLength(entry.id) > 500 || /[\u0000-\u001f\u007f-\u009f]/u.test(entry.id)) invalid(); if (!knownIds.has(entry.id)) continue;
    if (entry.top_provider !== undefined && entry.top_provider !== null && !record(entry.top_provider)) invalid(); const top = record(entry.top_provider) ? entry.top_provider : undefined;
    const contextWindow = limit(top?.context_length) ?? limit(entry.context_length), maxOutputTokens = limit(top?.max_completion_tokens), pricing = prices(entry.pricing);
    models.set(entry.id, Object.freeze({ id: entry.id, ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), ...(pricing ? { prices: pricing } : {}) }));
  }
  signal.throwIfAborted(); return models;
}
