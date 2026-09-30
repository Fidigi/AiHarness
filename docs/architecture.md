# Architecture AiHarness

## Vue d’ensemble

AiHarness est un monorepo npm workspaces composé de quatre packages :

```text
packages/
├── core/       # Types, providers, sessions, extensions et utilitaires partagés
├── cli/        # Commande ai-harness et interfaces terminal
├── server/     # API HTTP, SSE/WebSocket, credentials et lanceur Web
└── web/        # Application React/Vite
```

Dépendances principales :

```text
cli ─────┐
server ──┼──> core
web ─────┘

ai-harness-web ──> server + bundle web
```

Le CLI et le serveur utilisent le même format JSONL dans `~/.ai-harness/sessions/`. Le Web accède aux sessions et aux providers par l’API du serveur.

## Core (`packages/core`)

Le package `@ai-harness/core` contient :

- les types `Message`, `Session`, `ProviderConfig` et les structures de tool calls ;
- `SessionManager` et `JsonlSessionStore`, avec persistance, branches, clonage, résumés et compaction ;
- les providers OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex AI, AWS Bedrock, local compatible OpenAI et mock ;
- `ProviderFactory`, notamment utilisé par les providers enregistrés dynamiquement ;
- le registre d’extensions, ses commandes, outils, providers, panneaux UI, événements et hooks ;
- les utilitaires de retry, d’événements et de comptage.

## CLI (`packages/cli`)

Le binaire `ai-harness` propose deux interfaces :

- terminal classique basé sur `readline` ;
- plein écran avec transcript, historique, complétion et panneaux d’extensions.

Il orchestre les commandes de session, le streaming provider, les tool calls, les skills, les prompts, les extensions, la confiance des projets et le mode RPC JSONL. Les sessions sont persistées sauf avec `--no-session`.

Le point d’entrée est `packages/cli/src/index.ts` et le routeur de commandes se trouve dans `packages/cli/src/commands/handler.ts`.

## Serveur (`packages/server`)

Le serveur Express fournit :

- les routes `/api` pour le chat, les providers, la configuration et les sessions ;
- le streaming Server-Sent Events et WebSocket ;
- la persistance JSONL partagée avec le CLI ;
- des liens temporaires `/share/<token>` ;
- une authentification Bearer facultative ;
- le stockage facultatif des credentials chiffrés ;
- le service du bundle React et le fallback SPA en production.

`ai-harness-web` démarre ce serveur et le bundle Web sur un seul port. En développement, Vite utilise le port 3080 et relaie `/api` et les WebSockets vers le serveur sur le port 3099.

## Web (`packages/web`)

L’application React utilise Zustand pour l’état des sessions et providers. Elle comprend :

- `Sidebar` pour créer et sélectionner les sessions ;
- `ChatView` pour le chat et le streaming ;
- `SettingsView` pour les providers, les tokens, le transport et le thème ;
- `services/api.ts` pour les appels HTTP, SSE et WebSocket.

Les sessions restent la source de vérité du serveur et sont rechargées au démarrage de l’interface.

## Extensions

Les extensions JavaScript du CLI peuvent enregistrer :

- des commandes ;
- des outils appelables manuellement ou par un modèle ;
- des providers ;
- des panneaux texte pour le mode plein écran ;
- des listeners de cycle de vie et des hooks `before:agent`, `before:provider` et `before:tool`.

Les extensions Web ne sont pas encore chargées côté serveur. Voir [extensions.md](extensions.md).

## Validation

Les tests Vitest couvrent les quatre packages. Les tests Playwright valident l’interface Web et ses principaux parcours.

Commandes habituelles :

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Les cibles Docker équivalentes sont disponibles dans le `Makefile`.
