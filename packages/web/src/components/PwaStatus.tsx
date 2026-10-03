import { useEffect, useState } from 'react';
import { useI18n } from '../hooks/useI18n';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Registers the production service worker and exposes install/update/offline state without caching API data. */
export default function PwaStatus() {
  const { t } = useI18n();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [update, setUpdate] = useState<ServiceWorkerRegistration>();

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);

    let updateTimer: number | undefined;
    let reloading = false;
    const handleControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      void navigator.serviceWorker.register('/sw.js').then(registration => {
        if (registration.waiting && navigator.serviceWorker.controller) setUpdate(registration);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdate(registration);
          });
        });
        updateTimer = window.setInterval(() => void registration.update(), 6 * 60 * 60 * 1_000);
      }).catch(() => undefined);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      }
      if (updateTimer !== undefined) window.clearInterval(updateTimer);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(undefined);
  };

  const applyUpdate = () => update?.waiting?.postMessage({ type: 'SKIP_WAITING' });

  if (online && !installPrompt && !update) return null;
  return (
    <aside className="pwa-status" aria-live="polite">
      {!online && <span>● {t('pwa.offline')}</span>}
      {installPrompt && <button onClick={() => void install()}>{t('pwa.install')}</button>}
      {update && <>
        <span>{t('pwa.updateAvailable')}</span>
        <button onClick={applyUpdate}>{t('pwa.update')}</button>
        <button aria-label={t('common.close')} onClick={() => setUpdate(undefined)}>×</button>
      </>}
    </aside>
  );
}
