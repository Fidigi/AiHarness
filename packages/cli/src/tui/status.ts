import { getPublishedModelMetadata } from '@ai-harness/core';
import type { SessionEntry, SessionManager, TokenUsage } from '@ai-harness/core';
import { terminalText, wrapTerminalText } from './terminal-text.js';

export interface TerminalResources {
  skills: number;
  prompts: number;
  extensions: number;
  instructions: number;
  diagnostics: number;
}
export interface TerminalAccounting {
  requests: number;
  usage: Omit<TokenUsage, 'costUsd'>;
  partial: boolean;
  cost: 'none' | 'known' | 'partial' | 'unknown';
  knownCostUsd?: number;
}
export interface TerminalStatus {
  cwd: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionFile?: string;
  persistence: 'file' | 'memory';
  provider?: string;
  model?: string;
  thinking?: string;
  contextTokens?: number;
  contextWindow?: number;
  resources: TerminalResources;
  active: TerminalAccounting;
  history: TerminalAccounting;
  activePathComplete: boolean;
}
export interface TerminalStatusSource {
  sessionManager: Pick<SessionManager, 'get' | 'getRawEntries' | 'estimateContextTokens'>;
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  resources: TerminalResources;
}
const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function aggregate(entries: readonly SessionEntry[]): TerminalAccounting {
  const result: TerminalAccounting = { requests: 0, usage: {}, partial: false, cost: 'none' };
  let known = 0;
  let priced = 0;
  let unpriced = 0;
  for (const entry of entries) {
    // User/command/progress/metadata accounting is never authoritative. Core puts
    // authenticated nested aggregate usage ON the outer tool message exactly once.
    const incompleteNested = entry.type === 'message' && entry.role === 'tool'
      && entry.name === 'codemode'
      && (entry.metadata?.codemode as { costComplete?: unknown } | undefined)?.costComplete === false;
    if (entry.type !== 'compaction' && !(entry.type === 'message'
      && (entry.role === 'assistant' || (entry.role === 'tool' && (entry.usage || incompleteNested))))) continue;
    result.requests++;
    const usage = entry.usage;
    for (const key of counters) {
      if (valid(usage?.[key])) result.usage[key] = Math.min(Number.MAX_SAFE_INTEGER,
        (result.usage[key] ?? 0) + usage![key]!);
      else result.partial = true;
    }
    // Do not use current-model prices for past models or treat missing counters as
    // zero. Persisted costs are provider/host accounting, never progress.details.
    const cost = valid(usage?.costUsd) ? usage!.costUsd : undefined;
    const total = valid(usage?.totalTokens) ? usage!.totalTokens
      : counters.every(key => valid(usage?.[key]))
        ? counters.reduce((sum, key) => sum + usage![key]!, 0) : undefined;
    if (total !== undefined) result.usage.totalTokens = Math.min(Number.MAX_SAFE_INTEGER,
      (result.usage.totalTokens ?? 0) + total);
    if (cost !== undefined) { known += cost; priced++; }
    if (cost === undefined || incompleteNested) unpriced++;
  }
  result.cost = !result.requests ? 'none' : unpriced ? (priced ? 'partial' : 'unknown') : 'known';
  if (priced) result.knownCostUsd = Math.min(Number.MAX_SAFE_INTEGER, known);
  return result;
}

/** Active accounting is the durable ancestor path INCLUDING pre-compaction work;
 * history is the entire journal INCLUDING abandoned branches. Context is Core's
 * effective model-visible estimate, not either accounting token sum. */
