const en = {
  unavailable: 'The default workspace is unavailable. Choose an allowed directory.',
};
const fr: typeof en = {
  unavailable: 'L’espace de travail par défaut est indisponible. Choisissez un dossier autorisé.',
};
/** Feature-owned copy keeps the conserved shared/Settings dictionaries unchanged. */
export function workspaceFeedback(locale: string) { return locale.startsWith('fr') ? fr : en; }
