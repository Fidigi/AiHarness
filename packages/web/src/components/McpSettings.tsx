import { useEffect, useRef, useState } from 'react';
import type {
  McpConfigInventory,
  McpConfigProblemReason,
  McpConfigScope,
  McpServerInventoryEntry,
} from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import { getMcpConfig } from '../services/api';
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

function serverState(server: McpServerInventoryEntry): 'invalid' | 'shadowed' | 'disabled' | 'configured' {
  if (!server.valid) return 'invalid';
  if (server.shadowedByProject) return 'shadowed';
  if (!server.enabled) return 'disabled';
  return 'configured';
}

function ServerCard({ server }: { server: McpServerInventoryEntry }) {
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
    </div>
  </article>;
}

/** Read-only MCP configuration inventory; runtime connections are intentionally not part of this panel. */
export function McpSettings() {
  const { t } = useI18n();
  const workspace = useSessionStore(state => state.workspace);
  const [inventory, setInventory] = useState<McpConfigInventory>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const requestSequence = useRef(0);

  const load = async (cwd = workspace?.cwd, clear = false): Promise<void> => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError(undefined);
    if (clear) setInventory(undefined);
    const result = await getMcpConfig(cwd);
    if (sequence !== requestSequence.current) return;
    if (result.success && result.data) setInventory(result.data);
    else setLoadError(result.error);
    setLoading(false);
  };

  useEffect(() => {
    void load(workspace?.cwd, true);
    return () => { requestSequence.current++; };
  }, [workspace?.cwd, workspace?.trusted]);

  const projectFile = inventory?.files.find(file => file.scope === 'project');
  const groups = (['global', 'project'] as const).map(scope => ({
    scope,
    servers: inventory?.servers.filter(server => server.scope === scope) ?? [],
  })).filter(group => group.scope === 'global' || Boolean(inventory?.project));

  return <section className="settings-section" id="mcp">
    <div className="mcp-settings-heading">
      <div>
        <h3>{t('settings.mcp.title')}</h3>
        <p className="settings-help">{t('settings.mcp.help')}</p>
      </div>
      <button type="button" disabled={loading} onClick={() => void load(workspace?.cwd)}>{t('common.refresh')}</button>
    </div>
    {loading && !inventory && <p role="status">{t('common.loading')}…</p>}
    {loadError && <p role="alert" className="status-warning">{t('settings.mcp.loadFailed')} {loadError}</p>}
    {inventory?.project && !inventory.project.contentTrusted && projectFile?.exists && <p role="status" className="plugin-trust-notice">
      {inventory.project.trustError ? t('settings.mcp.trustUnavailable') : t('settings.mcp.untrustedProject')}
    </p>}
    {inventory && groups.map(group => <fieldset className="mcp-scope" data-scope={group.scope} key={group.scope}>
      <legend>{t(SCOPE_KEYS[group.scope])}</legend>
      {group.servers.length === 0
        ? <p className="settings-help">{group.scope === 'project' && projectFile?.exists && !inventory.project?.contentTrusted
          ? t('settings.mcp.projectLocked')
          : t('settings.mcp.empty')}</p>
        : <div className="settings-resource-list">{group.servers.map((server, index) => (
          <ServerCard server={server} key={`${server.scope}:${server.name}:${index}`} />
        ))}</div>}
    </fieldset>)}
    {inventory?.files.some(file => file.problems.length > 0) && <details className="mcp-file-diagnostics">
      <summary>{t('settings.mcp.fileDiagnostics')}</summary>
      {inventory.files.filter(file => file.problems.length > 0).map(file => <div key={file.scope}>
        <code>{file.path}</code>
        <ul>{file.problems.map((item, index) => <li key={`${item.reason}:${index}`}>{t(PROBLEM_KEYS[item.reason])}</li>)}</ul>
      </div>)}
    </details>}
  </section>;
}
