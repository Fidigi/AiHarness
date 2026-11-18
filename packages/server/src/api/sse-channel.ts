import type { Response } from 'express';
import type { CredentialRedactionStream } from '@ai-harness/core';

const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const SSE_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;
const MAX_QUEUED_EVENTS = 256;
const DRAIN_TIMEOUT_MS = 30_000;

export interface SseRebuildPolicy {
  /** Complete replacement snapshots only, never lifecycle/terminal records. */
  coalesceKey?: string;
  /** Deltas may be removed only by an authoritative complete checkpoint for this exact key. */
  deltaKey?: string;
  completedKey?: string;
}
interface QueuedFrame { raw: string; bytes: number; policy: SseRebuildPolicy }

/** Final, stateful credential-redacting boundary for non-chat SSE endpoints. */
export class SseChannel {
  private ended = false;
  private flushed = false;
  private blocked = false;
  private readonly queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private deadline?: NodeJS.Timeout;
  private readonly cleanup = (): void => {
    this.ended = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
    this.response.off('drain', this.drain);
    this.response.off('close', this.cleanup);
    this.response.off('finish', this.cleanup);
    this.queue.length = 0;
    this.queuedBytes = 0;
  };
  private readonly drain = (): void => {
    if (this.ended) return;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
    this.blocked = false;
    while (this.queue.length && !this.blocked && !this.ended) {
      const frame = this.queue.shift()!;
      this.queuedBytes -= frame.bytes;
      this.write(frame.raw);
    }
  };

  constructor(
    private readonly response: Response,
    private readonly redactor: CredentialRedactionStream,
    private readonly buffered = false,
  ) {
    if (buffered) {
      response.on('drain', this.drain);
      response.once('close', this.cleanup);
      response.once('finish', this.cleanup);
    }
  }

  send(event: string, data: unknown, id?: string | number, policy: SseRebuildPolicy = {}): boolean {
    if (!SSE_TOKEN.test(event) || (id !== undefined && !SSE_TOKEN.test(String(id)))) {
      return this.failClosed();
    }
    let json: string;
    try { json = JSON.stringify(data); }
    catch { return this.failClosed(); }
    const raw = `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${json}\n\n`;
    if (!this.buffered || !this.blocked) return this.write(raw);
    if (this.ended || this.response.writableEnded || this.response.destroyed) return false;
    const bytes = Buffer.byteLength(raw);
    if (bytes > MAX_SSE_EVENT_BYTES) return this.failClosed();
    // Remove only not-yet-written frames. Append replacements at their real
    // sequence position, preserving monotonic IDs and every start/end barrier.
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const previous = this.queue[index]!;
      if ((policy.coalesceKey && previous.policy.coalesceKey === policy.coalesceKey)
        || (policy.completedKey && previous.policy.deltaKey === policy.completedKey)) {
        this.queuedBytes -= previous.bytes;
        this.queue.splice(index, 1);
      }
    }
    const pending = this.response.writableLength || 0;
    if (this.queue.length >= MAX_QUEUED_EVENTS || pending + this.queuedBytes + bytes > MAX_SSE_BUFFERED_BYTES) return this.failClosed();
    this.queue.push({ raw, bytes, policy: { ...policy } });
    this.queuedBytes += bytes;
    return true;
  }

  heartbeat(): boolean {
    return this.blocked && this.buffered ? !this.ended : this.write(': heartbeat\n\n');
  }

  close(): void {
    if (this.ended) return;
    this.flush();
    this.ended = true;
    if (this.buffered) this.cleanup();
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end();
  }

  private write(raw: string): boolean {
    if (this.ended || this.response.writableEnded || this.response.destroyed) return false;
    if (Buffer.byteLength(raw) > MAX_SSE_EVENT_BYTES) return this.failClosed();
    let safe: string;
    try { safe = this.redactor.push(raw); }
    catch { return this.failClosed(); }
    const safeBytes = Buffer.byteLength(safe);
    if (safeBytes > MAX_SSE_EVENT_BYTES) return this.failClosed();
    const pendingBytes = typeof this.response.writableLength === 'number' ? this.response.writableLength : 0;
    if (pendingBytes + safeBytes > MAX_SSE_BUFFERED_BYTES) return this.failClosed();
    try {
      if (safe && this.response.write(safe) === false) {
        if (!this.buffered) return this.failClosed();
        this.blocked = true;
        this.deadline ??= setTimeout(() => this.failClosed(), DRAIN_TIMEOUT_MS);
        this.deadline.unref();
      }
      return true;
    } catch {
      return this.failClosed();
    }
  }

  private flush(): void {
    if (this.flushed || this.response.writableEnded || this.response.destroyed) return;
    this.flushed = true;
    try {
      const suffix = this.redactor.flush();
      const suffixBytes = Buffer.byteLength(suffix);
      const pendingBytes = typeof this.response.writableLength === 'number' ? this.response.writableLength : 0;
      if (suffix && suffixBytes <= MAX_SSE_EVENT_BYTES
        && pendingBytes + suffixBytes <= MAX_SSE_BUFFERED_BYTES) this.response.write(suffix);
    } catch { /* A failed redactor is closed without exposing its pending suffix. */ }
  }

  private failClosed(): false {
    if (!this.flushed) {
      this.flushed = true;
      try { this.redactor.flush(); } catch { /* Discard pending bytes on a failed channel. */ }
    }
    this.ended = true;
    if (this.buffered) this.cleanup();
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end();
    return false;
  }
}
