import type readline from 'readline';

/** Keep raw Escape decoding responsive while allowing a short split-key grace period. */
export const TERMINAL_ESCAPE_CODE_TIMEOUT_MS = 25;

/**
 * Grace period for terminals that surface Alt+Enter as separate Escape and
 * Enter keypresses instead of one modified Enter event.
 */
export const TERMINAL_ESCAPE_GRACE_MS = 100;

/** Terminal-only Escape disambiguation; agent cancellation remains application-owned. */
export class TerminalEscapeSequence {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onEscape: () => void,
    private readonly graceMs = TERMINAL_ESCAPE_GRACE_MS,
  ) {}

  deferEscape(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onEscape();
    }, this.graceMs);
  }

  consumeFollowingKey(key: readline.Key): boolean {
    if (this.timer === undefined) return false;
    this.cancel();
    return (key.name === 'return' || key.name === 'enter') && !key.ctrl && !key.shift;
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
