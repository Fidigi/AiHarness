import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  McpConfigFileInventory,
  McpConfigInventory,
  McpConfigProblemReason,
  McpConfigScope,
  McpExposure,
  McpOAuthFlowInfo,
  McpServerInventoryEntry,
} from '@ai-harness/core';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { McpImportPreview, type McpReplacementOutcome } from './McpImportPreview';
import { mcpTestMessage, type McpTestMessageKey } from './mcp-test-messages';
import { useI18n } from '../hooks/useI18n';
import { getMcpConfig } from '../services/api';
import {
  cancelMcpOAuthFlow,
  getMcpOAuthStatuses,
  logoutMcpOAuth,
  pasteMcpOAuthRedirect,
  readMcpOAuthFlow,
  removeMcpConfigServer,
  restoreMcpConfigServer,
  setMcpConfigEnabled,
  setMcpConfigExposure,
  startMcpOAuth,
  testMcpConfigServer,
  type McpActionResponse,
  type McpOAuthStatusEntry,
  type McpReplaceTarget,
} from '../services/mcp-api';
import { useSessionStore } from '../store/session-store';

const PROBLEM_KEYS: Record<McpConfigProblemReason, string> = {
  'invalid-shape': 'settings.mcp.problem.invalidShape',
  'invalid-syntax': 'settings.mcp.problem.invalidSyntax',
  'not-regular': 'settings.mcp.problem.notRegular',
  'too-deep': 'settings.mcp.problem.tooDeep',
  'too-large': 'settings.mcp.problem.tooLarge',
  'too-many-servers': 'settings.mcp.problem.tooManyServers',
  'trust-required': 'settings.mcp.problem.trustRequired',
  'trust-unavailable': 'settings.mcp.problem.trustUnavailable',
  'unsafe-link': 'settings.mcp.problem.unsafeLink',
  unreadable: 'settings.mcp.problem.unreadable',
};

const SCOPE_KEYS: Record<McpConfigScope, string> = {
  global: 'settings.mcp.scope.global',
  project: 'settings.mcp.scope.project',
};

type FeedbackKind = 'updated' | 'partial' | 'removed' | 'restored' | 'error' | 'uncertain';

interface UndoState {
  token: string;
  expiresAt: string;
}

interface PendingRemoval {
  scope: McpConfigScope;
  name: string;
  revision: string | null;
}

interface PendingControlFocus {
  kind: 'edit' | 'exposure';
  scope: McpConfigScope;
  name: string;
}

function serverState(server: McpServerInventoryEntry): 'invalid' | 'shadowed' | 'disabled' | 'configured' {
  if (!server.valid) return 'invalid';
  if (server.shadowedByProject) return 'shadowed';
  if (!server.enabled) return 'disabled';
  return 'configured';
}

function fileForScope(
  inventory: McpConfigInventory,
  scope: McpConfigScope,
): McpConfigFileInventory | undefined {
  return inventory.files.find(file => file.scope === scope);
}

function editKey(scope: McpConfigScope, name: string): string {
  return encodeURIComponent(`${scope}\0${name}`);
}

function oauthKey(server: Pick<McpServerInventoryEntry, 'scope' | 'name' | 'configKey'>): string {
  return `${server.scope}\0${server.name}\0${server.configKey}`;
}

function activeOAuthFlow(flow: McpOAuthFlowInfo | undefined): boolean {
  return Boolean(flow && !['connected', 'failed', 'cancelled', 'expired'].includes(flow.phase));
}

function safeAuthorizationLink(value: string | undefined): string | undefined {
  if (!value || value.length > 16_384) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return url.href;
    return undefined;
  } catch { return undefined; }
}

function testedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function McpTestReport({ server }: { server: McpServerInventoryEntry }) {
  const { locale, t } = useI18n();
  const status = server.testStatus;
  if (!status) return null;
  return <section className="mcp-test-report"
    aria-label={mcpTestMessage(locale, 'settings.mcp.test.reportNamed', { name: server.name })}>
    <div className="mcp-test-summary">
      <strong className={status.state === 'connected' ? 'status-success' : 'status-warning'}>
        {mcpTestMessage(locale, `settings.mcp.test.state.${status.state}` as McpTestMessageKey)}
      </strong>
      <small>{mcpTestMessage(locale, 'settings.mcp.test.timing', {
        testedAt: testedAt(status.testedAt),
        duration: status.durationMs,
      })}</small>
    </div>
    {status.serverInfo && <small>{mcpTestMessage(locale, 'settings.mcp.test.serverInfo', {
      name: status.serverInfo.name,
      version: status.serverInfo.version,
    })}{status.serverInfo.title ? ` · ${status.serverInfo.title}` : ''}</small>}
    {status.cwd && <small>{mcpTestMessage(locale, 'settings.mcp.test.cwd')} <code>{status.cwd}</code></small>}
    <small>{mcpTestMessage(locale, 'settings.mcp.test.capabilities', {
      tools: status.toolCount,
      resources: status.resources,
      templates: status.resourceTemplates,
      prompts: status.prompts,
    })}</small>
    {status.truncated && <small className="status-warning">{mcpTestMessage(locale, 'settings.mcp.test.truncated')}</small>}
    {status.timedOut && <small className="status-warning">{mcpTestMessage(locale, 'settings.mcp.test.timedOut')}</small>}
    {status.queueTimedOut && <small className="status-warning">{mcpTestMessage(locale, 'settings.mcp.test.queueTimedOut')}</small>}
    {status.state === 'needs-auth' && <small className="status-warning">{mcpTestMessage(locale, 'settings.mcp.test.needsAuth')}</small>}
    {status.tools.length > 0 && <ul className="mcp-test-tools">
      {status.tools.map((tool, index) => <li key={`${tool.name}:${index}`}>
        <code>{tool.name}</code>
        {tool.description && <span>{tool.description}</span>}
        <small>{mcpTestMessage(locale, tool.readOnly ? 'settings.mcp.test.readOnly' : 'settings.mcp.test.mayWrite')}
          {' · '}{t(`settings.mcp.exposure.${tool.exposure}`)}</small>
      </li>)}
    </ul>}
    {status.error && <pre className="mcp-test-output"
      aria-label={mcpTestMessage(locale, 'settings.mcp.test.error')}>{status.error}</pre>}
    {status.stderr && <details className="mcp-test-stderr">
      <summary>{mcpTestMessage(locale, 'settings.mcp.test.stderr')}</summary>
      <pre>{status.stderr}</pre>
    </details>}
  </section>;
}

function McpOAuthPanel({
  server,
  status,
  flow,
  busy,
  error,
  disabled,
  onStart,
  onPaste,
  onCancel,
  onLogout,
}: {
  server: McpServerInventoryEntry;
  status?: McpOAuthStatusEntry;
  flow?: McpOAuthFlowInfo;
  busy: boolean;
  error?: string;
  disabled: boolean;
  onStart(): void;
  onPaste(value: string): void;
  onCancel(): void;
  onLogout(): void;
}) {
  const { t } = useI18n();
  const [redirect, setRedirect] = useState('');
  useEffect(() => setRedirect(''), [flow?.flowId]);
  const active = activeOAuthFlow(flow);
  const authorizationUrl = safeAuthorizationLink(flow?.authorizationUrl);
  const statusKey = status?.signedIn
    ? 'settings.mcp.oauth.signedIn'
    : status?.stateStored
      ? 'settings.mcp.oauth.registrationOnly'
      : status ? 'settings.mcp.oauth.signedOut' : 'settings.mcp.oauth.unknown';
  return <section className="mcp-test-report mcp-oauth-panel"
    aria-label={t('settings.mcp.oauth.named', { name: server.name })}>
    <div className="mcp-test-summary">
      <strong>{t('settings.mcp.oauth.title')}</strong>
      <small className={status?.signedIn ? 'status-success' : undefined}>{t(statusKey)}</small>
    </div>
    {flow && active && <small role="status">
      {t(`settings.mcp.oauth.phase.${flow.phase}`)}
    </small>}
    {flow?.phase === 'authorize' && <div className="mcp-config-lines">
      {authorizationUrl
        ? <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
          {t('settings.mcp.oauth.openAuthorization')}
        </a>
        : <small className="status-warning">{t('settings.mcp.oauth.invalidAuthorizationUrl')}</small>}
      <label>
        <span>{t('settings.mcp.oauth.redirectLabel')}</span>
        <input value={redirect} disabled={busy}
          placeholder={t('settings.mcp.oauth.redirectPlaceholder')}
          onChange={event => setRedirect(event.currentTarget.value)} />
      </label>
      <button type="button" disabled={busy || redirect.trim().length === 0}
        onClick={() => onPaste(redirect)}>{t('settings.mcp.oauth.submitRedirect')}</button>
      {flow.redirectUrl && <small>{t('settings.mcp.oauth.callback', { url: flow.redirectUrl })}</small>}
    </div>}
    {flow && !active && <small role="status"
      className={flow.phase === 'connected' ? 'status-success' : 'status-warning'}>
      {t(`settings.mcp.oauth.outcome.${flow.phase}`)}
      {flow.phase === 'failed' && flow.failure
        ? ` ${t(`settings.mcp.oauth.failure.${flow.failure}`)}`
        : ''}
    </small>}
    {error && <small role="alert" className="status-warning">{error}</small>}
    <div className="mcp-row-actions">
      {active
        ? <button type="button" disabled={busy}
          onClick={onCancel}>{busy ? t('settings.mcp.oauth.working') : t('settings.mcp.oauth.cancel')}</button>
        : <button type="button" disabled={disabled || busy || !server.enabled || server.shadowedByProject}
          onClick={onStart}>{busy ? t('settings.mcp.oauth.working') : t('settings.mcp.oauth.signIn')}</button>}
      {!active && status?.stateStored && <button type="button" disabled={disabled || busy}
        onClick={onLogout}>{t('settings.mcp.oauth.signOut')}</button>}
    </div>
    <small>{t('settings.mcp.oauth.explanation')}</small>
  </section>;
}

