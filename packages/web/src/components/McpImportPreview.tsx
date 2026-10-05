import { useEffect, useRef, useState } from 'react';
import type {
  McpConfigInventory,
  McpConfigScope,
  McpImportEntryPreview,
  McpImportFieldValue,
  McpImportNote,
  McpImportNoteCode,
  McpImportScopeBlockReason,
  McpImportScopeConfirmation,
  McpImportSource,
  McpImportVariableAvailability,
  McpImportPreview as McpImportPreviewResult,
} from '@ai-harness/core';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useI18n } from '../hooks/useI18n';
import {
  importMcpConfigServer,
  previewMcpImport,
  replaceMcpConfigServer,
  type McpReplaceTarget,
} from '../services/mcp-api';
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

export type McpReplacementOutcome =
  | { status: 'success'; name: string }
  | { status: 'failure'; uncertain: boolean }
  | { status: 'cancel' };

interface ImportDraft {
  entry: McpImportEntryPreview;
  entryIndex: number;
  scope: McpConfigScope;
  name: string;
  values: Record<string, string>;
  referenceModes: Record<string, boolean>;
  secretReferences: Record<string, string>;
  literalConfirmed: boolean;
  remoteConfirmed: boolean;
}

function isReferenceableField(field: string): boolean {
  return field.startsWith('env.') || field.startsWith('headers.') || field === 'oauth.clientSecret';
}

function isRemoteReferenceField(field: string): boolean {
  return field.startsWith('headers.') || field === 'oauth.clientSecret';
}

function canConfigure(entry: McpImportEntryPreview, scope: McpConfigScope): boolean {
  return entry.scopes[scope].reasons.every(reason => {
    if (reason === 'name-taken') return true;
    if (reason === 'invalid-entry') return entry.fields.length > 0;
    if (reason === 'literal-secret') {
      return entry.literalSecretFields.every(field => entry.referenceableLiteralSecretFields.includes(field));
    }
    return false;
  });
}

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

function PreviewEntry({
  disabled,
  entry,
  entryIndex,
  onConfigure,
  replacementScope,
}: {
  disabled: boolean;
  entry: McpImportEntryPreview;
  entryIndex: number;
  onConfigure: (entry: McpImportEntryPreview, entryIndex: number, scope: McpConfigScope) => void;
  replacementScope?: McpConfigScope;
}) {
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
      {(replacementScope ? [replacementScope] : ['global', 'project'] as const)
        .map(scope => <ScopeResult scope={scope} entry={entry} key={scope} />)}
    </div>
    <div className="mcp-import-save-actions">
      {(replacementScope ? [replacementScope] : ['global', 'project'] as const).map(scope => <button type="button" key={scope}
        disabled={disabled || !canConfigure(entry, scope)}
        onClick={() => onConfigure(entry, entryIndex, scope)}>
        {replacementScope
          ? m('settings.mcp.edit.configure')
          : m(scope === 'global' ? 'settings.mcp.import.saveGlobal' : 'settings.mcp.import.saveProject')}
      </button>)}
    </div>
    <NoteList notes={entry.notes} />
  </article>;
}

