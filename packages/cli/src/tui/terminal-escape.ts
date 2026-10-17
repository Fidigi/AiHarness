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

  /** Inspect pending interpretation without stealing the native driver's timer/key. */
  isFollowingEnter(key: readline.Key): boolean {
    return this.timer !== undefined && (key.name === 'return' || key.name === 'enter') && !key.ctrl && !key.shift;
  }

  consumeFollowingKey(key: readline.Key): boolean {
    const enter = this.isFollowingEnter(key);
    this.cancel();
    return enter;
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
