import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  closeTerminal,
  createTerminal,
  listTerminals,
  resizeTerminal,
  streamTerminalEvents,
  writeTerminal,
  type TerminalSnapshot,
} from '../services/api';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';

interface StoredTerminalState {
  version: 1;
  open: boolean;
  activeId?: string;
  ids: string[];
}

function storageKey(workspaceId: string): string {
  return `ai-harness-terminals-v1:${workspaceId}`;
}

function readState(workspaceId: string): StoredTerminalState {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey(workspaceId)) || 'null') as Partial<StoredTerminalState> | null;
    if (parsed?.version === 1 && Array.isArray(parsed.ids)) {
      return {
        version: 1,
        open: parsed.open === true,
        activeId: typeof parsed.activeId === 'string' && parsed.activeId.length <= 200 ? parsed.activeId : undefined,
        ids: parsed.ids.filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, 12),
      };
    }
  } catch { /* Per-tab persistence is optional. */ }
  return { version: 1, open: false, ids: [] };
}

function writeState(workspaceId: string, state: StoredTerminalState): void {
  try { window.sessionStorage.setItem(storageKey(workspaceId), JSON.stringify(state)); } catch { /* Optional storage. */ }
}

function TerminalSurface({ snapshot, onSnapshot, onError }: {
  snapshot: TerminalSnapshot;
  onSnapshot: (snapshot: TerminalSnapshot) => void;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new XtermTerminal({
      cursorBlink: true,
      convertEol: false,
      allowTransparency: true,
      fontFamily: '"Noto Sans Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: {
        background: '#111827', foreground: '#e5e7eb', cursor: '#a4c2f4', selectionBackground: '#334155',
      },
    });
    terminal.open(container);
    terminal.focus();
    let disposed = false;
    let resizeTimer = 0;
    const controller = new AbortController();

    const sendSize = () => {
      const width = Math.max(20, Math.floor(container.clientWidth / 8.2));
      const height = Math.max(5, Math.floor(container.clientHeight / 17));
      const cols = Math.min(500, width);
      const rows = Math.min(200, height);
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        void resizeTerminal(snapshot.id, cols, rows).then(result => {
          if (result.success && result.data) onSnapshot(result.data);
        });
      }, 120);
    };
    const observer = new ResizeObserver(sendSize);
    observer.observe(container);
    sendSize();

    const input = terminal.onData(data => {
      void writeTerminal(snapshot.id, data).then(result => {
        if (!result.success) onError(result.error || 'Terminal input failed');
      });
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      if (event.code === 'KeyC' && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection());
        return false;
      }
      if (event.code === 'KeyV') {
        void navigator.clipboard?.readText().then(text => {
          if (text) void writeTerminal(snapshot.id, text);
        });
        return false;
      }
      return true;
    });

    void (async () => {
      while (!disposed && !controller.signal.aborted) {
        try {
          for await (const record of streamTerminalEvents(snapshot.id, offsetRef.current, controller.signal)) {
            if (record.type === 'connection.ready') {
              onSnapshot(record.snapshot);
              if (record.reset) {
                terminal.reset();
                terminal.writeln('\r\n\x1b[33m[Output replay was truncated]\x1b[0m');
                offsetRef.current = record.oldestOffset;
              }
            } else if (record.event.type === 'output') {
              terminal.write(record.event.data);
              offsetRef.current = Math.max(offsetRef.current, record.event.endOffset);
            } else {
              offsetRef.current = Math.max(offsetRef.current, record.event.endOffset);
              terminal.writeln(`\r\n\x1b[2m[process exited ${record.event.exitCode}]\x1b[0m`);
              onSnapshot({ ...snapshot, status: record.event.exitCode === 0 ? 'exited' : 'failed', exitCode: record.event.exitCode });
            }
          }
          if (!disposed && snapshot.status === 'running') await new Promise(resolve => setTimeout(resolve, 250));
          else break;
        } catch (error) {
          if (controller.signal.aborted) break;
          onError(error instanceof Error ? error.message : 'Terminal connection failed');
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      input.dispose();
      terminal.dispose();
    };
  }, [snapshot.id]); // Recreate only when switching PTY tabs.

  return <div className="terminal-surface" ref={containerRef} role="application" aria-label={snapshot.name} />;
}

