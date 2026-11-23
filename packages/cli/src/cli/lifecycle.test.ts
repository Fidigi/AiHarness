import { describe, expect, it, vi } from 'vitest';
import { cleanupCliEarlyExit } from './lifecycle.js';

describe('cleanupCliEarlyExit', () => {
  it('closes input, theme filtering, extensions, JSON output, and provider transports', async () => {
    const input = { close: vi.fn(() => { throw new Error('input close failed'); }) };
    const filteredInput = { dispose: vi.fn(() => { throw new Error('filter dispose failed'); }) };
    const themeProbe = { close: vi.fn(() => { throw new Error('theme close failed'); }) };
    const extensions = { shutdown: vi.fn(async () => { throw new Error('extension close failed'); }) };
    const jsonOutput = {
      flush: vi.fn(async () => { throw new Error('JSON flush failed'); }),
      restore: vi.fn(),
    };
    const closeNetwork = vi.fn(async () => { throw new Error('network close failed'); });

    await expect(cleanupCliEarlyExit({
      input, filteredInput, themeProbe, extensions, jsonOutput, closeNetwork,
    })).resolves.toBeUndefined();

    expect(input.close).toHaveBeenCalledOnce();
    expect(filteredInput.dispose).toHaveBeenCalledOnce();
    expect(themeProbe.close).toHaveBeenCalledOnce();
    expect(extensions.shutdown).toHaveBeenCalledOnce();
    expect(closeNetwork).toHaveBeenCalledOnce();
    expect(jsonOutput.flush).toHaveBeenCalledOnce();
    expect(jsonOutput.restore).toHaveBeenCalledOnce();
  });

  it('joins active owned cleanup beyond the legacy deadline without restoring output early', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const jsonOutput = { flush: vi.fn(() => held), restore: vi.fn() };
    let returned = false;
    const cleanup = cleanupCliEarlyExit({ jsonOutput, timeoutMs: 25, requireSettlement: true }).finally(() => { returned = true; });
    const rejected = expect(cleanup).rejects.toMatchObject({ name: 'AggregateError', errors: [
      expect.objectContaining({ message: 'CLI cleanup deadline exceeded.' }),
    ] });
    try {
      await vi.advanceTimersByTimeAsync(26); expect(returned).toBe(false); expect(jsonOutput.restore).not.toHaveBeenCalled();
      release(); await rejected; expect(jsonOutput.restore).toHaveBeenCalledOnce();
    } finally { release(); vi.useRealTimers(); }
  });

  it('surfaces active cleanup failure only after every owned branch and output restoration', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const restore = vi.fn(); let returned = false;
    const cleanup = cleanupCliEarlyExit({ input: { close: () => { throw new Error('input failed'); } },
      extensions: { shutdown: async () => { throw new Error('shutdown failed'); } },
      closeNetwork: () => held, jsonOutput: { flush: () => undefined, restore }, requireSettlement: true });
    const rejected = expect(cleanup.finally(() => { returned = true; })).rejects.toMatchObject({ name: 'AggregateError', errors: [
      expect.objectContaining({ message: 'input failed' }), expect.objectContaining({ message: 'shutdown failed' }),
    ] });
    await Promise.resolve(); expect(returned).toBe(false); release(); await rejected; expect(restore).toHaveBeenCalledOnce();
  });

  it('restores JSON stdout after the bounded cleanup deadline', async () => {
    vi.useFakeTimers();
    const jsonOutput = { flush: vi.fn(() => new Promise<void>(() => undefined)), restore: vi.fn() };
    const cleanup = cleanupCliEarlyExit({
      extensions: { shutdown: () => new Promise<void>(() => undefined) },
      closeNetwork: () => new Promise<void>(() => undefined),
      jsonOutput,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await cleanup;

    expect(jsonOutput.restore).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
