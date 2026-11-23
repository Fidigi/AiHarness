import { describe, expect, it, vi } from 'vitest';
import { isKeyboardEditable, mobileKeyboardViewKey, observeMobileKeyboard, type MobileKeyboardState } from './useMobileKeyboard';

function field(tagName = 'TEXTAREA', properties: Record<string, unknown> = {}): Element {
  return {
    tagName, type: 'text', readOnly: false, isContentEditable: false,
    matches: (selector: string) => selector === ':disabled' && properties.disabled === true,
    getAttribute: (name: string) => name === 'inputmode' ? properties.inputmode ?? null : null,
    ...properties,
  } as unknown as Element;
}

function browser() {
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, scale: 1, offsetTop: 0 });
  const document = Object.assign(new EventTarget(), { activeElement: null as Element | null, visibilityState: 'visible' });
  const coarse = Object.assign(new EventTarget(), { matches: true });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const window = Object.assign(new EventTarget(), {
    innerWidth: 390, innerHeight: 844, visualViewport: viewport,
    screen: { orientation: { angle: 0 } }, matchMedia: () => coarse,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback); return nextFrame;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
  });
  const publish = vi.fn<(state: MobileKeyboardState) => void>();
  let state: MobileKeyboardState = { keyboardOpen: false };
  publish.mockImplementation(next => { state = next; });
  const targets = [window, viewport, document, coarse];
  const adds = targets.map(target => vi.spyOn(target, 'addEventListener'));
  const removes = targets.map(target => vi.spyOn(target, 'removeEventListener'));
  const start = (loadStyles?: (signal: AbortSignal) => Promise<void>) =>
    observeMobileKeyboard(window as unknown as Window, document as unknown as Document, publish, loadStyles);
  const flush = () => {
    const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0));
  };
  const resize = (height: number, properties: Partial<typeof viewport> = {}) => {
    Object.assign(viewport, properties, { height }); viewport.dispatchEvent(new Event('resize')); flush();
  };
  const focus = (element: Element | null = field()) => {
    document.activeElement = element; document.dispatchEvent(new Event(element ? 'focusin' : 'focusout')); flush();
  };
  return { window, viewport, document, coarse, frames, publish, adds, removes, start, flush, resize, focus, state: () => state };
}

describe('editable keyboard focus', () => {
  it('includes text inputs, textarea and inherited contenteditable, including shadow focus', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number']) {
      expect(isKeyboardEditable(field('INPUT', { type }))).toBe(true);
    }
    expect(isKeyboardEditable(field())).toBe(true);
    expect(isKeyboardEditable(field('SPAN', { isContentEditable: true }))).toBe(true);
    const b = browser(); b.start();
    b.focus(field('CUSTOM-EDITOR', { shadowRoot: { activeElement: field() } })); b.resize(480);
    expect(b.state().keyboardOpen).toBe(true);
  });
  it('excludes non-text, disabled, readonly and explicit no-keyboard controls', () => {
    for (const type of ['checkbox', 'radio', 'file', 'button', 'submit', 'range', 'color', 'date', 'hidden']) {
      expect(isKeyboardEditable(field('INPUT', { type }))).toBe(false);
    }
    for (const properties of [{ disabled: true }, { readOnly: true }, { inputmode: 'none' }, { inputmode: 'NONE' }]) {
      expect(isKeyboardEditable(field('INPUT', properties))).toBe(false);
      expect(isKeyboardEditable(field('TEXTAREA', properties))).toBe(false);
    }
    expect(isKeyboardEditable(field('SELECT'))).toBe(false);
    expect(isKeyboardEditable(field('DIV'))).toBe(false);
    expect(isKeyboardEditable(null)).toBe(false);
  });
});

function delayedStyles() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const load = vi.fn((_signal: AbortSignal) => promise);
  return { load, resolve, reject };
}

