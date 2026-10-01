# Architecture AiHarness — Serveur

## Sommaire

- [Composition](#composition)
  - [Services principaux](#services-principaux)
  - [Routeurs API](#routeurs-api)
- [Flux agent détaché](#flux-agent-détaché)
- [Commandes shell et terminaux PTY](#commandes-shell-et-terminaux-pty)
- [Configuration](#configuration)
- [Sécurité HTTP](#sécurité-http)

## Composition

`packages/server/src/index.ts` assemble Express et les services créés par `runtime/services.ts`. Pour la vue d'ensemble du projet, consultez [architecture-overview.md](./architecture-overview.md).

### Services principaux

- `SessionManager` et `JsonlSessionStore` ;
- `AgentRuntime` et son journal d'événements ;
- `CommandRuntime` pour les commandes de session et `TerminalRuntime` pour les PTY interactifs ;
- `WorkspaceManager` et `ProjectTrustManager` ;
- `ConfigurationStore`, `ModelCatalogService`, `ProviderRegistryService` et métriques d'usage persistantes ;
- `PluginService`, `SkillCatalogService`, `SkillRegistryService` et `ExtensionModuleLoader` ;
- `PushService` pour VAPID et les souscriptions chiffrées ou volatiles ;
- `SubagentService` pour les profils persistés et `SubagentRuntime` pour les exécutions enfants ;
- registre d'extensions, providers intégrés/personnalisés et OAuth Device Flow.

### Routeurs API

| Module | Surface principale |
|---|---|
| `api/agent-routes.ts` | runs détachés, état, SSE, files, commandes, compaction, palette, interactions et reload d'extensions |
| `api/session-pagination.ts` | fenêtres de messages bornées `tail`/`before`/`around` et métadonnées de révision |
| `api/workspace-routes.ts` | cwd par défaut, validation, navigation, confiance et worktrees |
| `api/file-routes.ts` | arbre, contenu/download, index borné, upload à collisions explicites, statut/diff Git et surveillance SSE |
| `api/terminal-routes.ts` | création/liste des PTY, saisie, resize, reprise SSE par offset et fermeture |
| `api/config-routes.ts` | couches globale/projet/session et configuration effective |
| `api/model-routes.ts` | catalogue groupé, découverte et activation globale/projet des modèles |
| `api/provider-registry-routes.ts` | auth/OAuth, providers compatibles, modèles personnalisés, tests et imports |
| `api/tool-routes.ts` | inventaire effectif et réglages d'outils/presets globaux ou projet |
| `api/plugin-routes.ts` | catalogue metadata-only, installation/activation/suppression, vérification/mise à jour et reload atomique |
| `api/skill-routes.ts` | catalogue/invocation des skills et registre installable global/projet |
| `api/push-routes.ts` | clé publique VAPID, état, inscription et désinscription Web Push |
| `api/subagent-routes.ts` | réglages/profils globaux ou projet et cycle de vie des agents enfants |
| `api/proxy.ts` | providers, credentials, métriques tarifées et anciens endpoints de chat compatibles |

Les anciens endpoints `/api/chat*` restent disponibles pour compatibilité, mais le Web courant démarre un run via `/api/agent/runs`.

## Flux agent détaché

```text
POST /api/agent/runs
  -> validation cwd + confiance
  -> création éventuelle de la session au premier envoi
  -> AgentRuntime.start() retourne 202 sans attendre le modèle
  -> message utilisateur persisté
  -> modèle -> outils -> modèle ...
  -> messages/outils/usage persistés au fil de l'eau

GET /api/agent/sessions/:id/state?messageLimit=80
  -> snapshot + queue bornée de la session

GET /api/sessions/:id/messages?before=<message-id>&limit=80
  -> page précédente et positions globales

GET /api/agent/sessions/:id/events?after=N
  -> connection.ready
  -> rejeu des événements > N
  -> abonnement live + heartbeat
```

La fermeture du flux HTTP ne stoppe pas le run. À la reconnexion, le client récupère d'abord l'état puis reprend à la dernière séquence. Si le curseur est plus ancien que le journal borné, le serveur indique qu'un snapshot complet est requis. Le snapshot conserve aussi la tentative de retry planifiée, l'outil actif et l'éventuelle interaction d'extension ; l'interface peut donc restituer phase, erreur, demande d'attention et action d'arrêt après une coupure sans dupliquer le message assistant partiel.

Chaque appel provider du tool loop, y compris un tour intermédiaire, passe par le callback d'usage. `AiProxyServer` normalise entrée/sortie/cache, préfère le coût explicite du provider puis applique le prix personnalisé ou publié. Chat historique/SSE, compaction, auto-titre et résumé automatique utilisent le même compteur. Les cumuls par provider sont restaurés et remplacés atomiquement dans `usage-metrics.json` ; le coût du tour est aussi persisté dans la session.

Après chaque message persistant suffisamment de contexte, la boucle transmet le `AbortSignal` du run à `SessionManager.checkAndTriggerCompaction`. La politique effective peut désactiver cette étape par portée. Si le seuil de contexte est atteint, les événements `compaction:start|end|error` distinguent le mode automatique, publient les tokens avant/après/économisés et signalent explicitement une annulation. Le résumé n'est appliqué au JSONL qu'après génération complète ; échec ou arrêt laisse l'historique intact. Le Web recharge ensuite la fenêtre canonique, comme après une compaction manuelle, pour retirer les messages remplacés du store visible.

`POST /api/sessions/:id/auto-name` envoie au provider choisi au plus huit messages user/assistant tronqués, normalise une seule ligne de titre à 100 caractères puis la persiste. `DELETE /api/sessions/:id` répond `CASCADE_CONFIRMATION_REQUIRED` avec tous les descendants récursifs tant que `cascade=true` n'a pas été confirmé séparément ; un clone indépendant n'est pas descendant.

## Commandes shell et terminaux PTY

`CommandRuntime` lance une commande bornée au cwd approuvé, capture stdout/stderr progressivement, limite la mémoire du journal, persiste statut/sortie/code/durée et permet annulation/rejeu. `!commande` inclut son résultat dans le contexte du modèle ; `!!commande` le conserve dans la session mais l'exclut du contexte.

`TerminalRuntime` possède séparément les processus `node-pty`, indépendamment de la durée des requêtes HTTP. Chaque PTY a un cwd canonique approuvé, un journal ANSI borné indexé en offsets UTF-8, un état de sortie et un plafond global d'instances. Les routes SSE commencent par `connection.ready`, signalent un reset si l'offset demandé a été évincé, puis rejouent la sortie et suivent les événements vivants. Entrées et dimensions sont bornées ; l'environnement du shell est construit par liste blanche sans credentials serveur/provider, la fermeture d'un onglet tue le processus et l'arrêt du serveur tue tous les PTY. Le client xterm gère émulation, sélection/presse-papiers, resize et plusieurs onglets restaurés par workspace dans `sessionStorage` ; sa frontière React est remontée avec une clé workspace afin qu'aucun PTY de l'ancien cwd ne reste monté pendant une bascule.

## Configuration

`ConfigurationStore` valide une liste fermée de clés non secrètes, écrit atomiquement avec permissions `0600`, et `resolveEffectiveConfiguration()` fusionne une seule chaîne de priorité pour l'API, les capabilities, les runs et la politique de compaction :

```text
defaults < global < projet < session persistée < champs de session JSONL < environnement
```

La réponse effective associe chaque valeur à sa provenance (`default`, `global`, `project`, `session` ou `environment`). Les champs runtime `model`, `thinking`, `toolPreset` et `autoCompaction` constituent les surcharges de conversation sérialisées en JSONL. Le protocole Web `settingOverrides` distingue leur présence de leur valeur : une clé absente hérite, une clé explicite persiste la valeur envoyée et `null` supprime la surcharge. Les anciens clients qui n'envoient pas ce tableau conservent leur comportement historique et ne modifient que les champs présents dans la requête.

`AI_HARNESS_DEFAULT_PROVIDER`, `AI_HARNESS_DEFAULT_MODEL`, `AI_HARNESS_DEFAULT_THINKING`, `AI_HARNESS_DEFAULT_TOOL_PRESET` et `AI_HARNESS_AUTO_COMPACTION` alimentent la couche environnement, prioritaire et non modifiable depuis le composer. Un patch `null` dans une portée globale/projet supprime la valeur explicite et restaure l'héritage. Les credentials restent dans les variables d'environnement, les coffres chiffrés ou la mémoire des services ; ils ne sont jamais acceptés par ce store ni renvoyés avec la provenance.

### Catalogue de modèles

`ModelCatalogService` fusionne quatre sources non secrètes : catalogue publié/versionné, modèle configuré, découverte distante du provider et modèles personnalisés de `ProviderRegistryService`. OpenAI-compatible utilise `/models`, Gemini filtre les modèles autorisant `generateContent`, Anthropic utilise son catalogue et Azure n'invente pas de découverte générique. Les identifiants sont normalisés/dédupliqués, un échec conserve le dernier résultat valide, et capacités, contexte, sortie, prix et compatibilité sont exposés sans credential. `GET /api/models?projectId=…&refresh=true` renvoie groupes, disponibilité, métadonnées et provenance d'activation. `PATCH /api/models/enabled` n'accepte que des clés qualifiées `provider:model`, exige `configuration`, puis écrit la portée projet ou globale avec lecture rétrocompatible des anciens IDs.

### Outils et presets

Les routes `/api/tools` dérivent leur inventaire de l'`ExtensionRegistry` réellement chargé et stockent `enabledTools`, preset et activation PowerShell dans `ConfigurationStore`. Un `projectId` n'est jamais résolu seul : le `cwd` canonique correspondant est obligatoire. `AgentRuntime` intersecte ensuite preset, réglage, allowlist de sous-agent et capacité `toolCalls` du modèle ; l'UI affiche cette même décision. PowerShell n'est enregistré que sous Windows et reste désactivé par défaut.

### Skills

`SkillCatalogService` découvre les documents `SKILL.md` globaux, issus des packages, des chemins explicites `AI_HARNESS_SKILL_PATHS` et du projet. La traversée est bornée en profondeur, nombre et taille de fichier, ne suit pas les liens symboliques, met les métadonnées en cache par cwd et recalcule automatiquement après un changement de confiance. `GET /api/skills` ne restitue que nom, description, version, fichier, source, portée, confiance et état d'invocation : le corps d'instructions ne quitte jamais le serveur. `PATCH /api/skills/enabled` accepte uniquement les clés qualifiées découvertes, écrit `enabledSkills` en portée projet ou globale et refuse un skill projet tant que le workspace n'est pas approuvé. L'outil en lecture seule `load_skill` expose au modèle uniquement les instructions activées et approuvées ; les doublons de nom suivent la priorité projet, chemin explicite, package, global. Un profil enfant peut encore réduire cette liste avec son allowlist de skills.

### Registre de skills

`SkillRegistryService` lit explicitement l'index HTTPS `AI_HARNESS_SKILL_REGISTRY_URL`, borné à 2 Mio/2 000 entrées et mis en cache cinq minutes. Chaque `SKILL.md` est limité à 256 Kio, téléchargé sans redirection ni credentials, vérifié par SHA-256 obligatoire et validé contre les métadonnées annoncées. Installation et mise à jour remplacent atomiquement un dossier global ou `.ai-harness/skills` approuvé après contrôles `lstat` ; un échec restaure la version précédente. La lecture reste metadata-only ; les mutations du registre exigent la capacité `packages`.

### Plugins et packages

`PluginService` persiste dans `plugins.json` les packages globaux et projet, indépendamment de leur inventaire dérivé par workspace. Il n'accepte que `npm:`, une URL Git HTTPS sur allowlist (`AI_HARNESS_PLUGIN_GIT_HOSTS`) ou un chemin absolu résolu par `WorkspaceManager`. Npm s'exécute avec `--ignore-scripts --omit=dev` ; Git utilise un clone superficiel puis installe les dépendances sans scripts. Installation et mise à jour passent par staging, rename et backup/trash avec rollback, et l'état est remplacé atomiquement en mode `0600`. Aucun GET ne déclenche installation, vérification distante ou mise à jour.

L'inventaire lit les conventions de répertoires ou le bloc `pi` du manifeste, avec budgets de profondeur/fichiers/ressources, sans suivre les liens symboliques. L'API ne publie que métadonnées nettoyées, diagnostics et compteurs d'extensions, skills, prompts et thèmes : ni code/instructions, ni credentials, ni sortie de commande. Les packages projet restent configurés mais leurs ressources sont masquées avant confiance. Les skills actifs sont fournis en interne à `SkillCatalogService` ; une mutation invalide tous ses caches dérivés afin qu'un package global ne reste pas périmé dans un autre workspace.

`POST /api/plugins/check` interroge explicitement `npm view` ou `git ls-remote` ; les mises à jour réutilisent le même remplacement transactionnel. `POST /api/plugins/reload` construit et valide une génération candidate, peut résoudre une session mémoire ou JSONL et refuse tout workspace différent. Il enchaîne ensuite `RuntimeServices.reloadResources()`, qui découvre les extensions globales, projet approuvées et de packages, les importe via le loader borné, puis remplace atomiquement leurs commandes, providers, outils, panneaux UI, hooks et listeners dans `ExtensionRegistry`. Un échec dans le même workspace conserve la génération précédente ; lors d'une bascule invalide, `clear()` retire plutôt les handlers de l'ancien workspace. Le résultat `restartRequired` ne reste vrai que si le code exécutable n'a pas pu être engagé. Les modules chargés restent du code Node de confiance exécuté dans le processus serveur, sans sandbox de sécurité.

### Sous-agents

`SubagentService` fournit les profils intégrés **Explore**, **General purpose** et **Plan**, puis persiste les réglages globaux et les copies projet dans `subagents.json` par écriture atomique. Il valide les identifiants, instructions, outils/skills/extensions, modèle, thinking, tours, héritage et mode arrière-plan. Les routes `/api/subagents/settings|profiles` exposent le CRUD sous capacité `configuration`. `SubagentRuntime` réutilise exclusivement `AgentRuntime` : il crée une session JSONL enfant reliée par `parentId`, `parentAgentId` et `agentId`, transmet au plus 40 messages et 120 000 caractères de contexte, applique les allowlists du profil, limite la profondeur à trois et la concurrence globale du processus à 1–16.

L'outil intégré `spawn_subagent`, disponible avec les presets autorisant la lecture, démarre le profil dans le provider et le preset effectifs du parent. Un appel synchrone attend son résultat et suit l'annulation du parent ; un appel en arrière-plan rend immédiatement les identifiants du run et de la session enfant. Le runtime publie `subagent.started|updated|completed|failed` dans le journal parent, conserve 200 snapshots bornés en mémoire, permet arrêt et acquittement d'attention, et arrête proprement les enfants au shutdown. Les sessions et messages enfants restent persistés ; le registre éphémère des runs n'est pas reconstruit après un redémarrage serveur.

### Providers personnalisés et OAuth

`ProviderRegistryService` persiste les définitions non secrètes dans `providers.json`, et leurs secrets dans `provider-secrets.enc` uniquement avec `AI_HARNESS_MASTER_KEY` (sinon en mémoire). Les dialectes OpenAI Completions/Responses, Anthropic et Google sont adaptés au proxy, testables et découvrables. Les modèles personnalisés enrichissent capacités, contexte, prix et compatibilité. `ProviderOAuthService` garde le device code côté serveur, impose endpoints HTTPS et réponses/délais bornés, puis stocke directement le token dans le coffre ou la mémoire du proxy sans le retourner au navigateur.

### Notifications Web Push

`PushService` génère les clés VAPID et conserve jusqu'à 1 000 souscriptions dans `push.enc` uniquement si une clé maître existe. Les endpoints doivent être HTTPS et, hors tests, leur résolution DNS ne peut contenir aucune adresse privée/loopback. Les notifications `completion` et `attention` ont des catégories indépendantes, un tag et une URL relative ; les réponses 404/410 suppriment la souscription. Le service worker déduplique avec les clients visibles et n'affiche qu'après une inscription issue d'une action utilisateur.

### Vérification de mises à jour

`GET /api/app-update` expose séparément les versions Web/agent et une métadonnée de release bornée. Le serveur interroge par défaut GitHub Releases avec timeout, déduplique les requêtes concurrentes et conserve le résultat six heures ; erreurs et réponses invalides deviennent un diagnostic non sensible. Cette route ne télécharge ni n'installe aucun binaire.

## Sécurité HTTP

- écoute loopback par défaut ; une écoute non-loopback est refusée sans token ;
- Bearer utilisateur/admin ou session Web opaque en cookie `HttpOnly`, `SameSite=Strict` ;
- capacités distinctes pour lecture, écriture workspace/fichiers, terminal, configuration, credentials et administration des packages ;
- vérification d'`Origin` sur les mutations et upgrades WebSocket ;
- limites JSON/upload, rate limiting en mémoire et messages 5xx neutralisés ;
- authentification WebSocket par cookie, Bearer ou sous-protocole (le query token reste seulement compatible avec les anciens clients).

Dans un déploiement multi-réplique, le reverse proxy doit aussi appliquer limites de débit et HTTPS.
