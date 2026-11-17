# Exécution conteneurisée

L’image de test utilise par défaut Node.js 24.15.0 LTS figé ; l’image de production utilise le tag flottant Node.js 26. Toutes deux installent npm 12.1.0 et utilisent `npm ci` avec le lockfile unique des workspaces. Les Dockerfiles exposent les arguments de build `NODE_VERSION` et `NPM_VERSION` ; les modifier ne vaut pas validation avec les versions par défaut.

## CLI

Construisez l’image de production, puis lancez le CLI sans écrire de session sur le disque :

```sh
make build-prod
docker run --rm -it \
  --entrypoint node \
  -e ANTHROPIC_API_KEY \
  ai-harness:prod-latest \
  packages/cli/dist/index.js --no-session --regular
```

- `--no-session` désactive le chargement et toute écriture JSONL ; la conversation reste uniquement en mémoire.
- `--regular` évite le mode écran alternatif lorsque le terminal du conteneur ne fournit pas un TTY complet.
- `--rpc` expose le protocole JSONL sur stdin/stdout et convient aux processus orchestrés.
- L’image de production démarre le Web par défaut ; `--entrypoint node` permet ici d’exécuter directement le CLI compilé.
- Les clés peuvent être injectées par variables d'environnement ou par un secret manager. Ne les placez pas dans l'image.

Pour conserver les sessions, montez un volume privé sur le dossier `.ai-harness` de l’utilisateur du conteneur. Pour les extensions et skills de projet, approuvez explicitement le projet avec `/trust`; aucun code projet n'est chargé implicitement.

## Web

L’image de production démarre `ai-harness-web` sur le port 3080 sans ouvrir de navigateur.

### Avec Make

Depuis la racine du dépôt, fournissez un jeton d’authentification, construisez l’image puis démarrez le conteneur en arrière-plan :

```sh
export AI_HARNESS_AUTH_TOKEN="$(openssl rand -hex 32)"
make run-prod PROD_DOCKER_ARGS='--env AI_HARNESS_AUTH_TOKEN'
```

Conservez ce jeton en privé pour la connexion navigateur. Pour conserver aussi les credentials provider chiffrés, transmettez une `AI_HARNESS_MASTER_KEY` stable depuis votre gestionnaire de secrets à chaque démarrage.

L’application est alors disponible sur `http://127.0.0.1:3080`. Le conteneur se nomme `ai-harness-prod` et les données sont conservées dans le volume `ai-harness-data`. Une nouvelle exécution de `make run-prod` reconstruit l’image et remplace le conteneur existant sans supprimer ce volume.

Pour ouvrir Bash dans l’instance en cours d’exécution :

```sh
make shell-prod
```

Le shell utilise l’utilisateur non privilégié `aiharness`. Arrêtez et supprimez le conteneur avec `docker stop ai-harness-prod`; le volume de données reste conservé.

Le port et les options passées à `docker run` sont personnalisables. Par exemple, pour utiliser le port 8080 et transmettre des variables déjà exportées dans le shell hôte :

```sh
export OPENAI_API_KEY='...'
export AI_HARNESS_AUTH_TOKEN='...'
make run-prod PROD_PORT=8080 \
  PROD_DOCKER_ARGS='--env OPENAI_API_KEY --env AI_HARNESS_AUTH_TOKEN'
```

Par défaut, le port publié n’écoute que sur l’interface locale. Pour une écoute externe, utilisez `PROD_BIND_ADDRESS=0.0.0.0` uniquement avec un jeton d’authentification et un reverse proxy HTTPS ou un réseau privé de confiance.

### Avec Docker directement

```sh
docker build -f .docker/Dockerfile.prod -t ai-harness:latest .
docker run --rm \
  -p 127.0.0.1:3080:3080 \
  -e OPENAI_API_KEY \
  -e AI_HARNESS_AUTH_TOKEN \
  -v ai-harness-data:/app/.ai-harness \
  ai-harness:latest
```

Ouvrez ensuite `http://127.0.0.1:3080`. L’image définit `AI_HARNESS_WEB_HOSTNAME=0.0.0.0` et `AI_HARNESS_WEB_NO_OPEN=1`; `AI_HARNESS_WEB_PORT` permet de modifier le port interne. Puisque l’application écoute sur toutes les interfaces du conteneur, fournissez `AI_HARNESS_AUTH_TOKEN` ou `AI_HARNESS_ADMIN_TOKEN` même si Docker publie seulement sur le loopback de l’hôte ; sinon le démarrage est refusé. N’utilisez pas la dérogation d’écoute distante non sécurisée comme solution de production.
