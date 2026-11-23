import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { CredentialRedactor, type AgentEvent } from '@ai-harness/core';
import { describe, expect, it, vi } from 'vitest';
import { SseChannel } from './sse-channel.js';
import { agentEventPolicy } from './agent-event-policy.js';

function target() {
  const response = new EventEmitter() as EventEmitter & {
    writableEnded: boolean; destroyed: boolean; writableLength: number;
    write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>;
  };
  let pressured = true;
  const writes: string[] = [];
  Object.assign(response, { writableEnded: false, destroyed: false, writableLength: 0,
    write: vi.fn((text: string) => { writes.push(text); return !pressured; }),
    end: vi.fn(() => { response.writableEnded = true; response.emit('finish'); }),
  });
  const channel = new SseChannel(response as unknown as Response, new CredentialRedactor(['private-pressure-token']).createStream(), true);
  return { channel, response, writes, drain() { pressured = false; response.emit('drain'); } };
}
function event(sequence: number, type: AgentEvent['type'], data: unknown, runId = 'run'): AgentEvent {
  return { protocolVersion: 1, id: `session:${sequence}`, sessionId: 'session', runId, sequence,
    timestamp: '2026-01-01T00:00:00.000Z', type, data };
}
function send(channel: SseChannel, record: AgentEvent) {
  return channel.send(record.type, record, record.id, agentEventPolicy(record));
}
function records(writes: string[]): AgentEvent[] {
  return writes.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as AgentEvent);
}
const progress = (id: string, step: number) => ({ kind: 'tool', version: 1, toolCallId: id,
  toolName: 'read', status: 'running', sequence: step, content: String(step), durationMs: step, omittedUpdates: 0, truncated: false });

describe('detached event backpressure', () => {
  it('preserves every start/end and only the latest queued outer progress at its true sequence', () => {
    const test = target();
    send(test.channel, event(1, 'tool.started', { id: 'outer', name: 'read' }));
    for (let sequence = 2; sequence <= 1_002; sequence++) {
      expect(send(test.channel, event(sequence, 'tool.progress', progress('outer', sequence)))).toBe(true);
    }
    expect(send(test.channel, event(1_003, 'extension.ui', { action: 'resolved', requestId: 'dialog' }))).toBe(true);
    expect(send(test.channel, event(1_004, 'tool.completed', { call: { id: 'outer' }, content: 'complete' }))).toBe(true);
    expect(send(test.channel, event(1_005, 'run.completed', {}))).toBe(true);
    expect(test.response.end).not.toHaveBeenCalled();
    test.drain(); test.channel.close();
    expect(records(test.writes).map(record => record.sequence)).toEqual([1, 1_002, 1_003, 1_004, 1_005]);
    expect(test.response.listenerCount('drain')).toBe(0);
  });

  it('keeps independent parent/run identities and nested starts/ends uncoalesced', () => {
    const test = target();
    const input = [event(1, 'tool.started', { id: 'one', name: 'codemode' }),
      event(2, 'tool.progress', { kind: 'codemode', parentId: 'one', call: { id: 'nested', state: 'running' } }),
      event(3, 'tool.progress', progress('two', 1)),
      event(4, 'tool.progress', progress('three', 1)),
      event(5, 'tool.progress', progress('two', 2)),
      event(6, 'tool.progress', progress('two', 1), 'other-run'),
      event(7, 'tool.progress', { kind: 'codemode', parentId: 'one', call: { id: 'nested', state: 'completed' } }),
      event(8, 'tool.failed', { call: { id: 'one' } })];
    input.forEach(record => send(test.channel, record));
    test.drain(); test.channel.close();
    expect(records(test.writes).map(record => record.sequence)).toEqual([1, 2, 4, 5, 6, 7, 8]);
  });

  it('drops only queued deltas replaced by an exact complete checkpoint', () => {
    const test = target();
    const input = [event(1, 'message.start', { messageId: 'first' }),
      event(2, 'message.delta', { messageId: 'first', content: 'old' }),
      event(3, 'reasoning.delta', { messageId: 'first', content: 'thought' }),
      event(4, 'message.delta', { messageId: 'second', content: 'retained' }),
      event(5, 'message.completed', { messageId: 'first', content: 'entire answer', reasoning: 'entire thought' }),
      event(6, 'run.completed', {})];
    input.forEach(record => send(test.channel, record));
    test.drain(); test.channel.close();
    expect(records(test.writes).map(record => record.sequence)).toEqual([1, 4, 5, 6]);
    expect(records(test.writes)[2]!.data).toEqual(input[4]!.data);
  });

  it('does not discard deltas for legacy or malformed checkpoints, or foreign runs', () => {
    const test = target();
    const input = [event(1, 'message.start', { messageId: 'first' }),
      event(2, 'message.delta', { messageId: 'first', content: 'retained' }),
      event(3, 'message.completed', { content: 'legacy' }),
      event(4, 'message.completed', { messageId: 'first', content: 42 }),
      event(5, 'message.completed', { messageId: 'first', content: 'foreign' }, 'foreign')];
    input.forEach(record => send(test.channel, record));
    test.drain(); test.channel.close();
    expect(records(test.writes).map(record => record.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses irrecoverable essential-record count pressure rather than dropping terminal/UI events', () => {
    const test = target();
    send(test.channel, event(1, 'tool.started', {}));
    for (let sequence = 2; sequence <= 257; sequence++) expect(send(test.channel, event(sequence, 'extension.ui', { action: 'resolved' }))).toBe(true);
    expect(send(test.channel, event(258, 'run.stopped', {}))).toBe(false);
    expect(test.response.end).toHaveBeenCalledTimes(1);
    expect(test.response.listenerCount('drain')).toBe(0);
    test.drain();
    expect(test.writes).toHaveLength(1);
  });

  it('keeps the original byte/event caps and closes on undrained output after thirty seconds', () => {
    vi.useFakeTimers();
    try {
      const test = target();
      send(test.channel, event(1, 'tool.started', {}));
      for (let sequence = 2; sequence <= 4; sequence++) expect(send(test.channel, event(sequence, 'notice', { message: 'x'.repeat(900_000) }))).toBe(true);
      expect(send(test.channel, event(5, 'notice', { message: 'x'.repeat(900_000) }))).toBe(true);
      expect(send(test.channel, event(6, 'notice', { message: 'x'.repeat(900_000) }))).toBe(false);
      const timed = target();
      send(timed.channel, event(1, 'tool.started', {}));
      vi.advanceTimersByTime(29_999); expect(timed.response.end).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); expect(timed.response.end).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('queues detached bytes, maintains credential filtering, and disposes on client close', () => {
    const test = target();
    send(test.channel, event(1, 'tool.started', {}));
    const record = event(2, 'notice', { message: 'private-pressure-token' });
    send(test.channel, record);
    (record.data as { message: string }).message = 'mutated';
    test.drain(); test.channel.close();
    expect(test.writes.join('')).toContain('[REDACTED]');
    expect(test.writes.join('')).not.toMatch(/private-pressure-token|mutated/);
    const disconnected = target();
    send(disconnected.channel, event(1, 'tool.started', {}));
    send(disconnected.channel, event(2, 'notice', { message: 'pending' }));
    disconnected.response.destroyed = true;
    disconnected.response.emit('close');
    expect(disconnected.response.listenerCount('drain')).toBe(0);
    expect(send(disconnected.channel, event(3, 'notice', {}))).toBe(false);
  });
});
