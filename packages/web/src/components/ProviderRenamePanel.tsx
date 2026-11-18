import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import { isRenameableProvider, renameCustomProvider, type ProviderRenameResult, type RenameableProvider } from '../services/provider-lifecycle';
import { providerSettingsMessage, type ProviderSettingsMessage } from './provider-settings-messages';
import type { ProviderRenameCapability } from '../services/api';
import './provider-lifecycle.css';

export interface ProviderRenamePanelProps {
  provider: RenameableProvider;
  disabled?: boolean;
  capability?: ProviderRenameCapability;
  disabledReason?: ProviderSettingsMessage;
  /** Reload providers, auth status, catalogue, scoped defaults and effective config. */
  reconcile: (result?: ProviderRenameResult) => Promise<void>;
  onRenamed?: (provider: RenameableProvider) => void;
  /** Keep outcome notices in the host if canonical reload unmounts this row. */
  onOutcome?: (result: ProviderRenameResult) => void;
}

export function ProviderRenamePanel(props: ProviderRenamePanelProps) {
  const supported = isRenameableProvider(props.provider) && props.capability?.supported === true
    && props.capability.mode === 'exclusive-host-single-writer'
    && props.capability.reason === 'restricted-single-writer';
  return <ProviderRenameOperation key={`${props.provider.id}:${props.provider.revision}`} {...props}
    disabled={props.disabled || !supported}
    disabledReason={props.disabledReason ?? (!supported ? 'capabilityUnknown' : undefined)} />;
}
function ProviderRenameOperation({ provider, disabled = false, disabledReason, reconcile, onRenamed, onOutcome }: ProviderRenamePanelProps) {
  const { locale } = useI18n();
  const inputId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [open, setOpen] = useState(false);
  const [newId, setNewId] = useState(provider.id);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [feedback, setFeedback] = useState<ProviderSettingsMessage>();
  const message = (key: ProviderSettingsMessage) => providerSettingsMessage(locale, key);
  const submit = async () => {
    if (busy || disabled) return;
    setBusy(true); setFeedback(undefined);
    const result = await renameCustomProvider(provider, newId.trim(), reconcile);
    if (!mounted.current) return;
    setBusy(false); setOpen(false); setNeedsReload(result.uncertain);
    onOutcome?.(result);
    if (result.success && result.data) {
      onRenamed?.(result.data);
    } else setFeedback(result.uncertain ? 'uncertain' : ({ PROVIDER_IN_USE: 'inUse', PROVIDER_EXISTS: 'collision',
      PROVIDER_REGISTRY_STALE: 'stale', PROVIDER_REBIND_UNAVAILABLE: 'unavailable',
      PROVIDER_ENVIRONMENT_LOCKED: 'environment', PROVIDER_ADMISSION_UNAVAILABLE: 'disabled',
      PROVIDER_ADMINISTRATION_BUSY: 'busy', PROVIDER_UNSUPPORTED_REFERENCES: 'unsupported',
      PROVIDER_REFERENCE_STORE_UNAVAILABLE: 'unsupported' } as Record<string, ProviderSettingsMessage>)[result.code ?? ''] ?? 'failed');
  };
  return <div className="provider-rename-panel">
    {disabledReason && <p className="settings-help">{message(disabledReason)}</p>}
    {!open ? <button type="button" disabled={disabled || busy || needsReload} onClick={() => setOpen(true)}>{message('rename')}</button>
      : <div>
        <p>{message('target')}: <strong>{provider.name}</strong> <code>{provider.id}</code></p>
        <p>{message('warning')}</p>
        <label htmlFor={inputId}>{message('newId')}</label>
        <input id={inputId} value={newId} maxLength={64} autoComplete="off" spellCheck={false}
          disabled={disabled || busy} onChange={event => setNewId(event.currentTarget.value)} />
        <div className="provider-lifecycle-actions">
          <button type="button" disabled={disabled || busy || !isRenameableProvider({ ...provider, id: newId.trim() }) || newId.trim() === provider.id}
            onClick={() => void submit()}>{message('confirm')}</button>
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>{message('dismiss')}</button>
        </div>
      </div>}
    {feedback && <p role="status">{message(feedback)}</p>}
    {needsReload && <button type="button" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await reconcile(); setNeedsReload(false); setFeedback(undefined); }
      catch { setFeedback('uncertain'); }
      finally { setBusy(false); }
    }}>{message('refresh')}</button>}
  </div>;
}
