import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type {
  CustomModelDefinition,
  CustomProviderDefinition,
  ProviderAuthStatus,
  SkillRegistry,
  ToolSettings,
} from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import { ProviderRenamePanel } from './ProviderRenamePanel';
import { CacheNoticeSettings } from './CacheNoticeSettings';
import { OAuthPastePanel } from './OAuthPastePanel';
import { isRenameableProvider, type ProviderRenameResult } from '../services/provider-lifecycle';
import { providerSettingsMessage, type ProviderSettingsMessage } from './provider-settings-messages';
import { reasoningSettingsMessage } from './reasoning-settings-messages';
import { settingsAdminMessage, type SettingsAdminMessage } from './settings-admin-messages';
import { useSessionStore } from '../store/session-store';
import { useSettingsScope } from '../store/use-settings-scope';
import { readSettingsNavigation, writeSettingsNavigation } from '../store/settings-navigation';
import { toolSettingsMessage } from './tool-settings-messages';
import { providerContextMessage } from './provider-context-messages';
import { customModelMessage } from './custom-model-messages';
import { registryContextMessage } from './registry-context-messages';
import { useSettingsDraft, useSettingsDraftGuard } from './settings-drafts';
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
  submitProviderOAuthRedirect,
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

function customProviderForm(provider: CustomProviderDefinition) {
  return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, dialect: provider.dialect, apiKey: '', headers: '' };
}

