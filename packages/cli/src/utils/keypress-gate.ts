import type { Key } from 'node:readline';
import type { TransformCallback } from 'node:stream';
import { terminalText } from '../tui/terminal-text.js';
import { ThemeFilteredInput } from '../tui/theme-input-filter.js';

type KeypressGate = (text: string, key: Key) => boolean;
/** Public EventEmitter interception, before readline's editor listener; no private Node APIs. */
export class KeypressFilteredInput extends ThemeFilteredInput {
  private keypressGate?: KeypressGate;
  private retired = false;
  private pasteHandler?: (value: string | undefined) => void;
  private pastePending = Buffer.alloc(0);
  private pasteChunks: Buffer[] = [];
  private pasteBytes = 0;
  private pasting = false;
  private pasteTimer?: ReturnType<typeof setTimeout>;
  setPasteHandler(handler: (value: string | undefined) => void): void { this.pasteHandler = handler; }
  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.pasteHandler) { super._transform(chunk, encoding, callback); return; }
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    let bytes = Buffer.concat([this.pastePending, Buffer.from(chunk)]);
    this.pastePending = Buffer.alloc(0);
    while (bytes.length) {
      const marker = Buffer.from(this.pasting ? '\x1b[201~' : '\x1b[200~');
      const index = bytes.indexOf(marker);
      if (index >= 0) {
        this.acceptBytes(bytes.subarray(0, index), encoding);
        bytes = bytes.subarray(index + marker.length);
        if (this.pasting) {
          const value = this.pasteBytes > 65_536 ? undefined : terminalText(Buffer.concat(this.pasteChunks).toString('utf8').replace(/\r\n?/g, '\n')).replace(/\t/g, ' ');
          this.pasting = false; this.pasteChunks = []; this.pasteBytes = 0;
          this.pasteHandler(value);
        } else this.pasting = true;
        continue;
      }
      let suffix = Math.min(marker.length - 1, bytes.length);
      while (suffix && !bytes.subarray(bytes.length - suffix).equals(marker.subarray(0, suffix))) suffix--;
      this.acceptBytes(bytes.subarray(0, bytes.length - suffix), encoding);
      this.pastePending = Buffer.from(bytes.subarray(bytes.length - suffix));
      break;
    }
    // Outside a paste, a lone Escape must still reach the ordinary bounded decoder.
    if (this.pastePending.length && !this.pasting) {
      this.pasteTimer = setTimeout(() => {
        const pending = this.pastePending; this.pastePending = Buffer.alloc(0);
        super._transform(pending, encoding, () => undefined);
      }, 10);
      this.pasteTimer.unref?.();
    }
    callback();
  }
  private acceptBytes(bytes: Buffer, encoding: BufferEncoding): void {
    if (!bytes.length) return;
    if (!this.pasting) super._transform(bytes, encoding, () => undefined);
    else {
      this.pasteBytes += bytes.length;
      if (this.pasteBytes <= 65_536) this.pasteChunks.push(Buffer.from(bytes));
      else this.pasteChunks = [];
    }
  }
  setKeypressGate(gate: KeypressGate): () => void {
    if (this.retired) return () => undefined;
    this.keypressGate = gate;
    return () => { if (this.keypressGate === gate) this.keypressGate = undefined; };
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'keypress' && this.keypressGate?.(typeof args[0] === 'string' ? args[0] : '', (args[1] ?? {}) as Key)) return true;
    return super.emit(event, ...args);
  }
  override dispose(): void {
    this.retired = true; this.keypressGate = undefined; this.pasteHandler = undefined;
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pastePending = Buffer.alloc(0); this.pasteChunks = [];
    super.dispose();
  }
}
