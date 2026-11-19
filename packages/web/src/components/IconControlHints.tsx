import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const name = (element: HTMLElement) => element.getAttribute('aria-label') || element.getAttribute('title') || '';
function iconControl(target: EventTarget | null): HTMLElement | null {
  const control = target instanceof Element ? target.closest<HTMLElement>('button, a') : null;
  return control && !control.textContent?.trim() && control.querySelector(':scope > .ui-icon') && name(control)
    && !control.closest('[hidden], [inert], [aria-hidden="true"]') ? control : null;
}

/** Visual copies of existing names; never a focus target or an Escape owner. */
export default function IconControlHints() {
  const [focused, setFocused] = useState<HTMLElement | null>(null);
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const hint = useRef<HTMLDivElement>(null);
  const target = dismissed ? null : hovered ?? focused;
  const clear = () => { setFocused(null); setHovered(null); setDismissed(false); };

  useEffect(() => {
    const handlers: Record<string, EventListener> = {
      focusin: event => {
        const control = iconControl(event.target);
        const keyboard = control?.matches(':focus-visible');
        setFocused(keyboard ? control : null);
        if (keyboard) { setHovered(null); setDismissed(false); }
      },
      focusout: () => setFocused(null),
      pointerover: event => {
        if (event.target instanceof Node && hint.current?.contains(event.target)) return;
        const control = (event as PointerEvent).pointerType === 'touch' ? null : iconControl(event.target);
        // Existing browser hover titles remain available; the keyboard hint also covers those controls.
        const next = control?.hasAttribute('title') ? null : control;
        if (next && next !== hovered) setDismissed(false);
        setHovered(next);
      },
      pointerout: event => {
        const next = (event as PointerEvent).relatedTarget;
        if (next instanceof Node && (hint.current?.contains(next) || hovered?.contains(next))) return;
        setHovered(null);
      },
      pointerdown: event => {
        if (!(event.target instanceof Node && hint.current?.contains(event.target))) setDismissed(true);
      },
      keydown: event => {
        if (!['Shift', 'Control', 'Alt', 'Meta'].includes((event as KeyboardEvent).key)) setDismissed(true);
      },
    };
    for (const [type, listener] of Object.entries(handlers)) document.addEventListener(type, listener, true);
    window.addEventListener('resize', clear); window.addEventListener('blur', clear);
    return () => {
      for (const [type, listener] of Object.entries(handlers)) document.removeEventListener(type, listener, true);
      window.removeEventListener('resize', clear); window.removeEventListener('blur', clear);
    };
  }, [hovered]);

  useEffect(() => {
    if (!target) return;
    const label = name(target);
    const observer = new MutationObserver(records => {
      const visibilityChanged = records.some(record => record.type === 'attributes'
        && record.target instanceof Element && record.target.contains(target));
      if (!target.isConnected || !iconControl(target) || name(target) !== label
        || visibilityChanged && !target.getClientRects().length) clear();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-label', 'title', 'class', 'style', 'open'] });
    return () => observer.disconnect();
  }, [target]);

  useLayoutEffect(() => {
    if (!target || !hint.current) return;
    const node = hint.current;
    const place = () => {
      const box = target.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= window.innerHeight || box.right <= 0 || box.left >= window.innerWidth) { clear(); return; }
      const above = box.top - 8, below = window.innerHeight - box.bottom - 8;
      node.style.maxHeight = `${Math.max(above, below)}px`;
      const size = node.getBoundingClientRect(); // Preserve fractional geometry at the control boundary.
      node.style.left = `${Math.max(8, Math.min(box.x + (box.width - size.width) / 2, window.innerWidth - size.width - 8))}px`;
      node.style.top = `${above >= below ? box.top - size.height : box.bottom}px`;
    };
    place();
    document.addEventListener('scroll', place, true);
    return () => document.removeEventListener('scroll', place, true);
  }, [target]);

  return target && createPortal(<div ref={hint} className="icon-control-hint" aria-hidden="true" tabIndex={-1} onMouseDown={event => event.preventDefault()}>
    <span>{name(target)}</span>
  </div>, document.body);
}
