import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to model catalogue',
    unavailable: 'The selected model is unavailable in this view.',
  },
  fr: {
    back: 'Retour au catalogue de modèles',
    unavailable: 'Le modèle sélectionné n’est pas disponible dans cette vue.',
  },
} as const;

/** Catalogue metadata is not model-selection or enablement authority. */
export function modelCatalogMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
