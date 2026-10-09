# Static demonstration

The separate `demo/` application is an offline-capable, synthetic demonstration of AiHarness. It needs no account, provider key, inference service or application server. Its interface is English.

[IMPORTANT] Do not enter private information. Replies, model names, sessions, files, Git changes and terminal output are authored examples, not real inference or host operations. This is not a public deployment of the production agent.

## Try the example

- Choose either example conversation or create a temporary one. Select a mock model, enter a prompt and submit; **Stop** cancels the delayed replay.
- Enable or disable the simulated read/bash tools. Previewing an edit changes the bundled example file; Files, Git and Terminal show the same temporary change.
- Explore the bundled source, Markdown and image previews. The terminal accepts only its listed example commands; arbitrary paths, shell operators and processes are refused.
- Switch Light/Dark appearance. **Reset** asks before discarding temporary work. Reload also resets conversations, prompts and edits.

Nothing you type invokes an LLM, a real tool, Git, MCP, a terminal process or your filesystem. No prompt/session persistence or external analytics is added. The reused locale helper may read an existing non-secret language preference.

## Build and preview

From the repository root, with Docker available:

```bash
bash demo/run-docker.sh
# Optional nested static-host base; both slashes are required.
DEMO_BASE=/preview/AiHarness/ bash demo/run-docker.sh
```

The helper runs isolated tests, typechecks, artifact checks and Chromium journeys, then exports the validated `demo/dist/` without merging old assets. A failed validation does not publish a replacement; required export failures fail the command. Upload only the contents of that generated directory to its configured static base. No Node or AiHarness server is needed at the public host.

For a local preview of the generated artifact:

```bash
docker run --rm -p 127.0.0.1:4173:4173 \
  -e DEMO_HOST=0.0.0.0 -v "$PWD/demo:/app/demo:ro" \
  -w /app node:26-bookworm-slim node demo/scripts/serve.mjs
```

Open `http://127.0.0.1:4173/AiHarness/` for the default build. Hash routes work below the selected base. Unknown paths and API endpoints are not agent requests and return 404.

## Offline and deployment limitations

After **Offline ready**, the service worker can serve the public assets and lazy views offline. Initial installation requires a successful online load on HTTPS or localhost and browser support. It caches assets, not your prompts or sessions; reload still resets temporary work.

The dedicated Pages workflow validates pull requests without deployment authority. Only a successful main-branch push or explicit main-branch deployment dispatch can deploy the reviewed artifact. The repository owner must configure GitHub Pages for GitHub Actions and any environment approvals. No local validation enables Pages, changes settings or deploys remotely; a GitHub-hosted deployment is not claimed by the local tests.

The artifact is bounded and checked for representative secret shapes, but scanning is not proof that every arbitrary secret can be detected. Authored synthetic data and the absence of credential inputs, backend imports and host execution are the primary boundary. Generated-directory publication assumes a trusted checkout without concurrent mutation; it is not a hostile-host filesystem sandbox.

See the [implementation, validation and maintenance reference](../../ai/topics/static-demo.md) and the [production user guide](./user-guide.md).
