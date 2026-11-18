import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinkedDirectoryEntry, LinkedDirectoryInventory, LinkedDirectoryListing, LinkedDirectorySelector } from '@ai-harness/core';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../hooks/useI18n';
import { browseLinkedDirectory, LinkedDirectoriesApiError, listLinkedDirectories, readLinkedDirectoryFile, setLinkedDirectoryConsent } from '../services/linked-directories';
import { linkedDirectoryFailure, linkedDirectoryLiteral, linkedDirectoryMessages } from './linked-directory-messages';
import './linked-directory-modal.css';

export default function LinkedDirectoryModal({ cwd, initialDirectory = '.', onClose }: { cwd: string; initialDirectory?: string; onClose: () => void }) {
  const { locale } = useI18n(); const m = linkedDirectoryMessages(locale);
  const dialog = useRef<HTMLElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const [inventory, setInventory] = useState<LinkedDirectoryInventory>();
  const [directory, setDirectory] = useState(initialDirectory);
  const [directoryInput, setDirectoryInput] = useState(initialDirectory);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const focusEpoch = useRef(0);
  const [pendingFocus, setPendingFocus] = useState<{ target: string; epoch: number }>();
  useEffect(() => {
    const focused = () => { focusEpoch.current++; };
    document.addEventListener('focusin', focused);
    return () => document.removeEventListener('focusin', focused);
  }, []);
  useEffect(() => {
    const preserveComposition = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (event.isComposing || event.keyCode === 229)
        && event.target instanceof Node && dialog.current?.contains(event.target)) {
        // Run before document-capture traps, including an enclosing mobile Sidebar.
        // Do not prevent the IME's native default behavior.
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', preserveComposition, true);
    return () => window.removeEventListener('keydown', preserveComposition, true);
  }, []);
  const [review, setReview] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [browsing, setBrowsing] = useState<LinkedDirectorySelector>();
  const [listing, setListing] = useState<LinkedDirectoryListing>();
  const [content, setContent] = useState<{ path: string; content: string }>();
  useFocusTrap(true, dialog, onClose);
  useEffect(() => {
    if (!pendingFocus || busy || loading) return;
    setPendingFocus(undefined);
    if (pendingFocus.epoch !== focusEpoch.current) return;
    const target = pendingFocus.target === 'dialog' ? dialog.current
      : dialog.current?.querySelector<HTMLButtonElement>(`[data-link-id="${pendingFocus.target}"] button:not(:disabled)`);
    target?.focus({ preventScroll: pendingFocus.target === 'dialog' });
  }, [pendingFocus, busy, loading, inventory]);
  const failure = (error: unknown) => linkedDirectoryFailure(locale, error instanceof LinkedDirectoriesApiError ? error.code : 'failure');
  const start = () => { controller.current?.abort(); const next = new AbortController(); controller.current = next; return next; };
  const load = async (keepError = false, focusAtStart = focusEpoch.current) => {
    const next = start(); setLoading(true); setBusy(false); setInventory(undefined);
    setReview(undefined); setConfirmed(false); setBrowsing(undefined); setListing(undefined); setContent(undefined);
    if (!keepError) setError('');
    try { const result = await listLinkedDirectories(cwd, directory, next.signal); if (!next.signal.aborted) setInventory(result); }
    catch (error) { if (!next.signal.aborted) setError(failure(error)); }
    finally {
      if (!next.signal.aborted) {
        setLoading(false);
        if (keepError) setPendingFocus({ target: 'dialog', epoch: focusAtStart });
      }
    }
  };
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [cwd, directory]);
  const selector = (entry: LinkedDirectoryEntry): LinkedDirectorySelector => ({ cwd: inventory!.cwd, directory: inventory!.directory, id: entry.id, revision: inventory!.revision });
  const consent = async (entry: LinkedDirectoryEntry, allowed: boolean) => {
    if (!inventory || busy || (allowed && !confirmed)) return;
    const focusAtStart = focusEpoch.current;
    const next = start(); setBusy(true); setError('');
    try {
      const result = await setLinkedDirectoryConsent(selector(entry), allowed, next.signal);
      if (!next.signal.aborted) {
        setInventory(result); setReview(undefined); setConfirmed(false);
        setPendingFocus({ target: entry.id, epoch: focusAtStart });
      }
    } catch (error) {
      if (!next.signal.aborted) { setError(failure(error)); await load(true, focusAtStart); }
    } finally { if (!next.signal.aborted) setBusy(false); }
  };
  const browse = async (selection: LinkedDirectorySelector, path: string, file = false) => {
    const focusAtStart = focusEpoch.current;
    const next = start(); setBusy(true); setError(''); setContent(undefined);
    try {
      if (file) {
        const result = await readLinkedDirectoryFile({ ...selection, path }, next.signal);
        if (!next.signal.aborted) setContent(result);
      } else {
        const result = await browseLinkedDirectory({ ...selection, path }, next.signal);
        if (!next.signal.aborted) { setBrowsing(selection); setListing(result); }
      }
    } catch (error) {
      if (!next.signal.aborted) { setError(failure(error)); await load(true, focusAtStart); }
    } finally { if (!next.signal.aborted) setBusy(false); }
  };
  return createPortal(<div className="modal-backdrop linked-directory-backdrop">
    <section ref={dialog} className="linked-directory-dialog" role="dialog" aria-modal="true" tabIndex={-1}
      aria-labelledby="linked-directory-title" aria-describedby="linked-directory-risk">
      <header><h2 id="linked-directory-title">{m.title}</h2><button data-autofocus onClick={onClose} aria-label={m.close}>×</button></header>
      <p id="linked-directory-risk">{m.risk}</p>
      <p className="linked-directory-restriction">{m.restriction}</p>
      <code className="linked-directory-source" dir="ltr">{linkedDirectoryLiteral(cwd)}</code>
      {!browsing && <form className="linked-directory-location" onSubmit={event => {
        event.preventDefault(); if (!busy) { setDirectory(directoryInput); if (directory === directoryInput) void load(); }
      }}>
        <label>{locale.startsWith('fr') ? 'Dossier source relatif' : 'Relative source folder'}
          <input value={directoryInput} maxLength={4096} disabled={busy || loading} onChange={event => setDirectoryInput(event.target.value)} /></label>
        <button disabled={busy || loading}>{m.retry}</button>
      </form>}
      {error && <p role="alert" className="linked-directory-error">{error}</p>}
      {(loading || busy) && <p role="status">{m.loading}</p>}
      {!loading && !inventory && <button disabled={busy} onClick={() => void load()}>{m.retry}</button>}
      {!loading && inventory && !browsing && <>
        {!inventory.entries.length && <p>{m.empty}</p>}
        <ul className="linked-directory-entries">{inventory.entries.map(entry => <li key={entry.id} data-link-id={entry.id}>
          <h3 dir="ltr">{linkedDirectoryLiteral(entry.name)}</h3>
          <p>{entry.allowed ? m.allowed : m.blocked} · {m[entry.reason]}</p>
          <dl><dt>{m.raw}</dt><dd><code dir="ltr">{entry.rawTarget === undefined ? '—' : linkedDirectoryLiteral(entry.rawTarget)}</code></dd>
            <dt>{m.canonical}</dt><dd><code dir="ltr">{entry.canonicalTarget === undefined ? '—' : linkedDirectoryLiteral(entry.canonicalTarget)}</code></dd></dl>
          {entry.hiddenCharacters && <p className="linked-directory-warning">{m.warning}</p>}
          <div className="linked-directory-actions">
            {entry.allowed ? <>
              <button disabled={busy} onClick={() => void browse(selector(entry), '.')}>{m.browse}</button>
              <button disabled={busy} onClick={() => void consent(entry, false)}>{m.revoke}</button>
            </> : entry.reason === 'directory' && <button disabled={busy} onClick={() => { setReview(entry.id); setConfirmed(false); }}>{m.review}</button>}
          </div>
          {review === entry.id && <div className="linked-directory-confirmation">
            <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{m.confirm}</label>
            <div className="linked-directory-actions"><button disabled={busy} onClick={() => {
              setReview(undefined);
              setPendingFocus({ target: entry.id, epoch: focusEpoch.current });
            }}>{m.cancel}</button>
              <button disabled={busy || !confirmed} onClick={() => void consent(entry, true)}>{m.allow}</button></div>
          </div>}
        </li>)}</ul>
        {inventory.truncated && <p role="status">{m.truncated}</p>}
      </>}
      {browsing && listing && <div className="linked-directory-browser">
        <div className="linked-directory-actions"><button disabled={busy} onClick={() => { setBrowsing(undefined); setListing(undefined); setContent(undefined); void load(); }}>{m.back}</button>
          {listing.path !== '.' && <button disabled={busy} onClick={() => void browse(browsing, listing.path.includes('/') ? listing.path.slice(0, listing.path.lastIndexOf('/')) : '.')}>{m.parent}</button>}
        </div>
        <h3>{listing.path === '.' ? m.root : linkedDirectoryLiteral(listing.path)}</h3>
        <ul>{listing.entries.map(entry => <li key={entry.path}>
          <button disabled={entry.blocked || busy} onClick={() => void browse(browsing, entry.path, !entry.isDirectory)}>{entry.isDirectory ? '📁' : '📄'} {linkedDirectoryLiteral(entry.name)}</button>
          {entry.blocked && <p>{m.nested}</p>}
        </li>)}</ul>
        {!listing.entries.length && <p>{locale.startsWith('fr') ? 'Répertoire vide.' : 'Empty directory.'}</p>}
        {listing.truncated && <p role="status">{m.truncated}</p>}
        {content && <section aria-label={m.file}><h3>{linkedDirectoryLiteral(content.path)}</h3><pre dir="ltr">{content.content}</pre></section>}
      </div>}
    </section>
  </div>, document.body);
}
