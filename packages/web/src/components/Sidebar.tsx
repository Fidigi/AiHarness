// ============================================================
// Sidebar Component
// ============================================================

import { useNavigate } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';
import LanguageSelector from './LanguageSelector';

interface SidebarProps {
  isOpen: boolean;
}

function Sidebar({ isOpen }: SidebarProps) {
  const navigate = useNavigate();
  const sessions = useSessionStore((state) => state.sessions);
  const createRemoteSession = useSessionStore((state) => state.createRemoteSession);
  const { t } = useI18n();

  const handleCreate = async () => {
    const id = await createRemoteSession();
    if (id) navigate(`/chat/${id}`);
  };

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <h1>AiHarness</h1>
        <div className="sidebar-actions">
          <LanguageSelector />
          <button
            onClick={() => void handleCreate()}
            title={t('sidebar.newChat')}
            aria-label={t('sidebar.newChat')}
          >
            +
          </button>
        </div>
      </div>

      <nav className="sidebar-nav">
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <button onClick={() => navigate(`/chat/${session.id}`)}>
                {session.title || t('sidebar.untitled')}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <button onClick={() => navigate('/settings')}>⚙ {t('common.settings')}</button>
      </div>
    </aside>
  );
}

export default Sidebar;
