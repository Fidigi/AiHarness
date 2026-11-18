import type { ModelPricing, TokenUsage } from '../types/index.js';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Cache inclusion belongs to the actual API, not the operator name or shared endpoint. */
export function openRouterUsage(value: unknown, pricing: Readonly<Required<ModelPricing>> | undefined,
  api: 'openai-completions' | 'openrouter-images'): TokenUsage | undefined {
  if (!record(value)) return undefined;
  const token = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const prompt = token(value.prompt_tokens), output = token(value.completion_tokens);
  if (prompt === undefined && output === undefined) return undefined;
  const details = value.prompt_tokens_details;
  const inclusive = api === 'openrouter-images';
  const cachedValue = record(details) && details.cached_tokens !== undefined ? details.cached_tokens
    : inclusive ? undefined : value.prompt_cache_hit_tokens ?? value.cached_tokens;
  const cached = cachedValue === undefined ? 0 : token(cachedValue);
  const write = record(details) && details.cache_write_tokens !== undefined ? token(details.cache_write_tokens) : 0;
  const valid = (details === undefined || record(details)) && cached !== undefined && write !== undefined
    && (prompt === undefined || (inclusive ? Math.max(cached, write) : cached + write) <= prompt);
  const read = valid ? inclusive ? Math.max(0, cached! - write!) : cached : undefined;
  const input = prompt !== undefined && valid ? prompt - read! - write! : undefined;
  return { ...(input === undefined ? {} : { inputTokens: input }), ...(output === undefined ? {} : { outputTokens: output }),
    ...(valid && cachedValue !== undefined ? { cacheReadTokens: read } : {}),
    ...(valid && record(details) && details.cache_write_tokens !== undefined ? { cacheWriteTokens: write } : {}),
    ...(prompt === undefined || output === undefined ? {} : { totalTokens: Math.min(Number.MAX_SAFE_INTEGER, prompt + output) }),
    ...(pricing && input !== undefined && output !== undefined ? { costUsd: (input * pricing.inputPerMillion + output * pricing.outputPerMillion
      + read! * (pricing.cacheReadPerMillion ?? 0) + write! * (pricing.cacheWritePerMillion ?? 0)) / 1_000_000 } : {}),
  };
}
