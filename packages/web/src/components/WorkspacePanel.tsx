import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { FileUploadProgress, WorkspaceFileContent, WorkspaceFileEntry, GitStatusFile } from '../services/api';
import {
  getFileContent,
  getFileDiff,
  getGitStatus,
  listFiles,
  searchFiles,
  streamFileChanges,
  uploadFiles,
} from '../services/api';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';
import MarkdownContent from './MarkdownContent';

type Tab = 'files' | 'changes';
type ViewerTab = 'source' | 'preview' | 'diff';

function quoteMention(path: string): string {
  return path.includes(' ') ? `@"${path}"` : `@${path}`;
}

function FileNode({ entry, cwd, depth, onOpen, onMention, showHidden }: {
  entry: WorkspaceFileEntry;
  cwd: string;
  depth: number;
  onOpen: (path: string) => void;
  onMention: (path: string) => void;
  showHidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<WorkspaceFileEntry[]>();
  const [error, setError] = useState('');

  if (entry.hidden && !showHidden) return null;
  const activate = async () => {
    if (!entry.isDirectory) {
      onOpen(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && !children) {
      const result = await listFiles(cwd, entry.path);
      if (result.success && result.data) setChildren(result.data.entries);
      else setError(result.error || 'Error');
    }
  };
  return (
    <li className="file-node">
      <div style={{ paddingLeft: `${depth * .8}rem` }}>
        <button className="file-name" onClick={() => void activate()} title={entry.path}>
          {entry.isDirectory ? open ? '📂' : '📁' : '📄'} {entry.name}
          {entry.gitStatus && <span className={`git-badge ${entry.gitStatus}`} title={entry.gitStatus}>{gitBadge(entry.gitStatus)}</span>}
        </button>
        {!entry.isDirectory && <button className="file-mention" onClick={() => onMention(entry.path)} aria-label={`Mention ${entry.path}`}>@</button>}
      </div>
      {error && <small role="alert">{error}</small>}
      {open && children && <ul>{children.map(child => (
        <FileNode key={child.path} entry={child} cwd={cwd} depth={depth + 1}
          onOpen={onOpen} onMention={onMention} showHidden={showHidden} />
      ))}</ul>}
    </li>
  );
}

function WorkspacePanel({ isOpen = true, onRequestClose }: { isOpen?: boolean; onRequestClose?: () => void }) {
  const workspace = useSessionStore(state => state.workspace);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const draft = useSessionStore(state => activeSessionId ? state.drafts[activeSessionId] ?? '' : '');
  const setDraft = useSessionStore(state => state.setDraft);
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<Tab>('files');
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [changes, setChanges] = useState<GitStatusFile[]>([]);
  const [gitSummary, setGitSummary] = useState({ repository: true, additions: 0, deletions: 0 });
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<WorkspaceFileContent>();
  const [viewerTab, setViewerTab] = useState<ViewerTab>('source');
  const [diff, setDiff] = useState('');
  const [diffBinary, setDiffBinary] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<string[]>([]);
  const [viewerWidth, setViewerWidth] = useState(520);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [targetLine, setTargetLine] = useState<number>();
  const [uploadProgress, setUploadProgress] = useState<FileUploadProgress>();
  const [collision, setCollision] = useState<'reject' | 'rename' | 'overwrite'>('reject');
  const uploadAbortRef = useRef<AbortController | undefined>(undefined);
  const openFileAbortRef = useRef<AbortController | undefined>(undefined);
  const refreshAbortRef = useRef<AbortController | undefined>(undefined);

  const refresh = async () => {
    if (!workspace?.trusted) return;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setError('');
    const [tree, status] = await Promise.all([
      listFiles(workspace.cwd, '.', controller.signal),
      getGitStatus(workspace.cwd, controller.signal),
    ]);
    if (controller.signal.aborted || refreshAbortRef.current !== controller) return;
    refreshAbortRef.current = undefined;
    if (tree.success && tree.data) setEntries(tree.data.entries);
    else setError(tree.error || t('files.loadFailed'));
    if (status.success && status.data) {
      setChanges(status.data.files);
      setGitSummary(status.data);
    }
  };

  useEffect(() => {
    uploadAbortRef.current?.abort();
    openFileAbortRef.current?.abort();
    refreshAbortRef.current?.abort();
    setUploadProgress(undefined);
    setSelected(undefined);
    setEntries([]);
    setChanges([]);
    setGitSummary({ repository: false, additions: 0, deletions: 0 });
    setDiff('');
    setDiffBinary(false);
    setSearchResult([]);
    setError('');
    void refresh();
    return () => {
      uploadAbortRef.current?.abort();
      openFileAbortRef.current?.abort();
      refreshAbortRef.current?.abort();
    };
  }, [workspace?.cwd, workspace?.trusted]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!workspace || query.trim().length < 1) {
      setSearchResult([]);
      return;
    }
    setSearchResult([]);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchFiles(workspace.cwd, query.trim(), controller.signal).then(result => {
        if (!controller.signal.aborted && result.success && result.data) setSearchResult(result.data.files.slice(0, 100));
      });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, workspace]);

  const uploadSelectedFiles = async (files: File[]) => {
    if (!workspace || !files.length) return;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setError('');
    const result = await uploadFiles(workspace.cwd, '.', files, {
      collision,
      signal: controller.signal,
      onProgress: setUploadProgress,
    });
    if (uploadAbortRef.current === controller) uploadAbortRef.current = undefined;
    if (result.success) await refresh();
    else if (!controller.signal.aborted) setError(result.error || t('files.uploadFailed'));
    window.setTimeout(() => {
      if (!uploadAbortRef.current) setUploadProgress(undefined);
    }, 1_200);
  };

  const openFile = async (rawPath: string, targetTab: ViewerTab = 'source', requestedLine?: number) => {
    if (!workspace) return;
    setError('');
    const match = rawPath.match(/^(.*?)(?:#L(\d+))?$/i);
    const filePath = match?.[1] || rawPath;
    const line = requestedLine ?? (match?.[2] ? Number(match[2]) : undefined);
    openFileAbortRef.current?.abort();
    const controller = new AbortController();
    openFileAbortRef.current = controller;
    setTargetLine(line);
    setViewerTab(targetTab);
    const [content, diffResult] = await Promise.all([
      getFileContent(workspace.cwd, filePath, controller.signal),
      targetTab === 'diff' ? getFileDiff(workspace.cwd, filePath, controller.signal) : Promise.resolve(undefined),
    ]);
    if (controller.signal.aborted || openFileAbortRef.current !== controller) return;
    openFileAbortRef.current = undefined;
    if (diffResult) {
      setDiff(diffResult.success && diffResult.data ? diffResult.data.diff : diffResult.error || '');
      setDiffBinary(Boolean(diffResult.success && diffResult.data?.binary));
    }
    if (content.data && (content.success || content.data.tooLarge)) {
      setSelected(content.data);
    } else if (targetTab === 'diff' && diffResult?.success) {
      // Deleted and oversized files can still have a useful Git diff even when source content is unavailable.
      setSelected({
        path: filePath,
        name: filePath.split('/').pop() || filePath,
        size: 0,
        modifiedAt: '',
        language: 'text',
        binary: Boolean(diffResult.data?.binary),
      });
    } else {
      setError(content.error || t('files.openFailed'));
    }
  };

  useEffect(() => {
    const openLinkedFile = (event: Event) => {
      const detail = (event as CustomEvent).detail as unknown;
      if (typeof detail === 'string') void openFile(detail.replace(/^\/+/, ''));
      else if (detail && typeof detail === 'object' && 'path' in detail && typeof detail.path === 'string') {
        void openFile(detail.path.replace(/^\/+/, ''), 'source', 'line' in detail && typeof detail.line === 'number' ? detail.line : undefined);
      }
    };
    window.addEventListener('aih-open-file', openLinkedFile);
    return () => window.removeEventListener('aih-open-file', openLinkedFile);
  }, [workspace?.cwd]); // The handler always targets the active workspace.

  useEffect(() => {
    if (!selected || !workspace?.trusted) return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        for await (const event of streamFileChanges(workspace.cwd, selected.path, controller.signal)) {
          if (!current || event.type === 'connection.ready') continue;
          if (event.type === 'file.unavailable') {
            setError(t('files.watchUnavailable'));
            break;
          }
          const [content, nextDiff] = await Promise.all([
            getFileContent(workspace.cwd, selected.path, controller.signal),
            getFileDiff(workspace.cwd, selected.path, controller.signal),
          ]);
          if (!current) return;
          if (content.success && content.data) setSelected(content.data);
          else setError(content.error || t('files.openFailed'));
          if (nextDiff.success && nextDiff.data) {
            setDiff(nextDiff.data.diff);
            setDiffBinary(nextDiff.data.binary);
          }
          await refresh();
        }
      } catch (watchError) {
        if (!controller.signal.aborted) setError(watchError instanceof Error ? watchError.message : t('files.watchUnavailable'));
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [selected?.path, workspace?.cwd, workspace?.trusted]); // Watch follows only the currently opened file.

  useEffect(() => {
    if (!selected || !targetLine) return;
    window.setTimeout(() => document.getElementById(`source-line-${targetLine}`)?.scrollIntoView({ block: 'center' }), 0);
  }, [selected, targetLine, viewerTab]);

  const mention = (filePath: string) => {
    if (!activeSessionId) return;
    const separator = draft && !draft.endsWith(' ') ? ' ' : '';
    setDraft(activeSessionId, `${draft}${separator}${quoteMention(filePath)} `);
  };

  const changedGroups = useMemo(() => {
    const groups = new Map<string, GitStatusFile[]>();
    for (const change of changes) {
      const separator = change.path.lastIndexOf('/');
      const group = separator < 0 ? '.' : change.path.slice(0, separator);
      groups.set(group, [...(groups.get(group) ?? []), change]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [changes]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (pointer: PointerEvent) => setViewerWidth(Math.max(300, Math.min(1200, window.innerWidth - pointer.clientX)));
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  const downloadUrl = useMemo(() => workspace && selected
    ? `/api/files/download?cwd=${encodeURIComponent(workspace.cwd)}&path=${encodeURIComponent(selected.path)}`
    : '', [selected, workspace]);

  if (!workspace) return null;
  if (collapsed) return <aside className="workspace-panel collapsed"><button onClick={() => setCollapsed(false)} aria-label={t('files.expand')}>‹</button></aside>;

  return (
    <aside className={`workspace-panel ${isOpen ? 'panel-open' : ''} ${selected ? 'viewer-open' : ''} ${viewerExpanded ? 'viewer-expanded' : ''}`}
      style={selected ? { flexBasis: `${viewerWidth}px`, width: `${viewerWidth}px` } : undefined}
      aria-label={t('files.explorer')}>
      {selected && <div className="panel-resizer" role="separator" aria-orientation="vertical"
        aria-label={t('files.resize')} onPointerDown={beginResize} />}
      <header>
        <div className="panel-tabs">
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>{t('files.files')}</button>
          <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
            {t('files.changes')} {changes.length ? `(${changes.length})` : ''}
          </button>
        </div>
        <div className="panel-header-actions">
          {onRequestClose && <button className="workspace-panel-close" onClick={onRequestClose} aria-label={t('common.close')}>×</button>}
          <button onClick={() => window.dispatchEvent(new Event('aih-open-terminal'))} aria-label={t('terminal.openFromFiles')}>⌘</button>
          <button onClick={() => setCollapsed(true)} aria-label={t('files.collapse')}>›</button>
        </div>
      </header>

      {!workspace.trusted ? <p className="panel-empty">{t('files.trustRequired')}</p> : (
        <>
          <div className="file-toolbar">
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('files.search')} />
            <button onClick={() => void refresh()} aria-label={t('files.refresh')}>↻</button>
            <label title={t('files.upload')} aria-disabled={Boolean(uploadProgress && uploadProgress.phase !== 'complete')}>↑<input
              type="file" multiple disabled={Boolean(uploadProgress && uploadProgress.phase !== 'complete')} onChange={event => {
                const files = [...(event.target.files ?? [])];
                if (files.length) void uploadSelectedFiles(files);
                event.target.value = '';
              }} /></label>
          </div>
          <div className="upload-options">
            <label>{t('files.collision')}
              <select value={collision} disabled={Boolean(uploadProgress && uploadProgress.phase !== 'complete')}
                onChange={event => setCollision(event.target.value as typeof collision)}>
                <option value="reject">{t('files.collision.reject')}</option>
                <option value="rename">{t('files.collision.rename')}</option>
                <option value="overwrite">{t('files.collision.overwrite')}</option>
              </select>
            </label>
            {uploadProgress && <div className="upload-progress" role="status" aria-live="polite">
              <progress max={Math.max(1, uploadProgress.totalBytes)} value={uploadProgress.loadedBytes}
                aria-label={t('files.uploadProgress')} />
              <span>{t(`files.upload.${uploadProgress.phase}`, {
                percent: Math.min(100, Math.round(uploadProgress.loadedBytes / Math.max(1, uploadProgress.totalBytes) * 100)),
                completed: uploadProgress.completedFiles,
                total: uploadProgress.totalFiles,
              })}</span>
              {uploadProgress.phase !== 'complete' && <button onClick={() => uploadAbortRef.current?.abort()}>{t('common.cancel')}</button>}
            </div>}
          </div>
          <label className="hidden-toggle"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} /> {t('files.hidden')}</label>
          {error && <p className="panel-error" role="alert">{error}</p>}
          <div className="file-tree">
            {query ? (
              <ul>{searchResult.map(file => <li key={file}><button onClick={() => void openFile(file)}>📄 {file}</button><button onClick={() => mention(file)}>@</button></li>)}</ul>
            ) : tab === 'files' ? (
              entries.length ? <ul>{entries.map(entry => <FileNode key={entry.path} entry={entry} cwd={workspace.cwd}
                depth={0} onOpen={openFile} onMention={mention} showHidden={showHidden} />)}</ul>
                : <p className="panel-empty">{t('files.empty')}</p>
            ) : gitSummary.repository ? (
              <>
                <div className="git-summary"><span>+{gitSummary.additions}</span><span>−{gitSummary.deletions}</span></div>
                {changedGroups.map(([group, files]) => <section className="change-group" key={group}>
                  <h3>{group}</h3>
                  <ul>{files.map(change => <li key={change.path} className="change-row">
                    <button onClick={() => void openFile(change.path, 'diff')}>
                      <b>{gitBadge(change.status)}</b>
                      <span>{change.path.slice(group === '.' ? 0 : group.length + 1)}</span>
                      {(change.additions !== undefined || change.deletions !== undefined) && (
                        <small><i>+{change.additions ?? 0}</i> <em>−{change.deletions ?? 0}</em></small>
                      )}
                    </button>
                    <button onClick={() => mention(change.path)}>@</button>
                  </li>)}</ul>
                </section>)}
              </>
            ) : <p className="panel-empty">{t('files.notRepository')}</p>}
          </div>
        </>
      )}

      {selected && (
        <section className="file-viewer">
          <header>
            <strong title={selected.path}>{selected.name}</strong>
            <div>
              <button onClick={() => setViewerExpanded(value => !value)} aria-pressed={viewerExpanded}
                aria-label={viewerExpanded ? t('files.restore') : t('files.maximize')}>{viewerExpanded ? '↙' : '↗'}</button>
              <button onClick={() => setSelected(undefined)} aria-label={t('common.close')}>×</button>
            </div>
          </header>
          <div className="viewer-meta">{selected.language} · {selected.lineCount ?? '—'} {t('files.lines')} · {formatBytes(selected.size)}</div>
          <nav>
            <button className={viewerTab === 'source' ? 'active' : ''} onClick={() => setViewerTab('source')}>{t('files.source')}</button>
            <button className={viewerTab === 'preview' ? 'active' : ''} onClick={() => setViewerTab('preview')}>{t('files.preview')}</button>
            <button className={viewerTab === 'diff' ? 'active' : ''} onClick={() => void openFile(selected.path, 'diff')}>{t('files.diff')}</button>
          </nav>
          <div className="viewer-content">
            {viewerTab === 'diff' ? diffBinary ? <p className="panel-empty">{t('files.binaryDiff')}</p> : <DiffView diff={diff} />
              : selected.tooLarge ? <p className="panel-empty">{t('files.tooLarge')}</p>
                : viewerTab === 'preview' ? <FilePreview file={selected} downloadUrl={downloadUrl} />
                  : selected.binary ? <p className="panel-empty">{t('files.binary')}</p>
                    : <SourceView content={selected.content ?? ''} language={selected.language} targetLine={targetLine} />}
          </div>
          <footer>
            <button onClick={() => mention(selected.path)}>@ {t('files.mention')}</button>
            <button onClick={() => void navigator.clipboard?.writeText(selected.content ?? '')}>{t('chat.copy')}</button>
            <a href={downloadUrl} download>{t('files.download')}</a>
          </footer>
        </section>
      )}
    </aside>
  );
}

function SourceView({ content, language, targetLine }: { content: string; language: string; targetLine?: number }) {
  return <pre className={`source-view language-${language}`}>{content.split('\n').map((line, index) => {
    const lineNumber = index + 1;
    return <span id={`source-line-${lineNumber}`} className={targetLine === lineNumber ? 'target-line' : ''} key={lineNumber}>
      <i>{lineNumber}</i><code>{highlightSourceLine(line, language)}</code>
    </span>;
  })}</pre>;
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <p className="panel-empty">No changes</p>;
  return <pre className="diff-view">{diff.split('\n').map((line, index) => (
    <span className={line.startsWith('+') && !line.startsWith('+++') ? 'added'
      : line.startsWith('-') && !line.startsWith('---') ? 'removed'
        : line.startsWith('@@') ? 'hunk' : ''} key={index}>{line}{'\n'}</span>
  ))}</pre>;
}

function FilePreview({ file, downloadUrl }: { file: WorkspaceFileContent; downloadUrl: string }) {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file.path)) return <img src={downloadUrl} alt={file.name} />;
  if (/\.(mp3|wav|ogg|m4a)$/i.test(file.path)) return <audio src={downloadUrl} controls />;
  if (/\.(mp4|webm|mov)$/i.test(file.path)) return <video src={downloadUrl} controls />;
  if (file.binary) return <p>Binary preview unavailable</p>;
  if (/\.(md|mdx|markdown)$/i.test(file.path)) {
    const source = file.content ?? '';
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n?/);
    return <article className="markdown-preview">
      {frontmatter && <details className="frontmatter-card"><summary>Frontmatter</summary><pre>{frontmatter[1]}</pre></details>}
      <MarkdownContent content={frontmatter ? source.slice(frontmatter[0].length) : source} />
    </article>;
  }
  return <div className="text-preview">{(file.content ?? '').split('\n').map((line, index) => <p key={index}>{line || <br />}</p>)}</div>;
}

function gitBadge(status: string): string {
  return ({ modified: 'M', added: 'A', deleted: 'D', conflict: '!', untracked: 'U', renamed: 'R', changed: '•' } as Record<string, string>)[status] ?? status.slice(0, 1).toUpperCase();
}

function highlightSourceLine(line: string, language: string): ReactNode {
  if (!line) return ' ';
  const codeLanguages = new Set(['typescript', 'javascript', 'python', 'ruby', 'rust', 'go', 'java', 'shell', 'json', 'css']);
  if (!codeLanguages.has(language)) return line;
  const pattern = /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|class|interface|type|import|export|from|return|if|else|for|while|async|await|def|fn|struct|impl|package|public|private|true|false|null|None)\b|\b\d+(?:\.\d+)?\b)/g;
  return line.split(pattern).filter(Boolean).map((token, index) => {
    const className = /^(?:\/\/|#)/.test(token) ? 'syntax-comment'
      : /^(?:"|'|`)/.test(token) ? 'syntax-string'
        : /^\d/.test(token) ? 'syntax-number' : 'syntax-keyword';
    return <Fragment key={index}><span className={className}>{token}</span></Fragment>;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export default WorkspacePanel;
