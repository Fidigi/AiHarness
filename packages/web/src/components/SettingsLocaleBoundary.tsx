import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { loadSettingsLocales } from './settings-locale-loader';
import { settingsLocaleBoundaryMessage } from './settings-locale-boundary-messages';
import './settings-locale-boundary.css';

/** A route-local wait, never a suspension of the application/navigation/Stop. */
export function SettingsLocaleBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <SettingsLocaleLoad key={location.key}>{children}</SettingsLocaleLoad>;
}

function SettingsLocaleLoad({ children }: { children: ReactNode }) {
  const { locale, t } = useI18n();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let current = true;
    void loadSettingsLocales().then(
      () => { if (current) setState('ready'); },
      () => { if (current) setState('failed'); },
    );
    return () => { current = false; };
  }, []);
  if (state === 'ready') return children;
  // No focus calls, trap, redirects, scroll, or body mutations. Navigation
  // discards ownership; late imports may cache copy but never mount stale UI.
  return <section className="settings-locale-boundary" aria-label={t('common.settings')}>
    <h2>{t('common.settings')}</h2>
    <p role={state === 'failed' ? 'alert' : 'status'}>{settingsLocaleBoundaryMessage(locale, state)}</p>
    {state === 'failed' && <button type="button" onClick={() => window.location.reload()}>
      {settingsLocaleBoundaryMessage(locale, 'retry')}
    </button>}
    <Link to="/" aria-label={t('common.close')}>{t('common.close')}</Link>
  </section>;
}
