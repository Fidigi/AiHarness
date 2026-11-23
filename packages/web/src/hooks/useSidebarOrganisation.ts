import { useCallback, useEffect, useRef, useState } from 'react';
import type { SidebarChange, SidebarState } from '@ai-harness/core';
import { sidebarRequest } from '../services/sidebar-state.js';

export function useSidebarOrganisation(enabled: boolean) {
  const [state, setState] = useState<SidebarState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'error' | 'conflict'>();
  const [undoToken, setUndoToken] = useState<string>();
  const sequence = useRef(0), pending = useRef<object | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined), revision = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!enabled || pending.current || !lifetime.current) return;
    const id = ++sequence.current, signal = lifetime.current.signal;
    const result = await sidebarRequest(undefined, signal);
    if (signal.aborted || id !== sequence.current) return;
    if (result.success && result.data) {
      if (revision.current && revision.current !== result.data.state.revision) setUndoToken(undefined);
      revision.current = result.data.state.revision;
      setState(result.data.state); setError(undefined);
    } else setError('error');
  }, [enabled]);
  useEffect(() => {
    setBusy(false);
    if (!enabled) return;
    lifetime.current = new AbortController();
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => {
      lifetime.current?.abort(); sequence.current++; pending.current = undefined;
      window.clearInterval(timer); window.removeEventListener('focus', focus);
    };
  }, [enabled, refresh]);
  const mutate = async (change?: SidebarChange) => {
    if (!enabled || !state || pending.current || !lifetime.current) return;
    const signal = lifetime.current.signal, id = ++sequence.current, operation = {};
    pending.current = operation; setBusy(true); setError(undefined);
    const result = await sidebarRequest({ revision: state.revision, ...(change ? { change } : { undoToken }) }, signal);
    if (signal.aborted || id !== sequence.current) return;
    if (result.success && result.data) {
      revision.current = result.data.state.revision;
      setState(result.data.state); setUndoToken(result.data.undoToken);
    } else {
      setUndoToken(undefined);
      // Keep the mutation slot through readback; never replay an uncertain write.
      const canonical = await sidebarRequest(undefined, signal);
      if (signal.aborted || id !== sequence.current) return;
      if (canonical.success && canonical.data) {
        revision.current = canonical.data.state.revision;
        setState(canonical.data.state);
      }
      setError(canonical.success && ['sidebar-state-conflict', 'sidebar-state-busy', 'sidebar-undo-expired'].includes(result.code ?? '') ? 'conflict' : 'error');
    }
    if (pending.current === operation) { pending.current = undefined; setBusy(false); }
  };
  return { state, busy, error, undoToken, refresh, mutate };
}
