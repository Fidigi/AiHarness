# Extensions AiHarness — CLI

## Sommaire

- [Emplacements](#emplacements)
- [Sélecteurs configurés](#sélecteurs-configurés)
- [Exemple](#exemple)
- [API disponible](#api-disponible)
  - [Hooks transformants et annulables](#hooks-transformants-et-annulables)
  - [Appels automatiques d'outils](#appels-automatiques-doutils)
- [Gestion des packages](#gestion-des-packages)
- [Commandes de gestion](#commandes-de-gestion)
- [Limites actuelles](#limites-actuelles)

## Emplacements

Le CLI découvre automatiquement :

- `<répertoire-agent>/extensions/*` (`~/.ai-harness` par défaut), avec les suffixes JavaScript/TypeScript pris en charge
- `<projet>/.ai-harness/extensions/*`, après approbation du projet
- les sous-dossiers contenant un index pris en charge (priorité ci-dessous)

Un module peut aussi être chargé explicitement :

```bash
ai-harness --extension ./extensions/example.mjs
```

Plusieurs chemins peuvent être fournis avec plusieurs options `--extension`, ou avec `AI_HARNESS_EXTENSIONS` séparé par le séparateur de chemins du système.

Les entrées TypeScript (`.ts`, `.mts`, `.cts`, `.tsx`) sont désormais exécutées directement par le transpileur Core ; les déclarations (`.d.ts`, `.d.mts`, `.d.cts`) ne sont jamais exécutées. Un package installé peut aussi déclarer des extensions, skills, prompts et thèmes JSON via `aiHarness` (la clé historique `pi` du manifeste est également acceptée). Les extensions, skills et prompts actifs rejoignent le démarrage CLI et RPC depuis le même catalogue Core que le serveur Web ; un thème de package sélectionné rejoint le démarrage CLI interactif.

## Sélecteurs configurés

Le tableau `extensions` des `settings.json` global et projet approuvé s’applique aux fichiers réellement découverts **avant les imports**. Les sélecteurs globaux précèdent ceux du projet ; les chemins relatifs partent du dossier du fichier de réglages, pas du cwd du shell. Ce dossier reste une identité littérale, même si son nom contient des crochets ou d’autres caractères de glob. Les candidats automatiques, explicites et issus des packages actifs sont tous soumis à ces sélecteurs :

```json
{
  "extensions": [
    "extra/**/*.mjs",
    "!extensions/**/disabled.mjs",
    "!extra/**/experimental*.mjs",
    "+extra/stable/experimental-approved.mjs",
    "-extra/retired"
  ]
}
```

- Un chemin sans préfixe ajoute un fichier ou les entrées ordinaires d’un dossier peu profond ; un glob sans préfixe développe les entrées JavaScript/TypeScript prises en charge selon les motifs de chemins Node.
- `+chemin` ajoute un fichier/dossier exact ; les caractères de glob restent littéraux.
- `-chemin` retire le fichier exact ou les fichiers découverts sous ce dossier ; `!glob` retire les correspondances.
- L’ordre compte : un ajout ultérieur peut rétablir un retrait. Les fichiers sont dédupliqués et importés par ordre de chemin absolu. `--extension`, les chemins d’environnement et `paths` de Core restent littéraux, sans interprétation shell/glob.
- La confiance reste obligatoire pour les sélecteurs et fichiers projet, y compris un `+` exact et un motif dont la racine contient le cwd non approuvé. Aucun sélecteur ne contourne les contrôles de fichiers stables ni n’accorde la confiance. Les commutateurs virtuels `builtin:` utilisent la politique de capacités ci-dessous, distincte des chemins de fichiers.

Une génération admet au plus 200 chemins de découverte ordinaires et 200 sélecteurs (32 Kio UTF-8 par chaîne, ou pour le motif et sa base cumulés dans une entrée à portée explicite). Avec des sélecteurs non vides, les candidats ne peuvent dépasser 1 000 fichiers à aucune étape, même si des exclusions ultérieures réduiraient ce nombre. Un scan glob autorise 1 000 entrées par dossier, 10 000 visites d’entrées cumulées, 256 visites de dossiers et huit niveaux descendants ; les motifs répétés consomment le même budget global. Un glob non récursif ne descend pas dans les sous-arbres sans rapport. Un dépassement refuse toute la génération candidate plutôt que d’importer un préfixe tronqué. Les chemins facultatifs absents sont ignorés. Les modules liés, à liens physiques multiples ou trop volumineux restent refusés (5 Mio maximum) ; les fichiers de déclarations restent exclus.

Core exporte l’option additive `ExtensionModuleLoaderOptions.selectors` : tableau readonly de `ExtensionModuleSelector` ou callback synchrone/asynchrone qui le fournit, réévalué à chaque découverte/reload. Une entrée est une chaîne relative au cwd du chargeur, ou `{ pattern, baseDir }` avec un dossier de base absolu et littéral. Seul le motif est interprété comme glob ; les couches CLI et l’expansion du dossier personnel conservent cette distinction. L’hôte conserve la responsabilité de la confiance et du contexte via `isProjectTrusted` et `cwd`. Le démarrage CLI, print/JSON/RPC et le reload interactif transmettent les réglages ordonnés et résolus par couche à cette implémentation commune ; cette fonctionnalité CLI ne change pas la configuration du Server. Un échec de découverte conserve les enregistrements gérés précédents ; un remplacement réussi préserve les propriétaires indépendants. Les effets Node et imports de dépendances exécutés ne sont **ni sandboxés ni annulés** : un module admis peut importer lui-même une entrée exclue comme dépendance.

## Exécution TypeScript

```ts
import type { ExtensionAPI } from '@ai-harness/core';
export default function review(api: ExtensionAPI) {
  api.registerCommand('review', { description: 'Revue', handler: () => 'Prêt' });
}
```

Chargez ce fichier avec `ai-harness -e ./review.ts`, ou utilisez la découverte utilisateur/projet/réglages/environnement/packages. Core évalue les octets du descripteur déjà admis via `jiti` épinglé, en conservant limites, contrôles de liens/confiance et enregistrements transactionnels. La racine exacte `@ai-harness/core` désigne le véritable espace public de l’hôte, y compris lors d’imports tardifs hors installation. Imports relatifs/sans suffixe, enums, propriétés de paramètres, exports CommonJS et JSX classique sont pris en charge ; JSX exige toujours la fabrique/bibliothèque de l’auteur et n’ajoute aucune surface React ou navigateur.

Il n’y a ni vérification statique des types, ni chargement implicite des alias `tsconfig`. Le graphe de dépendances transformées est privé à chaque entrée et renouvelé au reload ; les dépendances natives conservent le cache Node. Les caches disque/globaux du transpileur sont désactivés. Une évaluation invalide produit un diagnostic fixe sans recopier le code ; les enregistrements précédents du même workspace survivent. Dépendances et effets Node admis ne sont **ni sandboxés ni annulés**.

Priorité des index enfants : `.mjs`, `.js`, `.cjs`, puis `.ts`, `.mts`, `.cts`, `.tsx`. Évitez de découvrir simultanément source et version compilée d’une même extension : des chemins distincts restent des candidats distincts. Les manifestes des packages installés passent par le service de packages. Les manifestes de dossiers non installés suivent désormais les règles littérales ci-dessous. La résolution plus large des modules/alias hôte JavaScript reste incomplète.

## Manifestes de dossiers

Un sous-dossier découvert ou un dossier explicite/réglages/environnement peut sélectionner ses entrées sans installation de package :

```json
{ "aiHarness": { "extensions": ["src/review.ts", "src/other.mjs"] } }
```

Le champ historique `pi.extensions` est également lu ; les champs natifs remplacent individuellement les champs historiques. Sans champ extensions, la découverte ordinaire reste active ; une liste vide désactive les entrées du dossier. Une liste déclarée remplace la découverte automatique des index/fichiers voisins. Les sélecteurs des réglages s’appliquent ensuite.

Il s’agit de **chemins relatifs exacts**, pas de globs ni d’opérateurs de sélection ; crochets et autres métacaractères restent littéraux, et les séparateurs antislash sont normalisés. Une entrée de dossier résout seulement son index pris en charge, sans manifestes récursifs ni `main`/`exports` arbitraires. La priorité historique JavaScript demeure. Les déclarations/fichiers réguliers non exécutables sont ignorés ; entrée absente, liée, trop grande ou sans index : la génération échoue, sans repli vers les fichiers voisins. Les globs de ressources des packages installés conservent leur sémantique distincte.

Les métadonnées passent par des descripteurs stables après admission de confiance : 256 Kio et 100 chemins par manifeste, 32 Kio par chaîne ; limites partagées par découverte : 200 lectures de manifestes, 4 Mio et 1 000 visites de chemins déclarés, travail répété inclus. Chemins absolus/hors dossier/autoréférents, UTF-8/JSON invalides ou changement d’identité produisent un diagnostic sans code source. `/reload` renouvelle la sélection ; des métadonnées invalides conservent les enregistrements précédents du même workspace. Ces contrôles d’entrée ne sandboxent pas les imports privilégiés et n’annulent pas leurs effets.

## Commutateurs intégrés facultatifs

Les identifiants CLI/RPC facultatifs sont `builtin:mcp`, `builtin:codemode` et `builtin:tool-search`. Dans les `extensions` globales, les exclusions `!glob` précèdent les ajouts exacts `+builtin:nom`, puis les retraits exacts `-builtin:nom`. Le dernier modificateur correspondant du projet approuvé prime sur la politique globale. Un identifiant sans préfixe ne rétablit pas une exclusion. Un `-e builtin:nom` explicite reste prioritaire ; un identifiant exact inconnu est refusé sans recopier sa valeur. Limites : 200 entrées par liste et 32 Kio par chaîne.

`--no-extensions` (`-ne`) supprime la découverte **exécutable** automatique globale/projet, les sélecteurs de réglages, l’environnement et les packages actifs, ainsi que ces capacités facultatives. Les fichiers/dossiers et identifiants intégrés explicitement demandés par `-e` restent actifs, avec les mêmes contrôles de confiance et de stabilité. Placez les options de découverte avant les options contribuées. Exemple : `ai-harness --no-extensions -e builtin:mcp -e ./review.mjs`.

Les outils workspace, skills/prompts/thèmes, providers et opérations MCP explicites restent indépendants. Ce n’est ni un mode hors ligne, ni une suppression de tous les outils, ni une sandbox. Codemode conserve ses réglages d’activation/sélection ; désactiver le `tool_search` hébergé n’efface pas les activations antérieures encore autorisées et ne désactive pas un remplacement tiers. `/reload` actualise la politique interactive et ferme les connexions MCP désactivées avant de poursuivre ; la réactivation attend un prochain prompt pour connecter. RPC exige un redémarrage. Le rollback des modules ne rétablit pas la politique de réglages séparée ; les effets externes déjà admis ne sont pas annulables.

Core expose `resolveBuiltinExtensionPolicy`, `BUILTIN_EXTENSION_NAMES` gelé, `BuiltinExtensionPolicy` readonly, les options additives `ExtensionModuleLoaderOptions.includeEnvironmentPaths` et `CreateAgentToolLoadoutOptions.toolSearchEnabled`, ainsi que `McpSessionHost.setEnabled(boolean)` réutilisable. La politique n’importe aucun module et n’accorde aucune confiance. La composition des réglages Server/Web ne change pas.

## Exemple

```js
export default function exampleExtension(api) {
  api.registerCommand('hello', {
    description: 'Afficher un message',
    usage: '/hello [nom]',
    handler: async (args, ctx) => {
      const message = `Bonjour ${args || 'monde'}`;
      ctx.notify(message, 'success');
      return message;
    },
  });

  api.registerTool({
    name: 'sum',
    description: 'Additionner deux nombres',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    execute: ({ a, b }) => ({
      content: String(a + b),
      details: { a, b },
    }),
  });

  api.registerUI({
    name: 'example-status',
    placement: 'status',
    render: ({ provider }) => `Provider actif : ${provider || 'inconnu'}`,
  });

  api.before('before:agent', data => ({
    input: data.input.trim(),
  }));

  api.before('before:tool', data => {
    if (data.tool === 'sum' && Number(data.input?.a) < 0) {
      return { cancel: true, reason: 'Les nombres négatifs sont interdits.' };
    }
  });

  const unsubscribe = api.on('session:create', event => {
    api.events.emit('example:session-created', event);
  });

  return () => unsubscribe();
}
```

## API disponible

Chaque factory reçoit `api.version`. La version `1` est aussi exportée sous le nom `AI_HARNESS_EXTENSION_API_VERSION` par `@ai-harness/core` ; une extension doit refuser une version majeure non prise en charge avant d’enregistrer son comportement.

- `version` : version majeure courante du contrat d’extension propre à AiHarness.
- `registerCommand(name, definition)` : ajoute une commande `/name`.
- `registerTool(definition)` : ajoute un outil exécutable. Les outils sont listés par `/tools` et peuvent être testés avec `/tool <nom> <json>`.
- `registerProvider(type, definition)` : ajoute une factory de provider sélectionnable avec `/provider <type>`.
- `registerUI(component)` : ajoute un panneau texte à l'interface CLI plein écran. Le composant reçoit notamment `currentSessionId` et `provider`.
- `on(event, handler)` : écoute un événement lifecycle et retourne une fonction de désabonnement.
- `before(event, handler)` : transforme ou annule une opération avant son exécution.
- `events` : bus d'événements pour la communication entre extensions.

Les événements actuels couvrent les sessions, messages, compactage, appels agent/provider/tool, `system:ready` et `system:shutdown`.

### Hooks transformants et annulables

Trois hooks sont disponibles :

- `before:agent` reçoit `{ sessionId, provider, input }` ;
- `before:provider` reçoit `{ provider, model, messages, options }` ;
- `before:tool` reçoit `{ tool, input, context }`.

Les handlers sont exécutés dans leur ordre d'enregistrement. Ils peuvent retourner un objet partiel pour transformer les données suivantes, `false` pour annuler, ou `{ cancel: true, reason?: string }` pour annuler avec une raison. Une exception interrompt l'opération et identifie l'extension fautive. Les hooks sont automatiquement désabonnés lors du déchargement.

Pour modifier une option provider sans supprimer les autres, conservez explicitement l'objet existant :

```js
api.before('before:provider', data => ({
  options: { ...data.options, temperature: 0.2 },
}));
```

### Appels automatiques d'outils

Les schémas des outils passent automatiquement par le contrat provider partagé ; les adaptateurs OpenAI/Azure, Anthropic, Gemini/Vertex, Bedrock et locaux compatibles les traduisent lorsque le modèle autorise les appels d’outils. Quand le modèle demande un outil, le CLI persiste le tool call, exécute l'outil, persiste son résultat (erreurs comprises), puis reprend l'appel modèle. La boucle est limitée à huit tours consécutifs pour éviter les appels infinis. Une interruption `Escape` ou `Ctrl+C` annule la requête provider et propage le signal à l'outil actif.

## Gestion des packages

L’état et la politique des sources résident dans `@ai-harness/core` ; le CLI et le Web ne maintiennent pas deux installateurs. `ai-harness package --help` décrit toutes les options :

```bash
ai-harness package install npm:@scope/review-kit@^2 --global
ai-harness package install ./review-kit --project --approve
ai-harness package configure @scope/review-kit --extensions='extensions/*.mjs,!extensions/unsafe.mjs'
ai-harness package list --json
ai-harness package check @scope/review-kit
ai-harness package update @scope/review-kit
ai-harness package remove @scope/review-kit
```

Les sources `npm:`, `git:` HTTPS restreintes et les chemins locaux explicites sont acceptés. `--extensions`, `--skills`, `--prompts` et `--themes` ne peuvent que restreindre les ressources du manifeste ; une valeur vide désactive le type et `--reset` rétablit les valeurs par défaut. Installer, configurer, activer, mettre à jour ou charger un package projet exige la confiance du projet ; sa désactivation et sa suppression restent disponibles pour un nettoyage sûr. Un package exécute du code Node de confiance sans sandbox : contrôlez sa source avant installation.

Dans le Web, les contrôles **Enable all** et **Disable all** des groupes Project/Global délèguent un unique lot borné à Core. Core conserve les filtres de ressources, valide les changements permis par une seule écriture atomique, rapporte les refus de confiance ou packages absents entrée par entrée, puis signale les changements exécutables qui exigent le reload séparé des ressources.

## Commandes de gestion

```text
/extensions   Liste les extensions et leurs capacités
/tools        Liste les outils enregistrés
/tool         Exécute manuellement un outil
/reload       Prépare et remplace atomiquement la génération gérée par le CLI
```

Le déchargement retire automatiquement les commandes, outils, providers, panneaux UI et listeners appartenant à l'extension. Une fonction de cleanup retournée par la factory est également appelée.

## Limites actuelles

- Le CLI et le serveur Web chargent des générations d’extensions séparées : `/reload` recharge uniquement le processus CLI, tandis que l’API Web possède ses propres routes de reload.
- Les panneaux CLI enregistrés avec `registerUI` sont textuels et visibles uniquement en mode plein écran ; le serveur restitue séparément ses widgets texte et interactions déclaratives.
- Les modules exécutables sont du code Node de confiance exécuté dans le processus hôte, sans sandbox de sécurité.
- Les règles de compatibilité publique et de probes golden sont décrites dans la [politique des contrats publics AiHarness](./public-contract-policy.md).
