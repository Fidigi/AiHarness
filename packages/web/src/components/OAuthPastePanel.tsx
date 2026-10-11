import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../hooks/useI18n';
import { providerSettingsMessage } from './provider-settings-messages';
import './provider-lifecycle.css';

export interface OAuthPastePanelProps {
  /** Only an explicitly started operation may enable the panel. */
  active: boolean;
  operationId: string;
  busy?: boolean;
  authorizationUrl?: string;
  onPaste: (redirectUrl: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export function safeOAuthAuthorizationUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 8_192) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

/** Neutral, opt-in paste control. Hosts keep all flow, polling, error and cancel
 * ownership. Submission is the explicit acknowledgement; no paste auto-submit,
 * focus effects, clipboard reads, storage, arbitrary HTML or raw secret fields.
 * Custom labels/fragment layout preserve the existing MCP presentation. */
export function OAuthPasteInput({ busy = false, label, placeholder, submitLabel, onPaste, renderControls }: {
  busy?: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  onPaste: (redirect: string) => void | Promise<void>;
  renderControls?: (controls: { redirect: string; setRedirect(value: string): void; submit(value: string): void }) => ReactNode;
}) {
  const id = useId();
  const [redirect, setRedirect] = useState('');
  const submit = () => {
    if (busy || !redirect.trim()) return;
    const value = redirect.trim();
    setRedirect('');
    void onPaste(value);
  };
  if (renderControls) return renderControls({ redirect, setRedirect: value => setRedirect(value.slice(0, 8_192)), submit: () => submit() });
  return <>
    <label htmlFor={id}>
      <span>{label}</span>
      <input id={id} value={redirect} disabled={busy} maxLength={8_192}
        autoComplete="off" spellCheck={false} placeholder={placeholder}
        onChange={event => setRedirect(event.currentTarget.value.slice(0, 8_192))}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault(); submit();
          }
        }} />
    </label>
    <button type="button" disabled={busy || redirect.trim().length === 0}
      onClick={submit}>{submitLabel}</button>
  </>;
}

/** Passive inline UI: no requests, timers, focus effects, traps or dialog ownership. */
export function OAuthPastePanel(props: OAuthPastePanelProps) {
  if (!props.active || !props.operationId) return null;
  return <ActiveOAuthPastePanel key={props.operationId} {...props} />;
}

function ActiveOAuthPastePanel({ busy = false, authorizationUrl, onPaste, onCancel }: OAuthPastePanelProps) {
  const { locale } = useI18n();
  const [pending, setPending] = useState(false);
  const [pasteGeneration, setPasteGeneration] = useState(0);
  const [failed, setFailed] = useState(false);
  const message = (key: Parameters<typeof providerSettingsMessage>[1]) => providerSettingsMessage(locale, key);
  const link = safeOAuthAuthorizationUrl(authorizationUrl);
  return <div className="provider-oauth-paste">
    {link && <a href={link} target="_blank" rel="noopener noreferrer">{message('open')}</a>}
    <OAuthPasteInput key={pasteGeneration} busy={busy || pending} label={message('paste')} placeholder={message('placeholder')}
      submitLabel={message('submit')} onPaste={async value => {
        setPending(true); setFailed(false);
        try { await onPaste(value); } catch { setFailed(true); } finally { setPending(false); }
      }} />
    <button type="button" onClick={() => {
      setPasteGeneration(value => value + 1);
      void Promise.resolve().then(onCancel).catch(() => setFailed(true));
    }}>{message('cancel')}</button>
    {failed && <p role="status">{message('failed')}</p>}
  </div>;
}
