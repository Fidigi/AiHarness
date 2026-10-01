# Extensions AiHarness — Pont UI Web et interactions déclaratives

## Sommaire

- [Vue d'ensemble](#vue-densemble)
- [Chargement et reload atomique](#chargement-et-reload-atomique)
- [Widgets, notices et requêtes interactives](#widgets-notices-et-requêtes-interactives)
  - [Types d'interactions](#types-dinteractions)
  - [Cycle de vie](#cycle-de-vie)
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
