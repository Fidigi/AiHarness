// ============================================================
// Sidebar Component
// ============================================================

import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../store/session-store';

interface SidebarProps {
  isOpen: boolean;
}

function Sidebar({ isOpen }: SidebarProps) {
  const navigate = useNavigate();
  const sessions = useSessionStore((state) => state.sessions);
  const createSession = useSessionStore((state) => state.createSession);

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <h1>AiHarness</h1>
        <button onClick={() => createSession()} title="New chat" aria-label="New chat">
          +
        </button>
      </div>

      <nav className="sidebar-nav">
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <button onClick={() => navigate(`/chat/${session.id}`)}>
                {session.title || 'Untitled'}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-footer">
        <button onClick={() => navigate('/settings')}>⚙ Settings</button>
      </div>
    </aside>
  );
}

export default Sidebar;