async function settleStyles() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('lazy keyboard styles publication', () => {
  it('does not load on mount/desktop/toolbar, and publishes only latest geometry after readiness', async () => {
    const b = browser(); const css = delayedStyles(); const stop = b.start(css.load);
    b.focus(); b.resize(710); await settleStyles(); expect(css.load).not.toHaveBeenCalled();
    b.coarse.matches = false; b.resize(480); await settleStyles(); expect(css.load).not.toHaveBeenCalled();
    b.coarse.matches = true; b.resize(480); await settleStyles();
    expect(css.load).toHaveBeenCalledTimes(1); expect(b.state().keyboardOpen).toBe(false);
    b.resize(430, { offsetTop: 22 }); expect(b.publish).not.toHaveBeenCalled();
    css.resolve(); await settleStyles(); b.flush();
    expect(b.state()).toEqual({ keyboardOpen: true, viewportHeight: 430, viewportOffsetTop: 22 });
    b.focus(null); b.focus(); b.resize(420); expect(css.load).toHaveBeenCalledTimes(1);
    stop(); expect(css.load.mock.calls[0]![0].aborted).toBe(true);
  });
  it.each(['blur', 'unmount', 'hidden', 'rotation'] as const)('rejects late ready after %s', async reason => {
    const b = browser(); const css = delayedStyles(); const stop = b.start(css.load);
    b.focus(); b.resize(480); await settleStyles();
    if (reason === 'unmount') stop();
    // Intentionally no focus/visibility event: readiness must re-measure too.
    if (reason === 'blur') b.document.activeElement = null;
    if (reason === 'hidden') b.document.visibilityState = 'hidden';
    if (reason === 'rotation') b.window.screen.orientation.angle = 90;
    css.resolve(); await settleStyles(); b.flush();
    expect(b.state().keyboardOpen).toBe(false); expect(b.publish).not.toHaveBeenCalled();
    stop(); expect(b.frames.size).toBe(0);
  });
  it('aborts loading on blur and ignores an older attempt resolving after refocus', async () => {
    const b = browser(); const first = delayedStyles(); const second = delayedStyles();
    const loader = vi.fn().mockImplementationOnce(first.load).mockImplementationOnce(second.load);
    const stop = b.start(loader); b.focus(); b.resize(480); await settleStyles();
    b.focus(null); expect(first.load.mock.calls[0]![0].aborted).toBe(true);
    b.focus(); b.resize(450); await settleStyles();
    first.resolve(); await settleStyles(); b.flush(); expect(b.state().keyboardOpen).toBe(false);
    second.resolve(); await settleStyles(); b.flush(); expect(b.state().viewportHeight).toBe(450);
    stop();
  });
  it('keeps normal layout on rejection, bounds retries until close and handles synchronous failure', async () => {
    const b = browser(); const css = delayedStyles(); const stop = b.start(css.load);
    b.focus(); b.resize(480); await settleStyles(); css.reject(new Error('offline'));
    await settleStyles(); b.flush();
    for (let i = 0; i < 10; i++) b.resize(440);
    expect(b.state().keyboardOpen).toBe(false); expect(css.load).toHaveBeenCalledTimes(1);
    b.focus(null); b.focus(); await settleStyles(); expect(css.load).toHaveBeenCalledTimes(2);
    stop();
    const c = browser(); const fail = vi.fn(() => { throw new Error('unavailable'); });
    const cleanup = c.start(fail); c.focus(); c.resize(480); await settleStyles();
    expect(c.state().keyboardOpen).toBe(false); expect(fail).toHaveBeenCalledTimes(1); cleanup();
  });
});

