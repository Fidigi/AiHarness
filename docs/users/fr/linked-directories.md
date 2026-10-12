# Parcourir les répertoires liés

Utilisez **Répertoires liés** dans la barre latérale du workspace ou le panneau de fichiers pour examiner un lien hors des racines configurées. Le champ dossier source est relatif au workspace source. Les noms de fichiers et mentions conservent la politique ordinaire pour les liens internes. Le bouton d’examen distinct ouvre les métadonnées source ; cliquer sur un nom de fichier n’accorde jamais implicitement de consentement externe. Une lecture de lien refusée peut ouvrir les métadonnées seulement si son bouton garde le focus ; une intention plus récente dans le composeur est prioritaire. Une nouvelle lecture explicite de lien retire l’ancienne vue en chargement avant d’attendre son résultat.

## Examen et consentement

1. Examinez les cibles brute et canonique exactes, affichées comme littéraux échappés. Les avertissements révèlent les caractères invisibles/directionnels trompeurs.
2. Choisissez **Examiner le consentement**, cochez **J’autorise la navigation de fichiers via ce lien exact de répertoire.**, puis **Autoriser le répertoire**.
3. Approuvez **séparément le workspace source** avant **Parcourir le répertoire autorisé**. Le consentement seul n’autorise pas le contenu.
4. Ouvrez des dossiers ordinaires ou fichiers UTF-8 dans cette cible exacte. Utilisez **Retour aux métadonnées** puis **Révoquer le consentement** pour retirer l’autorisation.

Inventaire et consentement lisent seulement les métadonnées cible : aucun handle du répertoire cible, nom de descendant ou contenu. La navigation/lecture exige révision courante, autorisation, confiance source et identités source/lien/cible, vérifiées avant le handle racine cible et chaque descendant, puis avant de retourner le résultat.

[IMPORTANT] Cette navigation limitée en lecture seule n’accorde **ni confiance projet ni exécution**. Elle n’étend pas les racines et n’autorise ni outils généraux de fichiers, Git, PTY, dossiers d’agents, MCP, instructions ou maintenance des fournisseurs. Approuver la source n’approuve pas la cible. Un processus privilégié conserve ses droits système existants.

## Limites et récupération

| Condition | Résultat |
|---|---|
| Lien modifié, cible remplacée ou révocation externe | Ancien sélecteur refusé ; la prochaine opération explicite retire le contenu périmé et recharge les métadonnées. Examinez et confirmez à nouveau si nécessaire. |
| Lien imbriqué, fichier à liens physiques/spécial ou UTF-8 invalide | Refus ; même les liens symboliques imbriqués internes ne sont pas suivis. |
| Cible large/protégée, composants liés ou plateforme non prise en charge | Aucune autorisation utilisable. La navigation externe sûre est actuellement réservée à Linux. |
| Stockage privé non sûr/indisponible | Refus fermé ; ne relâchez jamais propriétaire, permissions ou gardes de fichiers. |
| Échec réseau/API | Erreur locale et fermeture disponibles. Réessayer recharge les métadonnées faisant autorité ; un échec n’est pas une autorisation. |
| Échec du téléchargement JS/CSS optionnel | Fermez ou rechargez explicitement ; rouvrir ne réinitialise pas l’import rejeté. |

Copiez votre texte non envoyé avant de recharger : il peut être perdu. Recharger n’envoie pas Stop à un agent détaché. Pendant le chargement, éditeur/Stop restent utilisables sans piège de focus modal. Fermer, naviguer, changer de dossier/workspace source ou une activation plus récente retire les demandes anciennes. Seule la modale prête piège le focus ; Échap hors composition la ferme. Pendant une composition, y compris avec l’ancien keyCode 229, Échap conserve la saisie source et l’interaction IME. Pendant le chargement, Échap est inactif en composition et préserve le focus plus récent de l’éditeur hors composition. Si le focus change avant disponibilité, l’ancienne ouverture est retirée sans demande de métadonnées ; réactivez Répertoires liés. La fin du consentement et la récupération d’erreur ne remplacent jamais un focus plus récent.

Listes : 500 entrées maximum, avec signalement de troncature. Chemins : 4 096 octets/64 composants. Fichiers ordinaires : 2 Mio. Consentement privé : 128 Kio/256 associations hachées dans `<AI_HARNESS_DATA_DIR>/linked-directories.json`. Le dossier de données doit être indépendant de la source et privé pour l’utilisateur système du serveur. Les autorisations persistent au rechargement ; sélecteurs/révisions opaques doivent être renouvelés, sans autorité portable.

La révocation se sérialise avec les lectures coopérantes en cours ; son accusé bloque les accès suivants sans effacer le contenu déjà livré. Il ne s’agit ni de sandbox système, gel global, isolation contre un attaquant du même UID ni d’immunité aux inodes réutilisés/montages bind. L’expurgation couvre les secrets enregistrés, pas tout secret inconnu d’un contenu arbitraire.

## Documentation associée

- [Chargement du panneau de fichiers](./workspace-loading.md)
- [Guide utilisateur](./user-guide.md)
- [Version anglaise](../en/linked-directories.md)
