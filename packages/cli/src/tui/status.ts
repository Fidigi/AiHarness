import { getPublishedModelMetadata, getSessionAccounting } from '@ai-harness/core';
import type { SessionManager, SessionUsageAccounting } from '@ai-harness/core';
import { terminalText, wrapTerminalText } from './terminal-text.js';

export interface TerminalResources {
  skills: number;
  prompts: number;
  extensions: number;
  instructions: number;
  diagnostics: number;
}
export type TerminalAccounting = SessionUsageAccounting;
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
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Active accounting is the durable ancestor path INCLUDING pre-compaction work;
 * history is the entire journal INCLUDING abandoned branches. Context is Core's
 * effective model-visible estimate, not either accounting token sum. */
export async function createTerminalStatus(source: TerminalStatusSource): Promise<TerminalStatus> {
  const session = source.sessionManager.get(source.sessionId);
  const entries = await source.sessionManager.getRawEntries(source.sessionId);
  const accounting = getSessionAccounting(entries, session?.activeLeafId);
  if (!session) {
    accounting.activePathComplete = false;
    accounting.active.partial = true;
    accounting.active.cost = accounting.active.knownCostUsd === undefined ? 'unknown' : 'partial';
  }
  const metadata = source.provider && source.model
    ? getPublishedModelMetadata(source.provider, source.model) : undefined;
  const estimate = session ? source.sessionManager.estimateContextTokens(source.sessionId) : undefined;
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
    ...accounting,
  };
}

function costText(accounting: TerminalAccounting): string {
  if (accounting.cost === 'none') return 'cost — (no requests)';
  if (accounting.cost === 'unknown') return 'cost unknown';
  return `cost $${accounting.knownCostUsd!.toFixed(6)}${accounting.cost === 'partial' ? ' known subtotal; total unknown' : ''}`;
}
export function usageText(accounting: TerminalAccounting): string {
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