function ServerCard({
  server,
  disabled,
  testing,
  oauthStatus,
  oauthFlow,
  oauthBusy,
  oauthError,
  onTest,
  onOAuthStart,
  onOAuthPaste,
  onOAuthCancel,
  onOAuthLogout,
  onToggle,
  onExposureChange,
  onEdit,
  onRemove,
}: {
  server: McpServerInventoryEntry;
  disabled: boolean;
  testing: boolean;
  oauthStatus?: McpOAuthStatusEntry;
  oauthFlow?: McpOAuthFlowInfo;
  oauthBusy: boolean;
  oauthError?: string;
  onTest: () => void;
  onOAuthStart: () => void;
  onOAuthPaste: (value: string) => void;
  onOAuthCancel: () => void;
  onOAuthLogout: () => void;
  onToggle: () => void;
  onExposureChange: (exposure: McpExposure) => void;
  onEdit: (trigger: HTMLButtonElement) => void;
  onRemove: (trigger: HTMLButtonElement) => void;
}) {
  const { locale, t } = useI18n();
  const state = serverState(server);
  const target = server.transport === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : server.url;
  return <article className="settings-resource-card mcp-server-card"
    aria-label={`${server.name}: ${t(`settings.mcp.state.${state}`)}`}>
    <div>
      <strong>{server.name}</strong>
      <code>{t(SCOPE_KEYS[server.scope])} · {server.transport ? t(`settings.mcp.transport.${server.transport}`) : t('settings.mcp.transport.unknown')}</code>
      {target && <small>{target}</small>}
      <small>{server.sourcePath}</small>
      {server.envNames.length > 0 && <small>{t('settings.mcp.envNames', { names: server.envNames.join(', ') })}</small>}
      {server.headerNames.length > 0 && <small>{t('settings.mcp.headerNames', { names: server.headerNames.join(', ') })}</small>}
      {server.commandFields.length > 0 && <small>{t('settings.mcp.commandFields', { fields: server.commandFields.join(', ') })}</small>}
      {server.variableReferences.map(reference => <small key={`${reference.field}:${reference.names.join(',')}`}>
        {t('settings.mcp.variableReferences', { field: reference.field, names: reference.names.join(', ') })}
      </small>)}
      {server.problems.length > 0 && <ul className="mcp-diagnostics">
        {server.problems.map((diagnostic, index) => <li key={`${index}:${diagnostic}`}>{diagnostic}</li>)}
      </ul>}
    </div>
    <div className="mcp-server-controls">
      <span className={state === 'configured' ? 'status-success' : 'status-warning'}>
        {t(`settings.mcp.state.${state}`)}
      </span>
      {server.runtimeStatus && <>
        <small className={server.runtimeStatus.state === 'connected' ? 'status-success' : 'status-warning'}>
          {t(`settings.mcp.runtime.${server.runtimeStatus.state}`, {
            count: server.runtimeStatus.toolCount ?? 0,
          })} · {testedAt(server.runtimeStatus.updatedAt)}
        </small>
        {server.runtimeStatus.error && <small className="status-warning">{server.runtimeStatus.error}</small>}
      </>}
      {server.valid ? <label className="mcp-exposure-control">
        <span>{t('settings.mcp.exposureLabel')}</span>
        <select value={server.exposure} disabled={disabled}
          data-mcp-exposure-key={editKey(server.scope, server.name)}
          aria-label={t('settings.mcp.exposureNamed', { name: server.name })}
          onChange={event => onExposureChange(event.currentTarget.value as McpExposure)}>
          {(['direct', 'codemode', 'deferred'] as const).map(exposure => (
            <option value={exposure} key={exposure}>{t(`settings.mcp.exposure.${exposure}`)}</option>
          ))}
        </select>
      </label> : <small>{t(`settings.mcp.exposure.${server.exposure}`)}</small>}
      {server.masked && <small>{t('settings.mcp.masked')}</small>}
      {server.replacesGlobal && <small>{t('settings.mcp.replacesGlobal')}</small>}
      {server.valid && <div className="mcp-row-actions">
        <button type="button" disabled={disabled} onClick={onTest}
          aria-label={mcpTestMessage(locale, 'settings.mcp.test.named', { name: server.name })}>
          {mcpTestMessage(locale, testing ? 'settings.mcp.test.testing' : 'settings.mcp.test.action')}
        </button>
        <button type="button" disabled={disabled} onClick={event => onEdit(event.currentTarget)}
          data-mcp-edit-key={editKey(server.scope, server.name)}
          aria-label={t('settings.mcp.editNamed', { name: server.name })}>
          {t('settings.mcp.edit')}
        </button>
        <button type="button" disabled={disabled} onClick={onToggle}
          aria-label={t(server.enabled ? 'settings.mcp.disableNamed' : 'settings.mcp.enableNamed', { name: server.name })}>
          {t(server.enabled ? 'settings.mcp.disable' : 'settings.mcp.enable')}
        </button>
        <button type="button" className="mcp-remove-button" disabled={disabled}
          onClick={event => onRemove(event.currentTarget)}
          aria-label={t('settings.mcp.removeNamed', { name: server.name })}>
          {t('settings.mcp.remove')}
        </button>
      </div>}
    </div>
    {server.usesOAuth && <McpOAuthPanel
      server={server}
      status={oauthStatus}
      flow={oauthFlow}
      busy={oauthBusy}
      error={oauthError}
      disabled={disabled}
      onStart={onOAuthStart}
      onPaste={onOAuthPaste}
      onCancel={onOAuthCancel}
      onLogout={onOAuthLogout}
    />}
    <McpTestReport server={server} />
  </article>;
}

