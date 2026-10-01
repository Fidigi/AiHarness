// ============================================================
// Settings View Component - Provider Configuration
// ============================================================

import { lazy, Suspense, useEffect, useState } from 'react';
import '../settings.css';
import { useSessionStore } from '../store/session-store';
import { useI18n } from '../hooks/useI18n';
import type { ProviderType } from '@ai-harness/core';
import type { TranslationFunction } from '../i18n/types';
import {
  getAppUpdateStatus,
  getChatTransport,
  logoutWeb,
  setAuthToken,
  setChatTransport,
  setProviderApiKey,
  type AppUpdateStatus,
} from '../services/api';
import { SubagentSettings } from './SubagentSettings';
import { usePreferences } from '../store/preferences';
import { chordFromEvent, defaultKeybindings, shortcutActions, shortcutLabel } from '../services/keyboard';
import { pushSupported, syncPushSubscription, type NotificationEvent } from '../services/push';
import {
  CustomModelSettings,
  DefaultModelSettings,
  ProviderLifecycleSettings,
  SkillRegistryPanel,
  ToolSettingsPanel,
} from './EcosystemSettings';

const PluginSettings = lazy(async () => ({
  default: (await import('./PluginSettings')).PluginSettings,
}));

type SaveStatus =
  | { key: string; provider?: ProviderType }
  | { detail: string };

