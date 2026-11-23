import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import { getConfigurationScope, updateConfigurationScope } from '../services/api';
import { publishNotice } from '../services/notices';
import { cacheNoticeMessages } from './cache-notice-messages';
import { settingsAdminMessage, type SettingsAdminMessage } from './settings-admin-messages';

/** A server-global presentation preference, independent of warming authority. */
export function CacheNoticeSettings() {
  const { locale } = useI18n();
  const text = cacheNoticeMessages(locale);
  const mounted = useRef(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SettingsAdminMessage>();
  useEffect(() => {
    mounted.current = true;
    let current = true;
    void getConfigurationScope('global').then(result => {
      if (!current) return;
      if (result.success && result.data) setEnabled(result.data.values.showCacheMissNotices !== false);
      else setError('readFailed');
    });
    return () => { current = false; mounted.current = false; };
  }, []);
  return <details className="cache-notice-settings">
    <summary>{text.title}</summary>
    <p className="settings-help">{text.help}</p>
    {error && <p role="alert">{settingsAdminMessage(locale, error)}</p>}
    <label><input type="checkbox" checked={enabled ?? true} disabled={enabled === undefined || busy}
      onChange={async event => {
        const next = event.target.checked;
        setBusy(true);
        const result = await updateConfigurationScope('global', { showCacheMissNotices: next });
        const canonical = result.success ? result : await getConfigurationScope('global');
        if (!mounted.current) return;
        if (canonical.success && canonical.data) setEnabled(canonical.data.values.showCacheMissNotices !== false);
        if (!canonical.success || !canonical.data) {
          setEnabled(undefined);
          setError('readbackFailed');
        } else setError(undefined);
        if (!result.success) publishNotice(settingsAdminMessage(locale, 'saveFailed'), { level: 'error' });
        setBusy(false);
      }} />{text.label}</label>
  </details>;
}