export function McpImportPreview({
  cwd,
  disabled,
  inventory,
  onInventory,
  onReload,
  onReplacementOutcome,
  onWritingChange,
  replacement,
}: {
  cwd?: string;
  disabled: boolean;
  inventory?: McpConfigInventory;
  onInventory: (inventory: McpConfigInventory) => void;
  onReload: () => Promise<void>;
  onReplacementOutcome?: (outcome: McpReplacementOutcome) => void;
  onWritingChange?: (writing: boolean) => void;
  replacement?: McpReplaceTarget;
}) {
  const { locale } = useI18n();
  const m = mcpImportMessage.bind(null, locale);
  const [text, setText] = useState('');
  const [nativeSyntax, setNativeSyntax] = useState(false);
  const [preview, setPreview] = useState<McpImportPreviewResult>();
  const [error, setError] = useState<string>();
  const [writeMessage, setWriteMessage] = useState<'success' | 'error'>();
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState<ImportDraft>();
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const replacementKey = replacement
    ? `${replacement.scope}:${replacement.name}:${replacement.revision}`
    : '';
  const inventoryKey = inventory?.files
    .map(file => `${file.scope}:${file.exists ? file.revision ?? 'invalid' : 'missing'}`)
    .join('|') ?? '';

  const closeDraft = (): void => {
    if (!writing) setDraft(undefined);
  };
  useFocusTrap(Boolean(draft), dialogRef, closeDraft);

  useEffect(() => () => {
    request.current++;
    controller.current?.abort();
  }, []);

  useEffect(() => {
    request.current++;
    controller.current?.abort();
    setText('');
    setNativeSyntax(false);
    setPreview(undefined);
    setDraft(undefined);
    setError(undefined);
    setWriteMessage(undefined);
    setLoading(false);
    const frame = replacementKey
      ? window.requestAnimationFrame(() => textRef.current?.focus())
      : undefined;
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [replacementKey]);

  useEffect(() => {
    request.current++;
    controller.current?.abort();
    setPreview(undefined);
    setDraft(undefined);
    setLoading(false);
  }, [inventoryKey]);

  const clearResult = (): void => {
    request.current++;
    controller.current?.abort();
    setPreview(undefined);
    setDraft(undefined);
    setError(undefined);
    setWriteMessage(undefined);
    setLoading(false);
  };

  const runPreview = async (): Promise<void> => {
    if (!text.trim() || disabled || loading || writing) return;
    const sequence = ++request.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(undefined);
    setWriteMessage(undefined);
    setPreview(undefined);
    try {
      const result = await previewMcpImport({
        text,
        syntax: nativeSyntax ? 'aiharness' : 'foreign',
        ...(cwd ? { cwd } : {}),
        ...(replacement ? { replacement } : {}),
      }, nextController.signal);
      if (sequence === request.current) setPreview(result);
    } catch {
      if (sequence === request.current && !nextController.signal.aborted) {
        setError(m(replacement ? 'settings.mcp.edit.previewFailed' : 'settings.mcp.import.failed'));
        if (replacement) {
          try {
            await onReload();
          } catch {
            // Keep the localized failure while discarding revision-backed edit controls.
          }
          onReplacementOutcome?.({ status: 'failure', uncertain: false });
        }
      }
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  };

  const openDraft = (entry: McpImportEntryPreview, entryIndex: number, scope: McpConfigScope): void => {
    setWriteMessage(undefined);
    setDraft({
      entry,
      entryIndex,
      scope,
      name: replacement?.name ?? entry.name,
      values: Object.fromEntries(entry.fields.map(field => [field.field, ''])),
      referenceModes: Object.fromEntries(entry.fields.map(field => [field.field, false])),
      secretReferences: Object.fromEntries(entry.referenceableLiteralSecretFields.map(field => [field, ''])),
      literalConfirmed: false,
      remoteConfirmed: false,
    });
  };

  const remoteNames = new Set<string>();
  if (draft) {
    for (const variable of draft.entry.variables) {
      if (variable.confirmationRequired) remoteNames.add(variable.name);
    }
    for (const field of draft.entry.fields) {
      if (draft.referenceModes[field.field] && isRemoteReferenceField(field.field)) {
        const name = draft.values[field.field]?.trim();
        if (name) remoteNames.add(name);
      }
    }
    for (const [field, value] of Object.entries(draft.secretReferences)) {
      if (value.trim() && isRemoteReferenceField(field)) remoteNames.add(value.trim());
    }
  }
  const confirmedRemoteNames = [...remoteNames].sort();
  const unreplacedLiteralFields = draft?.entry.literalSecretFields
    .filter(field => !draft.secretReferences[field]?.trim()) ?? [];
  const missingLiteralFields = draft?.entry.fields.filter(field => !draft.referenceModes[field.field]) ?? [];
  const knownMissingSecretFields = missingLiteralFields.filter(field => field.kind === 'secret');
  const needsGlobalLiteralConfirmation = unreplacedLiteralFields.length > 0 || missingLiteralFields.length > 0;
  const projectLiteralBlocked = draft?.scope === 'project'
    && (unreplacedLiteralFields.length > 0 || knownMissingSecretFields.length > 0);
  const fieldsReady = draft?.entry.fields.every(field => Boolean(draft.values[field.field]?.trim())) ?? false;
  const readyToWrite = Boolean(draft && inventory && draft.name.trim() && fieldsReady
    && !disabled && !projectLiteralBlocked
    && (draft.scope !== 'global' || !needsGlobalLiteralConfirmation || draft.literalConfirmed)
    && (confirmedRemoteNames.length === 0 || draft.remoteConfirmed));

  const submitImport = async (): Promise<void> => {
    if (!draft || !inventory || !readyToWrite || writing) return;
    const selected = draft;
    const values: Record<string, McpImportFieldValue> = {};
    for (const field of selected.entry.fields) {
      const value = selected.values[field.field]!.trim();
      values[field.field] = selected.referenceModes[field.field] ? { reference: value } : value;
    }
    const secretReferences = Object.fromEntries(Object.entries(selected.secretReferences)
      .filter(([, value]) => Boolean(value.trim()))
      .map(([field, value]) => [field, value.trim()]));
    request.current++;
    controller.current?.abort();
    setWriting(true);
    onWritingChange?.(true);
    setError(undefined);
    setWriteMessage(undefined);
    let failureUncertain = true;
    try {
      const file = inventory.files.find(item => item.scope === selected.scope);
      const writeRequest = {
        scope: selected.scope,
        revision: replacement?.revision ?? file?.revision ?? null,
        text,
        syntax: nativeSyntax ? 'aiharness' as const : 'foreign' as const,
        entryIndex: selected.entryIndex,
        name: selected.name.trim(),
        values,
        secretReferences,
        confirmations: {
          ...(selected.scope === 'global' && needsGlobalLiteralConfirmation ? { literalSecret: true as const } : {}),
          ...(confirmedRemoteNames.length > 0 ? { remoteHostVariables: confirmedRemoteNames } : {}),
        },
        ...(cwd ? { cwd } : {}),
      };
      const result = replacement
        ? await replaceMcpConfigServer({ ...writeRequest, targetName: replacement.name })
        : await importMcpConfigServer(writeRequest);
      if (!result.success || !result.data) {
        failureUncertain = result.uncertain ?? true;
        throw new Error('MCP import or replacement failed');
      }
      setDraft(undefined);
      setPreview(undefined);
      setText('');
      onInventory(result.data.inventory);
      if (replacement) {
        const updatedName = result.data.updated?.name;
        if (!updatedName) throw new Error('MCP replacement identity is missing');
        onReplacementOutcome?.({ status: 'success', name: updatedName });
      } else {
        setWriteMessage('success');
      }
    } catch {
      setDraft(undefined);
      setPreview(undefined);
      if (!replacement) setWriteMessage('error');
      try {
        await onReload();
      } catch {
        // Keep the generic local failure and no revision-backed mutation controls.
      }
      if (replacement) onReplacementOutcome?.({ status: 'failure', uncertain: failureUncertain });
    } finally {
      setWriting(false);
      onWritingChange?.(false);
    }
  };

  return <>
    <details className="mcp-import-panel" open={replacement ? true : undefined}
      onToggle={event => {
        if (replacement && !event.currentTarget.open) event.currentTarget.open = true;
      }}>
      <summary>{replacement
        ? m('settings.mcp.edit.title', { name: replacement.name })
        : m('settings.mcp.import.title')}</summary>
      <div className="mcp-import-body">
        <p className="settings-help">{m(replacement
          ? 'settings.mcp.edit.help'
          : 'settings.mcp.import.help')}</p>
        <label htmlFor="mcp-import-text">{m(replacement
          ? 'settings.mcp.edit.pasteLabel'
          : 'settings.mcp.import.pasteLabel')}</label>
        <textarea ref={textRef} id="mcp-import-text" rows={6} maxLength={262_144} value={text} disabled={writing}
          placeholder={m(replacement ? 'settings.mcp.edit.placeholder' : 'settings.mcp.import.placeholder')}
          onChange={event => {
            clearResult();
            setText(event.target.value);
          }} />
        <label className="mcp-import-syntax">
          <input type="checkbox" checked={nativeSyntax} disabled={writing} onChange={event => {
            clearResult();
            setNativeSyntax(event.target.checked);
          }} />
          <span>{m('settings.mcp.import.nativeSyntax')}</span>
        </label>
        <p className="settings-help">{m('settings.mcp.import.syntaxHelp')}</p>
        <div className="mcp-import-actions">
          <button type="button" disabled={disabled || loading || writing || !text.trim()} onClick={() => void runPreview()}>
            {loading ? m('settings.mcp.import.previewing') : m('settings.mcp.import.preview')}
          </button>
          <button type="button" disabled={writing || (!text && !preview && !error)} onClick={() => {
            clearResult();
            setText('');
          }}>{m('settings.mcp.import.clear')}</button>
          {replacement && <button type="button" disabled={writing}
            onClick={() => onReplacementOutcome?.({ status: 'cancel' })}>
            {m('settings.mcp.edit.cancel')}
          </button>}
        </div>
        {loading && <p role="status">{m('settings.mcp.import.previewing')}</p>}
        {error && <p role="alert" className="status-warning">{error}</p>}
        {writeMessage && <p role={writeMessage === 'error' ? 'alert' : 'status'}
          className={writeMessage === 'error' ? 'status-warning' : 'status-success'}>
          {m(writeMessage === 'error' ? 'settings.mcp.import.writeFailed' : 'settings.mcp.import.saved')}
        </p>}
        {preview && <section className="mcp-import-results" aria-live="polite" aria-labelledby="mcp-import-results-title">
          <h4 id="mcp-import-results-title">{m(replacement
            ? 'settings.mcp.edit.results'
            : 'settings.mcp.import.results')}</h4>
          <NoteList notes={preview.notes} />
          {preview.entries.length === 0
            ? <p className="settings-help">{m('settings.mcp.import.noEntries')}</p>
            : <div className="settings-resource-list">{preview.entries.map((entry, index) => (
              <PreviewEntry disabled={disabled || writing || !inventory} entry={entry} entryIndex={index}
                key={`${entry.name}:${index}`} onConfigure={openDraft}
                {...(replacement ? { replacementScope: replacement.scope } : {})} />
            ))}</div>}
          <p className="settings-help">{m(replacement
            ? 'settings.mcp.edit.writeHelp'
            : 'settings.mcp.import.writeHelp')}</p>
        </section>}
      </div>
    </details>
    {draft && <div className="modal-backdrop mcp-import-backdrop" role="presentation">
      <section ref={dialogRef} className="mcp-import-dialog" role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby="mcp-import-dialog-title" aria-describedby="mcp-import-dialog-description">
        <h4 id="mcp-import-dialog-title">{m(replacement
          ? 'settings.mcp.edit.configureTitle'
          : 'settings.mcp.import.configureTitle')}</h4>
        <p id="mcp-import-dialog-description" className="settings-help">
          {replacement
            ? m('settings.mcp.edit.configureDescription', {
              name: replacement.name,
              scope: m(`settings.mcp.import.scope.${draft.scope}`),
            })
            : m('settings.mcp.import.configureDescription', {
              scope: m(`settings.mcp.import.scope.${draft.scope}`),
            })}
        </p>
        <form onSubmit={event => {
          event.preventDefault();
          void submitImport();
        }}>
          <label htmlFor="mcp-import-name">{m('settings.mcp.import.nameLabel')}</label>
          <input id="mcp-import-name" data-autofocus maxLength={64} value={draft.name} disabled={writing}
            onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : current)} />
          {draft.entry.fields.map((field, index) => {
            const referenceMode = Boolean(draft.referenceModes[field.field]);
            const inputId = `mcp-import-field-${draft.entryIndex}-${index}`;
            return <fieldset className="mcp-import-field" key={field.id}>
              <legend><code>{field.field}</code></legend>
              {field.canReference && isReferenceableField(field.field) && <label className="mcp-import-reference-toggle">
                <input type="checkbox" checked={referenceMode} disabled={writing}
                  onChange={event => setDraft(current => current ? {
                    ...current,
                    referenceModes: { ...current.referenceModes, [field.field]: event.target.checked },
                  } : current)} />
                <span>{m('settings.mcp.import.useReference')}</span>
              </label>}
              <label htmlFor={inputId}>{m(referenceMode
                ? 'settings.mcp.import.referenceLabel'
                : 'settings.mcp.import.valueLabel')}</label>
              <input id={inputId} autoComplete="off" spellCheck={false}
                type={!referenceMode && field.kind === 'secret' ? 'password' : 'text'}
                value={draft.values[field.field] ?? ''} disabled={writing}
                onChange={event => setDraft(current => current ? {
                  ...current,
                  values: { ...current.values, [field.field]: event.target.value },
                } : current)} />
            </fieldset>;
          })}
          {draft.entry.referenceableLiteralSecretFields.length > 0 && <fieldset className="mcp-import-secret-references">
            <legend>{m('settings.mcp.import.replaceSecrets')}</legend>
            <p className="settings-help">{m('settings.mcp.import.replaceSecretsHelp')}</p>
            {draft.entry.referenceableLiteralSecretFields.map((field, index) => {
              const inputId = `mcp-import-secret-reference-${draft.entryIndex}-${index}`;
              return <label htmlFor={inputId} key={field}>
                <code>{field}</code>
                <input id={inputId} type="text" autoComplete="off" spellCheck={false}
                  placeholder={m('settings.mcp.import.optionalReference')}
                  value={draft.secretReferences[field] ?? ''} disabled={writing}
                  onChange={event => setDraft(current => current ? {
                    ...current,
                    secretReferences: { ...current.secretReferences, [field]: event.target.value },
                  } : current)} />
              </label>;
            })}
          </fieldset>}
          {projectLiteralBlocked && <p role="alert" className="status-warning">
            {m('settings.mcp.import.projectSecretsBlocked')}
          </p>}
          {draft.scope === 'global' && needsGlobalLiteralConfirmation && <label className="mcp-import-confirmation">
            <input type="checkbox" checked={draft.literalConfirmed} disabled={writing}
              onChange={event => setDraft(current => current ? { ...current, literalConfirmed: event.target.checked } : current)} />
            <span>{m('settings.mcp.import.confirmLiteral')}</span>
          </label>}
          {confirmedRemoteNames.length > 0 && <label className="mcp-import-confirmation">
            <input type="checkbox" checked={draft.remoteConfirmed} disabled={writing}
              onChange={event => setDraft(current => current ? { ...current, remoteConfirmed: event.target.checked } : current)} />
            <span>{m('settings.mcp.import.confirmRemote', { names: confirmedRemoteNames.join(', ') })}</span>
          </label>}
          <div className="mcp-dialog-actions">
            <button type="button" disabled={writing} onClick={closeDraft}>{m('settings.mcp.import.cancel')}</button>
            <button type="submit" disabled={!readyToWrite || writing}>
              {m(writing
                ? (replacement ? 'settings.mcp.edit.saving' : 'settings.mcp.import.saving')
                : (replacement ? 'settings.mcp.edit.save' : 'settings.mcp.import.save'))}
            </button>
          </div>
        </form>
      </section>
    </div>}
  </>;
}
