# Exécution conteneurisée

Les images du dépôt utilisent Node.js 26 et npm 12.1.0. Les dépendances sont installées avec `npm ci` depuis le lockfile unique des workspaces.

## CLI

AiHarness peut fonctionner sans écrire de session sur le disque :

```sh
docker run --rm -it \
  --entrypoint node \
  -e ANTHROPIC_API_KEY \
  ai-harness:latest \
  packages/cli/dist/index.js --no-session --regular
```

- `--no-session` désactive le chargement et toute écriture JSONL ; la conversation reste uniquement en mémoire.
- `--regular` évite le mode écran alternatif lorsque le terminal du conteneur ne fournit pas un TTY complet.
- `--rpc` expose le protocole JSONL sur stdin/stdout et convient aux processus orchestrés.
- L’image de production démarre le Web par défaut ; `--entrypoint node` permet ici d’exécuter directement le CLI compilé.
- Les clés peuvent être injectées par variables d'environnement ou par un secret manager. Ne les placez pas dans l'image.

Pour conserver les sessions, montez un volume privé sur le dossier `.ai-harness` de l’utilisateur du conteneur. Pour les extensions et skills de projet, approuvez explicitement le projet avec `/trust`; aucun code projet n'est chargé implicitement.

## Web

L’image de production démarre `ai-harness-web` sur le port 3080 sans ouvrir de navigateur :

```sh
docker build -f .docker/Dockerfile.prod -t ai-harness:latest .
docker run --rm \
  -p 3080:3080 \
  -e OPENAI_API_KEY \
  -e AI_HARNESS_AUTH_TOKEN \
  -v ai-harness-data:/app/.ai-harness \
  ai-harness:latest
```

Ouvrez ensuite `http://127.0.0.1:3080`. L’image définit `AI_HARNESS_WEB_HOSTNAME=0.0.0.0` et `AI_HARNESS_WEB_NO_OPEN=1`; `AI_HARNESS_WEB_PORT` permet de modifier le port interne.
