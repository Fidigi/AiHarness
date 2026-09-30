// ============================================================
// Settings View Component - Provider Configuration
// ============================================================

import { useState } from 'react';
import { useSessionStore } from '../store/session-store';
import type { ProviderType } from '@ai-harness/core';
import { getChatTransport, setAuthToken, setChatTransport, setProviderApiKey } from '../services/api';

function SettingsView() {
  const providers = useSessionStore(state => state.providers);
  const setProvider = useSessionStore(state => state.setProvider);
  const updateApiKey = useSessionStore(state => state.updateApiKey);
  const sessionCount = useSessionStore(state => state.sessions.length);
  const [authToken, updateAuthToken] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [transport, updateTransport] = useState<'sse' | 'websocket'>(() => getChatTransport());

  // Local state for API key input (not committed until saved)
  const [apiKeyInputs, setApikeyInputs] = useState<Record<string, string>>(() => {
    const inputs: Record<string, string> = {};
    Object.entries(providers.available).forEach(([type, config]) => {
      inputs[type] = config.apiKey ? '••••••••' : ''; // Show masked if exists
    });
    return inputs;
  });

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setProvider(e.target.value as ProviderType);
  };

  const handleApiKeyChange = (type: string, value: string) => {
    setApikeyInputs(prev => ({ ...prev, [type]: value }));
  };

  const saveApiKey = async (type: string) => {
    const key = apiKeyInputs[type];
    if (key && !key.includes('•')) {
      const result = await setProviderApiKey(type, key);
      if (result.success) {
        updateApiKey(type as ProviderType, 'configured');
        setApikeyInputs(previous => ({ ...previous, [type]: '••••••••' }));
        setSaveStatus(`${getTypeLabel(type as ProviderType)} configuré côté serveur.`);
      } else {
        setSaveStatus(result.error || 'Échec de la configuration.');
      }
    }
  };

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Authentification serveur</h3>
        <div className="api-key-input-group">
          <input
            type="password"
            value={authToken}
            placeholder="Bearer token"
            onChange={event => updateAuthToken(event.target.value)}
          />
          <button onClick={() => { setAuthToken(authToken); setSaveStatus('Token appliqué pour cet onglet.'); }}>
            Appliquer
          </button>
        </div>
        {saveStatus && <p>{saveStatus}</p>}
      </section>

      {/* AI Provider Configuration */}
      <section className="settings-section">
        <h3>AI Provider</h3>
        <select value={providers.active} onChange={handleProviderChange}>
          {Object.keys(providers.available).map((type) => (
            <option key={type} value={type}>
              {{
                openai: 'OpenAI (GPT-4, GPT-3.5)',
                anthropic: 'Anthropic (Claude)',
                google: 'Google AI (Gemini)',
                local: 'Local Model (Ollama, etc.)',
                mock: 'Mock (Testing Only)',
                custom: 'Custom Provider',
              }[type] || type}
            </option>
          ))}
        </select>

        {/* API Key Configuration */}
        <div className="api-key-section">
          {Object.keys(providers.available).map((type) => (
            <div key={type} className={`api-key-row ${providers.active === type ? 'active' : ''}`}>
              <label>{getTypeLabel(type as ProviderType)}</label>
              <div className="api-key-input-group">
                <input
                  type="password"
                  placeholder={`${getTypeEnvVar(type as ProviderType)} (optional)`}
                  value={apiKeyInputs[type] || ''}
                  onChange={(e) => handleApiKeyChange(type, e.target.value)}
                />
                <button onClick={() => saveApiKey(type)}>Save</button>
              </div>
            </div>
          ))}
        </div>

        {/* Active provider status */}
        <div className="provider-status">
          {providers.active === 'mock' ? (
            <span className="status-info">🔧 Using Mock Provider (no API key needed)</span>
          ) : providers.active === 'local' ? (
            <span className="status-success">✅ Local OpenAI-compatible provider configured</span>
          ) : providers.available[providers.active]?.apiKey ? (
            <span className="status-success">✅ {getTypeLabel(providers.active)} configured</span>
          ) : (
            <span className="status-warning">⚠️ No API key set for {getTypeLabel(providers.active)}</span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>Transport temps réel</h3>
        <select value={transport} onChange={event => {
          const value = event.target.value as 'sse' | 'websocket';
          updateTransport(value);
          setChatTransport(value);
        }}>
          <option value="sse">Server-Sent Events (SSE)</option>
          <option value="websocket">WebSocket</option>
        </select>
      </section>

      {/* Model Selection */}
      <section className="settings-section">
        <h3>Model</h3>
        <select disabled={!providers.available[providers.active]?.model}>
          {getModelOptions(providers.active).map(model => (
            <option key={model.value} value={model.value}>{model.label}</option>
          ))}
        </select>
      </section>

      {/* Appearance */}
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="theme-toggle">
          <button onClick={() => document.documentElement.classList.add('dark')}>🌙 Dark Mode</button>
          <button onClick={() => document.documentElement.classList.remove('dark')}>☀️ Light Mode</button>
        </div>
      </section>

      {/* Session Management */}
      <section className="settings-section">
        <h3>Sessions</h3>
        <p>Total sessions: {sessionCount}</p>
        <small>Persisted as JSONL files in ~/.ai-harness/sessions/</small>
      </section>

      {/* About */}
      <section className="settings-section about">
        <h3>About</h3>
        <p>AiHarness v0.1.0 - Unified AI Agent Platform</p>
        <div className="about-links">
          <a href="#" onClick={(e) => { e.preventDefault(); alert('Documentation coming soon!'); }}>📖 Documentation</a>
          <span>•</span>
          <a href="#" onClick={(e) => { e.preventDefault(); alert('GitHub repository link'); }}>⭐ Star on GitHub</a>
        </div>
      </section>
    </div>
  );
}

/** Get human-readable label for provider type */
function getTypeLabel(type: ProviderType): string {
  return {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google AI',
    azure: 'Azure OpenAI',
    bedrock: 'AWS Bedrock',
    vertex: 'Google Vertex AI',
    local: 'Local Model',
    mock: 'Mock (Testing)',
    custom: 'Custom',
  }[type] || type;
}

/** Get environment variable name for provider */
function getTypeEnvVar(type: ProviderType): string {
  return {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    bedrock: 'AWS_ACCESS_KEY_ID:AWS_SECRET_ACCESS_KEY',
    vertex: 'GOOGLE_VERTEX_ACCESS_TOKEN',
    local: '',
    mock: '',
    custom: 'CUSTOM_API_KEY',
  }[type] || '';
}

/** Get model options for a provider */
function getModelOptions(type: ProviderType): Array<{ value: string; label: string }> {
  switch (type) {
    case 'openai':
      return [
        { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
        { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
      ];
    case 'anthropic':
      return [
        { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Most Capable)' },
        { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet (Balanced)' },
        { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (Fastest)' },
      ];
    case 'google':
    case 'vertex':
      return [
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      ];
    case 'azure':
      return [{ value: 'gpt-4o', label: 'Azure OpenAI deployment' }];
    case 'bedrock':
      return [{ value: 'anthropic.claude-3-haiku-20240307-v1:0', label: 'Claude 3 Haiku' }];
    case 'local':
      return [{ value: 'local-model', label: 'Local server model' }];
    default:
      return [{ value: '', label: 'Default model' }];
  }
}

export default SettingsView;
