import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to plugins',
    unavailable: 'The selected package is unavailable in this view.',
  },
  fr: {
    back: 'Retour aux plugins',
    unavailable: 'Le package sélectionné n’est pas disponible dans cette vue.',
  },
} as const;

/** Feature-only copy stays in the lazy Settings graph; package names stay literal. */
export function pluginSettingsMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
