import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ExtensionInteractionSnapshot } from '@ai-harness/core';
import type { ExtensionInteractionDialogProps } from './ExtensionInteractionBoundary';
import './extension-interaction-dialog.css';

export default function ExtensionInteractionDialog({ request, waitingCount, onResolve, restoreFocusRef, canRestoreFocus, canFocusInitially, renderOutput, t }: ExtensionInteractionDialogProps) {
  const [value, setValue] = useState<unknown>(() => interactionDraft(request));
  const [submitting, setSubmitting] = useState(false);
  const previousRequest = useRef(request);
  const mounted = useRef(false);
  const pendingSubmit = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const activeRequest = useRef(JSON.stringify(request));
  activeRequest.current = JSON.stringify(request);
  const dialogRef = useRef<HTMLFormElement>(null);
  const ownsFocus = useRef(false);
  const composing = useRef(false);
  const imeAcknowledgement = useRef(false);
  const composingElement = useRef<HTMLElement | null>(null);
  const avoidKeyboard = window.matchMedia('(pointer: coarse)').matches;
  useLayoutEffect(() => {
    const observeFocus = (event: FocusEvent) => {
      ownsFocus.current = event.target instanceof Node && Boolean(dialogRef.current?.contains(event.target));
    };
    const protectComposition = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog?.isConnected || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
      const editing = composing.current || event.isComposing || event.keyCode === 229;
      if (event.key === 'Enter') imeAcknowledgement.current = editing;
      else if (!editing) imeAcknowledgement.current = false;
      if (editing && (event.key === 'Escape' || event.key === 'Enter')) event.stopPropagation();
    };
    document.addEventListener('focusin', observeFocus, true);
    // Before document traps; native editing default is never prevented.
    window.addEventListener('keydown', protectComposition, true);
    return () => {
      document.removeEventListener('focusin', observeFocus, true);
      window.removeEventListener('keydown', protectComposition, true);
    };
  }, []);
  useEffect(() => {
    const previous = previousRequest.current;
    if (JSON.stringify(previous) === JSON.stringify(request)) return;
    previousRequest.current = request;
    setValue((draft: unknown) => interactionDraft(request, previous, draft));
    pendingSubmit.current = false;
    if (previous.id !== request.id || previous.kind !== request.kind
      || composingElement.current && !composingElement.current.isConnected) {
      composing.current = false;
      composingElement.current = null;
      imeAcknowledgement.current = false;
    }
    setSubmitting(false);
    if (previous !== request && ownsFocus.current && dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
      const target = avoidKeyboard ? dialogRef.current : dialogRef.current.querySelector<HTMLElement>('[data-autofocus]') ?? dialogRef.current;
      target.focus({ preventScroll: true });
    }
  }, [request, avoidKeyboard]);
  const custom = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const resolve = async (response: { cancelled: boolean; value?: unknown }) => {
    const key = JSON.stringify(request);
    if (pendingSubmit.current) return;
    pendingSubmit.current = true;
    setSubmitting(true);
    try { await onResolve(response); } finally { if (mounted.current && activeRequest.current === key) { pendingSubmit.current = false; setSubmitting(false); } }
  };
  useFocusTrap(true, dialogRef, () => { void resolve({ cancelled: true }); }, restoreFocusRef, avoidKeyboard, canRestoreFocus, canFocusInitially);
  return <div className="modal-overlay extension-interaction-overlay" onMouseDown={event => {
    if (!submitting && event.target === event.currentTarget) void resolve({ cancelled: true });
  }}>
    <form ref={dialogRef} tabIndex={-1} className="extension-interaction" role="dialog" aria-modal="true" aria-labelledby={`extension-title-${request.id}`}
      onCompositionStart={event => {
        composing.current = true;
        composingElement.current = event.target instanceof HTMLElement ? event.target : null;
      }}
      onCompositionEnd={() => { composing.current = false; composingElement.current = null; }}
      onPointerDownCapture={() => { if (!composing.current) imeAcknowledgement.current = false; }}
      onSubmit={event => {
        event.preventDefault();
        if (composing.current || imeAcknowledgement.current) return;
        void resolve({ cancelled: false, value: request.kind === 'confirm' ? true : value });
      }}>
      <header><h3 id={`extension-title-${request.id}`}>{request.title}</h3></header>
      {waitingCount > 0 && <p role="status">{t('chat.extensionInteraction.waiting', { count: waitingCount })}</p>}
      {request.message && <p>{request.message}</p>}
      {request.output && (/\u001b\[[0-9;]*m/.test(request.output)
        ? renderOutput(request.output) : <pre className="extension-output">{request.output}</pre>)}
      {request.kind === 'input' && <input data-autofocus required value={String(value)} placeholder={request.placeholder}
        onChange={event => setValue(event.target.value)} aria-label={request.title} />}
      {request.kind === 'editor' && <textarea data-autofocus required rows={10} value={String(value)} placeholder={request.placeholder}
        onChange={event => setValue(event.target.value)} aria-label={request.title} />}
      {request.kind === 'select' && <select data-autofocus value={String(value)} onChange={event => setValue(event.target.value)} aria-label={request.title}>
        {request.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>}
      {request.kind === 'custom' && <details className="extension-custom-panel" open>
        <summary>{t('chat.extensionInteraction.fields')}</summary>
        <div className="extension-fields">
          {request.fields?.map(field => <label key={field.name}>
            <span>{field.label}</span>
            {field.type === 'textarea' ? <textarea required={field.required} placeholder={field.placeholder}
              value={String(custom[field.name] ?? '')} onChange={event => setValue({ ...custom, [field.name]: event.target.value })} />
              : field.type === 'select' ? <select required={field.required} value={String(custom[field.name] ?? '')}
                onChange={event => setValue({ ...custom, [field.name]: event.target.value })}>
                {!field.required && <option value="" />}
                {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
                : field.type === 'checkbox' ? <input type="checkbox" checked={custom[field.name] === true}
                  onChange={event => setValue({ ...custom, [field.name]: event.target.checked })} />
                  : <input required={field.required} placeholder={field.placeholder} value={String(custom[field.name] ?? '')}
                    onChange={event => setValue({ ...custom, [field.name]: event.target.value })} />}
          </label>)}
        </div>
      </details>}
      <footer>
        <button type="button" disabled={submitting} onClick={() => void resolve({ cancelled: true })}>{t('common.cancel')}</button>
        <button type="submit" disabled={submitting}>{request.kind === 'confirm' ? t('common.confirm') : t('common.submit')}</button>
      </footer>
    </form>
  </div>;
}


export function interactionDraft(request: ExtensionInteractionSnapshot, previous?: ExtensionInteractionSnapshot, value?: unknown): unknown {
  const same = request.id === previous?.id && request.kind === previous.kind;
  if (request.kind === 'custom') {
    const values = same && value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return Object.fromEntries((request.fields ?? []).map(field => {
      const old = previous?.fields?.find(entry => entry.name === field.name);
      const compatible = same && old?.type === field.type;
      const draft = compatible ? values[field.name] : undefined;
      return [field.name, field.type === 'checkbox' ? draft === true
        : field.type === 'select' ? field.options?.some(option => option.value === draft) ? draft
          : field.required ? field.options?.[0]?.value ?? '' : ''
          : typeof draft === 'string' ? draft : ''];
    }));
  }
  if (request.kind === 'select') return same && request.options?.some(option => option.value === value) ? value : request.options?.[0]?.value ?? '';
  return same && typeof value === 'string' ? value : '';
}

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

/** Dialog-local focus ownership; the shared helper and its other callers are unchanged. */
function useFocusTrap(
  active: boolean,
  container: RefObject<HTMLElement | null>,
  onEscape: () => void,
  restoreFocus?: RefObject<HTMLElement | null>,
  avoidKeyboard = false,
  canRestoreFocus?: () => boolean,
  canFocusInitially?: () => boolean,
): void {
  const escapeHandler = useRef(onEscape);
  escapeHandler.current = onEscape;
  const restoreAllowed = useRef(canRestoreFocus);
  restoreAllowed.current = canRestoreFocus;
  const initialAllowed = useRef(canFocusInitially);
  initialAllowed.current = canFocusInitially;
  const cancelReturn = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    if (!active) return;
    cancelReturn.current?.();
    const dialog = container.current;
    const fallback = restoreFocus?.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    let newerFocus = false;
    let editableIntent = false;
    const rememberEditing = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (!dialog?.contains(event.target)) editableIntent = false;
      else if (event.target.matches('textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]')) editableIntent = true;
    };
    // Coarse pointers suppress unsolicited keyboard focus, not restoration of manual editing.
    document.addEventListener('focusin', rememberEditing, true);
    const rememberFocus = () => { newerFocus = true; };
    document.addEventListener('focusin', rememberFocus, true);
    const focusInitial = () => {
      document.removeEventListener('focusin', rememberFocus, true);
      if (newerFocus || initialAllowed.current?.() === false || !dialog?.isConnected || dialog !== container.current) return;
      const focusedModal = document.activeElement?.closest('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
      if (focusedModal && focusedModal !== dialog) return;
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
      (avoidKeyboard ? dialog : preferred ?? focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    };
    const frame = window.requestAnimationFrame(focusInitial);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!dialog?.isConnected || dialog !== container.current) return;
      const focusedModal = document.activeElement?.closest('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
      if (focusedModal && focusedModal !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); escapeHandler.current(); return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement) || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', rememberEditing, true);
      document.removeEventListener('focusin', rememberFocus, true);
      if (document.activeElement !== document.body && !dialog?.contains(document.activeElement)) return;
      let returned = false;
      const cancel = () => {
        returned = true;
        window.cancelAnimationFrame(returnFrame);
        document.removeEventListener('focusin', cancel, true);
        if (cancelReturn.current === cancel) cancelReturn.current = undefined;
      };
      const returnFrame = window.requestAnimationFrame(() => {
        const superseded = returned;
        cancel();
        if (superseded || restoreAllowed.current?.() === false || !fallback?.isConnected || restoreFocus?.current !== fallback) return;
        const available = (element?: HTMLElement | null) => Boolean(element?.isConnected && element !== document.body
          && !element.matches(':disabled') && !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0);
        const wasComposerSend = previousFocus?.matches('.composer-controls button[type="submit"]');
        const target = available(previousFocus) && !wasComposerSend ? previousFocus : fallback;
        if (!available(target) || (avoidKeyboard && !editableIntent && target?.matches('input, textarea, [contenteditable="true"]'))) return;
        const otherModal = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"]')]
          .some(modal => modal.isConnected && modal.getClientRects().length > 0 && !modal.contains(target ?? null));
        if (!otherModal) target?.focus({ preventScroll: true });
      });
      cancelReturn.current = cancel;
      document.addEventListener('focusin', cancel, true);
    };
  }, [active, container, restoreFocus, avoidKeyboard]);
}
