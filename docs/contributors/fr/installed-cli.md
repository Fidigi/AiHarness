# CLI installé et contrat des archives locales

## Limite de distribution

Les paquets npm `@ai-harness/core` et `@ai-harness/cli` sont actuellement **privés**. Cela interdit leur publication sur un registre, mais pas `npm pack` ni l'installation d'archives locales. Ce guide prouve le contrat de l'exécutable installé localement (CLI-RUN-01) ; il ne prétend pas prouver une version publiée sur npm, un téléchargement hébergé, une installation globale ou une distribution sur un registre public. Un critère exigeant cette disponibilité publique reste partiel jusqu'à une décision de publication distincte et autorisée.

Ne supprimez pas `private`, ne modifiez pas les dépendances/moteurs/métadonnées et ne publiez rien pour faire passer ce test. Un blocage réel du manifeste nécessite un correctif examiné par le coordinateur. L'absence d'une dépendance hors ligne n'est pas automatiquement un défaut du manifeste.

## Ce que prouve la régression

[`tests/functional-parity/installed-executable.test.ts`](../../../tests/functional-parity/installed-executable.test.ts) crée ses répertoires d'artefacts, de compilation et de consommation dans le répertoire temporaire système et vérifie que la racine des artefacts est hors du dépôt. Le test :

1. Copie Core/CLI dans un arbre de compilation indépendant, sans `dist`, `node_modules` ni anciens fichiers de compilation incrémentale. Exécute les scripts de compilation réels de chaque paquet, pas les scripts build/postbuild racine.
2. Exécute réellement `npm pack --json --offline --ignore-scripts` pour les deux paquets compilés. Ce n'est ni une archive fabriquée ni `pack --dry-run`.
3. Installe les chemins absolus littéraux des archives Core/CLI dans un consommateur jetable avec `npm install --offline --ignore-scripts --no-audit --no-fund --omit=dev`. Un paquet jetable distinct contenant des scripts pre/post-install vérifie que les scripts arbitraires des dépendances restent désactivés.
4. Vérifie que les répertoires installés Core/CLI ne sont pas des liens symboliques, que tous les liens installés restent dans le consommateur et que chaque fichier `dist` archivé est identique octet par octet à la compilation indépendante. Le verrou final du consommateur doit résoudre Core/CLI vers les archives locales réelles.
5. Lance **`ai-harness` via PATH**, avec seulement le `.bin` du consommateur devant Node et les répertoires système. Vérifie sa cible réelle, son mode exécutable et son shebang. Les sondes CLI ne lancent ni source, ni `dist/index.js` directement, ni `tsx`, `npm link` ou alias d'espace de travail.
6. Vérifie exactement aide/version intégrées et code/stdout/stderr d'une option inconnue, aide générée des extensions utilisateur/projet approuvé, valeurs contribuées et modes print/JSON/RPC installés avec le fournisseur mock. Les goldens de protocole existants et leur canonisation étroite restent inchangés ; ordre, valeurs, cadrage, canaux et codes de sortie restent vérifiés.
7. Exécute des consommateurs Node et TypeScript NodeNext de l'entrée publique installée `@ai-harness/core` : rechargement frais d'une entrée CommonJS après changement des métadonnées d'option, prompt/libération d'une session minimale utile, appels valides/rejetés du constructeur du chargeur et auto-test d'isolation QuickJS.

`--help`/`--version` intégrés n'exécutent pas les extensions. `--help-extensions` charge volontairement le code admissible ; les extensions projet nécessitent la confiance (`--approve` ne vaut que pour le processus). Les options inconnues peuvent nécessiter la découverte pour distinguer les options contribuées : le test ne garantit donc pas l'absence d'exécution du code utilisateur admissible dans ce cas. Les extensions sont du code Node hôte approuvé, pas du code sandboxé.

## Distinction exacte des dépendances hors ligne

Il s'agit d'une preuve hybride **dépendances réellement installées copiées + cache npm hors ligne existant**, pas d'une résolution vierge des dépendances sur un registre :

- La fermeture des dépendances de production est copiée depuis de vrais paquets installés dans l'image Docker, en conservant les versions imbriquées et en déréférençant les copies. Les dépendances installées locales au CLI doivent rester disponibles : la version racine de Chalk peut différer de celle requise par le CLI.
- Seuls les enregistrements réels de `node_modules/.package-lock.json` des dépendances copiées amorcent le verrou du consommateur jetable. Les indicateurs dev/extraneous du dépôt sont retirés car le nouveau consommateur déclare lui-même ces paquets. Aucune entrée Core/CLI n'est amorcée : npm doit décompresser les deux nouvelles archives et créer leur bin.
- `@types/node` et ses déclarations requises servent à la petite sonde de types SDK ; le compilateur reste un outil de test Docker, pas une dépendance de production revendiquée.
- Le `_cacache` du cache npm préexistant est copié dans le cache jetable. npm peut réinstaller les dépendances copiées possédant des bins (par exemple `which`) depuis ces archives en cache. Les URL de registre du verrou/cache sont des clés de cache ; `--offline` et Docker `--network none` empêchent l'accès registre/réseau. La validation ne remplit jamais le cache depuis le réseau.
- Une image sans cette fermeture/cache échoue au lieu de fabriquer des paquets, modifier les manifestes des archives, activer silencieusement les scripts ou basculer vers une installation en ligne.

