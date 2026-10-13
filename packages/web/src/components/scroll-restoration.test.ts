import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreWhileOwned } from './scroll-restoration';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
    cancelAnimationFrame: clearTimeout,
    setTimeout, clearTimeout,
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

class ScrollRoot extends EventTarget {
  scrollTop = 10;
  scrollHeight = 1_000;
  clientHeight = 400;
  isConnected = true;
}

describe('layout restoration ownership', () => {
  it('settles through bounded frames/deadlines while retaining its own offset changes', () => {
    const root = new ScrollRoot();
    const restore = vi.fn(() => { root.scrollTop++; });
    restoreWhileOwned(root, restore);
    vi.runAllTimers();
    expect(restore).toHaveBeenCalledTimes(13);
    expect(root.scrollTop).toBe(23);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('follows virtual measurement and viewport adjustments instead of mistaking them for user scrolling', () => {
    const root = new ScrollRoot();
    const restore = vi.fn(() => { root.scrollTop = 10; });
    const remove = vi.spyOn(root, 'removeEventListener');
    restoreWhileOwned(root, restore);
    root.scrollHeight += 449;
    root.scrollTop += 449;
    vi.advanceTimersByTime(16);
    expect(root.scrollTop).toBe(10);
    root.clientHeight -= 100;
    root.scrollTop += 100;
    vi.runAllTimers();
    expect(restore).toHaveBeenCalledTimes(13);
    expect(root.scrollTop).toBe(10);
    expect(remove).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('retires on %s even when layout changes concurrently', type => {
    const root = new ScrollRoot();
    const restore = vi.fn();
    restoreWhileOwned(root, restore);
    vi.advanceTimersByTime(16);
    root.dispatchEvent(new Event(type));
    root.scrollHeight += 100;
    root.scrollTop += 100;
    vi.runAllTimers();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never overrides a later scroll, including returning to the formerly owned offset', () => {
    const root = new ScrollRoot();
    const restore = vi.fn();
    restoreWhileOwned(root, restore);
    vi.advanceTimersByTime(32); expect(restore).toHaveBeenCalledTimes(2);
    root.scrollTop = 64;
    vi.advanceTimersByTime(120);
    root.scrollTop = 10;
    vi.runAllTimers();
    expect(restore).toHaveBeenCalledTimes(2);
  });
  it('retires detached history roots permanently', () => {
    const root = new ScrollRoot();
    const restore = vi.fn();
    restoreWhileOwned(root, restore);
    root.isConnected = false; vi.advanceTimersByTime(120);
    root.isConnected = true; vi.runAllTimers();
    expect(restore).not.toHaveBeenCalled();
  });
  it('disposes all pending frames/timers before a replacement view can reuse the container', () => {
    const root = new ScrollRoot();
    const restore = vi.fn();
    const dispose = restoreWhileOwned(root, restore);
    vi.advanceTimersByTime(16);
    dispose(); dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers(); expect(restore).toHaveBeenCalledTimes(1);
  });
});
