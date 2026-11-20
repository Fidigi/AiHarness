import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to custom models',
    unavailable: 'The selected custom model is unavailable.',
  },
  fr: {
    back: 'Retour aux modèles personnalisés',
    unavailable: 'Le modèle personnalisé sélectionné n’est pas disponible.',
  },
} as const;

/** Custom-model metadata never changes the editor target or active model. */
export function customModelMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
