import { useEffect, useState } from 'react';
import type {
  CustomModelDefinition,
  CustomProviderDefinition,
  ProviderAuthStatus,
  SkillRegistry,
  ToolSettings,
} from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
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
} from '../services/api';

function error(message?: string): void {
  publishNotice(message || 'Operation failed.', { level: 'error' });
}

export function ProviderLifecycleSettings() {
  const { t } = useI18n();
  const hydrateProviders = useSessionStore(state => state.hydrateProviders);
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const [statuses, setStatuses] = useState<ProviderAuthStatus[]>([]);
  const [providers, setProviders] = useState<CustomProviderDefinition[]>([]);
  const [editing, setEditing] = useState<string>();
  const [oauthFlow, setOauthFlow] = useState<ProviderOAuthFlow>();
  const [form, setForm] = useState({ id: '', name: '', baseUrl: '', dialect: 'openai-completions', apiKey: '', headers: '{}' });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [auth, custom] = await Promise.all([getProviderAuthStatuses(), getCustomProviders()]);
    if (auth.success && auth.data) setStatuses(auth.data);
    if (custom.success && custom.data) setProviders(custom.data);
  };
  useEffect(() => { void load(); }, []);
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
        {providers.map(provider => <article key={provider.id} className="settings-resource-card">
          <div><strong>{provider.name}</strong><code>{provider.id}</code><small>{provider.dialect} · {provider.baseUrl}</small></div>
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
            result.success ? publishNotice(t('settings.connectionOk', { count: 1 }), { level: 'success' }) : error(result.error);
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
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [busy, setBusy] = useState(false);
  const projectScoped = scope === 'project';
  const load = async () => {
    const result = await getToolSettings(projectScoped ? workspace?.cwd : undefined, projectScoped ? workspace?.id : undefined);
    if (result.success && result.data) setSettings(result.data); else error(result.error);
  };
  useEffect(() => { void load(); }, [scope, workspace?.cwd, workspace?.id]);
  const persist = async (next: ToolSettings) => {
    setSettings(next); setBusy(true);
    const result = await updateToolSettings({
      enabledTools: next.tools.filter(tool => tool.enabled).map(tool => tool.name),
      toolPreset: next.preset ?? 'default', powershellEnabled: next.powershellEnabled,
      cwd: projectScoped ? workspace?.cwd : undefined, projectId: projectScoped ? workspace?.id : undefined,
    });
    if (result.success && result.data) setSettings(result.data); else { error(result.error); await load(); }
    setBusy(false);
  };
  return <section className="settings-section" id="tools">
    <h3>{t('settings.tools.title')}</h3>
    <label>{t('settings.scope')}<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
      <option value="global">{t('chat.scope.global')}</option>
      <option value="project" disabled={!workspace?.id}>{t('chat.scope.project')}</option>
    </select></label>
    {settings && <>
      <p className="settings-help">{t('settings.tools.scope', { scope: settings.scope, source: settings.source })}</p>
      <label>{t('settings.tools.defaultPreset')}<select value={settings.preset ?? 'default'} disabled={busy}
        onChange={event => void persist({ ...settings, preset: event.target.value as ToolSettings['preset'] })}>
        {['configured', 'chat-only', 'read-only', 'default', 'full'].map(preset => <option key={preset}>{preset}</option>)}
      </select></label>
      <div className="tool-settings-list">
        {settings.tools.map(tool => <label key={tool.name} title={tool.unavailableReason}>
          <input type="checkbox" checked={tool.enabled} disabled={busy || !tool.available}
            onChange={event => void persist({ ...settings, tools: settings.tools.map(item => item.name === tool.name ? { ...item, enabled: event.target.checked } : item) })} />
          <span><strong>{tool.name}</strong><small>{tool.description} · {tool.extensionId}</small></span>
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
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [values, setValues] = useState({ provider: '', model: '', toolPreset: '' });
  const [effective, setEffective] = useState<Awaited<ReturnType<typeof getEffectiveConfiguration>>['data']>();
  const scopeId = scope === 'project' ? workspace?.id : undefined;
  useEffect(() => {
    void Promise.all([getConfigurationScope(scope, scopeId), getEffectiveConfiguration(scopeId)]).then(([configured, resolved]) => {
      if (!configured.success || !configured.data) { error(configured.error); return; }
      setValues({
        provider: typeof configured.data.values.provider === 'string' ? configured.data.values.provider : '',
        model: typeof configured.data.values.model === 'string' ? configured.data.values.model : '',
        toolPreset: typeof configured.data.values.toolPreset === 'string' ? configured.data.values.toolPreset : '',
      });
      if (resolved.success) setEffective(resolved.data);
    });
  }, [scope, scopeId]);
  const environmentLocked = (key: 'provider' | 'model' | 'toolPreset') => effective?.provenance[key]?.scope === 'environment';
  return <section className="settings-section" id="defaults">
    <h3>{t('settings.defaults.title')}</h3>
    <p className="settings-help">{t('settings.defaults.help')}</p>
    {effective && <p className="settings-help defaults-provenance">
      {t('settings.defaults.effective', {
        provider: String(effective.values.provider ?? '—'),
        model: String(effective.values.model ?? '—'),
        preset: String(effective.values.toolPreset ?? 'default'),
      })}
      {' · '}{['provider', 'model', 'toolPreset'].map(key => `${key}: ${effective.provenance[key as keyof typeof effective.provenance]?.source ?? 'built-in'}`).join(' · ')}
    </p>}
    {scope === 'project' && Object.values(values).some(value => !value) && <p className="status-warning">{t('settings.defaults.inheritanceWarning')}</p>}
    <label>{t('settings.scope')}<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
      <option value="global">{t('chat.scope.global')}</option><option value="project" disabled={!workspace?.id}>{t('chat.scope.project')}</option>
    </select></label>
    <label>{t('settings.provider')}<input value={values.provider} disabled={environmentLocked('provider')}
      placeholder={`${t('chat.setting.auto')} · ${String(effective?.values.provider ?? '—')}`}
      onChange={event => setValues(current => ({ ...current, provider: event.target.value }))} /></label>
    <label>{t('settings.model')}<input value={values.model} disabled={environmentLocked('model')}
      placeholder={`${t('chat.setting.auto')} · ${String(effective?.values.model ?? '—')}`}
      onChange={event => setValues(current => ({ ...current, model: event.target.value }))} /></label>
    <label>{t('settings.tools.defaultPreset')}<select value={values.toolPreset} disabled={environmentLocked('toolPreset')}
      onChange={event => setValues(current => ({ ...current, toolPreset: event.target.value }))}>
      <option value="">{t('chat.setting.auto')} · {String(effective?.values.toolPreset ?? 'default')}</option>
      {['configured', 'chat-only', 'read-only', 'default', 'full'].map(preset => <option key={preset}>{preset}</option>)}
    </select></label>
    <button type="button" disabled={scope === 'project' && !scopeId} onClick={async () => {
      const result = await updateConfigurationScope(scope, {
        provider: values.provider || null,
        model: values.model || null,
        toolPreset: values.toolPreset || null,
      }, scopeId);
      if (result.success) {
        publishNotice(t('settings.defaults.saved'), { level: 'success' });
        const resolved = await getEffectiveConfiguration(scopeId);
        if (resolved.success) setEffective(resolved.data);
      } else error(result.error);
    }}>{t('common.save')}</button>
  </section>;
}
