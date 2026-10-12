# Options de démarrage des extensions (API v1)

Ce contrat appartient à AiHarness. `ExtensionAPI`, `ExtensionOption`,
`ExtensionOptionDescriptor` et `ExtensionOptionValue` sont exportés par
`@ai-harness/core`. Cet ajout à l’API d’extension v1 ne nécessite aucune migration
des factories existantes.

```js
export default api => {
  api.registerOption('review-style', {
    type: 'string', description: 'Style de revue', default: 'brief',
    completions: ['brief', 'full'],
  });
  api.registerOption('review-check', {
    type: 'boolean', description: 'Vérifier la revue', default: false,
  });
  api.before('before:provider', () => {
    const style = api.getOption('review-style');
    const check = api.getOption('review-check');
  });
}
```

Les options de chargement et de confiance doivent **précéder** les options ajoutées :

```sh
ai-harness --approve --extension ./review.mjs --review-style=full --review-check=false --print --no-session hello
ai-harness --approve --extension ./review.mjs --help-extensions
ai-harness --approve --extension ./review.mjs --completion=--review-style=f
printf '%s\n' '{"type":"prompt","message":"review"}' | ai-harness --approve --extension ./review.mjs --mode=rpc --no-session --review-style=full --review-check
```

- Le nom, sans `--`, utilise des mots alphanumériques minuscules séparés par des
  tirets (64 caractères maximum). Les noms et alias intégrés sont réservés.
- Types acceptés : `boolean` et `string`. Un booléen accepte la présence seule
  (`true`) ou `=true`/`=false` ; une chaîne accepte `--nom=valeur` ou `--nom valeur`.
  Les doublons, chaînes vides, types/valeurs invalides et options inconnues échouent.
  Un prompt positionnel ou `--` termine l’interprétation des options.
- La factory peut immédiatement lire les valeurs par défaut. Les valeurs explicites
  sont disponibles via **son propre** `api.getOption(nom)` après l’analyse stricte,
  avant les hooks, commandes et outils. Ne conservez pas une lecture effectuée dans
  la factory comme valeur de démarrage. La lecture d’une option d’une autre extension
  renvoie `undefined`. Les valeurs ne sont injectées ni dans le contexte partagé
  des outils ni dans les métadonnées persistées des sessions.
- L’enregistrement renvoie une fonction de retrait idempotente. Le déchargement
  retire métadonnées et valeurs. Le rechargement revalide les arguments avec les
  nouvelles métadonnées ; un échec transactionnel restaure les anciennes valeurs.
- Limites : 32 options par extension, 256 par registre, descriptions en texte brut
  de 512 caractères, valeurs/défauts chaîne de 4096 caractères, 64 suggestions
  littérales de 256 caractères maximum. Les caractères de contrôle sont refusés.
  La complétion n’exécute aucun callback ni shell. La complétion du terminal inclut
  les options enregistrées et les suggestions `--nom=valeur`.

## Exécution et confiance

`--help` et `--version` restent des opérations intégrées sans exécution
d’extensions, même avec `--extension` ou `--approve`. `--help-extensions` et
`--completion` chargent explicitement les extensions exécutables autorisées puis
quittent sans démarrer d’agent ni de session. Les extensions et paquets du projet,
également ceux explicitement sélectionnés, nécessitent la confiance. Un projet
refusé n’est jamais importé simplement pour reconnaître une option ; une option
inconnue y échoue. Les extensions globales sont du code utilisateur exécutable,
non des métadonnées isolées.

L’analyse initiale ne peut connaître l’arité d’une option non enregistrée sans
exécuter du code. Les options de chargement/confiance placées après la première
option longue inconnue sont donc refusées plutôt que déduites d’un éventuel prompt.
Les démarrages interactif, print, JSON et RPC réutilisent la génération déjà
chargée sans seconde exécution de la factory. RPC reçoit le registre et le chargeur
préparés : les hooks et outils conservent les valeurs explicites de leur propriétaire.
Les sorties accidentelles des imports, factories, hooks et de l’arrêt restent hors
de stdout protocolaire. La fin d’entrée et les échecs de démarrage ou de livraison
de sortie arrêtent et déchargent ce même registre.

L’identité des tentatives d’import est indépendante de la génération validée.
Un échec d’enregistrement ou d’import laisse celle-ci inchangée ; la tentative
suivante évalue le nouveau code d’entrée au lieu de réutiliser un candidat en cache.
Cela couvre ESM (`.mjs` et `.js` de type module) et CommonJS (`.cjs` et `.js`
CommonJS), également lors des rechargements réussis et entre chargeurs indépendants.
Les points d’entrée des répertoires incluent `index.cjs`.

Les entrées CommonJS sont compilées comme de nouveaux modules hors cache, depuis
la source du fichier maintenu ouvert ; une query seule ne contourne pas le cache
CommonJS de Node indexé par nom de fichier. Les entrées préexistantes de
`require.cache` ne sont ni supprimées ni remplacées, même en cas d’échec.
Les `require`/`import` dynamiques relatifs, `__filename` et `__dirname` conservent
l’emplacement réel de l’entrée ; les imports relatifs ESM et `import.meta.url`
conservent leur emplacement normal. Seule l’entrée est réévaluée : les dépendances
conservent le cache normal de Node. La transaction protège les enregistrements
et valeurs possédés, pas les effets de bord arbitraires des modules.
