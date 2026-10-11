import { useEffect, useRef, useState } from 'react';
import type {
  CustomModelDefinition,
  CustomProviderDefinition,
  ProviderAuthStatus,
  SkillRegistry,
  ToolSettings,
} from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import { ProviderRenamePanel } from './ProviderRenamePanel';
import { isRenameableProvider, type ProviderRenameResult } from '../services/provider-lifecycle';
import { providerSettingsMessage, type ProviderSettingsMessage } from './provider-settings-messages';
import { useSessionStore } from '../store/session-store';
import { publishNotice } from '../services/notices';
import {
  cancelProviderOAuth,
  deleteCustomModel,
  deleteCustomProvider,
  disconnectProvider,
  getConfigurationScope,
  getCustomModels,
  getEffectiveConfiguration,
  getCustomProviders,
  getProviders,
  getModelCatalog,
  getProviderAuthStatuses,
  getProviderOAuth,
  getSkillRegistry,
  getToolSettings,
  importCustomProviderModels,
  installRegistrySkill,
  saveCustomModel,
  saveCustomProvider,
  startProviderOAuth,
  testCustomModel,
  testProviderConnection,
  updateConfigurationScope,
  updateRegistrySkills,
  updateToolSettings,
  type ProviderOAuthFlow,
  type ProviderRenameCapability,
} from '../services/api';

function error(message?: string): void {
  publishNotice(message || 'Operation failed.', { level: 'error' });
}

