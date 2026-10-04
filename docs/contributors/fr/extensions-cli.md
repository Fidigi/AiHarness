# Extensions AiHarness — CLI

## Sommaire

- [Emplacements](#emplacements)
- [Exemple](#exemple)
- [API disponible](#api-disponible)
  - [Hooks transformants et annulables](#hooks-transformants-et-annulables)
  - [Appels automatiques d'outils](#appels-automatiques-doutils)
- [Gestion des packages](#gestion-des-packages)
- [Commandes de gestion](#commandes-de-gestion)
- [Limites actuelles](#limites-actuelles)

## Emplacements

Le CLI découvre automatiquement :

- `~/.ai-harness/extensions/*.js|*.mjs`
- `<projet>/.ai-harness/extensions/*.js|*.mjs`
- les sous-dossiers contenant `index.js` ou `index.mjs`

Un module peut aussi être chargé explicitement :

```bash
ai-harness --extension ./extensions/example.mjs
```

Plusieurs chemins peuvent être fournis avec plusieurs options `--extension`, ou avec `AI_HARNESS_EXTENSIONS` séparé par le séparateur de chemins du système.

Les extensions TypeScript doivent actuellement être compilées en JavaScript avant leur chargement. Un package installé peut aussi déclarer des extensions, skills, prompts et thèmes JSON via `aiHarness` (la clé historique `pi` du manifeste est également acceptée). Les extensions, skills et prompts actifs rejoignent le démarrage CLI et RPC depuis le même catalogue Core que le serveur Web ; un thème de package sélectionné rejoint le démarrage CLI interactif.

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
/reload       Décharge puis recharge tous les modules
```

Le déchargement retire automatiquement les commandes, outils, providers, panneaux UI et listeners appartenant à l'extension. Une fonction de cleanup retournée par la factory est également appelée.

## Limites actuelles

- Le CLI et le serveur Web chargent des générations d’extensions séparées : `/reload` recharge uniquement le processus CLI, tandis que l’API Web possède ses propres routes de reload.
- Les panneaux CLI enregistrés avec `registerUI` sont textuels et visibles uniquement en mode plein écran ; le serveur restitue séparément ses widgets texte et interactions déclaratives.
- Les modules exécutables sont du code Node de confiance exécuté dans le processus hôte, sans sandbox de sécurité.