`AIH_INSTALLED_NPM_CACHE` sélectionne le cache existant ; à défaut, le test utilise `.npm` du répertoire personnel du lanceur. `AIH_INSTALLED_EVIDENCE_DIR`, facultatif, doit être hors du dépôt et conserve les inventaires complets des archives Core/CLI, chemins sources des dépendances, arguments/résultat réels d'installation et racines des artefacts. Les consommateurs temporaires sont supprimés après la suite.

## Inventaire des artefacts d'exécution

L'archive Core doit contenir `dist/index.js`, les déclarations publiques émises, le chargeur d'extensions, `dist/tools/codemode.js` et `dist/tools/codemode-worker.js`. La source du worker est du JavaScript émis contenant le programme du worker sandbox ; ce n'est pas un worker TypeScript séparé non compilé. Les paquets QuickJS copiés contiennent leurs ressources JS/WASM, réellement résolues et exécutées par l'auto-test public installé, sans capacités ambiantes Node/réseau/minuteries.

L'archive CLI doit contenir `dist/index.js` exécutable, ses modules d'exécution émis et `scripts/copy-assets.mjs`. Ce script crée actuellement `dist` et applique le mode `0755` au bin ; aucune omission de copie de ressource CLI n'a été reproduite. Core n'a actuellement pas de script copy-assets. Cette preuve n'exige donc aucune modification des scripts de compilation.

Il n'existe actuellement pas de liste restrictive `files` : npm archive aussi sources/tests, cartes de sources/déclarations et métadonnées de compilation. L'inventaire les décrit au lieu de revendiquer une archive de publication épurée. Nettoyage des archives et publication publique sont des décisions distinctes.

## Validation Docker ciblée

Utilisez une image worker déjà approvisionnée hors ligne contenant les sources candidates, les véritables dépendances installées de production/développement, les dépendances locales au CLI et une entrée Core compilée pour les tests d'invocation existants. Préparez-la sans réseau ; ne prenez pas le dépôt actif modifié comme consommateur. La suite installée recompile Core/CLI indépendamment, même si l'image possède `dist` pour la suite d'invocation.

```bash
docker run --name aih-installed-cli-proof --network none --read-only \
  --cpus=1 --memory=1536m \
  --tmpfs /tmp:rw,exec,size=768m \
  --tmpfs /app/node_modules/.vite-temp:rw,size=16m \
  --tmpfs /app/node_modules/.vite:rw,size=16m \
  -e HOME=/tmp/runner-home \
  -e AIH_INSTALLED_NPM_CACHE=/root/.npm \
  -e AIH_INSTALLED_REQUIRE_READ_ONLY_SOURCE=1 \
  --mount type=volume,source=aih-installed-cli-evidence,target=/evidence \
  -e AIH_INSTALLED_EVIDENCE_DIR=/evidence \
  ai-harness:installed-cli-worker \
  ./node_modules/.bin/vitest run \
  tests/functional-parity/installed-executable.test.ts \
  packages/cli/src/cli/invocation.test.ts --maxWorkers=1
```

Les sources et le système de fichiers de l'image sont en lecture seule ; seuls `/tmp` jetable, les caches Vitest bornés et le volume de preuves sont modifiables. `AIH_INSTALLED_REQUIRE_READ_ONLY_SOURCE=1` vérifie aussi que l'ouverture en écriture de l'entrée serveur existante échoue avec `EROFS`, sans écrire de données ni créer de sonde dans les sources. Chaque enfant a un budget stdout/stderr combiné de 1 Mio et un délai (20 secondes normalement, 60 secondes pour compilation/installation/outils de types) ; préparation et sondes multiprocessus ont des délais de suite distincts bornés. Aucun test global, de production, de PTY natif ou de parité complète ni mise à jour de baseline n'est nécessaire pour ce contrat étroit. Conservez le conteneur terminé pour exporter `/evidence/inventory.json` avec `docker cp` ; le volume conserve la preuve après l'arrêt, contrairement au tmpfs. Supprimez conteneur/volume jetables une fois l'examen terminé.

Voir aussi : [politique du contrat public](./public-contract-policy.md), [extensions](./extensions-cli.md), [SDK de session](./session-sdk.md), [version anglaise](../en/installed-cli.md).
