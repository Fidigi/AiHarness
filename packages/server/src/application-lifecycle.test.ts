import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { RuntimeServices } from './runtime/services.js';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { createApp, stop } from './index.js';

function runtime(close = vi.fn(async () => undefined)): RuntimeServices {
  return { close } as unknown as RuntimeServices;
}

afterEach(async () => {
  vi.useRealTimers();
  await stop();
  vi.restoreAllMocks();
});

describe('Server application lifecycle', () => {
  it('reports configuration rather than claiming a listening server during app construction', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createApp({
      port: 43123,
      host: '127.0.0.1',
      runtimeServicesFactory: async () => runtime(),
      enableMockProvider: true,
    });
    const messages = log.mock.calls.map(args => args.join(' '));
    expect(messages).toContain('[Server] AiHarness application configured for http://127.0.0.1:43123');
    expect(messages.some(message => message.includes('server running'))).toBe(false);
  });

  it('retires the previous Express generation before the replacement serves', async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const first = createApp({
      runtimeServicesFactory: async () => runtime(firstClose),
      enableMockProvider: true,
    });
    createApp({
      runtimeServicesFactory: async () => runtime(secondClose),
      enableMockProvider: true,
    });

    await request(first).get('/api/health').expect(503, {
      error: 'Application runtime is no longer active.',
    });
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
  });

  it('prevents an in-flight handler from publishing after its generation is replaced', async () => {
    let resolveOld!: (services: RuntimeServices) => void;
    const oldRuntime = new Promise<RuntimeServices>(resolve => { resolveOld = resolve; });
    const first = createApp({
      runtimeServicesFactory: async () => oldRuntime,
      enableMockProvider: true,
    });
    const inFlight = request(first).get('/api/models');
    const responsePromise = inFlight.then(response => response);
    await new Promise(resolve => setImmediate(resolve));

    createApp({
      runtimeServicesFactory: async () => runtime(),
      enableMockProvider: true,
    });
    resolveOld(runtime());

    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Application runtime is no longer active.' });
  });

  it('closes a runtime that resolves after replacement shutdown timed out', async () => {
    vi.useFakeTimers();
    let resolveOld!: (services: RuntimeServices) => void;
    const oldRuntime = new Promise<RuntimeServices>(resolve => { resolveOld = resolve; });
    const lateClose = vi.fn(async () => undefined);
    createApp({
      runtimeServicesFactory: async () => oldRuntime,
      enableMockProvider: true,
    });
    createApp({
      runtimeServicesFactory: async () => runtime(),
      enableMockProvider: true,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    resolveOld(runtime(lateClose));
    for (let index = 0; index < 10 && lateClose.mock.calls.length === 0; index++) {
      await Promise.resolve();
    }

    expect(lateClose).toHaveBeenCalledOnce();
  });
});
