import { useEffect, useRef, useState } from 'react';
import type { SubagentRunSnapshot } from '@ai-harness/core';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { acknowledgeSubagentRun, listSubagentRuns, stopSubagentRun } from '../services/api';
import { useSessionStore } from '../store/session-store';

function terminal(status: SubagentRunSnapshot['status']): boolean {
  return ['completed', 'failed', 'stopped'].includes(status);
}

interface SubagentPanelProps { parentSessionId: string; parentLinkId?: string }

export function SubagentPanel(props: SubagentPanelProps) {
  const workspace = useSessionStore(state => state.workspace);
  const address = useLocation();
  return <ScopedSubagentPanel key={JSON.stringify([props.parentSessionId, props.parentLinkId,
    workspace?.id, workspace?.cwd, address.key, address.pathname, address.search, address.hash])} {...props} />;
}

function ScopedSubagentPanel(props: SubagentPanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const workspace = useSessionStore(state => state.workspace);
  const [runs, setRuns] = useState<SubagentRunSnapshot[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef<AbortController | undefined>(undefined);
  const revision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const started = revision.current;
      const result = await listSubagentRuns(props.parentSessionId, controller.signal);
      if (controller.signal.aborted) return;
      if (started !== revision.current) { timer = setTimeout(poll, 1_000); return; }
      if (result.success && result.data) {
        setRuns(result.data.filter(run => run.parentSessionId === props.parentSessionId));
        setError('');
      } else setError(t('subagents.statusUnavailable'));
      timer = setTimeout(poll, result.success && result.data?.some(run => !terminal(run.status)) ? 1_000 : 4_000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [props.parentSessionId, t]);

  const openPanel = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    const controller = owner.current;
    if (!controller || controller.signal.aborted) return;
    const started = ++revision.current;
    const attention = runs.filter(run => run.attention);
    const acknowledged = await Promise.all(attention.map(run => acknowledgeSubagentRun(run.id, controller.signal)));
    if (controller.signal.aborted || started !== revision.current) return;
    revision.current++;
    if (acknowledged.some(result => !result.success)) setError(t('subagents.statusUnavailable'));
    const replacements = new Map(acknowledged.flatMap(result => result.success && result.data
      ? [[result.data.id, result.data] as const]
      : []));
    setRuns(current => current.map(run => replacements.get(run.id) ?? run));
  };

  const attention = runs.filter(run => run.attention).length;
  const go = (sessionId: string) => navigate(`/chat/${encodeURIComponent(sessionId)}${workspace?.cwd ? `?cwd=${encodeURIComponent(workspace.cwd)}` : ''}`);

  return (
    <div className="subagent-switcher">
      {props.parentLinkId && (
        <button className="subagent-parent-link" onClick={() => go(props.parentLinkId!)}>{t('subagents.backToParent')}</button>
      )}
      <button className={`subagent-toggle ${attention ? 'attention' : ''}`} aria-expanded={open}
        aria-label={t('subagents.openPanel', { count: runs.length })} onClick={() => void openPanel()}>
        <span className="subagent-toggle-label">{t('subagents.panel')}</span>
        <span className="subagent-toggle-mobile" aria-hidden="true">A</span>
        <span className="subagent-toggle-count">{runs.length}</span>{attention > 0 && <b>{attention}</b>}
      </button>
      {open && (
        <aside className="subagent-panel" aria-label={t('subagents.panel')}>
          <header><strong>{t('subagents.panel')}</strong><button onClick={() => setOpen(false)} aria-label={t('common.close')}>×</button></header>
          {error && <p role="alert" className="status-warning">{error}</p>}
          {!runs.length && <p>{t('subagents.none')}</p>}
          <div className="subagent-run-list">
            {runs.map(run => (
              <article key={run.id} className={`subagent-run ${run.status} ${run.attention ? 'attention' : ''}`}>
                <header><strong>{run.profileName}</strong><span>{t(`subagents.status.${run.status}`)}</span></header>
                <p>{run.task}</p>
                <div className="subagent-progress">
                  <progress max={run.maxTurns} value={run.turn} />
                  <small>{t('subagents.turns', { turn: run.turn, max: run.maxTurns })} · {run.phase}</small>
                </div>
                {run.error && <p className="status-warning">{run.error}</p>}
                <footer>
                  <button onClick={() => go(run.childSessionId)}>{t('subagents.open')}</button>
                  {!terminal(run.status) && <button disabled={run.phase === 'stopping'} onClick={async () => {
                    const controller = owner.current;
                    if (!controller || controller.signal.aborted) return;
                    const started = ++revision.current;
                    const result = await stopSubagentRun(run.id, controller.signal);
                    if (controller.signal.aborted || started !== revision.current) return;
                    revision.current++;
                    if (result.success && result.data) setRuns(current => current.map(item => item.id !== run.id
                      || (terminal(item.status) && !terminal(result.data!.status)) ? item : result.data!));
                    else setError(t('subagents.stopError'));
                  }}>{t('subagents.stop')}</button>}
                </footer>
              </article>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
