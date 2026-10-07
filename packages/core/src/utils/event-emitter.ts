// ============================================================
// Event Emitter - Typed lifecycle hooks for core and extensions
// ============================================================

export type EventHandler<T = void> = (data: T) => void | Promise<void>;

export interface EventMap {
  'session:create': { sessionId: string; title?: string };
  'session:delete': { sessionId: string };
  'session:update': { sessionId: string; messageCount: number };
  'session:switch': { fromId?: string; toId: string };
  'message:add': { sessionId: string; role: string; contentLength: number };
  'message:clear': { sessionId: string };
  'compaction:start': { sessionId: string; automatic?: boolean; tokensBefore?: number };
  'compaction:end': {
    sessionId: string;
    summaryLength: number;
    automatic?: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
    tokensSaved?: number;
  };
  'compaction:error': { sessionId: string; error: string; automatic?: boolean; cancelled?: boolean };
  'agent:start': { sessionId: string; provider: string };
  'agent:end': { sessionId: string; contentLength: number };
  'agent:error': { sessionId: string; error: string };
  'provider:call:start': { provider: string; model?: string };
  'provider:call:end': { provider: string; tokensUsed?: number; durationMs: number };
  'provider:call:error': { provider: string; error: string };
  'tool:call': { tool: string; input: unknown };
  'tool:result': { tool: string; isError: boolean; contentLength: number };
  'tool:error': { tool: string; error: string };
  'system:ready': void;
  'system:shutdown': void;
}

type StoredHandler = EventHandler<unknown>;

const MAX_EVENT_TYPES = 512;
const MAX_LISTENERS_PER_EVENT = 256;

/** Minimal typed event emitter with synchronous and asynchronous listeners. */
export class EventEmitter<TEvents extends object> {
  private listeners = new Map<keyof TEvents, Set<StoredHandler>>();
  private onceListeners = new Map<keyof TEvents, Set<StoredHandler>>();

  on<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    if (this.listeners.get(event)?.has(handler as StoredHandler)) return;
    this.assertCapacity(event);
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler as StoredHandler);
  }

  once<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    if (this.onceListeners.get(event)?.has(handler as StoredHandler)) return;
    this.assertCapacity(event);
    if (!this.onceListeners.has(event)) this.onceListeners.set(event, new Set());
    this.onceListeners.get(event)!.add(handler as StoredHandler);
  }

  off<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    const regular = this.listeners.get(event);
    const once = this.onceListeners.get(event);
    regular?.delete(handler as StoredHandler);
    once?.delete(handler as StoredHandler);
    if (regular?.size === 0) this.listeners.delete(event);
    if (once?.size === 0) this.onceListeners.delete(event);
  }

  /** Emit an event and wait for every listener. Listener failures are isolated. */
  async emit<K extends keyof TEvents>(
    event: K,
    ...args: TEvents[K] extends void ? [] | [data: TEvents[K]] : [data: TEvents[K]]
  ): Promise<void> {
    const data = args[0] as TEvents[K];
    const regular = [...(this.listeners.get(event) ?? [])];
    const once = [...(this.onceListeners.get(event) ?? [])];
    this.onceListeners.delete(event);

    await Promise.all([
      ...regular.map(handler => this.invoke(handler, data, false)),
      ...once.map(handler => this.invoke(handler, data, true)),
    ]);
  }

  hasListeners<K extends keyof TEvents>(event: K): boolean {
    return this.listenerCount(event) > 0;
  }

  listenerCount<K extends keyof TEvents>(event: K): number {
    return (this.listeners.get(event)?.size ?? 0) + (this.onceListeners.get(event)?.size ?? 0);
  }

  removeAllListeners<K extends keyof TEvents>(event?: K): void {
    if (event !== undefined) {
      this.listeners.delete(event);
      this.onceListeners.delete(event);
      return;
    }
    this.listeners.clear();
    this.onceListeners.clear();
  }

  clear(): void {
    this.removeAllListeners();
  }

  private async invoke<K extends keyof TEvents>(
    handler: StoredHandler,
    data: TEvents[K],
    once: boolean,
  ): Promise<void> {
    try {
      await handler(data);
    } catch {
      const kind = once ? 'once listener' : 'listener';
      console.error(`[EventEmitter] ${kind} failed.`);
    }
  }

  private assertCapacity<K extends keyof TEvents>(event: K): void {
    const known = this.listeners.has(event) || this.onceListeners.has(event);
    const eventTypes = new Set([...this.listeners.keys(), ...this.onceListeners.keys()]);
    if (!known && eventTypes.size >= MAX_EVENT_TYPES) throw new Error('Event type limit reached.');
    if (this.listenerCount(event) >= MAX_LISTENERS_PER_EVENT) throw new Error('Event listener limit reached.');
  }
}
