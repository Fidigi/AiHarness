import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, EventMap } from './event-emitter';

describe('EventEmitter', () => {
  let emitter: EventEmitter<EventMap>;

  beforeEach(() => {
    emitter = new EventEmitter<EventMap>();
  });

  afterEach(() => {
    emitter.clear();
    vi.restoreAllMocks();
  });

  it('registers, emits and removes a typed listener', async () => {
    const handler = vi.fn();
    emitter.on('session:create', handler);

    expect(emitter.hasListeners('session:create')).toBe(true);
    await emitter.emit('session:create', { sessionId: 'session-1', title: 'Test' });
    expect(handler).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Test' });

    emitter.off('session:create', handler);
    expect(emitter.hasListeners('session:create')).toBe(false);
  });

  it('supports multiple listeners', async () => {
    const first = vi.fn();
    const second = vi.fn();
    emitter.on('message:add', first);
    emitter.on('message:add', second);

    await emitter.emit('message:add', {
      sessionId: 'session-1',
      role: 'user',
      contentLength: 12,
    });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(emitter.listenerCount('message:add')).toBe(2);
  });

  it('runs once listeners only once', async () => {
    const handler = vi.fn();
    emitter.once('session:delete', handler);

    await emitter.emit('session:delete', { sessionId: 'session-1' });
    await emitter.emit('session:delete', { sessionId: 'session-2' });

    expect(handler).toHaveBeenCalledOnce();
    expect(emitter.hasListeners('session:delete')).toBe(false);
  });

  it('waits for asynchronous listeners', async () => {
    const calls: string[] = [];
    emitter.on('compaction:end', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      calls.push('done');
    });

    await emitter.emit('compaction:end', { sessionId: 'session-1', summaryLength: 42 });
    expect(calls).toEqual(['done']);
  });

  it('isolates synchronous listener errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const healthyHandler = vi.fn();
    emitter.on('provider:call:error', () => {
      throw new Error('broken listener');
    });
    emitter.on('provider:call:error', healthyHandler);

    await expect(emitter.emit('provider:call:error', {
      provider: 'openai',
      error: 'rate limit',
    })).resolves.toBeUndefined();

    expect(healthyHandler).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('isolates asynchronous listener errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    emitter.on('system:ready', async () => {
      throw new Error('async failure');
    });

    await expect(emitter.emit('system:ready')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[EventEmitter] Error in listener for "system:ready":',
      expect.any(Error),
    );
  });

  it('supports events without payloads', async () => {
    const handler = vi.fn();
    emitter.on('system:shutdown', handler);

    await emitter.emit('system:shutdown');
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('removes listeners for one event only', () => {
    emitter.on('system:ready', vi.fn());
    emitter.on('system:shutdown', vi.fn());

    emitter.removeAllListeners('system:ready');

    expect(emitter.hasListeners('system:ready')).toBe(false);
    expect(emitter.hasListeners('system:shutdown')).toBe(true);
  });

  it('clears every listener', () => {
    emitter.on('system:ready', vi.fn());
    emitter.once('system:shutdown', vi.fn());

    emitter.clear();

    expect(emitter.listenerCount('system:ready')).toBe(0);
    expect(emitter.listenerCount('system:shutdown')).toBe(0);
  });
});
