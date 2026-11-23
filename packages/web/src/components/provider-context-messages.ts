import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    navigation: 'Provider connections',
    builtin: 'Built-in providers',
    custom: 'Custom providers',
    back: 'Back to provider connections',
    unavailable: 'The selected provider is unavailable in this view.',
  },
  fr: {
    navigation: 'Connexions fournisseurs',
    builtin: 'Fournisseurs intégrés',
    custom: 'Fournisseurs personnalisés',
    back: 'Retour aux connexions fournisseurs',
    unavailable: 'Le fournisseur sélectionné n’est pas disponible dans cette vue.',
  },
} as const;

/** Metadata choices do not grant connection or provider-mutation authority. */
export function providerContextMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
