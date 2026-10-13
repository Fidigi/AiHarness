import { useEffect, useRef, type RefObject } from 'react';
import { currentEscapeModal, registerEscapeLayer } from '../services/escape-stack';

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
  const invocation = useRef<{ dialog: HTMLElement | null; target: HTMLElement | undefined } | null>(null);
  const cancelRestore = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    // A new modal lifetime (including StrictMode replay) retires the old return.
    cancelRestore.current?.();
    const ownedDialog = container.current;
    const releaseEscape = registerEscapeLayer({ document, kind: 'modal',
      element: () => container.current === ownedDialog ? ownedDialog : null,
      close: () => escapeHandler.current() });
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    // A parent can pause while a child owns the keys, without losing its invoker.
    const previousFocus = invocation.current?.dialog === ownedDialog ? invocation.current.target
      : document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    invocation.current = { dialog: ownedDialog, target: previousFocus };
    let newerFocus = false;
    const rememberFocus = () => { newerFocus = true; };
    document.addEventListener('focusin', rememberFocus, true);
    const focusInitial = () => {
      document.removeEventListener('focusin', rememberFocus, true);
      const dialog = container.current;
      if (newerFocus || !dialog?.isConnected || dialog !== ownedDialog || currentEscapeModal(document) !== dialog) return;
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
      const target = coarse ? dialog : preferred ?? focusableElements(dialog)[0] ?? dialog;
      if (coarse && !dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
      target.focus({ preventScroll: true });
    };
    const frame = window.requestAnimationFrame(focusInitial);
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = container.current;
      if (!dialog) return;
      if (event.defaultPrevented || event.key !== 'Tab') return;
      if (currentEscapeModal(document) !== dialog) return;
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
      releaseEscape();
      if (!ownedDialog?.isConnected || ownedDialog.getClientRects().length === 0 || container.current !== ownedDialog) invocation.current = null;
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', rememberFocus, true);
      // Closing may already have committed a newer explicit destination. Never
      // return over that focus, or over a focusin between cleanup and the frame.
      const currentFocus = document.activeElement;
      if (currentFocus !== document.body && !ownedDialog?.contains(currentFocus)) return;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        window.cancelAnimationFrame(restoreFrame);
        document.removeEventListener('focusin', cancel, true);
        if (cancelRestore.current === cancel) cancelRestore.current = undefined;
      };
      const restoreFrame = window.requestAnimationFrame(() => {
        const superseded = cancelled;
        cancel();
        if (superseded) return;
        const available = (element: HTMLElement | null | undefined) => element?.isConnected
          && element !== document.body && !element.matches(':disabled')
          && !element.closest('[inert], [aria-hidden="true"]')
          && element.getClientRects().length > 0;
        const target = available(previousFocus) ? previousFocus : restoreFocus?.current;
        // A sibling/child modal may have activated before either frame runs.
        // Returning outside that live scope must not cancel its initial focus.
        const topModal = currentEscapeModal(document);
        const outsideActiveModal = topModal && !topModal.contains(target ?? null);
        const editable = target?.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]');
        if (!outsideActiveModal && available(target) && !(coarse && editable)) target?.focus({ preventScroll: true });
      });
      cancelRestore.current = cancel;
      document.addEventListener('focusin', cancel, true);
    };
  }, [active, container, restoreFocus]);
}
