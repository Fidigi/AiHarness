# AiHarness Project Map for AI Agents

This is the canonical navigation and validation guide for repository work. Read it before changing code. It explains where behavior lives, which contracts cross package boundaries, and how changes must be validated. It is not a replacement for reading the relevant implementation and colocated tests.

## 1. Working Rules

1. Read the nearest `AGENTS.md` and this file before editing.
2. Run `git status --short` first. The working tree may contain unrelated user changes; preserve them and never reset, overwrite, or reformat them accidentally.
3. Read the implementation, its tests, and the relevant documentation before making a change. Do not infer current behavior from filenames or the changelog alone.
4. Keep changes in the owning package. Move shared contracts and reusable behavior into `@ai-harness/core`; do not create reverse dependencies from `core` to an interface package.
5. Use npm workspaces. The root `package.json` defines the workspaces, and `package-lock.json` is the single workspace lockfile. Do not hand-edit lockfiles or generated output.
6. Do not edit `node_modules/`, `dist/`, coverage output, Playwright reports, or other generated files.
7. Tests and type checks are required to run in Docker in this repository. Use the `Makefile` workflow described in [Validation](#8-validation).
8. Never commit credentials, tokens, local session data, or `.env` files. Tests must use mocks or disposable values.
9. Keep this map current when package boundaries, entry points, persistence formats, documentation status, or validation commands change.

## 2. Platform at a Glance

AiHarness is a strict TypeScript, ESM, npm workspaces monorepo with four packages:

```text
                                      ┌──────────────────────┐
                                      │ @ai-harness/core     │
                                      │ types, providers,    │
                                      │ sessions, extensions │
                                      └──────────▲───────────┘
                                                 │
                         ┌───────────────────────┼───────────────────────┐
                         │                       │                       │
                 ┌───────┴────────┐      ┌───────┴────────┐      ┌───────┴────────┐
                 │ CLI            │      │ Express server │      │ React Web      │
                 │ ai-harness     │      │ API + launcher │◄─────│ browser client │
                 └────────────────┘      └────────────────┘ HTTP └────────────────┘
```

Dependency direction:

- `@ai-harness/cli` -> `@ai-harness/core`
- `@ai-harness/server` -> `@ai-harness/core`
- `@ai-harness/web` -> `@ai-harness/core` for shared types, and -> server at runtime over HTTP/SSE/WebSocket
- `core` must remain independent of CLI, server, React, and browser concerns

Primary runtime entry points:

| Runtime | Source entry point | Built command/output |
|---|---|---|
| Interactive CLI and JSONL RPC | `packages/cli/src/index.ts` | `ai-harness`, `packages/cli/dist/index.js` |
| API server | `packages/server/src/index.ts` | `packages/server/dist/index.js` |
| Combined production Web launcher | `packages/server/src/web-cli.ts` | `ai-harness-web`, `packages/server/dist/web-cli.js` |
| React application | `packages/web/src/index.tsx` | `packages/web/dist/` |

Development ports differ from the combined launcher:

- Vite Web development server: `3080`
- Express development server: `3099`
- Vite proxies `/api` and WebSocket upgrades to `127.0.0.1:3099`
- `ai-harness-web` serves the API and built Web assets together on `127.0.0.1:3080` by default

## 3. Repository Navigation

### Root

| Path | Purpose |
|---|---|
| `package.json` | Workspace scripts and shared development dependencies |
| `package-lock.json` | Authoritative npm workspace dependency lockfile |
| `tsconfig.json` | Strict shared TypeScript options; source uses ESM |
| `vitest.config.ts` | Canonical root unit-test discovery and source aliases |
| `playwright.config.ts` | Browser test configuration; starts Vite only |
| `Makefile` | Authoritative Docker build and validation workflow |
| `.docker/` | Test, production, and lockfile Dockerfiles |
| `e2e/*.spec.ts`, `e2e/fixtures/` | Playwright Web UI journeys split by feature, with reusable intercepted API fixtures |
| `docs/` | User, architecture, extension, container, and agent documentation |

Use npm from the repository root so workspace packages are linked consistently. Treat `package-lock.json` as authoritative for dependency changes.

### `packages/core`: shared domain and infrastructure

Start at `packages/core/src/index.ts`, which defines the public package exports.

| Area | Files | Responsibility |
|---|---|---|
| Shared contracts | `src/types/index.ts` | `Message`, `Session`, `ProviderConfig`, `ProviderType`, tool calls, app/terminal/Web configuration |
| Provider abstraction | `src/providers/index.ts` | `AiProvider`, `ProviderFactory`, built-in providers, streaming, retries, tool-call normalization |
| Session persistence | `src/sessions/session-manager.ts` | `SessionManager`, `JsonlSessionStore`, branches, cloning, summaries, effective context |
| Compaction | `src/sessions/compaction.ts` | Token estimation, compaction target selection, summary prompts |
| Extension API | `src/extensions/extension-registry.ts` | Commands, tools, providers, text UI panels, lifecycle events, cancellable/transforming hooks |
| Utilities | `src/utils/index.ts`, `src/utils/event-emitter.ts` | IDs, formatting, retry helpers, typed event infrastructure |

Provider implementations currently include OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex Gemini, AWS Bedrock, local OpenAI-compatible servers, and mock. Public additions must be re-exported from `src/index.ts`.

Session files are JSONL. Entry types are `metadata`, `message`, `compaction`, and `branch_summary`. Runtime timestamps are `Date` objects; persisted timestamps are Unix milliseconds. Preserve backward compatibility when changing this format, and update loading, saving, appending, exports/imports, API serialization, and tests together.

### `packages/cli`: terminal product and automation

| Area | Files | Responsibility |
|---|---|---|
| Composition root | `src/index.ts` | Startup, argument modes, session loading, resources, trust, extensions, input dispatch, hooks, streaming, shutdown |
| Command router | `src/commands/handler.ts` | Built-in slash commands, provider initialization, model/session operations, import/export/share/login |
| Agent tool loop | `src/agent/tool-loop.ts` | Provider turns, model-requested tools, persisted tool calls/results, loop limit, cancellation |
| Regular TUI | `src/tui/terminal-ui.ts` | Readline-oriented output, help, transcript, streaming writer |
| Fullscreen TUI | `src/tui/fullscreen-ui.ts`, `src/tui/fullscreen-input.ts` | Alternate-screen rendering, input/history/completion, scrolling, extension panels |
| Mode and themes | `src/tui/mode.ts`, `src/tui/theme-manager.ts` | Terminal mode selection and built-in/custom themes |
| Extensions | `src/extensions/extension-loader.ts` | JavaScript extension discovery, dynamic import, reload |
| Skills/prompts | `src/resources/resource-manager.ts` | Markdown front matter, discovery, prompt expansion, model-invocable skills |
| Trust and OAuth | `src/security/` | Project trust file and provider OAuth device flow |
| Headless RPC | `src/rpc/rpc-server.ts` | JSONL stdin/stdout protocol and RPC provider/session setup |
| Integration helpers | `src/utils/` | Keybindings, exports, clipboard, external editor |

The CLI has regular, fullscreen, and RPC paths. A change to shared conversation behavior may need coverage in more than one path. Built-in command metadata lives in `commands/handler.ts`, while user-visible help also exists in both TUI implementations.

Project extensions are executable code. User extensions are loaded from `~/.ai-harness/extensions`; project extensions under `.ai-harness/extensions` require project trust. The server and Web application do not load CLI extensions.

### `packages/server`: API, transport, persistence, and Web launcher

| Area | Files | Responsibility |
|---|---|---|
| Server composition | `src/index.ts` | Express app, middleware, auth, session routes, sharing, static Web assets, lifecycle |
| Provider proxy | `src/api/proxy.ts` | Environment-based provider setup, dynamic credentials, chat/compaction handlers, SSE encoding |
| WebSocket transport | `src/api/websocket.ts` | Upgrade authentication, minimal RFC 6455 framing, SSE-compatible event payloads |
| Credential storage | `src/security/credential-store.ts` | Optional encrypted credential persistence |
| Production launcher | `src/web-cli.ts`, `src/web-cli-options.ts` | `ai-harness-web` flags, environment precedence, static bundle location, browser opening |

Main HTTP surfaces:

- Public: `GET /health`, temporary `GET /share/:token`
- Chat: `POST /api/chat`, `/api/chat/stream`, `/api/chat/compact`
- WebSocket: upgrade at `/api/chat/ws`
- Providers: `GET /api/providers`, `POST /api/config`
- Sessions: list/create/get/update/delete, append message, fork, clone, tree, and share under `/api/sessions`

All `/api` HTTP routes use optional Bearer authentication. Credential mutation can require a separate admin token. WebSocket authentication is handled independently during upgrade. Express route declaration order matters: fixed paths such as `/tree` must be registered before conflicting `/:id` routes.

The server has adapter/proxy code in addition to the provider implementations in `core`. Provider changes often need updates in both places.

### `packages/web`: React browser client

| Area | Files | Responsibility |
|---|---|---|
| App/router | `src/App.tsx`, `src/index.tsx` | Session/provider hydration and routes for chat/settings |
| Session/provider state | `src/store/session-store.ts` | Zustand store, remote hydration, optimistic message state, provider selection |
| API client | `src/services/api.ts` | Authenticated fetch, session/provider endpoints, SSE parser, WebSocket transport |
| Chat | `src/components/ChatView.tsx` | Input, streaming updates, persistence, client-side mock/demo behavior |
| Navigation | `src/components/Sidebar.tsx` | Session creation and selection |
| Settings | `src/components/SettingsView.tsx` | Provider credentials, auth token, transport, theme |
| Internationalization | `src/hooks/useI18n.tsx`, `src/i18n/`, `src/components/LanguageSelector.tsx` | Browser locale detection, English fallback, registered language packages, persisted locale selection |
| Styling | `src/index.css` | Global layout, themes, responsive behavior |
| Tooling | `vite.config.ts`, `vitest.config.ts` | Source aliases, development proxy, package test settings |

The server is the source of truth for persisted Web sessions. The chat streaming endpoint does not automatically attach messages to a session; `ChatView` explicitly persists user and assistant messages through the session API. Keep optimistic state and server persistence consistent.

The Web mock response is simulated in `ChatView`; it is not the server proxy's mock provider. Playwright tests also intercept API requests, so they validate browser behavior but not a live Express-to-provider integration.

## 4. Important Runtime Flows

### CLI conversation

```text
CLI input
  -> resource expansion or CommandHandler
  -> before:agent extension hook
  -> SessionManager.addMessage(user)
  -> runToolLoop
       -> before:provider hook
       -> AiProvider.streamChat
       -> optional tool calls -> before:tool hook -> extension tool
       -> persist tool call/result and continue provider turns
  -> persist final assistant message
  -> lifecycle events and TUI updates
```

Cancellation must propagate through `AbortSignal` to provider and active tool work. Do not add a provider call path that bypasses hooks, persistence, or cancellation without an explicit reason.

### Web conversation

```text
React ChatView
  -> Zustand optimistic state
  -> POST session user message
  -> API client SSE or WebSocket stream
  -> Express auth/transport
  -> AiProxyServer/provider adapter
  -> incremental Zustand assistant update
  -> POST final assistant message
```

SSE event names used by the browser are primarily `message_start`, `text_delta`, `message_end`, and `error`. If an event contract changes, update the server SSE writer, WebSocket forwarding, browser parser, tests, and documentation together.

### Session persistence

Both CLI and server default to `~/.ai-harness/sessions/<session-id>.jsonl`, so they can share conversations when running as the same OS user. `--no-session` disables CLI persistence. RPC can override the directory with `AI_HARNESS_SESSIONS_DIR`.

Use `SessionManager` for domain operations and `JsonlSessionStore` for storage behavior. Avoid direct mutation of manager internals. Every write is asynchronous and should be awaited before reporting success.

## 5. Cross-Package Change Guides

### Add or change a provider

Review all of the following, not only the core implementation:

1. `core/src/types/index.ts`: provider type/config contract.
2. `core/src/providers/index.ts`: implementation, validation, model defaults, factory registration, streaming/tool behavior.
3. `core/src/index.ts`: public exports.
4. `cli/src/commands/handler.ts`: environment initialization and provider/model commands.
5. `cli/src/rpc/rpc-server.ts`: headless provider initialization if supported there.
6. `server/src/api/proxy.ts`: server initialization, adapters, configuration endpoint, provider listing.
7. `web/src/store/session-store.ts` and `components/SettingsView.tsx`: defaults and settings UI.
8. Provider, CLI, server, store, and API tests; user-facing provider documentation.

Do not assume every surface supports every provider automatically. CLI and server configuration paths are separate.

### Change messages, sessions, or JSONL entries

Update the shared type, JSONL reader/writer/append methods, `SessionManager`, CLI import/export, server serializers and routes, Web API/store hydration, and all fixtures. Explicitly test old persisted data when compatibility matters. Remember that JSON transports dates as strings while core uses `Date`.

### Add or change a CLI command

Update the command registry and tests in `commands/handler.*`, then check dispatch/completion in `cli/src/index.ts` and help in both `terminal-ui.ts` and `fullscreen-ui.ts`. Document user-visible commands in `docs/user-guide.md`.

### Add or change an HTTP or streaming contract

Update `server/src/index.ts` or `server/src/api/proxy.ts`, the matching `web/src/services/api.ts` function, consuming store/component code, server tests, browser API tests, and documentation. Verify HTTP status, auth behavior, malformed input, transport framing, and serialization. Add live server integration coverage when Playwright's mocked API cannot prove the behavior.

### Change extensions, skills, or prompts

The shared extension contract belongs in `core/src/extensions`; CLI discovery and trust belong in `cli/src/extensions`, `resources`, and `security`. Preserve unload cleanup and ownership semantics. Project code must remain blocked until trusted. Update `docs/extensions.md` or the resource sections of `docs/user-guide.md`.

### Change startup, packaging, or static assets

Check root scripts, package scripts, both `copy-assets.mjs` files, `web-cli.ts`, production Docker stages, executable permissions, and the relative location of `packages/web/dist`. Validate with a production image, not only TypeScript tests.

## 6. Coding and Contract Conventions

- TypeScript is strict and enables unused-symbol and implicit-return checks.
- Source is ESM (`"type": "module"`). Relative TypeScript imports use `.js` specifiers so emitted JavaScript resolves correctly.
- Use `import type` for type-only dependencies when practical.
- Keep public core APIs exported through `packages/core/src/index.ts`.
- Prefer shared typed contracts over duplicated ad hoc shapes, but do not expose server- or React-specific concerns from `core`.
- Keep tests next to source as `*.test.ts` or `*.test.tsx`. The root Vitest config is the canonical all-package test configuration.
- Mock network calls in unit tests. Provider tests must not depend on real credentials or external services.
- Preserve streaming semantics: chunks are incremental, final content is assembled once, and errors must terminate cleanly without double completion.
- Treat session IDs and request input as untrusted at HTTP, RPC, import, and extension boundaries.
- Escape content rendered into standalone HTML or share pages. React-rendered text should remain text unless it has been deliberately sanitized.
- Never expose provider credentials in API responses, logs, session files, browser local storage, or error text.
- `AI_HARNESS_AUTH_TOKEN` protects API access; `AI_HARNESS_ADMIN_TOKEN` can separately protect credential changes; `AI_HARNESS_MASTER_KEY` enables encrypted credential persistence.
- Bind to loopback by default. A non-loopback deployment must use authentication and a trusted HTTPS reverse proxy or private network.

Formatting is defined by `.editorconfig` and `.prettierrc.json`. Avoid broad formatting passes during focused work, especially in a dirty working tree.

## 7. Documentation Status and Authority

| Document | Language | Status and intended use |
|---|---|---|
| `docs/ai/project-map.md` | English | Canonical repository navigation, subsystem ownership, and validation workflow for agents |
| `README.md` | English with some French links/text | High-level product overview and common startup commands; verify detailed behavior in code |
| `docs/architecture.md` | French | Concise architecture overview; useful orientation, not an exhaustive contract |
| `docs/user-guide.md` | French | Main end-user guide for installation, providers, CLI, Web, files, and security |
| `docs/extensions.md` | French | CLI extension authoring and lifecycle guide |
| `docs/i18n.md` | French | Web translation architecture, message conventions, and language-package contribution guide |
| `docs/containerization.md` | French | Container runtime guidance |
| `CHANGELOG.md` | English | Historical scaffold; its “Planned” list is stale and includes features already implemented, so it is not a roadmap or source of current behavior |

Authority for behavior, from strongest to weakest:

1. Executable code and tests.
2. Package/root configuration and Dockerfiles.
3. This map for navigation and required workflow.
4. Feature documentation and README examples.
5. Changelog planning notes.

When code and user documentation disagree, verify the behavior with tests, fix the relevant documentation in the same change when appropriate, and do not silently encode the discrepancy here.

## 8. Validation

### Required environment

The `Makefile` explicitly requires tests and type checks to run in Docker. Do not run `npm test`, Vitest, Playwright, or TypeScript validation directly on the host. Preferred commands:

```bash
make typecheck       # Build the test image and run workspace TypeScript checks
make test            # Build the test image and run all root Vitest tests
make test-e2e        # Build the test image and run Playwright with Chromium
make test-coverage   # Optional full coverage run
make build-prod      # Build the complete production image
```

Use `make lockfile` after an intentional dependency or package metadata change; it regenerates `package-lock.json` in Docker.

For a focused test during iteration, use `make shell` and run the relevant npm/Vitest command inside that container. The final validation should still use the standard targets below.

### Validation matrix

| Changed area | Minimum validation |
|---|---|
| Documentation only | Check links/commands against source; run `git diff --check` |
| Core types/providers/sessions/extensions | `make typecheck` and `make test` |
| CLI behavior/TUI/RPC/resources/security | `make typecheck` and `make test` |
| Server/API/auth/credentials/WebSocket | `make typecheck` and `make test` |
| React components/store/API client/CSS | `make typecheck`, `make test`, and `make test-e2e` |
| Cross-package streaming or session flow | `make typecheck`, `make test`, and `make test-e2e` |
| Launcher, build scripts, dependencies, Docker, static asset serving | Relevant tests plus `make build-prod` |

Playwright starts only the Vite development server and mocks API requests through `e2e/fixtures/mock-api.ts`. Passing E2E tests does not validate Express routes, authentication, credential storage, JSONL persistence, or real provider streaming. Use/add server integration tests for those behaviors.

### Before finishing

1. Review `git diff -- <files-you-changed>` and `git diff --check`.
2. Confirm no unrelated user changes or generated files were modified.
3. Run the validation required by the matrix, or state clearly which commands could not run and why.
4. Summarize changed files, behavioral impact, and validation results.
