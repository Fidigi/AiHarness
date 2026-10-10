# Extensions AiHarness — Pont UI Web et interactions déclaratives

## Sommaire

- [Vue d'ensemble](#vue-densemble)
- [Chargement et reload atomique](#chargement-et-reload-atomique)
- [Widgets, notices et requêtes interactives](#widgets-notices-et-requêtes-interactives)
  - [Types d'interactions](#types-dinteractions)
  - [Cycle de vie](#cycle-de-vie)
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
4. ChatView rend le dialogue avec focus trap et gestion Escape
5. L'utilisateur répond ou annule (`POST /api/agent/sessions/:sessionId/interactions/:requestId`)
6. Le serveur revalide la réponse structurée avant de résoudre l'extension
7. Si l'onglet n'est pas visible, une notification Web Push catégorie "attention" est envoyée
```

**Règles importantes :**
- Une interaction nécessite **toujours un run actif**. Sans run, elle est ignorée.
- Les formulaires `custom` restent déclaratifs : jamais de HTML arbitraire ni d'accès DOM direct.
- La réponse structurée est revalidée par `AgentRuntime` avant résolution.
- Le focus reste piégé dans le dialogue tant qu'il est ouvert, puis revient au contrôle précédent.

### Contrat de la file du runtime détaché

Le runtime détaché Core/Server prend désormais en charge plusieurs demandes en attente. Le client Web actuel conserve encore un état d’interaction unique, notamment le snapshot de compatibilité du premier élément ; la file complète côté navigateur, le compteur, les notifications et le focus ne sont pas encore livrés.

- `requestInteraction(request)` renvoie une Promise que l’on peut attendre. Le runtime détaché fournit aussi un `id` en lecture seule et les contrôles `update(replacement)` et `close()` ; les autres adaptateurs peuvent les omettre. Conservez le handle retourné : connaître un ID ne confère aucun droit de modification ou de fermeture.
- `update` remplace entièrement l’affichage et le schéma sans changer l’ID, l’ordre d’admission, la date de création, l’AbortSignal ou l’échéance initiale. Les champs d’affichage omis disparaissent. La réponse suivante est validée contre le dernier schéma.
- Réponse, fermeture, abandon et expiration résolvent la Promise une seule fois. Les contrôles périmés ou déjà résolus renvoient `false`. Sans run actif, le résultat est `{cancelled: true}`.
- Par run : 16 demandes en attente, 128 000 octets JSON UTF-8 par demande normalisée et 512 000 octets cumulés. Une admission ou modification dépassant ces bornes lève `409 EXTENSION_INTERACTION_QUEUE_FULL` sans remplacer l’état précédent. La normalisation conserve les limites existantes des champs/chaînes et le masquage des secrets.
- Le délai facultatif doit être fini, positif ou nul, et ne pas dépasser 2 147 483 647 ms ; sinon `400 INVALID_EXTENSION_INTERACTION_TIMEOUT`. Signaux et délais ne sont jamais sérialisés dans les snapshots de reconnexion.
- `extensionRequests` contient la file complète dans l’ordre d’admission ; `extensionRequest` reste le premier élément. Les événements ne transportent que la demande modifiée ou l’ID fermé. Réponse/annulation HTTP reste liée aux IDs session/demande ; une réponse périmée, étrangère ou répétée retourne 404.
- Stop, fin du run, engagement réussi d’une génération exécutable/d’outils et nettoyage de sécurité après échec d’un changement de workspace annulent les demandes et révoquent les anciens callbacks. Lectures passives et candidates échouées dans le même workspace conservent la génération. Server capture les callbacks des commandes avant les attentes session/trust.

Ces demandes sont en mémoire, sans durabilité après crash ni parité UI concurrente CLI/RPC. Le registre existant des runs terminés n’est pas nouvellement borné. L’accusé de réception de Stop ne vaut pas règlement durable : la comptabilité des outils interrompus est encore persistée avant le rejeu terminal.

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
