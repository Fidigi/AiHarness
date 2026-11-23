import { calculatePublishedModelCost, getPublishedProviders } from '../providers/model-metadata.js';
import type { TokenUsage } from '../types/index.js';
import type { SessionEntry } from './session-manager.js';
import { getCacheWarmUsage } from '../providers/cache-notices.js';

export interface SessionUsageAccounting {
  requests: number;
  usage: Omit<TokenUsage, 'costUsd'>;
  partial: boolean;
  cost: 'none' | 'known' | 'partial' | 'unknown';
  knownCostUsd?: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  /** Message and command entries; summaries are not synthetic messages. */
  totalMessages: number;
}
export interface SessionAccounting {
  active: SessionUsageAccounting;
  history: SessionUsageAccounting;
  activePathComplete: boolean;
}
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const publishedProviders = new Set(getPublishedProviders());
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function aggregate(entries: readonly SessionEntry[]): SessionUsageAccounting {
  const result: SessionUsageAccounting = { requests: 0, usage: {}, partial: false, cost: 'none',
    userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0 };
  let priced = 0;
  let unpriced = 0;
  let known = 0;
  for (const entry of entries) {
    if (entry.type === 'command') result.totalMessages++;
    if (entry.type === 'message') {
      result.totalMessages++;
      if (entry.role === 'user') result.userMessages++;
      if (entry.role === 'tool') result.toolResults++;
      if (entry.role === 'assistant') {
        result.assistantMessages++;
        result.toolCalls += entry.toolCalls?.length ?? 0;
      }
    }
    // Nested accounting is authenticated on the OUTER tool message by Core;
    // never sum nestedCalls/progress/details or user/system/metadata usage.
    const incompleteNested = entry.type === 'message' && entry.role === 'tool' && entry.name === 'codemode'
      && (entry.metadata?.codemode as { costComplete?: unknown } | undefined)?.costComplete === false;
    const warmed = getCacheWarmUsage(entry);
    if (!warmed && entry.type !== 'compaction' && entry.type !== 'branch_summary' && !(entry.type === 'message'
      && (entry.role === 'assistant' || (entry.role === 'tool' && (entry.usage || incompleteNested))))) continue;
    result.requests++;
    const attributed = warmed ?? (entry as Extract<SessionEntry, { type: 'message' | 'compaction' | 'branch_summary' }>);
    const usage = attributed.usage;
    for (const key of counters) {
      if (valid(usage?.[key])) {
        const sum = (result.usage[key] ?? 0) + usage![key]!;
        result.usage[key] = Math.min(Number.MAX_SAFE_INTEGER, sum);
        if (sum > Number.MAX_SAFE_INTEGER) result.partial = true;
      } else result.partial = true;
    }
    const total = valid(usage?.totalTokens) ? usage.totalTokens
      : counters.every(key => valid(usage?.[key])) ? counters.reduce((sum, key) => sum + usage![key]!, 0) : undefined;
    if (total !== undefined) {
      const sum = (result.usage.totalTokens ?? 0) + total;
      result.usage.totalTokens = Math.min(Number.MAX_SAFE_INTEGER, sum);
      if (sum > Number.MAX_SAFE_INTEGER) result.partial = true;
    }
    // Never borrow today's selected model for an unattributed historical entry.
    // Missing cache counters retain the published calculator's existing zero
    // policy; the separate partial marker exposes incomplete measurements.
    const cost = valid(usage?.costUsd) ? usage.costUsd
      : usage && valid(usage.inputTokens) && valid(usage.outputTokens) && attributed.provider && attributed.model
        && publishedProviders.has(attributed.provider)
        ? calculatePublishedModelCost(attributed.provider, attributed.model, usage) : undefined;
    const boundedCost = valid(cost) && cost <= Number.MAX_SAFE_INTEGER && known + cost <= Number.MAX_SAFE_INTEGER;
    if (boundedCost) { known += cost; priced++; }
    if (!boundedCost || incompleteNested) unpriced++;
  }
  result.cost = !result.requests ? 'none' : unpriced ? (priced ? 'partial' : 'unknown') : 'known';
  if (priced) result.knownCostUsd = Math.min(Number.MAX_SAFE_INTEGER, known);
  return result;
}

/** Journal accounting, not context size: active includes pre-compaction
 * ancestors, history includes abandoned branches. Missing/cyclic/ambiguous
 * parent paths retain only a known subtotal and are explicitly incomplete. */
export function getSessionAccounting(entries: readonly SessionEntry[], activeLeafId?: string): SessionAccounting {
  const byId = new Map<string, SessionEntry>();
  let complete = true;
  let duplicateIds = false;
  for (const entry of entries) {
    if (entry.type === 'metadata') continue;
    if (byId.has(entry.id)) { complete = false; duplicateIds = true; }
    byId.set(entry.id, entry);
  }
  const ids = new Set<string>();
  let cursor = activeLeafId;
  if (!cursor && byId.size) complete = false;
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry || ids.has(cursor)) { complete = false; break; }
    ids.add(cursor);
    cursor = entry.type === 'message' ? entry.parentMessageId
      : entry.type === 'metadata' ? undefined : entry.parentEntryId;
  }
  // A repeated logical ID is not a second billable entry. Retain the last
  // append-order projection, while exposing ambiguous input as incomplete.
  const canonical = [...byId.values()];
  const active = aggregate(canonical.filter(entry => ids.has(entry.id)));
  if (!complete) {
    active.partial = true;
    active.cost = active.knownCostUsd === undefined ? 'unknown' : 'partial';
  }
  const history = aggregate(canonical);
  if (duplicateIds) {
    history.partial = true;
    history.cost = history.knownCostUsd === undefined ? 'unknown' : 'partial';
  }
  return { active, history, activePathComplete: complete };
}
