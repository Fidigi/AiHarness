import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    navigation: 'Provider credentials',
    back: 'Back to provider credentials',
    saving: 'Saving submitted API key…',
    unavailable: 'The selected provider credentials are unavailable in this view.',
  },
  fr: {
    navigation: 'Identifiants fournisseurs',
    back: 'Retour aux identifiants fournisseurs',
    saving: 'Enregistrement de la clé API envoyée…',
    unavailable: 'Les identifiants du fournisseur sélectionné ne sont pas disponibles dans cette vue.',
  },
} as const;

/** Credential-row selection is presentation only, never active-provider authority. */
export function providerCredentialsMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