export function ProviderLifecycleSettings({ presented, onCanonicalReload, onProvidersLoaded, onSelectionInvalidated, discardFormRef }: {
  presented: boolean;
  discardFormRef?: RefObject<((discard: () => void) => void) | null>;
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
  const editChoices = useRef(providers);
  useLayoutEffect(() => { editChoices.current = providers; }, [providers]);
  const [editing, setEditing] = useState<string>();
  const [oauthFlow, setOauthFlow] = useState<ProviderOAuthFlow>();
  const [oauthStarting, setOauthStarting] = useState(false);
  const oauthOperation = useRef<{ provider: string; group: 'builtin' | 'custom'; method: 'device' | 'browser' | 'copy-code'; controller: AbortController; flow?: ProviderOAuthFlow } | undefined>(undefined);
  const retireOAuth = () => {
    const previous = oauthOperation.current;
    oauthOperation.current = undefined;
    if (previous) ++loadSequence.current;
    previous?.controller.abort();
    if (previous?.flow?.state === 'pending') void cancelProviderOAuth(previous.flow.id);
  };
  const empty = { id: '', name: '', baseUrl: '', dialect: 'openai-completions', apiKey: '', headers: '{}' };
  const [form, setForm] = useState(empty);
  const editorState = useRef({ editing, form });
  useLayoutEffect(() => { editorState.current = { editing, form }; }, [editing, form]);
  const formBaseline = useRef(form);
  const editorSummary = useRef<HTMLElement>(null);
  const guardFormDiscard = useSettingsDraftGuard((Object.keys(form) as Array<keyof typeof form>)
    .some(key => form[key] !== formBaseline.current[key]), editorSummary);
  useLayoutEffect(() => {
    if (!discardFormRef) return;
    discardFormRef.current = guardFormDiscard;
    return () => { if (discardFormRef.current === guardFormDiscard) discardFormRef.current = null; };
  }, [discardFormRef, guardFormDiscard]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [position, setPosition] = useState(() => readSettingsNavigation(origin.workspace?.cwd).positions['provider-lifecycle']);
  const positionRef = useRef(position);
  const navigationEpoch = useRef(0);
  const navigationGeneration = navigationEpoch.current;
  const [overview, setOverview] = useState(!position?.selection);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 959px)').matches);
  const navigation = useRef<HTMLElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const focus = useRef<'navigation' | 'detail' | null>(null);
  const prefix = useId();
  const builtinStatuses = statuses.filter(status => !providers.some(provider => provider.id === status.type));
  const groups = [
    { id: 'builtin' as const, rows: builtinStatuses.map(status => ({ id: status.type, name: status.name, connected: status.connected })) },
    { id: 'custom' as const, rows: providers.map(provider => ({ id: provider.id, name: provider.name, connected: provider.configured })) },
  ];
  const choices = groups.flatMap(group => group.rows.map(row => ({ ...row, group: group.id })));
  const matches = choices.filter(choice => choice.group === position?.group && choice.id === position?.selection);
  const selected = position?.selection ? matches.length === 1 ? matches[0] : undefined
    : position?.group ? choices.find(choice => choice.group === position.group) : choices[0];
  useEffect(() => {
    const query = window.matchMedia('(max-width: 959px)');
    const resize = () => {
      if (query.matches && detail.current?.contains(document.activeElement)) setOverview(false);
      setMobile(query.matches);
    };
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);
  useLayoutEffect(() => {
    if (!presented || !focus.current) return;
    const target = focus.current; focus.current = null;
    if (target === 'navigation') {
      const current = navigation.current?.querySelector<HTMLElement>('[aria-current="true"]:not(:disabled)');
      (current ?? navigation.current)?.focus();
    } else if (mobile && !overview) back.current?.focus();
  }, [presented, mobile, overview, selected]);
  const selectProviderChoice = (group: 'builtin' | 'custom', selection: string, explicit = true) => {
    const next = { group, selection };
    positionRef.current = next; setPosition(next); ++navigationEpoch.current; setOverview(false);
    focus.current = explicit && mobile ? 'detail' : null;
    const current = readSettingsNavigation(origin.workspace?.cwd);
    writeSettingsNavigation(origin.workspace?.cwd, { ...current,
      ...(explicit ? { section: 'provider-lifecycle' as const } : {}),
      positions: { ...current.positions, 'provider-lifecycle': next } });
  };
  const captureProviderChoice = (group: 'builtin' | 'custom', selection: string) => {
    if (positionRef.current?.group !== group || positionRef.current?.selection !== selection) selectProviderChoice(group, selection, false);
  };
  const load = async () => {
    const generation = epoch.current;
    const sequence = ++loadSequence.current;
    const [auth, custom] = await Promise.all([getProviderAuthStatuses(), getCustomProviders()]);
    if (!mounted.current || generation !== epoch.current || sequence !== loadSequence.current) return;
    if (auth.success && auth.data) setStatuses(auth.data);
    setRenameCapability(custom.renameCapability);
    if (custom.success && custom.data) { setProviders(custom.data); onProvidersLoaded?.(custom.data); }
    setLoaded(true);
    return custom.success ? custom.data : undefined;
  };
  const reconcile = async (outcome?: ProviderRenameResult, notify = true, renameTarget?: string, choiceGeneration?: number) => {
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
      else if (mounted.current && generation === epoch.current && sequence === loadSequence.current) await load();
      return;
    }
    // Navigation/new selection owns its own reload.
    setStatuses(auth.data ?? []); setProviders(custom.data); setRenameCapability(custom.renameCapability); setLoaded(true);
    onProvidersLoaded?.(custom.data);
    const renamedChoice = outcome?.success && outcome.data && custom.data.filter(provider => provider.id === outcome.data!.id).length === 1
      ? outcome.data.id : undefined;
    if (renamedChoice && navigationEpoch.current === choiceGeneration && positionRef.current?.group === 'custom'
      && positionRef.current.selection === renameTarget) selectProviderChoice('custom', renamedChoice, false);
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
      if (mounted.current) { setRenameCapability({ supported: false, mode: 'disabled', reason: 'unavailable' }); void load(); }
    });
    return () => { mounted.current = false; ++epoch.current; retireOAuth(); };
  }, []);
  useEffect(() => {
    const operation = oauthOperation.current;
    if (!oauthFlow || oauthFlow.state !== 'pending' || !operation) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      const result = await getProviderOAuth(oauthFlow.id, operation.controller.signal);
      if (!active || !mounted.current || oauthOperation.current !== operation || operation.controller.signal.aborted) return;
      if (result.success && result.data) {
        operation.flow = result.data;
        setOauthFlow(result.data);
        if (result.data.state === 'connected') await reconcile().catch(() => {
          if (mounted.current && oauthOperation.current === operation) error();
        });
      } else error(result.error);
    }, 2_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [oauthFlow]);
  const login = async (provider: string, method: 'device' | 'browser' | 'copy-code' = 'device') => {
    retireOAuth();
    const group: 'builtin' | 'custom' = providers.some(item => item.id === provider) ? 'custom' : 'builtin';
    const operation = { provider, group, method, controller: new AbortController(), flow: undefined as ProviderOAuthFlow | undefined };
    oauthOperation.current = operation;
    setOauthFlow(undefined); setOauthStarting(true);
    const result = await startProviderOAuth(provider, operation.controller.signal, method);
    if (!mounted.current || oauthOperation.current !== operation || operation.controller.signal.aborted) {
      if (result.data?.state === 'pending') void cancelProviderOAuth(result.data.id);
      return;
    }
    setOauthStarting(false);
    if (!result.success || !result.data) error(result.error);
    else { operation.flow = result.data; setOauthFlow(result.data); }
  };
  const completeOAuth = async (value: string) => {
    const operation = oauthOperation.current;
    if (!operation?.flow?.authorizationUrl || operation.flow.state !== 'pending') return;
    const result = await submitProviderOAuthRedirect(operation.flow.id, value, operation.controller.signal);
    if (!mounted.current || oauthOperation.current !== operation || operation.controller.signal.aborted) return;
    if (!result.success || !result.data) error(result.error);
    else {
      operation.flow = result.data; setOauthFlow(result.data);
      await reconcile().catch(() => { if (mounted.current && oauthOperation.current === operation) error(); });
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const generation = epoch.current, choiceGeneration = navigationEpoch.current;
    try {
      let headers: Record<string, string> | undefined;
      try { if (form.headers.trim()) headers = JSON.parse(form.headers) as Record<string, string>; }
      catch { error(t('settings.customProviders.invalidHeaders')); return; }
      const baseline = formBaseline.current;
      const result = await saveCustomProvider({
        id: form.id, name: form.name, baseUrl: form.baseUrl, dialect: form.dialect,
        ...(headers ? { headers } : {}),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      }, editing);
      if (!result.success) error(result.error);
      else {
        const current = editorState.current;
        if (result.data?.id === (editing || form.id) && current.editing === editing && current.form.id === form.id && formBaseline.current === baseline
          && (Object.keys(form) as Array<keyof typeof form>).some(key => current.form[key] !== form[key])) {
          const saved = customProviderForm(result.data), next: typeof form = { ...saved };
          for (const key of Object.keys(form) as Array<keyof typeof form>) {
            if (current.form[key] !== form[key]) next[key] = current.form[key];
          }
          formBaseline.current = saved; setEditing(saved.id); setForm(next);
        } else { setEditing(undefined); formBaseline.current = empty; setForm(empty); }
        publishNotice(t('settings.customProviders.saved'), { level: 'success' });
        const [canonical] = await Promise.all([load(), hydrateProviders(), hydrateModelCatalog(true)]);
        if (mounted.current && generation === epoch.current && choiceGeneration === navigationEpoch.current && result.data?.id
          && canonical?.filter(provider => provider.id === result.data!.id).length === 1) selectProviderChoice('custom', result.data.id, false);
      }
    } finally { setBusy(false); }
  };
  return <section className="settings-section" id="provider-lifecycle">
    <h3>{t('settings.providerLifecycle')}</h3>
    <CacheNoticeSettings />
    {loaded && (position?.group || position?.selection) && !selected && <p role="status">{providerContextMessage(locale, 'unavailable')}</p>}
    <div className="provider-context">
      <nav ref={navigation} aria-label={providerContextMessage(locale, 'navigation')} tabIndex={-1} hidden={mobile && !overview && !!selected}>
        {groups.filter(group => group.rows.length > 0).map(group => <div key={group.id} role="group" aria-label={providerContextMessage(locale, group.id)}>
          <h4>{providerContextMessage(locale, group.id)}</h4>
          {group.rows.map((row, index) => {
            const id = `${prefix}-${group.id}-${index}`, current = selected?.group === group.id && selected.id === row.id;
            return <button key={row.id} type="button" aria-label={`${row.name} (${row.id})`}
              aria-current={current ? 'true' : undefined} aria-expanded={current && (!mobile || !overview)}
              aria-controls={id} aria-describedby={`${id}-summary`} onClick={() => selectProviderChoice(group.id, row.id)}>
              <strong>{row.name}</strong><code>{row.id}</code>
              <small id={`${id}-summary`}>{row.connected ? t('settings.connected') : t('settings.disconnected')}</small>
            </button>;
          })}
        </div>)}
      </nav>
      <div ref={detail} className="provider-context-detail">
        <button ref={back} type="button" className="provider-context-back" hidden={!mobile || overview || !selected}
          onClick={() => { ++navigationEpoch.current; focus.current = 'navigation'; setOverview(true); }}>{providerContextMessage(locale, 'back')}</button>
    <div className="provider-lifecycle-list" data-settings-group="builtin">
      {builtinStatuses.map((status, index) => <article key={status.type} id={`${prefix}-builtin-${index}`} className="settings-resource-card" data-settings-selection={status.type}
        hidden={selected?.group !== 'builtin' || selected.id !== status.type || mobile && overview}
        onFocusCapture={() => captureProviderChoice('builtin', status.type)} onClickCapture={() => captureProviderChoice('builtin', status.type)}>
        <div><strong>{status.name}</strong><code>{status.type}</code></div>
        <span className={status.connected ? 'status-success' : 'status-warning'}>
          {status.connected ? t('settings.connected') : t('settings.disconnected')} · {status.method}
          {status.environmentVariable ? ` (${status.environmentVariable})` : ''}
          {status.usage ? ` · ${status.usage.requests ?? 0} requests · ${(status.usage.inputTokens ?? 0) + (status.usage.outputTokens ?? 0)} tokens · $${(status.usage.costUsd ?? 0).toFixed(4)}` : ''}
        </span>
        <div>
          {status.method === 'oauth' && <button type="button" disabled={oauthStarting} onClick={() => {
            void login(status.type);
          }}>{status.connected ? t('settings.reconnect') : t('settings.connect')}</button>}
          {status.type === 'openai-codex' && <button type="button" disabled={oauthStarting} onClick={() => { void login(status.type, 'browser'); }}>{providerSettingsMessage(locale, 'browser')}</button>}
          <button type="button" disabled={!status.connected} onClick={async () => {
            const result = await testProviderConnection(status.type);
            if (result.success) {
              publishNotice(t('settings.connectionOk', { count: result.data?.models.length ?? 0 }), { level: 'success' });
              await load();
            } else error(result.error);
          }}>{t('settings.testConnection')}</button>
          {status.disconnectSupported && <button type="button" onClick={async () => {
            const generation = epoch.current;
            if (oauthOperation.current?.provider === status.type) {
              retireOAuth(); setOauthFlow(undefined); setOauthStarting(false);
            }
            const result = await disconnectProvider(status.type);
            if (!mounted.current || epoch.current !== generation) return;
            if (!result.success) error(result.error); else await reconcile().catch(() => {
              if (mounted.current && epoch.current === generation) error();
            });
          }}>{t('settings.disconnect')}</button>}
        </div>
      </article>)}
    </div>
    {(oauthStarting || oauthFlow) && <aside className="oauth-device-flow" role="status"
      hidden={selected?.group !== oauthOperation.current?.group || selected?.id !== oauthOperation.current?.provider || mobile && overview}>
      {oauthOperation.current?.method === 'browser' || oauthOperation.current?.method === 'copy-code' ? <strong>PKCE</strong> :
      <strong>{t('settings.oauth.title')}</strong>}
      {oauthStarting && <button type="button" onClick={() => {
        retireOAuth(); setOauthStarting(false);
      }}>{t('common.cancel')}</button>}
      {oauthFlow && <>
      {oauthFlow.state === 'pending' ? <>
        {oauthFlow.authorizationUrl ? <>
          <p className="settings-help">{providerSettingsMessage(locale, oauthOperation.current?.method === 'copy-code' ? 'copyCodeHelp' : 'browserHelp')}</p>
          <OAuthPastePanel active operationId={oauthFlow.id} authorizationUrl={oauthFlow.authorizationUrl} inputKind={oauthOperation.current?.method === 'copy-code' ? 'code' : 'redirect'}
            onPaste={completeOAuth} onCancel={() => { retireOAuth(); setOauthFlow(undefined); }} />
        </> : <>
        <p>{t('settings.oauth.code')}: <code>{oauthFlow.userCode}</code></p>
        <a href={oauthFlow.verificationUriComplete || oauthFlow.verificationUri} target="_blank" rel="noopener noreferrer">{t('settings.oauth.open')}</a>
        <button type="button" onClick={() => { retireOAuth(); setOauthFlow(undefined); }}>{t('common.cancel')}</button>
        </>}
      </> : <p>{oauthFlow.state === 'connected' ? t('settings.oauth.connected') : oauthFlow.error || oauthFlow.state}</p>}
      </>}
    </aside>}
    <details className="custom-resource-editor" open={Boolean(editing)}>
      <summary ref={editorSummary}>{t('settings.customProviders.manage')}</summary>
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
          <option value="openai">OpenAI mixed Responses / Decisions</option>
          <option value="mistral-conversations">Mistral Chat / Conversations</option>
          <option value="openrouter">OpenRouter mixed A/C/I/T</option>
          <option value="cloudflare-workers-ai">Cloudflare Workers AI mixed C/S</option>
          <option value="cerebras">Cerebras Chat Completions</option>
          <option value="deepseek">DeepSeek Chat Completions</option>
          <option value="groq">Groq Chat Completions</option>
          <option value="zai">Z.ai Coding Chat Completions</option>
          <option value="moonshot">Moonshot Chat Completions</option>
          <option value="nvidia">NVIDIA Chat Completions</option>
          <option value="ant-ling">Ant Ling Chat Completions</option>
          <option value="baseten">Baseten Chat Completions</option>
          <option value="fireworks">Fireworks Messages / Chat Completions</option>
          <option value="huggingface">Hugging Face Chat Completions</option>
          <option value="kimi-coding">Kimi Coding Messages (API key)</option>
          <option value="meta">Meta Responses (API key or Muse)</option>
          <option value="minimax">MiniMax Messages</option>
          <option value="minimax-cn">MiniMax CN Messages</option>
          <option value="opencode-go">OpenCode Go Messages / Chat / Responses</option>
          <option value="opencode">OpenCode Zen Messages / Google / Chat / Responses</option>
          <option value="together">Together Chat Completions</option>
          <option value="xai">xAI Responses (API key or Grok/X)</option>
          <option value="xiaomi">Xiaomi Chat Completions</option>
          <option value="moonshot-cn">Moonshot CN Chat Completions</option>
          <option value="qwen-token-plan">Qwen Token Plan</option>
          <option value="qwen-token-plan-cn">Qwen Token Plan CN</option>
          <option value="qwen-token-plan-individual">Qwen Token Plan Individual</option>
          <option value="xiaomi-token-plan-ams">Xiaomi Token Plan AMS</option>
          <option value="xiaomi-token-plan-cn">Xiaomi Token Plan CN</option>
          <option value="xiaomi-token-plan-sgp">Xiaomi Token Plan SGP</option>
          <option value="zai-coding-cn">Z.ai Coding CN</option>
          <option value="typesafe">TypeSafe System One</option>
          <option value="cloudflare-ai-gateway">Cloudflare AI Gateway (gateway root URL)</option>
          <option value="vercel-ai-gateway">Vercel AI Gateway (gateway root URL)</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="google">Google Generative Language</option>
        </select></label>
        <label>{t('settings.apiKey')}<input type="password" autoComplete="off" value={form.apiKey}
          placeholder={editing ? t('settings.keepExistingSecret') : ''}
          onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))} /></label>
        <label>{t('settings.customHeaders')}<textarea rows={3} value={form.headers}
          onChange={event => setForm(current => ({ ...current, headers: event.target.value }))} /></label>
        <div><button disabled={busy}>{t('common.save')}</button>{editing && <button type="button" onClick={() => guardFormDiscard(() => {
          setEditing(undefined); formBaseline.current = empty; setForm(empty);
        })}>{t('common.cancel')}</button>}</div>
      </form>
    </details>
      <div className="settings-resource-list" data-settings-group="custom">
        {providers.map((provider, index) => <article key={provider.id} id={`${prefix}-custom-${index}`} className={`settings-resource-card${isRenameableProvider(provider) ? ' provider-custom-card' : ''}`} data-settings-selection={provider.id}
          hidden={selected?.group !== 'custom' || selected.id !== provider.id || mobile && overview}
          onFocusCapture={() => captureProviderChoice('custom', provider.id)} onClickCapture={() => captureProviderChoice('custom', provider.id)}>
          <div><strong>{provider.name}</strong><code>{provider.id}</code><small>{provider.dialect} · {provider.baseUrl}</small></div>
          {isRenameableProvider(provider) ? <ProviderRenamePanel provider={provider} reconcile={outcome => reconcile(outcome, true, provider.id, navigationGeneration)} capability={renameCapability}
            disabled={busy || Boolean(editing) || oauthFlow?.state === 'pending' || !renameCapability.supported}
            disabledReason={!renameCapability.supported ? renameCapability.reason === 'exclusive-host-required' ? 'disabled' : 'capabilityUnknown' : undefined} />
            : null}
          <span>{provider.configured ? t('settings.connected') : t('settings.disconnected')} · {provider.modelCount} models</span>
          <div>
            {['kimi-coding', 'meta', 'xai'].includes(provider.dialect) && <button type="button" disabled={oauthStarting} onClick={() => { void login(provider.id); }}>{provider.configured ? t('settings.reconnect') : t('settings.connect')}</button>}
            {['openrouter', 'anthropic'].includes(provider.dialect) && <button type="button" disabled={oauthStarting} onClick={() => { void login(provider.id, 'browser'); }}>{providerSettingsMessage(locale, 'browser')}</button>}
            {provider.dialect === 'anthropic' && <button type="button" disabled={oauthStarting} onClick={() => { void login(provider.id, 'copy-code'); }}>{providerSettingsMessage(locale, 'copyCode')}</button>}
            <button type="button" onClick={() => {
              const id = provider.id;
              guardFormDiscard(() => {
                const targets = editChoices.current.filter(choice => choice.id === id);
                if (targets.length !== 1) return;
                const provider = targets[0]!;
                setEditing(provider.id);
                const next = customProviderForm(provider);
                formBaseline.current = next; setForm(next);
              });
            }}>{t('common.edit')}</button>
            <button type="button" disabled={!provider.configured} onClick={async () => {
              const result = await testProviderConnection(provider.id);
              if (result.success) publishNotice(t('settings.connectionOk', { count: result.data?.models.length ?? 0 }), { level: 'success' });
              else error(result.error);
            }}>{t('settings.testConnection')}</button>
            {provider.configured && <button type="button" onClick={async () => {
              if (oauthOperation.current?.provider === provider.id) { retireOAuth(); setOauthFlow(undefined); setOauthStarting(false); }
              const result = await disconnectProvider(provider.id);
              if (!result.success) error(result.error); else if (['kimi-coding', 'openrouter', 'anthropic', 'meta', 'xai'].includes(provider.dialect)) await reconcile(); else await load();
            }}>{t('settings.disconnect')}</button>}
            <button type="button" onClick={async () => {
              const result = await importCustomProviderModels(provider.id);
              if (result.success) {
                publishNotice(t('settings.modelsImported', { count: result.data?.length ?? 0 }), { level: 'success' });
                await hydrateModelCatalog(true); await load();
              } else error(result.error);
            }}>{t('settings.importModels')}</button>
            <button type="button" onClick={async () => {
              if (!window.confirm(t('settings.customProviders.deleteConfirm', { name: provider.name }))) return;
              if (oauthOperation.current?.provider === provider.id) { retireOAuth(); setOauthFlow(undefined); setOauthStarting(false); }
              const result = await deleteCustomProvider(provider.id);
              if (!result.success) error(result.error);
              else await Promise.all([load(), hydrateProviders(), hydrateModelCatalog(true)]);
            }}>{t('common.delete')}</button>
          </div>
        </article>)}
      </div>
      </div>
    </div>
  </section>;
}

