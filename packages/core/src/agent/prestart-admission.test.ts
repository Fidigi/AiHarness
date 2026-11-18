import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { awaitAgentAdmission } from './prestart-admission.js';
import { AgentAbortError } from '../index.js';
import { AgentAbortError as LoopAbortError } from './tool-loop.js';

describe('unpublished agent admission awaits', () => {
  it('never invokes work for an already aborted lifetime', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    const result = awaitAgentAdmission(() => { calls++; return 'late'; }, controller.signal);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await expect(result).rejects.toBeInstanceOf(AgentAbortError);
    expect(AgentAbortError).toBe(LoopAbortError);
    expect(calls).toBe(0); expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
  it('retains native synchronous and asynchronous results and removes listeners', async () => {
    const controller = new AbortController();
    expect(await awaitAgentAdmission(() => 'sync', controller.signal)).toBe('sync');
    expect(await awaitAgentAdmission(async () => 'async', controller.signal)).toBe('async');
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
  it('retains failures without cancellation and removes listeners', async () => {
    const controller = new AbortController(), failure = new Error('controlled admission failure');
    await expect(awaitAgentAdmission(() => { throw failure; }, controller.signal)).rejects.toBe(failure);
    await expect(awaitAgentAdmission(() => Promise.reject(failure), controller.signal)).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
  it('lets synchronous abort win over a callback failure without invoking any timeout', async () => {
    const controller = new AbortController();
    await expect(awaitAgentAdmission(() => { controller.abort(); throw new Error('late failure'); }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
  it('withdraws a held callback while still observing its late rejection', async () => {
    const controller = new AbortController(); let reject!: (reason: Error) => void;
    const held = new Promise<string>((_resolve, refuse) => { reject = refuse; });
    const refused = expect(awaitAgentAdmission(() => held, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1); controller.abort(); await refused;
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]); reject(new Error('late callback rejection'));
    await new Promise<void>(resolve => setImmediate(resolve));
  });
});
