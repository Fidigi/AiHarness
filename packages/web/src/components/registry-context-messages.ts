import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to Agent Skills registry',
    unavailable: 'The selected registry entry is unavailable in this view.',
  },
  fr: {
    back: 'Retour au registre Agent Skills',
    unavailable: 'L’entrée sélectionnée du registre n’est pas disponible dans cette vue.',
  },
} as const;

/** Registry metadata never installs, updates or grants skill invocation. */
export function registryContextMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
