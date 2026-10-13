/** A short layout-settling lease, not authority to override later scrolling.
 * Virtual measurement/viewport changes may adjust offsets without user intent.
 * Input, unrelated offsets, detachment and disposal permanently retire it. */
export function restoreWhileOwned(
  container: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'isConnected' | 'addEventListener' | 'removeEventListener'>,
  restore: () => unknown,
  frames = 10,
  delays: readonly number[] = [120, 300, 600],
): () => void {
  let live = true;
  let top = container.scrollTop;
  let height = container.scrollHeight;
  let viewport = container.clientHeight;
  let frame: number | undefined;
  const timers = new Set<number>();
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const dispose = (): void => {
    live = false;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    timers.forEach(timer => window.clearTimeout(timer));
    timers.clear();
    inputs.forEach(type => container.removeEventListener(type, dispose, true));
  };
  const apply = (): void => {
    if (!live) return;
    const layoutChanged = container.scrollHeight !== height || container.clientHeight !== viewport;
    if (!container.isConnected || container.scrollTop !== top && !layoutChanged) { dispose(); return; }
    restore();
    top = container.scrollTop;
    height = container.scrollHeight;
    viewport = container.clientHeight;
  };
  const finish = (): void => { if (frames <= 0 && !timers.size) dispose(); };
  const tick = (): void => {
    frame = undefined;
    apply();
    if (live && --frames > 0) frame = window.requestAnimationFrame(tick);
    finish();
  };
  inputs.forEach(type => container.addEventListener(type, dispose, { capture: true, passive: true }));
  frame = window.requestAnimationFrame(tick);
  delays.forEach(delay => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      apply();
      finish();
    }, delay);
    timers.add(timer);
  });
  return dispose;
}
