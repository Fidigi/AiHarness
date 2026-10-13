import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyboardComposing, registerEscapeLayer, type EscapeLayer } from './escape-stack';

class ElementStub {
  isConnected = true;
  hidden = false;
  children: ElementStub[] = [];
  contains(target: unknown): boolean { return target === this || this.children.some(child => child.contains(target)); }
  getClientRects() { return this.hidden ? [] : [{}]; }
  closest() { return null; }
}
class DocumentStub extends EventTarget {
  defaultView = null;
  pendingModal = false;
  capture = false;
  closest() { return this.capture ? {} : null; }
  querySelector() { return this.pendingModal ? {} : null; }
}
const releases: Array<() => void> = [];
afterEach(() => { releases.splice(0).reverse().forEach(release => release()); });
function layer(doc: DocumentStub, kind: EscapeLayer['kind'], element?: ElementStub, close = vi.fn(() => true)) {
  const release = registerEscapeLayer({ document: doc as unknown as Document, kind, close,
    ...(element ? { element: () => element as unknown as HTMLElement } : {}) });
  releases.push(release);
  return { close, release };
}
function escape(doc: DocumentStub, extra = {}) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', repeat: false,
    isComposing: false, keyCode: 27, ...extra });
  doc.dispatchEvent(event);
  return event;
}

describe('capture Escape ownership', () => {
  it('closes only the nearest nested modal even when its parent registers later', () => {
    const doc = new DocumentStub(); const parent = new ElementStub(); const child = new ElementStub(); parent.children = [child];
    const inner = layer(doc, 'modal', child); const outer = layer(doc, 'modal', parent);
    const event = escape(doc);
    expect(event.defaultPrevented).toBe(true); expect(inner.close).toHaveBeenCalledTimes(1); expect(outer.close).not.toHaveBeenCalled();
    inner.release(); escape(doc); expect(outer.close).toHaveBeenCalledTimes(1);
  });
  it('prefers only a menu inside the top modal, not a composer menu behind it', () => {
    const doc = new DocumentStub(); const modal = new ElementStub(); const menu = new ElementStub(); modal.children = [menu];
    const behind = layer(doc, 'menu', new ElementStub()); const dialog = layer(doc, 'modal', modal);
    const nearest = layer(doc, 'menu', menu); escape(doc);
    expect(nearest.close).toHaveBeenCalledTimes(1); expect(behind.close).not.toHaveBeenCalled(); expect(dialog.close).not.toHaveBeenCalled();
  });
  it('takes the most recently registered sibling and retires leases idempotently', () => {
    const doc = new DocumentStub(); const a = layer(doc, 'modal', new ElementStub()); const b = layer(doc, 'modal', new ElementStub());
    escape(doc); expect(b.close).toHaveBeenCalledTimes(1); expect(a.close).not.toHaveBeenCalled();
    b.release(); b.release(); escape(doc); expect(a.close).toHaveBeenCalledTimes(1);
  });
  it.each(['hidden', 'isConnected'] as const)('skips unavailable %s layers', property => {
    const doc = new DocumentStub(); const element = new ElementStub(); element[property] = property === 'hidden';
    const modal = layer(doc, 'modal', element); const agent = layer(doc, 'agent'); escape(doc);
    expect(modal.close).not.toHaveBeenCalled(); expect(agent.close).toHaveBeenCalledTimes(1);
  });
  it('closes navigation before stopping an agent, and leaves idle Escape untouched', () => {
    const doc = new DocumentStub(); const agent = layer(doc, 'agent'); const navigation = layer(doc, 'navigation');
    escape(doc); expect(navigation.close).toHaveBeenCalledTimes(1); expect(agent.close).not.toHaveBeenCalled();
    navigation.close.mockReturnValue(false); escape(doc); expect(agent.close).toHaveBeenCalledTimes(1);
    agent.close.mockReturnValue(false); expect(escape(doc).defaultPrevented).toBe(false);
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not dismiss or stop during native composition %j', extra => {
    const doc = new DocumentStub(); const modal = layer(doc, 'modal', new ElementStub()); const agent = layer(doc, 'agent');
    const event = escape(doc, extra); expect(event.defaultPrevented).toBe(false);
    expect(modal.close).not.toHaveBeenCalled(); expect(agent.close).not.toHaveBeenCalled();
  });
  it('tracks composition when the browser key does not carry isComposing and releases it at compositionend', () => {
    const doc = new DocumentStub(); const modal = layer(doc, 'modal', new ElementStub());
    doc.dispatchEvent(new Event('compositionstart')); const event = escape(doc);
    expect(keyboardComposing(event as unknown as KeyboardEvent, doc as unknown as Document)).toBe(true);
    expect(modal.close).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
    doc.dispatchEvent(new Event('compositionend')); escape(doc); expect(modal.close).toHaveBeenCalledTimes(1);
  });
  it('does not fan one event out to legacy bubble handlers or auto-repeat through the stack', () => {
    const doc = new DocumentStub(); layer(doc, 'modal', new ElementStub()); const later = vi.fn(); doc.addEventListener('keydown', later);
    escape(doc); expect(later).not.toHaveBeenCalled();
    const repeated = layer(doc, 'menu', new ElementStub()); escape(doc, { repeat: true }); expect(repeated.close).not.toHaveBeenCalled();
  });
  it('blocks fallback while a committed modal has not registered its handler yet', () => {
    const doc = new DocumentStub(); doc.pendingModal = true; const agent = layer(doc, 'agent');
    expect(escape(doc).defaultPrevented).toBe(true); expect(agent.close).not.toHaveBeenCalled();
  });
  it('leaves explicit shortcut recording local, without navigating or stopping', () => {
    const doc = new DocumentStub(); doc.capture = true; const navigation = layer(doc, 'navigation'); const agent = layer(doc, 'agent');
    expect(escape(doc).defaultPrevented).toBe(false);
    expect(navigation.close).not.toHaveBeenCalled(); expect(agent.close).not.toHaveBeenCalled();
  });
  it('does not process an already prevented event', () => {
    const doc = new DocumentStub(); const agent = layer(doc, 'agent');
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }); event.preventDefault();
    doc.dispatchEvent(event); expect(agent.close).not.toHaveBeenCalled();
  });
  it('removes capture and composition listeners when the last layer retires', () => {
    const doc = new DocumentStub(); const remove = vi.spyOn(doc, 'removeEventListener'); const modal = layer(doc, 'modal', new ElementStub());
    modal.release(); expect(remove).toHaveBeenCalledTimes(3);
    expect(escape(doc).defaultPrevented).toBe(false);
  });
});
