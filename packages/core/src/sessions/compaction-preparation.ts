import type { Message } from '../types/index.js';
import type { MessageEntry, SessionManager } from './session-manager.js';
import { TokenEstimator } from './compaction.js';
import { getCompactionModelMessages } from './compaction-model-messages.js';
import { selectCompactionCut } from './compaction-cut.js';

export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export interface PreparedCompactionContext {
  /** Independently owned, mutable legacy Message arrays; no aliases into history. */
  messages: Message[];
  toCompact: Message[];
  keptMessages: Message[];
  firstKeptEntryId: string;
  /** Legacy context heuristics only, not full provider-wire or billed token counts. */
  tokensBefore: number;
  compactedTokens: number;
  keptTokens: number;
}

/**
 * Share model projection and atomic target selection, not provider/publication authority.
 * The generation owner captures its exact manager source and bindings before calling
 * this helper, then retains that source through final Core save admission. Automatic
 * enablement, complete request-wire budgeting, hooks and overflow retry belong to the
 * owning pipeline; a reason here selects a cut and never starts work implicitly.
 */
export function prepareCompactionContext(manager: SessionManager, sessionId: string,
  reason: CompactionReason = 'manual'): PreparedCompactionContext | null {
  const keepProperty = Object.getOwnPropertyDescriptor(manager.getCompactionSettings(), 'keepRecentTokens');
  if (!keepProperty || !('value' in keepProperty) || typeof keepProperty.value !== 'number'
    || !Number.isSafeInteger(keepProperty.value) || keepProperty.value < 0) {
    throw new Error('Compaction cut policy is invalid.');
  }
  const messages = getCompactionModelMessages(manager, sessionId);
  const entries: MessageEntry[] = messages.map(message => ({ ...message, type: 'message', timestamp: message.timestamp.getTime() }));
  const weights = entries.map(entry => TokenEstimator.estimateMessageEntry(entry));
  // The legacy manager accepts zero keep: each heuristic entry costs at least four,
  // so normalizing that soft target to one preserves its final-unit retention.
  const cut = selectCompactionCut(entries, weights, Math.max(1, keepProperty.value), reason);
  if (!cut) return null;
  const index = cut.toCompact.length;
  return { messages, toCompact: messages.slice(0, index), keptMessages: messages.slice(index),
    firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: cut.compactedTokens + cut.keptTokens,
    compactedTokens: cut.compactedTokens, keptTokens: cut.keptTokens };
}
