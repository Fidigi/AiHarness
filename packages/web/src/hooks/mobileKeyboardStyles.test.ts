import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMobileKeyboardStyles } from './mobileKeyboardStyles';

// Vitest disables CSS processing; browser/build tests verify the real URL asset.
vi.mock('./mobile-keyboard.css?url&no-inline', () => ({ default: '/mobile-keyboard.css' }));

function documentWithLink() {
  const link = { rel: '', href: '', onload: null as null | (() => void), onerror: null as null | (() => void), remove: vi.fn() };
  const append = vi.fn();
  const document = { createElement: vi.fn(() => link), head: { append } } as unknown as Document;
  return { document, link, append };
}

afterEach(() => vi.useRealTimers());
describe('mount-owned mobile stylesheet', () => {
  it('waits for load, retains it on success and removes it on unmount without stale handlers', async () => {
    const b = documentWithLink(); const controller = new AbortController();
    const ready = vi.fn(); const pending = loadMobileKeyboardStyles(b.document, controller.signal).then(ready);
    expect(b.link.rel).toBe('stylesheet'); expect(b.link.href).toContain('mobile-keyboard.css');
    expect(b.append).toHaveBeenCalledWith(b.link); expect(ready).not.toHaveBeenCalled();
    b.link.onload!(); await pending; expect(ready).toHaveBeenCalledTimes(1);
    expect(b.link.remove).not.toHaveBeenCalled();
    controller.abort(); expect(b.link.remove).toHaveBeenCalledTimes(1);
    expect(b.link.onload).toBeNull(); expect(b.link.onerror).toBeNull();
  });
  it.each(['error', 'timeout', 'abort'] as const)('removes failed/pending CSS on %s', async reason => {
    vi.useFakeTimers(); const b = documentWithLink(); const controller = new AbortController();
    const pending = loadMobileKeyboardStyles(b.document, controller.signal);
    const failure = expect(pending).rejects.toThrow();
    if (reason === 'error') b.link.onerror!();
    if (reason === 'timeout') vi.advanceTimersByTime(8_000);
    if (reason === 'abort') controller.abort();
    await failure; expect(b.link.remove).toHaveBeenCalledTimes(1);
    expect(b.link.onload).toBeNull(); expect(b.link.onerror).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    controller.abort(); expect(b.link.remove).toHaveBeenCalledTimes(1);
  });
  it('does not allocate a link for an already aborted request', async () => {
    const b = documentWithLink(); const controller = new AbortController(); controller.abort();
    await expect(loadMobileKeyboardStyles(b.document, controller.signal)).rejects.toThrow();
    expect(b.append).not.toHaveBeenCalled(); expect(b.document.createElement).not.toHaveBeenCalled();
  });
});
