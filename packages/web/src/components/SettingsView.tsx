// ============================================================
// Settings View Component - Provider Configuration
// ============================================================

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '../settings.css';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { generalSettingsPanel, generalSettingsPanels, modelSettingsPanel, modelSettingsPanels, settingsCategories, settingsSectionCategory, type GeneralSettingsPanel, type ModelSettingsPanel, type SettingsCategory } from './settings-categories';
import { useSessionStore } from '../store/session-store';
import { useI18n } from '../hooks/useI18n';
import { SettingsLocaleBoundary } from './SettingsLocaleBoundary';
import type { ProviderType } from '@ai-harness/core';
import type { TranslationFunction } from '../i18n/types';
import {
  getAppUpdateStatus,
  logoutWeb,
  setAuthToken,
  setProviderApiKey,
  type AppUpdateStatus,
} from '../services/api';
import { SubagentSettings } from './SubagentSettings';
import { McpSettings } from './McpSettings';
import { readPreferences, usePreferences } from '../store/preferences';
import { isSettingsSection, readSettingsNavigation, writeSettingsNavigation } from '../store/settings-navigation';
import { bindSettingsNavigation } from './settings-navigation';
import { chordFromEvent, defaultKeybindings, shortcutActions, shortcutLabel } from '../services/keyboard';
import { pushSupported, syncPushSubscription, type NotificationEvent } from '../services/push';
import {
  CustomModelSettings,
  DefaultModelSettings,
  ProviderLifecycleSettings,
  SkillRegistryPanel,
  ToolSettingsPanel,
} from './EcosystemSettings';

import { ResourceBatchReport, ResourceGroupButtons, useResourceBatches } from './ResourceBatchControls';
import { SkillContentPane } from './SkillContentPane';
import { Icon } from './Icon';

const PluginSettings = lazy(async () => ({
  default: (await import('./PluginSettings')).PluginSettings,
}));

type SaveStatus =
  | { key: string; provider?: ProviderType }
  | { detail: string };

