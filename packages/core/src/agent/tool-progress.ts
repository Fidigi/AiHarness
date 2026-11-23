import type { ToolCall } from '../types/index.js';

export const TOOL_PROGRESS_VERSION = 1 as const;
export const TOOL_PROGRESS_LIMITS = Object.freeze({ contentBytes: 16_384, detailsBytes: 8_192,
  depth: 6, nodes: 256, submissions: 4_096, deliveries: 256 });
export type ToolProgressValue = null | boolean | number | string | ToolProgressValue[] | { [key: string]: ToolProgressValue };
/** Rebuildable snapshots, not deltas. Omitted fields retain their last accepted value.
 * Details are display-only: never usage, pricing, activation or store authority. */
export interface ToolProgressInput {
  version: typeof TOOL_PROGRESS_VERSION;
  content?: string;
  details?: ToolProgressValue;
}
export interface ToolProgressSnapshot extends ToolProgressInput {
  toolCallId: string;
  toolName: string;
  sequence: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  durationMs: number;
  truncated: boolean;
  omittedUpdates: number;
}

function utf8(value: string, bytes: number): string {
  // Slice before encoding so even a huge producer string has bounded allocation.
  const buffer = Buffer.from(value.slice(0, bytes), 'utf8');
  if (buffer.length <= bytes) return buffer.toString('utf8');
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/** An opaque scrubber cannot detect a credential cut in half by a prefix limit.
 * Redact complete fitting strings; replace oversized inputs wholesale, without
 * unbounded scanning/encoding or passing partial credentials to the scrubber. Only
 * scrubbed output is UTF-8 clipped. The callback itself is trusted, not sandboxed. */
function boundedRedactedText(value: string, bytes: number, redact: (text: string) => string): string {
  if (value.length > bytes || Buffer.byteLength(value, 'utf8') > bytes) return utf8('[redacted]', bytes);
  return utf8(redact(value), bytes);
}

/** Do not invoke accessors/toJSON or keep producer references. Accepted output,
 * descriptor/key/node traversal and our string allocations are bounded. Producer
 * objects/proxies and redactors are privileged: traps, CPU execution and engine
 * enumeration internals (including for-in allocation) are not sandboxed/bounded. */
function boundedDetails(value: unknown, redact: (text: string) => string): { value: ToolProgressValue; truncated: boolean } {
  let nodes = 0;
  let inspectedKeys = 0;
  let bytes = TOOL_PROGRESS_LIMITS.detailsBytes;
  let truncated = false;
  const seen = new Set<object>();
  const text = (input: string): string => {
    const result = boundedRedactedText(input, Math.max(0, bytes), redact);
    bytes -= Buffer.byteLength(JSON.stringify(result));
    if (result !== input) truncated = true;
    return result;
  };
  const visit = (input: unknown, depth: number): ToolProgressValue => {
    if (++nodes > TOOL_PROGRESS_LIMITS.nodes || depth > TOOL_PROGRESS_LIMITS.depth || bytes < 16) {
      truncated = true; return null;
    }
    bytes -= 8;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'string') return text(input);
    if (!input || typeof input !== 'object' || seen.has(input)) { truncated = true; return null; }
    seen.add(input);
    const output: { [key: string]: ToolProgressValue } = Object.create(null) as { [key: string]: ToolProgressValue };
    const array: ToolProgressValue[] = [];
    let isArray = false;
    try {
      isArray = Array.isArray(input);
      if (isArray) {
        const descriptor = Object.getOwnPropertyDescriptor(input, 'length');
        const length: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
        if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
          truncated = true; return array;
        }
        // JSON array shape: holes are null, indices retain order, named properties
        // are ignored. Unlike JSON.stringify, inherited indices/accessors/toJSON
        // are deliberately not executed. Never allocate from producer length.
        for (let index = 0; index < length; index++) {
          if (++inspectedKeys > TOOL_PROGRESS_LIMITS.nodes || nodes >= TOOL_PROGRESS_LIMITS.nodes || bytes < 16) {
            truncated = true; break;
          }
          const entry = Object.getOwnPropertyDescriptor(input, String(index));
          if (entry && !('value' in entry)) {
            truncated = true;
            array.push(visit(null, depth + 1));
          } else array.push(visit(entry ? entry.value : null, depth + 1));
        }
      } else {
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null) { truncated = true; return null; }
        // Bound keys processed by our loop, not engine enumeration internals.
        for (const key in input) {
          if (++inspectedKeys > TOOL_PROGRESS_LIMITS.nodes || nodes >= TOOL_PROGRESS_LIMITS.nodes || bytes < 16) {
            truncated = true; break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          if (!descriptor || !('value' in descriptor)) { truncated = true; continue; }
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') { truncated = true; continue; }
          output[text(key)] = visit(descriptor.value, depth + 1);
        }
      }
    } catch { truncated = true; }
    return isArray ? array : output;
  };
  const result = visit(value, 0);
  // JSON syntax/key overhead also counts toward the hard wire/persistence limit.
  if (Buffer.byteLength(JSON.stringify(result)) > TOOL_PROGRESS_LIMITS.detailsBytes) return { value: null, truncated: true };
  return { value: result, truncated };
}

