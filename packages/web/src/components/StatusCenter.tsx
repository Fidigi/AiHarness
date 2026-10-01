import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../hooks/useI18n';
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
      <button type="button" onClick={() => dismissNotice(notice.id)} aria-label={t('common.close')}>×</button>
      {notice.progress !== undefined && (
        <progress value={notice.progress} max={1} aria-label={t('status.progress')} />
      )}
    </article>
  );
}

/** Global status region kept outside routed views so notices survive navigation. */
export default function StatusCenter() {
  const { t } = useI18n();
  const notices = useSyncExternalStore(subscribeNotices, getNoticesSnapshot, getNoticesSnapshot);
  return (
    <aside className="status-center" aria-label={t('status.messages')} aria-live="polite">
      {notices.map(notice => <StatusNotice key={`${notice.id}:${notice.updatedAt}`} notice={notice} />)}
    </aside>
  );
}
