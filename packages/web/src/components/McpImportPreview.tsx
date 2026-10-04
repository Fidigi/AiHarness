import { useEffect, useRef, useState } from 'react';
import type {
  McpConfigScope,
  McpImportEntryPreview,
  McpImportNote,
  McpImportNoteCode,
  McpImportScopeBlockReason,
  McpImportScopeConfirmation,
  McpImportSource,
  McpImportVariableAvailability,
  McpImportPreview as McpImportPreviewResult,
} from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import { previewMcpImport } from '../services/mcp-api';
import { mcpImportMessage, type McpImportMessageKey } from './mcp-import-messages';

const SOURCE_KEYS: Record<McpImportSource, McpImportMessageKey> = {
  url: 'settings.mcp.import.source.url',
  'command-line': 'settings.mcp.import.source.command',
  'aiharness-command': 'settings.mcp.import.source.command',
  'claude-command': 'settings.mcp.import.source.command',
  'codex-command': 'settings.mcp.import.source.command',
  'gemini-command': 'settings.mcp.import.source.command',
  'vscode-command': 'settings.mcp.import.source.command',
  'mcp-json': 'settings.mcp.import.source.json',
  'vscode-json': 'settings.mcp.import.source.json',
  'zed-json': 'settings.mcp.import.source.json',
  'opencode-json': 'settings.mcp.import.source.json',
  'server-object': 'settings.mcp.import.source.json',
  'server-map': 'settings.mcp.import.source.json',
  'cursor-install-link': 'settings.mcp.import.source.link',
  'vscode-install-link': 'settings.mcp.import.source.link',
  'visual-studio-install-link': 'settings.mcp.import.source.link',
  'copilot-app-install-link': 'settings.mcp.import.source.link',
};

const NOTE_KEYS: Record<McpImportNoteCode, McpImportMessageKey> = {
  'command-value': 'settings.mcp.import.note.commandValue',
  'dropped-properties': 'settings.mcp.import.note.droppedProperties',
  'empty-input': 'settings.mcp.import.note.emptyInput',
  'host-variable-confirmation': 'settings.mcp.import.note.hostVariableConfirmation',
  'insecure-http': 'settings.mcp.import.note.insecureHttp',
  'input-too-large': 'settings.mcp.import.note.inputTooLarge',
  'install-link-invalid': 'settings.mcp.import.note.installLinkInvalid',
  'invalid-entry': 'settings.mcp.import.note.invalidEntry',
  'invalid-json': 'settings.mcp.import.note.invalidJson',
  'literal-escaped': 'settings.mcp.import.note.literalEscaped',
  'literal-secret': 'settings.mcp.import.note.literalSecret',
  'management-command': 'settings.mcp.import.note.managementCommand',
  'missing-value': 'settings.mcp.import.note.missingValue',
  'missing-variable': 'settings.mcp.import.note.missingVariable',
  'name-derived': 'settings.mcp.import.note.nameDerived',
  'name-sanitized': 'settings.mcp.import.note.nameSanitized',
  'name-taken': 'settings.mcp.import.note.nameTaken',
  'no-server': 'settings.mcp.import.note.noServer',
  'reserved-variable': 'settings.mcp.import.note.reservedVariable',
  'too-deep': 'settings.mcp.import.note.tooDeep',
  'too-many-fields': 'settings.mcp.import.note.tooManyFields',
  'too-many-servers': 'settings.mcp.import.note.tooManyServers',
  'unrecognized-input': 'settings.mcp.import.note.unrecognizedInput',
  'unsafe-shell': 'settings.mcp.import.note.unsafeShell',
  'unsupported-reference': 'settings.mcp.import.note.unsupportedReference',
  'unsupported-scheme': 'settings.mcp.import.note.unsupportedScheme',
  'unsupported-transport': 'settings.mcp.import.note.unsupportedTransport',
  'userinfo-moved': 'settings.mcp.import.note.userinfoMoved',
};

const SCOPE_REASON_KEYS: Record<McpImportScopeBlockReason, McpImportMessageKey> = {
  'config-unavailable': 'settings.mcp.import.scopeReason.configUnavailable',
  'invalid-entry': 'settings.mcp.import.scopeReason.invalidEntry',
  'literal-secret': 'settings.mcp.import.scopeReason.literalSecret',
  'name-taken': 'settings.mcp.import.scopeReason.nameTaken',
  'no-project': 'settings.mcp.import.scopeReason.noProject',
  'reserved-variable': 'settings.mcp.import.scopeReason.reservedVariable',
  'trust-required': 'settings.mcp.import.scopeReason.trustRequired',
  'trust-unavailable': 'settings.mcp.import.scopeReason.trustUnavailable',
};

