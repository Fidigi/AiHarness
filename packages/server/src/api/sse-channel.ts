import type { Response } from 'express';
import type { CredentialRedactionStream } from '@ai-harness/core';

const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const SSE_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;

/** Final, stateful credential-redacting boundary for non-chat SSE endpoints. */
export class SseChannel {
  private ended = false;
  private flushed = false;

  constructor(
    private readonly response: Response,
    private readonly redactor: CredentialRedactionStream,
  ) {}

  send(event: string, data: unknown, id?: string | number): boolean {
    if (!SSE_TOKEN.test(event) || (id !== undefined && !SSE_TOKEN.test(String(id)))) {
      return this.failClosed();
    }
    let json: string;
    try { json = JSON.stringify(data); }
    catch { return this.failClosed(); }
    return this.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${json}\n\n`);
  }

  heartbeat(): boolean {
    return this.write(': heartbeat\n\n');
  }

  close(): void {
    if (this.ended) return;
    this.flush();
    this.ended = true;
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
      if (safe && this.response.write(safe) === false) return this.failClosed();
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
    if (!this.response.writableEnded && !this.response.destroyed) this.response.end();
    return false;
  }
}
