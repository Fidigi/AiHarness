import { useSyncExternalStore } from 'react';
import type { ITheme } from '@xterm/xterm';
export type TerminalTheme = 'dark' | 'light';
export const TERMINAL_THEME_KEY = 'ai-harness-terminal-theme-v1';
export function parseTerminalTheme(value: unknown): TerminalTheme { return value === 'light' ? 'light' : 'dark'; }
export const TERMINAL_THEMES: Readonly<Record<TerminalTheme, Readonly<ITheme>>> = Object.freeze({
  dark: Object.freeze({ background: '#111827', foreground: '#e5e7eb', cursor: '#a4c2f4', selectionBackground: '#334155' }),
  light: Object.freeze({
    background: '#f8fafc', foreground: '#1e293b', cursor: '#1d4ed8', cursorAccent: '#f8fafc', selectionBackground: '#bfdbfe',
    black: '#1e293b', red: '#b91c1c', green: '#166534', yellow: '#854d0e', blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0e7490', white: '#64748b',
    brightBlack: '#475569', brightRed: '#991b1b', brightGreen: '#14532d', brightYellow: '#713f12', brightBlue: '#1e40af', brightMagenta: '#6b21a8', brightCyan: '#155e75', brightWhite: '#475569',
  }),
});
let current: TerminalTheme | undefined;
let volatile = false;
const listeners = new Set<() => void>();
function readStored(): TerminalTheme {
  try { return parseTerminalTheme(window.localStorage.getItem(TERMINAL_THEME_KEY)); }
  catch { return current ?? 'dark'; }
}
const snapshot = () => current ??= readStored();
const notify = () => { for (const listener of listeners) listener(); };
function storage(event: StorageEvent): void {
  if (event.key !== null && event.key !== TERMINAL_THEME_KEY) return;
  try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
  catch { return; }
  volatile = false; current = readStored(); notify();
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size) {
    window.addEventListener('storage', storage);
    // A failed own write remains authoritative in memory, even before first subscription.
    if (!volatile) current = readStored();
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', storage); };
}
export function setTerminalTheme(value: TerminalTheme): void {
  current = parseTerminalTheme(value);
  try { window.localStorage.setItem(TERMINAL_THEME_KEY, current); volatile = false; } catch { volatile = true; }
  notify();
}
export function useTerminalTheme(): TerminalTheme { return useSyncExternalStore(subscribe, snapshot, () => 'dark'); }
