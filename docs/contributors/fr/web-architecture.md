# Architecture AiHarness — Application Web

## Sommaire

- [Composants React](#composants-react)
- [Stores et persistance](#stores-et-persistance)
  - [`session-store.ts`](#session-storets)
  - [`preferences.ts`](#preferencests)
- [Rendu riche et assainissement](#rendu-riche-et-assainissement)
- [Accessibilité et navigation clavier](#accessibilité-et-navigation-clavier)
- [Flux de conversation courant](#flux-de-conversation-courant)
- [PWA et service worker](#pwa-et-service-worker)
- [Validation et budgets](#validation-et-budgets)

## Composants React

L'application React s'organise autour des composants principaux suivants :

| Composant | Responsabilité |
|---|---|
| `Sidebar` | workspace, confiance, worktrees, recherche et cycle de vie des sessions |
| `ChatView` | historique riche, exécution/reconnexion agent, composer, images, commandes, branches et informations |
| `WorkspacePanel` | fichiers, changements Git, upload XHR annulable et viewer source/aperçu/diff surveillé |
| `TerminalPanel` | onglets xterm reliés aux PTY serveur, chargés dynamiquement à la première ouverture |
| `CommandPalette` | recherche et exécution clavier de commandes, sessions, réglages et fichiers |
| `StatusCenter` | file globale bornée de succès, avertissements, erreurs et progressions, conservée pendant les navigations avec expiration suspendue au survol/focus |
| `PluginSettings` | packages globaux/projet, installation explicite, inventaire, activation, mises à jour, diagnostics et reload lié à la session |
| `EcosystemSettings` | cycle de vie/OAuth des providers, providers et modèles personnalisés, defaults, outils et registre de skills |
| `SubagentSettings`, `SubagentPanel`, `SubagentMonitor` | profils globaux/projet, permissions, progression, attention, notifications globales, arrêt et navigation parent/enfant |

Pour la vue d'ensemble du projet, consultez [architecture-overview.md](./architecture-overview.md).

## Stores et persistance

### `session-store.ts`

Hydrate les dates du contrat API et conserve en mémoire les brouillons, pièces jointes, runs, réglages par session et catalogues de modèles/skills du workspace. Les requêtes de catalogue sont séquencées lors d'une bascule de projet ; l'activation est optimiste, puis confirmée par la réponse serveur ou restaurée en cas d'échec.

`SettingsView` groupe et filtre les modèles, expose disponibilité/capacités/provenance et déclenche l'actualisation ; `ChatView` ne propose que les entrées activées et disponibles du provider courant. `PluginSettings`, remonté avec une clé de workspace, possède le même rollback optimiste pour l'activation et recharge un catalogue isolé à chaque changement de cwd.

Un nouveau chat utilise un ID `draft:*` local ; sa session distante n'est créée qu'au premier envoi réussi. Les snapshots de run portant une séquence antérieure sont ignorés pour qu'une reconnexion concurrente n'efface pas une file plus récente.

Le cache de vue v2 par workspace accélère le premier rendu depuis `sessionStorage` avant réconciliation et migre explicitement les snapshots v1 : il est révisionné, limité à 2 Mio, trois sessions distantes, trois brouillons, 160 messages par session et 24 heures. Il privilégie texte/réglages sur les pièces jointes volumineuses, mémorise le provider et les modèles actifs sans credential, tronque les sorties lourdes et retire systématiquement `providerConfig.apiKey`. Une écriture `pagehide` protège le dernier changement avant rechargement.

La liste initiale reçoit seulement les métadonnées et le nombre total de messages. La conversation active charge une queue bornée, puis fusionne les pages précédentes ou une fenêtre entourant une entrée recherchée d'après leurs index globaux. Les plages non contiguës restent signalées et rechargeables. Au-delà de 120 messages, `@tanstack/react-virtual` ne monte que les lignes visibles ; l'ancre identifiée est rematérialisée puis restaurée après insertion d'une page. La route racine reprend l'ID actif du cache réconcilié, les navigations précédent/suivant suivent la liste du workspace et un état 404 retire l'entrée locale devenue inaccessible. Un export complet reste un téléchargement serveur et n'est jamais assemblé dans le store.

### `preferences.ts`

Persiste un document navigateur v3 validé et synchronisé entre onglets, avec migration v1/v2 : thème, largeur, police, raisonnement ouvert, volume, catégories indépendantes de son/notification locale/Web Push, actions de sélection, panneaux, dernière section et accords clavier `Mod+…`. Aucun credential ni souscription Push n'y est écrit.

`ChatView` réutilise l'index borné du workspace pour la palette `@`, bascule vers une requête serveur lorsqu'il est tronqué et propose une mini-carte des tours/outils compatible avec les pages et leurs lacunes. Il conserve séparément dans `sessionStorage` au plus 24 positions par workspace pendant 24 heures : offset brut, distance au bas et ID/offset de l'entrée visible. Les écritures sont différées, les erreurs de stockage ignorées, et une ancre paginée absente est rechargée avec `messages?around=` avant correction répétée des mesures virtuelles.

## Rendu riche et assainissement

Le rendu riche n'injecte pas le HTML du modèle : GFM et liens `file:` sont analysés par `react-markdown`/`rehype-sanitize`, les sorties KaTeX passent par DOMPurify avec `trust: false`, et `beautiful-mermaid` n'est importé que pour un bloc diagramme. Les directives Mermaid actives sont filtrées puis le SVG est débarrassé des imports/URL et assaini sans script, `foreignObject`, iframe, objet ni embed avant insertion. Le viewer réutilise ce rendu pour Markdown/frontmatter, sert les médias par la route de téléchargement et écoute un flux SSE de fichier afin d'invalider simultanément source, diff et statut Git.

Les requêtes de recherche, contenu, diff et hydratation sont annulées ou séquencées lorsque leur résultat devient obsolète.

Le diagnostic `/api/sessions/:id/info` agrège messages, outils, usage/coût et contexte sans exposer de secret. Le panneau Web offre les copies utiles et délègue l'export complet au serveur, sans assembler tout le journal dans le navigateur. Chaque message conserve son horodatage, provider/modèle, durée et usage/coût de tour. `ChatView` regroupe outils et raisonnement en Process/Response, rend ANSI, garde l'aperçu et le contexte bornés, puis n'utilise `tool_result.fullContent` qu'après expansion explicite pour copie/téléchargement.

Les widgets d'extension sont rendus exclusivement comme texte. Les interactions `confirm`, `input`, `select`, `editor` et `custom` produisent des contrôles React déclaratifs, piégés au clavier et sans `dangerouslySetInnerHTML` ; leur réponse structurée est revalidée par `AgentRuntime` avant résolution. Palette, widgets et demandes actives sont repris depuis le snapshot/journal après navigation.

## Accessibilité et navigation clavier

Les modales, palettes, tiroirs et zooms partagent un focus trap avec restauration ; `inert`, les annonces ARIA, les styles `focus-visible`, couleurs forcées et `prefers-reduced-motion` complètent la navigation clavier.

## Flux de conversation courant

```text
ChatView
  -> POST /api/agent/runs (ou queue d'un run actif)
  -> remplacement du brouillon local par la session serveur
  -> GET state
  -> GET events?after=sequence
  -> deltas optimistes identifiés par messageId
  -> resynchronisation de la session aux événements terminaux
```

La page `LoginView` n'apparaît que lorsqu'une authentification est configurée et qu'aucune session cookie valide n'existe. Si le serveur est simplement hors ligne, le shell reste navigable et affiche les erreurs de chargement.

## PWA et service worker

Le bundle de production est une PWA : manifeste et icône installables, fallback hors ligne, service worker à mise à jour explicite et récepteur Web Push. Celui-ci cache uniquement le shell et les ressources statiques, exclut `/api/`, compare les clients visibles avant d'afficher une notification et ouvre l'URL relative de session au clic. La vérification de release affichée dans **À propos** reste indépendante : elle démarre après le rendu, montre lien et notes comme texte, et ne déclenche aucune installation.

## Validation et budgets

Les tests Vitest couvrent les contrats Core, runtime agent/extensions, providers, JSONL, workspace/Git, commandes, PTY, configuration, catalogues et registres, OAuth, métriques tarifées, Push, sous-agents, sécurité, routes réelles et stores Web. Playwright couvre l'interface avec une API déterministe interceptée **et** un parcours complet contre Express/provider mock/persistance/PTY/fichiers. `web-server.test.ts` complète par Git/worktrees/diffs/uploads/watch, PTY et contrats HTTP sans navigateur. Les suites dédiées vérifient axe/WCAG, focus et clavier, virtualisation/cache, restauration et chargement différé.

Les 114 baselines Light/Dark desktop/tablette/mobile couvrent notamment modèles/providers personnalisés, registre de skills, processus et dialogue d'extension, en plus des surfaces historiques, avec un seuil maximal de différence de 2 %.

Le build Web exécute `packages/web/scripts/check-bundle-budget.mjs` après Vite. Il échoue au-delà de :

| Budget | Limite |
|---|---|
| Entrée brute / gzip | 500 Kio / 150 Kio |
| Assets JS eager gzip | 180 Kio |
| Chunk asynchrone brut / gzip | 1,6 Mio / 500 Kio |
| Feuille CSS brute | 64 Kio |

Les validations canoniques s'exécutent dans Docker :

```bash
make typecheck
make test
make test-e2e
make build-prod
```