export async function createTerminalStatus(source: TerminalStatusSource): Promise<TerminalStatus> {
  const session = source.sessionManager.get(source.sessionId);
  const entries = await source.sessionManager.getRawEntries(source.sessionId);
  const byId = new Map(entries.filter(entry => entry.type !== 'metadata').map(entry => [entry.id, entry]));
  const ids = new Set<string>();
  let cursor = session?.activeLeafId;
  let complete = Boolean(session);
  if (!cursor && byId.size) complete = false; // Legacy/unparented journal: don't invent an active path.
  while (cursor) {
    const entry = byId.get(cursor);
    if (!entry || ids.has(cursor)) { complete = false; break; }
    ids.add(cursor);
    cursor = entry.type === 'message' ? entry.parentMessageId : entry.parentEntryId;
  }
  const metadata = source.provider && source.model
    ? getPublishedModelMetadata(source.provider, source.model) : undefined;
  const estimate = session ? source.sessionManager.estimateContextTokens(source.sessionId) : undefined;
  const active = aggregate(entries.filter(entry => ids.has(entry.id)));
  if (!complete) {
    active.partial = true;
    active.cost = active.knownCostUsd === undefined ? 'unknown' : 'partial';
  }
  return {
    cwd: source.cwd,
    sessionId: session?.id,
    sessionTitle: session?.title,
    sessionFile: source.sessionFile,
    persistence: source.sessionFile ? 'file' : 'memory',
    provider: source.provider,
    model: source.model,
    thinking: source.thinking,
    contextTokens: valid(estimate) ? estimate : undefined,
    contextWindow: metadata?.contextWindow,
    resources: { ...source.resources },
    active,
    history: aggregate(entries),
    activePathComplete: complete,
  };
}

function costText(accounting: TerminalAccounting): string {
  if (accounting.cost === 'none') return 'cost — (no requests)';
  if (accounting.cost === 'unknown') return 'cost unknown';
  return `cost $${accounting.knownCostUsd!.toFixed(6)}${accounting.cost === 'partial' ? ' known subtotal; total unknown' : ''}`;
}
function usageText(accounting: TerminalAccounting): string {
  const usage = accounting.usage;
  return `tokens ${usage.totalTokens ?? '?'} · in ${usage.inputTokens ?? '?'} out ${usage.outputTokens ?? '?'} cache R/W ${usage.cacheReadTokens ?? '?'}/${usage.cacheWriteTokens ?? '?'}${accounting.partial ? ' (partial)' : ''} · ${costText(accounting)}`;
}
export function statusText(status: TerminalStatus, editor: string): string[] {
  const r = status.resources;
  const context = status.contextTokens === undefined ? 'unknown' : `~${status.contextTokens}`;
  const pressure = status.contextTokens !== undefined && status.contextWindow
    ? ` (${Math.round(status.contextTokens / status.contextWindow * 100)}%)` : '';
  return [
    `cwd ${status.cwd}`,
    `session ${status.sessionTitle ?? 'untitled'} [${status.sessionId ?? 'none'}] · ${status.persistence === 'memory' ? 'memory (not saved)' : status.sessionFile}`,
    `model ${status.provider ?? '?'}/${status.model ?? '?'} · thinking ${status.thinking ?? '?'}`,
    `resources ${r.skills} skills · ${r.prompts} prompts · ${r.extensions} extensions · ${r.instructions} instructions · ${r.diagnostics} diagnostics`,
    `context ${context}/${status.contextWindow ?? '?'} tokens${pressure} (estimate; effective session context)`,
    `${status.activePathComplete ? 'active path' : 'active path incomplete'} · ${usageText(status.active)}`,
    `full history (all branches) · ${usageText(status.history)}`,
    `editor ${editor}`,
  ].map(line => terminalText(line).replace(/\s+/g, ' ').trim());
}

/** At narrow widths stack fields; at short heights explicitly advertise resizing
 * rather than imply that a clipped subtotal is the full status. */
export function statusLines(status: TerminalStatus, editor: string, width: number, maxLines = Infinity): string[] {
  const lines = statusText(status, editor).flatMap(line => wrapTerminalText(line, width));
  if (lines.length <= maxLines) return lines;
  const compact = [
    `model ${status.provider ?? '?'}/${status.model ?? '?'}`,
    `ctx ${status.contextTokens === undefined ? '?' : `~${status.contextTokens}`}/${status.contextWindow ?? '?'}`,
    `active ${costText(status.active)}`,
    `editor ${editor} · resize for full status`,
  ].map(line => terminalText(line).replace(/\s+/g, ' ')).flatMap(line => wrapTerminalText(line, width));
  if (compact.length <= maxLines) return compact;
  return wrapTerminalText('status: resize', width).slice(0, Math.max(0, maxLines));
}
