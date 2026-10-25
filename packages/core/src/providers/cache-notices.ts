import type { SessionEntry } from '../sessions/session-manager.js';
import type { TokenUsage } from '../types/index.js';
import { copySessionCustomValue } from '../sessions/session-custom-data.js';
import { getPublishedModelMetadata } from './model-metadata.js';

export interface CacheWarmUsage { provider: string; model: string; usage: TokenUsage; extensionOverride?: boolean }
export function getCacheWarmUsage(entry: SessionEntry): CacheWarmUsage | undefined {
  if (entry.type !== 'custom' || entry.customType !== 'provider.cache_warm') return undefined;
  try {
    const data = copySessionCustomValue(entry.data, 8192) as CacheWarmUsage;
    if (!data || typeof data.provider !== 'string' || typeof data.model !== 'string' || !data.usage
      || typeof data.usage !== 'object' || Object.entries(data.usage).some(([key, value]) =>
        !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd'].includes(key)
        || typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return undefined;
    return data;
  } catch { return undefined; }
}
export interface CacheTranscriptNotice {
  id: string;
  afterEntryId: string;
  kind: 'cache_warm' | 'cache_miss';
  costUsd?: number;
  missedTokens?: number;
  modelChanged?: boolean;
  idleMinutes?: number;
}
/** Derive repeatable notices on an already selected ancestry. Never add context or mutate messages. */
export function getCacheTranscriptNotices(entries: readonly SessionEntry[]): CacheTranscriptNotice[] {
  const notices: CacheTranscriptNotice[] = [];
  let previous: { tokens: number; provider: string; model: string; timestamp: number; cached: boolean } | undefined;
  let anchor: string | undefined;
  for (const entry of new Map(entries.map(entry => [entry.id, entry])).values()) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') { previous = undefined; continue; }
    const warmed = getCacheWarmUsage(entry);
    const message = entry.type === 'message' && entry.role === 'assistant' ? entry : undefined;
    if (entry.type === 'message') anchor = entry.id;
    if (!warmed && !message) continue;
    const usage = warmed?.usage ?? message?.usage;
    if (!usage) continue;
    const provider = warmed?.provider ?? message?.provider, model = warmed?.model ?? message?.model;
    if (!provider || !model) continue;
    const tokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (warmed && anchor) notices.push({ id: entry.id, afterEntryId: anchor, kind: 'cache_warm',
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) });
    if (message && previous && tokens > 0 && (cache > 0 || previous.cached)) {
      const missedTokens = Math.max(0, Math.min(previous.tokens, tokens) - (usage.cacheReadTokens ?? 0));
      const pricing = getPublishedModelMetadata(provider, model)?.pricing;
      const paid = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      const paidCost = usage.costUsd !== undefined && pricing?.outputPerMillion !== undefined && pricing.cacheReadPerMillion !== undefined
        ? Math.max(0, usage.costUsd - ((usage.outputTokens ?? 0) * pricing.outputPerMillion
          + (usage.cacheReadTokens ?? 0) * pricing.cacheReadPerMillion) / 1_000_000)
        : ((usage.inputTokens ?? 0) * (pricing?.inputPerMillion ?? 0)
          + (usage.cacheWriteTokens ?? 0) * (pricing?.cacheWritePerMillion ?? 0)) / 1_000_000;
      const costUsd = pricing && paid > 0 ? missedTokens * Math.max(0,
        paidCost * 1_000_000 / paid - (pricing.cacheReadPerMillion ?? 0)) / 1_000_000 : undefined;
      if (missedTokens > 1024 && (missedTokens >= 20_000 || (costUsd ?? 0) >= 0.1)) {
        const idle = Math.max(0, entry.timestamp - previous.timestamp);
        notices.push({ id: `cache-miss:${entry.id}`, afterEntryId: entry.id, kind: 'cache_miss', missedTokens,
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(previous.model !== model || previous.provider !== provider ? { modelChanged: true } : {}),
          ...(idle > 300_000 ? { idleMinutes: Math.floor(idle / 60_000) } : {}),
        });
      }
    }
    if (tokens > 0) previous = { tokens, provider, model, timestamp: entry.timestamp,
      cached: cache > 0 || Boolean(warmed) || previous?.cached === true };
  }
  return notices;
}