export function ProviderLifecycleSettings({ onCanonicalReload, onProvidersLoaded, onSelectionInvalidated }: {
  onCanonicalReload?: () => void;
  onSelectionInvalidated?: () => void;
  onProvidersLoaded?: (providers: CustomProviderDefinition[]) => void;
}) {
  const { t, locale } = useI18n();
  const epoch = useRef(0);
  const mounted = useRef(false);
  const origin = useSessionStore.getState();
  const loadSequence = useRef(0);
  const [renameCapability, setRenameCapability] = useState<ProviderRenameCapability>({ supported: false, mode: 'disabled', reason: 'unavailable' });
  const hydrateProviders = useSessionStore(state => state.hydrateProviders);
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const [statuses, setStatuses] = useState<ProviderAuthStatus[]>([]);
  const [providers, setProviders] = useState<CustomProviderDefinition[]>([]);
  const [editing, setEditing] = useState<string>();
  const [oauthFlow, setOauthFlow] = useState<ProviderOAuthFlow>();
  const [form, setForm] = useState({ id: '', name: '', baseUrl: '', dialect: 'openai-completions', apiKey: '', headers: '{}' });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const generation = epoch.current;
    const sequence = ++loadSequence.current;
    const [auth, custom] = await Promise.all([getProviderAuthStatuses(), getCustomProviders()]);
    if (!mounted.current || generation !== epoch.current || sequence !== loadSequence.current) return;
    if (auth.success && auth.data) setStatuses(auth.data);
    setRenameCapability(custom.renameCapability);
    if (custom.success && custom.data) { setProviders(custom.data); onProvidersLoaded?.(custom.data); }
  };
  const reconcile = async (outcome?: ProviderRenameResult, notify = true, renameTarget?: string) => {
    const generation = epoch.current;
    const sequence = ++loadSequence.current;
    // Bound to the operation's rendered selection, not the selection after a
    // delayed mutation response. Navigation must never retarget this result.
    const initial = origin;
    const [auth, custom, actual, catalog, global, project, effective] = await Promise.all([
      getProviderAuthStatuses(), getCustomProviders(), getProviders(), getModelCatalog(initial.workspace?.id, true),
      getConfigurationScope('global'),
      initial.workspace?.id ? getConfigurationScope('project', initial.workspace.id) : Promise.resolve({ success: true }),
      getEffectiveConfiguration(initial.workspace?.id, initial.activeSessionId ?? undefined),
    ]);
    if (![auth, custom, actual, catalog, global, project, effective].every(result => result.success)
      || !actual.data || !custom.data || !catalog.data) throw new Error('Canonical reload failed');
    const current = useSessionStore.getState();
    if (!mounted.current || generation !== epoch.current || sequence !== loadSequence.current || current.workspace?.id !== initial.workspace?.id
      || current.activeSessionId !== initial.activeSessionId || current.providers.active !== initial.providers.active
      || outcome && current.providers.available[current.providers.active] !== initial.providers.available[initial.providers.active]) {
      // Ask the still-mounted Settings owner for a fresh, selection-bound read;
      // never apply this old operation's mutation result to the new selection.
      if (outcome) onSelectionInvalidated?.();
      return;
    }
    // Navigation/new selection owns its own reload.
    setStatuses(auth.data ?? []); setProviders(custom.data); setRenameCapability(custom.renameCapability);
    onProvidersLoaded?.(custom.data);
    useSessionStore.setState(state => {
      if (state.workspace?.id !== initial.workspace?.id || state.activeSessionId !== initial.activeSessionId
        || state.providers.active !== initial.providers.active
        || outcome && state.providers.available[state.providers.active] !== initial.providers.available[initial.providers.active]) return state;
      // Built-in credential inputs/selection are independent of discovery and
      // must remain present even if the server lists only configured providers.
      const builtins = Object.fromEntries((['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'local', 'mock'] as const)
        .map(type => [type, state.providers.available[type]]));
      const available = { ...builtins, ...Object.fromEntries(actual.data!.map(provider => {
        const group = catalog.data!.providers.find(item => item.provider === provider.type);
        const existing = state.providers.available[provider.type as keyof typeof state.providers.available];
        // Keep model selection only when still present at the same canonical source.
        const model = group?.models.some(item => item.id === existing?.model) ? existing!.model ?? ''
          : group?.models.find(item => item.enabled && item.available)?.id ?? '';
        return [provider.type, { type: provider.type, model, ...(provider.configured ? { apiKey: 'configured' } : {}) }];
      })) } as typeof state.providers.available;
      const renamed = outcome?.success && outcome.data && custom.data!.some(item => item.id === outcome.data!.id)
        ? outcome.data.id : undefined;
      const active = renamed && available[renamed as keyof typeof available]
        && (state.providers.active === renameTarget || !available[state.providers.active]) ? renamed
        : available[state.providers.active] ? state.providers.active : actual.data![0]?.type ?? 'mock';
      return { providers: { ...state.providers, available, active: active as typeof state.providers.active,
        catalog: catalog.data, catalogLoading: false, catalogError: undefined } };
    });
    if (notify) onCanonicalReload?.();
    if (outcome) {
      const refusal = ({ PROVIDER_IN_USE: 'inUse', PROVIDER_EXISTS: 'collision', PROVIDER_REGISTRY_STALE: 'stale',
        PROVIDER_ADMISSION_UNAVAILABLE: 'disabled', PROVIDER_ADMINISTRATION_BUSY: 'busy',
        PROVIDER_REBIND_UNAVAILABLE: 'unavailable', PROVIDER_ENVIRONMENT_LOCKED: 'environment',
        PROVIDER_UNSUPPORTED_REFERENCES: 'unsupported', PROVIDER_REFERENCE_STORE_UNAVAILABLE: 'unsupported' } as Record<string, ProviderSettingsMessage>)[
        outcome.code ?? ''];
      publishNotice(providerSettingsMessage(locale, outcome.success ? 'renamed' : outcome.uncertain ? 'uncertain' : refusal ?? 'failed'),
        { level: outcome.success ? 'success' : 'warning' });
    }
  };
  useEffect(() => {
    mounted.current = true;
    ++epoch.current;
    void load();
    void reconcile(undefined, false).catch(() => {
      if (mounted.current) setRenameCapability({ supported: false, mode: 'disabled', reason: 'unavailable' });
    });
    return () => { mounted.current = false; ++epoch.current; };
  }, []);
  useEffect(() => {
    if (!oauthFlow || oauthFlow.state !== 'pending') return;
    const timer = window.setTimeout(async () => {
      const result = await getProviderOAuth(oauthFlow.id);
      if (result.success && result.data) {
        setOauthFlow(result.data);
        if (result.data.state === 'connected') await Promise.all([load(), hydrateProviders(), hydrateModelCatalog(true)]);
      } else error(result.error);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [oauthFlow]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      let headers: Record<string, string> | undefined;
      try { if (form.headers.trim()) headers = JSON.parse(form.headers) as Record<string, string>; }
      catch { error(t('settings.customProviders.invalidHeaders')); return; }
      const result = await saveCustomProvider({
        id: form.id, name: form.name, baseUrl: form.baseUrl, dialect: form.dialect,
        ...(headers ? { headers } : {}),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      }, editing);
      if (!result.success) error(result.error);
      else {
        setEditing(undefined);
        setForm({ id: '', name: '', baseUrl: '', dialect: 'openai-completions', apiKey: '', headers: '{}' });
        publishNotice(t('settings.customProviders.saved'), { level: 'success' });
        await Promise.all([load(), hydrateProviders(), hydrateModelCatalog(true)]);
      }
    } finally { setBusy(false); }
  };
  return <section className="settings-section" id="provider-lifecycle">
    <h3>{t('settings.providerLifecycle')}</h3>
    <div className="provider-lifecycle-list">
      {statuses.filter(status => !providers.some(provider => provider.id === status.type)).map(status => <article key={status.type} className="settings-resource-card">
        <div><strong>{status.name}</strong><code>{status.type}</code></div>
        <span className={status.connected ? 'status-success' : 'status-warning'}>
          {status.connected ? t('settings.connected') : t('settings.disconnected')} · {status.method}
          {status.environmentVariable ? ` (${status.environmentVariable})` : ''}
          {status.usage ? ` · ${status.usage.requests ?? 0} requests · ${(status.usage.inputTokens ?? 0) + (status.usage.outputTokens ?? 0)} tokens · $${(status.usage.costUsd ?? 0).toFixed(4)}` : ''}
        </span>
        <div>
          {status.method === 'oauth' && <button type="button" onClick={async () => {
            const result = await startProviderOAuth(status.type);
            if (!result.success || !result.data) error(result.error); else setOauthFlow(result.data);
          }}>{status.connected ? t('settings.reconnect') : t('settings.connect')}</button>}
          <button type="button" disabled={!status.connected} onClick={async () => {
            const result = await testProviderConnection(status.type);
            if (result.success) {
              publishNotice(t('settings.connectionOk', { count: result.data?.models.length ?? 0 }), { level: 'success' });
              await load();
            } else error(result.error);
          }}>{t('settings.testConnection')}</button>
          {status.disconnectSupported && <button type="button" onClick={async () => {
            const result = await disconnectProvider(status.type);
            if (!result.success) error(result.error); else await load();
          }}>{t('settings.disconnect')}</button>}
        </div>
      </article>)}
    </div>
    {oauthFlow && <aside className="oauth-device-flow" role="status">
      <strong>{t('settings.oauth.title')}</strong>
      {oauthFlow.state === 'pending' ? <>
        <p>{t('settings.oauth.code')}: <code>{oauthFlow.userCode}</code></p>
        <a href={oauthFlow.verificationUriComplete || oauthFlow.verificationUri} target="_blank" rel="noopener noreferrer">{t('settings.oauth.open')}</a>
        <button type="button" onClick={async () => { await cancelProviderOAuth(oauthFlow.id); setOauthFlow(undefined); }}>{t('common.cancel')}</button>
      </> : <p>{oauthFlow.state === 'connected' ? t('settings.oauth.connected') : oauthFlow.error || oauthFlow.state}</p>}
    </aside>}
    <details className="custom-resource-editor" open={Boolean(editing)}>
      <summary>{t('settings.customProviders.manage')}</summary>
      <p className="settings-help">{t('settings.customProviders.security')}</p>
      <form onSubmit={event => void submit(event)}>
        <label>ID<input required pattern="[a-z][a-z0-9_-]{1,63}" disabled={Boolean(editing)} value={form.id}
          onChange={event => setForm(current => ({ ...current, id: event.target.value }))} /></label>
        <label>{t('settings.name')}<input required value={form.name}
          onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
        <label>{t('settings.baseUrl')}<input required type="url" value={form.baseUrl}
          onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))} /></label>
        <label>{t('settings.dialect')}<select value={form.dialect}
          onChange={event => setForm(current => ({ ...current, dialect: event.target.value }))}>
          <option value="openai-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="google">Google Generative Language</option>
        </select></label>
        <label>{t('settings.apiKey')}<input type="password" autoComplete="off" value={form.apiKey}
          placeholder={editing ? t('settings.keepExistingSecret') : ''}
          onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))} /></label>
        <label>{t('settings.customHeaders')}<textarea rows={3} value={form.headers}
          onChange={event => setForm(current => ({ ...current, headers: event.target.value }))} /></label>
        <div><button disabled={busy}>{t('common.save')}</button>{editing && <button type="button" onClick={() => {
          setEditing(undefined); setForm({ id: '', name: '', baseUrl: '', dialect: 'openai-completions', apiKey: '', headers: '{}' });
        }}>{t('common.cancel')}</button>}</div>
      </form>
      <div className="settings-resource-list">
        {providers.map(provider => <article key={provider.id} className={`settings-resource-card${isRenameableProvider(provider) ? ' provider-custom-card' : ''}`}>
          <div><strong>{provider.name}</strong><code>{provider.id}</code><small>{provider.dialect} · {provider.baseUrl}</small></div>
          {isRenameableProvider(provider) ? <ProviderRenamePanel provider={provider} reconcile={outcome => reconcile(outcome, true, provider.id)} capability={renameCapability}
            disabled={busy || Boolean(editing) || oauthFlow?.state === 'pending' || !renameCapability.supported}
            disabledReason={!renameCapability.supported ? renameCapability.reason === 'exclusive-host-required' ? 'disabled' : 'capabilityUnknown' : undefined} />
            : null}
          <span>{provider.configured ? t('settings.connected') : t('settings.disconnected')} · {provider.modelCount} models</span>
          <div>
            <button type="button" onClick={() => {
              setEditing(provider.id);
              setForm({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, dialect: provider.dialect, apiKey: '', headers: '' });
            }}>{t('common.edit')}</button>
            <button type="button" disabled={!provider.configured} onClick={async () => {
              const result = await testProviderConnection(provider.id);
              if (result.success) publishNotice(t('settings.connectionOk', { count: result.data?.models.length ?? 0 }), { level: 'success' });
              else error(result.error);
            }}>{t('settings.testConnection')}</button>
            {provider.configured && <button type="button" onClick={async () => {
              const result = await disconnectProvider(provider.id);
              if (!result.success) error(result.error); else await load();
            }}>{t('settings.disconnect')}</button>}
            <button type="button" onClick={async () => {
              const result = await importCustomProviderModels(provider.id);
              if (result.success) {
                publishNotice(t('settings.modelsImported', { count: result.data?.length ?? 0 }), { level: 'success' });
                await hydrateModelCatalog(true);
              } else error(result.error);
            }}>{t('settings.importModels')}</button>
            <button type="button" onClick={async () => {
              if (!window.confirm(t('settings.customProviders.deleteConfirm', { name: provider.name }))) return;
              const result = await deleteCustomProvider(provider.id);
              if (!result.success) error(result.error);
              else await Promise.all([load(), hydrateProviders(), hydrateModelCatalog(true)]);
            }}>{t('common.delete')}</button>
          </div>
        </article>)}
      </div>
    </details>
  </section>;
}

