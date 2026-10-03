import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitWorktree, WorkspaceDescriptor } from '@ai-harness/core';
import type { SessionSearchResult } from '../services/api';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  autoNameSession,
  browseWorkspace,
  createWorktree,
  deleteSession,
  listWorktrees,
  removeWorktree,
  searchSessions,
  setWorkspaceTrust,
  updateSession,
  validateWorkspace,
} from '../services/api';
import { useI18n } from '../hooks/useI18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useSessionStore } from '../store/session-store';
import LanguageSelector from './LanguageSelector';

interface SidebarProps {
  isOpen: boolean;
  modal?: boolean;
  inactive?: boolean;
  onRequestClose?: () => void;
}

function relativeDate(value: Date, locale: string): string {
  const seconds = Math.round((value.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function highlightExcerpt(result: SessionSearchResult, query: string) {
  const excerpt = result.excerpt || '';
  const start = result.matchStart ?? excerpt.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (start < 0) return excerpt;
  const length = result.matchLength ?? query.length;
  return <>{excerpt.slice(0, start)}<mark>{excerpt.slice(start, start + length)}</mark>{excerpt.slice(start + length)}</>;
}

function sessionIdFromPathname(pathname: string): string | undefined {
  const encoded = /^\/chat\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function Sidebar({ isOpen, modal = false, inactive = false, onRequestClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const sessions = useSessionStore(state => state.sessions);
  const workspace = useSessionStore(state => state.workspace);
  const recentWorkspaces = useSessionStore(state => state.recentWorkspaces);
  const runs = useSessionStore(state => state.runs);
  const providers = useSessionStore(state => state.providers);
  const createSession = useSessionStore(state => state.createSession);
  const hydrateSessions = useSessionStore(state => state.hydrateSessions);
  const setWorkspace = useSessionStore(state => state.setWorkspace);
  const removeSession = useSessionStore(state => state.removeSession);
  const renameLocal = useSessionStore(state => state.renameSession);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const { t, locale } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([]);
  const [parent, setParent] = useState<string>();
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<string>();
  const [renameValue, setRenameValue] = useState('');
  const [autoNaming, setAutoNaming] = useState<string>();
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [worktreeForm, setWorktreeForm] = useState({ path: '', branch: '', createBranch: true });
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceDescriptor>();
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const trustDialogRef = useRef<HTMLElement>(null);
  const pickerDialogRef = useRef<HTMLElement>(null);
  const browseSequence = useRef(0);
  const autoNameAbortRef = useRef<AbortController | undefined>(undefined);

  const query = useMemo(() => workspace ? `?cwd=${encodeURIComponent(workspace.cwd)}` : '', [workspace]);
  const selectedSessionId = sessionIdFromPathname(location.pathname) ?? activeSessionId;
  useFocusTrap(modal && !pendingWorkspace && !pickerOpen, sidebarRef, () => onRequestClose?.());
  useFocusTrap(Boolean(pendingWorkspace), trustDialogRef, () => setPendingWorkspace(undefined));
  useFocusTrap(pickerOpen, pickerDialogRef, () => setPickerOpen(false));

  useEffect(() => {
    autoNameAbortRef.current?.abort();
    autoNameAbortRef.current = undefined;
    setAutoNaming(undefined);
    return () => autoNameAbortRef.current?.abort();
  }, [workspace?.id]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearchResults([]);
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchSessions(search.trim(), workspace?.cwd, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setSearchResults(result.success && result.data ? result.data.results : []);
        setSearching(false);
      });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [search, workspace?.cwd]);

  useEffect(() => {
    if (!workspace?.git) {
      setWorktrees([]);
      return;
    }
    setWorktrees([]);
    const controller = new AbortController();
    void listWorktrees(workspace.cwd, controller.signal).then(result => {
      if (!controller.signal.aborted && result.success && result.data) setWorktrees(result.data);
    });
    return () => controller.abort();
  }, [workspace]);

  const handleCreate = () => {
    createSession();
    const id = useSessionStore.getState().activeSessionId;
    if (id) navigate(`/chat/${encodeURIComponent(id)}${query}`);
  };

  const openSession = (id: string) => navigate(`/chat/${encodeURIComponent(id)}${query}`);

  const browse = async (target?: string) => {
    const sequence = ++browseSequence.current;
    setError('');
    const result = await browseWorkspace(target || pathInput || workspace?.cwd);
    if (sequence !== browseSequence.current) return;
    if (!result.success || !result.data) {
      setError(result.error || t('workspace.invalid'));
      return;
    }
    setPathInput(result.data.cwd);
    setParent(result.data.parent);
    setDirectories(result.data.entries.filter(entry => entry.isDirectory).map(entry => ({
      name: entry.name,
      path: entry.path,
    })));
  };

  const activateWorkspace = async (selected: WorkspaceDescriptor) => {
    await setWorkspace(selected);
    setPickerOpen(false);
    setPendingWorkspace(undefined);
    navigate(`/?cwd=${encodeURIComponent(selected.cwd)}`);
  };

  const chooseWorkspace = async () => {
    setError('');
    const result = await validateWorkspace(pathInput);
    if (!result.success || !result.data) {
      setError(result.error || t('workspace.invalid'));
      return;
    }
    if (!result.data.trusted) {
      setPickerOpen(false);
      setPendingWorkspace(result.data);
      return;
    }
    await activateWorkspace(result.data);
  };

  const trustPendingWorkspace = async () => {
    if (!pendingWorkspace) return;
    setError('');
    const trust = await setWorkspaceTrust(pendingWorkspace.cwd, true);
    if (!trust.success) {
      setError(trust.error || t('workspace.trustFailed'));
      return;
    }
    await activateWorkspace({ ...pendingWorkspace, trusted: true });
  };

  const switchWorktree = async (cwd: string) => {
    const result = await validateWorkspace(cwd);
    if (!result.success || !result.data) {
      setError(result.error || t('workspace.invalid'));
      return;
    }
    await setWorkspace(result.data);
    navigate(`/?cwd=${encodeURIComponent(result.data.cwd)}`);
  };

  const addWorktree = async () => {
    if (!workspace) return;
    const result = await createWorktree({ cwd: workspace.cwd, ...worktreeForm });
    if (!result.success || !result.data) {
      setError(result.error || t('workspace.worktreeCreateFailed'));
      return;
    }
    const created = result.data;
    setWorktreeOpen(false);
    if (!created.trusted) {
      setPendingWorkspace(created);
      return;
    }
    await activateWorkspace(created);
  };

  const removeTree = async (tree: GitWorktree) => {
    if (!workspace || !window.confirm(t('workspace.worktreeDeleteConfirmation', { path: tree.path }))) return;
    const result = await removeWorktree(workspace.cwd, tree.path);
    if (!result.success) setError(result.error || t('workspace.worktreeDeleteFailed'));
    else setWorktrees(items => items.filter(item => item.path !== tree.path));
  };

  const commitRename = async (id: string) => {
    const title = renameValue.trim();
    if (!title) return;
    if (id.startsWith('draft:')) {
      renameLocal(id, title);
      setRenaming(undefined);
      return;
    }
    const result = await updateSession(id, { title });
    if (result.success) {
      renameLocal(id, title);
      setRenaming(undefined);
    } else setError(result.error || t('session.renameFailed'));
  };

  const generateTitle = async (id: string) => {
    if (autoNaming) return;
    setError('');
    setAutoNaming(id);
    autoNameAbortRef.current?.abort();
    const controller = new AbortController();
    autoNameAbortRef.current = controller;
    const active = providers.active;
    const result = await autoNameSession(id, active, providers.available[active]?.model, controller.signal);
    if (controller.signal.aborted) return;
    if (result.success && result.data?.title) renameLocal(id, result.data.title);
    else setError(result.error || t('session.autoNameFailed'));
    if (autoNameAbortRef.current === controller) {
      autoNameAbortRef.current = undefined;
      setAutoNaming(undefined);
    }
  };

  const remove = async (id: string, title: string) => {
    if (!window.confirm(t('session.deleteConfirmation', { title }))) return;
    let cascade = false;
    let descendantIds: string[] = [];
    if (!id.startsWith('draft:')) {
      let result = await deleteSession(id);
      if (!result.success && result.data?.requiresCascade) {
        descendantIds = result.data.descendants?.map(descendant => descendant.id) ?? [];
        if (!window.confirm(t('session.deleteBranchesConfirmation', { title, count: descendantIds.length }))) return;
        cascade = true;
        result = await deleteSession(id, true);
      }
      if (!result.success) {
        setError(result.error || t('session.deleteFailed'));
        return;
      }
    }
    const activeDeleted = activeSessionId === id || descendantIds.includes(activeSessionId ?? '');
    removeSession(id);
    descendantIds.forEach(removeSession);
    if (cascade) await hydrateSessions();
    if (activeDeleted || location.pathname.includes(encodeURIComponent(id)) || location.pathname.includes(id)) navigate(`/${query}`);
  };

  return (
    <aside ref={sidebarRef} className={`sidebar ${isOpen ? 'open' : ''}`} aria-label={t('sidebar.label')}
      {...(modal ? { role: 'dialog', 'aria-modal': true, tabIndex: -1 } : {})}
      aria-hidden={inactive || undefined} inert={inactive || undefined}>
      <div className="sidebar-header">
        <h1>AiHarness</h1>
        <div className="sidebar-actions">
          <LanguageSelector />
          <button onClick={handleCreate} title={t('sidebar.newChat')} aria-label={t('sidebar.newChat')}>+</button>
        </div>
      </div>

      <section className="workspace-selector">
        <span className="workspace-label">{t('workspace.label')}</span>
        <button className="workspace-button" onClick={() => {
          setPathInput(workspace?.cwd ?? '');
          setPickerOpen(true);
          void browse(workspace?.cwd);
        }} title={workspace?.cwd}>
          <span>{workspace?.name ?? t('workspace.loading')}</span>
          <small>{workspace?.git?.branch ?? workspace?.cwd ?? ''}</small>
        </button>
        {workspace && !workspace.trusted && (
          <button className="trust-warning" onClick={() => {
            setError('');
            setPendingWorkspace(workspace);
          }}>
            ⚠ {t('workspace.untrusted')}
          </button>
        )}
        {workspace?.git && (
          <div className="worktree-switcher">
            <select value={workspace.cwd} aria-label={t('workspace.worktree')}
              onChange={event => void switchWorktree(event.target.value)}>
              {worktrees.length === 0 && <option value={workspace.cwd}>{workspace.git.branch || t('workspace.detached')}</option>}
              {worktrees.map(tree => <option key={tree.path} value={tree.path}>{tree.branch || t('workspace.detached')}</option>)}
            </select>
            <button onClick={() => setWorktreeOpen(value => !value)} aria-label={t('workspace.worktreeAdd')}>+</button>
          </div>
        )}
        {worktreeOpen && workspace?.git && (
          <div className="worktree-form">
            <input value={worktreeForm.path} placeholder={t('workspace.worktreePath')}
              onChange={event => setWorktreeForm(form => ({ ...form, path: event.target.value }))} />
            <input value={worktreeForm.branch} placeholder={t('workspace.worktreeBranch')}
              onChange={event => setWorktreeForm(form => ({ ...form, branch: event.target.value }))} />
            <label><input type="checkbox" checked={worktreeForm.createBranch}
              onChange={event => setWorktreeForm(form => ({ ...form, createBranch: event.target.checked }))} /> {t('workspace.worktreeNewBranch')}</label>
            <button onClick={() => void addWorktree()}>{t('workspace.worktreeCreate')}</button>
            {worktrees.filter(tree => tree.path !== workspace.cwd).map(tree => (
              <button className="danger" key={tree.path} onClick={() => void removeTree(tree)}>× {tree.branch || tree.path}</button>
            ))}
          </div>
        )}
      </section>

      {error && <div className="sidebar-error" role="alert">{error}</div>}

      <div className="session-search">
        <input type="search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder={t('session.search')} aria-label={t('session.search')} />
        {searching && <span aria-label={t('common.loading')}>…</span>}
        <button onClick={() => void hydrateSessions()} aria-label={t('files.refresh')}>↻</button>
      </div>
      {search.trim().length >= 2 && (
        <div className="search-results" aria-live="polite">
          <small>{t('session.searchCount', { count: searchResults.length })}</small>
          <ul>
            {searchResults.map((result, index) => (
              <li key={`${result.sessionId}:${result.messageId ?? 'title'}:${index}`}>
                <button onClick={() => navigate(`/chat/${encodeURIComponent(result.sessionId)}${query}${result.messageId ? `#${encodeURIComponent(result.messageId)}` : ''}`)}>
                  <strong>{result.title || t('sidebar.untitled')}</strong>
                  <span>{highlightExcerpt(result, search.trim())}</span>
                  <small>
                    {result.cwd}
                    <span aria-hidden="true"> · </span>
                    <time dateTime={result.updatedAt}>{relativeDate(new Date(result.updatedAt), locale)}</time>
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <nav className="sidebar-nav" aria-label={t('sidebar.sessions')}>
        <ul>
          {sessions.map(session => {
            const run = runs[session.id];
            const active = session.id === selectedSessionId;
            return (
              <li key={session.id} className={active ? 'active' : ''}>
                {renaming === session.id ? (
                  <form className="session-rename" onSubmit={event => {
                    event.preventDefault();
                    void commitRename(session.id);
                  }}>
                    <input
                      autoFocus
                      value={renameValue}
                      aria-label={t('session.rename')}
                      onChange={event => setRenameValue(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Escape') setRenaming(undefined); }}
                    />
                    <button type="submit" aria-label={t('common.save')}>✓</button>
                  </form>
                ) : (
                  <div className="session-row">
                    <button className="session-main" onClick={() => openSession(session.id)}>
                      <span className="session-title">
                        {run && !['completed', 'failed', 'stopped'].includes(run.phase) && <span aria-label={t('session.running')}>●</span>}
                        {session.attention && <span aria-label={t('session.attention')}>!</span>}
                        {session.unread && <span className="session-unread" aria-label={t('session.unread')}>●</span>}
                        {session.title || t('sidebar.untitled')}
                      </span>
                      <small>{session.messagePage?.total ?? session.messages.length} · {relativeDate(session.updatedAt, locale)}</small>
                    </button>
                    <div className="session-actions">
                      <button onClick={() => {
                        setRenaming(session.id);
                        setRenameValue(session.title || '');
                      }} aria-label={t('session.rename')}>✎</button>
                      {!session.draft && <button disabled={Boolean(autoNaming)} onClick={() => void generateTitle(session.id)}
                        aria-label={t('session.autoName')}>{autoNaming === session.id ? '…' : 'AI'}</button>}
                      <button onClick={() => void remove(session.id, session.title || t('sidebar.untitled'))}
                        aria-label={t('session.delete')}>×</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <button onClick={() => navigate(`/settings${query}`)}>⚙ {t('common.settings')}</button>
      </div>

      {pendingWorkspace && (
        <div className="modal-backdrop" role="presentation">
          <section ref={trustDialogRef} className="trust-dialog" role="alertdialog" aria-modal="true" tabIndex={-1}
            aria-labelledby="workspace-trust-title" aria-describedby="workspace-trust-description">
            <header><h2 id="workspace-trust-title">{t('workspace.trustTitle')}</h2></header>
            <p id="workspace-trust-description">
              {t('workspace.trustConfirmation', { path: pendingWorkspace.cwd })}
            </p>
            <code>{pendingWorkspace.cwd}</code>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button onClick={() => void activateWorkspace(pendingWorkspace)}>{t('workspace.trustWithout')}</button>
              <button className="primary" data-autofocus onClick={() => void trustPendingWorkspace()}>
                {t('workspace.trustAction')}
              </button>
            </footer>
          </section>
        </div>
      )}

      {pickerOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setPickerOpen(false);
        }}>
          <section ref={pickerDialogRef} className="directory-picker" role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby="workspace-picker-title">
            <header>
              <h2 id="workspace-picker-title">{t('workspace.choose')}</h2>
              <button onClick={() => setPickerOpen(false)} aria-label={t('common.close')}>×</button>
            </header>
            <form onSubmit={event => { event.preventDefault(); void browse(); }}>
              <input data-autofocus value={pathInput} onChange={event => setPathInput(event.target.value)}
                aria-label={t('workspace.path')} placeholder="~/project" list="recent-workspaces" />
              <datalist id="recent-workspaces">
                {recentWorkspaces.map(item => <option key={item.id} value={item.cwd}>{item.name}</option>)}
              </datalist>
              <button type="submit">{t('workspace.browse')}</button>
            </form>
            {recentWorkspaces.length > 0 && (
              <div className="recent-workspaces" aria-label={t('workspace.recent')}>
                {recentWorkspaces.map(item => (
                  <button key={item.id} onClick={() => void browse(item.cwd)}>{item.name}<small>{item.cwd}</small></button>
                ))}
              </div>
            )}
            {parent && <button className="directory-parent" onClick={() => void browse(parent)}>↑ {t('workspace.parent')}</button>}
            <ul className="directory-list">
              {directories.map(directory => (
                <li key={directory.path}>
                  <button onClick={() => void browse(directory.path)}>📁 {directory.name}</button>
                </li>
              ))}
            </ul>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button onClick={() => setPickerOpen(false)}>{t('common.cancel')}</button>
              <button className="primary" onClick={() => void chooseWorkspace()}>{t('workspace.use')}</button>
            </footer>
          </section>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;
