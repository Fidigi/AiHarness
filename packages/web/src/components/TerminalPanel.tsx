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
import { TerminalStreamError } from '../services/terminal-replay';
import { terminalLifecycleMessages } from './terminal-lifecycle-messages';
import { useSessionStore } from '../store/session-store';
import { setTerminalTheme, TERMINAL_THEMES, useTerminalTheme } from '../store/terminal-theme';
import TerminalExtraKeys, { terminalControlMessages, useTerminalExtraKeysVisible } from './TerminalExtraKeys';
import { applyTerminalModifiers, NO_TERMINAL_MODIFIERS, terminalExtraKeySequence, type TerminalExtraKey,
  type TerminalModifier, type TerminalModifiers } from './terminal-extra-keys';

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
    const raw = window.sessionStorage.getItem(storageKey(workspaceId));
    if (raw && raw.length > 32_768) return { version: 1, open: false, ids: [] };
    const parsed = JSON.parse(raw || 'null') as Partial<StoredTerminalState> | null;
    if (parsed?.version === 1 && Array.isArray(parsed.ids)) {
      return {
        version: 1,
        open: parsed.open === true,
        activeId: typeof parsed.activeId === 'string' && parsed.activeId.length <= 200 ? parsed.activeId : undefined,
        ids: [...new Set(parsed.ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 12),
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
  const terminalRef = useRef<XtermTerminal | undefined>(undefined);
  const offsetRef = useRef(0);
  const runningRef = useRef(snapshot.status === 'running');
  runningRef.current = snapshot.status === 'running';
  const readyRef = useRef(false);
  const [inputEnabled, setInputEnabled] = useState(false);
  const [modifiers, setModifiers] = useState<Readonly<TerminalModifiers>>(NO_TERMINAL_MODIFIERS);
  const modifiersRef = useRef(modifiers);
  const theme = useTerminalTheme();
  const extraKeysVisible = useTerminalExtraKeysVisible();
  const { locale } = useI18n();
  const messages = useRef(terminalLifecycleMessages(locale));
  messages.current = terminalLifecycleMessages(locale);
  const resetModifiers = () => { modifiersRef.current = NO_TERMINAL_MODIFIERS; setModifiers(NO_TERMINAL_MODIFIERS); };
  const sender = useRef<(data: string) => void>(() => undefined);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = { ...TERMINAL_THEMES[theme] };
  }, [theme]);
  useEffect(() => {
    const enabled = readyRef.current && snapshot.status === 'running';
    setInputEnabled(enabled);
    if (terminalRef.current) terminalRef.current.options.disableStdin = !enabled;
    if (!enabled || !extraKeysVisible) resetModifiers();
  }, [snapshot.status, extraKeysVisible]);

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
      theme: { ...TERMINAL_THEMES[theme] },
      disableStdin: true,
    });
    terminalRef.current = terminal;
    terminal.open(container);
    terminal.focus();
    let disposed = false;
    let latestSnapshot = snapshot;
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
        if (disposed || !runningRef.current) return;
        void resizeTerminal(snapshot.id, cols, rows, controller.signal).then(result => {
          if (!disposed && runningRef.current && result.success && result.data?.status === 'running') {
            latestSnapshot = result.data; onSnapshot(result.data);
          }
        });
      }, 120);
    };
    const observer = new ResizeObserver(sendSize);
    observer.observe(container);
    sendSize();

    const mayWrite = () => !disposed && terminalRef.current === terminal && readyRef.current && runningRef.current;
    const availability = (ready: boolean) => {
      if (disposed) return;
      readyRef.current = ready;
      const enabled = ready && runningRef.current;
      terminal.options.disableStdin = !enabled;
      setInputEnabled(enabled);
      if (!enabled) resetModifiers();
    };
    const pending: string[] = [];
    let queuedBytes = 0, sending = false;
    const send = (data: string) => {
      if (!mayWrite() || !data) return;
      const size = new TextEncoder().encode(data).byteLength;
      if (size > 65_536 || queuedBytes + size > 262_144 || pending.length >= 64) {
        onError(messages.current.limit); return;
      }
      pending.push(data); queuedBytes += size;
      if (sending) return;
      sending = true;
      void (async () => {
        try {
          while (pending.length && mayWrite()) {
            const value = pending[0];
            const result = await writeTerminal(snapshot.id, value, controller.signal);
            if (disposed) return;
            if (!result.success) {
              // An uncertain write may already be durable in the PTY. Never
              // resend it or continue queued commands after that uncertainty.
              availability(false); controller.abort(); onError(messages.current.input); return;
            }
            pending.shift(); queuedBytes -= new TextEncoder().encode(value).byteLength;
          }
        } finally { pending.length = 0; queuedBytes = 0; sending = false; }
      })();
    };
    sender.current = send;
    const input = terminal.onData(data => {
      if (!mayWrite()) return;
      const owned = modifiersRef.current;
      resetModifiers();
      send(applyTerminalModifiers(data, owned));
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      if (event.code === 'KeyC' && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection());
        return false;
      }
      if (event.code === 'KeyV') {
        event.preventDefault();
        if (!mayWrite()) return false;
        const owned = modifiersRef.current;
        resetModifiers();
        void navigator.clipboard?.readText().then(text => {
          if (text && mayWrite()) terminal.paste(applyTerminalModifiers(text, owned));
        }).catch(() => { if (!disposed) onError('Terminal clipboard unavailable'); });
        return false;
      }
      return true;
    });

    let streamController: AbortController | undefined;
    const online = () => streamController?.abort();
    const offline = () => {
      if (!disposed && !controller.signal.aborted && runningRef.current) {
        availability(false); onError(messages.current.connection);
      }
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    void (async () => {
      while (!disposed && !controller.signal.aborted) {
        const connection = new AbortController();
        streamController = connection;
        const cancel = () => connection.abort();
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          for await (const record of streamTerminalEvents(snapshot.id, offsetRef.current, connection.signal)) {
            if (disposed || controller.signal.aborted || connection.signal.aborted) break;
            if (record.type === 'connection.ready') {
              if (!record.reset && (offsetRef.current < record.oldestOffset || offsetRef.current > record.lastOffset)) throw new TerminalStreamError();
              latestSnapshot = record.snapshot;
              runningRef.current = record.snapshot.status === 'running';
              availability(true); onError('');
              onSnapshot(record.snapshot);
              if (record.reset) {
                terminal.reset();
                terminal.writeln(`\r\n\x1b[33m[${messages.current.truncated}]\x1b[0m`);
                offsetRef.current = record.oldestOffset;
              }
            } else if (record.event.type === 'output') {
              if (record.event.endOffset <= offsetRef.current) continue;
              if (record.event.offset !== offsetRef.current) throw new TerminalStreamError();
              terminal.write(record.event.data);
              offsetRef.current = record.event.endOffset;
            } else {
              offsetRef.current = Math.max(offsetRef.current, record.event.endOffset);
              terminal.writeln(`\r\n\x1b[2m[process exited ${record.event.exitCode}]\x1b[0m`);
              availability(false);
              runningRef.current = false;
              onSnapshot({ ...latestSnapshot, lastOffset: offsetRef.current, status: record.event.exitCode === 0 ? 'exited' : 'failed',
                exitCode: record.event.exitCode, signal: record.event.signal });
            }
          }
          if (!disposed && runningRef.current) await new Promise(resolve => setTimeout(resolve, 250));
          else break;
        } catch (error) {
          if (controller.signal.aborted) break;
          if (connection.signal.aborted) continue;
          availability(false);
          if (error instanceof TerminalStreamError && [403, 404, 409].includes(error.status ?? 0)) {
            runningRef.current = false;
            onSnapshot({ ...latestSnapshot, status: 'failed' });
            onError(messages.current.expired); break;
          }
          onError(messages.current.connection);
          await new Promise(resolve => setTimeout(resolve, 1_000));
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          if (streamController === connection) streamController = undefined;
        }
      }
    })();

    return () => {
      disposed = true;
      pending.length = 0;
      readyRef.current = false;
      terminalRef.current = undefined;
      sender.current = () => undefined;
      controller.abort();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      input.dispose();
      terminal.dispose();
    };
  }, [snapshot.id]); // Recreate only when switching PTY tabs.

  const pressKey = (key: TerminalExtraKey) => {
    const terminal = terminalRef.current;
    if (!terminal || !readyRef.current || !runningRef.current) return;
    const owned = modifiersRef.current;
    resetModifiers();
    sender.current(terminalExtraKeySequence(key, owned, terminal.modes.applicationCursorKeysMode));
  };
  const toggleModifier = (key: TerminalModifier) => {
    if (!readyRef.current || !runningRef.current) return;
    modifiersRef.current = { ...modifiersRef.current, [key]: !modifiersRef.current[key] };
    setModifiers(modifiersRef.current);
  };
  return <>
    <div className="terminal-surface" data-terminal-theme={theme} ref={containerRef} role="application" aria-label={snapshot.name} />
    {extraKeysVisible && <TerminalExtraKeys disabled={!inputEnabled} modifiers={modifiers} locale={locale}
      onKey={pressKey} onModifier={toggleModifier} />}
  </>;
}

