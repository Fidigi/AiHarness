import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

const hooks = vi.hoisted(() => ({ effect: undefined as (() => void | (() => void)) | undefined,
  refs: [] as { current: unknown }[], index: 0 }));
vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; },
  useRef: (value: unknown) => hooks.refs[hooks.index++] ?? (hooks.refs[hooks.index - 1] = { current: value }),
}));

let dom: EventTarget & { activeElement: ElementStub; body: ElementStub };
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
class ElementStub {
  isConnected = true;
  hidden = false;
  disabled = false;
  inert = false;
  visible = true;
  children: ElementStub[] = [];
  preferred?: ElementStub;
  focus = vi.fn(() => { dom.activeElement = this; dom.dispatchEvent(new Event('focusin')); });
  getClientRects() { return this.visible ? [{}] : []; }
  getAttribute() { return null; }
  matches() { return this.disabled; }
  closest() { return this.inert ? this : null; }
  contains(target: unknown) { return target === this || this.children.includes(target as ElementStub); }
  querySelector() { return this.preferred ?? null; }
  querySelectorAll() { return this.children; }
}
const ref = (element: ElementStub | null) => ({ current: element as unknown as HTMLElement | null });
function setup(dialog: ReturnType<typeof ref>, fallback?: ReturnType<typeof ref>, active = true) {
  hooks.index = 0;
  useFocusTrap(active, dialog, () => {}, fallback);
  const cleanup = hooks.effect?.();
  return typeof cleanup === 'function' ? cleanup : undefined;
}
function paint() {
  for (const [id, callback] of [...frames]) {
    if (!frames.has(id)) continue;
    frames.delete(id); callback(0);
  }
}
beforeEach(() => {
  hooks.refs = []; hooks.index = 0; hooks.effect = undefined;
  frames = new Map(); frameId = 0;
  const body = new ElementStub();
  dom = Object.assign(new EventTarget(), { body, activeElement: body });
  vi.stubGlobal('document', dom); vi.stubGlobal('HTMLElement', ElementStub);
  vi.stubGlobal('window', {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
});
afterEach(() => vi.unstubAllGlobals());

function modal() {
  const invoker = new ElementStub(); dom.activeElement = invoker;
  const dialog = new ElementStub(); const input = new ElementStub();
  dialog.children = [input]; dialog.preferred = input;
  return { invoker, dialog, input, dialogRef: ref(dialog) };
}
function detach(dialog: ElementStub) { dialog.isConnected = false; dom.activeElement = dom.body; }

describe('focus trap deferred ownership', () => {
  it('initially focuses the preferred child and returns to the invoker on ordinary close', () => {
    const m = modal(); const cleanup = setup(m.dialogRef); paint();
    expect(dom.activeElement).toBe(m.input);
    detach(m.dialog); cleanup?.(); paint();
    expect(dom.activeElement).toBe(m.invoker);
  });
  it('does not overwrite a newer explicit focus before passive cleanup', () => {
    const m = modal(); const cleanup = setup(m.dialogRef); paint(); detach(m.dialog);
    const newer = new ElementStub(); newer.focus(); cleanup?.(); paint();
    expect(dom.activeElement === newer).toBe(true); expect(m.invoker.focus).not.toHaveBeenCalled();
  });
  it('retires queued return after a newer focusin, even if that element later blurs', () => {
    const m = modal(); const cleanup = setup(m.dialogRef); paint(); detach(m.dialog); cleanup?.();
    new ElementStub().focus(); dom.activeElement = dom.body; paint();
    expect(m.invoker.focus).not.toHaveBeenCalled();
  });
  it('retires old return on a new active lifetime/StrictMode replay', () => {
    const m = modal(); const cleanup = setup(m.dialogRef); paint(); detach(m.dialog); cleanup?.();
    const next = new ElementStub(); const input = new ElementStub(); next.children = [input];
    m.dialogRef.current = next as unknown as HTMLElement;
    const stop = setup(m.dialogRef); paint();
    expect(dom.activeElement).toBe(input); expect(m.invoker.focus).not.toHaveBeenCalled(); stop?.(); paint();
  });
  it('does not overwrite newer focus while initial autofocus is pending', () => {
    const m = modal(); const cleanup = setup(m.dialogRef);
    const newer = new ElementStub(); newer.focus(); paint();
    expect(dom.activeElement === newer).toBe(true); expect(m.input.focus).not.toHaveBeenCalled(); cleanup?.(); paint();
  });
  it('never autofocuses a replacement DOM scope through the old frame', () => {
    const m = modal(); const cleanup = setup(m.dialogRef);
    const next = new ElementStub(); next.preferred = new ElementStub();
    m.dialogRef.current = next as unknown as HTMLElement; paint();
    expect(next.preferred.focus).not.toHaveBeenCalled(); cleanup?.(); paint();
  });
  it('uses only an available fallback when the invoker was removed', () => {
    const m = modal(); const fallback = new ElementStub(); const cleanup = setup(m.dialogRef, ref(fallback));
    paint(); detach(m.dialog); m.invoker.isConnected = false; cleanup?.(); paint();
    expect(dom.activeElement).toBe(fallback);
  });
  it('does not return into an inert, disabled or hidden fallback', () => {
    for (const unavailable of ['inert', 'disabled', 'visible'] as const) {
      hooks.refs = [];
      const m = modal(); const fallback = new ElementStub(); fallback[unavailable] = unavailable !== 'visible';
      const cleanup = setup(m.dialogRef, ref(fallback)); paint(); detach(m.dialog); m.invoker.isConnected = false; cleanup?.(); paint();
      expect(fallback.focus).not.toHaveBeenCalled();
    }
  });
});

it('a retired picker cannot supersede a different newly active modal before its autofocus', () => {
  const old = modal(); const closeOld = setup(old.dialogRef); paint(); detach(old.dialog); closeOld?.();
  // Different hook instance: not the same cancelRestore ref or StrictMode replay.
  hooks.refs = [];
  const next = new ElementStub(); const input = new ElementStub(); next.children = [input];
  const closeNext = setup(ref(next)); paint();
  expect(dom.activeElement === input).toBe(true);
  expect(old.invoker.focus).not.toHaveBeenCalled();
  detach(next); closeNext?.(); paint();
});
