// ============================================================
// Web App - Main Component
// ============================================================

import { useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SettingsView from './components/SettingsView';

function App() {
  const [sidebarOpen] = useState(true);

  return (
    <div className="app">
      <Sidebar isOpen={sidebarOpen} />
      <main className="main-content" style={{ marginLeft: sidebarOpen ? '280px' : '0', transition: 'margin-left 0.3s' }}>
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
