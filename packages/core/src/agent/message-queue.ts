import type { AgentQueueMode } from '../config/agent-settings.js';

export type AgentMessageQueueKind = 'steer' | 'follow-up';

export interface AgentMessageQueueSnapshot<T> {
  steering: T[];
  followUp: T[];
}

export interface AgentMessageQueueBatch<T> {
  kind: AgentMessageQueueKind;
  items: T[];
}

export interface ClearedAgentMessages<T> extends AgentMessageQueueSnapshot<T> {
  /** Removed values in their original cross-queue insertion order. */
  ordered: T[];
}

export interface AgentMessageQueueOptions {
  steeringMode?: AgentQueueMode;
  followUpMode?: AgentQueueMode;
  /** Maximum combined steering and follow-up entries. Defaults to 100. */
  maxItems?: number;
}

interface QueueEntry<T> {
  kind: AgentMessageQueueKind;
  value: T;
}

/** Parse a queue mode at an untrusted settings or transport boundary. */
export function parseAgentQueueMode(value: unknown): AgentQueueMode {
  if (value !== 'one-at-a-time' && value !== 'all') {
    throw new Error(`Invalid queue mode: ${String(value)}`);
  }
  return value;
}

/**
 * Bounded steering/follow-up scheduler shared by terminal, RPC, and detached
 * Web runs. It owns delivery-mode semantics while each adapter owns rendering,
 * persistence, and transport events.
 */
export class AgentMessageQueue<T> {
  private entries: Array<QueueEntry<T>> = [];
  private steeringMode: AgentQueueMode;
  private followUpMode: AgentQueueMode;
  private readonly maxItems: number;

  constructor(options: AgentMessageQueueOptions = {}) {
    const maxItems = options.maxItems ?? 100;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 10_000) {
      throw new Error('maxItems must be an integer between 1 and 10000.');
    }
    this.maxItems = maxItems;
    this.steeringMode = parseAgentQueueMode(options.steeringMode ?? 'one-at-a-time');
    this.followUpMode = parseAgentQueueMode(options.followUpMode ?? 'one-at-a-time');
  }

  enqueue(kind: AgentMessageQueueKind, value: T): void {
    if (this.entries.length >= this.maxItems) {
      throw new Error(`Agent message queue is full (${this.maxItems} entries).`);
    }
    this.entries.push({ kind, value });
  }

  /** Remove the next delivery batch according to the selected kind's mode. */
  take(kind: AgentMessageQueueKind): T[] {
    const mode = this.getMode(kind);
    if (mode === 'all') {
      const taken = this.entries.filter(entry => entry.kind === kind);
      if (taken.length === 0) return [];
      this.entries = this.entries.filter(entry => entry.kind !== kind);
      return taken.map(entry => entry.value);
    }

    const index = this.entries.findIndex(entry => entry.kind === kind);
    if (index < 0) return [];
    return this.entries.splice(index, 1).map(entry => entry.value);
  }

  /** Remove the next steer-first batch, falling back to follow-ups. */
  takeNext(): AgentMessageQueueBatch<T> | undefined {
    const kind = this.entries.some(entry => entry.kind === 'steer')
      ? 'steer'
      : this.entries.some(entry => entry.kind === 'follow-up')
        ? 'follow-up'
        : undefined;
    return kind ? { kind, items: this.take(kind) } : undefined;
  }

  clear(kind?: AgentMessageQueueKind): ClearedAgentMessages<T> {
    const removed = kind === undefined
      ? this.entries
      : this.entries.filter(entry => entry.kind === kind);
    this.entries = kind === undefined
      ? []
      : this.entries.filter(entry => entry.kind !== kind);
    return {
      steering: removed.filter(entry => entry.kind === 'steer').map(entry => entry.value),
      followUp: removed.filter(entry => entry.kind === 'follow-up').map(entry => entry.value),
      ordered: removed.map(entry => entry.value),
    };
  }

  snapshot(): AgentMessageQueueSnapshot<T> {
    return {
      steering: this.entries.filter(entry => entry.kind === 'steer').map(entry => entry.value),
      followUp: this.entries.filter(entry => entry.kind === 'follow-up').map(entry => entry.value),
    };
  }

  setMode(kind: AgentMessageQueueKind, value: unknown): AgentQueueMode {
    const mode = parseAgentQueueMode(value);
    if (kind === 'steer') this.steeringMode = mode;
    else this.followUpMode = mode;
    return mode;
  }

  getMode(kind: AgentMessageQueueKind): AgentQueueMode {
    return kind === 'steer' ? this.steeringMode : this.followUpMode;
  }

  size(kind?: AgentMessageQueueKind): number {
    return kind === undefined
      ? this.entries.length
      : this.entries.filter(entry => entry.kind === kind).length;
  }
}
