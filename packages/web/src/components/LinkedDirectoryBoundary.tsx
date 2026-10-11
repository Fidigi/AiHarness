import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import { linkedDirectoryMessages } from './linked-directory-messages';
import { linkedDirectoryBoundaryMessages } from './linked-directory-boundary-messages';
import type LinkedDirectoryModal from './LinkedDirectoryModal';

type Modal = typeof LinkedDirectoryModal;
// Native ESM/preload rejection may be cached. Reopening is not a network retry.
let moduleLoad: Promise<Modal> | undefined;
// Sidebar and pane may both be reachable during the nonmodal wait. Latest
// explicit activation owns the single real modal; never mount duplicate traps.
let currentOwner: { close: () => void } | undefined;
function loadModal() {
  return moduleLoad ??= import('./LinkedDirectoryModal').then(module => module.default);
}

/** Local nonmodal wait: no suspension, focus trap, consent or API before ready. */
export default function LinkedDirectoryBoundary({ cwd, initialDirectory, onClose }: {
  cwd: string; initialDirectory?: string; onClose: () => void;
}) {
  const { locale } = useI18n();
  const m = linkedDirectoryMessages(locale);
  const copy = linkedDirectoryBoundaryMessages(locale);
  const [Modal, setModal] = useState<Modal>();
  const [failed, setFailed] = useState(false);
  const invoker = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const boundaryRef = useRef<HTMLElement>(null);
  const closeLoading = () => {
    const active = document.activeElement;
    // A nonmodal wait does not own newer focus in the composer or another surface.
    if ((active === invoker.current || active === document.body || boundaryRef.current?.contains(active))
      && invoker.current?.isConnected && invoker.current.getClientRects().length) invoker.current.focus();
    onClose();
  };
  useEffect(() => {
    let current = true;
    const owner = { close: onClose };
    const previous = currentOwner;
    currentOwner = owner;
    previous?.close();
    void loadModal().then(
      component => {
        if (!current || currentOwner !== owner) return;
        const active = document.activeElement;
        if (!invoker.current?.isConnected || (active !== document.body && active !== invoker.current
          && !boundaryRef.current?.contains(active))) {
          // Retire the old presentation intent, without opening metadata or a trap.
          onClose();
          return;
        }
        setModal(() => component);
      },
      () => { if (current && currentOwner === owner) setFailed(true); },
    );
    return () => {
      current = false;
      if (currentOwner === owner) currentOwner = undefined;
    };
  }, []);
  useEffect(() => {
    if (Modal) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        event.stopPropagation();
        closeLoading();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [Modal, onClose]);
  if (Modal) return <Modal cwd={cwd} initialDirectory={initialDirectory} onClose={onClose} />;
  // Do not focus/restore during the handoff. The real modal owns its only trap.
  return <section ref={boundaryRef} className="linked-directory-boundary" aria-label={m.title}>
    <p role={failed ? 'alert' : 'status'}>{failed ? copy.failed : copy.loading}</p>
    {failed && <>
      <p>{copy.unsent}</p>
      <button type="button" onClick={() => window.location.reload()}>{copy.reload}</button>
    </>}
    <button type="button" onClick={closeLoading}>{m.close}</button>
  </section>;
}
