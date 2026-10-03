# Containerized Execution

The repository images use Node.js 26 and npm 12.1.0. Dependencies are installed with `npm ci` from the monorepo lockfile.

## CLI

AiHarness can run without writing sessions to disk:

```sh
docker run --rm -it \
  --entrypoint node \
  -e ANTHROPIC_API_KEY \
  ai-harness:latest \
  packages/cli/dist/index.js --no-session --regular
```

- `--no-session` disables loading and all JSONL writes; the conversation stays in memory only.
- `--regular` avoids alternate screen mode when the container terminal does not provide a full TTY.
- `--rpc` exposes the JSONL protocol on stdin/stdout, suitable for orchestrated processes.
- The production image starts the Web UI by default; `--entrypoint node` lets you run the compiled CLI directly here.
- Keys can be injected via environment variables or a secret manager. Never place them in the image.

To persist sessions, mount a private volume on the container user's `.ai-harness` folder. For project extensions and skills, explicitly approve the project with `/trust`; no project code is loaded implicitly.

## Web

The production image starts `ai-harness-web` on port 3080 without opening a browser.

### With Make

From the repository root, build the image then start the container in the background:

```sh
make run-prod
```

The application is available at `http://127.0.0.1:3080`. The container is named `ai-harness-prod` and data persists in the `ai-harness-data` volume. Running `make run-prod` again rebuilds the image and replaces the existing container without deleting that volume.

To open Bash inside the running instance:

```sh
make shell-prod
```

The shell runs as the unprivileged user `aiharness`. Stop and remove the container with `docker stop ai-harness-prod`; the data volume is preserved.

Port and docker run options are customizable. For example, to use port 8080 and pass variables already exported in the host shell:

```sh
export OPENAI_API_KEY='...'
export AI_HARNESS_AUTH_TOKEN='...'
make run-prod PROD_PORT=8080 \
  PROD_DOCKER_ARGS='--env OPENAI_API_KEY --env AI_HARNESS_AUTH_TOKEN'
```

By default, the published port listens only on the loopback interface. For external access, use `PROD_BIND_ADDRESS=0.0.0.0` only with an authentication token and a trusted HTTPS reverse proxy or private network.

### With Docker directly

```sh
docker build -f .docker/Dockerfile.prod -t ai-harness:latest .
docker run --rm \
  -p 127.0.0.1:3080:3080 \
  -e OPENAI_API_KEY \
  -e AI_HARNESS_AUTH_TOKEN \
  -v ai-harness-data:/app/.ai-harness \
  ai-harness:latest
```

Then open `http://127.0.0.1:3080`. The image sets `AI_HARNESS_WEB_HOSTNAME=0.0.0.0` and `AI_HARNESS_WEB_NO_OPEN=1`; `AI_HARNESS_WEB_PORT` lets you change the internal port.
