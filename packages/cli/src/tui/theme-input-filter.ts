import { Transform, type TransformCallback } from 'node:stream';
import { TerminalThemeResponseFilter } from '@ai-harness/core';

interface TerminalInputSource extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  pipe<T extends NodeJS.WritableStream>(destination: T): T;
  unpipe(destination?: NodeJS.WritableStream): this;
}

/**
 * Preserve normal terminal input while keeping OSC/CSI theme reports away from
 * readline and the fullscreen editor. Raw stdin remains visible to the probe.
 */
export class ThemeFilteredInput extends Transform {
  private readonly responseFilter = new TerminalThemeResponseFilter();
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly source: TerminalInputSource = process.stdin) {
    super();
    source.pipe(this);
  }

  get isTTY(): boolean {
    return this.source.isTTY === true;
  }

  get isRaw(): boolean {
    return this.source.isRaw === true;
  }

  setRawMode(mode: boolean): void {
    this.source.setRawMode?.(mode);
  }

  private schedulePendingFlush(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    if (!this.responseFilter.hasPending() || this.disposed) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      const pending = this.responseFilter.flush();
      if (pending.length && !this.destroyed) this.push(pending);
      this.schedulePendingFlush();
    }, this.responseFilter.pendingTimeoutMs());
    this.pendingTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    const pending = this.responseFilter.flush();
    if (pending.length) this.push(pending);
    this.source.unpipe(this);
    this.end();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    const safe = this.responseFilter.push(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    if (safe.length) this.push(safe);
    this.schedulePendingFlush();
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    const pending = this.responseFilter.flush();
    if (pending.length) this.push(pending);
    callback();
  }
}
