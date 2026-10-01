import { describe, expect, it, vi } from 'vitest';
import { chordFromEvent, matchesShortcut, shortcutLabel } from './keyboard';

describe('keyboard shortcuts', () => {
  it('normalizes Ctrl and Meta to portable Mod chords', () => {
    expect(chordFromEvent({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe('Mod+K');
    expect(chordFromEvent({ key: 'O', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true })).toBe('Mod+Shift+O');
    expect(chordFromEvent({ key: 'Shift', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBe('');
  });

  it('matches complete chords without accepting extra modifiers', () => {
    const event = { key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true } as KeyboardEvent;
    expect(matchesShortcut(event, 'Mod+Shift+F')).toBe(true);
    expect(matchesShortcut(event, 'Mod+F')).toBe(false);
  });

  it('renders a readable platform label', () => {
    vi.stubGlobal('navigator', { platform: 'Linux' });
    expect(shortcutLabel('Mod+Shift+T')).toBe('Ctrl+Shift+T');
    vi.unstubAllGlobals();
  });
});
