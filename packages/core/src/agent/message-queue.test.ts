import { describe, expect, it } from 'vitest';
import { AgentMessageQueue, parseAgentQueueMode } from './message-queue.js';

describe('AgentMessageQueue', () => {
  it('delivers one item or the complete kind while preserving insertion order', () => {
    const queue = new AgentMessageQueue<string>({
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
    });
    queue.enqueue('steer', 'steer one');
    queue.enqueue('follow-up', 'follow one');
    queue.enqueue('steer', 'steer two');
    queue.enqueue('follow-up', 'follow two');

    expect(queue.takeNext()).toEqual({ kind: 'steer', items: ['steer one'] });
    expect(queue.snapshot()).toEqual({
      steering: ['steer two'],
      followUp: ['follow one', 'follow two'],
    });
    expect(queue.takeNext()).toEqual({ kind: 'steer', items: ['steer two'] });
    expect(queue.takeNext()).toEqual({ kind: 'follow-up', items: ['follow one', 'follow two'] });
    expect(queue.takeNext()).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('can change modes and returns cleared input in cross-queue insertion order', () => {
    const queue = new AgentMessageQueue<string>();
    expect(queue.setMode('steer', 'all')).toBe('all');
    queue.enqueue('follow-up', 'later one');
    queue.enqueue('steer', 'guide one');
    queue.enqueue('follow-up', 'later two');

    expect(queue.clear()).toEqual({
      steering: ['guide one'],
      followUp: ['later one', 'later two'],
      ordered: ['later one', 'guide one', 'later two'],
    });
    expect(queue.snapshot()).toEqual({ steering: [], followUp: [] });
  });

  it('validates modes and bounds the combined queue', () => {
    const queue = new AgentMessageQueue<string>({ maxItems: 2 });
    queue.enqueue('steer', 'one');
    queue.enqueue('follow-up', 'two');

    expect(() => queue.enqueue('steer', 'three')).toThrow('queue is full');
    expect(() => queue.setMode('steer', 'invalid')).toThrow('Invalid queue mode');
    expect(() => parseAgentQueueMode(undefined)).toThrow('Invalid queue mode');
    expect(() => new AgentMessageQueue({ maxItems: 0 })).toThrow('maxItems');
  });
});
