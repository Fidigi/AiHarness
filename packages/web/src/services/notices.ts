export type NoticeLevel = 'info' | 'success' | 'warning' | 'error';

export interface AppNotice {
  id: string;
  message: string;
  level: NoticeLevel;
  /** Values between zero and one render a determinate progress bar. */
  progress?: number;
  timeoutMs: number;
  updatedAt: number;
}

export interface PublishNoticeOptions {
  id?: string;
  level?: NoticeLevel;
  progress?: number;
  /** Set to zero to keep the notice until it is dismissed. */
  timeoutMs?: number;
}

let notices: AppNotice[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function defaultTimeout(level: NoticeLevel): number {
  if (level === 'error') return 10_000;
  if (level === 'warning') return 8_000;
  return 6_000;
}

/** Publish or update a bounded, route-independent status notice. */
export function publishNotice(message: string, options: PublishNoticeOptions = {}): string {
  const normalized = message.trim().slice(0, 10_000);
  if (!normalized) return '';
  const level = options.level ?? 'info';
  const id = options.id ?? crypto.randomUUID();
  const progress = options.progress === undefined
    ? undefined
    : Math.max(0, Math.min(1, options.progress));
  const notice: AppNotice = {
    id,
    message: normalized,
    level,
    ...(progress === undefined ? {} : { progress }),
    timeoutMs: Math.max(0, Math.min(60_000, options.timeoutMs ?? defaultTimeout(level))),
    updatedAt: Date.now(),
  };
  notices = [notice, ...notices.filter(item => item.id !== id)].slice(0, 20);
  emit();
  return id;
}

export function dismissNotice(id: string): void {
  const next = notices.filter(notice => notice.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

export function clearNotices(): void {
  if (!notices.length) return;
  notices = [];
  emit();
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNoticesSnapshot(): AppNotice[] {
  return notices;
}
