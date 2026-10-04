import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalEscapeSequence } from './terminal-escape';

afterEach(() => vi.useRealTimers());

describe('TerminalEscapeSequence', () => {
  it('dispatches a lone Escape after the grace period', () => {
    vi.useFakeTimers();
    const onEscape = vi.fn();
    const sequence = new TerminalEscapeSequence(onEscape, 25);

    sequence.deferEscape();
    vi.advanceTimersByTime(24);
    expect(onEscape).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('recognizes split Alt+Enter and cancels the Escape action', () => {
    vi.useFakeTimers();
    const onEscape = vi.fn();
    const sequence = new TerminalEscapeSequence(onEscape, 25);

    sequence.deferEscape();
    expect(sequence.consumeFollowingKey({ name: 'return' })).toBe(true);
    vi.runAllTimers();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('cancels a pending Escape when another key follows', () => {
    vi.useFakeTimers();
    const onEscape = vi.fn();
    const sequence = new TerminalEscapeSequence(onEscape, 25);

    sequence.deferEscape();
    expect(sequence.consumeFollowingKey({ name: 'x' })).toBe(false);
    vi.runAllTimers();
    expect(onEscape).not.toHaveBeenCalled();
  });
});
