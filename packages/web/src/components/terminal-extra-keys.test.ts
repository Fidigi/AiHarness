import { describe, expect, it } from 'vitest';
import { applyTerminalModifiers, NO_TERMINAL_MODIFIERS, TERMINAL_EXTRA_KEYS, terminalExtraKeySequence, type TerminalExtraKey } from './terminal-extra-keys';
const normal: [TerminalExtraKey, string, string][] = [
  ['Escape', '\x1b', '\x1b'], ['/', '/', '/'], ['-', '-', '-'], ['Tab', '\t', '\t'],
  ['Home', '\x1b[H', '\x1bOH'], ['End', '\x1b[F', '\x1bOF'],
  ['ArrowUp', '\x1b[A', '\x1bOA'], ['ArrowDown', '\x1b[B', '\x1bOB'],
  ['ArrowRight', '\x1b[C', '\x1bOC'], ['ArrowLeft', '\x1b[D', '\x1bOD'],
  ['PageUp', '\x1b[5~', '\x1b[5~'], ['PageDown', '\x1b[6~', '\x1b[6~'],
];
describe('literal native terminal key encoding', () => {
  it.each(normal)('%s respects normal and application cursor modes', (key, expected, application) => {
    expect(terminalExtraKeySequence(key, NO_TERMINAL_MODIFIERS, false)).toBe(expected);
    expect(terminalExtraKeySequence(key, NO_TERMINAL_MODIFIERS, true)).toBe(application);
  });
  it.each([
    [true, false, 5], [false, true, 3], [true, true, 7],
  ] as const)('encodes xterm modifier parameters ctrl=%s alt=%s', (ctrl, alt, parameter) => {
    for (const application of [false, true]) {
      const modifiers = { ctrl, alt };
      for (const [key, final] of [['Home', 'H'], ['End', 'F'], ['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D']] as const) {
        expect(terminalExtraKeySequence(key, modifiers, application)).toBe(`\x1b[1;${parameter}${final}`);
      }
      expect(terminalExtraKeySequence('PageUp', modifiers, application)).toBe(`\x1b[5;${parameter}~`);
      expect(terminalExtraKeySequence('PageDown', modifiers, application)).toBe(`\x1b[6;${parameter}~`);
    }
  });
  it.each([
    ['c', '\x03'], ['Z', '\x1a'], ['@', '\x00'], ['[', '\x1b'], ['\\', '\x1c'], [']', '\x1d'], ['^', '\x1e'], ['_', '\x1f'],
    [' ', '\x00'], ['/', '\x1f'], ['-', '\x1f'], ['?', '\x7f'], ['é', 'é'], ['🦊', '🦊'], ['1', '1'],
  ])('maps CTRL %s without treating text as a command', (data, expected) => {
    expect(applyTerminalModifiers(data, { ctrl: true, alt: false })).toBe(expected);
    expect(applyTerminalModifiers(data, { ctrl: true, alt: true })).toBe('\x1b' + expected);
    expect(applyTerminalModifiers(data, { ctrl: false, alt: true })).toBe('\x1b' + data);
    expect(applyTerminalModifiers(data, NO_TERMINAL_MODIFIERS)).toBe(data);
  });
  it('preserves empty, pasted, composed and already encoded multi-character input', () => {
    for (const data of ['', 'ab', '漢字', 'e\u0301', '\x1b[A', 'print("unchanged")\n'.repeat(10_000)]) {
      expect(applyTerminalModifiers(data, { ctrl: true, alt: true })).toBe(data);
    }
  });
  it('keeps Escape/Tab semantics and only the declared literal key set', () => {
    expect(terminalExtraKeySequence('Escape', { ctrl: true, alt: true }, true)).toBe('\x1b\x1b');
    expect(terminalExtraKeySequence('Tab', { ctrl: true, alt: true }, false)).toBe('\x1b\t');
    expect(terminalExtraKeySequence('/', { ctrl: true, alt: false }, true)).toBe('\x1f');
    expect(terminalExtraKeySequence('-', { ctrl: true, alt: true }, true)).toBe('\x1b\x1f');
    expect(TERMINAL_EXTRA_KEYS).toEqual(['Escape', '/', '-', 'Home', 'ArrowUp', 'End', 'PageUp', 'Tab', 'ctrl', 'alt', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'PageDown']);
    expect(Object.isFrozen(TERMINAL_EXTRA_KEYS)).toBe(true);
    expect(NO_TERMINAL_MODIFIERS).toEqual({ ctrl: false, alt: false });
    expect(Object.isFrozen(NO_TERMINAL_MODIFIERS)).toBe(true);
  });
});
