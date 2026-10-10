export function workspacePanelMessages(locale: string) {
  return locale === 'fr' ? {
    retry: 'Recharger et réessayer',
    reloadWarning: 'Copiez votre texte non envoyé avant de recharger la page : il risque d’être perdu.',
    loading: 'Chargement du panneau de fichiers…',
    failed: 'Le panneau de fichiers n’a pas pu être chargé. Rechargez la page pour réessayer.',
  } : {
    retry: 'Reload and retry',
    reloadWarning: 'Copy unsent text before reloading the page: it may be lost.',
    loading: 'Loading the file pane…',
    failed: 'The file pane could not load. Reload the page to try again.',
  };
}