export function CustomModelSettings() {
  const { t } = useI18n();
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const [models, setModels] = useState<CustomModelDefinition[]>([]);
  const [editing, setEditing] = useState<string>();
  const empty = { provider: '', id: '', name: '', reasoning: false, imageInput: false, toolCalls: true, contextWindow: '', maxOutputTokens: '', inputPrice: '', outputPrice: '', cacheReadPrice: '', cacheWritePrice: '', compatibility: '{}' };
  const [form, setForm] = useState(empty);
  const load = async () => {
    const result = await getCustomModels();
    if (result.success && result.data) setModels(result.data);
  };
  useEffect(() => { void load(); }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    let compatibility: Record<string, string | number | boolean>;
    try { compatibility = JSON.parse(form.compatibility); }
    catch { error(t('settings.customModels.invalidCompatibility')); return; }
    const result = await saveCustomModel({
      provider: form.provider, id: form.id, name: form.name,
      capabilities: { reasoning: form.reasoning, imageInput: form.imageInput, toolCalls: form.toolCalls },
      ...(form.contextWindow ? { contextWindow: Number(form.contextWindow) } : {}),
      ...(form.maxOutputTokens ? { maxOutputTokens: Number(form.maxOutputTokens) } : {}),
      pricing: {
        ...(form.inputPrice ? { inputPerMillion: Number(form.inputPrice) } : {}),
        ...(form.outputPrice ? { outputPerMillion: Number(form.outputPrice) } : {}),
        ...(form.cacheReadPrice ? { cacheReadPerMillion: Number(form.cacheReadPrice) } : {}),
        ...(form.cacheWritePrice ? { cacheWritePerMillion: Number(form.cacheWritePrice) } : {}),
      }, compatibility,
    }, editing);
    if (!result.success) error(result.error);
    else { setEditing(undefined); setForm(empty); await Promise.all([load(), hydrateModelCatalog(true)]); }
  };
  return <section className="settings-section" id="custom-models">
    <h3>{t('settings.customModels.title')}</h3>
    <details className="custom-resource-editor">
      <summary>{editing ? t('settings.customModels.edit') : t('settings.customModels.create')}</summary>
      <form onSubmit={event => void submit(event)}>
        <label>{t('settings.provider')}<input required value={form.provider} onChange={event => setForm(current => ({ ...current, provider: event.target.value }))} /></label>
        <label>ID<input required value={form.id} onChange={event => setForm(current => ({ ...current, id: event.target.value }))} /></label>
        <label>{t('settings.name')}<input required value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
        <label><input type="checkbox" checked={form.reasoning} onChange={event => setForm(current => ({ ...current, reasoning: event.target.checked }))} /> reasoning</label>
        <label><input type="checkbox" checked={form.imageInput} onChange={event => setForm(current => ({ ...current, imageInput: event.target.checked }))} /> images</label>
        <label><input type="checkbox" checked={form.toolCalls} onChange={event => setForm(current => ({ ...current, toolCalls: event.target.checked }))} /> tools</label>
        <label>{t('settings.contextWindow')}<input type="number" min="1" value={form.contextWindow} onChange={event => setForm(current => ({ ...current, contextWindow: event.target.value }))} /></label>
        <label>{t('settings.maxOutput')}<input type="number" min="1" value={form.maxOutputTokens} onChange={event => setForm(current => ({ ...current, maxOutputTokens: event.target.value }))} /></label>
        <label>{t('settings.inputPrice')}<input type="number" min="0" step="any" value={form.inputPrice} onChange={event => setForm(current => ({ ...current, inputPrice: event.target.value }))} /></label>
        <label>{t('settings.outputPrice')}<input type="number" min="0" step="any" value={form.outputPrice} onChange={event => setForm(current => ({ ...current, outputPrice: event.target.value }))} /></label>
        <label>{t('settings.cacheReadPrice')}<input type="number" min="0" step="any" value={form.cacheReadPrice} onChange={event => setForm(current => ({ ...current, cacheReadPrice: event.target.value }))} /></label>
        <label>{t('settings.cacheWritePrice')}<input type="number" min="0" step="any" value={form.cacheWritePrice} onChange={event => setForm(current => ({ ...current, cacheWritePrice: event.target.value }))} /></label>
        <label>{t('settings.compatibility')}<textarea rows={3} value={form.compatibility} onChange={event => setForm(current => ({ ...current, compatibility: event.target.value }))} /></label>
        <div><button>{t('common.save')}</button>{editing && <button type="button" onClick={() => { setEditing(undefined); setForm(empty); }}>{t('common.cancel')}</button>}</div>
      </form>
    </details>
    <div className="settings-resource-list">
      {models.map(model => <article key={model.key} className="settings-resource-card">
        <div><strong>{model.name}</strong><code>{model.key}</code><small>{model.contextWindow ?? '—'} context · {model.maxOutputTokens ?? '—'} max output</small></div>
        <div>
          <button type="button" onClick={() => {
            setEditing(model.key); setForm({
              provider: model.provider, id: model.id, name: model.name,
              reasoning: model.capabilities.reasoning, imageInput: model.capabilities.imageInput, toolCalls: model.capabilities.toolCalls,
              contextWindow: model.contextWindow ? String(model.contextWindow) : '', maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
              inputPrice: model.pricing?.inputPerMillion === undefined ? '' : String(model.pricing.inputPerMillion),
              outputPrice: model.pricing?.outputPerMillion === undefined ? '' : String(model.pricing.outputPerMillion),
              cacheReadPrice: model.pricing?.cacheReadPerMillion === undefined ? '' : String(model.pricing.cacheReadPerMillion),
              cacheWritePrice: model.pricing?.cacheWritePerMillion === undefined ? '' : String(model.pricing.cacheWritePerMillion),
              compatibility: JSON.stringify(model.compatibility ?? {}, null, 2),
            });
          }}>{t('common.edit')}</button>
          <button type="button" onClick={async () => {
            const result = await testCustomModel(model.key);
            if (result.success) publishNotice(t('settings.connectionOk', { count: 1 }), { level: 'success' });
            else error(result.error);
          }}>{t('settings.testConnection')}</button>
          <button type="button" onClick={async () => {
            const result = await deleteCustomModel(model.key);
            if (!result.success) error(result.error); else await Promise.all([load(), hydrateModelCatalog(true)]);
          }}>{t('common.delete')}</button>
        </div>
      </article>)}
    </div>
  </section>;
}

