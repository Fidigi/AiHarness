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

  it('honours explicit and legacy CLI flags before the environment', () => {
    expect(resolveTerminalMode(['--regular'], { AI_HARNESS_TUI_MODE: 'fullscreen' }, true)).toBe('regular');
    expect(resolveTerminalMode(['--fullscreen'], { AI_HARNESS_TUI_MODE: 'regular' }, true)).toBe('fullscreen');
    expect(resolveTerminalMode(['--tui-mode', 'regular'], { AI_HARNESS_TUI_MODE: 'fullscreen' }, true)).toBe('regular');
    expect(resolveTerminalMode(['--tui-mode=fullscreen'], { AI_HARNESS_TUI_MODE: 'regular' }, true)).toBe('fullscreen');
    expect(resolveTerminalMode(['--tui-mode', 'regular', '--fullscreen'], {}, true)).toBe('fullscreen');
    expect(resolveTerminalMode(['--fullscreen', '--tui-mode=regular'], {}, true)).toBe('regular');
    expect(resolveTerminalMode(['--', '--regular'], {}, true)).toBe('fullscreen');
  });

  it('supports environment and agent settings with environment precedence', () => {
    expect(resolveTerminalMode([], { AI_HARNESS_TUI_MODE: 'regular' }, true, 'fullscreen')).toBe('regular');
    expect(resolveTerminalMode([], { AI_HARNESS_TUI_MODE: 'fullscreen' }, true, 'regular')).toBe('fullscreen');
    expect(resolveTerminalMode([], {}, true, 'regular')).toBe('regular');
    expect(resolveTerminalMode([], {}, false, 'fullscreen')).toBe('regular');
  });
});
