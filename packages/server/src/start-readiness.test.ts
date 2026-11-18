import { afterEach, expect, it, vi } from 'vitest';
import { start, stop } from './index.js';
import type { RuntimeServices } from './runtime/services.js';

afterEach(async () => { await stop(); vi.restoreAllMocks(); });

it('start does not publish a listener before the injected composition resolves', async () => {
  let ready!: (value: RuntimeServices) => void;
  const composition = new Promise<RuntimeServices>(resolve => { ready = resolve; });
  const published = vi.fn();
  const starting = start({port: 0, runtimeServicesFactory: async () => composition}).then(value => {published(); return value;});
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(published).not.toHaveBeenCalled();
  ready({close: async () => undefined} as RuntimeServices);
  const server = await starting;
  expect(server.port).toBeGreaterThan(0);
  expect(published).toHaveBeenCalledOnce();
});

it('start rejects the actual initialization error rather than advertising success', async () => {
  const failure = new Error('fixture composition rejected');
  await expect(start({port: 0, runtimeServicesFactory: async () => {throw failure;}})).rejects.toBe(failure);
});

it('stop during composition retires the pending start and closes late services', async () => {
  let ready!: (value: RuntimeServices) => void;
  const composition = new Promise<RuntimeServices>(resolve => { ready = resolve; });
  const closed = vi.fn(async () => undefined);
  const starting = start({port: 0, runtimeServicesFactory: async () => composition});
  const rejected = expect(starting).rejects.toThrow('Application runtime is no longer active.');
  const stopping = stop();
  ready({close: closed} as unknown as RuntimeServices);
  await rejected;
  await stopping;
  expect(closed).toHaveBeenCalledOnce();
});
