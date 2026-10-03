import type { MessageContentBlock } from '../types/index.js';
import type { ExtensionInteractionRequest } from '../extensions/extension-registry.js';

export const AGENT_EVENT_PROTOCOL_VERSION = 1 as const;

export type AgentPhase =
  | 'idle'
  | 'queued'
  | 'prompting'
  | 'streaming'
  | 'tool'
  | 'command'
  | 'compacting'
  | 'completed'
  | 'failed'
  | 'stopped';

export type AgentEventType =
  | 'connection.ready'
  | 'snapshot'
  | 'run.queued'
  | 'run.started'
  | 'run.phase'
  | 'run.completed'
  | 'run.failed'
  | 'run.stopped'
  | 'message.start'
  | 'message.delta'
  | 'message.completed'
  | 'reasoning.delta'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'tool.failed'
  | 'command.started'
  | 'command.output'
  | 'command.completed'
  | 'queue.updated'
  | 'retry.scheduled'
  | 'compaction.started'
  | 'compaction.completed'
  | 'compaction.failed'
  | 'subagent.started'
  | 'subagent.updated'
  | 'subagent.completed'
  | 'subagent.failed'
  | 'extension.ui'
  | 'notice';

export interface AgentEvent<T = unknown> {
  protocolVersion: typeof AGENT_EVENT_PROTOCOL_VERSION;
  id: string;
  sequence: number;
  sessionId: string;
  runId?: string;
  type: AgentEventType;
  timestamp: string;
  data: T;
}

export interface QueuedAgentMessage {
  id: string;
  kind: 'steer' | 'follow-up';
  content: string;
  blocks?: MessageContentBlock[];
  createdAt: string;
}

export interface AgentRetrySnapshot {
  attempt: number;
  max: number;
  delayMs: number;
  message: string;
  scheduledAt: string;
}

export interface ExtensionInteractionSnapshot extends ExtensionInteractionRequest {
  id: string;
  extensionId?: string;
  createdAt: string;
}

export interface ActiveToolSnapshot {
  id: string;
  name: string;
  input: unknown;
  startedAt: string;
}

export interface AgentRunSnapshot {
  id: string;
  sessionId: string;
  workspaceId?: string;
  cwd: string;
  provider: string;
  model?: string;
  phase: AgentPhase;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retry?: AgentRetrySnapshot;
  activeTool?: ActiveToolSnapshot;
  extensionRequest?: ExtensionInteractionSnapshot;
  partialMessage?: { id: string; content: string; reasoning?: string };
  steerQueue: QueuedAgentMessage[];
  followUpQueue: QueuedAgentMessage[];
  lastSequence: number;
}

export interface AgentStateSnapshot {
  sessionId: string;
  lastSequence: number;
  run?: AgentRunSnapshot;
}

export interface AgentEventReplay {
  events: AgentEvent[];
  lastSequence: number;
  /** True when `after` predates the bounded journal and a fresh snapshot is required. */
  reset: boolean;
}

type AgentEventListener = (event: AgentEvent) => void;

/** Bounded, per-session event journal with strictly increasing sequence IDs. */
export class AgentEventJournal {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly sequences = new Map<string, number>();
  private readonly listeners = new Map<string, Set<AgentEventListener>>();

  constructor(private readonly maxEventsPerSession = 2_000) {
    if (!Number.isSafeInteger(maxEventsPerSession) || maxEventsPerSession < 10) {
      throw new Error('maxEventsPerSession must be an integer greater than or equal to 10');
    }
  }

  publish<T>(sessionId: string, type: AgentEventType, data: T, runId?: string): AgentEvent<T> {
    const sequence = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    const event: AgentEvent<T> = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      id: `${sessionId}:${sequence}`,
      sequence,
      sessionId,
      runId,
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    const journal = this.events.get(sessionId) ?? [];
    journal.push(event);
    if (journal.length > this.maxEventsPerSession) {
      journal.splice(0, journal.length - this.maxEventsPerSession);
    }
    this.events.set(sessionId, journal);
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
    return event;
  }

  replay(sessionId: string, after = 0): AgentEventReplay {
    const journal = this.events.get(sessionId) ?? [];
    const lastSequence = this.sequences.get(sessionId) ?? 0;
    const oldestSequence = journal[0]?.sequence ?? lastSequence + 1;
    return {
      events: journal.filter(event => event.sequence > after),
      lastSequence,
      reset: after > 0 && after < oldestSequence - 1,
    };
  }

  subscribe(sessionId: string, listener: AgentEventListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  lastSequence(sessionId: string): number {
    return this.sequences.get(sessionId) ?? 0;
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.events.delete(sessionId);
      this.sequences.delete(sessionId);
      this.listeners.delete(sessionId);
      return;
    }
    this.events.clear();
    this.sequences.clear();
    this.listeners.clear();
  }
}
