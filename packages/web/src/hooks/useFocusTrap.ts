import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Ephemeral modal ownership only; no pending intent or application authority.
const activeScopes = new Set<{ dialog: HTMLElement | null; document: Document }>();

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
  const cancelRestore = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    // A new modal lifetime (including StrictMode replay) retires the old return.
    cancelRestore.current?.();
    const ownedDialog = container.current;
    const scope = { dialog: ownedDialog, document };
    activeScopes.add(scope);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    let newerFocus = false;
    const rememberFocus = () => { newerFocus = true; };
    document.addEventListener('focusin', rememberFocus, true);
    const focusInitial = () => {
      document.removeEventListener('focusin', rememberFocus, true);
      const dialog = container.current;
      if (newerFocus || !dialog?.isConnected || dialog !== ownedDialog) return;
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
      activeScopes.delete(scope);
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
        const outsideActiveModal = [...activeScopes].some(owner => owner.document === document
          && owner.dialog?.isConnected && owner.dialog.getClientRects().length > 0
          && !owner.dialog.closest('[inert], [aria-hidden="true"]')
          && !owner.dialog.contains(target ?? null));
        if (!outsideActiveModal && available(target)) target?.focus();
      });
      cancelRestore.current = cancel;
      document.addEventListener('focusin', cancel, true);
    };
  }, [active, container, restoreFocus]);
}
