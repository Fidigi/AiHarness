import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { useEscapeLayer } from '../hooks/useEscapeLayer';
import { useSessionStore, type StoredSession } from '../store/session-store';
import { copyDisplayedSession } from '../services/session-row-copy';
import { captureDisplayedSessionCopyTarget } from './session-row-copy-target';
import { sessionLinkTo } from './session-links';
import './session-row-copy.css';

/** Lazy presentation only. Native popover keeps its DOM inside the Sidebar's
 * focus boundary while painting outside the scrolling list. No source runtime. */
export default function SessionRowCopyMenu({ session, inactive, onRequestClose }: {
  session: StoredSession; inactive: boolean; onRequestClose?: () => void;
}) {
  const { locale } = useI18n(), navigate = useNavigate(), location = useLocation(), id = useId();
  const copy = locale.startsWith('fr') ? {
    menu: 'Actions de conversation', action: 'Copier jusqu’à l’entrée affichée',
    unavailable: 'Une entrée enregistrée de cette conversation est requise.',
    failed: 'Impossible de copier l’entrée affichée.', pending: 'Copie en cours…',
  } : {
    menu: 'Conversation actions', action: 'Copy through displayed entry',
    unavailable: 'A saved entry in this conversation is required.',
    failed: 'The displayed entry could not be copied.', pending: 'Copying…',
  };
  const workspace = useSessionStore(state => state.workspace);
  const unavailable = useSessionStore(state => state.workspaceUnavailable);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const eligible = captureDisplayedSessionCopyTarget(session, workspace, unavailable);
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [owner, setOwner] = useState<HTMLElement | null>(null);
  const wrapper = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLButtonElement>(null), request = useRef<AbortController | undefined>(undefined);
  const pendingRef = useRef(false), mounted = useRef(true), navigation = useRef(location);
  navigation.current = location;
  const available = useRef(!inactive); available.current = !inactive;
  const scene = () => {
    const state = useSessionStore.getState(), route = navigation.current;
    return JSON.stringify([route.key, route.pathname, route.search, route.hash,
      state.workspace?.id, state.workspace?.cwd, state.workspaceUnavailable, state.activeSessionId,
      state.sessions.find(item => item.id === state.activeSessionId)?.activeLeafId]);
  };
  useEffect(() => {
    mounted.current = true; setOwner(wrapper.current?.closest<HTMLElement>('.sidebar') ?? null);
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => {
    const element = popover.current;
    const toggled = (event: Event) => {
      const opened = (event as ToggleEvent).newState === 'open'; setOpen(opened);
      if (opened && element) (element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? element).focus();
    };
    element?.addEventListener('toggle', toggled);
    return () => { element?.removeEventListener('toggle', toggled); };
  }, [owner]);
  useEffect(() => {
    // A hidden/inert Sidebar stays mounted on mobile. Closing its owner retires
    // this request even when route/session identity stays the same or it reopens.
    request.current?.abort(); setError('');
    if (popover.current?.matches(':popover-open')) popover.current.hidePopover();
  }, [inactive, workspace?.id, workspace?.cwd, activeSessionId, location.key, location.pathname, location.search, location.hash]);
  useEscapeLayer(open, 'menu', () => {
    if (popover.current?.matches(':popover-open')) popover.current.hidePopover();
  }, popover);

  const toggle = () => {
    const element = popover.current, button = invoker.current;
    if (!element || !button) return;
    const rect = button.getBoundingClientRect();
    // Keep the fixed popup origin on CSS pixels, not fractional row layout.
    // Native viewport clamps and the owning Sidebar/focus boundary stay exact.
    element.style.left = `${Math.round(Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)))}px`;
    element.style.top = `${Math.round(Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 110)))}px`;
  };
  const performCopy = async () => {
    // All target primitives are owned before the first await. Never refresh a
    // missing leaf from later source state, the last message or the current page.
    const target = captureDisplayedSessionCopyTarget(session, useSessionStore.getState().workspace,
      useSessionStore.getState().workspaceUnavailable);
    if (!target || !available.current || pendingRef.current) return;
    const owner = scene(), controller = new AbortController(); request.current = controller;
    pendingRef.current = true; setPending(true); setError('');
    try {
      const result = await copyDisplayedSession(target, controller.signal);
      if (!mounted.current || !available.current || controller.signal.aborted) return;
      const state = useSessionStore.getState(), owned = scene() === owner;
      if (result.success && result.data && !state.workspaceUnavailable
        && state.workspace?.id === target.workspaceId && state.workspace.cwd === target.cwd) state.syncSession(result.data);
      if (!owned) return;
      if (result.success && result.data) {
        if (popover.current?.matches(':popover-open')) popover.current.hidePopover();
        onRequestClose?.();
        navigate(sessionLinkTo(result.data.id, target.cwd));
      } else setError(copy.failed);
    } finally {
      if (request.current === controller) {
        request.current = undefined; pendingRef.current = false;
        if (mounted.current) setPending(false);
      }
    }
  };
  return <div className="session-row-copy" ref={wrapper}>
    <button type="button" ref={invoker} disabled={!owner || inactive} aria-label={copy.menu} title={copy.menu}
      aria-haspopup="menu" aria-expanded={open} aria-controls={id} popoverTarget={id} onClick={toggle}>⋮</button>
    {owner && createPortal(<div id={id} ref={popover} popover="auto" tabIndex={-1} className="session-row-copy-menu" role="menu" aria-label={copy.menu}>
      <button type="button" role="menuitem" disabled={!eligible || pending} onClick={() => void performCopy()}>
        {pending ? copy.pending : copy.action}
      </button>
      {!eligible && <p>{copy.unavailable}</p>}
      {error && <p role="alert">{error}</p>}
    </div>, owner)}
  </div>;
}