function SettingsView() {
  const providers = useSessionStore(state => state.providers);
  const setProvider = useSessionStore(state => state.setProvider);
  const updateApiKey = useSessionStore(state => state.updateApiKey);
  const setModel = useSessionStore(state => state.setModel);
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const setModelEnabled = useSessionStore(state => state.setModelEnabled);
  const setAllModelsEnabled = useSessionStore(state => state.setAllModelsEnabled);
  const skills = useSessionStore(state => state.skills);
  const hydrateSkillCatalog = useSessionStore(state => state.hydrateSkillCatalog);
  const setSkillModelInvocable = useSessionStore(state => state.setSkillModelInvocable);
  const sessionCount = useSessionStore(state => state.sessions.length);
  const workspaceId = useSessionStore(state => state.workspace?.id);
  const { t } = useI18n();
  const [authToken, updateAuthToken] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [transport, updateTransport] = useState<'sse' | 'websocket'>(() => getChatTransport());
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [pushStatus, setPushStatus] = useState('');
  const [preferences, setPreferences] = usePreferences();

  const activeCatalog = providers.catalog?.providers.find(group => group.provider === providers.active);
  const configuredModel = providers.available[providers.active]?.model || '';
  const catalogModelOptions = activeCatalog
    ? activeCatalog.models.filter(model => model.enabled && model.available).map(model => ({ value: model.id, label: model.name }))
    : getModelOptions(providers.active, t);
  const modelOptions = configuredModel && !catalogModelOptions.some(model => model.value === configuredModel)
    ? [{ value: configuredModel, label: configuredModel }, ...catalogModelOptions]
    : catalogModelOptions;
  const normalizedModelFilter = modelFilter.trim().toLocaleLowerCase();
  const visibleModelGroups = providers.catalog?.providers.map(group => ({
    ...group,
    models: group.models.filter(model => !normalizedModelFilter
      || group.provider.toLocaleLowerCase().includes(normalizedModelFilter)
      || model.id.toLocaleLowerCase().includes(normalizedModelFilter)
      || model.name.toLocaleLowerCase().includes(normalizedModelFilter)),
  })).filter(group => group.models.length > 0) ?? [];
  const normalizedSkillFilter = skillFilter.trim().toLocaleLowerCase();
  const visibleSkillGroups = (['project', 'global', 'path', 'package'] as const).map(scope => ({
    scope,
    skills: (skills.catalog?.skills ?? []).filter(skill => skill.scope === scope && (
      !normalizedSkillFilter
      || skill.name.toLocaleLowerCase().includes(normalizedSkillFilter)
      || skill.description.toLocaleLowerCase().includes(normalizedSkillFilter)
      || skill.source.toLocaleLowerCase().includes(normalizedSkillFilter)
    )),
  })).filter(group => group.skills.length > 0);

  const checkForUpdate = async (refresh = false) => {
    setCheckingUpdate(true);
    const result = await getAppUpdateStatus(refresh);
    if (result.success && result.data) setUpdateStatus(result.data);
    else setUpdateStatus({
      webVersion: 'unknown', agentVersion: 'unknown', checkedAt: new Date().toISOString(), available: false,
      error: { code: 'unavailable', message: result.error || t('settings.updateUnavailable') },
    });
    setCheckingUpdate(false);
  };

  useEffect(() => {
    const target = window.location.hash.slice(1) || preferences.lastSettingsSection;
    window.setTimeout(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }), 0);
  }, []); // Restore only on entry; interacting with controls must not move the page.

  useEffect(() => {
    // Defer the remote release check so settings and the rest of the application render first.
    const timer = window.setTimeout(() => void checkForUpdate(), 0);
    return () => window.clearTimeout(timer);
  }, []);

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

  const notificationCategories = (events = preferences.pushEvents): NotificationEvent[] =>
    (Object.entries(events) as Array<[NotificationEvent, boolean]>).filter(([, enabled]) => enabled).map(([event]) => event);

  const configurePush = async (enabled: boolean, events = preferences.pushEvents) => {
    setPushStatus(t('settings.push.configuring'));
    const result = await syncPushSubscription(enabled, notificationCategories(events));
    if (result.error) {
      setPushStatus(result.error);
      setPreferences({ pushNotifications: false });
      return;
    }
    setPreferences({ pushNotifications: result.subscribed });
    setPushStatus(result.subscribed
      ? result.persistent === false ? t('settings.push.volatile') : t('settings.push.active')
      : t('settings.push.inactive'));
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
    <div className="settings-view" onFocusCapture={event => {
      const section = (event.target as Element).closest<HTMLElement>('.settings-section[id]');
      if (section?.id && section.id !== preferences.lastSettingsSection) setPreferences({ lastSettingsSection: section.id });
    }}>
      <h2>{t('settings.title')}</h2>

      <section className="settings-section" id="authentication">
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
        <button className="logout-button" onClick={() => void logoutWeb().finally(() => {
          window.dispatchEvent(new Event('aih-auth-required'));
        })}>{t('settings.logout')}</button>
        {saveStatus && (
          <p>{'detail' in saveStatus
            ? saveStatus.detail
            : t(saveStatus.key, saveStatus.provider
              ? { provider: getTypeLabel(saveStatus.provider, t) }
              : undefined)}</p>
        )}
      </section>

      {/* AI Provider Configuration */}
      <section className="settings-section" id="providers">
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
          {Object.keys(providers.available).filter(type => [
            'openai', 'anthropic', 'google', 'azure', 'bedrock', 'vertex', 'local', 'mock',
          ].includes(type)).map(type => {
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

      <ProviderLifecycleSettings />

      <section className="settings-section" id="transport">
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

      {/* Model Selection and server catalogue */}
      <section className="settings-section" id="model">
        <h3>{t('settings.model')}</h3>
        <select
          aria-label={t('settings.selectModel')}
          value={configuredModel}
          disabled={!configuredModel || modelOptions.length === 0}
          onChange={event => setModel(providers.active, event.target.value)}
        >
          {modelOptions.map(model => (
            <option key={model.value} value={model.value}>{model.label}</option>
          ))}
        </select>

        <details className="model-catalog">
          <summary>{t('settings.modelCatalog.manage')}</summary>
          <p className="settings-help">{t('settings.modelCatalog.help')}</p>
          <div className="model-catalog-toolbar">
            <label>
              <span>{t('settings.modelCatalog.filter')}</span>
              <input type="search" value={modelFilter} aria-label={t('settings.modelCatalog.filter')}
                onChange={event => setModelFilter(event.target.value)} />
            </label>
            <div>
              <button type="button" disabled={providers.catalogLoading} onClick={() => void hydrateModelCatalog(true)}>
                {t('settings.modelCatalog.refresh')}
              </button>
              <button type="button" disabled={providers.catalogLoading || !providers.catalog} onClick={() => void setAllModelsEnabled(true)}>
                {t('settings.modelCatalog.enableAll')}
              </button>
              <button type="button" disabled={providers.catalogLoading || !providers.catalog} onClick={() => void setAllModelsEnabled(false)}>
                {t('settings.modelCatalog.disableAll')}
              </button>
            </div>
          </div>
          {providers.catalog && <p className="model-catalog-meta">
            {t('settings.modelCatalog.scope', { scope: t(`chat.scope.${providers.catalog.enabledScope}`) })}
            {' · '}{t('settings.modelCatalog.updated', { date: new Date(providers.catalog.updatedAt).toLocaleString() })}
          </p>}
          {providers.catalogLoading && <p role="status">{t('common.loading')}…</p>}
          {providers.catalogError && <p role="alert" className="status-warning">{providers.catalogError}</p>}
          {!providers.catalogLoading && providers.catalog && visibleModelGroups.length === 0 && (
            <p>{t('settings.modelCatalog.empty')}</p>
          )}
          <div className="model-catalog-groups">
            {visibleModelGroups.map(group => (
              <fieldset key={group.provider} data-provider={group.provider}>
                <legend>
                  {getTypeLabel(group.provider as ProviderType, t)}
                  <span className={group.configured ? 'status-success' : 'status-warning'}>
                    {group.configured ? t('settings.modelCatalog.configured') : t('settings.modelCatalog.unavailable')}
                  </span>
                </legend>
                {group.models.map(model => (
                  <label key={model.key} className="model-catalog-row">
                    <input type="checkbox" checked={model.enabled} disabled={providers.catalogLoading}
                      aria-label={t('settings.modelCatalog.toggle', { model: model.name, provider: getTypeLabel(group.provider as ProviderType, t) })}
                      onChange={event => void setModelEnabled(model.key, event.target.checked)} />
                    <span className="model-catalog-identity">
                      <strong>{model.name}</strong>
                      <code>{model.id}</code>
                    </span>
                    <span className="model-capabilities" aria-label={t('settings.modelCatalog.capabilities')}>
                      {model.capabilities.reasoning && <small>{t('settings.modelCatalog.reasoning')}</small>}
                      {model.capabilities.imageInput && <small>{t('settings.modelCatalog.images')}</small>}
                      {model.capabilities.toolCalls && <small>{t('settings.modelCatalog.tools')}</small>}
                      {model.contextWindow && <small>{model.contextWindow.toLocaleString()} ctx</small>}
                      {model.maxOutputTokens && <small>{model.maxOutputTokens.toLocaleString()} max</small>}
                      {model.pricing?.inputPerMillion !== undefined && <small>${model.pricing.inputPerMillion}/M in</small>}
                      {!model.available && <small className="unavailable">{t('settings.modelCatalog.unavailable')}</small>}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </details>
      </section>

      <DefaultModelSettings />
      <CustomModelSettings />

      <section className="settings-section" id="skills">
        <h3>{t('settings.skills.title')}</h3>
        <p className="settings-help">{t('settings.skills.help')}</p>
        <div className="model-catalog-toolbar">
          <label>
            <span>{t('settings.skills.filter')}</span>
            <input type="search" value={skillFilter} aria-label={t('settings.skills.filter')}
              onChange={event => setSkillFilter(event.target.value)} />
          </label>
          <div>
            <button type="button" disabled={skills.loading} onClick={() => void hydrateSkillCatalog(true)}>
              {t('settings.skills.refresh')}
            </button>
          </div>
        </div>
        {skills.catalog && <p className="model-catalog-meta">
          {t('settings.skills.scope', {
            scope: t(`chat.scope.${skills.catalog.enabledScope}`),
            source: skills.catalog.enabledSource,
          })}
          {' · '}{t('settings.modelCatalog.updated', { date: new Date(skills.catalog.updatedAt).toLocaleString() })}
        </p>}
        {skills.catalog && !skills.catalog.projectTrusted && (
          <p className="status-warning" role="status">{t('settings.skills.untrustedProject')}</p>
        )}
        {skills.catalog && skills.catalog.errorCount > 0 && (
          <p className="status-warning">{t('settings.skills.errors', { count: skills.catalog.errorCount })}</p>
        )}
        {skills.loading && <p role="status">{t('common.loading')}…</p>}
        {skills.error && <p role="alert" className="status-warning">{skills.error}</p>}
        {!skills.loading && skills.catalog && visibleSkillGroups.length === 0 && <p>{t('settings.skills.empty')}</p>}
        <SkillRegistryPanel />
        <div className="skill-catalog-groups">
          {visibleSkillGroups.map(group => (
            <fieldset key={group.scope} data-scope={group.scope}>
              <legend>{t(`settings.skills.scope.${group.scope}`)}</legend>
              {group.skills.map(skill => (
                <label key={skill.key} className="skill-catalog-row">
                  <input type="checkbox" checked={skill.modelInvocable}
                    disabled={skills.loading || !skill.trusted}
                    title={!skill.trusted ? t('settings.skills.requiresTrust') : undefined}
                    aria-label={t('settings.skills.toggle', { skill: skill.name })}
                    onChange={event => void setSkillModelInvocable(skill.key, event.target.checked)} />
                  <span className="skill-catalog-identity">
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                    <code>{skill.filePath}</code>
                  </span>
                  <span className="model-capabilities" aria-label={t('settings.skills.metadata')}>
                    {skill.version && <small>v{skill.version}</small>}
                    <small>{skill.source}</small>
                    {!skill.trusted && <small className="unavailable">{t('settings.skills.untrusted')}</small>}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </section>

      <ToolSettingsPanel />

      <Suspense fallback={(
        <section className="settings-section plugin-settings" id="plugins">
          <h3>{t('settings.plugins.title')}</h3>
          <p role="status">{t('common.loading')}…</p>
        </section>
      )}>
        <PluginSettings key={workspaceId ?? 'default-workspace'} />
      </Suspense>

      <SubagentSettings />

      {/* Appearance */}
      <section className="settings-section" id="appearance">
        <h3>{t('settings.appearance')}</h3>
        <div className="preference-grid">
          <label>{t('settings.theme')}
            <select value={preferences.theme} onChange={event => setPreferences({ theme: event.target.value as typeof preferences.theme })}>
              {['system', 'light', 'dark', 'mist', 'rose', 'pine'].map(theme => (
                <option key={theme} value={theme}>{t(`settings.theme.${theme}`)}</option>
              ))}
            </select>
          </label>
          <label>{t('settings.contentWidth', { width: preferences.contentWidth })}
            <input type="range" min="820" max="2000" step="20" value={preferences.contentWidth}
              onChange={event => setPreferences({ contentWidth: Number(event.target.value) })} />
          </label>
          <label>{t('settings.fontSize', { size: preferences.fontSize })}
            <input type="range" min="12" max="24" value={preferences.fontSize}
              onChange={event => setPreferences({ fontSize: Number(event.target.value) })} />
          </label>
          <label><input type="checkbox" checked={preferences.reasoningOpen}
            onChange={event => setPreferences({ reasoningOpen: event.target.checked })} /> {t('settings.reasoningOpen')}</label>
          <label><input type="checkbox" checked={preferences.sound}
            onChange={event => setPreferences({ sound: event.target.checked })} /> {t('settings.sound')}</label>
          <label>{t('settings.soundVolume')}
            <input type="range" min="0" max="1" step="0.05" value={preferences.soundVolume}
              onChange={event => setPreferences({ soundVolume: Number(event.target.value) })} />
          </label>
          <fieldset className="preference-events">
            <legend>{t('settings.soundEvents')}</legend>
            {(['completion', 'attention'] as const).map(kind => <label key={kind}>
              <input type="checkbox" checked={preferences.soundEvents[kind]}
                onChange={event => setPreferences({ soundEvents: { ...preferences.soundEvents, [kind]: event.target.checked } })} />
              {t(`settings.event.${kind}`)}
            </label>)}
          </fieldset>
          <label><input type="checkbox" checked={preferences.notifications}
            onChange={async event => {
              const enabled = event.target.checked;
              if (enabled && 'Notification' in window && Notification.permission === 'default') {
                const permission = await Notification.requestPermission();
                setPreferences({ notifications: permission === 'granted' });
              } else setPreferences({ notifications: enabled });
            }} /> {t('settings.notifications')}</label>
          <fieldset className="preference-events notification-event-settings">
            <legend>{t('settings.notificationEvents')}</legend>
            {(['completion', 'attention'] as const).map(kind => <label key={kind}>
              <input type="checkbox" checked={preferences.notificationEvents[kind]}
                onChange={event => {
                  const next = { ...preferences.notificationEvents, [kind]: event.target.checked };
                  setPreferences({ notificationEvents: next });
                }} />
              {t(`settings.event.${kind}`)}
            </label>)}
          </fieldset>
          <label title={pushSupported() ? undefined : t('settings.push.unsupported')}>
            <input className="push-notification-toggle" type="checkbox" checked={preferences.pushNotifications} disabled={!pushSupported()}
              onChange={event => void configurePush(event.target.checked)} />
            {t('settings.push')}
          </label>
          <fieldset className="preference-events push-event-settings">
            <legend>{t('settings.pushEvents')}</legend>
            {(['completion', 'attention'] as const).map(kind => <label key={kind}>
              <input type="checkbox" checked={preferences.pushEvents[kind]}
                onChange={event => {
                  const next = { ...preferences.pushEvents, [kind]: event.target.checked };
                  setPreferences({ pushEvents: next });
                  if (preferences.pushNotifications) void configurePush(true, next);
                }} />
              {t(`settings.event.${kind}`)}
            </label>)}
          </fieldset>
          {pushStatus && <small role="status">{pushStatus}</small>}
          <label><input type="checkbox" checked={preferences.selectionActions}
            onChange={event => setPreferences({ selectionActions: event.target.checked })} /> {t('settings.selectionActions')}</label>
        </div>
      </section>

      <section className="settings-section" id="shortcuts">
        <h3>{t('settings.shortcuts')}</h3>
        <p className="settings-help">{t('settings.shortcutsHelp')}</p>
        <div className="shortcut-grid">
          {shortcutActions.map(action => {
            const chord = preferences.keybindings[action];
            const conflict = shortcutActions.some(other => other !== action && preferences.keybindings[other] === chord);
            return <label key={action} className={conflict ? 'conflict' : ''}>
              <span>{t(`shortcuts.${action}`)}</span>
              <input readOnly data-shortcut-capture value={shortcutLabel(chord)} aria-label={t('settings.shortcutFor', { action: t(`shortcuts.${action}`) })}
                onKeyDown={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === 'Backspace' || event.key === 'Delete') {
                    setPreferences({ keybindings: { ...preferences.keybindings, [action]: defaultKeybindings[action] } });
                    return;
                  }
                  const next = chordFromEvent(event.nativeEvent);
                  if (next) setPreferences({ keybindings: { ...preferences.keybindings, [action]: next } });
                }} />
              {conflict && <small>{t('settings.shortcutConflict')}</small>}
            </label>;
          })}
        </div>
        <button onClick={() => setPreferences({ keybindings: { ...defaultKeybindings } })}>{t('settings.shortcutsReset')}</button>
      </section>

      {/* Session Management */}
      <section className="settings-section" id="sessions">
        <h3>{t('settings.sessions')}</h3>
        <p>{t('settings.totalSessions', { count: sessionCount })}</p>
        <small>{t('settings.sessionsLocation')}</small>
      </section>

      {/* About */}
      <section className="settings-section about" id="about">
        <h3>{t('settings.about')}</h3>
        <p>{t('settings.aboutDescription')}</p>
        <div className="version-status" aria-live="polite">
          <dl>
            <dt>{t('settings.webVersion')}</dt><dd>{updateStatus?.webVersion ?? '…'}</dd>
            <dt>{t('settings.agentVersion')}</dt><dd>{updateStatus?.agentVersion ?? '…'}</dd>
          </dl>
          {checkingUpdate && <p>{t('settings.checkingUpdate')}</p>}
          {!checkingUpdate && updateStatus?.available && updateStatus.release && (
            <div className="update-available">
              <a href={updateStatus.release.url} target="_blank" rel="noopener noreferrer">
                {t('settings.updateAvailable', { version: updateStatus.release.version })}
              </a>
              {updateStatus.release.notes && <details>
                <summary>{t('settings.releaseNotes')}</summary>
                <pre>{updateStatus.release.notes}</pre>
              </details>}
            </div>
          )}
          {!checkingUpdate && updateStatus && !updateStatus.available && !updateStatus.error && (
            <p>{t('settings.upToDate')}</p>
          )}
          {!checkingUpdate && updateStatus?.error && (
            <details className="update-diagnostic">
              <summary>{t('settings.updateUnavailable')}</summary>
              <p><code>{updateStatus.error.code}</code> — {updateStatus.error.message}</p>
            </details>
          )}
          <button type="button" disabled={checkingUpdate} onClick={() => void checkForUpdate(true)}>
            {t('settings.checkAgain')}
          </button>
        </div>
        <div className="about-links">
          <a href="https://github.com/Fidigi/AiHarness#readme" target="_blank" rel="noopener noreferrer">
            📖 {t('settings.documentation')}
          </a>
          <span>•</span>
          <a href="https://github.com/Fidigi/AiHarness" target="_blank" rel="noopener noreferrer">
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
