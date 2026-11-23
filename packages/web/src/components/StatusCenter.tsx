import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../hooks/useI18n';
import { Icon } from './Icon';
import {
  dismissNotice,
  getNoticesSnapshot,
  subscribeNotices,
  type AppNotice,
} from '../services/notices';

function StatusNotice({ notice }: { notice: AppNotice }) {
  const { t } = useI18n();
  const [paused, setPaused] = useState(false);
  const remainingMs = useRef(notice.timeoutMs);
  const timerStartedAt = useRef(0);

  useEffect(() => {
    if (paused || remainingMs.current <= 0) return;
    timerStartedAt.current = Date.now();
    const timer = window.setTimeout(() => dismissNotice(notice.id), remainingMs.current);
    return () => {
      window.clearTimeout(timer);
      remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - timerStartedAt.current));
    };
  }, [notice.id, paused]);

  return (
    <article
      className={`status-notice ${notice.level}`}
      role={notice.level === 'error' || notice.level === 'warning' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span>{notice.message}</span>
      <button type="button" onClick={() => dismissNotice(notice.id)} aria-label={t('common.close')}><Icon name="close" /></button>
      {notice.progress !== undefined && (
        <progress value={notice.progress} max={1} aria-label={t('status.progress')} />
      )}
    </article>
  );
}

/** Move a stable portal host into Settings without restarting notice lifetimes. */
export default function StatusCenter({ container }: { container: HTMLElement | null }) {
  const { t } = useI18n();
  const notices = useSyncExternalStore(subscribeNotices, getNoticesSnapshot, getNoticesSnapshot);
  const [host] = useState(() => {
    const node = document.createElement('div'); node.className = 'status-center-host'; return node;
  });
  useLayoutEffect(() => {
    (container ?? document.body).append(host);
    return () => host.remove();
  }, [container, host]);
  return createPortal(
    <aside className="status-center" aria-label={t('status.messages')} aria-live="polite">
      {notices.map(notice => <StatusNotice key={`${notice.id}:${notice.updatedAt}`} notice={notice} />)}
    </aside>, host,
  );
}