/** One in-flight sink and one latest pending snapshot. Ignored Promises cannot grow
 * a queue; cooperating producers await downstream backpressure. Settlement drains
 * accepted work before the durable terminal result; abort discards pending/late work. */
export class ToolProgressChannel {
  private submissions = 0;
  private deliveries = 0;
  private omitted = 0;
  private sequence = 0;
  private latest?: ToolProgressSnapshot;
  private pending?: ToolProgressSnapshot;
  private draining?: Promise<void>;
  private closed = false;
  private settlement?: Promise<ToolProgressSnapshot | undefined>;
  private error?: unknown;
  private readonly callId: string;
  private readonly toolName: string;
  private readonly startedAt = performance.now();
  private readonly abort = (): void => {
    if (this.pending) this.omitted++;
    this.pending = undefined;
  };

  constructor(call: ToolCall,
    private readonly sink?: (snapshot: ToolProgressSnapshot) => void | Promise<void>,
    private readonly signal?: AbortSignal,
    private readonly redact: (text: string) => string = text => text) {
    this.callId = call.id;
    this.toolName = call.name;
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  readonly report = (input: ToolProgressInput): Promise<void> => {
    if (this.closed || this.signal?.aborted || this.error) return Promise.resolve();
    if (++this.submissions > TOOL_PROGRESS_LIMITS.submissions) { this.omitted++; return this.draining ?? Promise.resolve(); }
    try {
      if (!input || Object.getOwnPropertyDescriptor(input, 'version')?.value !== TOOL_PROGRESS_VERSION) {
        this.omitted++; return this.draining ?? Promise.resolve();
      }
      const content = Object.getOwnPropertyDescriptor(input, 'content')?.value as unknown;
      const details = Object.getOwnPropertyDescriptor(input, 'details');
      if (content !== undefined && typeof content !== 'string') { this.omitted++; return this.draining ?? Promise.resolve(); }
      const snapshot: ToolProgressSnapshot = { ...this.latest, version: TOOL_PROGRESS_VERSION,
        toolCallId: this.callId, toolName: this.toolName, sequence: ++this.sequence,
        status: 'running', durationMs: this.duration(), truncated: this.latest?.truncated ?? false,
        omittedUpdates: this.omitted };
      if (typeof content === 'string') {
        snapshot.content = boundedRedactedText(content, TOOL_PROGRESS_LIMITS.contentBytes, this.redact);
        snapshot.truncated ||= snapshot.content !== content;
      }
      if (details && 'value' in details) {
        const bounded = boundedDetails(details.value, this.redact);
        snapshot.details = bounded.value;
        snapshot.truncated ||= bounded.truncated;
      }
      if (this.pending) this.omitted++;
      snapshot.omittedUpdates = this.omitted;
      this.latest = snapshot;
      this.pending = snapshot;
      if (!this.draining) this.beginDrain();
      return this.draining!;
    } catch {
      this.omitted++; return this.draining ?? Promise.resolve();
    }
  };

  private beginDrain(): void {
    let complete!: () => void;
    // Install before entering the sink: synchronous reentrant producers must
    // also coalesce rather than create another in-flight delivery.
    this.draining = new Promise<void>(resolve => { complete = resolve; });
    const settled = (): void => { this.draining = undefined; complete(); };
    void this.drain().then(settled, error => {
      this.error = error instanceof Error ? error : new Error('Tool progress sink failed.');
      this.pending = undefined;
      settled();
    });
  }

  private duration(): number { return Math.max(0, Math.round(performance.now() - this.startedAt)); }
  private async drain(): Promise<void> {
    while (this.pending && !this.signal?.aborted) {
      const snapshot = this.pending;
      this.pending = undefined;
      if (++this.deliveries > TOOL_PROGRESS_LIMITS.deliveries) { this.omitted++; continue; }
      try { await this.sink?.(structuredClone(snapshot)); }
      catch (error) {
        this.error = error instanceof Error ? error : new Error('Tool progress sink failed.');
        if (this.pending) this.omitted++;
        this.pending = undefined;
        break;
      }
    }
  }

  finish(status: ToolProgressSnapshot['status']): Promise<ToolProgressSnapshot | undefined> {
    this.settlement ??= this.settle(status);
    return this.settlement.then(snapshot => snapshot ? structuredClone(snapshot) : undefined);
  }

  private async settle(status: ToolProgressSnapshot['status']): Promise<ToolProgressSnapshot | undefined> {
    this.closed = true;
    await this.draining;
    this.signal?.removeEventListener('abort', this.abort);
    this.pending = undefined;
    if (!this.latest) return undefined;
    this.latest = { ...this.latest, sequence: ++this.sequence,
      status: this.signal?.aborted ? 'cancelled' : this.error ? 'failed' : status,
      durationMs: this.duration(), omittedUpdates: this.omitted };
    return this.latest;
  }

  get failure(): unknown { return this.error; }
}