export function ToolSettingsPanel() {
  const { t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [settings, setSettings] = useState<ToolSettings>();
  const [scope, setScope] = useState<'global' | 'project'>(workspace?.id ? 'project' : 'global');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const projectScoped = scope === 'project';
  const load = async () => {
    const generation = epoch.current;
    const result = await getToolSettings(projectScoped ? workspace?.cwd : undefined, projectScoped ? workspace?.id : undefined);
    if (generation !== epoch.current) return;
    if (result.success && result.data) setSettings(result.data); else error(result.error);
  };
  useEffect(() => {
    epoch.current++; setSettings(undefined); setBusy(false); void load();
    return () => { epoch.current++; };
  }, [scope, workspace?.cwd, workspace?.id]);
  const persist = async (next: ToolSettings) => {
    const generation = epoch.current;
    setBusy(true);
    const result = await updateToolSettings({
      enabledTools: next.tools.filter(tool => tool.enabled).map(tool => tool.name),
      toolPreset: next.preset ?? 'default', powershellEnabled: next.powershellEnabled,
      cwd: projectScoped ? workspace?.cwd : undefined, projectId: projectScoped ? workspace?.id : undefined,
      ...(next.codemode ? { codemodeEnabled: next.codemode.enabled, codemodeMode: next.codemode.mode,
        codemodeInlineBudget: next.codemode.inlineBudget } : {}),
    });
    if (generation !== epoch.current) return;
    if (result.success && result.data) setSettings(result.data); else { error(result.error); await load(); }
    setBusy(false);
  };
  return <section className="settings-section" id="tools">
    <h3>{t('settings.tools.title')}</h3>
    <label>{t('settings.scope')}<select value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}>
      <option value="global">{t('chat.scope.global')}</option>
      <option value="project" disabled={!workspace?.id}>{t('chat.scope.project')}</option>
    </select></label>
    {settings && <>
      <p className="settings-help">{t('settings.tools.scope', { scope: settings.scope, source: settings.source })}</p>
      <label>{t('settings.tools.defaultPreset')}<select value={settings.preset ?? 'default'} disabled={busy}
        onChange={event => void persist({ ...settings, preset: event.target.value as ToolSettings['preset'] })}>
        {['configured', 'chat-only', 'read-only', 'default', 'full'].map(preset => <option key={preset}>{preset}</option>)}
      </select></label>
      {settings.codemode && <fieldset className="codemode-settings">
        <legend>{t('settings.codemode.title')}</legend>
        <p role="status">QuickJS · {t(`settings.codemode.selfTest.${settings.codemode.selfTest.state}`)}</p>
        <label>{t('settings.codemode.activation')}<select value={settings.codemode.enabled ? 'on' : 'automatic'} disabled={busy || settings.codemode.selfTest.state !== 'passed'}
          onChange={event => void persist({ ...settings,
            tools: settings.tools.map(tool => tool.name === 'codemode' ? { ...tool, enabled: true } : tool),
            codemode: { ...settings.codemode!, enabled: event.target.value === 'on' } })}>
          <option value="automatic">{t('settings.codemode.automatic')}</option>
          <option value="on">{t('settings.codemode.always')}</option>
        </select></label>
        <label>{t('settings.codemode.mode')}<select value={settings.codemode.mode} disabled={busy}
          onChange={event => void persist({ ...settings, codemode: { ...settings.codemode!, mode: event.target.value as 'on' | 'only' } })}>
          <option value="on">on</option><option value="only">only</option>
        </select></label>
        <label>{t('settings.codemode.inlineBudget')}<input key={`${scope}:${settings.codemode.inlineBudget}`} type="number" min="0" max="3000" step="100" defaultValue={settings.codemode.inlineBudget} disabled={busy}
          onBlur={event => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isSafeInteger(value) && value >= 0 && value <= 3000 && value !== settings.codemode!.inlineBudget) {
              void persist({ ...settings, codemode: { ...settings.codemode!, inlineBudget: value } });
            } else event.currentTarget.value = String(settings.codemode!.inlineBudget);
          }} /></label>
        <p className="settings-help">{t('settings.codemode.limits')}</p>
        <p className="settings-help">{t('settings.codemode.warning')}</p>
      </fieldset>}
      <div className="tool-settings-list">
        {settings.tools.map(tool => <label key={tool.name}>
          <input type="checkbox" checked={tool.enabled} disabled={busy || !tool.available}
            onChange={event => void persist({ ...settings, tools: settings.tools.map(item => item.name === tool.name ? { ...item, enabled: event.target.checked } : item) })} />
          <span><strong>{tool.name}</strong><small>{tool.description} · {tool.extensionId}</small>
            {tool.disabledReason && <small>{t(`settings.tools.reason.${tool.disabledReason}`)}</small>}
            {tool.unavailableReason && <small>{tool.unavailableReason}</small>}
          </span>
        </label>)}
      </div>
      <label><input type="checkbox" checked={settings.powershellEnabled} disabled={busy || !settings.powershellAvailable}
        onChange={event => void persist({ ...settings, powershellEnabled: event.target.checked })} /> {t('settings.tools.powershell')}</label>
    </>}
  </section>;
}

