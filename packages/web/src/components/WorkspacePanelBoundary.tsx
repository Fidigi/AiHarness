import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { useI18n } from '../hooks/useI18n';
import { workspacePanelMessages } from './workspace-panel-messages';
import './workspace-panel-boundary.css';

type PanelProps = { isOpen?: boolean; onRequestClose?: () => void };
let load: Promise<ComponentType<PanelProps>> | undefined;
function loadPanel() {
  // Preserve failures too: Vite's preload bookkeeping alone is not proof that
  // a previously failed stylesheet loaded. A failure requires a page reload.
  return load ??= Promise.all([import('./WorkspacePanel'), import('../workspace-panel.css')])
    .then(([module]) => module.default);
}

export default function WorkspacePanelBoundary({ onRequestClose }: { onRequestClose: () => void }) {
  const { t, locale } = useI18n();
  const [Panel, setPanel] = useState<ComponentType<PanelProps>>();
  const [failed, setFailed] = useState(false);
  const pendingFile = useRef<string | { path: string; line?: number } | undefined>(undefined);
  const stopRemembering = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    // Existing callers show the pane, then emit an open-file intent on the next
    // timer. Retain only the latest bounded intent while the module is loading;
    // the real panel remains the sole owner of path parsing, trust and reads.
    const remember = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (typeof detail === 'string' && detail.length <= 4096) pendingFile.current = detail;
      else if (detail && typeof detail === 'object' && 'path' in detail
        && typeof detail.path === 'string' && detail.path.length <= 4096) {
        pendingFile.current = { path: detail.path,
          line: 'line' in detail && typeof detail.line === 'number' ? detail.line : undefined };
      }
    };
    window.addEventListener('aih-open-file', remember);
    const stop = () => { window.removeEventListener('aih-open-file', remember); };
    stopRemembering.current = stop;
    return stop;
  }, []);
  useEffect(() => {
    // Child effects have installed the real panel's listener before this effect.
    if (!Panel) return;
    // Keep the loading listener through commit until child passive effects have
    // registered the real listener. Removing it in layout cleanup leaves a gap.
    stopRemembering.current?.();
    if (pendingFile.current === undefined) return;
    const detail = pendingFile.current;
    pendingFile.current = undefined;
    // A newly mounted child has a development StrictMode effect replay too.
    // Wait one task for its final listener setup; retire the task on rekey/close.
    const supersede = () => { window.clearTimeout(timer); };
    const timer = window.setTimeout(() => {
      window.removeEventListener('aih-open-file', supersede);
      window.dispatchEvent(new CustomEvent('aih-open-file', { detail }));
    }, 0);
    // A newer live intent belongs to the registered child, never replay an older one.
    window.addEventListener('aih-open-file', supersede, { once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('aih-open-file', supersede);
    };
  }, [Panel]);
  useEffect(() => {
    let current = true;
    // No optimistic cached-success flag: both real imports must succeed. Vite
    // awaits the stylesheet fetch before resolving it, so mounting is styled.
    void loadPanel().then(component => {
      if (current) setPanel(() => component);
    }, () => { if (current) setFailed(true); });
    // Import fetches cannot be aborted, but a closed/rekeyed boundary no longer
    // owns their completion. File retrieval/trust/watch cleanup stay in Panel.
    return () => { current = false; };
  }, []);

  if (Panel) return <Panel isOpen onRequestClose={onRequestClose} />;
  const copy = workspacePanelMessages(locale);
  // This is deliberately non-modal: no Suspense of the app, focus trap, DOM
  // state mutation or prompt/Stop/palette replacement during a network wait.
  return <aside className="workspace-panel-loading" aria-label={t('files.explorer')} aria-busy={!failed}>
    <header><strong>{t('files.explorer')}</strong>
      <button type="button" onClick={onRequestClose} aria-label={t('common.close')}>×</button>
    </header>
    <p role={failed ? 'alert' : 'status'}>{failed ? copy.failed : copy.loading}</p>
    {failed && <>
      <p>{copy.reloadWarning}</p>
      <button type="button" onClick={() => window.location.reload()}>{copy.retry}</button>
    </>}
    <button type="button" onClick={onRequestClose}>{t('common.cancel')}</button>
  </aside>;
}
