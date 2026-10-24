const messages = {
  en: {
    readFailed: 'Settings could not be read safely. Refresh before saving.',
    saveFailed: 'The save could not be confirmed. Saved settings were reloaded; review before retrying.',
    readbackFailed: 'The save result is uncertain because saved settings could not be reloaded. Refresh before saving again.',
    refresh: 'Reload saved settings',
    filteredHelp: 'Only changed displayed packages are saved. Hidden packages and other scopes are preserved.',
  },
  fr: {
    readFailed: 'La lecture sûre des paramètres a échoué. Actualisez avant d’enregistrer.',
    saveFailed: 'L’enregistrement n’a pas pu être confirmé. Les paramètres sauvegardés ont été rechargés ; vérifiez avant de réessayer.',
    readbackFailed: 'Le résultat de l’enregistrement est incertain car la relecture des paramètres a échoué. Actualisez avant d’enregistrer à nouveau.',
    refresh: 'Recharger les paramètres sauvegardés',
    filteredHelp: 'Seuls les packages affichés modifiés sont enregistrés. Les packages masqués et les autres portées sont conservés.',
  },
} as const;

export type SettingsAdminMessage = keyof typeof messages.en;
export function settingsAdminMessage(locale: string, key: SettingsAdminMessage): string {
  return messages[locale === 'fr' ? 'fr' : 'en'][key];
}
