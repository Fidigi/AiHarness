import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionAPI } from '@ai-harness/core';
import { ExtensionLoader } from '../extensions/extension-loader.js';
import { runRpcMode } from './rpc-server';

describe('RPC server', () => {
  it('rejects retired and hybrid envelopes without dispatch, then accepts canonical reads', async () => {
    const records: Record<string, unknown>[] = [];
    const retired = [
      { id: 1, method: 'session.create', params: { title: 'must-not-create' } },
      { id: 'private-id', method: 'chat.send', params: { content: 'private-content' } },
      { type: 'prompt', method: 'chat.send', message: 'must-not-run' },
      { type: 'new_session', params: {} },
    ];
    await runRpcMode({
      noSession: true, offline: true, noExtensions: true,
      input: Readable.from([...retired.map(value => JSON.stringify(value) + '\n'),
        '{"type":"get_messages","id":"messages"}\n']),
      output: record => { records.push(record); },
    });
    expect(records.slice(0, 4)).toEqual(retired.map(() => ({
      error: { code: 'INVALID_REQUEST', message: 'Legacy method/params RPC is not supported. Use type commands.' },
    })));
    expect(records.slice(4)).toEqual([{
      type: 'response', command: 'get_messages', id: 'messages', success: true, data: { messages: [] },
    }]);
  });

  it('serializes custom protocol sinks under backpressure', async () => {
    const records: Array<Record<string, unknown>> = [];
    let releaseFirst = (): void => undefined;
    const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });
    let first = true;
    let deliveryStarted = false;
    let deliveriesInFlight = 0;
    let maximumDeliveriesInFlight = 0;
    const running = runRpcMode({
      noSession: true,
      input: Readable.from([
        '{"type":"get_state","id":"state-1"}\n',
        '{"type":"get_state","id":"state-2"}\n',
      ]),
      output: async record => {
        deliveriesInFlight++;
        maximumDeliveriesInFlight = Math.max(maximumDeliveriesInFlight, deliveriesInFlight);
        deliveryStarted = true;
        try {
          if (first) {
            first = false;
            await firstWrite;
          }
          records.push(record);
        } finally {
          deliveriesInFlight--;
        }
      },
    });

    await vi.waitFor(() => expect(deliveryStarted).toBe(true));
    expect(records).toEqual([]);
    expect(maximumDeliveriesInFlight).toBe(1);
    releaseFirst();
    await running;

    expect(maximumDeliveriesInFlight).toBe(1);
    expect(records).toHaveLength(2);
    expect(records.map(record => record.id).sort()).toEqual(['state-1', 'state-2']);
  });

  it('treats asynchronous protocol delivery failure as terminal', async () => {
    await expect(runRpcMode({
      noSession: true,
      input: Readable.from(['{"type":"get_state","id":"state"}\n']),
      output: async () => { throw new Error('closed protocol output'); },
    })).rejects.toThrow('closed protocol output');
  });

  it('preserves an unrelated premature input close as a terminal failure', async () => {
    const failure = Object.assign(new Error('unexpected input close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    const input = new Readable({ read() { this.destroy(failure); } });
    await expect(runRpcMode({ noSession: true, input, output: () => undefined })).rejects.toBe(failure);
  });

  it.each(['eof', 'startup-failure', 'output-failure'] as const)('reuses and shuts down a prepared generation on %s', async ending => {
    const registry = new ExtensionRegistry();
    let owner!: ExtensionAPI;
    const cleanup = vi.fn();
    const shutdownValues: unknown[] = [];
    const factory = vi.fn((api: ExtensionAPI) => {
      owner = api;
      api.registerOption('review-style', { type: 'string', description: 'Style', default: 'brief' });
      api.on('system:shutdown', () => { shutdownValues.push(api.getOption('review-style')); });
      return cleanup;
    });
    await registry.load('prepared-review', factory);
    registry.setOptionValues({ 'review-style': 'full' });
    const loader = new ExtensionLoader(registry);
    const load = vi.spyOn(loader, 'loadAll');
    const records: Record<string, unknown>[] = [];
    const running = runRpcMode({
      noSession: true,
      extensionRegistry: registry,
      extensionLoader: loader,
      ...(ending === 'startup-failure' ? { provider: 'missing', model: 'missing-model' } : {}),
      input: Readable.from(['{"id":"prepared","type":"get_state"}\n']),
      output: async record => {
        if (ending === 'output-failure') throw new Error('closed prepared sink');
        records.push(record);
      },
    });
    if (ending === 'eof') {
      await running;
      expect(records).toEqual([expect.objectContaining({ id: 'prepared', command: 'get_state', success: true })]);
    } else {
      await expect(running).rejects.toThrow(ending === 'startup-failure' ? 'Provider unavailable' : 'closed prepared sink');
    }
    expect(load).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(shutdownValues).toEqual(['full']);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.getOptions()).toEqual([]);
    expect(owner.getOption('review-style')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

});
