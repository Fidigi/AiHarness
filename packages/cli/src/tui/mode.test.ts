import { describe, expect, it } from 'vitest';
import { resolveTerminalMode } from './mode';

describe('resolveTerminalMode', () => {
  it('selects fullscreen automatically on supported terminals', () => {
    expect(resolveTerminalMode([], {}, true)).toBe('fullscreen');
  });

  it('falls back to regular mode outside a TTY', () => {
    expect(resolveTerminalMode([], {}, false)).toBe('regular');
    expect(resolveTerminalMode(['--fullscreen'], {}, false)).toBe('regular');
  });

  it('honours explicit CLI flags before the environment', () => {
    expect(resolveTerminalMode(['--regular'], { AI_HARNESS_TUI_MODE: 'fullscreen' }, true)).toBe('regular');
    expect(resolveTerminalMode(['--fullscreen'], { AI_HARNESS_TUI_MODE: 'regular' }, true)).toBe('fullscreen');
  });

  it('supports AI_HARNESS_TUI_MODE', () => {
    expect(resolveTerminalMode([], { AI_HARNESS_TUI_MODE: 'regular' }, true)).toBe('regular');
    expect(resolveTerminalMode([], { AI_HARNESS_TUI_MODE: 'fullscreen' }, true)).toBe('fullscreen');
  });
});