const SCOPE_CONFIRMATION_KEYS: Record<McpImportScopeConfirmation, McpImportMessageKey> = {
  'literal-secret': 'settings.mcp.import.scopeConfirmation.literalSecret',
  'remote-host-variable': 'settings.mcp.import.scopeConfirmation.remoteHostVariable',
};

const AVAILABILITY_KEYS: Record<McpImportVariableAvailability, McpImportMessageKey> = {
  available: 'settings.mcp.import.variable.available',
  missing: 'settings.mcp.import.variable.missing',
  reserved: 'settings.mcp.import.variable.reserved',
};

function NoteList({ notes }: { notes: McpImportNote[] }) {
  const { locale } = useI18n();
  const m = mcpImportMessage.bind(null, locale);
  if (notes.length === 0) return null;
  return <ul className="mcp-import-notes">
    {notes.map((item, index) => <li className={`mcp-import-note-${item.severity}`} key={`${item.code}:${item.field ?? ''}:${index}`}>
      {m(NOTE_KEYS[item.code], {
        field: item.field ?? m('settings.mcp.import.unspecifiedField'),
        count: item.count ?? 1,
      })}
    </li>)}
  </ul>;
}

function ScopeResult({ scope, entry }: { scope: McpConfigScope; entry: McpImportEntryPreview }) {
  const { locale, t } = useI18n();
  const m = mcpImportMessage.bind(null, locale);
  const result = entry.scopes[scope];
  return <div className="mcp-import-scope-result">
    <strong>{t(`settings.mcp.scope.${scope}`)}</strong>
    <span className={result.allowed ? 'status-success' : 'status-warning'}>
      {m(result.allowed ? 'settings.mcp.import.scopeAllowed' : 'settings.mcp.import.scopeBlocked')}
    </span>
    {!result.allowed && <ul>{result.reasons.map(reason => <li key={reason}>{m(SCOPE_REASON_KEYS[reason])}</li>)}</ul>}
    {result.confirmations.length > 0 && <ul>{result.confirmations.map(confirmation => (
      <li key={confirmation}>{m(SCOPE_CONFIRMATION_KEYS[confirmation])}</li>
    ))}</ul>}
  </div>;
}

function PreviewEntry({ entry }: { entry: McpImportEntryPreview }) {
  const { locale, t } = useI18n();
  const m = mcpImportMessage.bind(null, locale);
  const target = entry.persisted.transport === 'stdio'
    ? [entry.persisted.command, ...(entry.persisted.args ?? [])].filter(Boolean).join(' ')
    : entry.persisted.url;
  return <article className="settings-resource-card mcp-import-entry" aria-label={entry.name}>
    <header>
      <div>
        <strong>{entry.name}</strong>
        <code>{m(SOURCE_KEYS[entry.source])}{entry.scopeHint ? ` · ${t(`settings.mcp.scope.${entry.scopeHint}`)}` : ''}</code>
      </div>
      <span className={entry.complete ? 'status-success' : 'status-warning'}>
        {m(entry.complete ? 'settings.mcp.import.complete' : 'settings.mcp.import.incomplete')}
      </span>
    </header>
    <section className="mcp-import-persisted" aria-label={m('settings.mcp.import.persistedShape')}>
      <h5>{m('settings.mcp.import.persistedShape')}</h5>
      <code>{entry.persisted.transport
        ? t(`settings.mcp.transport.${entry.persisted.transport}`)
        : t('settings.mcp.transport.unknown')}</code>
      {target && <small>{target}</small>}
      {entry.persisted.envNames.length > 0 && <small>{t('settings.mcp.envNames', { names: entry.persisted.envNames.join(', ') })}</small>}
      {entry.persisted.headerNames.length > 0 && <small>{t('settings.mcp.headerNames', { names: entry.persisted.headerNames.join(', ') })}</small>}
      {entry.persisted.oauthFields.length > 0 && <small>{m('settings.mcp.import.oauthFields', { fields: entry.persisted.oauthFields.join(', ') })}</small>}
      {entry.persisted.commandFields.length > 0 && <small>{t('settings.mcp.commandFields', { fields: entry.persisted.commandFields.join(', ') })}</small>}
      {entry.persisted.masked && <small>{t('settings.mcp.masked')}</small>}
    </section>
    {entry.fields.length > 0 && <section>
      <h5>{m('settings.mcp.import.fields')}</h5>
      <ul>{entry.fields.map(field => <li key={field.id}>
        <code>{field.field}</code> · {m(`settings.mcp.import.fieldKind.${field.kind}`)}
        {!field.canReference && ` · ${m('settings.mcp.import.referenceUnsupported')}`}
      </li>)}</ul>
    </section>}
    {entry.variables.length > 0 && <section>
      <h5>{m('settings.mcp.import.variables')}</h5>
      <ul>{entry.variables.map(variable => <li key={`${variable.field}:${variable.name}`}>
        <code>{variable.field}</code> → <code>{variable.name}</code> · {m(AVAILABILITY_KEYS[variable.availability])}
        {variable.confirmationRequired && ` · ${m('settings.mcp.import.remoteConfirmation')}`}
      </li>)}</ul>
    </section>}
    {entry.literalSecretFields.length > 0 && <section>
      <h5>{m('settings.mcp.import.literalSecrets')}</h5>
      <p className="settings-help">{entry.literalSecretFields.join(', ')}</p>
    </section>}
    <div className="mcp-import-scopes">
      <ScopeResult scope="global" entry={entry} />
      <ScopeResult scope="project" entry={entry} />
    </div>
    <NoteList notes={entry.notes} />
  </article>;
}