function SettingsView({ entryRelease, entryEpoch, category, generalPanel, modelPanel }: {
  category: SettingsCategory;
  generalPanel: GeneralSettingsPanel;
  modelPanel: ModelSettingsPanel;
  entryRelease: { readonly current: (() => void) | null };
  entryEpoch: string;
}) {
  const providers = useSessionStore(state => state.providers);
  const setProvider = useSessionStore(state => state.setProvider);
  const updateApiKey = useSessionStore(state => state.updateApiKey);
  const setModel = useSessionStore(state => state.setModel);
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const batches = useResourceBatches();
  const skills = useSessionStore(state => state.skills);
  const hydrateSkillCatalog = useSessionStore(state => state.hydrateSkillCatalog);
  const sessionCount = useSessionStore(state => state.sessions.length);
  const workspaceId = useSessionStore(state => state.workspace?.id);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});
  const [providerReload, setProviderReload] = useState(0);
  const [providerInvalidation, setProviderInvalidation] = useState(0);
  const { t } = useI18n();
  const [authToken, updateAuthToken] = useState('');
  const [authApplied, setAuthApplied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Partial<Record<string, SaveStatus>>>({});
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<string>();
  const skillInvoker = useRef<HTMLButtonElement | null>(null);
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
  const visibleSkillGroups = (['project', 'global', 'path', 'package'] as const).flatMap(scope => {
    const candidates = (skills.catalog?.skills ?? []).filter(skill => skill.scope === scope && (
      !normalizedSkillFilter
      || skill.name.toLocaleLowerCase().includes(normalizedSkillFilter)
      || skill.description.toLocaleLowerCase().includes(normalizedSkillFilter)
      || skill.source.toLocaleLowerCase().includes(normalizedSkillFilter)
    ));
    const sources = scope === 'package' || scope === 'path' ? [...new Set(candidates.map(skill => skill.source))] : [''];
    return sources.map(source => ({ scope, source, skills: candidates.filter(skill => !source || skill.source === source) }));
  }).filter(group => group.skills.length > 0);

  const skillDetail = visibleSkillGroups.flatMap(group => group.skills).find(skill => skill.key === selectedSkill);

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
    // Preserve the accepted startup task order in this business lifetime: entry
    // alignment first, then deferred checking UI. The layout owner stays outside.
    const release = entryRelease.current;
    const timer = window.setTimeout(() => release?.(), 0);
    return () => window.clearTimeout(timer);
  }, [entryRelease, entryEpoch]);

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
    setSaveStatus(previous => { const next = { ...previous }; delete next[type]; return next; });
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

  const [vertexCredentialMode, setVertexCredentialMode] = useState<'api-key' | 'bearer'>('bearer');
  const saveApiKey = async (type: string) => {
    const key = apiKeyInputs[type];
    if (key && !key.includes('•')) {
      const result = await setProviderApiKey(type, key, undefined, type === 'vertex' ? vertexCredentialMode : undefined);
      if (result.success) {
        updateApiKey(type as ProviderType, 'configured');
        setApikeyInputs(previous => ({ ...previous, [type]: '••••••••' }));
        setSaveStatus(previous => ({ ...previous, [type]: {
          key: 'settings.providerConfiguredOnServer', provider: type as ProviderType,
        } }));
      } else {
        setSaveStatus(previous => ({ ...previous, [type]: result.error
          ? { detail: result.error } : { key: 'settings.configurationFailed' } }));
      }
    }
  };

  return (
    <>
      <section className="settings-section" id="authentication" hidden={category !== 'general' || generalPanel !== 'authentication'}>
        <h3>{t('settings.serverAuthentication')}</h3>
        <div className="api-key-input-group">
          <input
            type="password"
            value={authToken}
            placeholder={t('settings.bearerToken')}
            aria-label={t('settings.bearerToken')}
            onChange={event => { updateAuthToken(event.target.value); setAuthApplied(false); }}
          />
          <button onClick={() => {
            setAuthToken(authToken);
            setAuthApplied(true);
          }}>
            {t('settings.apply')}
          </button>
        </div>
        <button className="logout-button" onClick={() => void logoutWeb().finally(() => {
          window.dispatchEvent(new Event('aih-auth-required'));
        })}>{t('settings.logout')}</button>
        {authApplied && <p role="status">{t('settings.tokenApplied')}</p>}
      </section>

      <div hidden={category !== 'models'}>
      {/* AI Provider Configuration */}
      <section className="settings-section" id="providers" hidden={modelPanel !== 'providers'}>
        <h3>{t('settings.aiProvider')}</h3>
        <select
          value={providers.active}
          aria-label={t('settings.selectProvider')}
          onChange={handleProviderChange}
        >
          {Object.keys(providers.available).map(type => (
            <option key={type} value={type}>
              {providerNames[type] ? `${providerNames[type]} (${type})` : getProviderOptionLabel(type as ProviderType, t)}
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
            const status = saveStatus[type];
            const environmentVariable = type === 'vertex' && vertexCredentialMode === 'api-key' ? 'GOOGLE_CLOUD_API_KEY' : getTypeEnvVar(providerType);
            return (
              <div key={type} className={`api-key-row ${providers.active === type ? 'active' : ''}`}>
                <label>{providerLabel}</label>
                {type === 'vertex' && <select aria-label={t('settings.vertexCredentialMode')} value={vertexCredentialMode}
                  onChange={event => setVertexCredentialMode(event.target.value === 'api-key' ? 'api-key' : 'bearer')}>
                  <option value="bearer">{t('settings.vertexBearerCredential')}</option>
                  <option value="api-key">{t('settings.vertexCloudCredential')}</option>
                </select>}
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
                {status && <p role={'detail' in status || !status.provider ? 'alert' : 'status'}>
                  {'detail' in status ? status.detail : t(status.key, status.provider
                    ? { provider: getTypeLabel(status.provider, t) } : undefined)}
                </p>}
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

      <div hidden={modelPanel !== 'provider-lifecycle'}>
        <ProviderLifecycleSettings key={`${workspaceId}:${activeSessionId}:${providers.active}:${providerInvalidation}`}
          onSelectionInvalidated={() => setProviderInvalidation(value => value + 1)}
          onProvidersLoaded={items => setProviderNames(Object.fromEntries(items.map(item => [item.id, item.name])))}
          onCanonicalReload={() => setProviderReload(value => value + 1)} />
      </div>

      {/* Model Selection and server catalogue */}
      <section className="settings-section" id="model" hidden={modelPanel !== 'model'}>
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
              <button type="button" disabled={providers.catalogLoading || batches.busy} onClick={() => void hydrateModelCatalog(true)}>
                {t('settings.modelCatalog.refresh')}
              </button>
              <ResourceGroupButtons group={t('settings.modelCatalog.manage')}
                rows={visibleModelGroups.flatMap(group => group.models.map(model => ({ key: model.key, enabled: model.enabled })))}
                disabled={!!providers.catalogLoading || batches.busy}
                save={changes => batches.save('models', changes)} />
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
          <ResourceBatchReport busy={batches.busy} outcomes={batches.reports.models} error={batches.errors.models}
            names={new Map(providers.catalog?.providers.flatMap(group => group.models.map(model => [model.key, model.name] as const)))} />
          <div className="model-catalog-groups">
            {visibleModelGroups.map(group => (
              <fieldset key={group.provider} data-provider={group.provider} data-settings-group={group.provider}>
                <legend>
                  {getTypeLabel(group.provider as ProviderType, t)}
                  <span className={group.configured ? 'status-success' : 'status-warning'}>
                    {group.configured ? t('settings.modelCatalog.configured') : t('settings.modelCatalog.unavailable')}
                  </span>
                </legend>
                <ResourceGroupButtons group={getTypeLabel(group.provider as ProviderType, t)}
                  rows={group.models.map(model => ({ key: model.key, enabled: model.enabled }))}
                  disabled={!!providers.catalogLoading || batches.busy}
                  save={changes => batches.save('models', changes)} />
                {group.models.map(model => (
                  <label key={model.key} className="model-catalog-row" data-settings-selection={model.key}>
                    <input type="checkbox" checked={model.enabled} disabled={providers.catalogLoading || batches.busy}
                      aria-label={t('settings.modelCatalog.toggle', { model: model.name, provider: getTypeLabel(group.provider as ProviderType, t) })}
                      onChange={event => void batches.save('models', [{ key: model.key, enabled: event.target.checked }])} />
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

      <div hidden={modelPanel !== 'custom-models'}>
        <CustomModelSettings key={`provider-models:${providerReload}`} />
      </div>
      </div>

      <section className="settings-section" id="skills" hidden={category !== 'skills'}>
        <h3>{t('settings.skills.title')}</h3>
        <p className="settings-help">{t('settings.skills.help')}</p>
        <div className="model-catalog-toolbar">
          <label>
            <span>{t('settings.skills.filter')}</span>
            <input type="search" value={skillFilter} aria-label={t('settings.skills.filter')}
              onChange={event => setSkillFilter(event.target.value)} />
          </label>
          <div>
            <button type="button" disabled={skills.loading || batches.busy} onClick={() => void hydrateSkillCatalog(true)}>
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
        <ResourceBatchReport busy={batches.busy} outcomes={batches.reports.skills} error={batches.errors.skills}
          names={new Map(skills.catalog?.skills.map(skill => [skill.key, skill.name] as const))} />
        <div className="skill-catalog-groups">
          {visibleSkillGroups.map(group => (
            <fieldset key={`${group.scope}:${group.source}`} data-scope={group.scope} data-source={group.source}
              data-settings-group={JSON.stringify([group.scope, group.source])}>
              <legend>{t(`settings.skills.scope.${group.scope}`)}{group.source && ` · ${group.source}`}</legend>
              <ResourceGroupButtons group={group.source || t(`settings.skills.scope.${group.scope}`)}
                rows={group.skills.map(skill => ({ key: skill.key, enabled: skill.modelInvocable }))}
                disabled={!!skills.loading || batches.busy} save={changes => batches.save('skills', changes)} />
              {group.skills.map(skill => (
                <div key={skill.key} className="skill-catalog-row" data-settings-selection={skill.key}>
                  <label>
                    <input type="checkbox" checked={skill.modelInvocable}
                      disabled={skills.loading || batches.busy || !skill.trusted}
                      title={!skill.trusted ? t('settings.skills.requiresTrust') : undefined}
                      aria-label={t('settings.skills.toggle', { skill: skill.name })}
                      onChange={event => void batches.save('skills', [{ key: skill.key, enabled: event.target.checked }])} />
                    <span className="skill-catalog-identity">
                      <span>{skill.description}</span>
                      <code>{skill.filePath}</code>
                    </span>
                    <span className="model-capabilities" aria-label={t('settings.skills.metadata')}>
                      {skill.version && <small>v{skill.version}</small>}
                      <small>{skill.source}</small>
                      {!skill.trusted && <small className="unavailable">{t('settings.skills.untrusted')}</small>}
                    </span>
                  </label>
                  <button type="button" className="skill-instructions-trigger" disabled={skills.loading || batches.busy || !skill.trusted}
                    title={t('settings.skills.openInstructions', { skill: skill.name })}
                    aria-label={t('settings.skills.openInstructions', { skill: skill.name })} aria-expanded={selectedSkill === skill.key}
                    aria-controls={selectedSkill === skill.key ? 'skill-content-detail' : undefined}
                    onClick={event => { skillInvoker.current = event.currentTarget; setSelectedSkill(skill.key); }}>{skill.name}</button>
                </div>
              ))}
            </fieldset>
          ))}
        </div>
        {skillDetail && skills.catalog && <SkillContentPane
          key={JSON.stringify([skillDetail.key, skills.catalog.cwd, skills.catalog.projectId, skills.catalog.projectTrusted])}
          skillKey={skillDetail.key} name={skillDetail.name} cwd={skills.catalog.cwd} projectId={skills.catalog.projectId}
          onClose={() => { setSelectedSkill(undefined); if (skillInvoker.current?.isConnected) skillInvoker.current.focus(); }} />}
      </section>

      <div hidden={category !== 'tools'}><ToolSettingsPanel /></div>

      <div hidden={category !== 'plugins'}><Suspense fallback={(
        <section className="settings-section plugin-settings" id="plugins">
          <h3>{t('settings.plugins.title')}</h3>
          <p role="status">{t('common.loading')}…</p>
        </section>
      )}>
        <PluginSettings key={workspaceId ?? 'default-workspace'} presented={category === 'plugins'} />
      </Suspense></div>

      <div hidden={category !== 'subagents'}><SubagentSettings presented={category === 'subagents'} /></div>

      {/* Appearance */}
      <section className="settings-section" id="appearance" hidden={category !== 'general' || generalPanel !== 'appearance'}>
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
        </div>
      </section>

      <section className="settings-section" id="behavior" hidden={category !== 'general' || generalPanel !== 'behavior'}>
        <h3>{t('settings.behavior')}</h3>
        <div className="preference-grid">
          <label>{t('settings.sendMode')}
            <select value={preferences.sendMode}
              onChange={event => setPreferences({ sendMode: event.target.value as typeof preferences.sendMode })}>
              <option value="enter">{t('settings.sendMode.enter')}</option>
              <option value="mod-enter">{t('settings.sendMode.modEnter')}</option>
            </select>
          </label>
          <label className="preference-toggle"><input type="checkbox" checked={preferences.reasoningOpen}
            onChange={event => setPreferences({ reasoningOpen: event.target.checked })} /> {t('settings.reasoningOpen')}</label>
          <label className="preference-toggle"><input type="checkbox" checked={preferences.selectionActions}
            onChange={event => setPreferences({ selectionActions: event.target.checked })} /> {t('settings.selectionActions')}</label>
        </div>
      </section>
      <div hidden={category !== 'general' || generalPanel !== 'behavior'}><DefaultModelSettings key={`provider-defaults:${providerReload}`} /></div>

      <section className="settings-section" id="notifications" hidden={category !== 'general' || generalPanel !== 'notifications'}>
        <h3>{t('settings.notificationPreferences')}</h3>
        <div className="preference-grid">
          <label className="preference-toggle"><input type="checkbox" checked={preferences.sound}
            onChange={event => setPreferences({ sound: event.target.checked })} /> {t('settings.sound')}</label>
          <label>{t('settings.soundVolume')}
            <input type="range" min="0" max="1" step="0.05" value={preferences.soundVolume}
              onChange={event => setPreferences({ soundVolume: Number(event.target.value) })} />
          </label>
          <fieldset className="preference-events">
            <legend>{t('settings.soundEvents')}</legend>
            {(['completion', 'attention'] as const).map(kind => <label className="preference-toggle" key={kind}>
              <input type="checkbox" checked={preferences.soundEvents[kind]}
                onChange={event => setPreferences({ soundEvents: { ...preferences.soundEvents, [kind]: event.target.checked } })} />
              {t(`settings.event.${kind}`)}
            </label>)}
          </fieldset>
          <label className="preference-toggle"><input type="checkbox" checked={preferences.notifications}
            onChange={async event => {
              const enabled = event.target.checked;
              if (enabled && 'Notification' in window && Notification.permission === 'default') {
                const permission = await Notification.requestPermission();
                setPreferences({ notifications: permission === 'granted' });
              } else setPreferences({ notifications: enabled });
            }} /> {t('settings.notifications')}</label>
          <fieldset className="preference-events notification-event-settings">
            <legend>{t('settings.notificationEvents')}</legend>
            {(['completion', 'attention'] as const).map(kind => <label className="preference-toggle" key={kind}>
              <input type="checkbox" checked={preferences.notificationEvents[kind]}
                onChange={event => {
                  const next = { ...preferences.notificationEvents, [kind]: event.target.checked };
                  setPreferences({ notificationEvents: next });
                }} />
              {t(`settings.event.${kind}`)}
            </label>)}
          </fieldset>
          <label className="preference-toggle" title={pushSupported() ? undefined : t('settings.push.unsupported')}>
            <input className="push-notification-toggle" type="checkbox" checked={preferences.pushNotifications} disabled={!pushSupported()}
              onChange={event => void configurePush(event.target.checked)} />
            {t('settings.push')}
          </label>
          <fieldset className="preference-events push-event-settings">
            <legend>{t('settings.pushEvents')}</legend>
            {(['completion', 'attention'] as const).map(kind => <label className="preference-toggle" key={kind}>
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
        </div>
      </section>

      <section className="settings-section" id="shortcuts" hidden={category !== 'general' || generalPanel !== 'behavior'}>
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

      <div hidden={category !== 'mcp'}><McpSettings presented={category === 'mcp'} /></div>

      {/* About */}
      <section className="settings-section about" id="about" hidden={category !== 'general' || generalPanel !== 'about'}>
        <h3>{t('settings.about')}</h3>
        <p>{t('settings.aboutDescription')}</p>
        <section className="settings-section" id="sessions">
          <h4>{t('settings.sessions')}</h4>
          <p>{t('settings.totalSessions', { count: sessionCount })}</p>
          <small>{t('settings.sessionsLocation')}</small>
        </section>
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
            <Icon name="file" /> {t('settings.documentation')}
          </a>
          <span>•</span>
          <a href="https://github.com/Fidigi/AiHarness" target="_blank" rel="noopener noreferrer">
            <Icon name="star" /> {t('settings.starOnGitHub')}
          </a>
        </div>
      </section>
    </>
  );
}

/** Get the translated short label for a provider type. */
function getTypeLabel(type: ProviderType, t: TranslationFunction): string {
  const keys: Partial<Record<ProviderType, string>> = {
    openai: 'provider.label.openai',
    anthropic: 'provider.label.anthropic',
    google: 'provider.label.google',
    azure: 'provider.label.azure',
    bedrock: 'provider.label.bedrock',
    vertex: 'provider.label.vertex',
    local: 'provider.label.local',
    mock: 'provider.label.mock',
    custom: 'provider.label.custom',
  };
  const key = keys[type];
  return key ? t(key) : type;
}

/** Get the translated provider selector label. */
function getProviderOptionLabel(type: ProviderType, t: TranslationFunction): string {
  const keys: Partial<Record<ProviderType, string>> = {
    openai: 'provider.option.openai',
    anthropic: 'provider.option.anthropic',
    google: 'provider.option.google',
    azure: 'provider.option.azure',
    bedrock: 'provider.option.bedrock',
    vertex: 'provider.option.vertex',
    local: 'provider.option.local',
    mock: 'provider.option.mock',
    custom: 'provider.option.custom',
  };
  const key = keys[type];
  return key ? t(key) : type;
}

/** Get environment variable name for provider */
function getTypeEnvVar(type: ProviderType): string {
  const variables: Partial<Record<ProviderType, string>> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    bedrock: 'AWS_ACCESS_KEY_ID:AWS_SECRET_ACCESS_KEY',
    vertex: 'GOOGLE_VERTEX_ACCESS_TOKEN',
    local: '',
    mock: '',
    custom: 'CUSTOM_API_KEY',
  };
  return variables[type] || '';
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

function SettingsNavigationBoundary() {
  const workspace = useSessionStore(state => state.workspace);
  const root = useRef<HTMLDivElement>(null);
  const entryRelease = useRef<(() => void) | null>(null);
  const contextualNavigation = useRef<HTMLElement>(null);
  const contextBack = useRef<HTMLButtonElement>(null);
  const contextFocus = useRef(false);
  const [overview, setOverview] = useState(false);
  const cwd = workspace?.cwd;
  const { hash, pathname, search } = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const section = hash.replace(/^#/, '');
  // Peer storage writes may refresh metadata, never this mounted category choice.
  const initial = useMemo(() => readSettingsNavigation(cwd, readPreferences().lastSettingsSection), [cwd, hash]);
  const activeSection = isSettingsSection(section) ? section : initial.section;
  const category = settingsSectionCategory[activeSection];
  const panels = category === 'general' ? generalSettingsPanels : category === 'models' ? modelSettingsPanels : [];
  const panel = category === 'models' ? modelSettingsPanel(activeSection) : generalSettingsPanel(activeSection);
  const address = (section: string) => `${pathname}${search}#${section}`;
  const categorySection = (item: typeof settingsCategories[number]) => category === item.id ? activeSection
    : initial.categories?.[item.id] ?? item.section;
  const selectSection = (target: string) => {
    // Give a remembered /settings entry a stable Back target before leaving it.
    if (!isSettingsSection(section)) navigate(address(activeSection), { replace: true });
    navigate(address(target));
  };
  const selectCategory = (item: typeof settingsCategories[number]) => {
    if (item.id === category) return;
    selectSection(categorySection(item));
  };
  // Keep navigation/focus ownership across a trust refresh; retire all forms,
  // pending local results and mounted sections before the replacement commits.
  const context = JSON.stringify([workspace?.id, cwd, workspace?.trusted, workspace?.operationTrusted]);
  useLayoutEffect(() => { setOverview(false); }, [context, hash]);
  useLayoutEffect(() => {
    if (!contextFocus.current) return;
    contextFocus.current = false;
    if (category !== 'general' && category !== 'models') return;
    if (overview) contextualNavigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    else if (contextBack.current?.offsetParent) contextBack.current.focus();
  }, [overview, activeSection, category]);
  useLayoutEffect(() => {
    if (!root.current) return;
    const entryReady = new Promise<void>(resolve => { entryRelease.current = resolve; });
    let local = initial;
    const dispose = bindSettingsNavigation(root.current, local, {
      hash, entryReady,
      save: (section, position) => {
        const fresh = readSettingsNavigation(cwd);
        local = { ...local, section, scopes: fresh.scopes,
          categories: { ...local.categories, ...fresh.categories, [settingsSectionCategory[section]]: section },
          positions: { ...local.positions, ...fresh.positions,
            ...(position.group || position.selection ? { [section]: position } : {}) } };
        writeSettingsNavigation(cwd, local);
      },
    });
    return () => { entryRelease.current = null; dispose(); };
  }, [cwd, hash, initial]);
  return <div className="settings-layout">
    <nav className="settings-categories" aria-label={t('settings.categories')}>
      {settingsCategories.map(item => <Link key={item.id} to={address(categorySection(item))} aria-current={category === item.id ? 'page' : undefined}
        onClick={event => {
          if (!event.defaultPrevented && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault(); selectCategory(item);
          }
        }}>
        <Icon name={item.icon} />{t(`settings.category.${item.id}`)}
      </Link>)}
    </nav>
    <label className="settings-category-picker">{t('settings.categories')}
      <select value={category} onChange={event => selectCategory(settingsCategories.find(item => item.id === event.target.value)!)}>
        {settingsCategories.map(item => <option key={item.id} value={item.id}>{t(`settings.category.${item.id}`)}</option>)}
      </select>
    </label>
    <div className={`settings-content${panels.length && overview ? ' settings-content-overview' : ''}`}>
      <nav className="settings-context" ref={contextualNavigation} aria-label={t(category === 'models' ? 'settings.modelsNavigation' : 'settings.generalNavigation')} hidden={!panels.length}>
        {panels.map(item => <Link key={item.section} to={address(item.section)}
          aria-current={panel === item.section ? 'page' : undefined}
          onClick={event => {
            if (!event.defaultPrevented && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              event.preventDefault(); contextFocus.current = overview; setOverview(false); selectSection(item.section);
            }
          }}>{t(item.label)}</Link>)}
      </nav>
      <div className="settings-detail">
        <button type="button" className="settings-context-back" ref={contextBack} hidden={!panels.length}
          onClick={() => { contextFocus.current = true; setOverview(true); }}>{t(category === 'models' ? 'settings.modelsBack' : 'settings.generalBack')}</button>
        <div className="settings-view" ref={root}><SettingsView key={context} category={category}
          generalPanel={generalSettingsPanel(activeSection)} modelPanel={modelSettingsPanel(activeSection)}
          entryRelease={entryRelease} entryEpoch={JSON.stringify([cwd, hash])} /></div>
      </div>
    </div>
  </div>;
}

type SettingsDialogProps = { onClose: () => void; onEscape: () => void; onModalChange: (root: HTMLElement | null) => void; suspended: boolean };
function SettingsDialog({ onClose, onEscape, onModalChange, suspended }: SettingsDialogProps) {
  const root = useRef<HTMLElement>(null);
  const { t } = useI18n();
  useFocusTrap(!suspended, root, onEscape);
  useLayoutEffect(() => { onModalChange(root.current); return () => onModalChange(null); }, [onModalChange]);
  return createPortal(<div className="modal-backdrop settings-backdrop">
    <section className="settings-dialog" ref={root} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} inert={suspended || undefined}>
      <header className="settings-dialog-header"><h2 id="settings-title">{t('settings.title')}</h2>
        <button type="button" data-settings-entry-focus onClick={onClose} aria-label={t('common.close')}><Icon name="close" /></button>
      </header>
      <SettingsNavigationBoundary />
    </section>
  </div>, document.body);
}

function LocalizedSettingsView(props: SettingsDialogProps) {
  return <SettingsLocaleBoundary><SettingsDialog {...props} /></SettingsLocaleBoundary>;
}

export default LocalizedSettingsView;
