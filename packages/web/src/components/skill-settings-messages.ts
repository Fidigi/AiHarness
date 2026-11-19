import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to skills',
    unavailable: 'The selected skill is unavailable in this view.',
    enabled: 'Autonomous invocation enabled',
    disabled: 'Autonomous invocation disabled',
  },
  fr: {
    back: 'Retour aux compétences',
    unavailable: 'La compétence sélectionnée n’est pas disponible dans cette vue.',
    enabled: 'Invocation autonome activée',
    disabled: 'Invocation autonome désactivée',
  },
} as const;

/** Metadata navigation never grants instruction-read or invocation authority. */
export function skillSettingsMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
