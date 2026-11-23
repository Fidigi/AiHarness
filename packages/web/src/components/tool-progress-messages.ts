const en = {
  label: 'Tool progress', duration: 'Host duration', phase: 'Tool phase · update',
  loading: 'Loading tool progress…', failedLoad: 'Progress display could not load. Tool execution is unaffected.',
  waiting: 'Waiting for tool progress…', empty: 'No progress text reported.',
  details: 'Tool-reported details (self-reported)', disclaimer: 'Display only · not verified usage, cost or permissions.',
  truncated: 'Progress display truncated.', omitted: 'updates omitted/coalesced.', omittedOne: 'update omitted/coalesced.',
  status: { running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' },
};
const fr: typeof en = {
  label: 'Progression de l’outil', duration: 'Durée mesurée par l’hôte', phase: 'Phase de l’outil · mise à jour',
  loading: 'Chargement de la progression…', failedLoad: 'Impossible de charger l’affichage de la progression. L’exécution de l’outil n’est pas affectée.',
  waiting: 'En attente de la progression de l’outil…', empty: 'Aucun texte de progression signalé.',
  details: 'Détails déclarés par l’outil (autodéclarés)', disclaimer: 'Affichage uniquement · utilisation, coût et permissions non vérifiés.',
  truncated: 'Affichage de la progression tronqué.', omitted: 'mises à jour omises/regroupées.', omittedOne: 'mise à jour omise/regroupée.',
  status: { running: 'en cours', completed: 'terminé', failed: 'échec', cancelled: 'annulé' },
};

/** Feature-local copy; unregistered locales retain the product's English fallback. */
export function toolProgressMessages(locale: string): typeof en {
  return locale === 'fr' ? fr : en;
}
