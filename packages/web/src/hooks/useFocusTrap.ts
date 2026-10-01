import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0);
}

/** Traps keyboard focus in an active modal, closes it on Escape and restores its invoker. */
export function useFocusTrap(
  active: boolean,
  container: RefObject<HTMLElement | null>,
  onEscape: () => void,
  restoreFocus?: RefObject<HTMLElement | null>,
): void {
  const escapeHandler = useRef(onEscape);
  escapeHandler.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusInitial = () => {
      const dialog = container.current;
      if (!dialog) return;
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? focusableElements(dialog)[0] ?? dialog).focus();
    };
    const frame = window.requestAnimationFrame(focusInitial);
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = container.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        escapeHandler.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.requestAnimationFrame(() => {
        const previousAvailable = previousFocus?.isConnected
          && !previousFocus.matches(':disabled')
          && previousFocus.getClientRects().length > 0;
        (previousAvailable ? previousFocus : restoreFocus?.current)?.focus();
      });
    };
  }, [active, container, restoreFocus]);
}
