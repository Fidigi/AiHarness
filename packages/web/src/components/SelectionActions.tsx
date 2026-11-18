import { useLayoutEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';

export interface CapturedSelection {
  text: string;
  range: Range;
  view: string;
  scope: { workspaceId?: string; cwd?: string; sessionId?: string };
}

function ownsSelection(capture: CapturedSelection, view: string): boolean {
  const state = useSessionStore.getState();
  return capture.view === view && state.activeSessionId === capture.scope.sessionId
    && state.workspace?.id === capture.scope.workspaceId && state.workspace?.cwd === capture.scope.cwd
    && !capture.range.collapsed && capture.range.startContainer.isConnected && capture.range.endContainer.isConnected;
}

/** Optional, view-owned UI: coordinates are observations, never durable selection authority. */
export default function SelectionActions({ capture, view, setCapture, onQuote }: {
  capture: CapturedSelection;
  view: string;
  setCapture: Dispatch<SetStateAction<CapturedSelection | undefined>>;
  onQuote: (newChat: boolean) => void;
}) {
  const { t } = useI18n();
  const [position, setPosition] = useState<{ x: number; y: number }>();
  useLayoutEffect(() => {
    let disposed = false, frame = 0;
    const range = capture.range;
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const root = start?.closest('.messages-container');
    const dismiss = () => setCapture(previous => previous === capture ? undefined : previous);
    const update = () => {
      if (disposed) return;
      if (!ownsSelection(capture, view) || !root?.contains(range.startContainer) || !root.contains(range.endContainer)) { dismiss(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) { dismiss(); return; }
      const x = rect.left + rect.width / 2, y = rect.top;
      setPosition(previous => previous?.x === x && previous.y === y ? previous : { x, y });
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    update();
    if (!root) return () => { disposed = true; };
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    if (start && start !== root) resize.observe(start);
    const changes = new MutationObserver(schedule);
    changes.observe(root, { childList: true, characterData: true, attributes: true, subtree: true });
    document.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    document.fonts.addEventListener('loadingdone', schedule);
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect();
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.fonts.removeEventListener('loadingdone', schedule);
    };
    // The captured lifetime owns observers; quote callbacks and coordinate observations do not.
  }, [capture, view, setCapture]);
  if (!position || !ownsSelection(capture, view)) return null;
  const quote = (newChat: boolean) => { if (ownsSelection(capture, view)) onQuote(newChat); };
  return <div className="selection-actions" role="toolbar" aria-label={t('chat.selectionActions')}
    style={{ left: position.x, top: position.y }}>
    <button onClick={() => quote(false)}>{t('chat.askHere')}</button>
    <button onClick={() => quote(true)}>{t('chat.askNew')}</button>
  </div>;
}
