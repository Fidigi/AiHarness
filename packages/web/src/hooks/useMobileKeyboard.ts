import { useEffect, useRef, useState } from 'react';
import { loadMobileKeyboardStyles } from './mobileKeyboardStyles';

export interface MobileKeyboardState {
  keyboardOpen: boolean;
  /** CSS pixels, not device pixels; present only for a confidently detected keyboard. */
  viewportHeight?: number;
  viewportOffsetTop?: number;
}

const CLOSED: MobileKeyboardState = { keyboardOpen: false };

/** Preserve field boundaries even when valid workspace paths/session IDs contain colons. */
export function mobileKeyboardViewKey(
  workspaceId: string | undefined,
  cwd: string | undefined,
  sessionId: string | undefined,
  routeKey: string,
): string {
  return JSON.stringify([workspaceId, cwd, sessionId, routeKey]);
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Selects/buttons, readonly fields and inputmode=none do not imply an OS keyboard. */
export function isKeyboardEditable(element: Element | null): boolean {
  if (!element || element.matches(':disabled') || element.getAttribute('inputmode')?.toLowerCase() === 'none') return false;
  if (element.tagName === 'TEXTAREA') return !(element as HTMLTextAreaElement).readOnly;
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    return !input.readOnly && TEXT_INPUT_TYPES.has(input.type);
  }
  return (element as HTMLElement).isContentEditable === true;
}

function activeEditable(document: Document): boolean {
  let element = document.activeElement;
  // Shadow-root focus is not represented by document.activeElement alone.
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return isKeyboardEditable(element);
}

/**
 * Owns a fixed set of listeners and at most one animation frame, with no polling.
 * Exported separately so lifecycle and ambiguous viewport sequences can be tested.
 * visualViewport cannot prove an OS keyboard: overlay keyboards and a first mount
 * into an already resized layout viewport can remain undetected by design.
 */
