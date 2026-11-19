import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to profiles',
    unavailable: 'The selected profile is unavailable in this view.',
  },
  fr: {
    back: 'Retour aux profils',
    unavailable: 'Le profil sélectionné n’est pas disponible dans cette vue.',
  },
} as const;

/** Feature-only copy stays in the lazy Settings graph; profile names stay literal. */
export function subagentSettingsMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
