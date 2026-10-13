/** Ephemeral keyboard ownership; never grants run, workspace or transport authority. */
export interface EscapeLayer {
  document: Document;
  kind: 'modal' | 'menu' | 'navigation' | 'agent';
  element?: () => HTMLElement | null | undefined;
  close: () => void | boolean;
}
interface Stack {
  layers: EscapeLayer[];
  composing: WeakSet<EventTarget>;
  release: () => void;
}
const stacks = new WeakMap<Document, Stack>();
function visible(layer: EscapeLayer): boolean {
  if (!layer.element) return true;
  const element = layer.element();
  return Boolean(element?.isConnected && element.getClientRects().length > 0
    && !element.closest('[inert], [aria-hidden="true"]'));
}
function deepest(items: EscapeLayer[]): EscapeLayer | undefined {
  return items.reduce<EscapeLayer | undefined>((top, candidate) => {
    if (!top) return candidate;
    const a = top.element?.(); const b = candidate.element?.();
    return b?.contains(a ?? null) ? top : candidate;
  }, undefined);
}
/** Shared keyboard/focus owner; DOM nesting wins over React effect order. */
export function currentEscapeModal(document: Document): HTMLElement | null | undefined {
  return deepest(stacks.get(document)?.layers.filter(layer => layer.kind === 'modal' && visible(layer)) ?? [])?.element?.();
}

export function keyboardComposing(event: KeyboardEvent, document: Document): boolean {
  return event.isComposing || event.keyCode === 229
    || Boolean(event.target && stacks.get(document)?.composing.has(event.target));
}

export function registerEscapeLayer(layer: EscapeLayer): () => void {
  const doc = layer.document;
  let stack = stacks.get(doc);
  if (!stack) {
    const target = doc.defaultView ?? doc;
    const composing = new WeakSet<EventTarget>();
    const start = (event: Event) => { if (event.target) composing.add(event.target); };
    const end = (event: Event) => { if (event.target) composing.delete(event.target); };
    const owned: Stack = { layers: [], composing, release: () => {
      target.removeEventListener('keydown', keydown as EventListener, true);
      target.removeEventListener('compositionstart', start, true);
      target.removeEventListener('compositionend', end, true);
    } };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (keyboardComposing(event, doc)) {
        // Keep the native IME default, but no JS layer may dismiss or stop.
        event.stopImmediatePropagation();
        return;
      }
      // Shortcut recording is an explicit local key owner, not a navigation chord.
      if ((event.target as Element | null)?.closest?.('[data-shortcut-capture]')) return;
      const eligible = owned.layers.filter(visible);
      const modal = deepest(eligible.filter(candidate => candidate.kind === 'modal'));
      const menus = eligible.filter(candidate => candidate.kind === 'menu'
        && (!modal || modal.element?.()?.contains(candidate.element?.() ?? null)));
      const local = deepest(menus) ?? modal;
      const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
      if (event.repeat) { if (eligible.length) consume(); return; }
      if (local) { consume(); local.close(); return; }
      // A just-committed modal whose layout/effect has not registered yet blocks fallback.
      if (doc.querySelector?.('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) { consume(); return; }
      for (const kind of ['navigation', 'agent'] as const) {
        for (const candidate of [...eligible].reverse().filter(item => item.kind === kind)) {
          if (candidate.close() !== false) { consume(); return; }
        }
      }
    };
    stacks.set(doc, owned);
    target.addEventListener('keydown', keydown as EventListener, true);
    target.addEventListener('compositionstart', start, true);
    target.addEventListener('compositionend', end, true);
    stack = owned;
  }
  stack.layers.push(layer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = stack.layers.indexOf(layer);
    if (index >= 0) stack.layers.splice(index, 1);
    if (!stack.layers.length) { stack.release(); stacks.delete(doc); }
  };
}
