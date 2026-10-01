// ============================================================
// Web App - Main Component
// ============================================================

import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import WorkspacePanel from './components/WorkspacePanel';
import LoginView from './components/LoginView';
import PwaStatus from './components/PwaStatus';
import CommandPalette from './components/CommandPalette';
import StatusCenter from './components/StatusCenter';
import { SubagentMonitor } from './components/SubagentMonitor';
import { useI18n } from './hooks/useI18n';
import { getAgentRun, getWebAuthStatus, listRunningAgentRuns } from './services/api';
import { useSessionStore } from './store/session-store';
import { readPreferences, usePreferences } from './store/preferences';
import { matchesShortcut } from './services/keyboard';

const SettingsView = lazy(() => import('./components/SettingsView'));
const TerminalPanel = lazy(() => import('./components/TerminalPanel'));

function App() {
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia?.('(max-width: 959px)').matches ?? false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(() => readPreferences().sidebarVisible);
  const [filesOpen, setFilesOpen] = useState(() => !window.matchMedia?.('(max-width: 959px)').matches && readPreferences().filesOpen);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalWorkspaceId, setTerminalWorkspaceId] = useState<string>();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const hydrateWorkspace = useSessionStore(state => state.hydrateWorkspace);
  const hydrateSessions = useSessionStore(state => state.hydrateSessions);
  const hydrateProviders = useSessionStore(state => state.hydrateProviders);
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const hydrateSkillCatalog = useSessionStore(state => state.hydrateSkillCatalog);
  const createSession = useSessionStore(state => state.createSession);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const workspace = useSessionStore(state => state.workspace);
  const setRun = useSessionStore(state => state.setRun);
  const { t } = useI18n();
  const [preferences, setPreferences] = usePreferences();

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 959px)');
    const update = () => {
      const narrow = media?.matches ?? false;
      setIsNarrow(narrow);
      setFilesOpen(narrow ? false : readPreferences().filesOpen);
      if (!narrow) setSidebarOpen(false);
    };
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const check = async () => {
      const result = await getWebAuthStatus();
      // Keep the offline shell usable when the status endpoint itself is unreachable.
      setAuthenticated(result.success ? Boolean(result.data?.authenticated) : true);
    };
    const requireLogin = () => setAuthenticated(false);
    window.addEventListener('aih-auth-required', requireLogin);
    void check();
    return () => window.removeEventListener('aih-auth-required', requireLogin);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void (async () => {
      const requestedCwd = new URLSearchParams(window.location.search).get('cwd') || undefined;
      await hydrateWorkspace(requestedCwd);
      await Promise.all([hydrateSessions(), hydrateProviders(), hydrateModelCatalog(), hydrateSkillCatalog()]);
    })();
  }, [authenticated, hydrateWorkspace, hydrateSessions, hydrateProviders, hydrateModelCatalog, hydrateSkillCatalog]);

  useEffect(() => {
    document.title = t('app.documentTitle');
  }, [t]);

  useEffect(() => {
    if (!workspace || !activeSessionId || location.pathname !== '/') return;
    navigate(`/chat/${encodeURIComponent(activeSessionId)}?cwd=${encodeURIComponent(workspace.cwd)}`, { replace: true });
  }, [activeSessionId, location.pathname, navigate, workspace]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    let request: AbortController | undefined;
    const refreshRuns = async () => {
      request?.abort();
      request = new AbortController();
      const signal = request.signal;
      const result = await listRunningAgentRuns(signal);
      if (disposed || signal.aborted || !result.success || !result.data) return;
      const running = result.data.filter(run => run.workspaceId ? run.workspaceId === workspace.id : run.cwd === workspace.cwd);
      const runningIds = new Set(running.map(run => run.id));
      for (const run of running) setRun(run.sessionId, run);
      const stale = Object.values(useSessionStore.getState().runs).filter(run => (
        (run.workspaceId ? run.workspaceId === workspace.id : run.cwd === workspace.cwd)
        && !['completed', 'failed', 'stopped'].includes(run.phase)
        && !runningIds.has(run.id)
      ));
      await Promise.all(stale.map(async run => {
        const terminal = await getAgentRun(run.id, signal);
        if (!disposed && !signal.aborted && terminal.success && terminal.data) setRun(run.sessionId, terminal.data);
      }));
    };
    const onVisibility = () => { if (!document.hidden) void refreshRuns(); };
    void refreshRuns();
    const timer = window.setInterval(() => void refreshRuns(), 2_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [setRun, workspace?.cwd, workspace?.id]);

  useEffect(() => {
    const requestTerminal = () => {
      if (workspace) setTerminalWorkspaceId(workspace.id);
    };
    window.addEventListener('aih-toggle-terminal', requestTerminal);
    window.addEventListener('aih-open-terminal', requestTerminal);
    if (workspace) {
      try {
        const stored = JSON.parse(sessionStorage.getItem(`ai-harness-terminals-v1:${workspace.id}`) || 'null') as {
          version?: number; open?: boolean; ids?: unknown;
        } | null;
        setTerminalWorkspaceId(stored?.version === 1 && stored.open === true && Array.isArray(stored.ids)
          ? workspace.id : undefined);
      } catch { setTerminalWorkspaceId(undefined); }
    } else setTerminalWorkspaceId(undefined);
    return () => {
      window.removeEventListener('aih-toggle-terminal', requestTerminal);
      window.removeEventListener('aih-open-terminal', requestTerminal);
    };
  }, [location.pathname, workspace?.id]);

  useEffect(() => {
    const toggleFiles = () => {
      setFilesOpen(!filesOpen);
      setPreferences({ filesOpen: !filesOpen });
    };
    const shortcuts = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-shortcut-capture]')) return;
      const binding = preferences.keybindings;
      let handled = true;
      if (matchesShortcut(event, binding.newSession)) {
        createSession();
        const id = useSessionStore.getState().activeSessionId;
        if (id) navigate(`/chat/${encodeURIComponent(id)}?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`);
      } else if (matchesShortcut(event, binding.focusPrompt)) {
        window.dispatchEvent(new CustomEvent('aih-focus-prompt'));
      } else if (matchesShortcut(event, binding.toggleSidebar)) {
        if (isNarrow) setSidebarOpen(value => !value);
        else {
          setSidebarVisible(!sidebarVisible);
          setPreferences({ sidebarVisible: !sidebarVisible });
        }
      }
      else if (matchesShortcut(event, binding.toggleFiles)) toggleFiles();
      else if (matchesShortcut(event, binding.toggleTerminal)) window.dispatchEvent(new CustomEvent('aih-toggle-terminal'));
      else if (matchesShortcut(event, binding.openSettings)) navigate('/settings');
      else if (matchesShortcut(event, binding.commandPalette)) setPaletteOpen(value => !value);
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', shortcuts, { capture: true });
    const showFiles = () => setFilesOpen(true);
    window.addEventListener('aih-files-toggle', toggleFiles);
    window.addEventListener('aih-show-files', showFiles);
    return () => {
      window.removeEventListener('keydown', shortcuts, { capture: true });
      window.removeEventListener('aih-files-toggle', toggleFiles);
      window.removeEventListener('aih-show-files', showFiles);
    };
  }, [createSession, filesOpen, isNarrow, navigate, preferences.keybindings, setPreferences, sidebarVisible, workspace?.cwd]);

  useEffect(() => {
    setSidebarOpen(false);
    setPaletteOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const closeOverlays = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || paletteOpen) return;
      if (sidebarOpen) setSidebarOpen(false);
      else if (filesOpen && window.matchMedia?.('(max-width: 959px)').matches) setFilesOpen(false);
    };
    window.addEventListener('keydown', closeOverlays);
    return () => window.removeEventListener('keydown', closeOverlays);
  }, [filesOpen, paletteOpen, sidebarOpen]);

  if (authenticated === null) return <div className="app-loading" role="status">{t('common.loading')}…</div>;
  if (!authenticated) return <LoginView onLogin={() => setAuthenticated(true)} />;

  return (
    <div className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
      <button className="mobile-menu" onClick={() => setSidebarOpen(open => !open)}
        aria-expanded={sidebarOpen} aria-label={t('sidebar.toggle')}><span className="menu-icon" aria-hidden="true" /></button>
      {!location.pathname.startsWith('/settings') && <button className="mobile-files" onClick={() => {
        setFilesOpen(!filesOpen);
        setPreferences({ filesOpen: !filesOpen });
      }}
        aria-expanded={filesOpen} aria-label={t('files.explorer')}>☷</button>}
      {sidebarOpen && <button className="mobile-backdrop" aria-label={t('common.close')} onClick={() => setSidebarOpen(false)} />}
      {(isNarrow || sidebarVisible) && <Sidebar isOpen={sidebarOpen} modal={isNarrow && sidebarOpen}
        inactive={isNarrow && !sidebarOpen} onRequestClose={() => setSidebarOpen(false)} />}
      <main className="main-content">
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/chat/:id" element={<ChatView />} />
          <Route path="/settings" element={<Suspense fallback={
            <div className="app-loading" role="status">{t('common.loading')}…</div>
          }><SettingsView /></Suspense>} />
        </Routes>
      </main>
      {!location.pathname.startsWith('/settings') && filesOpen && <WorkspacePanel isOpen={filesOpen} onRequestClose={() => {
        setFilesOpen(false);
        setPreferences({ filesOpen: false });
      }} />}
      {!location.pathname.startsWith('/settings') && terminalWorkspaceId !== workspace?.id && workspace
        && <button className="terminal-launcher" onClick={() => setTerminalWorkspaceId(workspace.id)}
          aria-label={t('terminal.open')}>⌘</button>}
      {!location.pathname.startsWith('/settings') && workspace && terminalWorkspaceId === workspace.id
        && <Suspense fallback={null}><TerminalPanel key={workspace.id} initialOpen /></Suspense>}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <SubagentMonitor />
      <StatusCenter />
      <PwaStatus />
    </div>
  );
}

export default App;
