/** Host metadata only: private journal payloads are never part of branch admission. */
export interface SessionBranchEvent {
  readonly sourceSessionId: string;
  readonly operation: 'fork' | 'clone' | 'branch-before';
  readonly entryId?: string;
  readonly position: 'before' | 'at';
  readonly externalSource: boolean;
  readonly signal: AbortSignal;
}

export interface SessionBranchOptions { signal?: AbortSignal }
export type SessionBranchHook = (event: Readonly<SessionBranchEvent>) => void | false | Promise<void | false>;

/** Cancellation withdraws unpublished work, never an already-admitted durable write. */
export class SessionBranchCancelledError extends Error {
  readonly code = 'SESSION_BRANCH_CANCELLED';
  constructor() {
    super('Session branch operation cancelled.');
    this.name = 'AbortError';
  }
}

export function captureSessionBranchSignal(value: unknown): AbortSignal | undefined {
  if (value !== undefined && !(value instanceof AbortSignal)) throw new Error('Session branch options are invalid.');
  return value;
}

export function copySessionBranchOptions(value: SessionBranchOptions): SessionBranchOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session branch options are invalid.');
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (key !== 'signal' || !descriptor || !('value' in descriptor)) throw new Error('Session branch options are invalid.');
    signal = captureSessionBranchSignal(descriptor.value);
  }
  return { signal };
}

/** Capture admission metadata without evaluating own accessors or forwarding unknown data. */
export function copySessionBranchEvent(value: SessionBranchEvent): Readonly<SessionBranchEvent> {
  const fail = (): never => { throw new Error('Session branch event is invalid.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'sourceSessionId' && key !== 'operation' && key !== 'entryId' && key !== 'position'
      && key !== 'externalSource' && key !== 'signal') return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return fail();
    const item: unknown = descriptor.value;
    if (key === 'sourceSessionId' || key === 'entryId') {
      if (key === 'entryId' && item === undefined) continue;
      if (typeof item !== 'string' || !item || Buffer.byteLength(item) > 256 || item.includes('\0')) return fail();
    } else if (key === 'operation') {
      if (item !== 'fork' && item !== 'clone' && item !== 'branch-before') return fail();
    } else if (key === 'position') {
      if (item !== 'before' && item !== 'at') return fail();
    } else if (key === 'externalSource') {
      if (typeof item !== 'boolean') return fail();
    } else if (!(item instanceof AbortSignal)) return fail();
    result[key] = item;
  }
  if (typeof result.sourceSessionId !== 'string' || result.operation === undefined || result.position === undefined
    || typeof result.externalSource !== 'boolean' || !(result.signal instanceof AbortSignal)) return fail();
  return Object.freeze(result) as unknown as Readonly<SessionBranchEvent>;
}

/** Internal publication lease. Hosts cannot resurrect a cancelled or completed lease. */
export class SessionBranchTicket {
  private readonly controller = new AbortController();
  private readonly detachCaller: () => void;
  private state: 'pending' | 'admitted' | 'finished' = 'pending';
  private refusal?: Error;
  private authorityRetired = false;

  constructor(readonly sourceSessionId: string, caller: AbortSignal | undefined, private readonly release: () => void) {
    const abort = (): void => this.cancel();
    caller?.addEventListener('abort', abort, { once: true });
    this.detachCaller = () => caller?.removeEventListener('abort', abort);
    if (caller?.aborted) this.cancel();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get authorityWithdrawn(): boolean { return this.authorityRetired; }

  check(): void {
    if (this.state === 'finished') throw new SessionBranchCancelledError();
    if (this.state === 'pending' && this.signal.aborted) throw this.refusal ?? new SessionBranchCancelledError();
  }

  cancel(refusal?: Error, authorityWithdrawn = false): void {
    if (this.state !== 'pending') return;
    if (authorityWithdrawn) this.authorityRetired = true;
    if (this.signal.aborted) return;
    this.refusal = refusal;
    this.controller.abort();
  }

  /** Call only at the owner's existing mutation/persistence admission boundary. */
  admit(): void {
    this.check();
    if (this.state === 'admitted') return;
    this.state = 'admitted';
    this.detachCaller();
    this.release();
  }

  finish(): void {
    if (this.state === 'finished') return;
    this.cancel();
    this.state = 'finished';
    this.detachCaller();
    this.release();
  }

  /** A late non-cooperative callback may keep running, but cannot publish through this lease. */
  async waitFor<T>(operation: Promise<T>): Promise<T> {
    try { this.check(); }
    catch (error) { void operation.catch(() => undefined); throw error; }
    if (this.state === 'admitted') return operation;
    let detach = (): void => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(this.refusal ?? new SessionBranchCancelledError());
      this.signal.addEventListener('abort', abort, { once: true });
      detach = () => this.signal.removeEventListener('abort', abort);
      if (this.signal.aborted) abort();
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { detach(); }
  }
}

/** Separate from ordinary lifecycle events: ordered, fail-closed and revocable. */
export class SessionBranchAdmissions {
  private readonly hooks = new Map<symbol, SessionBranchHook>();
  private readonly pending = new Set<SessionBranchTicket>();

  onBefore(hook: SessionBranchHook): () => void {
    if (typeof hook !== 'function') throw new Error('Session branch hook is invalid.');
    if (this.hooks.size >= 128) throw new Error('Session branch hook limit reached.');
    const key = Symbol();
    this.retire();
    if (this.hooks.size >= 128) throw new Error('Session branch hook limit reached.');
    this.hooks.set(key, hook);
    return () => {
      if (!this.hooks.delete(key)) return;
      this.retire();
    };
  }

  /** Hook-generation or storage withdrawal retires only unpublished admissions. */
  retire(sourceSessionId?: string, refusal?: Error, authorityWithdrawn = false): void {
    for (const ticket of this.pending) {
      if (sourceSessionId === undefined || ticket.sourceSessionId === sourceSessionId) ticket.cancel(refusal, authorityWithdrawn);
    }
  }

  begin(sourceSessionId: string, caller?: AbortSignal): SessionBranchTicket {
    caller = captureSessionBranchSignal(caller);
    if (caller?.aborted) throw new SessionBranchCancelledError();
    if (this.pending.size >= 256) throw new Error('Session branch admission limit reached.');
    const ticket = new SessionBranchTicket(sourceSessionId, caller, () => this.pending.delete(ticket));
    if (this.pending.size >= 256) { ticket.finish(); throw new Error('Session branch admission limit reached.'); }
    this.pending.add(ticket);
    return ticket;
  }

  async run(ticket: SessionBranchTicket, selection: Omit<SessionBranchEvent, 'sourceSessionId' | 'signal'>): Promise<void> {
    ticket.check();
    const event = copySessionBranchEvent({ ...selection, sourceSessionId: ticket.sourceSessionId, signal: ticket.signal });
    for (const hook of [...this.hooks.values()]) {
      ticket.check();
      let result: unknown;
      try { result = await ticket.waitFor(Promise.resolve().then(() => hook(event))); }
      catch {
        ticket.check();
        ticket.cancel();
        throw new Error('Session branch hook failed.');
      }
      ticket.check();
      if (result === false) {
        ticket.cancel();
        throw new SessionBranchCancelledError();
      }
      if (result !== undefined) {
        ticket.cancel();
        throw new Error('Session branch hook result is invalid.');
      }
    }
  }
}
