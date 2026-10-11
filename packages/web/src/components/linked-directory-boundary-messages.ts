const en = {
  loading: 'Loading linked-directory controls… No new access has been granted.',
  failed: 'Linked-directory controls could not load. Reload the page to retry the download. No new access was granted.',
  unsent: 'Copy any unsent text before reloading; unsent text may be lost.',
  reload: 'Reload page to retry',
};
const fr: typeof en = {
  loading: 'Chargement des contrôles des répertoires liés… Aucun nouvel accès accordé.',
  failed: 'Les contrôles des répertoires liés n’ont pas pu charger. Rechargez la page pour réessayer le téléchargement. Aucun nouvel accès accordé.',
  unsent: 'Copiez tout texte non envoyé avant de recharger ; il peut être perdu.',
  reload: 'Recharger la page pour réessayer',
};
export function linkedDirectoryBoundaryMessages(locale: string) { return locale.startsWith('fr') ? fr : en; }
