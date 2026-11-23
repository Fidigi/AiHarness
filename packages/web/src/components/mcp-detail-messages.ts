import type { Locale } from '../i18n/types.js';

const messages = {
  en: {
    back: 'Back to MCP servers',
    show: 'Show details for',
    region: 'Server details:',
    unavailable: 'The selected server is no longer available. Select another server.',
  },
  fr: {
    back: 'Retour aux serveurs MCP',
    show: 'Afficher les détails de',
    region: 'Détails du serveur :',
    unavailable: 'Le serveur sélectionné n’est plus disponible. Sélectionnez un autre serveur.',
  },
} as const;

/** Feature-only copy stays in the lazy Settings graph. Names remain literal React text. */
export function mcpDetailMessage(locale: Locale, key: keyof typeof messages.en): string {
  return (messages[locale] ?? messages.en)[key];
}
