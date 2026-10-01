import { describe, expect, it, vi } from 'vitest';
import { AGENT_EVENT_PROTOCOL_VERSION, AgentEventJournal } from './events.js';

describe('AgentEventJournal', () => {
  it('isolates sessions, sequences events, and unsubscribes listeners', () => {
    const journal = new AgentEventJournal(10);
    const listener = vi.fn();
    const unsubscribe = journal.subscribe('one', listener);
    const first = journal.publish('one', 'run.started', { ok: true }, 'run-1');
    journal.publish('two', 'notice', { message: 'other' });
    unsubscribe();
    journal.publish('one', 'run.completed', {});

    expect(first).toMatchObject({ protocolVersion: AGENT_EVENT_PROTOCOL_VERSION, id: 'one:1', sequence: 1, runId: 'run-1' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(journal.replay('one').events.map(event => event.sequence)).toEqual([1, 2]);
    expect(journal.lastSequence('two')).toBe(1);
  });

  it('bounds history and requests a snapshot reset for stale cursors', () => {
    const journal = new AgentEventJournal(10);
    for (let index = 1; index <= 15; index++) journal.publish('session', 'message.delta', { index });

    const stale = journal.replay('session', 2);
    expect(stale.reset).toBe(true);
    expect(stale.lastSequence).toBe(15);
    expect(stale.events.map(event => event.sequence)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(journal.replay('session', 10)).toMatchObject({ reset: false, lastSequence: 15 });
  });
});
