// ============================================================
// Settings View Component
// ============================================================

import { useSessionStore } from '../store/session-store';

function SettingsView() {
  const providers = useSessionStore((state) => state.providers);
  const setProvider = useSessionStore((state) => state.setProvider);

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>AI Provider</h3>
        <select
          value={providers.active}
          onChange={(e) => setProvider(e.target.value)}
        >
          {Object.keys(providers.available).map((type) => (
            <option key={type} value={type}>
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h3>Model</h3>
        <p>Model selection coming soon...</p>
      </section>

      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="theme-toggle">
          <button>🌙 Dark Mode</button>
          <button>☀️ Light Mode</button>
        </div>
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <p>AiHarness v0.1.0 - Unified AI Agent Platform</p>
      </section>
    </div>
  );
}

export default SettingsView;