/** Local MCP administration plus an explicit, bounded one-shot connection test. */
export function McpSettings() {
  const { locale, t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const refreshWorkspace = useSessionStore(state => state.refreshWorkspace);
  const [inventory, setInventory] = useState<McpConfigInventory>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [testing, setTesting] = useState<string>();
  const [testError, setTestError] = useState<string>();
  const [oauthStatuses, setOAuthStatuses] = useState<Record<string, McpOAuthStatusEntry>>({});
  const [oauthFlows, setOAuthFlows] = useState<Record<string, McpOAuthFlowInfo>>({});
  const [oauthBusy, setOAuthBusy] = useState<string>();
  const [oauthErrors, setOAuthErrors] = useState<Record<string, string>>({});
  const [importWriting, setImportWriting] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackKind>();
  const [undo, setUndo] = useState<UndoState>();
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval>();
  const [replacement, setReplacement] = useState<McpReplaceTarget>();
  const [pendingControlFocus, setPendingControlFocus] = useState<PendingControlFocus>();
  const inventoryRequest = useRef(0);
  const actionRequest = useRef(0);
  const testRequest = useRef(0);
  const oauthRequest = useRef(0);
  const removalReturnFocus = useRef<HTMLButtonElement | null>(null);
  const removalDialogRef = useRef<HTMLElement | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement | null>(null);
  const editReturnFocus = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);

  const refreshOAuthStatuses = useCallback(async (next: McpConfigInventory): Promise<void> => {
    const servers = next.servers.filter(server => server.valid && server.usesOAuth)
      .map(server => ({ scope: server.scope, name: server.name, configKey: server.configKey }));
    const request = ++oauthRequest.current;
    if (servers.length === 0) {
      setOAuthStatuses({});
      return;
    }
    const result = await getMcpOAuthStatuses(servers, workspace?.cwd);
    if (request !== oauthRequest.current) return;
    if (result.success && result.data) {
      setOAuthStatuses(Object.fromEntries(result.data.statuses.map(status => [oauthKey(status), status])));
      setOAuthErrors(current => {
        const nextErrors = { ...current };
        for (const server of servers) delete nextErrors[oauthKey(server)];
        return nextErrors;
      });
      return;
    }
    setOAuthStatuses({});
    const message = result.error ?? t('settings.mcp.oauth.unavailable');
    setOAuthErrors(current => ({
      ...current,
      ...Object.fromEntries(servers.map(server => [oauthKey(server), message])),
    }));
  }, [t, workspace?.cwd]);

  const load = useCallback(async (clear = false): Promise<void> => {
    const sequence = ++inventoryRequest.current;
    setLoading(true);
    setLoadError(undefined);
    if (clear) setInventory(undefined);
    const result = await getMcpConfig(workspace?.cwd);
    if (sequence !== inventoryRequest.current) return;
    if (result.success && result.data) {
      setInventory(result.data);
      void refreshOAuthStatuses(result.data);
    } else setLoadError(result.error);
    setLoading(false);
  }, [refreshOAuthStatuses, workspace?.cwd]);

  const reloadCanonical = useCallback(async (): Promise<void> => {
    await Promise.all([load(true), refreshWorkspace()]);
  }, [load, refreshWorkspace]);

  useEffect(() => {
    actionRequest.current++;
    testRequest.current++;
    setBusy(undefined);
    setTesting(undefined);
    setTestError(undefined);
    oauthRequest.current++;
    setOAuthStatuses({});
    setOAuthFlows({});
    setOAuthBusy(undefined);
    setOAuthErrors({});
    setImportWriting(false);
    setFeedback(undefined);
    setUndo(undefined);
    setPendingRemoval(undefined);
    setReplacement(undefined);
    setPendingControlFocus(undefined);
    void load(true);
    return () => {
      inventoryRequest.current++;
      actionRequest.current++;
      testRequest.current++;
      oauthRequest.current++;
    };
  }, [load, workspace?.operationTrusted, workspace?.trusted]);

  useEffect(() => {
    if (!undo) return;
    const delay = Math.max(0, Date.parse(undo.expiresAt) - Date.now());
    const timeout = window.setTimeout(() => {
      setUndo(current => current?.token === undo.token ? undefined : current);
    }, delay);
    const frame = window.requestAnimationFrame(() => undoButtonRef.current?.focus());
    return () => {
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
    };
  }, [undo]);

  useEffect(() => {
    const active = Object.entries(oauthFlows).filter(([, flow]) => activeOAuthFlow(flow));
    if (active.length === 0) return;
    let cancelled = false;
    let timeout: number;
    const poll = async () => {
      await Promise.all(active.map(async ([key, flow]) => {
        const result = await readMcpOAuthFlow(flow.flowId);
        if (cancelled) return;
        if (result.success && result.data) {
          setOAuthFlows(current => current[key]?.flowId === flow.flowId && activeOAuthFlow(current[key])
            ? { ...current, [key]: result.data! }
            : current);
          if (!activeOAuthFlow(result.data) && inventory) void refreshOAuthStatuses(inventory);
        } else {
          setOAuthErrors(current => ({
            ...current,
            [key]: result.error ?? t('settings.mcp.oauth.unavailable'),
          }));
        }
      }));
      if (!cancelled) timeout = window.setTimeout(() => void poll(), 1_000);
    };
    timeout = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [inventory, oauthFlows, refreshOAuthStatuses, t]);

  useFocusTrap(
    Boolean(pendingRemoval),
    removalDialogRef,
    () => { if (!busy) closeRemoval(true); },
    removalReturnFocus,
  );

  useEffect(() => {
    if (!pendingControlFocus || busy || importWriting || replacement || loading) return;
    const target = pendingControlFocus;
    const attribute = target.kind === 'edit' ? 'data-mcp-edit-key' : 'data-mcp-exposure-key';
    let attempts = 30;
    let frame = 0;
    const tryFocus = (): void => {
      const next = sectionRef.current?.querySelector<HTMLButtonElement | HTMLSelectElement>(
        `[${attribute}="${editKey(target.scope, target.name)}"]`,
      );
      if (next && !next.disabled) {
        next.focus();
        setPendingControlFocus(current => current === target ? undefined : current);
        return;
      }
      attempts--;
      if (attempts > 0) {
        frame = window.requestAnimationFrame(tryFocus);
        return;
      }
      const fallback = editReturnFocus.current?.isConnected ? editReturnFocus.current : refreshButtonRef.current;
      fallback?.focus();
      setPendingControlFocus(current => current === target ? undefined : current);
    };
    frame = window.requestAnimationFrame(tryFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [busy, importWriting, inventory, loading, pendingControlFocus, replacement]);

  const reconcileFailure = async (result: McpActionResponse): Promise<void> => {
    setFeedback(result.uncertain ? 'uncertain' : 'error');
    // A client timeout or transport failure may happen after commit; never retain stale mutation controls.
    await load(true);
  };

  const testServer = async (server: McpServerInventoryEntry): Promise<void> => {
    if (!inventory || busy || testing || importWriting || replacement || !server.valid) return;
    const request = ++testRequest.current;
    const key = `${server.scope}:${server.name}`;
    setTesting(key);
    setTestError(undefined);
    setFeedback(undefined);
    setUndo(undefined);
    const response = await testMcpConfigServer(server.scope, server.name, workspace?.cwd);
    if (request !== testRequest.current) return;
    if (response.success && response.data) {
      const tested = response.data;
      setInventory(current => current ? {
        ...current,
        servers: current.servers.map(item => item.scope === tested.scope
          && item.name === tested.name && item.configKey === tested.configKey
          ? { ...item, testStatus: tested.result }
          : item),
      } : current);
      // A fresh inventory also detects edits or trust changes that raced the test.
      await load(false);
    } else {
      setTestError(response.error ?? mcpTestMessage(locale, 'settings.mcp.test.failed'));
    }
    if (request === testRequest.current) setTesting(undefined);
  };

  const setEnabled = async (
    scope: McpConfigScope,
    names: string[],
    enabled: boolean,
    key: string,
  ): Promise<void> => {
    if (!inventory || busy || names.length === 0) return;
    const request = ++actionRequest.current;
    const revision = fileForScope(inventory, scope)?.revision ?? null;
    setBusy(key);
    setFeedback(undefined);
    setUndo(undefined);
    const result = await setMcpConfigEnabled(scope, names, enabled, revision, workspace?.cwd);
    if (request !== actionRequest.current) return;
    if (result.success && result.data) {
      setInventory(result.data.inventory);
      setFeedback(result.data.outcomes?.some(outcome => outcome.status === 'missing' || outcome.status === 'invalid')
        ? 'partial'
        : 'updated');
    } else {
      await reconcileFailure(result);
    }
    if (request === actionRequest.current) setBusy(undefined);
  };

  const setExposure = async (
    server: McpServerInventoryEntry,
    exposure: McpExposure,
  ): Promise<void> => {
    if (!inventory || busy || exposure === server.exposure) return;
    const request = ++actionRequest.current;
    const revision = fileForScope(inventory, server.scope)?.revision ?? null;
    setBusy(`exposure:${server.scope}:${server.name}`);
    setFeedback(undefined);
    setUndo(undefined);
    const result = await setMcpConfigExposure(
      server.scope,
      server.name,
      exposure,
      revision,
      workspace?.cwd,
    );
    if (request !== actionRequest.current) return;
    if (result.success && result.data) {
      setInventory(result.data.inventory);
      setFeedback('updated');
    } else {
      await reconcileFailure(result);
    }
    if (request === actionRequest.current) {
      setBusy(undefined);
      setPendingControlFocus({ kind: 'exposure', scope: server.scope, name: server.name });
    }
  };

  const closeRemoval = (restoreFocus: boolean): void => {
    setPendingRemoval(undefined);
    if (restoreFocus) window.requestAnimationFrame(() => removalReturnFocus.current?.focus());
  };

  const confirmRemoval = async (): Promise<void> => {
    if (!pendingRemoval || busy) return;
    const removal = pendingRemoval;
    const request = ++actionRequest.current;
    setBusy(`remove:${removal.scope}:${removal.name}`);
    setFeedback(undefined);
    const result = await removeMcpConfigServer(
      removal.scope,
      removal.name,
      removal.revision,
      workspace?.cwd,
    );
    if (request !== actionRequest.current) return;
    setPendingRemoval(undefined);
    if (result.success && result.data) {
      setInventory(result.data.inventory);
      setUndo(result.data.undo);
      setFeedback('removed');
    } else {
      await reconcileFailure(result);
      window.requestAnimationFrame(() => removalReturnFocus.current?.focus());
    }
    if (request === actionRequest.current) setBusy(undefined);
  };

  const restoreRemoval = async (): Promise<void> => {
    if (!undo || busy) return;
    const current = undo;
    const request = ++actionRequest.current;
    setBusy('restore');
    setFeedback(undefined);
    setUndo(undefined);
    const result = await restoreMcpConfigServer(current.token, workspace?.cwd);
    if (request !== actionRequest.current) return;
    if (result.success && result.data) {
      setInventory(result.data.inventory);
      setFeedback('restored');
    } else {
      await reconcileFailure(result);
    }
    if (request === actionRequest.current) setBusy(undefined);
  };

  const finishReplacement = (outcome: McpReplacementOutcome): void => {
    const selected = replacement;
    setReplacement(undefined);
    if (outcome.status === 'success') setFeedback('updated');
    else if (outcome.status === 'failure') setFeedback(outcome.uncertain ? 'uncertain' : 'error');
    const focusName = outcome.status === 'success' ? outcome.name : selected?.name;
    if (selected && focusName) {
      setPendingControlFocus({ kind: 'edit', scope: selected.scope, name: focusName });
    } else {
      refreshButtonRef.current?.focus();
    }
  };

  const oauthControlsDisabled = Boolean(busy) || Boolean(testing) || importWriting || Boolean(replacement);

  const startOAuth = async (server: McpServerInventoryEntry): Promise<void> => {
    const key = oauthKey(server);
    if (oauthBusy || oauthControlsDisabled) return;
    setOAuthBusy(key);
    setOAuthErrors(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const sequence = inventoryRequest.current;
    const result = await startMcpOAuth(server, workspace?.cwd);
    if (sequence !== inventoryRequest.current) return;
    if (result.success && result.data) {
      setOAuthFlows(current => ({ ...current, [key]: result.data! }));
      if (!activeOAuthFlow(result.data) && inventory) void refreshOAuthStatuses(inventory);
    } else {
      setOAuthErrors(current => ({
        ...current,
        [key]: result.error ?? t('settings.mcp.oauth.unavailable'),
      }));
    }
    setOAuthBusy(current => current === key ? undefined : current);
  };

  const pasteOAuth = async (server: McpServerInventoryEntry, value: string): Promise<void> => {
    const key = oauthKey(server);
    const flow = oauthFlows[key];
    if (!flow || oauthBusy) return;
    setOAuthBusy(key);
    const sequence = inventoryRequest.current;
    const result = await pasteMcpOAuthRedirect(flow.flowId, value);
    if (sequence !== inventoryRequest.current) return;
    if (result.success && result.data) {
      setOAuthFlows(current => ({ ...current, [key]: result.data! }));
      if (!activeOAuthFlow(result.data) && inventory) void refreshOAuthStatuses(inventory);
      setOAuthErrors(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } else {
      setOAuthErrors(current => ({
        ...current,
        [key]: result.error ?? t('settings.mcp.oauth.redirectRefused'),
      }));
    }
    setOAuthBusy(current => current === key ? undefined : current);
  };

  const cancelOAuth = async (server: McpServerInventoryEntry): Promise<void> => {
    const key = oauthKey(server);
    const flow = oauthFlows[key];
    if (!flow || oauthBusy) return;
    setOAuthBusy(key);
    const sequence = inventoryRequest.current;
    const result = await cancelMcpOAuthFlow(flow.flowId);
    if (sequence !== inventoryRequest.current) return;
    if (result.success && result.data) {
      setOAuthFlows(current => ({ ...current, [key]: result.data! }));
    } else {
      setOAuthErrors(current => ({
        ...current,
        [key]: result.error ?? t('settings.mcp.oauth.unavailable'),
      }));
    }
    setOAuthBusy(current => current === key ? undefined : current);
  };

  const logoutOAuth = async (server: McpServerInventoryEntry): Promise<void> => {
    const key = oauthKey(server);
    if (oauthBusy || oauthControlsDisabled) return;
    setOAuthBusy(key);
    const sequence = inventoryRequest.current;
    oauthRequest.current++;
    const result = await logoutMcpOAuth(server, workspace?.cwd);
    if (sequence !== inventoryRequest.current) return;
    oauthRequest.current++;
    if (result.success) {
      setOAuthStatuses(current => ({
        ...current,
        [key]: {
          scope: server.scope,
          name: server.name,
          configKey: server.configKey,
          available: true,
          signedIn: false,
          stateStored: false,
        },
      }));
      setOAuthFlows(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setOAuthErrors(current => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } else {
      setOAuthErrors(current => ({
        ...current,
        [key]: result.error ?? t('settings.mcp.oauth.unavailable'),
      }));
    }
    setOAuthBusy(current => current === key ? undefined : current);
  };

  const projectFile = inventory?.files.find(file => file.scope === 'project');
  const groups = (['global', 'project'] as const).map(scope => ({
    scope,
    file: inventory ? fileForScope(inventory, scope) : undefined,
    servers: inventory?.servers.filter(server => server.scope === scope) ?? [],
  })).filter(group => group.scope === 'global' || Boolean(inventory?.project));

  const feedbackKey = feedback ? `settings.mcp.mutation.${feedback}` : undefined;

  const controlsDisabled = Boolean(busy) || Boolean(testing) || Boolean(oauthBusy) || importWriting || Boolean(replacement);

  return <section ref={sectionRef} className="settings-section" id="mcp">
    <div className="mcp-settings-heading">
      <div>
        <h3>{t('settings.mcp.title')}</h3>
        <p className="settings-help">{t('settings.mcp.help')}</p>
      </div>
      <button ref={refreshButtonRef} type="button" disabled={loading || controlsDisabled}
        onClick={() => void load(true)}>{t('common.refresh')}</button>
    </div>
    {loading && !inventory && <p role="status">{t('common.loading')}…</p>}
    {loadError && <p role="alert" className="status-warning">{t('settings.mcp.loadFailed')} {loadError}</p>}
    {testError && <p role="alert" className="status-warning mcp-action-feedback">
      {mcpTestMessage(locale, 'settings.mcp.test.failed')} {testError}
    </p>}
    {feedbackKey && <p role="status" aria-live="polite"
      className={feedback === 'error' || feedback === 'uncertain' ? 'status-warning mcp-action-feedback' : 'status-success mcp-action-feedback'}>
      {t(feedbackKey)}
    </p>}
    {undo && <div className="mcp-undo" role="status">
      <span>{t('settings.mcp.undoAvailable')}</span>
      <button ref={undoButtonRef} type="button" disabled={Boolean(busy)} onClick={() => void restoreRemoval()}>
        {t('settings.mcp.undo')}
      </button>
    </div>}
    {inventory?.project && !inventory.project.contentTrusted && projectFile?.exists && <p role="status" className="plugin-trust-notice">
      {inventory.project.trustError ? t('settings.mcp.trustUnavailable') : t('settings.mcp.untrustedProject')}
    </p>}
    <McpImportPreview
      key={`${workspace?.cwd ?? 'global'}:${(workspace?.operationTrusted ?? workspace?.trusted) ? 'allowed' : 'blocked'}`}
      cwd={workspace?.cwd}
      disabled={Boolean(busy)}
      inventory={inventory}
      onInventory={next => {
        setInventory(next);
        void refreshWorkspace();
      }}
      onReload={reloadCanonical}
      onWritingChange={setImportWriting}
      replacement={replacement}
      onReplacementOutcome={finishReplacement}
    />
    {inventory && groups.map(group => {
      const actionable = group.servers.filter(server => server.valid);
      const enableNames = actionable.filter(server => !server.enabled).map(server => server.name);
      const disableNames = actionable.filter(server => server.enabled).map(server => server.name);
      const revision = group.file?.revision ?? null;
      return <fieldset className="mcp-scope" data-scope={group.scope} key={group.scope}>
        <legend>{t(SCOPE_KEYS[group.scope])}</legend>
        {actionable.length > 0 && <div className="mcp-group-actions" aria-label={t('settings.mcp.groupActions')}>
          <button type="button" disabled={controlsDisabled || enableNames.length === 0}
            onClick={() => void setEnabled(group.scope, enableNames, true, `group:${group.scope}`)}>
            {t('settings.mcp.enableAll')}
          </button>
          <button type="button" disabled={controlsDisabled || disableNames.length === 0}
            onClick={() => void setEnabled(group.scope, disableNames, false, `group:${group.scope}`)}>
            {t('settings.mcp.disableAll')}
          </button>
        </div>}
        {group.servers.length === 0
          ? <p className="settings-help">{group.scope === 'project' && projectFile?.exists && !inventory.project?.contentTrusted
            ? t('settings.mcp.projectLocked')
            : t('settings.mcp.empty')}</p>
          : <div className="settings-resource-list">{group.servers.map((server, index) => (
            <ServerCard
              server={server}
              disabled={controlsDisabled}
              testing={testing === `${server.scope}:${server.name}`}
              oauthStatus={oauthStatuses[oauthKey(server)]}
              oauthFlow={oauthFlows[oauthKey(server)]}
              oauthBusy={oauthBusy === oauthKey(server)}
              oauthError={oauthErrors[oauthKey(server)]}
              key={`${server.scope}:${server.name}:${index}`}
              onTest={() => void testServer(server)}
              onOAuthStart={() => void startOAuth(server)}
              onOAuthPaste={value => void pasteOAuth(server, value)}
              onOAuthCancel={() => void cancelOAuth(server)}
              onOAuthLogout={() => void logoutOAuth(server)}
              onToggle={() => void setEnabled(server.scope, [server.name], !server.enabled, `row:${server.scope}:${server.name}`)}
              onExposureChange={exposure => void setExposure(server, exposure)}
              onEdit={trigger => {
                const file = fileForScope(inventory, server.scope);
                if (!file?.revision || controlsDisabled) return;
                editReturnFocus.current = trigger;
                setFeedback(undefined);
                setUndo(undefined);
                setReplacement({ scope: server.scope, name: server.name, revision: file.revision });
              }}
              onRemove={trigger => {
                removalReturnFocus.current = trigger;
                setPendingRemoval({ scope: server.scope, name: server.name, revision });
              }}
            />
          ))}</div>}
      </fieldset>;
    })}
    {inventory?.files.some(file => file.problems.length > 0) && <details className="mcp-file-diagnostics">
      <summary>{t('settings.mcp.fileDiagnostics')}</summary>
      {inventory.files.filter(file => file.problems.length > 0).map(file => <div key={file.scope}>
        <code>{file.path}</code>
        <ul>{file.problems.map((item, index) => <li key={`${item.reason}:${index}`}>{t(PROBLEM_KEYS[item.reason])}</li>)}</ul>
      </div>)}
    </details>}
    {pendingRemoval && <div className="modal-backdrop mcp-remove-backdrop" role="presentation">
      <section ref={removalDialogRef} className="mcp-remove-dialog" role="alertdialog" aria-modal="true" tabIndex={-1}
        aria-labelledby="mcp-remove-title" aria-describedby="mcp-remove-description">
        <h4 id="mcp-remove-title">{t('settings.mcp.removeTitle')}</h4>
        <p id="mcp-remove-description">{t('settings.mcp.removeDescription')}</p>
        <code>{pendingRemoval.name}</code>
        <div className="mcp-dialog-actions">
          <button data-autofocus type="button" disabled={Boolean(busy)} onClick={() => closeRemoval(true)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="mcp-remove-button" disabled={Boolean(busy)} onClick={() => void confirmRemoval()}>
            {busy ? t('settings.mcp.working') : t('settings.mcp.remove')}
          </button>
        </div>
      </section>
    </div>}
  </section>;
}
