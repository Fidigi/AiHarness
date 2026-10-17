import type { KeyBinding } from '@ai-harness/core';

/** Every configurable application/editor action; callbacks remain owned by the input host. */
export const TERMINAL_ACTIONS = [
  { id: 'app.interrupt', description: 'Interrupt current operation or exit', keys: ['ctrl+c'], reserved: true },
  { id: 'app.exit', description: 'Exit the application when the editor is empty', keys: ['ctrl+d'], reserved: true },
  { id: 'app.escape', description: 'Cancel the current operation or close hotkeys', keys: ['escape'], reserved: true },
  { id: 'app.help', description: 'Show command help', keys: ['alt+h', 'ctrl+slash'] },
  { id: 'app.hotkeys', description: 'Browse and filter all keyboard actions', keys: ['f1', 'alt+k'] },
  { id: 'terminal.clear', description: 'Refresh the terminal screen', keys: ['ctrl+l'] },
  { id: 'input.submit', description: 'Submit input or steer the active conversation', keys: ['enter'] },
  { id: 'input.followUp', description: 'Submit a follow-up', keys: ['alt+enter', 'ctrl+q'] },
  { id: 'input.dequeue', description: 'Restore queued input or scroll up', keys: ['alt+up'] },
  { id: 'input.externalEditor', description: 'Edit the current draft in the external editor', keys: ['ctrl+g'] },
  { id: 'transcript.up', description: 'Scroll up in transcript', keys: ['pageup'] },
  { id: 'transcript.down', description: 'Scroll down in transcript', keys: ['pagedown', 'alt+down'] },
  { id: 'editor.left', description: 'Move cursor left', keys: ['left'] },
  { id: 'editor.right', description: 'Move cursor right', keys: ['right'] },
  { id: 'editor.home', description: 'Move cursor to beginning', keys: ['home', 'ctrl+a'] },
  { id: 'editor.end', description: 'Move cursor to end', keys: ['end', 'ctrl+e'] },
  { id: 'editor.previous', description: 'Previous editor history entry', keys: ['up'] },
  { id: 'editor.next', description: 'Next editor history entry', keys: ['down'] },
  { id: 'editor.backspace', description: 'Delete before cursor', keys: ['backspace'] },
  { id: 'editor.delete', description: 'Delete after cursor', keys: ['delete'] },
  { id: 'editor.clear', description: 'Clear the editor', keys: ['ctrl+u'] },
  { id: 'editor.complete', description: 'Complete the current command', keys: ['tab'] },
] as const;
export type TerminalActionId = typeof TERMINAL_ACTIONS[number]['id'];
export const RESERVED_TERMINAL_KEYS = new Map<string, TerminalActionId>([
  ['c+ctrl', 'app.interrupt'], ['ctrl+d', 'app.exit'], ['escape', 'app.escape'],
  ['alt+escape', 'app.escape'], // Node may mark a bare Escape as meta.
]);
export function defaultTerminalBindings(): KeyBinding[] {
  return TERMINAL_ACTIONS.flatMap(action => action.keys.map(chord => ({
    id: `${action.id}:${chord}`, action: action.id, keys: chord.split('+').sort(), description: action.description,
  })));
}

/** Native editor methods bypass the stream's keypress gate, so remaps never recurse. */
export const EDITOR_ACTION_KEYS: Partial<Record<TerminalActionId, { name: string; ctrl?: boolean; meta?: boolean }>> = {
  'app.interrupt': { name: 'c', ctrl: true }, 'app.exit': { name: 'd', ctrl: true },
  'app.escape': { name: 'escape' }, 'terminal.clear': { name: 'l', ctrl: true },
  'input.submit': { name: 'return' }, 'input.followUp': { name: 'q', ctrl: true },
  'input.dequeue': { name: 'up', meta: true }, 'input.externalEditor': { name: 'g', ctrl: true },
  'editor.left': { name: 'left' }, 'editor.right': { name: 'right' }, 'editor.home': { name: 'home' },
  'editor.end': { name: 'end' }, 'editor.previous': { name: 'up' }, 'editor.next': { name: 'down' },
  'editor.backspace': { name: 'backspace' }, 'editor.delete': { name: 'delete' },
  'editor.clear': { name: 'u', ctrl: true }, 'editor.complete': { name: 'tab' },
};
