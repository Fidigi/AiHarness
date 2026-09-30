// ============================================================
// Settings View Component - Provider Configuration
// ============================================================

import { useState } from 'react';
import { useSessionStore } from '../store/session-store';
import { useI18n } from '../hooks/useI18n';
import type { ProviderType } from '@ai-harness/core';
import type { TranslationFunction } from '../i18n/types';
import { getChatTransport, setAuthToken, setChatTransport, setProviderApiKey } from '../services/api';

type SaveStatus =
  | { key: string; provider?: ProviderType }
  | { detail: string };

function SettingsView() {
  const providers = useSessionStore(state => state.providers);
  const setProvider = useSessionStore(state => state.setProvider);
  const updateApiKey = useSessionStore(state => state.updateApiKey);
  const sessionCount = useSessionStore(state => state.sessions.length);
  const { t } = useI18n();
  const [authToken, updateAuthToken] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
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
        setSaveStatus({
          key: 'settings.providerConfiguredOnServer',
          provider: type as ProviderType,
        });
      } else {
        setSaveStatus(result.error
          ? { detail: result.error }
          : { key: 'settings.configurationFailed' });
      }
    }
  };

  return (
    <div className="settings-view">
      <h2>{t('settings.title')}</h2>

      <section className="settings-section">
        <h3>{t('settings.serverAuthentication')}</h3>
        <div className="api-key-input-group">
          <input
            type="password"
            value={authToken}
            placeholder={t('settings.bearerToken')}
            aria-label={t('settings.bearerToken')}
            onChange={event => updateAuthToken(event.target.value)}
          />
          <button onClick={() => {
            setAuthToken(authToken);
            setSaveStatus({ key: 'settings.tokenApplied' });
          }}>
            {t('settings.apply')}
          </button>
        </div>
        {saveStatus && (
          <p>{'detail' in saveStatus
            ? saveStatus.detail
            : t(saveStatus.key, saveStatus.provider
              ? { provider: getTypeLabel(saveStatus.provider, t) }
              : undefined)}</p>
        )}
      </section>

      {/* AI Provider Configuration */}
      <section className="settings-section">
        <h3>{t('settings.aiProvider')}</h3>
        <select
          value={providers.active}
          aria-label={t('settings.selectProvider')}
          onChange={handleProviderChange}
        >
          {Object.keys(providers.available).map(type => (
            <option key={type} value={type}>
              {getProviderOptionLabel(type as ProviderType, t)}
            </option>
          ))}
        </select>

        {/* API Key Configuration */}
        <div className="api-key-section">
          {Object.keys(providers.available).map(type => {
            const providerType = type as ProviderType;
            const providerLabel = getTypeLabel(providerType, t);
            const environmentVariable = getTypeEnvVar(providerType);
            return (
              <div key={type} className={`api-key-row ${providers.active === type ? 'active' : ''}`}>
                <label>{providerLabel}</label>
                <div className="api-key-input-group">
                  <input
                    type="password"
                    aria-label={t('settings.apiKeyForProvider', { provider: providerLabel })}
                    placeholder={environmentVariable
                      ? t('settings.apiKeyOptional', { variable: environmentVariable })
                      : t('settings.apiKeyOptionalGeneric')}
                    value={apiKeyInputs[type] || ''}
                    onChange={event => handleApiKeyChange(type, event.target.value)}
                  />
                  <button onClick={() => void saveApiKey(type)}>{t('common.save')}</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active provider status */}
        <div className="provider-status">
          {providers.active === 'mock' ? (
            <span className="status-info">{t('settings.usingMockProvider')}</span>
          ) : providers.active === 'local' ? (
            <span className="status-success">{t('settings.localProviderConfigured')}</span>
          ) : providers.available[providers.active]?.apiKey ? (
            <span className="status-success">
              {t('settings.providerConfigured', { provider: getTypeLabel(providers.active, t) })}
            </span>
          ) : (
            <span className="status-warning">
              {t('settings.noApiKey', { provider: getTypeLabel(providers.active, t) })}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>{t('settings.realtimeTransport')}</h3>
        <select
          value={transport}
          aria-label={t('settings.selectTransport')}
          onChange={event => {
            const value = event.target.value as 'sse' | 'websocket';
            updateTransport(value);
            setChatTransport(value);
          }}
        >
          <option value="sse">Server-Sent Events (SSE)</option>
          <option value="websocket">WebSocket</option>
        </select>
      </section>

      {/* Model Selection */}
      <section className="settings-section">
        <h3>{t('settings.model')}</h3>
        <select
          aria-label={t('settings.selectModel')}
          disabled={!providers.available[providers.active]?.model}
        >
          {getModelOptions(providers.active, t).map(model => (
            <option key={model.value} value={model.value}>{model.label}</option>
          ))}
        </select>
      </section>

      {/* Appearance */}
      <section className="settings-section">
        <h3>{t('settings.appearance')}</h3>
        <div className="theme-toggle">
          <button onClick={() => document.documentElement.classList.add('dark')}>
            🌙 {t('settings.darkMode')}
          </button>
          <button onClick={() => document.documentElement.classList.remove('dark')}>
            ☀️ {t('settings.lightMode')}
          </button>
        </div>
      </section>

      {/* Session Management */}
      <section className="settings-section">
        <h3>{t('settings.sessions')}</h3>
        <p>{t('settings.totalSessions', { count: sessionCount })}</p>
        <small>{t('settings.sessionsLocation')}</small>
      </section>

      {/* About */}
      <section className="settings-section about">
        <h3>{t('settings.about')}</h3>
        <p>{t('settings.aboutDescription')}</p>
        <div className="about-links">
          <a href="#" onClick={event => {
            event.preventDefault();
            alert(t('settings.documentationComingSoon'));
          }}>
            📖 {t('settings.documentation')}
          </a>
          <span>•</span>
          <a href="#" onClick={event => {
            event.preventDefault();
            alert(t('settings.githubRepositoryLink'));
          }}>
            ⭐ {t('settings.starOnGitHub')}
          </a>
        </div>
      </section>
    </div>
  );
}

/** Get the translated short label for a provider type. */
function getTypeLabel(type: ProviderType, t: TranslationFunction): string {
  const key = {
    openai: 'provider.label.openai',
    anthropic: 'provider.label.anthropic',
    google: 'provider.label.google',
    azure: 'provider.label.azure',
    bedrock: 'provider.label.bedrock',
    vertex: 'provider.label.vertex',
    local: 'provider.label.local',
    mock: 'provider.label.mock',
    custom: 'provider.label.custom',
  }[type];
  return key ? t(key) : type;
}

/** Get the translated provider selector label. */
function getProviderOptionLabel(type: ProviderType, t: TranslationFunction): string {
  const key = {
    openai: 'provider.option.openai',
    anthropic: 'provider.option.anthropic',
    google: 'provider.option.google',
    azure: 'provider.option.azure',
    bedrock: 'provider.option.bedrock',
    vertex: 'provider.option.vertex',
    local: 'provider.option.local',
    mock: 'provider.option.mock',
    custom: 'provider.option.custom',
  }[type];
  return key ? t(key) : type;
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

/** Get model options for a provider. */
function getModelOptions(
  type: ProviderType,
  t: TranslationFunction,
): Array<{ value: string; label: string }> {
  switch (type) {
    case 'openai':
      return [
        { value: 'gpt-4o', label: t('model.recommended') },
        { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
        { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
      ];
    case 'anthropic':
      return [
        { value: 'claude-3-opus-20240229', label: t('model.mostCapable') },
        { value: 'claude-3-sonnet-20240229', label: t('model.balanced') },
        { value: 'claude-3-haiku-20240307', label: t('model.fastest') },
      ];
    case 'google':
    case 'vertex':
      return [
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      ];
    case 'azure':
      return [{ value: 'gpt-4o', label: t('model.azureDeployment') }];
    case 'bedrock':
      return [{ value: 'anthropic.claude-3-haiku-20240307-v1:0', label: 'Claude 3 Haiku' }];
    case 'local':
      return [{ value: 'local-model', label: t('model.localServer') }];
    default:
      return [{ value: '', label: t('model.default') }];
  }
}

export default SettingsView;
