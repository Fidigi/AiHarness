const en = {
  title: 'Linked directories', close: 'Close', loading: 'Loading link metadata…', retry: 'Retry', empty: 'No outside-root directory links in this folder.',
  risk: 'This link leaves the configured workspace roots. Consent permits only this directory and its ordinary descendants through this link. It does not grant project trust, code execution, parent/sibling access or arbitrary root access.',
  restriction: 'Scoped file browsing only. General file tools, Git, execution and provider maintenance scanners do not use these grants.',
  raw: 'Exact raw target (escaped literal)', canonical: 'Canonical target (escaped literal)', warning: 'Warning: hidden or directional characters are present. Escapes below expose every such character.',
  confirm: 'I allow file browsing through this exact directory link.', allow: 'Allow directory', revoke: 'Revoke consent', review: 'Review directory consent', cancel: 'Cancel', allowed: 'Allowed', blocked: 'Not allowed',
  directory: 'Directory target; explicit confirmation required.', unavailable: 'The target is unavailable; no access is possible.', 'unsafe-target': 'Unsafe target or linked path; access refused.', 'not-directory': 'Only directory targets can be allowed.', 'store-unavailable': 'Private consent storage is unavailable. No allowance can be saved or used.', 'unsupported-platform': 'Safe linked-directory access is unavailable on this platform.',
  'stale-entry': 'The link, target or consent changed. Review the refreshed metadata and confirm again.', 'consent-required': 'Explicit consent is required for this exact link.', 'source-trust-required': 'Trust the source workspace separately before browsing files.',
  'too-large': 'This file or consent store exceeds the safe size limit.', busy: 'Consent storage is busy. Retry shortly.', 'invalid-request': 'The selected path is invalid or exceeds safe limits.',
  'provider-host-unsupported-operation': 'Provider maintenance mode does not support linked-directory access.',
  'provider-host-restricted': 'Provider maintenance mode does not support linked-directory access.',
  PROVIDER_REFERENCE_OWNER_UNAVAILABLE: 'Provider maintenance mode does not support linked-directory access.',
  'http-403': 'Your role or the current server policy does not permit this operation.', 'http-401': 'Sign in before accessing linked directories.',
  'request-unavailable': 'The server could not be reached. Retry to reload authoritative consent.',
  timeout: 'The request timed out. Retry to reload authoritative consent.', failure: 'Linked-directory loading failed. No new access was granted.',
  browse: 'Browse allowed directory', back: 'Back to link metadata', root: 'Directory root', parent: 'Parent within this directory', file: 'File content', nested: 'Linked or nonregular entry: access refused.', truncated: 'The safe entry limit was reached; this listing is incomplete.',
};
const fr: typeof en = {
  title: 'Répertoires liés', close: 'Fermer', loading: 'Chargement des métadonnées des liens…', retry: 'Réessayer', empty: 'Aucun lien de répertoire hors racines dans ce dossier.',
  risk: 'Ce lien sort des racines configurées. Le consentement autorise uniquement ce répertoire et ses descendants ordinaires via ce lien. Il ne donne ni confiance au projet, ni exécution de code, ni accès aux parents, voisins ou racines arbitraires.',
  restriction: 'Navigation de fichiers limitée. Les outils généraux, Git, l’exécution et les analyseurs de maintenance des fournisseurs n’utilisent pas ces autorisations.',
  raw: 'Cible brute exacte (littéral échappé)', canonical: 'Cible canonique (littéral échappé)', warning: 'Attention : des caractères invisibles ou directionnels sont présents. Les échappements ci-dessous les révèlent tous.',
  confirm: 'J’autorise la navigation de fichiers via ce lien exact de répertoire.', allow: 'Autoriser le répertoire', revoke: 'Révoquer le consentement', review: 'Examiner le consentement', cancel: 'Annuler', allowed: 'Autorisé', blocked: 'Non autorisé',
  directory: 'Cible de répertoire ; confirmation explicite requise.', unavailable: 'La cible est indisponible ; aucun accès possible.', 'unsafe-target': 'Cible ou chemin lié non sûr ; accès refusé.', 'not-directory': 'Seules les cibles de répertoire peuvent être autorisées.', 'store-unavailable': 'Le stockage privé est indisponible. Aucune autorisation ne peut être enregistrée ou utilisée.', 'unsupported-platform': 'L’accès sûr aux répertoires liés est indisponible sur cette plateforme.',
  'stale-entry': 'Le lien, la cible ou le consentement a changé. Examinez les métadonnées actualisées et confirmez à nouveau.', 'consent-required': 'Un consentement explicite est requis pour ce lien exact.', 'source-trust-required': 'Approuvez séparément le workspace source avant de parcourir les fichiers.',
  'too-large': 'Ce fichier ou stockage dépasse la limite de taille sûre.', busy: 'Le stockage est occupé. Réessayez bientôt.', 'invalid-request': 'Le chemin sélectionné est invalide ou dépasse les limites sûres.',
  'provider-host-unsupported-operation': 'Le mode maintenance des fournisseurs ne prend pas en charge les répertoires liés.',
  'provider-host-restricted': 'Le mode maintenance des fournisseurs ne prend pas en charge les répertoires liés.',
  PROVIDER_REFERENCE_OWNER_UNAVAILABLE: 'Le mode maintenance des fournisseurs ne prend pas en charge les répertoires liés.',
  'http-403': 'Votre rôle ou la politique serveur interdit cette opération.', 'http-401': 'Connectez-vous avant d’accéder aux répertoires liés.',
  'request-unavailable': 'Le serveur est injoignable. Réessayez pour recharger le consentement officiel.',
  timeout: 'La requête a expiré. Réessayez pour recharger le consentement officiel.', failure: 'Échec du chargement. Aucun nouvel accès n’a été accordé.',
  browse: 'Parcourir le répertoire autorisé', back: 'Retour aux métadonnées', root: 'Racine du répertoire', parent: 'Parent dans ce répertoire', file: 'Contenu du fichier', nested: 'Entrée liée ou non ordinaire : accès refusé.', truncated: 'La limite sûre d’entrées est atteinte ; cette liste est incomplète.',
};
export function linkedDirectoryMessages(locale: string) { return locale.startsWith('fr') ? fr : en; }
/** Display an exact literal without allowing bidi/format/control characters to spoof it. */
export function linkedDirectoryLiteral(value: string): string {
  return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, character => {
    const code = character.codePointAt(0)!;
    return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
  });
}
export function linkedDirectoryFailure(locale: string, code: string): string {
  const messages = linkedDirectoryMessages(locale);
  return Object.hasOwn(messages, code) ? messages[code as keyof typeof messages] : messages.failure;
}