export default function TerminalPanel({ initialOpen = false }: { initialOpen?: boolean }) {
  const workspace = useSessionStore(state => state.workspace);
  const workspaceOperationTrusted = Boolean(workspace
    && (workspace.operationTrusted ?? workspace.trusted));
  const { t, locale } = useI18n();
  const terminalTheme = useTerminalTheme();
  const controlMessages = terminalControlMessages(locale);
  const initial = useMemo(() => workspace ? readState(workspace.id) : { version: 1 as const, open: false, ids: [] }, [workspace?.id]);
  const initialOpenRef = useRef(initialOpen);
  const createOnMountRef = useRef(initialOpen && !initial.open);
  const [open, setOpen] = useState(initialOpen || initial.open);
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(initial.activeId);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const scope = useRef<AbortController | undefined>(undefined);
  const hydrated = useRef(false);
  const active = terminals.find(terminal => terminal.id === activeId) ?? terminals[0];

  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    hydrated.current = false; setLoading(true); setCreating(false);
    if (!workspace || !workspaceOperationTrusted) {
      setLoading(false);
      setTerminals([]);
      setError('');
      return;
    }
    const stored = readState(workspace.id);
    setOpen(initialOpenRef.current || stored.open);
    setTerminals([]);
    setActiveId(stored.activeId);
    setError('');
    let current = true;
    void (async () => {
      const result = await listTerminals(workspace.cwd, controller.signal);
      if (!current) return;
      initialOpenRef.current = false;
      if (!result.success || !result.data) {
        setLoading(false);
        setTerminals([]);
        setError(result.error || t('terminal.loadFailed'));
        return;
      }
      const eligible = result.data.filter(item => item.cwd === workspace.cwd);
      const byId = new Map(eligible.map(item => [item.id, item]));
      const restored = stored.ids.map(id => byId.get(id)).filter((item): item is TerminalSnapshot => Boolean(item));
      const remainingRunning = eligible.filter(item => item.status === 'running' && !stored.ids.includes(item.id));
      const next = [...restored, ...remainingRunning];
      const shouldCreate = createOnMountRef.current;
      createOnMountRef.current = false;
      if (next.length === 0 && stored.ids.length > 0) setError(terminalLifecycleMessages(locale).expired);
      if (next.length === 0 && shouldCreate) {
        const created = await createTerminal({ cwd: workspace.cwd, name: `${t('terminal.title')} 1` }, controller.signal);
        if (!current) return;
        if (created.success && created.data) next.push(created.data);
        else setError(created.error || t('terminal.createFailed'));
      }
      hydrated.current = true; setLoading(false);
      setTerminals(next);
      setActiveId(id => id && next.some(item => item.id === id) ? id : next[0]?.id);
    })();
    return () => { current = false; controller.abort(); };
  }, [workspace?.cwd, workspace?.id, workspaceOperationTrusted, t]);

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
    if (!workspace || !workspaceOperationTrusted || !hydrated.current) return;
    writeState(workspace.id, { version: 1, open, activeId: active?.id, ids: terminals.map(item => item.id) });
  }, [active?.id, open, terminals, workspace, workspaceOperationTrusted]);

  const add = async () => {
    const controller = scope.current;
    if (!workspace || !workspaceOperationTrusted || loading || creating || !controller || controller.signal.aborted) return;
    setError(''); setCreating(true);
    const result = await createTerminal({ cwd: workspace.cwd, name: `${t('terminal.title')} ${terminals.length + 1}` }, controller.signal);
    if (controller !== scope.current || controller.signal.aborted) return;
    setCreating(false);
    if (!result.success || !result.data) {
      setError(result.error || t('terminal.createFailed'));
      return;
    }
    hydrated.current = true;
    setTerminals(items => [...items.filter(item => item.id !== result.data!.id), result.data!]);
    setActiveId(result.data.id);
    setOpen(true);
  };

  const close = async (terminal: TerminalSnapshot) => {
    if (terminal.status === 'running' && !window.confirm(t('terminal.closeConfirmation', { name: terminal.name }))) return;
    const controller = scope.current;
    if (!controller || controller.signal.aborted) return;
    const result = await closeTerminal(terminal.id, controller.signal);
    if (controller !== scope.current || controller.signal.aborted) return;
    if (!result.success) {
      setError(result.error || t('terminal.closeFailed'));
      return;
    }
    setTerminals(items => items.filter(item => item.id !== terminal.id));
    setActiveId(id => id === terminal.id ? terminals.find(item => item.id !== terminal.id)?.id : id);
  };

  if (!workspace || !workspaceOperationTrusted) return null;
  if (!open) {
    return <button className="terminal-launcher" disabled={loading || creating} onClick={() => {
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
          <button className="terminal-add" disabled={loading || creating} onClick={() => void add()} aria-label={t('terminal.new')}>+</button>
        </nav>
        <div>
          {active && <small>{active.shell} · {active.cols}×{active.rows}{active.exitCode === undefined ? '' : ` · exit ${active.exitCode}`}</small>}
          <select className="terminal-theme" aria-label={controlMessages.theme} value={terminalTheme}
            onChange={event => setTerminalTheme(event.target.value === 'light' ? 'light' : 'dark')}>
            <option value="dark">{controlMessages.dark}</option><option value="light">{controlMessages.light}</option>
          </select>
          <button onClick={() => setOpen(false)} aria-label={t('terminal.hide')}>⌄</button>
        </div>
      </header>
      {error && <p className="terminal-error" role="alert">{error}</p>}
      {active ? <TerminalSurface key={active.id} snapshot={active}
        onSnapshot={next => setTerminals(items => items.map(item => item.id !== next.id ? item
          : item.status !== 'running' && next.status === 'running' ? item : { ...next, lastOffset: Math.max(item.lastOffset, next.lastOffset) }))}
        onError={setError} />
        : <div className="terminal-empty"><p>{t('terminal.empty')}</p><button disabled={loading || creating} onClick={() => void add()}>{t('terminal.new')}</button></div>}
    </section>
  );
}
