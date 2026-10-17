import type { Key } from 'node:readline';
import { ThemeFilteredInput } from '../tui/theme-input-filter.js';

type KeypressGate = (text: string, key: Key) => boolean;
/** Public EventEmitter interception, before readline's editor listener; no private Node APIs. */
export class KeypressFilteredInput extends ThemeFilteredInput {
  private keypressGate?: KeypressGate;
  private retired = false;
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
    this.retired = true; this.keypressGate = undefined;
    super.dispose();
  }
}
