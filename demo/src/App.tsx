import { useEffect, useRef, useState } from 'react';
import MarkdownContent from '../../packages/web/src/components/MarkdownContent';
import { composerKeySubmits } from '../../packages/web/src/components/composer-submit';
import { useFocusTrap } from '../../packages/web/src/hooks/useFocusTrap';
import { initialFiles, models, tools } from './fixtures';
import { freshState, gitDiff, MAX_PROMPT, MAX_SESSIONS, previewEdit, simulatedTurn, terminalReply } from './state';

const tabs = ['Chat', 'Files', 'Git', 'Terminal', 'Models', 'Tools'] as const;
type Tab = typeof tabs[number];
function readRoute(): { tab: Tab; sessionId: string } {
  const [, rawTab, sessionId] = location.hash.split('/');
  const tab = tabs.find(value => value.toLowerCase() === rawTab) ?? 'Chat';
  return { tab, sessionId: /^[a-z0-9-]{1,60}$/.test(sessionId ?? '') ? sessionId! : 'workspace-review' };
}

export default function App() {
  const [state, setState] = useState(freshState);
  const [route, setRoute] = useState(readRoute);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [draft, setDraft] = useState('');
  const [enabled, setEnabled] = useState(tools.map(tool => tool.name));
  const [selectedFile, setSelectedFile] = useState('src/GardenCard.tsx');
  const [command, setCommand] = useState('');
  const [terminal, setTerminal] = useState(['Synthetic terminal · no host shell. Type help for commands.']);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Explore the synthetic workspace. Changes stay in this tab; reload resets them.');
  const [offlineReady, setOfflineReady] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const resetDialog = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const draftRevision = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const session = state.sessions.find(value => value.id === route.sessionId) ?? state.sessions[0]!;
  const changed = state.files['README.md'] !== initialFiles['README.md'];
  useFocusTrap(resetOpen, resetDialog, () => setResetOpen(false));
  useEffect(() => {
    const onHash = () => { draftRevision.current++; setRoute(readRoute()); setDraft(''); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let active = true;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'DEMO_OFFLINE_READY' && active) setOfflineReady(true);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then(async () => {
        const registration = await navigator.serviceWorker.ready;
        if (active) registration.active?.postMessage({ type: 'DEMO_CACHE_STATUS' });
      }).catch(() => { if (active) setNotice('Offline cache unavailable. The loaded demo still works without a backend.'); });
    return () => { active = false; navigator.serviceWorker.removeEventListener('message', onMessage); };
  }, []);
  function navigate(tab: Tab, id = session.id) { location.hash = `/${tab.toLowerCase()}/${id}`; }
  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setBusy(false);
    setNotice('Replay stopped. No messages or files were changed.');
  }
  function send(prompt = draft) {
    if (!prompt.trim() || busy) return;
    const target = session;
    const revision = draftRevision.current;
    setBusy(true);
    setNotice('Replaying a deterministic fixture; no model connection.');
    const id = `turn-${++sequence.current}`;
    timer.current = setTimeout(() => {
      setState(current => ({ ...current, sessions: current.sessions.map(value => value.id === target.id
        ? simulatedTurn(prompt, value, current.files, enabled, id) : value) }));
      if (draftRevision.current === revision) setDraft('');
      setBusy(false); timer.current = null;
      setNotice('Fixture replay complete. No API request, inference or host tool execution.');
    }, 600);
  }
  function edit() {
    if (!enabled.includes('edit')) { setNotice('Enable the synthetic edit tool in Tools before previewing the edit.'); return; }
    setState(current => ({ ...current, files: previewEdit(current.files) }));
    setNotice('Preview applied to browser memory only. Open Git to inspect the diff.');
  }
  function reset() {
    stop(); draftRevision.current++; setState(freshState()); setEnabled(tools.map(tool => tool.name)); setDraft('');
    setTerminal(['Synthetic terminal · no host shell. Type help for commands.']); setCommand('');
    setSelectedFile('src/GardenCard.tsx'); setResetOpen(false); navigate('Chat', 'workspace-review');
    setNotice('Demo reset. All local previews and prompts were discarded.');
  }
  return <>
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
    <header className="topbar">
      <a className="brand" href="#/chat/workspace-review"><img src={`${import.meta.env.BASE_URL}mark.svg`} alt="" width="36" height="36" />
        <span>AiHarness <small>Interactive demo</small></span></a>
      <div className="header-actions"><span className="pill">Synthetic · no backend</span>
        <button aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? 'Dark' : 'Light'}</button>
        <button onClick={() => setResetOpen(true)}>Reset demo</button></div>
    </header>
    <div className="layout">
      <aside className="sidebar" aria-label="Demo sessions">
        <div className="workspace"><span className="eyebrow">VIRTUAL WORKSPACE</span><strong>Garden board</strong><span>/demo/garden-board</span></div>
        <div className="section-title"><h2>Sessions</h2><button disabled={state.sessions.length >= MAX_SESSIONS || busy} onClick={() => {
          const id = `new-${++sequence.current}`;
          setState(current => ({ ...current, sessions: [...current.sessions, { id, name: `Untitled demo ${current.sessions.length - 1}`, model: models[0]!.key, messages: [] }] }));
          navigate('Chat', id);
        }}>New chat</button></div>
        <nav className="session-list" aria-label="Sessions">{state.sessions.map(value => <a key={value.id} href={`#/chat/${value.id}`}
          aria-current={value.id === session.id ? 'page' : undefined}><span>{value.name}</span><small>{value.messages.length} messages · mock</small></a>)}</nav>
        <section className="safety"><h2>A safe place to explore</h2><p>Authored fixtures, not real conversations. No accounts, API credentials, host files or processes.</p><p>Prompts are temporary and are not saved. Please don’t enter private information.</p></section>
        <span className="offline" role="status">{offlineReady ? 'Offline ready · reload supported' : 'Preparing offline assets…'}</span>
      </aside>
      <div className="content">
        <nav className="tabs" aria-label="Workspace views">{tabs.map(tab => <a key={tab} href={`#/${tab.toLowerCase()}/${session.id}`}
          aria-current={route.tab === tab ? 'page' : undefined}>{tab}{tab === 'Git' && changed ? ' (1)' : ''}</a>)}</nav>
        <main id="main" tabIndex={-1}>
          <div className="view-heading"><div><span className="eyebrow">{route.tab === 'Chat' ? 'CONVERSATION' : 'WORKSPACE EXPLORER'}</span>
            <h1>{route.tab === 'Chat' ? session.name : route.tab === 'Git' ? 'Git changes' : route.tab === 'Terminal' ? 'Synthetic terminal' : route.tab === 'Models' ? 'Demo models' : route.tab === 'Tools' ? 'Demo tools' : 'Workspace files'}</h1></div><span className="pill">{changed ? '1 preview change' : 'Clean fixture'}</span></div>
          {route.tab === 'Chat' && <>
            <div className="model-bar"><label>Session model <select value={session.model} disabled={busy} onChange={event => {
              const model = event.target.value;
              setState(current => ({ ...current, sessions: current.sessions.map(value => value.id === session.id ? { ...value, model } : value) }));
            }}>{models.map(model => <option value={model.key} key={model.key}>{model.name} · mock</option>)}</select></label><span>Deterministic replay · no live AI</span></div>
            <section className="messages" aria-label="Conversation messages">{session.messages.length ? session.messages.map(value => <article className={`message ${value.role}`} key={value.id} aria-label={`${value.role}${value.name ? ` ${value.name}` : ''} message`}>
              <header><strong>{value.role === 'assistant' ? 'AiHarness' : value.role === 'user' ? 'You' : `Process · ${value.name}`}</strong><span>{value.role === 'tool' ? 'Synthetic tool result' : value.role === 'assistant' ? 'Fixture response' : 'Demo prompt'}</span></header>
              {value.role === 'tool' ? <details><summary>View full {value.name} result</summary><pre>{value.content}</pre></details> : value.role === 'user' ? <p className="user-text">{value.content}</p> : <MarkdownContent content={value.content} />}
            </article>) : <div className="empty"><h2>Start exploring</h2><p>Replay a workspace review or preview an edit. The response is a fixed example, not a live model.</p></div>}</section>
            <div className="quick-actions"><button disabled={busy} onClick={() => send('Review the synthetic garden workspace.')}>Review workspace</button><button disabled={busy || changed} onClick={edit}>Preview welcome edit</button><button onClick={() => navigate('Files')}>Explore files</button></div>
            <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}><label htmlFor="prompt">Try a demo prompt</label>
              <textarea id="prompt" ref={composer} maxLength={MAX_PROMPT} rows={3} value={draft} placeholder="Ask about the garden board (fixture replay only)…" onChange={event => { draftRevision.current++; setDraft(event.target.value); }}
                onKeyDown={event => { if (composerKeySubmits({ ...event, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, 'mod-enter')) { event.preventDefault(); send(); } }} />
              <div className="composer-footer"><small>Ctrl/⌘ + Enter replays · {draft.length}/{MAX_PROMPT}</small>{busy ? <button key="stop" type="button" onClick={event => { event.preventDefault(); stop(); }}>Stop replay</button> : <button key="replay" className="primary" disabled={!draft.trim()} type="submit">Replay fixture</button>}</div></form>
          </>}
          {route.tab === 'Files' && <><p>Bundled synthetic source. Read-only viewer; the welcome edit is a fixed browser-memory preview.</p><div className="file-grid">
            <nav aria-label="Bundled files" className="file-list">{Object.keys(state.files).map(path => <button aria-pressed={path === selectedFile} key={path} onClick={() => setSelectedFile(path)}>{path}{path === 'README.md' && changed ? ' · modified' : ''}</button>)}</nav>
            <section aria-label="File preview" className="file-preview"><h2>{selectedFile}</h2>{selectedFile.endsWith('.svg') && <img className="garden-asset" alt="Synthetic garden sprout" src={`${import.meta.env.BASE_URL}garden.svg`} />}
              {selectedFile.endsWith('.md') ? <MarkdownContent content={state.files[selectedFile]!} /> : <pre>{state.files[selectedFile]}</pre>}</section></div></>}
          {route.tab === 'Git' && <><p>Branch <code>demo/welcome</code> · simulated Git state, not a repository connection.</p><div className="git-actions"><button disabled={changed || busy} onClick={edit}>Preview welcome edit</button><button disabled={!changed || busy} onClick={() => {
            setState(current => ({ ...current, files: { ...initialFiles } })); setNotice('Preview reverted in browser memory.');
          }}>Revert preview</button></div><section className="diff" aria-label="Synthetic Git diff"><h2>{changed ? 'README.md · +1 −1' : 'No changes'}</h2><pre>{gitDiff(state.files)}</pre></section></>}
          {route.tab === 'Terminal' && <><p>No shell is started. Only exact allowlisted commands return fixture text. Try <code>help</code>, <code>ls</code>, <code>git diff</code> or <code>npm test</code>.</p>
            <pre className="terminal-output" aria-label="Terminal output" tabIndex={0}>{terminal.join('\n\n')}</pre>
            <form className="terminal-form" onSubmit={event => { event.preventDefault(); if (!command.trim()) return;
              setTerminal(current => [...current, `$ ${command}\n${terminalReply(command, state.files)}`].slice(-20)); setCommand('');
            }}><label htmlFor="command">Synthetic command</label><div><input id="command" maxLength={200} value={command} onChange={event => setCommand(event.target.value)} placeholder="help" /><button className="primary" disabled={!command.trim()}>Replay command</button></div></form><button onClick={() => setTerminal(['Synthetic terminal cleared. No process was started.'])}>Clear output</button></>}
          {route.tab === 'Models' && <><p>These invented models replay fixed responses. No provider connection, pricing, credential entry or live discovery.</p><div className="catalog">{models.map(model => <article className="card" key={model.key}><span className="pill">Synthetic provider: mock</span><h2>{model.name}</h2><code>{model.key}</code><dl><dt>Context (illustrative)</dt><dd>{model.contextWindow?.toLocaleString('en-US')} tokens</dd><dt>Fixture capabilities</dt><dd>{model.capabilities.reasoning ? 'Reasoning label, ' : ''}tool results · text only</dd></dl><button onClick={() => {
            setState(current => ({ ...current, sessions: current.sessions.map(value => value.id === session.id ? { ...value, model: model.key } : value) }));
            navigate('Chat'); setNotice(`Selected ${model.name} for this demo session.`);
          }} disabled={busy}>Use in this session</button></article>)}</div></>}
          {route.tab === 'Tools' && <><p>Demo toggles affect fixture replay and preview actions only. This is not the real tool runtime, QuickJS or MCP.</p><div className="catalog">{tools.map(tool => <label className="card tool-card" key={tool.name}><input type="checkbox" checked={enabled.includes(tool.name)} disabled={busy} onChange={event => setEnabled(current => event.target.checked ? [...current, tool.name] : current.filter(name => name !== tool.name))} /><span><strong>{tool.name}</strong><span>{tool.description}</span></span></label>)}</div><p>Disabled tools produce no corresponding simulated result. Terminal command replay remains available independently; it never executes the bash tool.</p></>}
          <p className="notice" role="status">{notice}</p>
          <details className="limitations"><summary>Demo limitations & privacy</summary><p>All models, sessions, messages, file contents, Git changes and terminal output are synthetic. There is no backend, inference, real filesystem, shell, Git process, authentication, credential entry, upload, MCP connection or code-mode execution.</p><p>Session messages and edits live only in memory and reset on reload. Up to 12 sessions, 80 recent messages per session, 2,000 characters per prompt and 20 terminal outputs are retained. No prompt is saved to browser storage or sent over the network. The service worker caches public static assets only. Offline reload works after “Offline ready” appears; first load requires a static host. To remove the asset cache, clear site data in your browser.</p></details>
        </main>
      </div>
    </div>
    {resetOpen && <div className="modal-backdrop"><div className="modal" ref={resetDialog} role="dialog" aria-modal="true" aria-labelledby="reset-title" tabIndex={-1}><h2 id="reset-title">Reset this demo?</h2><p>Discard temporary prompts, sessions, file previews and terminal output. No real files are affected.</p><div><button data-autofocus onClick={() => setResetOpen(false)}>Cancel</button><button className="primary" onClick={reset}>Reset temporary state</button></div></div></div>}
  </>;
}