export function McpImportPreview({ cwd, disabled }: { cwd?: string; disabled: boolean }) {
  const { locale } = useI18n();
  const m = mcpImportMessage.bind(null, locale);
  const [text, setText] = useState('');
  const [nativeSyntax, setNativeSyntax] = useState(false);
  const [preview, setPreview] = useState<McpImportPreviewResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current++;
    controller.current?.abort();
  }, []);

  const clearResult = (): void => {
    request.current++;
    controller.current?.abort();
    setPreview(undefined);
    setError(undefined);
    setLoading(false);
  };

  const runPreview = async (): Promise<void> => {
    if (!text.trim() || disabled || loading) return;
    const sequence = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(undefined);
    setPreview(undefined);
    try {
      const result = await previewMcpImport({
        text,
        syntax: nativeSyntax ? 'aiharness' : 'foreign',
        ...(cwd ? { cwd } : {}),
      }, nextController.signal);
      if (sequence === request.current) setPreview(result);
    } catch {
      if (sequence === request.current && !nextController.signal.aborted) {
        setError(m('settings.mcp.import.failed'));
      }
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  };

  return <details className="mcp-import-panel">
    <summary>{m('settings.mcp.import.title')}</summary>
    <div className="mcp-import-body">
      <p className="settings-help">{m('settings.mcp.import.help')}</p>
      <label htmlFor="mcp-import-text">{m('settings.mcp.import.pasteLabel')}</label>
      <textarea id="mcp-import-text" rows={6} maxLength={262_144} value={text}
        placeholder={m('settings.mcp.import.placeholder')}
        onChange={event => {
          clearResult();
          setText(event.target.value);
        }} />
      <label className="mcp-import-syntax">
        <input type="checkbox" checked={nativeSyntax} onChange={event => {
          clearResult();
          setNativeSyntax(event.target.checked);
        }} />
        <span>{m('settings.mcp.import.nativeSyntax')}</span>
      </label>
      <p className="settings-help">{m('settings.mcp.import.syntaxHelp')}</p>
      <div className="mcp-import-actions">
        <button type="button" disabled={disabled || loading || !text.trim()} onClick={() => void runPreview()}>
          {loading ? m('settings.mcp.import.previewing') : m('settings.mcp.import.preview')}
        </button>
        <button type="button" disabled={!text && !preview && !error} onClick={() => {
          clearResult();
          setText('');
        }}>{m('settings.mcp.import.clear')}</button>
      </div>
      {loading && <p role="status">{m('settings.mcp.import.previewing')}</p>}
      {error && <p role="alert" className="status-warning">{error}</p>}
      {preview && <section className="mcp-import-results" aria-live="polite" aria-labelledby="mcp-import-results-title">
        <h4 id="mcp-import-results-title">{m('settings.mcp.import.results')}</h4>
        <NoteList notes={preview.notes} />
        {preview.entries.length === 0
          ? <p className="settings-help">{m('settings.mcp.import.noEntries')}</p>
          : <div className="settings-resource-list">{preview.entries.map((entry, index) => (
            <PreviewEntry entry={entry} key={`${entry.name}:${index}`} />
          ))}</div>}
        <p className="settings-help">{m('settings.mcp.import.noWrite')}</p>
      </section>}
    </div>
  </details>;
}
