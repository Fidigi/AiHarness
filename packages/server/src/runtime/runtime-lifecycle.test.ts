import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCloser } from './runtime-lifecycle.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createRuntimeCloser', () => {
  it('is idempotent and attempts every runtime-owned cleanup branch', async () => {
    const dependencies = {
      terminal: { shutdown: vi.fn(() => { throw new Error('terminal failed'); }) },
      subagents: { shutdown: vi.fn(async () => { throw new Error('subagents failed'); }) },
      mcp: { shutdown: vi.fn(async () => undefined) },
      extensions: { shutdown: vi.fn(async () => undefined) },
      agents: {
        listRunning: vi.fn(() => [{ id: 'run-1' }, { id: 'run-2' }]),
        stop: vi.fn((id: string) => { if (id === 'run-2') throw new Error('already stopped'); }),
        wait: vi.fn(async () => undefined),
      },
    };
    const close = createRuntimeCloser(dependencies);

    const first = close();
    const second = close();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();

    expect(dependencies.terminal.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.subagents.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.mcp.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.extensions.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.agents.stop).toHaveBeenCalledTimes(2);
    expect(dependencies.agents.wait).toHaveBeenCalledTimes(1);
  });

  it('finishes at the deadline when a runtime dependency never settles', async () => {
    vi.useFakeTimers();
    const close = createRuntimeCloser({
      terminal: { shutdown: vi.fn() },
      subagents: { shutdown: () => new Promise<void>(() => undefined) },
      mcp: { shutdown: vi.fn() },
      extensions: { shutdown: vi.fn() },
      agents: { listRunning: () => [], stop: vi.fn(), wait: vi.fn() },
    }, 25);

    const closing = close();
    await vi.advanceTimersByTimeAsync(25);
    await expect(closing).resolves.toBeUndefined();
  });
});