export function observeMobileKeyboard(
  window: Window,
  document: Document,
  publish: (state: MobileKeyboardState) => void,
  loadStyles?: (signal: AbortSignal) => Promise<void>,
  requireFreshIntent = false,
): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const coarse = window.matchMedia('(pointer: coarse)');
  let baseline: { width: number; height: number; orientation: number | undefined } | undefined;
  let state = CLOSED;
  let frame: number | undefined;
  let disposed = false;
  let rotationPending = false;
  let awaitingIntent = requireFreshIntent;
  let published = CLOSED;
  let stylesReady = !loadStyles;
  let stylesFailed = false;
  let stylesRequest: AbortController | undefined;
  const publishReady = (next: MobileKeyboardState) => {
    if (published.keyboardOpen === next.keyboardOpen && published.viewportHeight === next.viewportHeight
      && published.viewportOffsetTop === next.viewportOffsetTop) return;
    published = next;
    publish(next);
  };
  const emit = (next: MobileKeyboardState) => {
    // Detection/hysteresis continues while loading; publication is gated on CSS.
    state = next;
    if (!next.keyboardOpen) {
      if (!stylesReady) { stylesRequest?.abort(); stylesRequest = undefined; }
      stylesFailed = false;
      publishReady(CLOSED);
      return;
    }
    if (stylesReady) { publishReady(next); return; }
    if (stylesRequest || stylesFailed || !loadStyles) return;
    const request = new AbortController();
    stylesRequest = request;
    // Also handle a synchronous loader failure without escaping the observer.
    void Promise.resolve().then(() => loadStyles(request.signal)).then(() => {
      if (disposed || request.signal.aborted || stylesRequest !== request) return;
      stylesReady = true;
      // Re-measure instead of replaying captured geometry/focus. This retains
      // the latest baseline but rejects silent blur/rotation/hidden samples.
      schedule();
    }, () => {
      if (disposed || request.signal.aborted || stylesRequest !== request) return;
      request.abort();
      stylesRequest = undefined;
      stylesFailed = true; // No event-storm retries; a closed sample rearms it.
      publishReady(CLOSED);
    });
  };
  const measure = () => {
    frame = undefined;
    if (disposed) return;
    const { height, width, scale, offsetTop } = viewport;
    const layoutWidth = window.innerWidth;
    const layoutHeight = window.innerHeight;
    const orientation = window.screen.orientation?.angle;
    const focused = activeEditable(document);
    const editable = !awaitingIntent && focused;
    if (rotationPending && focused) { emit(CLOSED); return; }
    rotationPending = false;
    const valid = [height, width, scale, layoutWidth, layoutHeight, offsetTop].every(Number.isFinite)
      && height > 0 && width > 0 && layoutWidth > 0 && layoutHeight > 0 && offsetTop >= 0;
    // Normalize pinch zoom before measuring loss: height alone would classify
    // every zoom as a keyboard. Scroll/toolbar offsets are not height loss.
    const normalizedHeight = height * scale;
    const unzoomed = Math.abs(scale - 1) <= 0.02;
    if (!valid || scale <= 0 || !Number.isFinite(normalizedHeight)
      || document.visibilityState === 'hidden' || !coarse.matches || layoutWidth > 959
      || Math.abs(width * scale - layoutWidth) > layoutWidth * 0.05) {
      emit(CLOSED);
      return;
    }
    const changedGeometry = baseline && (orientation !== baseline.orientation
      || Math.abs(layoutWidth - baseline.width) > Math.max(48, baseline.width * 0.1));
    if (changedGeometry) {
      baseline = undefined;
      emit(CLOSED);
      // A rotation while editing may already have a keyboard-sized layout. Do
      // not mistake the old portrait height for landscape keyboard occlusion.
      if (focused) { rotationPending = true; return; }
    }
    if (!baseline) {
      // A first zoomed sample cannot establish a trustworthy keyboard-free
      // baseline. Wait for unzoomed geometry, including after rotation.
      if (!unzoomed) { emit(CLOSED); return; }
      // If only the visual viewport resizes, layout height remains useful. If
      // both are already small on mount, remain conservative by design.
      baseline = { width: layoutWidth, height: Math.max(layoutHeight, normalizedHeight), orientation };
    }
    // A larger unzoomed viewport is safe to learn even while focused (e.g.
    // Safari hiding its toolbar). Never learn a baseline from zoomed geometry.
    if (unzoomed) baseline.height = Math.max(baseline.height, layoutHeight, normalizedHeight);
    const openingLoss = Math.max(160, baseline.height * 0.2);
    const closingLoss = Math.max(120, baseline.height * 0.15);
    const loss = baseline.height - normalizedHeight;
    const open = editable && loss > (state.keyboardOpen ? closingLoss : openingLoss);
    emit(open ? { keyboardOpen: true, viewportHeight: height, viewportOffsetTop: offsetTop } : CLOSED);
    // Retain the high-water baseline through blur before the closing resize;
    // only a geometry/orientation change can replace it with a smaller baseline.
  };
  const schedule = () => {
    if (!disposed && frame === undefined) frame = window.requestAnimationFrame(measure);
  };
  const rotate = () => {
    baseline = undefined;
    emit(CLOSED);
    // Wait for an unfocused sample rather than seed from the rotation's first
    // (often stale) focused resize. Geometry below will be seeded on blur.
    rotationPending = activeEditable(document);
    schedule();
  };
  const intent = () => {
    if (activeEditable(document)) awaitingIntent = false;
    schedule();
  };
  const listeners: Array<[EventTarget, string, EventListener]> = [
    [viewport, 'resize', schedule], [viewport, 'scroll', schedule],
    [window, 'resize', schedule], [window, 'orientationchange', rotate],
    [document, 'focusin', intent], [document, 'focusout', schedule],
    [document, 'visibilitychange', schedule], [coarse, 'change', schedule],
    // IME candidate bars sometimes change geometry without a viewport event.
    [document, 'input', intent], [document, 'compositionend', intent],
    [window, 'pageshow', schedule],
  ];
  for (const [target, event, listener] of listeners) target.addEventListener(event, listener);
  measure();
  return () => {
    disposed = true;
    stylesRequest?.abort();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    for (const [target, event, listener] of listeners) target.removeEventListener(event, listener);
  };
}

/** View-local state; the scoped stylesheet is owned/removed by this mount. */
export function useMobileKeyboard(viewKey = ''): MobileKeyboardState {
  const [viewState, setViewState] = useState({ viewKey, state: CLOSED });
  const previousView = useRef(viewKey);
  useEffect(() => {
    const changedView = previousView.current !== viewKey;
    previousView.current = viewKey;
    setViewState({ viewKey, state: CLOSED });
    return observeMobileKeyboard(window, document,
      state => setViewState({ viewKey, state }),
      signal => loadMobileKeyboardStyles(document, signal), changedView);
  }, [viewKey]);
  // A reused ChatView must never display the previous session's async result.
  return viewState.viewKey === viewKey ? viewState.state : CLOSED;
}
