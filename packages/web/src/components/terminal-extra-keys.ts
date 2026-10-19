export type TerminalExtraKey = 'Escape' | '/' | '-' | 'Home' | 'ArrowUp' | 'End' | 'PageUp'
  | 'Tab' | 'ArrowLeft' | 'ArrowDown' | 'ArrowRight' | 'PageDown';
export type TerminalModifier = 'ctrl' | 'alt';
export interface TerminalModifiers { ctrl: boolean; alt: boolean }
export const NO_TERMINAL_MODIFIERS: Readonly<TerminalModifiers> = Object.freeze({ ctrl: false, alt: false });
export const TERMINAL_EXTRA_KEYS: readonly (TerminalExtraKey | TerminalModifier)[] = Object.freeze([
  'Escape', '/', '-', 'Home', 'ArrowUp', 'End', 'PageUp',
  'Tab', 'ctrl', 'alt', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'PageDown',
]);
const finals: Partial<Record<TerminalExtraKey, string>> = {
  Home: 'H', End: 'F', ArrowUp: 'A', ArrowDown: 'B', ArrowLeft: 'D', ArrowRight: 'C',
};
function ctrlCharacter(data: string): string {
  if (/^[a-z@-_]$/i.test(data)) return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
  if (data === ' ') return '\x00';
  if (data === '/' || data === '-') return '\x1f';
  if (data === '?') return '\x7f';
  return data;
}
/** A paste/IME batch is never reinterpreted as a list of control keystrokes. */
export function applyTerminalModifiers(data: string, modifiers: Readonly<TerminalModifiers>): string {
  if (data.length > 2 || [...data].length !== 1) return data;
  const value = modifiers.ctrl ? ctrlCharacter(data) : data;
  return modifiers.alt ? `\x1b${value}` : value;
}
export function terminalExtraKeySequence(key: TerminalExtraKey, modifiers: Readonly<TerminalModifiers>, applicationCursor: boolean): string {
  const parameter = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const final = finals[key];
  if (final) return parameter > 1 ? `\x1b[1;${parameter}${final}` : applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
  if (key === 'PageUp' || key === 'PageDown') return `\x1b[${key === 'PageUp' ? 5 : 6}${parameter > 1 ? `;${parameter}` : ''}~`;
  if (key === 'Escape') return modifiers.alt ? '\x1b\x1b' : '\x1b';
  if (key === 'Tab') return modifiers.alt ? '\x1b\t' : '\t';
  return applyTerminalModifiers(key, modifiers);
}
