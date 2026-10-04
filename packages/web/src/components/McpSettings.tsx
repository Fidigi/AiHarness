import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  McpConfigFileInventory,
  McpConfigInventory,
  McpConfigProblemReason,
  McpConfigScope,
  McpServerInventoryEntry,
} from '@ai-harness/core';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../hooks/useI18n';
import { getMcpConfig } from '../services/api';
import {
  removeMcpConfigServer,
  restoreMcpConfigServer,
  setMcpConfigEnabled,
  type McpActionResponse,
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

function ServerCard({
  server,
  disabled,
  onToggle,
  onRemove,
}: {
  server: McpServerInventoryEntry;
  disabled: boolean;
  onToggle: () => void;
  onRemove: (trigger: HTMLButtonElement) => void;
}) {
  const { t } = useI18n();
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
    <div>
      <span className={state === 'configured' ? 'status-success' : 'status-warning'}>
        {t(`settings.mcp.state.${state}`)}
      </span>
      <small>{t(`settings.mcp.exposure.${server.exposure}`)}</small>
      {server.masked && <small>{t('settings.mcp.masked')}</small>}
      {server.replacesGlobal && <small>{t('settings.mcp.replacesGlobal')}</small>}
      {server.valid && <div className="mcp-row-actions">
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
  </article>;
}

/** Local MCP configuration administration. It never connects, resolves values, runs commands, or initializes OAuth. */
export function McpSettings() {
  const { t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [inventory, setInventory] = useState<McpConfigInventory>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<FeedbackKind>();
  const [undo, setUndo] = useState<UndoState>();
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval>();
  const inventoryRequest = useRef(0);
  const actionRequest = useRef(0);
  const removalReturnFocus = useRef<HTMLButtonElement | null>(null);
  const removalDialogRef = useRef<HTMLElement | null>(null);
  const undoButtonRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (clear = false): Promise<void> => {
    const sequence = ++inventoryRequest.current;
    setLoading(true);
    setLoadError(undefined);
    if (clear) setInventory(undefined);
    const result = await getMcpConfig(workspace?.cwd);
    if (sequence !== inventoryRequest.current) return;
    if (result.success && result.data) setInventory(result.data);
    else setLoadError(result.error);
    setLoading(false);
  }, [workspace?.cwd]);

  useEffect(() => {
    actionRequest.current++;
    setBusy(undefined);
    setFeedback(undefined);
    setUndo(undefined);
    setPendingRemoval(undefined);
    void load(true);
    return () => {
      inventoryRequest.current++;
      actionRequest.current++;
    };
  }, [load, workspace?.trusted]);

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

  useFocusTrap(
    Boolean(pendingRemoval),
    removalDialogRef,
    () => { if (!busy) closeRemoval(true); },
    removalReturnFocus,
  );

  const reconcileFailure = async (result: McpActionResponse): Promise<void> => {
    setFeedback(result.uncertain ? 'uncertain' : 'error');
    // A client timeout or transport failure may happen after commit; never retain stale mutation controls.
    await load(true);
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

  const projectFile = inventory?.files.find(file => file.scope === 'project');
  const groups = (['global', 'project'] as const).map(scope => ({
    scope,
    file: inventory ? fileForScope(inventory, scope) : undefined,
    servers: inventory?.servers.filter(server => server.scope === scope) ?? [],
  })).filter(group => group.scope === 'global' || Boolean(inventory?.project));

  const feedbackKey = feedback ? `settings.mcp.mutation.${feedback}` : undefined;

  return <section className="settings-section" id="mcp">
    <div className="mcp-settings-heading">
      <div>
        <h3>{t('settings.mcp.title')}</h3>
        <p className="settings-help">{t('settings.mcp.help')}</p>
      </div>
      <button type="button" disabled={loading || Boolean(busy)} onClick={() => void load(true)}>{t('common.refresh')}</button>
    </div>
    {loading && !inventory && <p role="status">{t('common.loading')}…</p>}
    {loadError && <p role="alert" className="status-warning">{t('settings.mcp.loadFailed')} {loadError}</p>}
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
    {inventory && groups.map(group => {
      const actionable = group.servers.filter(server => server.valid);
      const enableNames = actionable.filter(server => !server.enabled).map(server => server.name);
      const disableNames = actionable.filter(server => server.enabled).map(server => server.name);
      const revision = group.file?.revision ?? null;
      return <fieldset className="mcp-scope" data-scope={group.scope} key={group.scope}>
        <legend>{t(SCOPE_KEYS[group.scope])}</legend>
        {actionable.length > 0 && <div className="mcp-group-actions" aria-label={t('settings.mcp.groupActions')}>
          <button type="button" disabled={Boolean(busy) || enableNames.length === 0}
            onClick={() => void setEnabled(group.scope, enableNames, true, `group:${group.scope}`)}>
            {t('settings.mcp.enableAll')}
          </button>
          <button type="button" disabled={Boolean(busy) || disableNames.length === 0}
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
              disabled={Boolean(busy)}
              key={`${server.scope}:${server.name}:${index}`}
              onToggle={() => void setEnabled(server.scope, [server.name], !server.enabled, `row:${server.scope}:${server.name}`)}
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
