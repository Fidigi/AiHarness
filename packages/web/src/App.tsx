// ============================================================
// Web App - Main Component
// ============================================================

import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';
import { useSessionStore } from './store/session-store';

function App() {
  const [sidebarOpen] = useState(true);
  const hydrateSessions = useSessionStore(state => state.hydrateSessions);
  const hydrateProviders = useSessionStore(state => state.hydrateProviders);

  useEffect(() => {
    void hydrateSessions();
    void hydrateProviders();
  }, [hydrateSessions, hydrateProviders]);

  return (
    <div className="app">
      <Sidebar isOpen={sidebarOpen} />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/chat/:id" element={<ChatView />} />
          <Route path="/settings" element={<SettingsView />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
