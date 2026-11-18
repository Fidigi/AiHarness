import { describe, expect, it } from 'vitest';
import { unseenMessagesAfter } from './history-reading';

const rows = (...ids: string[]) => ids.map(id => ({ id }));

describe('loaded conversation reading tail', () => {
  it('does not call prepended historical entries new messages', () => {
    expect(unseenMessagesAfter(rows('earlier-1', 'earlier-2', 'seen'), 'seen')).toBe(0);
  });
  it('retains genuine new entries when an older page fills a gap concurrently', () => {
    expect(unseenMessagesAfter(rows('earlier', 'seen', 'new-user', 'new-assistant'), 'seen')).toBe(2);
  });
  it('deduplicated or overlapping history leaves the observed tail unchanged', () => {
    expect(unseenMessagesAfter(rows('earlier', 'seen', 'new-assistant'), 'seen')).toBe(1);
    expect(unseenMessagesAfter(rows('seen', 'new-assistant'), 'seen')).toBe(1);
  });
  it('does not invent evidence from a missing tail or replacement window', () => {
    expect(unseenMessagesAfter(rows('old-1', 'old-2'), undefined)).toBe(0);
    expect(unseenMessagesAfter(rows('replacement'), 'retired')).toBe(0);
    expect(unseenMessagesAfter([], 'seen')).toBe(0);
  });
  it('counts from identity rather than timestamps or special object keys without mutating the window', () => {
    const messages = Object.freeze(rows('__proto__', 'constructor', 'new'));
    expect(unseenMessagesAfter(messages, '__proto__')).toBe(2);
    expect(unseenMessagesAfter(messages, 'constructor')).toBe(1);
    expect(messages).toEqual(rows('__proto__', 'constructor', 'new'));
  });
});
