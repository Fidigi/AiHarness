export const shortcutActions = [
  'newSession',
  'focusPrompt',
  'toggleSidebar',
  'toggleFiles',
  'toggleTerminal',
  'openSettings',
  'commandPalette',
] as const;

export type ShortcutAction = typeof shortcutActions[number];
export type Keybindings = Record<ShortcutAction, string>;

export const defaultKeybindings: Keybindings = {
  newSession: 'Mod+Shift+O',
  focusPrompt: 'Mod+L',
  toggleSidebar: 'Mod+Shift+S',
  toggleFiles: 'Mod+Shift+F',
  toggleTerminal: 'Mod+Shift+T',
  openSettings: 'Mod+,',
  commandPalette: 'Mod+K',
};

function normalizedKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return ({ Escape: 'Esc', Control: 'Ctrl', Meta: 'Meta', Alt: 'Alt', Shift: 'Shift' } as Record<string, string>)[key] ?? key;
}

/** Stable platform-neutral chord used by storage, matching and settings capture. */
export function chordFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return '';
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(normalizedKey(event.key));
  return parts.join('+');
}

export function matchesShortcut(event: KeyboardEvent, chord: string): boolean {
  return Boolean(chord) && chordFromEvent(event) === chord;
}

export function shortcutLabel(chord: string): string {
  const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return chord.replace('Mod', apple ? '⌘' : 'Ctrl').replaceAll('+', apple ? '' : '+');
}
