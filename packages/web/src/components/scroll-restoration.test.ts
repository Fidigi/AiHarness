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
  it('does not reclaim a later bottom scroll when the viewport grows at the same time', () => {
    const root = new ScrollRoot();
    root.scrollTop = 0;
    root.scrollHeight = 2_259;
    root.clientHeight = 634;
    const restore = vi.fn(() => { root.scrollTop = 0; });
    restoreWhileOwned(root, restore);
    // Reaching the bottom hides the jump-to-latest control and grows the viewport.
    root.scrollTop = root.scrollHeight - root.clientHeight;
    root.clientHeight += 49;
    root.scrollTop = root.scrollHeight - root.clientHeight;
    vi.runAllTimers();
    expect(restore).not.toHaveBeenCalled();
    expect(root.scrollTop).toBe(1_576);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retires an upward scroll during a viewport shrink', () => {
    const root = new ScrollRoot();
    const restore = vi.fn();
    restoreWhileOwned(root, restore);
    root.clientHeight -= 100;
    root.scrollTop = 0;
    vi.runAllTimers();
    expect(restore).not.toHaveBeenCalled();
    expect(root.scrollTop).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps ownership through viewport clamping and subsequent growth of the scroll range', () => {
    const root = new ScrollRoot();
    root.scrollTop = 800;
    root.clientHeight = 100;
    const restore = vi.fn(() => { root.scrollTop = Math.min(800, root.scrollHeight - root.clientHeight); });
    restoreWhileOwned(root, restore);
    root.clientHeight = 400;
    root.scrollTop = 600;
    vi.advanceTimersByTime(16);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(root.scrollTop).toBe(600);
    root.clientHeight = 100;
    vi.runAllTimers();
    expect(restore).toHaveBeenCalledTimes(13);
    expect(root.scrollTop).toBe(800);
    expect(vi.getTimerCount()).toBe(0);
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
