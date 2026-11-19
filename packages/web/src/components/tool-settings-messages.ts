import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to tools',
    unavailable: 'The selected tool is unavailable in this view.',
    enabled: 'Enabled',
    disabled: 'Disabled',
  },
  fr: {
    back: 'Retour aux outils',
    unavailable: 'L’outil sélectionné n’est pas disponible dans cette vue.',
    enabled: 'Activé',
    disabled: 'Désactivé',
  },
} as const;

/** Feature-only copy stays Settings-lazy; tool names and sources stay literal. */
export function toolSettingsMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
