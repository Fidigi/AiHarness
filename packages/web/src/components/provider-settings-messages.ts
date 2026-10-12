const messages = {
  en: {
    paste: 'Paste the full OAuth callback address', placeholder: 'http://127.0.0.1:…/oauth/callback?…',
    submit: 'Submit callback', cancel: 'Cancel sign-in', open: 'Open authorization page',
    failed: 'The operation failed. Refresh before retrying.',
    rename: 'Rename provider', newId: 'New provider ID', confirm: 'Confirm rename', dismiss: 'Cancel', refresh: 'Refresh',
    warning: 'Restricted SINGLE-WRITER rename updates only supported saved references. Busy hosts, stale revisions and unsupported reference owners are refused. No shared CLI or multi-server support.',
    disabled: 'Rename is off: an explicitly composed exclusive host is required. Default and shared hosts do not support rename.',
    capabilityUnknown: 'Rename is off: the server did not provide an active exclusive-host capability.',
    target: 'Exact custom provider target',
    renamed: 'Provider renamed. Canonical provider and configuration state reloaded.',
    unsupported: 'Rename refused: unsupported or unreadable reference owners.',
    busy: 'Rename refused: the host is busy.',
    inUse: 'Rename refused: a session or running agent uses this provider.',
    collision: 'That provider ID is already in use.', stale: 'The provider changed. Refresh before retrying.',
    unavailable: 'Atomic provider reference updates are unavailable.', environment: 'The server environment controls this provider.',
    uncertain: 'The result is uncertain. Reload provider and configuration state before another operation.',
  },
  fr: {
    paste: 'Coller l’adresse complète de retour OAuth', placeholder: 'http://127.0.0.1:…/oauth/callback?…',
    submit: 'Envoyer l’adresse de retour', cancel: 'Annuler la connexion', open: 'Ouvrir la page d’autorisation',
    failed: 'L’opération a échoué. Actualisez avant de réessayer.',
    rename: 'Renommer le fournisseur', newId: 'Nouvel identifiant du fournisseur', confirm: 'Confirmer le renommage', dismiss: 'Annuler', refresh: 'Actualiser',
    warning: 'Renommage restreint SINGLE-WRITER : seules les références prises en charge sont actualisées. Hôte occupé, révision périmée et propriétaires non pris en charge sont refusés. Aucun support CLI partagé ou multiserveur.',
    disabled: 'Renommage désactivé : un hôte exclusif explicitement composé est requis. Les hôtes par défaut ou partagés ne le prennent pas en charge.',
    capabilityUnknown: 'Renommage désactivé : le serveur n’a pas fourni de capacité active d’hôte exclusif.',
    target: 'Fournisseur personnalisé ciblé exactement',
    renamed: 'Fournisseur renommé. État canonique des fournisseurs et de la configuration rechargé.',
    unsupported: 'Renommage refusé : propriétaires de références non pris en charge ou illisibles.',
    busy: 'Renommage refusé : l’hôte est occupé.',
    inUse: 'Renommage refusé : une session ou un agent actif utilise ce fournisseur.',
    collision: 'Cet identifiant de fournisseur est déjà utilisé.', stale: 'Le fournisseur a changé. Actualisez avant de réessayer.',
    unavailable: 'La mise à jour atomique des références du fournisseur est indisponible.', environment: 'L’environnement du serveur contrôle ce fournisseur.',
    uncertain: 'Le résultat est incertain. Rechargez les fournisseurs et la configuration avant toute autre opération.',
  },
} as const;
export type ProviderSettingsMessage = keyof typeof messages.en;
export function providerSettingsMessage(locale: string, key: ProviderSettingsMessage): string {
  return messages[locale === 'fr' ? 'fr' : 'en'][key];
}
