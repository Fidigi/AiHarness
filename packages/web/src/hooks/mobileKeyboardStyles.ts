import stylesheetUrl from './mobile-keyboard.css?url&no-inline';

/** URL-only import: no eager CSS injection or inlined CSS in the entry bundle. */
export function loadMobileKeyboardStyles(document: Document, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Mobile keyboard styles cancelled')); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = stylesheetUrl;
    let ready = false;
    const cleanup = () => {
      clearTimeout(timeout);
      link.onload = null;
      link.onerror = null;
    };
    const abort = () => {
      cleanup();
      link.remove();
      signal.removeEventListener('abort', abort);
      if (!ready) reject(new Error('Mobile keyboard styles cancelled'));
    };
    const fail = () => {
      cleanup();
      link.remove();
      signal.removeEventListener('abort', abort);
      reject(new Error('Mobile keyboard styles unavailable'));
    };
    // A stalled request must not retain a pending compact-layout transition.
    const timeout = setTimeout(fail, 8_000);
    link.onload = () => { ready = true; cleanup(); resolve(); };
    link.onerror = fail;
    signal.addEventListener('abort', abort, { once: true });
    document.head.append(link);
    // A successful link stays owned by this mount until signal cancellation.
  });
}
