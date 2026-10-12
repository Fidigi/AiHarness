# Extensions AiHarness — Pont UI Web et interactions déclaratives

## Sommaire

- [Vue d'ensemble](#vue-densemble)
- [Chargement et reload atomique](#chargement-et-reload-atomique)
- [Widgets, notices et requêtes interactives](#widgets-notices-et-requêtes-interactives)
  - [Types d'interactions](#types-dinteractions)
  - [Cycle de vie](#cycle-de-vie)
  - [Chargement du formulaire optionnel et focus](#chargement-du-formulaire-optionnel-et-focus)
  - [Contrat de la file du runtime détaché](#contrat-de-la-file-du-runtime-détaché)
- [Sécurité et limites du chargeur](#sécurité-et-limites-du-chargeur)
- [Administration via Settings](#administration-via-settings)

## Vue d'ensemble

Le serveur Web expose une interface pour les extensions déclaratives : widgets texte, notices de statut et requêtes interactives (`confirm`, `input`, `select`, `editor`, `custom`). Contrairement aux extensions CLI qui s'exécutent dans le processus Node, l'interface Web ne reçoit **que des métadonnées nettoyées** — jamais le code source d'une extension.

Pour les extensions exécutables du CLI, consultez [extensions-cli.md](./extensions-cli.md).

## Chargement et reload atomique

Les extensions proviennent de trois sources :

1. répertoire global `~/.ai-harness/extensions/` ;
2. répertoire projet `<projet>/.ai-harness/extensions/` (uniquement dans un workspace approuvé) ;
3. packages/plugins actifs installés via npm, Git ou chemin local.

Le serveur construit une **génération** atomique : il découvre toutes les extensions actives, les importe via le loader borné (`ExtensionModuleLoader`), puis remplace la génération précédente en une seule opération. En cas d'erreur dans le même workspace, l'ancienne génération reste active et aucun handler de la candidate partielle n'est engagé.

Le reload serveur est déclenchable depuis :
- la page **Settings → Plugins and packages** ;
- `POST /api/agent/reload` avec `cwd`/`projectId` dans le corps ;
- `POST /api/plugins/reload` avec `sessionId` dans le corps pour résoudre un workspace spécifique.

La commande CLI `/reload` recharge uniquement les extensions du processus CLI ; elle ne notifie pas le serveur Web.

Un changement de workspace invalide immédiatement les handlers de l'ancien projet et retire ses ressources avant de restaurer celles du nouveau.

## Widgets, notices et requêtes interactives

### Types d'interactions

Une extension peut publier :

| Type | Description |
|---|---|
| **Widget texte** | Affichage statique dans un panneau repliable (ex : statut provider) |
| **Notice** | Message non bloquant dans le centre de statuts global (`StatusCenter`) |
| **Interaction `confirm`** | Dialogue avec boutons Oui/Non piégé au clavier |
| **Interaction `input`** | Champ texte avec validation et retour structuré |
| **Interaction `select`** | Menu déroulant avec options prédéfinies |
| **Interaction `editor`** | Zone de saisie multi-ligne pour des instructions plus longues |
| **Interaction `custom`** | Formulaire déclaratif : champs texte, sélection, case à cocher et boutons |

### Cycle de vie

```text
1. Extension active → AgentRuntime publie un événement `extension.ui`
2. Le serveur stocke la demande dans le snapshot du run actif
3. L'événement est diffusé au navigateur par SSE
4. ChatView affiche un chargement/une erreur locale, puis charge le formulaire déclaratif et son CSS
5. L'utilisateur répond ou annule (`POST /api/agent/sessions/:sessionId/interactions/:requestId`)
6. Le serveur revalide la réponse structurée avant de résoudre l'extension
7. Si l'onglet n'est pas visible, une notification Web Push catégorie "attention" est envoyée
```

**Règles importantes :**
- Une interaction nécessite **toujours un run actif**. Sans run, elle est ignorée.
- Les formulaires `custom` restent déclaratifs : jamais de HTML arbitraire ni d'accès DOM direct.
- La réponse structurée est revalidée par `AgentRuntime` avant résolution.
- Le formulaire monté possède son focus trap et la gestion ordinaire d’Escape ; le retour respecte la vue courante, le focus plus récent et les autres dialogues au lieu de toujours restaurer le contrôle précédent.

Les nouvelles notices de commandes d’extension publiées via l’API de session omettent `runId` lorsque le run courant de la session est `completed`, `failed` ou `stopped` ; tant que ce run est actif, la corrélation est conservée. Un callback `notify` lié au run et capturé dans le contexte d’un outil conserve son `runId` initial, même s’il est appelé après la fin de ce run. Ce contrat de corrélation des événements ne garantit ni leur présentation dans le navigateur ni une nouvelle admission d’interaction.

Les métadonnées du titre de session ne définissent pas la durée de vie de l’abonnement SSE de ChatView : une actualisation du titre canonique ne doit ni retirer le flux ni perdre une notice valide. Les notifications existantes d’attention/de fin/d’échec lisent, lors de leur émission, le dernier titre canonique déjà présent dans le store navigateur pour la session abonnée, avec `AiHarness` comme repli si le titre est absent ou vide. Le remplacement de session/cwd et le démontage de la vue annulent toujours le transport possédé ; cela n’ajoute ni epochs SSE pour l’adresse complète ni livraison complète de la file/des notifications d’attention côté navigateur.

### Chargement du formulaire optionnel et focus

`ExtensionInteractionBoundary.tsx` reste eager ; seule une demande unique en attente importe `ExtensionInteractionDialog.tsx` et sa feuille de style. Le chargement/l’erreur reste non modal et traduit, avec Fermer/Annuler disponibles, tandis que le composeur et Stop restent utilisables. Les imports échoués restent en cache même après réouverture. **Recharger et réessayer** recharge la page : copiez d’abord le texte non envoyé.

Le remplacement de la demande/du schéma ou de la vue abandonne le transport de réponse et empêche une publication navigateur périmée ; il n’annule pas une réponse déjà acceptée par Server. Le tuple de vue comprend l’ID/cwd du workspace, la session, le run et tous les champs d’identité de route. Les contrôles compatibles de même ID/type conservent leur brouillon et leur composition connectée. Les contrôles modifiés/supprimés sont réinitialisés. Enter/Escape pendant l’IME ou avec le code clavier historique 229 restent de l’édition native, sans validation/annulation du formulaire ; un Enter ordinaire après la composition peut envoyer une seule réponse.

Le focus initial est admis avant la fin de l’import puis revérifié à la première frame du renderer. Un focus plus récent (même suivi d’un blur), un autre dialogue ou la même demande réaffichée dans une route de remplacement refusent cette admission. Le retour exige une vue courante, une cible de repli inchangée et disponible, sans focus/dialogue plus récent. Un pointeur coarse évite le focus éditable non sollicité, mais un retour gardé au composeur reste possible après une édition manuelle dans le formulaire ; un focus externe efface cette intention d’édition.

`extension-interaction-dialog.test.ts` protège les champs, le texte inerte, CSS/transport/copie et la projection du brouillon. `e2e/interaction-single-asset-load.spec.ts`, en preview de production, teste les vrais JS/CSS retardés/refusés, le rechargement et les gardes focus/IME/durée de vie. `e2e/interaction-live-boundary.spec.ts` prouve séparément la validation réelle extension/HTTP et réponse/annulation via le provider mock. L’émulation tactile Chromium ne certifie pas Android/iOS/Safari physiques.

### Contrat de la file du runtime détaché

Le runtime détaché Core/Server prend en charge plusieurs demandes en attente. Le client Web présente la tête ordonnée et le compteur, avec notifications tenant compte de la restauration et gardes locales contre les réponses/découvertes périmées. Le formulaire avance sans restitution intermédiaire du focus. Ces gardes ne prouvent pas le règlement de Stop côté backend, les transactions générales de fork retardé ni le comportement sur appareils physiques.

- `requestInteraction(request)` renvoie une Promise que l’on peut attendre. Le runtime détaché fournit aussi un `id` en lecture seule et les contrôles `update(replacement)` et `close()` ; les autres adaptateurs peuvent les omettre. Conservez le handle retourné : connaître un ID ne confère aucun droit de modification ou de fermeture.
- `update` remplace entièrement l’affichage et le schéma sans changer l’ID, l’ordre d’admission, la date de création, l’AbortSignal ou l’échéance initiale. Les champs d’affichage omis disparaissent. La réponse suivante est validée contre le dernier schéma.
- Réponse, fermeture, abandon et expiration résolvent la Promise une seule fois. Les contrôles périmés ou déjà résolus renvoient `false`. Sans run actif, le résultat est `{cancelled: true}`.
- Par run : 16 demandes en attente, 128 000 octets JSON UTF-8 par demande normalisée et 512 000 octets cumulés. Une admission ou modification dépassant ces bornes lève `409 EXTENSION_INTERACTION_QUEUE_FULL` sans remplacer l’état précédent. La normalisation conserve les limites existantes des champs/chaînes et le masquage des secrets.
- Le délai facultatif doit être fini, positif ou nul, et ne pas dépasser 2 147 483 647 ms ; sinon `400 INVALID_EXTENSION_INTERACTION_TIMEOUT`. Signaux et délais ne sont jamais sérialisés dans les snapshots de reconnexion.
- `extensionRequests` contient la file complète dans l’ordre d’admission ; `extensionRequest` reste le premier élément. Les événements ne transportent que la demande modifiée ou l’ID fermé. Réponse/annulation HTTP reste liée aux IDs session/demande ; une réponse périmée, étrangère ou répétée retourne 404.
- Stop, fin du run, engagement réussi d’une génération exécutable/d’outils et nettoyage de sécurité après échec d’un changement de workspace annulent les demandes et révoquent les anciens callbacks. Lectures passives et candidates échouées dans le même workspace conservent la génération. Server capture les callbacks des commandes avant les attentes session/trust.

Ces demandes sont en mémoire, sans durabilité après crash ni parité UI concurrente CLI/RPC. Le registre existant des runs terminés n’est pas nouvellement borné. L’accusé de réception de Stop ne vaut pas règlement durable : la comptabilité des outils interrompus est encore persistée avant le rejeu terminal.

## Progression générique des outils expérimentale — WIP

`ToolProgressBoundary`, `ToolProgressCard` et `tool-progress-state.ts` conservent un adaptateur navigateur en cours de développement pour la progression v1 émise par le runtime. Texte/détails restent inertes et bornés ; la progression personnalisée ne remplace pas la carte spécialisée code-mode et n’acquiert aucune autorité sur l’invocation, l’usage ou le store.

Cette livraison **n’est pas qualifiée côté navigateur**. Compilation/build/lint Docker et les 1 917 tests unitaires plus cinq tests Node passent. Le fichier complet `e2e/tool-progress.spec.ts`, avec une vraie extension, compte 13 échecs/un succès en développement et 14 échecs en preview compilée, avec `node --no-maglev` explicite, un worker et aucun retry. Affichage terminal/rechargement, rattrapage après readiness, assets différés et captures proposées restent à résoudre. Les 24 PNG de progression sont des attentes de test provisoires, pas des références produit validées. Aucun snapshot ni assertion n’a été assoupli ; ce checkpoint WIP ne clôt aucun critère d’audit.

## Sécurité et limites du chargeur

Le chargeur d'extensions applique les garde-fous de découverte suivants, mais n'isole pas le code chargé dans une sandbox :

| Limite | Valeur |
|---|---|
| Taille maximale d'un module | 5 MiB |
| Liens symboliques | Refusés systématiquement |
| Code HTML/DOM injecté | Interdit (widgets = texte uniquement) |
| Accès `dangerouslySetInnerHTML` | Jamais utilisé pour les widgets/interactions |

Les ressources projet restent masquées et inactives tant que le workspace n'est pas explicitement approuvé via `/trust`. Tout module activé reste néanmoins du code Node de confiance exécuté dans le processus serveur.

## Administration via Settings

La page **Settings → Plugins and packages** permet d'administrer :

1. L'inventaire des extensions par package (nom, version, état) ;
2. L'activation/désactivation de chaque package sans désinstaller ;
3. Le reload atomique des ressources lié à une session spécifique ;
4. Les diagnostics en cas d'échec de chargement.

Sous authentification, les mutations exigent la capacité administrateur `packages`. Le catalogue transmis au navigateur ne contient que des métadonnées nettoyées : ni code, ni instructions, ni credentials.
