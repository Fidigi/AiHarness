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
