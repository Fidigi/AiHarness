/** Sidebar-only presentation copy. No eager dictionaries or backend authority. */
export function sessionLinkMessages(locale: string) {
  return locale.startsWith('fr') ? {
    sessionTab: 'Ouvrir la conversation dans un nouvel onglet',
    projectTab: 'Ouvrir le projet dans un nouvel onglet',
  } : {
    sessionTab: 'Open conversation in a new tab',
    projectTab: 'Open project in a new tab',
  };
}