describe('conservative mobile VisualViewport observer', () => {
  it('requires both editable focus and substantial height loss, not offsets or toolbar shifts', () => {
    const b = browser(); b.start(); b.resize(480);
    expect(b.state().keyboardOpen).toBe(false);
    b.resize(844); b.focus();
    b.resize(710, { offsetTop: 70 }); expect(b.state().keyboardOpen).toBe(false);
    b.viewport.dispatchEvent(new Event('scroll')); b.flush(); expect(b.state().keyboardOpen).toBe(false);
    b.resize(480, { offsetTop: 18 });
    expect(b.state()).toEqual({ keyboardOpen: true, viewportHeight: 480, viewportOffsetTop: 18 });
    b.focus(null); expect(b.state()).toEqual({ keyboardOpen: false });
  });
  it('does not interpret pinch zoom as a keyboard or learn its reduced height', () => {
    const b = browser(); b.start(); b.focus();
    b.resize(400, { scale: 2, width: 195 }); expect(b.state().keyboardOpen).toBe(false);
    b.focus(null); b.resize(400, { scale: 2 }); b.focus();
    b.resize(844, { scale: 1, width: 390 }); expect(b.state().keyboardOpen).toBe(false);
    b.resize(490); expect(b.state().keyboardOpen).toBe(true);
    b.resize(400, { scale: 1.2 }); expect(b.state().keyboardOpen).toBe(false);
  });
  it('distinguishes a zoomed keyboard from pinch-only loss using a trusted unzoomed baseline', () => {
    const b = browser(); b.start(); b.focus();
    b.resize(422, { scale: 2, width: 195 }); expect(b.state().keyboardOpen).toBe(false);
    b.resize(250, { scale: 2, width: 195 });
    expect(b.state()).toEqual({ keyboardOpen: true, viewportHeight: 250, viewportOffsetTop: 0 });
    b.resize(422, { scale: 2, width: 195 }); expect(b.state().keyboardOpen).toBe(false);
    b.resize(350, { scale: 1.3, width: 300 }); expect(b.state().keyboardOpen).toBe(true);
    b.resize(844 / 1.3, { scale: 1.3, width: 300 }); expect(b.state().keyboardOpen).toBe(false);
  });
  it('does not learn the initial baseline from a zoomed mount', () => {
    const b = browser(); b.viewport.scale = 2; b.viewport.width = 195; b.viewport.height = 250;
    b.focus(); b.start(); expect(b.state().keyboardOpen).toBe(false);
    b.resize(250); expect(b.state().keyboardOpen).toBe(false);
    b.resize(844, { scale: 1, width: 390 }); b.resize(480); expect(b.state().keyboardOpen).toBe(true);
  });
  it('handles keyboards that resize both viewports, and freezes baseline through blur/closing animation', () => {
    const b = browser(); b.start(); b.focus(); b.window.innerHeight = 490; b.resize(490);
    expect(b.state().keyboardOpen).toBe(true);
    b.focus(null); b.resize(530); b.focus(); b.resize(490);
    expect(b.state().keyboardOpen).toBe(true);
    b.resize(844); expect(b.state().keyboardOpen).toBe(false);
  });
  it('uses hysteresis without accumulating small toolbar moves', () => {
    const b = browser(); b.start(); b.focus(); b.resize(670); expect(b.state().keyboardOpen).toBe(true);
    b.resize(700); expect(b.state().keyboardOpen).toBe(true);
    b.resize(730); expect(b.state().keyboardOpen).toBe(false);
    b.focus(null); b.resize(800); b.resize(760); b.resize(720);
    b.focus(); b.resize(700); expect(b.state().keyboardOpen).toBe(false);
  });
  it('learns a growing unzoomed baseline without accumulating layout-and-toolbar shrinkage', () => {
    const b = browser(); b.start(); b.focus(); b.window.innerHeight = 920; b.resize(920);
    b.window.innerHeight = 850; b.resize(850);
    expect(b.state().keyboardOpen).toBe(false);
    b.focus(null);
    for (const height of [810, 770, 730]) { b.window.innerHeight = height; b.resize(height); }
    b.focus(); b.resize(700); expect(b.state().keyboardOpen).toBe(true);
  });
  it('resets on orientation and waits for blur before learning focused rotated geometry', () => {
    const b = browser(); b.start(); b.focus(); b.resize(480);
    b.window.innerWidth = 844; b.window.innerHeight = 390;
    b.window.screen.orientation.angle = 90;
    Object.assign(b.viewport, { width: 844, height: 220 });
    b.window.dispatchEvent(new Event('orientationchange')); b.flush();
    expect(b.state().keyboardOpen).toBe(false);
    b.resize(210); b.resize(200); expect(b.state().keyboardOpen).toBe(false);
    b.focus(null); b.resize(390); b.focus(); b.resize(220);
    expect(b.state().keyboardOpen).toBe(true);
  });
  it('also invalidates the baseline on width changes without an orientation event', () => {
    const b = browser(); b.start(); b.focus();
    b.window.innerWidth = 800; b.window.innerHeight = 390; b.resize(230, { width: 800 });
    b.resize(220); expect(b.state().keyboardOpen).toBe(false);
    b.focus(null); b.resize(390); b.focus(); b.resize(220); expect(b.state().keyboardOpen).toBe(true);
  });
  it('is conservative when mounted into an already resized layout, but accepts a known layout baseline', () => {
    const b = browser(); b.focus(); b.window.innerHeight = 480; b.viewport.height = 480; b.start();
    expect(b.state().keyboardOpen).toBe(false);
    const c = browser(); c.focus(); c.viewport.height = 480; c.start();
    expect(c.state().keyboardOpen).toBe(true);
  });
  it('ignores desktop/fine-pointer, hidden, malformed and ambiguous width samples', () => {
    const b = browser(); b.start(); b.focus();
    b.coarse.matches = false; b.resize(480); expect(b.state().keyboardOpen).toBe(false);
    b.coarse.matches = true; b.window.innerWidth = 1440; b.resize(480, { width: 1440 });
    expect(b.state().keyboardOpen).toBe(false);
    b.window.innerWidth = 390; b.resize(480, { width: 250 }); expect(b.state().keyboardOpen).toBe(false);
    for (const height of [NaN, Infinity, 0, -1]) { b.resize(height, { width: 390 }); expect(b.state().keyboardOpen).toBe(false); }
    b.document.visibilityState = 'hidden'; b.resize(480); expect(b.state().keyboardOpen).toBe(false);
    b.document.visibilityState = 'visible'; b.document.dispatchEvent(new Event('visibilitychange')); b.flush();
    expect(b.state().keyboardOpen).toBe(true);
  });
  it('rechecks silent IME geometry changes and pageshow without polling', () => {
    const b = browser(); b.start(); b.focus(); b.viewport.height = 480;
    b.document.dispatchEvent(new Event('input')); b.flush(); expect(b.state().keyboardOpen).toBe(true);
    b.viewport.height = 844; b.document.dispatchEvent(new Event('compositionend')); b.flush();
    expect(b.state().keyboardOpen).toBe(false);
    b.viewport.height = 480; b.window.dispatchEvent(new Event('pageshow')); b.flush();
    expect(b.state().keyboardOpen).toBe(true);
  });
  it('coalesces bursts, deduplicates publishes, cleans all listeners and pending frames on every mount', () => {
    const b = browser();
    for (let mount = 0; mount < 3; mount++) {
      const stop = b.start(); b.focus(); b.publish.mockClear();
      for (let i = 0; i < 100; i++) b.viewport.dispatchEvent(new Event('resize'));
      expect(b.frames.size).toBe(1); b.flush(); expect(b.publish).not.toHaveBeenCalled();
      b.resize(480); b.publish.mockClear(); b.resize(480); expect(b.publish).not.toHaveBeenCalled();
      b.viewport.dispatchEvent(new Event('scroll')); expect(b.frames.size).toBe(1);
      stop(); expect(b.frames.size).toBe(0);
      b.resize(844); expect(b.publish).not.toHaveBeenCalled();
      b.focus(null);
    }
    expect(b.adds.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(33);
    for (let i = 0; i < b.adds.length; i++) expect(b.removes[i]!.mock.calls).toEqual(b.adds[i]!.mock.calls);
  });
  it('is a no-op without VisualViewport', () => {
    const b = browser(); (b.window as unknown as { visualViewport: null }).visualViewport = null;
    b.start()(); expect(b.adds.every(spy => spy.mock.calls.length === 0)).toBe(true);
  });
});

describe('mobile view identity field boundaries', () => {
  it('distinguishes valid colon-containing paths and session IDs despite a reused route key', () => {
    const first = { cwd: '/workspace:branch', id: 'session', routeKey: 'same-key' };
    const second = { cwd: '/workspace', id: 'branch:session', routeKey: 'same-key' };
    // The prior product expression loses boundaries; this control explains the regression.
    const previousKey = (view: typeof first) => `${view.cwd}:${view.id}:${view.routeKey}`;
    expect(previousKey(first)).toBe(previousKey(second));
    expect(mobileKeyboardViewKey(undefined, first.cwd, first.id, first.routeKey))
      .not.toBe(mobileKeyboardViewKey(undefined, second.cwd, second.id, second.routeKey));
  });

  it('retires a changed workspace identity even when cwd, session and route are unchanged', () => {
    expect(mobileKeyboardViewKey('first', '/workspace', 'session', 'same-key'))
      .not.toBe(mobileKeyboardViewKey('second', '/workspace', 'session', 'same-key'));
    expect(mobileKeyboardViewKey(undefined, undefined, undefined, 'same-key'))
      .toBe(mobileKeyboardViewKey(undefined, undefined, undefined, 'same-key'));
  });
});

// Exact acceptance review additions: threshold boundaries, not queue helpers.
describe('exact mobile threshold boundaries', () => {
  it('requires strictly greater than the opening loss and closes at the hysteresis boundary', () => {
    const b = browser(); b.window.innerHeight = 800; b.viewport.height = 800; b.start(); b.focus();
    b.resize(640); expect(b.state().keyboardOpen).toBe(false);
    b.resize(639); expect(b.state().keyboardOpen).toBe(true);
    b.resize(680); expect(b.state().keyboardOpen).toBe(false);
  });
  it('does not load styles for focused non-editable fields even with full keyboard-sized geometry', async () => {
    const b = browser(); const css = delayedStyles(); const stop = b.start(css.load);
    for (const element of [field('SELECT'), field('INPUT', { readOnly: true }), field('INPUT', { disabled: true }), field('TEXTAREA', { inputmode: 'none' })]) {
      b.focus(element); b.resize(400); await settleStyles();
      expect(css.load).not.toHaveBeenCalled(); expect(b.state().keyboardOpen).toBe(false);
    }
    stop();
  });
});
