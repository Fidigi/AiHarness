import type { Message } from '../types/index.js';
import type { SessionEntry, SessionManager } from './session-manager.js';

/**
 * Owned projection adapter, not a second context engine. Token policy, atomic
 * cuts, generation hooks and accounting are separate from this conversion.
 * Use the same parent-based model projection as ordinary turns, never raw
 * custom entries or the UI's ordinary-message-only session list.
 */
export function getCompactionModelMessages(manager: SessionManager, sessionId: string): Message[] {
  return compactionMessagesFromEntries(manager.getEffectiveContext(sessionId));
}

/** Convert an already selected effective-model prefix; this does not select ancestry or grant source authority. */
export function compactionMessagesFromEntries(entries: readonly SessionEntry[]): Message[] {
  const owned = structuredClone(entries);
  return owned.flatMap(entry => entry.type !== 'message' ? [] : [{
    id: entry.id,
    role: entry.role,
    content: entry.content,
    timestamp: new Date(entry.timestamp),
    ...(entry.blocks !== undefined ? { blocks: entry.blocks } : {}),
    ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
    ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.parentMessageId !== undefined ? { parentMessageId: entry.parentMessageId } : {}),
    ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  }]);
}