export function SkillRegistryPanel() {
  const { t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const hydrateSkills = useSessionStore(state => state.hydrateSkillCatalog);
  const [registry, setRegistry] = useState<SkillRegistry>();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [busy, setBusy] = useState(false);
  const load = async (refresh = false) => {
    const result = await getSkillRegistry(query, workspace?.cwd, workspace?.id, refresh);
    if (result.success && result.data) setRegistry(result.data); else error(result.error);
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [query, workspace?.cwd, workspace?.id]);
  const install = async (id: string) => {
    setBusy(true);
    const result = await installRegistrySkill({ id, scope, cwd: workspace?.cwd, projectId: workspace?.id });
    if (!result.success) error(result.error); else {
      await hydrateSkills(true); await load(true);
      publishNotice(t('settings.skills.registryInstalled'), { level: 'success' });
    }
    setBusy(false);
  };
  return <details className="skill-registry">
    <summary>{t('settings.skills.registry')}</summary>
    <div className="model-catalog-toolbar">
      <label>{t('settings.skills.registrySearch')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label={t('settings.skills.installScope')} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
        <option value="project">{t('settings.skills.scope.project')}</option><option value="global">{t('settings.skills.scope.global')}</option>
      </select>
      <button type="button" disabled={busy} onClick={() => void load(true)}>{t('common.refresh')}</button>
      <button type="button" disabled={busy || !registry?.entries.some(entry => entry.installed?.scope === scope && entry.installed.updateAvailable)}
        onClick={async () => {
          setBusy(true);
          const result = await updateRegistrySkills({ all: true, scope, cwd: workspace?.cwd, projectId: workspace?.id });
          if (!result.success) error(result.error); else { await hydrateSkills(true); await load(true); }
          setBusy(false);
        }}>{t('settings.skills.updateAll')}</button>
    </div>
    {registry?.error && <p role="alert" className="status-warning">{registry.error}</p>}
    <div className="settings-resource-list">
      {registry?.entries.map(entry => <article className="settings-resource-card" key={entry.id}>
        <div><strong>{entry.name}</strong><span>{entry.description}</span><code>v{entry.version}</code></div>
        <div>
          {entry.installed && <small>{t('settings.skills.installedVersion', { version: entry.installed.version ?? '?' })}</small>}
          <button type="button" disabled={busy || entry.installed?.scope === scope && !entry.installed.updateAvailable}
            onClick={() => void install(entry.id)}>{entry.installed?.updateAvailable ? t('settings.skills.update') : t('settings.skills.install')}</button>
        </div>
      </article>)}
    </div>
  </details>;
}

export function DefaultModelSettings() {
  const { t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [scope, setScope] = useState<'global' | 'project'>(workspace?.id ? 'project' : 'global');
  const [values, setValues] = useState({ provider: '', model: '', thinking: '', toolPreset: '' });
  const [dirty, setDirty] = useState<Array<keyof typeof values>>([]);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [overrideWarning, setOverrideWarning] = useState(false);
  const change = (key: keyof typeof values, value: string) => {
    setValues(current => ({ ...current, [key]: value }));
    setDirty(current => [...new Set([...current, key])]);
  };
  const [effective, setEffective] = useState<Awaited<ReturnType<typeof getEffectiveConfiguration>>['data']>();
  const scopeId = scope === 'project' ? workspace?.id : undefined;
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setReady(false); setDirty([]); setOverrideWarning(false);
    if (scope === 'project' && !scopeId) { setScope('global'); return; }
    void Promise.all([getConfigurationScope(scope, scopeId), getEffectiveConfiguration(workspace?.id)]).then(([configured, resolved]) => {
      if (cancelled) return;
      setBusy(false);
      if (!configured.success || !configured.data || !resolved.success || !resolved.data) {
        error(configured.error || resolved.error); return;
      }
      setReady(true);
      setValues({
        provider: typeof configured.data.values.provider === 'string' ? configured.data.values.provider : '',
        model: typeof configured.data.values.model === 'string' ? configured.data.values.model : '',
        thinking: typeof configured.data.values.thinking === 'string' ? configured.data.values.thinking : '',
        toolPreset: typeof configured.data.values.toolPreset === 'string' ? configured.data.values.toolPreset : '',
      });
      setEffective(resolved.data);
    });
    return () => { cancelled = true; };
  }, [scope, scopeId, workspace?.id]);
  const environmentLocked = (key: keyof typeof values) => effective?.provenance[key]?.scope === 'environment';
  return <section className="settings-section" id="defaults">
    <h3>{t('settings.defaults.title')}</h3>
    <p className="settings-help">{t('settings.defaults.help')}</p>
    {effective && <p className="settings-help defaults-provenance">
      {t('settings.defaults.effective', {
        provider: String(effective.values.provider ?? '—'),
        model: String(effective.values.model ?? '—'),
        preset: String(effective.values.toolPreset ?? 'default'),
      })}
      {' · '}{['provider', 'model', 'thinking', 'toolPreset'].map(key => `${key}: ${effective.provenance[key as keyof typeof effective.provenance]?.source ?? 'built-in'}`).join(' · ')}
    </p>}
    {scope === 'project' && Object.values(values).some(value => !value) && <p className="status-warning">{t('settings.defaults.inheritanceWarning')}</p>}
    {overrideWarning && <p role="status" className="status-warning">{t('settings.defaults.overrideWarning')}</p>}
    {!ready && !busy && <p role="alert">{t('settings.defaults.failed')}</p>}
    <label>{t('settings.scope')}<select value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}>
      <option value="global">{t('chat.scope.global')}</option><option value="project" disabled={!workspace?.id}>{t('chat.scope.project')}</option>
    </select></label>
    <label>{t('settings.provider')}<input value={values.provider} disabled={busy || !ready || environmentLocked('provider')}
      placeholder={`${t('chat.setting.auto')} · ${String(effective?.values.provider ?? '—')}`}
      onChange={event => change('provider', event.target.value)} /></label>
    <label>{t('settings.model')}<input value={values.model} disabled={busy || !ready || environmentLocked('model')}
      placeholder={`${t('chat.setting.auto')} · ${String(effective?.values.model ?? '—')}`}
      onChange={event => change('model', event.target.value)} /></label>
    <label>{t('chat.thinking')}<select value={values.thinking} disabled={busy || !ready || environmentLocked('thinking')}
      onChange={event => change('thinking', event.target.value)}>
      <option value="">{t('chat.setting.auto')} · {String(effective?.values.thinking ?? 'off')}</option>
      {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level}>{level}</option>)}
    </select></label>
    <label>{t('settings.tools.defaultPreset')}<select value={values.toolPreset} disabled={busy || !ready || environmentLocked('toolPreset')}
      onChange={event => change('toolPreset', event.target.value)}>
      <option value="">{t('chat.setting.auto')} · {String(effective?.values.toolPreset ?? 'default')}</option>
      {['configured', 'chat-only', 'read-only', 'default', 'full'].map(preset => <option key={preset}>{preset}</option>)}
    </select></label>
    <button type="button" disabled={busy || !ready || !dirty.length || scope === 'project' && !scopeId} onClick={async () => {
      setBusy(true);
      try {
        const changed = dirty.filter(key => !environmentLocked(key));
        const result = await updateConfigurationScope(scope,
          Object.fromEntries(changed.map(key => [key, values[key] || null])), scopeId);
        if (!result.success) { error(result.error); return; }
        setDirty([]);
        const resolved = await getEffectiveConfiguration(workspace?.id);
        if (resolved.success && resolved.data) {
          setEffective(resolved.data);
          const overridden = scope === 'global' && changed.some(key => ['project', 'environment'].includes(resolved.data!.provenance[key]?.scope ?? ''));
          setOverrideWarning(overridden);
          publishNotice(t(overridden ? 'settings.defaults.overrideWarning' : 'settings.defaults.saved'), { level: overridden ? 'warning' : 'success' });
        } else error(resolved.error);
      } finally { setBusy(false); }
    }}>{t('common.save')}</button>
  </section>;
}