export default function TerminalPanel({ initialOpen = false }: { initialOpen?: boolean }) {
  const workspace = useSessionStore(state => state.workspace);
  const { t } = useI18n();
  const initial = useMemo(() => workspace ? readState(workspace.id) : { version: 1 as const, open: false, ids: [] }, [workspace?.id]);
  const initialOpenRef = useRef(initialOpen);
  const createOnMountRef = useRef(initialOpen);
  const [open, setOpen] = useState(initialOpen || initial.open);
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(initial.activeId);
  const [error, setError] = useState('');
  const active = terminals.find(terminal => terminal.id === activeId) ?? terminals[0];

  useEffect(() => {
    if (!workspace) return;
    const stored = readState(workspace.id);
    setOpen(initialOpenRef.current || stored.open);
    initialOpenRef.current = false;
    setTerminals([]);
    setActiveId(stored.activeId);
    setError('');
    let current = true;
    void (async () => {
      const result = await listTerminals(workspace.cwd);
      if (!current) return;
      if (!result.success || !result.data) {
        setTerminals([]);
        setError(result.error || t('terminal.loadFailed'));
        return;
      }
      const byId = new Map(result.data.map(item => [item.id, item]));
      const restored = stored.ids.map(id => byId.get(id)).filter((item): item is TerminalSnapshot => Boolean(item));
      const remainingRunning = result.data.filter(item => item.status === 'running' && !stored.ids.includes(item.id));
      const next = [...restored, ...remainingRunning];
      if (next.length === 0 && createOnMountRef.current) {
        createOnMountRef.current = false;
        const created = await createTerminal({ cwd: workspace.cwd, name: `${t('terminal.title')} 1` });
        if (!current) return;
        if (created.success && created.data) next.push(created.data);
        else setError(created.error || t('terminal.createFailed'));
      }
      setTerminals(next);
      setActiveId(id => id && next.some(item => item.id === id) ? id : next[0]?.id);
    })();
    return () => { current = false; };
  }, [workspace?.cwd, workspace?.id, t]);

  useEffect(() => {
    const toggle = () => setOpen(value => !value);
    const show = () => setOpen(true);
    window.addEventListener('aih-toggle-terminal', toggle);
    window.addEventListener('aih-open-terminal', show);
    return () => {
      window.removeEventListener('aih-toggle-terminal', toggle);
      window.removeEventListener('aih-open-terminal', show);
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;
    writeState(workspace.id, { version: 1, open, activeId: active?.id, ids: terminals.map(item => item.id) });
  }, [active?.id, open, terminals, workspace]);

  const add = async () => {
    if (!workspace) return;
    setError('');
    const result = await createTerminal({ cwd: workspace.cwd, name: `${t('terminal.title')} ${terminals.length + 1}` });
    if (!result.success || !result.data) {
      setError(result.error || t('terminal.createFailed'));
      return;
    }
    setTerminals(items => [...items, result.data!]);
    setActiveId(result.data.id);
    setOpen(true);
  };

  const close = async (terminal: TerminalSnapshot) => {
    if (terminal.status === 'running' && !window.confirm(t('terminal.closeConfirmation', { name: terminal.name }))) return;
    const result = await closeTerminal(terminal.id);
    if (!result.success) {
      setError(result.error || t('terminal.closeFailed'));
      return;
    }
    setTerminals(items => items.filter(item => item.id !== terminal.id));
    setActiveId(id => id === terminal.id ? terminals.find(item => item.id !== terminal.id)?.id : id);
  };

  if (!workspace) return null;
  if (!open) {
    return <button className="terminal-launcher" onClick={() => {
      if (terminals.length) setOpen(true);
      else void add();
    }} aria-label={t('terminal.open')}>⌘</button>;
  }

  return (
    <section className="terminal-panel" aria-label={t('terminal.title')}>
      <header>
        <nav aria-label={t('terminal.tabs')}>
          {terminals.map(terminal => (
            <div className={terminal.id === active?.id ? 'active' : ''} key={terminal.id}>
              <button onClick={() => setActiveId(terminal.id)}>
                <span className={`terminal-status ${terminal.status}`} aria-hidden="true" />
                {terminal.name}
              </button>
              <button onClick={() => void close(terminal)} aria-label={t('terminal.close', { name: terminal.name })}>×</button>
            </div>
          ))}
          <button className="terminal-add" onClick={() => void add()} aria-label={t('terminal.new')}>+</button>
        </nav>
        <div>
          {active && <small>{active.shell} · {active.cols}×{active.rows}{active.exitCode === undefined ? '' : ` · exit ${active.exitCode}`}</small>}
          <button onClick={() => setOpen(false)} aria-label={t('terminal.hide')}>⌄</button>
        </div>
      </header>
      {error && <p className="terminal-error" role="alert">{error}</p>}
      {active ? <TerminalSurface key={active.id} snapshot={active}
        onSnapshot={next => setTerminals(items => items.map(item => item.id === next.id ? next : item))}
        onError={setError} />
        : <div className="terminal-empty"><p>{t('terminal.empty')}</p><button onClick={() => void add()}>{t('terminal.new')}</button></div>}
    </section>
  );
}
