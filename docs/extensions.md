# Extensions AiHarness

Les extensions sont des modules JavaScript de confiance exécutés dans le processus CLI. Elles disposent des mêmes permissions système qu'AiHarness : ne chargez pas de code non vérifié.

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

Les extensions TypeScript doivent actuellement être compilées en JavaScript avant leur chargement.

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
- `registerUI(component)` : ajoute un panneau texte à l’interface CLI plein écran. Le composant reçoit notamment `currentSessionId` et `provider`.
- `on(event, handler)` : écoute un événement lifecycle et retourne une fonction de désabonnement.
- `before(event, handler)` : transforme ou annule une opération avant son exécution.
- `events` : bus d'événements pour la communication entre extensions.

Les événements actuels couvrent les sessions, messages, compactage, appels agent/provider/tool, `system:ready` et `system:shutdown`.

### Hooks transformants et annulables

Trois hooks sont disponibles :

- `before:agent` reçoit `{ sessionId, provider, input }` ;
- `before:provider` reçoit `{ provider, model, messages, options }` ;
- `before:tool` reçoit `{ tool, input, context }`.

Les handlers sont exécutés dans leur ordre d'enregistrement. Ils peuvent retourner un objet partiel pour transformer les données suivantes, `false` pour annuler, ou `{ cancel: true, reason?: string }` pour annuler avec une raison. Une exception interrompt l'opération et identifie l'extension fautive. Les hooks sont automatiquement désabonnés lors du déchargement.

Pour modifier une option provider sans supprimer les autres, conservez explicitement l'objet existant :

```js
api.before('before:provider', data => ({
  options: { ...data.options, temperature: 0.2 },
}));
```

### Appels automatiques d'outils

Les schémas des outils sont transmis automatiquement aux providers OpenAI, Anthropic et locaux compatibles OpenAI. Quand le modèle demande un outil, le CLI persiste le tool call, exécute l'outil, persiste son résultat (erreurs comprises), puis reprend l'appel modèle. La boucle est limitée à huit tours consécutifs pour éviter les appels infinis. Une interruption `Ctrl+C` annule la requête provider et propage le signal à l'outil actif.

## Commandes de gestion

```text
/extensions   Liste les extensions et leurs capacités
/tools        Liste les outils enregistrés
/tool         Exécute manuellement un outil
/reload       Décharge puis recharge tous les modules
```

Le déchargement retire automatiquement les commandes, outils, providers, panneaux UI et listeners appartenant à l'extension. Une fonction de cleanup retournée par la factory est également appelée.

## Limites actuelles

- L'exécution automatique des outils, les hooks agent/provider et les panneaux UI sont orchestrés par le CLI ; le serveur Web ne charge pas encore les extensions locales.
- Les panneaux enregistrés avec `registerUI` sont textuels et visibles uniquement dans le mode CLI plein écran.
