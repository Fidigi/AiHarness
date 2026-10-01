import { describe, expect, it } from 'vitest';
import type { Session } from '@ai-harness/core';
import { getSessionMessagePage, serializeSessionPage } from './session-pagination.js';

function session(size: number): Session {
  return {
    id: 'session-1',
    messages: Array.from({ length: size }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${index}`,
      timestamp: new Date(1_700_000_000_000 + index),
    })),
    commands: [{
      id: 'command-1', command: 'echo test', cwd: '/workspace', output: 'test',
      status: 'completed', excludedFromContext: false, timestamp: new Date(),
    }],
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-02T00:00:00.000Z'),
  };
}

describe('session pagination', () => {
  it('returns a tail followed by stable before pages', () => {
    const source = session(12);
    const tail = getSessionMessagePage(source, { limit: 5 });
    expect(tail.messages.map(message => message.id)).toEqual([
      'message-7', 'message-8', 'message-9', 'message-10', 'message-11',
    ]);
    expect(tail.page).toMatchObject({ start: 7, end: 12, total: 12, hasMoreBefore: true, hasMoreAfter: false, nextBefore: 'message-7' });

    const previous = getSessionMessagePage(source, { limit: 5, before: tail.page.nextBefore });
    expect(previous.messages.map(message => message.id)).toEqual([
      'message-2', 'message-3', 'message-4', 'message-5', 'message-6',
    ]);
    expect(previous.page).toMatchObject({ start: 2, end: 7, hasMoreBefore: true, hasMoreAfter: true });
  });

  it('loads an exact target window and rejects invalid cursors', () => {
    const source = session(30);
    const target = getSessionMessagePage(source, { limit: 9, around: 'message-4' });
    expect(target.messages.some(message => message.id === 'message-4')).toBe(true);
    expect(target.page).toMatchObject({ start: 1, end: 10, targetIndex: 4, hasMoreBefore: true, hasMoreAfter: true });
    expect(() => getSessionMessagePage(source, { before: 'missing' })).toThrow('Message cursor not found');
    expect(() => getSessionMessagePage(source, { around: 'missing' })).toThrow('Message target not found');
  });

  it('can serialize metadata-only summaries without commands or message payloads', () => {
    const serialized = serializeSessionPage(session(4), { limit: 0, includeCommands: false });
    expect(serialized.messages).toEqual([]);
    expect(serialized.commands).toBeUndefined();
    expect(serialized.messagePage).toMatchObject({ start: 4, end: 4, total: 4, hasMoreBefore: true });
  });
});
