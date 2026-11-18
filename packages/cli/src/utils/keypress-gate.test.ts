import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { KeypressFilteredInput } from './keypress-gate.js';
import { KeyBindingManager } from './keybinding-manager.js';

function fixture() {
  const source = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  const input = new KeypressFilteredInput(source);
  const output = Object.assign(new PassThrough(), { columns: 80, isTTY: true });
  const rl = createInterface({ input, output, terminal: true });
  return { source, input, rl, close() { rl.close(); input.dispose(); source.destroy(); output.destroy(); } };
}
describe('actual readline keypress interception', () => {
  it('consumes a matched key before the native editor handles it', async () => {
    const f = fixture();
    try {
      f.rl.write('preserved draft'); let intercepted!: () => void;
      const seen = new Promise<void>(resolve => { intercepted = resolve; });
      const gate = vi.fn((_text, key) => { if (key.ctrl && key.name === 'u') { intercepted(); return true; } return false; });
      f.input.setKeypressGate(gate); f.source.write('\u0015'); await seen;
      expect(f.rl.line).toBe('preserved draft'); expect(gate).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it('passes unconsumed keys to the real native editor exactly once', async () => {
    const f = fixture();
    try {
      f.rl.write('draft'); const gate = vi.fn(() => false); f.input.setKeypressGate(gate);
      f.source.write('\u0015'); await setImmediate(); expect(f.rl.line).toBe(''); expect(gate).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
  it('preserves ordinary native line delivery', async () => {
    const f = fixture();
    try {
      const line = new Promise<string>(resolve => f.rl.once('line', resolve)); f.input.setKeypressGate(() => false);
      f.source.write('hello\n'); await expect(line).resolves.toBe('hello');
    } finally { f.close(); }
  });
  it('uses public readline.write for remapped editor actions without recursively gating', () => {
    const f = fixture();
    try {
      const gate = vi.fn(() => true); f.input.setKeypressGate(gate);
      f.rl.write('draft'); f.rl.write(null, { ctrl: true, name: 'u' });
      expect(f.rl.line).toBe(''); expect(gate).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('releases only the captured gate generation and cannot resurrect after disposal', () => {
    const f = fixture();
    try {
      const old = vi.fn(() => true), latest = vi.fn(() => true);
      const releaseOld = f.input.setKeypressGate(old), releaseLatest = f.input.setKeypressGate(latest);
      releaseOld(); f.input.emit('keypress', 'x', { name: 'x' }); expect(latest).toHaveBeenCalledOnce(); expect(old).not.toHaveBeenCalled();
      releaseLatest(); f.input.emit('keypress', 'x', { name: 'x' }); expect(latest).toHaveBeenCalledOnce();
      f.input.dispose(); f.input.setKeypressGate(old); f.input.emit('keypress', 'x', { name: 'x' }); expect(old).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('resolves actual Ctrl+/ control bytes even when Node names them underscore', async () => {
    const f = fixture();
    try {
      const manager = new KeyBindingManager(); let handled!: () => void;
      const complete = new Promise<void>(resolve => { handled = resolve; });
      const action = vi.fn(() => handled()); manager.registerAction('app.help', { handler: action });
      f.rl.write('draft'); f.input.setKeypressGate((_text, key) => manager.handleKeypress(key));
      f.source.write('\u001f'); await complete;
      expect(action).toHaveBeenCalledOnce(); expect(f.rl.line).toBe('draft');
    } finally { f.close(); }
  });
  it('captures fragmented UTF-8 bracketed paste inertly, without dispatching embedded controls or lines', async () => {
    const f = fixture(); const paste = vi.fn(); const line = vi.fn(); const gate = vi.fn(() => false);
    try {
      f.input.setPasteHandler(paste); f.input.setKeypressGate(gate); f.rl.on('line', line);
      const bytes = Buffer.from('\x1b[200~界🙂\r\n/quit\x03\x1b]52;c;FORGED\x07\x1b[201~');
      for (const byte of bytes) f.source.write(Buffer.from([byte]));
      await setImmediate(); expect(paste).toHaveBeenCalledExactlyOnceWith('界🙂\n/quit');
      expect(line).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.rl.line).toBe('');
    } finally { f.close(); }
  });
  it('rejects the whole oversized paste and discards unfinished paste at retirement', async () => {
    const f = fixture(); const paste = vi.fn();
    try {
      f.input.setPasteHandler(paste);
      f.source.write('\x1b[200~' + 'x'.repeat(65_537) + '\x1b[201~');
      await setImmediate(); expect(paste).toHaveBeenCalledExactlyOnceWith(undefined);
      f.source.write('\x1b[200~/quit\r'); f.input.dispose();
      await setImmediate(); expect(paste).toHaveBeenCalledTimes(1); expect(f.rl.line).toBe('');
    } finally { f.close(); }
  });
  it('retains theme-response filtering before decoding/gating user keys', async () => {
    const f = fixture();
    try {
      let complete!: () => void; const seen = new Promise<void>(resolve => { complete = resolve; });
      const values: string[] = [];
      f.input.setKeypressGate((text, key) => { values.push(text); if (key.name === 'x') complete(); return true; });
      f.source.write('\u001b]11;rgb:0000/0000/0000\u0007x'); await seen;
      expect(values).toEqual(['x']);
    } finally { f.close(); }
  });
});