function customModelForm(model: CustomModelDefinition) {
  return {
    provider: model.provider, id: model.id, name: model.name,
    reasoning: model.capabilities.reasoning, imageInput: model.capabilities.imageInput, toolCalls: model.capabilities.toolCalls,
    contextWindow: model.contextWindow ? String(model.contextWindow) : '', maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
    inputPrice: model.pricing?.inputPerMillion === undefined ? '' : String(model.pricing.inputPerMillion),
    outputPrice: model.pricing?.outputPerMillion === undefined ? '' : String(model.pricing.outputPerMillion),
    cacheReadPrice: model.pricing?.cacheReadPerMillion === undefined ? '' : String(model.pricing.cacheReadPerMillion),
    cacheWritePrice: model.pricing?.cacheWritePerMillion === undefined ? '' : String(model.pricing.cacheWritePerMillion),
    compatibility: JSON.stringify(model.compatibility ?? {}, null, 2),
  };
}

export function CustomModelSettings({ presented }: { presented: boolean }) {
  const { t, locale } = useI18n();
  const workspaceCwd = useSessionStore(state => state.workspace?.cwd);
  const hydrateModelCatalog = useSessionStore(state => state.hydrateModelCatalog);
  const [models, setModels] = useState<CustomModelDefinition[]>([]);
  const editChoices = useRef(models);
  useLayoutEffect(() => { editChoices.current = models; }, [models]);
  const [loaded, setLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState(() => readSettingsNavigation(workspaceCwd).positions['custom-models']?.selection);
  const [overview, setOverview] = useState(!selectedKey);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 959px)').matches);
  const navigationRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusRef = useRef<'navigation' | 'detail' | null>(null);
  const detailPrefix = useId();
  const matches = models.filter(model => model.key === selectedKey);
  const selected = selectedKey ? matches.length === 1 ? matches[0] : undefined : models[0];
  useEffect(() => {
    const media = window.matchMedia('(max-width: 959px)');
    const changed = () => {
      if (media.matches && detailRef.current?.contains(document.activeElement)) setOverview(false);
      setMobile(media.matches);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    if (!presented || !focusRef.current) return;
    const target = focusRef.current; focusRef.current = null;
    if (target === 'navigation') (navigationRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? navigationRef.current)?.focus();
    else if (mobile && !overview) backRef.current?.focus();
  }, [presented, mobile, overview, selected]);
  const selectMetadata = (selection: string) => {
    setSelectedKey(selection); setOverview(false); focusRef.current = mobile ? 'detail' : null;
    const current = readSettingsNavigation(workspaceCwd);
    writeSettingsNavigation(workspaceCwd, { ...current, section: 'custom-models', positions: { ...current.positions, 'custom-models': { selection } } });
  };
  const [editing, setEditing] = useState<string>();
  const empty = { provider: '', id: '', name: '', reasoning: false, imageInput: false, toolCalls: true, contextWindow: '', maxOutputTokens: '', inputPrice: '', outputPrice: '', cacheReadPrice: '', cacheWritePrice: '', compatibility: '{}' };
  const [form, setForm] = useState(empty);
  const editorState = useRef({ editing, form });
  useLayoutEffect(() => { editorState.current = { editing, form }; }, [editing, form]);
  const formBaseline = useRef(form);
  const editorSummary = useRef<HTMLElement>(null);
  const guardFormDiscard = useSettingsDraftGuard((Object.keys(form) as Array<keyof typeof form>)
    .some(key => form[key] !== formBaseline.current[key]), editorSummary);
  const load = async () => {
    const result = await getCustomModels();
    if (result.success && result.data) { setModels(result.data); setLoaded(true); }
  };
  useEffect(() => { void load(); }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    let compatibility: Record<string, string | number | boolean>;
    try { compatibility = JSON.parse(form.compatibility); }
    catch { error(t('settings.customModels.invalidCompatibility')); return; }
    const baseline = formBaseline.current;
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
    else {
      const current = editorState.current;
      if (result.data && current.editing === editing && formBaseline.current === baseline
        && (editing ? result.data.key === editing : result.data.key === `${form.provider}:${form.id}`
          && result.data.provider === form.provider && result.data.id === form.id
          && current.form.provider === form.provider && current.form.id === form.id)
        && (Object.keys(form) as Array<keyof typeof form>).some(key => current.form[key] !== form[key])) {
        const saved = customModelForm(result.data);
        let next = { ...current.form };
        if (!editing) for (const key of Object.keys(form) as Array<keyof typeof form>) {
          if (current.form[key] === form[key]) next = { ...next, [key]: saved[key] };
        }
        formBaseline.current = saved;
        setEditing(result.data.key); setForm(next);
      } else { setEditing(undefined); formBaseline.current = empty; setForm(empty); }
      await Promise.all([load(), hydrateModelCatalog(true)]);
    }
  };
  return <section className="settings-section" id="custom-models">
    <h3>{t('settings.customModels.title')}</h3>
    <details className="custom-resource-editor">
      <summary ref={editorSummary}>{editing ? t('settings.customModels.edit') : t('settings.customModels.create')}</summary>
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
        <div><button>{t('common.save')}</button>{editing && <button type="button" onClick={() => guardFormDiscard(() => { setEditing(undefined); formBaseline.current = empty; setForm(empty); })}>{t('common.cancel')}</button>}</div>
      </form>
    </details>
    {loaded && selectedKey && !selected && <p role="status">{customModelMessage(locale, 'unavailable')}</p>}
    <div className="custom-model-context">
      <nav ref={navigationRef} aria-label={t('settings.customModels.title')} tabIndex={-1} hidden={mobile && !overview && !!selected}>
        {models.map((model, index) => <button key={model.key} type="button" aria-current={selected === model ? 'true' : undefined}
          aria-expanded={selected === model && (!mobile || !overview)} aria-controls={`${detailPrefix}-${index}`}
          onClick={() => selectMetadata(model.key)}><strong>{model.name}</strong><code>{model.key}</code></button>)}
      </nav>
      <div ref={detailRef} className="custom-model-context-detail" hidden={mobile && overview}>
        <button ref={backRef} type="button" className="custom-model-context-back" hidden={!mobile || overview || !selected}
          onClick={() => { focusRef.current = 'navigation'; setOverview(true); }}>{customModelMessage(locale, 'back')}</button>
    <div className="settings-resource-list">
      {models.map((model, index) => <article key={model.key} id={`${detailPrefix}-${index}`} className="settings-resource-card" data-settings-selection={model.key}
        hidden={selected !== model}>
        <div><strong>{model.name}</strong><code>{model.key}</code><small>{model.contextWindow ?? '—'} context · {model.maxOutputTokens ?? '—'} max output</small></div>
        <div>
          <button type="button" onClick={() => {
            const key = model.key;
            guardFormDiscard(() => {
              const targets = editChoices.current.filter(choice => choice.key === key);
              if (targets.length !== 1) return;
              const model = targets[0]!;
              setEditing(model.key);
              const next = customModelForm(model);
              formBaseline.current = next; setForm(next);
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
      </div>
    </div>
  </section>;
}

export function ToolSettingsPanel({ presented }: { presented: boolean }) {
  const workspace = useSessionStore(state => state.workspace);
  const [scope, setScope] = useSettingsScope('tools', workspace?.id ? 'project' : 'global');
  return <ScopedToolSettings key={scope} scope={scope} setScope={setScope} presented={presented} />;
}

function ScopedToolSettings({ scope, setScope, presented }: {
  scope: 'global' | 'project'; setScope(scope: 'global' | 'project'): void; presented: boolean;
}) {
  const { t, locale } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [settings, setSettings] = useState<ToolSettings>();
  const [inlineBudgetDirty, setInlineBudgetDirty] = useState(false);
  useSettingsDraft(inlineBudgetDirty);
  useLayoutEffect(() => { setInlineBudgetDirty(false); }, [settings?.codemode?.inlineBudget]);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const [selectedName, setSelectedName] = useState(() => {
    const position = readSettingsNavigation(workspace?.cwd).positions.tools;
    return position?.group === scope ? position.selection : undefined;
  });
  const [overview, setOverview] = useState(!selectedName);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 959px)').matches);
  const navigationRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const navigationFocus = useRef(false);
  const detailPrefix = useId();
  useEffect(() => {
    const media = window.matchMedia('(max-width: 959px)');
    const changed = () => {
      if (media.matches && detailRef.current?.contains(document.activeElement)) setOverview(false);
      setMobile(media.matches);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    if (!navigationFocus.current) return;
    navigationFocus.current = false;
    if (!presented) return;
    if (overview) {
      const choice = navigationRef.current?.querySelector<HTMLElement>('[aria-current="true"]:not(:disabled)');
      (choice ?? navigationRef.current)?.focus();
    } else if (mobile) backRef.current?.focus();
  }, [mobile, overview, presented, selectedName]);
  const selectTool = (tool: ToolSettings['tools'][number]) => {
    setSelectedName(tool.name);
    setOverview(false);
    const current = readSettingsNavigation(workspace?.cwd);
    writeSettingsNavigation(workspace?.cwd, { ...current, section: 'tools',
      positions: { ...current.positions, tools: { group: scope, selection: tool.name } } });
  };
  const matches = selectedName ? settings?.tools.filter(tool => tool.name === selectedName) ?? [] : [];
  const selected = selectedName ? matches.length === 1 ? matches[0] : undefined : settings?.tools[0];
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
  const codemodeFields = settings?.codemode && <fieldset className="codemode-settings">
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
      onChange={event => setInlineBudgetDirty(event.currentTarget.value !== String(settings.codemode!.inlineBudget))}
      onBlur={event => {
        // Confirmation focus must not turn Escape into the ordinary blur save.
        if (event.currentTarget.closest('.settings-layout[inert]')) return;
        const value = event.currentTarget.valueAsNumber;
        if (Number.isSafeInteger(value) && value >= 0 && value <= 3000 && value !== settings.codemode!.inlineBudget) {
          void persist({ ...settings, codemode: { ...settings.codemode!, inlineBudget: value } });
        } else { event.currentTarget.value = String(settings.codemode!.inlineBudget); setInlineBudgetDirty(false); }
      }} /></label>
    <p className="settings-help">{t('settings.codemode.limits')}</p>
    <p className="settings-help">{t('settings.codemode.warning')}</p>
  </fieldset>;
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
      {selectedName && !selected && <p role="status" className="settings-help">{toolSettingsMessage(locale, 'unavailable')}</p>}
      <div className="tool-context">
        <nav ref={navigationRef} tabIndex={-1} aria-label={t('settings.tools.title')}
          hidden={mobile && !overview && Boolean(selected)}>
          {settings.tools.map((tool, index) => <button key={tool.name} type="button" disabled={busy}
            aria-label={tool.name} aria-current={tool === selected ? 'true' : undefined}
            aria-expanded={tool === selected && (!mobile || !overview)} aria-controls={`${detailPrefix}-${index}`}
            aria-describedby={`${detailPrefix}-${index}-state`}
            onClick={() => { navigationFocus.current = mobile; selectTool(tool); }}>
            <strong>{tool.name}</strong>
            <small id={`${detailPrefix}-${index}-state`}>{tool.extensionId} · {toolSettingsMessage(locale, tool.enabled ? 'enabled' : 'disabled')}</small>
          </button>)}
        </nav>
        <div ref={detailRef} className="tool-context-detail" hidden={mobile && (overview || !selected)}>
          <button ref={backRef} type="button" className="tool-context-back" hidden={!mobile}
            onClick={() => { navigationFocus.current = true; setOverview(true); }}>{toolSettingsMessage(locale, 'back')}</button>
          <div className="tool-settings-list" data-settings-group={scope}>
            {settings.tools.map((tool, index) => <div key={tool.name} id={`${detailPrefix}-${index}`}
              data-settings-selection={tool.name} hidden={tool !== selected}>
              <label><input type="checkbox" checked={tool.enabled} disabled={busy || !tool.available}
                onChange={event => {
                  selectTool(tool);
                  void persist({ ...settings, tools: settings.tools.map(item => item.name === tool.name ? { ...item, enabled: event.target.checked } : item) });
                }} />
              <span><strong>{tool.name}</strong><small>{tool.description} · {tool.extensionId}</small>
                {tool.disabledReason && <small>{t(`settings.tools.reason.${tool.disabledReason}`)}</small>}
                {tool.unavailableReason && <small>{tool.unavailableReason}</small>}
              </span></label>
              {tool.name === 'codemode' && codemodeFields}
            </div>)}
          </div>
        </div>
      </div>
      <label><input type="checkbox" checked={settings.powershellEnabled} disabled={busy || !settings.powershellAvailable}
        onChange={event => void persist({ ...settings, powershellEnabled: event.target.checked })} /> {t('settings.tools.powershell')}</label>
    </>}
  </section>;
}

export function SkillRegistryPanel({ presented }: { presented: boolean }) {
  const { t, locale } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const hydrateSkills = useSessionStore(state => state.hydrateSkillCatalog);
  const [registry, setRegistry] = useState<SkillRegistry>();
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(() => {
    const position = readSettingsNavigation(workspace?.cwd).positions.skills;
    return position?.group === 'registry' ? position.selection : undefined;
  });
  const [overview, setOverview] = useState(!selectedId);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 959px)').matches);
  const navigationRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const focusRef = useRef<'navigation' | 'detail' | null>(null);
  const detailPrefix = useId();
  const entries = registry?.entries ?? [];
  const matches = entries.filter(entry => entry.id === selectedId);
  const selected = selectedId ? matches.length === 1 ? matches[0] : undefined : entries[0];
  useEffect(() => {
    const media = window.matchMedia('(max-width: 959px)');
    const changed = () => {
      if (media.matches && detailRef.current?.contains(document.activeElement)) setOverview(false);
      setMobile(media.matches);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    if (!presented || !focusRef.current) return;
    const target = focusRef.current; focusRef.current = null;
    if (target === 'navigation') (navigationRef.current?.querySelector<HTMLElement>('[aria-current="true"]:not(:disabled)') ?? navigationRef.current)?.focus();
    else if (mobile && !overview) backRef.current?.focus();
  }, [presented, mobile, overview, selected]);
  const rememberMetadata = (selection: string) => {
    const current = readSettingsNavigation(workspace?.cwd);
    writeSettingsNavigation(workspace?.cwd, { ...current, section: 'skills', positions: { ...current.positions, skills: { group: 'registry', selection } } });
  };
  const selectMetadata = (selection: string) => {
    setSelectedId(selection); setOverview(false); focusRef.current = mobile ? 'detail' : null;
    rememberMetadata(selection);
  };
  const [query, setQuery] = useState('');
  const [scope, setScope] = useSettingsScope('registry', 'project');
  const [busy, setBusy] = useState(false);
  const load = async (refresh = false) => {
    const result = await getSkillRegistry(query, workspace?.cwd, workspace?.id, refresh);
    if (result.success && result.data) { setRegistry(result.data); setLoaded(true); } else error(result.error);
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
  return <details className="skill-registry" data-settings-group="registry">
    <summary>{t('settings.skills.registry')}</summary>
    <div className="model-catalog-toolbar">
      <label>{t('settings.skills.registrySearch')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label={t('settings.skills.installScope')} value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
        <option value="project" disabled={!workspace?.id}>{t('settings.skills.scope.project')}</option><option value="global">{t('settings.skills.scope.global')}</option>
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
    {loaded && selectedId && !selected && <p role="status">{registryContextMessage(locale, 'unavailable')}</p>}
    <div className="skill-registry-context">
      <nav ref={navigationRef} aria-label={t('settings.skills.registry')} tabIndex={-1} hidden={mobile && !overview && !!selected}>
        {entries.map((entry, index) => <button key={entry.id} type="button" disabled={busy}
          aria-current={selected === entry ? 'true' : undefined} aria-expanded={selected === entry && (!mobile || !overview)}
          aria-controls={`${detailPrefix}-${index}`} onClick={() => selectMetadata(entry.id)}><strong>{entry.name}</strong><code>{entry.id}</code></button>)}
      </nav>
      <div ref={detailRef} className="skill-registry-context-detail" hidden={mobile && overview}>
        <button ref={backRef} type="button" className="skill-registry-context-back" hidden={!mobile || overview || !selected}
          onClick={() => { if (selected) rememberMetadata(selected.id); focusRef.current = 'navigation'; setOverview(true); }}>{registryContextMessage(locale, 'back')}</button>
    <div className="settings-resource-list">
      {entries.map((entry, index) => <article className="settings-resource-card" key={entry.id} id={`${detailPrefix}-${index}`}
        data-settings-selection={entry.id} hidden={selected !== entry}>
        <div><strong>{entry.name}</strong><span>{entry.description}</span><code>v{entry.version}</code></div>
        <div>
          {entry.installed && <small>{t('settings.skills.installedVersion', { version: entry.installed.version ?? '?' })}</small>}
          <button type="button" disabled={busy || entry.installed?.scope === scope && !entry.installed.updateAvailable}
            onClick={() => void install(entry.id)}>{entry.installed?.updateAvailable ? t('settings.skills.update') : t('settings.skills.install')}</button>
        </div>
      </article>)}
    </div>
      </div>
    </div>
  </details>;
}

export function DefaultModelSettings() {
  const { t, locale } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [scope, setScope] = useSettingsScope('defaults', workspace?.id ? 'project' : 'global');
  const [values, setValues] = useState({ provider: '', model: '', thinking: '', thinkingBudgets: '', toolPreset: '' });
  const [dirty, setDirty] = useState<Array<keyof typeof values>>([]);
  const guardScopeDiscard = useSettingsDraftGuard(dirty.length > 0);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [overrideWarning, setOverrideWarning] = useState(false);
  const [feedback, setFeedback] = useState<SettingsAdminMessage>();
  const epoch = useRef(0);
  const change = (key: keyof typeof values, value: string) => {
    setValues(current => ({ ...current, [key]: value }));
    setDirty(current => [...new Set([...current, key])]);
  };
  const [effective, setEffective] = useState<Awaited<ReturnType<typeof getEffectiveConfiguration>>['data']>();
  const scopeId = scope === 'project' ? workspace?.id : undefined;
  const readSaved = async (generation: number) => {
    const [configured, resolved] = await Promise.all([
      getConfigurationScope(scope, scopeId), getEffectiveConfiguration(workspace?.id),
    ]);
    if (generation !== epoch.current) return;
    if (!configured.success || !configured.data || !resolved.success || !resolved.data) {
      setReady(false); setEffective(undefined); return;
    }
    setValues({
      provider: typeof configured.data.values.provider === 'string' ? configured.data.values.provider : '',
      model: typeof configured.data.values.model === 'string' ? configured.data.values.model : '',
      thinking: typeof configured.data.values.thinking === 'string' ? configured.data.values.thinking : '',
      thinkingBudgets: configured.data.values.thinkingBudgets === undefined ? '' : JSON.stringify(configured.data.values.thinkingBudgets),
      toolPreset: typeof configured.data.values.toolPreset === 'string' ? configured.data.values.toolPreset : '',
    });
    setDirty([]); setReady(true); setEffective(resolved.data);
    return resolved.data;
  };
  const reload = async () => {
    const generation = epoch.current;
    setBusy(true); setReady(false); setOverrideWarning(false); setFeedback(undefined);
    const resolved = await readSaved(generation);
    if (generation !== epoch.current) return;
    if (!resolved) setFeedback('readFailed');
    setBusy(false);
  };
  useEffect(() => {
    ++epoch.current;
    setDirty([]); setEffective(undefined);
    if (scope === 'project' && !scopeId) { setScope('global'); return; }
    void reload();
    return () => { ++epoch.current; };
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
      {' · '}{['provider', 'model', 'thinking', 'thinkingBudgets', 'toolPreset'].map(key => `${key}: ${effective.provenance[key as keyof typeof effective.provenance]?.source ?? 'built-in'}`).join(' · ')}
    </p>}
    {scope === 'project' && Object.values(values).some(value => !value) && <p className="status-warning">{t('settings.defaults.inheritanceWarning')}</p>}
    {overrideWarning && <p role="status" className="status-warning">{t('settings.defaults.overrideWarning')}</p>}
    {feedback && <p role="alert">{settingsAdminMessage(locale, feedback)}</p>}
    {!ready && !busy && <button type="button" onClick={() => void reload()}>{settingsAdminMessage(locale, 'refresh')}</button>}
    <label>{t('settings.scope')}<select value={scope} disabled={busy} onChange={event => {
      const nextScope = event.target.value as typeof scope;
      if (nextScope === scope) setScope(nextScope);
      else guardScopeDiscard(() => setScope(nextScope));
    }}>
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
    <label>{reasoningSettingsMessage(locale, 'label')}<input value={values.thinkingBudgets}
      style={{ color: 'inherit', backgroundColor: 'transparent' }} maxLength={256} placeholder={JSON.stringify(effective?.values.thinkingBudgets ?? {})}
      disabled={busy || !ready || environmentLocked('thinkingBudgets')} aria-describedby="thinking-budgets-help"
      onChange={event => change('thinkingBudgets', event.target.value)} /></label>
    <p id="thinking-budgets-help" className="settings-help">{reasoningSettingsMessage(locale, 'help')}</p>
    <label>{t('settings.tools.defaultPreset')}<select value={values.toolPreset} disabled={busy || !ready || environmentLocked('toolPreset')}
      onChange={event => change('toolPreset', event.target.value)}>
      <option value="">{t('chat.setting.auto')} · {String(effective?.values.toolPreset ?? 'default')}</option>
      {['configured', 'chat-only', 'read-only', 'default', 'full'].map(preset => <option key={preset}>{preset}</option>)}
    </select></label>
    <button type="button" disabled={busy || !ready || !dirty.length || scope === 'project' && !scopeId} onClick={async () => {
      const generation = epoch.current;
      setBusy(true); setFeedback(undefined); setOverrideWarning(false);
      try {
        const changed = dirty.filter(key => !environmentLocked(key));
        let patch: Record<string, unknown>;
        try {
          patch = Object.fromEntries(changed.map(key => [key, key === 'thinkingBudgets'
            ? values[key].trim() ? JSON.parse(values[key]) as unknown : null : values[key] || null]));
        } catch { error(reasoningSettingsMessage(locale, 'invalid')); return; }
        const result = await updateConfigurationScope(scope, patch, scopeId);
        if (generation !== epoch.current) return;
        // A failed response may follow a durable write. Never infer rollback or
        // report success until both saved values and provenance are readable.
        const resolved = await readSaved(generation);
        if (generation !== epoch.current) return;
        if (!resolved) { setFeedback('readbackFailed'); return; }
        if (!result.success) { setFeedback('saveFailed'); return; }
        const overridden = scope === 'global' && changed.some(key => ['project', 'environment'].includes(resolved.provenance[key]?.scope ?? ''));
        setOverrideWarning(overridden);
        publishNotice(t(overridden ? 'settings.defaults.overrideWarning' : 'settings.defaults.saved'), { level: overridden ? 'warning' : 'success' });
      } finally { if (generation === epoch.current) setBusy(false); }
    }}>{t('common.save')}</button>
  </section>;
}
