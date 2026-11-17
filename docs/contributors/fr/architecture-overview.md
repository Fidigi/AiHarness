# Architecture AiHarness — Vue d'ensemble et socle Core

## Sommaire

- [Vue d'ensemble](#vue-densemble)
- [Contrats partagés (`packages/core`)](#contrats-partagés-packagescore)
  - [Sessions versionnées](#sessions-versionnées)
  - [Runtime d'agent partagé](#runtime-dagent-partagé)
  - [Providers, multimodal et métadonnées](#providers-multimodal-et-métadonnées)
  - [Frontière workspace](#frontière-workspace)
- [CLI (`packages/cli`)](#cli-packagescli)

## Vue d'ensemble

AiHarness est un monorepo npm workspaces strict TypeScript/ESM composé de quatre packages :

```text
packages/
├── core/       # Contrats, providers, sessions, runtime agent et sécurité workspace
├── cli/        # Commande ai-harness et interfaces terminal
├── server/     # API HTTP/SSE/WS, runtimes détachés et lanceur Web
└── web/        # Application React/Vite
```

```text
CLI ───────────────┐
                   ├──> @ai-harness/core
Serveur Express ───┘          ▲
        ▲                      │ types uniquement
        └── HTTP/SSE ─── Web React
```

Le CLI et le serveur partagent le format JSONL et la boucle d'outils du Core. Le navigateur ne charge jamais les modules Node du Core : il importe uniquement leurs types et communique avec le serveur.

Pour plus de détails sur l'architecture serveur, consultez [server-architecture.md](./server-architecture.md).
Pour plus de détails sur l'application Web, consultez [web-architecture.md](./web-architecture.md).

## Contrats partagés (`packages/core`)

### Sessions versionnées

`Session` utilise actuellement le schéma v2. Il conserve notamment :

- les blocs texte, image, raisonnement, appel/résultat d'outil et commande ;
- le modèle, le provider, la durée, l'agent et l'usage/coût par message ;
- le cwd, le workspace, la branche Git, les relations de branche et la feuille active ;
- les commandes shell et leur politique d'inclusion dans le contexte ;
- les métadonnées de compaction et l'usage cumulé.

Le runtime manipule des `Date`. `serializeSession()` les convertit en ISO 8601 pour l'API et `deserializeSession()` les hydrate côté client. `JsonlSessionStore` lit aussi les anciens fichiers non versionnés. Les clés de provider ressemblant à des secrets sont retirées avant écriture ou sérialisation.

Un journal JSONL v2 contient les entrées `metadata`, `message`, `command`, `compaction`, `branch_summary`, `custom`, `custom_message`, `context_edit` et `loadout`. La compaction réduit l’historique effectif sans supprimer le journal. Données custom privées et loadouts restent hors des DTO navigateur ; voir [l’état du contexte de session](../../ai/topics/session-context-state.md).

### Runtime d'agent partagé

`packages/core/src/agent/` contient:

- `tool-loop.ts` : boucle modèle/outils multi-tour commune au CLI et au serveur ;
- `runtime.ts` : exécutions détachées, arrêt, retry avant premier delta et files `steer`/`follow-up` ;
- `events.ts` : journal borné par session avec séquences strictement croissantes et rejeu.

Un snapshot d'exécution inclut sa phase, son workspace, les files, le dernier numéro de séquence et l'éventuel message assistant partiel. Les événements couvrent cycle de vie, deltas, outils, commandes, retry, files et compaction. Le runtime expose aussi la sélection exacte des outils par preset (`chat-only`, `read-only`, etc.) afin que l'exécution et le panneau de capacités partagent la même liste.

### Providers, multimodal et métadonnées

Les providers intégrés sont OpenAI/Azure, Anthropic, Google Gemini/Vertex, AWS Bedrock, local compatible OpenAI et mock. Les appels d'outils sont normalisés, ainsi que les deltas de raisonnement explicitement fournis et les compteurs entrée/sortie/cache. Les blocs image sont adaptés nativement aux dialectes OpenAI (`image_url`), Anthropic (source base64) et Gemini (`inlineData`).

Le Core possède les métadonnées publiées et déclarations des adaptateurs dans `packages/core/src/providers/{model-metadata,provider-model-metadata,model-catalog}.ts`. CLI et Server réutilisent cet assemblage ; `packages/server/src/runtime/model-catalog.ts` ajoute découverte/cache hôte, surcharges opérateur et activation par portée. Une déclaration ne prouve ni credentials ni droits d’accès du compte. Le Core fournit `AiProvider.getAvailableModels()` pour la découverte bornée OpenAI-compatible, Anthropic et Gemini ; Azure reste sans hypothèse de découverte générique. Les contrats partagés des providers/modèles personnalisés, statuts OAuth, registres de ressources, réglages outils et interactions d’extension restent dans `packages/core/src/types/index.ts`, sans dépendance du Core vers le serveur ou React.

### Frontière workspace

`packages/core/src/security/` fournit :

- `WorkspaceManager` : expansion de `~`, canonicalisation par `realpath`, racines autorisées, contrôle de type, détection Git et opérations worktree ;
- `ProjectTrustManager` : décisions v2 d’autorisation/refus persistées atomiquement, résolues depuis l’ancêtre canonique le plus proche ; les anciennes allow-lists migrent lors d’une mutation.

La résolution de confiance encadre l’exécution séparément de la validation des racines. Le CLI peut admettre pour le processus un dossier sans ressource protégée sans enregistrer d’approbation ; les contenus projet protégés restent soumis à la confiance des ressources. Le Web conserve son approbation explicite des opérations. Refus enregistrés, surcharges de processus et inspection fraîche des ressources restent autoritatifs. La résolution rejette traversées, liens symboliques sortants et destinations hors racine. Voir la [confiance workspace](../../ai/topics/security.md).

## CLI (`packages/cli`)

Le CLI propose les modes terminal classique/plein écran, print de texte final, événements JSON et RPC JSONL. Il orchestre sessions, providers, outils, skills, prompts, extensions et confiance projet. La boucle d'outils historique délègue désormais au moteur partagé du Core afin que le CLI et le Web aient les mêmes règles de persistance et d'annulation.

Les extensions de projet restent bloquées avant confiance. Le CLI conserve son orchestration terminal, mais le chargeur borné `ExtensionModuleLoader` est partagé dans le Core avec le serveur : refus des liens symboliques et des modules dépassant 5 Mio, génération gérée et remplacement atomique. Le Web administre les packages et charge explicitement leurs extensions activées lors d'un reload de ressources, jamais pendant un simple GET ou une installation. Les modules chargés sont du code Node de confiance dans le processus hôte : le chargeur n’est pas une sandbox de sécurité.
