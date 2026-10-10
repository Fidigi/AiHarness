import type { Locale } from '../i18n/types';

const messages = {
  en: {
    loading: 'Loading Settings translations…',
    retry: 'Reload and retry',
    failed: 'Settings translations could not load. Reload the page to try again.',
  },
  fr: {
    loading: 'Chargement des traductions des réglages…',
    retry: 'Recharger et réessayer',
    failed: 'Les traductions des réglages n’ont pas pu être chargées. Rechargez la page pour réessayer.',
  },
};

export function settingsLocaleBoundaryMessage(locale: Locale, state: 'loading' | 'failed' | 'retry'): string {
  return (messages[locale] ?? messages.en)[state];
}
