import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { searchFiles } from '../services/api';
import { shortcutLabel } from '../services/keyboard';
import { usePreferences } from '../store/preferences';
import { useSessionStore } from '../store/session-store';

interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  detail?: string;
  shortcut?: string;
  run: () => void;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sessions = useSessionStore(state => state.sessions);
  const workspace = useSessionStore(state => state.workspace);
  const createSession = useSessionStore(state => state.createSession);
  const [preferences] = usePreferences();
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);

  const closeAnd = (action: () => void) => {
    onClose();
    window.setTimeout(action, 0);
  };
  const create = () => {
    createSession();
    const id = useSessionStore.getState().activeSessionId;
    if (id) navigate(`/chat/${encodeURIComponent(id)}?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`);
  };
  const commands = useMemo<PaletteEntry[]>(() => [
    { id: 'new', group: t('palette.commands'), label: t('shortcuts.newSession'), shortcut: preferences.keybindings.newSession, run: create },
    { id: 'prompt', group: t('palette.commands'), label: t('shortcuts.focusPrompt'), shortcut: preferences.keybindings.focusPrompt,
      run: () => window.dispatchEvent(new CustomEvent('aih-focus-prompt')) },
    { id: 'files', group: t('palette.commands'), label: t('shortcuts.toggleFiles'), shortcut: preferences.keybindings.toggleFiles,
      run: () => window.dispatchEvent(new CustomEvent('aih-files-toggle')) },
    { id: 'terminal', group: t('palette.commands'), label: t('shortcuts.toggleTerminal'), shortcut: preferences.keybindings.toggleTerminal,
      run: () => window.dispatchEvent(new CustomEvent('aih-toggle-terminal')) },
    { id: 'settings', group: t('palette.settings'), label: t('settings.title'), shortcut: preferences.keybindings.openSettings,
      run: () => navigate('/settings') },
    { id: 'appearance', group: t('palette.settings'), label: t('settings.appearance'), run: () => navigate('/settings#appearance') },
    { id: 'skills', group: t('palette.settings'), label: t('settings.skills.title'), run: () => navigate('/settings#skills') },
    { id: 'subagents', group: t('palette.settings'), label: t('subagents.title'), run: () => navigate('/settings#subagents') },
    { id: 'keyboard', group: t('palette.settings'), label: t('settings.shortcuts'), run: () => navigate('/settings#shortcuts') },
  ], [preferences.keybindings, t, workspace?.cwd]); // Store actions are stable.

  useFocusTrap(true, dialog, onClose);

  useEffect(() => {
    if (!workspace?.trusted || query.trim().length < 1) {
      setFiles([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void searchFiles(workspace.cwd, query, controller.signal).then(result => {
      if (!controller.signal.aborted && result.success && result.data) setFiles(result.data.files);
    }), 120);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, workspace?.cwd, workspace?.trusted]);

  const needle = query.trim().toLocaleLowerCase();
  const entries: PaletteEntry[] = [
    ...commands.filter(entry => !needle || `${entry.label} ${entry.detail ?? ''}`.toLocaleLowerCase().includes(needle)),
    ...sessions.filter(session => !needle || (session.title || '').toLocaleLowerCase().includes(needle)).slice(0, 12).map(session => ({
      id: `session:${session.id}`, group: t('palette.sessions'), label: session.title || t('sidebar.untitled'),
      detail: session.messages.at(-1)?.content.slice(0, 80),
      run: () => navigate(`/chat/${encodeURIComponent(session.id)}?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`),
    })),
    ...files.map(file => ({ id: `file:${file}`, group: t('palette.files'), label: file,
      run: () => {
        window.dispatchEvent(new CustomEvent('aih-show-files'));
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('aih-open-file', { detail: file })), 0);
      } })),
  ];
  const active = entries[Math.min(selected, Math.max(0, entries.length - 1))];

  return <div className="global-command-palette-backdrop" role="presentation" onMouseDown={event => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section ref={dialog} className="global-command-palette" role="dialog" aria-modal="true" aria-label={t('palette.title')}>
      <input ref={input} data-autofocus value={query} aria-label={t('palette.search')} placeholder={t('palette.placeholder')}
        onChange={event => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected(index => entries.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length : 0);
          } else if (event.key === 'Enter' && active) {
            event.preventDefault();
            closeAnd(active.run);
          }
        }} />
      <div className="global-command-palette-results" role="listbox" aria-label={t('palette.title')}>
        {entries.length === 0 && <p>{t('palette.empty')}</p>}
        {entries.map((entry, index) => <button key={entry.id} role="option" aria-selected={index === selected}
          className={index === selected ? 'active' : ''} onMouseMove={() => setSelected(index)} onClick={() => closeAnd(entry.run)}>
          <small>{entry.group}</small><span><strong>{entry.label}</strong>{entry.detail && <em>{entry.detail}</em>}</span>
          {entry.shortcut && <kbd>{shortcutLabel(entry.shortcut)}</kbd>}
        </button>)}
      </div>
    </section>
  </div>;
}
