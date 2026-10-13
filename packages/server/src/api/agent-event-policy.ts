import type { AgentEvent } from '@ai-harness/core';
import type { SseRebuildPolicy } from './sse-channel.js';

/** The detached protocol alone grants replacement semantics. Legacy chat,
 * nested call lifecycle and arbitrary producer events stay non-rebuildable. */
export function agentEventPolicy(event: AgentEvent): SseRebuildPolicy {
  if (!event.runId || !event.data || typeof event.data !== 'object') return {};
  const data = event.data as Record<string, unknown>;
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const key = (kind: string, identity: string): string => JSON.stringify([event.sessionId, event.runId, kind, identity]);
  if (event.type === 'tool.progress' && data.kind === 'tool' && data.version === 1
    && data.status === 'running' && data.parentId === undefined && id(data.toolCallId)) {
    return { coalesceKey: key('tool', data.toolCallId) };
  }
  if (id(data.messageId)) {
    if (event.type === 'message.delta' || event.type === 'reasoning.delta') return { deltaKey: key('message', data.messageId) };
    if (event.type === 'message.completed' && typeof data.content === 'string') return { completedKey: key('message', data.messageId) };
  }
  return {};
}
