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
| `playwright.config.ts` | Browser test configuration; starts Vite and a disposable Express server |
| `Makefile` | Authoritative Docker build and validation workflow; E2E artifacts and Docker-generated baselines are copied out of the completed container |
| `.docker/` | Test, production, and lockfile Dockerfiles |
| `e2e/*.spec.ts`, `e2e/fixtures/`, `e2e/*-snapshots/` | Playwright journeys with reusable intercepted API fixtures, a real-server smoke path and Docker-generated visual baselines |
| `docs/` | User, architecture, extension, container, and agent documentation |

Use npm from the repository root so workspace packages are linked consistently. Treat `package-lock.json` as authoritative for dependency changes.

### `packages/core`: shared domain and infrastructure

Start at `packages/core/src/index.ts`, which defines the public package exports.

| Area | Files | Responsibility |
|---|---|---|
| Shared contracts | `src/types/index.ts` | `Message`, `Session`, provider/model metadata and pricing, OAuth/custom providers, tools, skill registry, plugins/sub-agents, extension interactions and run snapshots |
| Provider abstraction | `src/providers/index.ts` | `AiProvider`, factory/built-ins, streaming/reasoning, retries, discovery and usage/cache normalization |
| Session persistence | `src/sessions/session-manager.ts`, `src/sessions/serialization.ts` | `SessionManager`, v2 JSONL/wire format, commands, branches, cloning, summaries, per-session setting overrides, effective context and secret redaction |
| Compaction | `src/sessions/compaction.ts`, `src/sessions/session-manager.ts` | Token estimation, target selection, summary prompts, inherited automatic policy, metrics and cancellation-safe application |
| Detached agent | `src/agent/runtime.ts`, `src/agent/tool-loop.ts`, `src/agent/events.ts` | Shared model/tool loop, runs, stop/retry/queues, full bounded tool outputs, extension interactions and sequenced journal |
| Workspace security | `src/security/` | Canonical allowed roots, symlink boundary, trust persistence, Git/worktree operations |
| Extension API/loader | `src/extensions/{extension-registry,module-loader}.ts` | Owned commands/tools/providers/plain-text UI, hooks/listeners, bounded symlink-free discovery and atomic managed generations |
| Utilities | `src/utils/index.ts`, `src/utils/event-emitter.ts` | IDs, formatting, retry helpers, typed event infrastructure |

Provider implementations currently include OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex Gemini, AWS Bedrock, local OpenAI-compatible servers, and mock. OpenAI/Anthropic/Gemini expose bounded model discovery where their APIs permit it; reasoning deltas and input/output/cache usage are normalized. Server's `src/runtime/model-catalog.ts` owns the versioned published capabilities, context/output limits, compatibility and cache-aware prices. Public Core additions must be re-exported from `src/index.ts`.

Session files are versioned JSONL (current schema: v2). Entry types include `metadata`, `message`, `command`, `compaction`, and `branch_summary`; old unversioned message-only files remain readable. Runtime timestamps are `Date` objects, API dates are ISO strings, and persisted entry timestamps are Unix milliseconds. Rich message blocks, usage/cost, agent/workspace metadata and branch relationships must round-trip. Provider secrets must be redacted before API or disk serialization. Update loading, saving, appending, exports/imports, API hydration and compatibility tests together.

### `packages/cli`: terminal product and automation

| Area | Files | Responsibility |
|---|---|---|
| Composition root | `src/index.ts` | Startup, argument modes, session loading, resources, trust, extensions, input dispatch, hooks, streaming, shutdown |
| Command router | `src/commands/handler.ts` | Built-in slash commands, provider initialization, model/session operations, import/export/share/login |
| Agent tool loop | `src/agent/tool-loop.ts` | Backward-compatible re-export of Core `runToolLoop` and its types |
| Regular TUI | `src/tui/terminal-ui.ts` | Readline-oriented output, help, transcript, streaming writer |
| Fullscreen TUI | `src/tui/fullscreen-ui.ts`, `src/tui/fullscreen-input.ts` | Alternate-screen rendering, input/history/completion, scrolling, extension panels |
| Mode and themes | `src/tui/mode.ts`, `src/tui/theme-manager.ts` | Terminal mode selection and built-in/custom themes |
| Extensions | `src/extensions/extension-loader.ts` | JavaScript extension discovery, dynamic import, reload |
| Skills/prompts | `src/resources/resource-manager.ts` | Markdown front matter, discovery, prompt expansion, model-invocable skills |
| Trust and OAuth | `src/security/` | Project trust file and provider OAuth device flow |
| Headless RPC | `src/rpc/rpc-server.ts` | JSONL stdin/stdout protocol and RPC provider/session setup |
| Integration helpers | `src/utils/` | Keybindings, exports, clipboard, external editor |

The CLI has regular, fullscreen, and RPC paths. A change to shared conversation behavior may need coverage in more than one path. Built-in command metadata lives in `commands/handler.ts`, while user-visible help also exists in both TUI implementations.

Project extensions are executable code. User extensions are loaded from `~/.ai-harness/extensions`; project extensions under `.ai-harness/extensions` require project trust. CLI discovery/orchestration remains in `cli/src/extensions`, while the bounded `ExtensionModuleLoader` implementation is shared from Core. The server also uses it only during explicit startup/reload to atomically host enabled standalone/package extensions and their declarative Web surfaces; catalogue GETs and install operations never execute extension code.

### `packages/server`: API, transport, persistence, and Web launcher

| Area | Files | Responsibility |
|---|---|---|
| Server composition | `src/index.ts`, `src/runtime/services.ts` | Express app, shared runtime services, middleware, route mounting, sharing, static Web assets, lifecycle |
| Detached execution | `src/api/agent-routes.ts`, `src/runtime/command-runtime.ts` | Agent state/SSE/queues/stop, effective setting overrides, exact preset capabilities, shell command output/replay/cancel, manual and automatic compaction |
| Interactive terminals | `src/api/terminal-routes.ts`, `src/runtime/terminal-runtime.ts` | Owned `node-pty` processes, bounded ANSI replay by UTF-8 offset, input/resize/exit, instance limits and shutdown |
| Session windows | `src/api/session-pagination.ts`, `src/index.ts` | Metadata-only lists, bounded tail/before/around pages, stable message cursors, full server-side export, provider title generation and recursive cascade guard |
| Workspaces and files | `src/api/workspace-routes.ts`, `src/api/file-routes.ts`, `src/agent/workspace-tools.ts` | Trust, browse/Git/worktrees, bounded file tools, fuzzy index, collision-aware upload, source/media download, Git stats/diffs and file-watch SSE |
| Scoped configuration | `src/api/config-routes.ts`, `src/config/{config-store,effective-configuration}.ts` | Validated nullable global/project/session values, runtime/environment precedence, provenance and atomic non-secret storage |
| Providers/models | `src/api/{model,provider-registry}-routes.ts`, `src/runtime/{model-catalog,provider-registry,provider-oauth}.ts` | Published/discovered/custom models, custom dialect providers, OAuth Device Flow, capabilities/prices, activation and encrypted-or-volatile secrets |
| Tools | `src/api/tool-routes.ts`, `src/agent/workspace-tools.ts`, `src/runtime/services.ts` | Effective registry inventory, scoped presets/enabled tools, model capability filtering and Windows-only opt-in PowerShell |
| Plugin packages | `src/api/plugin-routes.ts`, `src/runtime/plugin-service.ts`, `src/runtime/services.ts` | Explicit npm/Git/path administration, bounded metadata inventory, trust/scopes, transactional updates/checks and executable generation reload |
| Skills | `src/api/skill-routes.ts`, `src/runtime/{skill-catalog,skill-registry}.ts` | Metadata-only discovery/invocation plus HTTPS/SHA-256 registry installs and updates by trusted global/project scope |
| Web Push | `src/api/push-routes.ts`, `src/runtime/push-service.ts` | VAPID lifecycle, public-endpoint validation, encrypted-or-volatile subscriptions, categories and stale cleanup |
| Child agents | `src/api/subagent-routes.ts`, `src/runtime/{subagent-service,subagent-runtime}.ts`, `src/runtime/services.ts` | Atomic global/project profiles, `spawn_subagent`, bounded linked child sessions, concurrency/depth, lifecycle and parent journal events |
| Release status | `src/runtime/app-update.ts` | Bounded Web/agent versions, timed and cached release lookup, safe diagnostics without automatic installation |
| Request security | `src/security/request-security.ts` | Cookie/Bearer roles and capabilities, Origin checks, rate limits, safe errors, WebSocket auth context |
| Provider proxy/usage | `src/api/proxy.ts` | Built-in/custom provider setup, credentials, persistent cache-aware usage/cost, legacy chat/compaction and SSE |
| WebSocket transport | `src/api/websocket.ts` | Upgrade authentication, minimal RFC 6455 framing, legacy chat event payloads |
| Credential storage | `src/security/credential-store.ts` | Optional encrypted credential persistence |
| Production launcher | `src/web-cli.ts`, `src/web-cli-options.ts` | `ai-harness-web` flags, environment precedence, static bundle location, browser opening |

Main HTTP surfaces:

- Public/auth: `GET /health`, temporary `GET /share/:token`, `/api/auth/status|login|logout`
- Application release status: authenticated `GET /api/app-update`, optionally refreshed without automatic installation
- Detached agent: `/api/agent/runs`, run queues/stop, session state/events/capabilities/compaction, commands/events
- Workspaces: `/api/workspaces/default|validate|browse|trust|worktrees`
- Files/Git: `/api/files`, content/download/index/upload/watch and `git/status|diff`
- Terminals: `/api/terminals`, per-terminal events/input/resize/delete
- Configuration: scoped/effective nullable values under `/api/configuration`; legacy built-in credentials remain under `/api/config`
- Models: grouped published/discovered/custom catalogue and refresh under `/api/models`; qualified global/project activation under `/api/models/enabled`
- Provider registry: auth status/OAuth flows, tests, custom provider/model CRUD and imports under `/api/provider-registry`
- Tools: effective inventory and scoped preset/enabled-tool mutations under `/api/tools`; project IDs require their canonical cwd
- Plugins: metadata-only scoped catalogue plus explicit install/enable/disable/remove/update/check and atomic session-aware executable reload under `/api/plugins`
- Skills: trust-aware catalogue/activation and HTTPS registry search/install/update under `/api/skills`
- Push: public VAPID key plus authenticated status/subscribe/unsubscribe under `/api/push`
- Child agents: scoped settings/profile CRUD and run list/start/get/stop/acknowledge under `/api/subagents`
- Sessions: list/search/create/get/update/delete, model-assisted `auto-name`, recursive cascade confirmation, paged messages, info/export, append, fork, clone, tree and share
- Legacy chat: `POST /api/chat`, `/api/chat/stream`, `/api/chat/compact`; WebSocket upgrade at `/api/chat/ws`

All protected `/api` routes accept optional Bearer authentication or an opaque HttpOnly Web-session cookie when auth is configured. User/admin roles map to explicit capabilities; credential and dangerous workspace mutations require admin. Origin checks cover mutations and WebSocket upgrades. Express route declaration order matters: fixed paths such as `/tree` and `/search` must be registered before conflicting `/:id` routes.

The server has adapter/proxy code in addition to the provider implementations in `core`. Provider changes often need updates in both places.

### `packages/web`: React browser client

| Area | Files | Responsibility |
|---|---|---|
| App/router/auth | `src/App.tsx`, `src/index.tsx`, `src/components/LoginView.tsx` | Auth bootstrap, workspace/session/provider/model/skill hydration, deep-link restoration, detached-run polling, chat/settings routes and lazy Settings/terminal boundaries |
| Session/provider state | `src/store/session-store.ts` | Date hydration, indexed windows, bounded v1→v2 workspace cache, drafts/attachments, sequenced workspace model/skill catalogues, provider/model selection, summaries, runs and per-session settings |
| Preferences | `src/store/preferences.ts` | Validated v3 themes/layout/reasoning/volume and separate sound/local/Push categories, selection/panels/keybindings, v1/v2 migration and cross-tab updates |
| API client | `src/services/api.ts`, `src/services/push.ts` | Cookie/Bearer fetch and SSE plus sessions/workspaces/files/Git, provider registry/OAuth, tools, skill registry, plugins, Push and child agents |
| Chat | `src/components/{ChatView,MarkdownContent,MarkdownContentRenderer,SubagentPanel}.tsx`, `src/agent.css` | Reconnection/history, rich rendering, Process/Response and full output, dynamic resource palette, declarative extension widgets/interactions, drafts/images/queues, settings/compaction/branches and child agents |
| Navigation | `src/components/Sidebar.tsx` | Workspace/trust/worktrees, sequenced directory browsing, session search/create/inline rename/model auto-name/cascade-safe delete and run indicators |
| Workspace panel | `src/components/WorkspacePanel.tsx`, `src/workspace-panel.css` | Lazy Git-annotated tree, grouped changes/stats, watched/resizable source/media/Markdown/diff viewer, abortable workspace refresh, cancellable XHR upload with collision strategy and file mentions |
| Terminal | `src/components/TerminalPanel.tsx`, `src/terminal.css` | Dynamically imported multi-tab xterm UI with keyed workspace boundary, per-workspace tab restoration, input/clipboard/resize and offset reconnection |
| Global keyboard/accessibility | `src/components/{CommandPalette,StatusCenter,SubagentMonitor}.tsx`, `src/services/{keyboard,notices}.ts`, `src/hooks/useFocusTrap.ts` | Focus-trapped palettes/dialogs/extensions, bounded status and child notices, robust focus restoration and portable shortcuts |
| Settings | `src/components/{SettingsView,EcosystemSettings,PluginSettings,SubagentSettings}.tsx` | Provider lifecycle/custom resources, defaults/tools, model/skill registry, plugins, child profiles, auth, appearance, Push preferences, versions and shortcuts |
| PWA shell | `src/components/PwaStatus.tsx`, `src/services/push.ts`, `public/{manifest.webmanifest,sw.js,offline.html}` | Install/update/offline shell plus explicit Web Push subscription, visible-client deduplication and notification routing |
| Internationalization | `src/hooks/useI18n.tsx`, `src/i18n/`, `src/components/LanguageSelector.tsx` | Browser locale detection, English fallback, registered language packages, persisted locale selection |
| Styling | `src/{index,settings}.css`, `src/agent.css`, component CSS | Global/chat layout plus route-split Settings styles, themes and responsive behavior |
| Tooling | `vite.config.ts`, `vitest.config.ts`, `scripts/check-bundle-budget.mjs` | Source aliases, development proxy, package test settings, production chunks and failing bundle budgets |

The server is the source of truth for persisted Web sessions. A `draft:*` session stays browser-local until `POST /api/agent/runs`; the server persists the user message before detached execution starts and later persists model/tool turns. `ChatView` may hold a temporary streamed assistant message, but terminal events must resynchronize it with the canonical session without duplicates. The optional per-tab workspace cache is schema v2 with explicit v1 migration; it must remain bounded, favor draft text over binary previews, strip provider API keys and be discarded or reconciled whenever the server revision changes. PTY React state and stored IDs are keyed by workspace so a cwd switch unmounts the previous surfaces before restoring the target workspace. Scroll state uses a separate versioned, 24-entry/24-hour per-workspace `sessionStorage` map; capture it at scroll time (not from reused DOM during route cleanup), debounce writes, and rematerialize a missing virtual anchor through the paged `around` API before correcting its measured offset.

The Web uses the server's real mock provider; there is no client-side demo response path. Most Playwright tests intercept API requests and model the detached protocol, including OAuth/custom providers/models, tool settings, skill registry, plugin/reload, extension interactions, Web Push, profile CRUD and child runs. `e2e/live-server.spec.ts` traverses Vite → Express → mock provider → JSONL/reload and exercises real PTY/files/security. `web-server.test.ts` provides broader HTTP/provider/persistence/security and disposable Git/PTY/child-runtime coverage. Accessibility tests run axe plus focus/keyboard checks; performance tests protect bounds/cache/lazy loading. The 114 visual cases protect historical surfaces plus provider/model editors, registry, Process blocks and extension dialogs in Light/Dark desktop/tablet/mobile variants.

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

### Web detached conversation

```text
React ChatView + local draft
  -> GET /api/configuration/effective (value + provenance)
  -> POST /api/agent/runs (trusted canonical cwd + explicit settingOverrides)
  -> server creates/reuses session, applies or removes only declared overrides, and persists user message
  -> AgentRuntime continues independently of the HTTP request
       -> shared provider/tool loop with effective model/thinking/tool preset
       -> optional auto-compaction under the same AbortSignal
       -> incremental persistence + sequenced events
  -> browser GET state?messageLimit=80, then GET events?after=<last sequence>
  -> older/target windows through messages?before= or ?around=
  -> temporary assistant delta keyed by messageId
  -> canonical session resync on terminal/tool events
```

The current protocol uses dotted event names such as `run.started`, `message.delta`, `tool.completed`, `extension.ui`, `queue.updated`, `retry.scheduled`, and `compaction.completed`, plus `connection.ready` for SSE setup. Sequence IDs, snapshot reset semantics, partial-message/interaction restoration and no-duplicate replay are one contract. The underscore event names (`message_start`, `text_delta`, `message_end`) belong only to legacy `/api/chat*` and WebSocket chat compatibility. Update Core events, server writer, browser parser/store, fixtures, integration tests and documentation together.

### Child-agent delegation

```text
parent AgentRuntime tool loop -> spawn_subagent(profile, task, background)
  -> SubagentService resolves effective global/project profile
  -> concurrency + depth + trust checks
  -> bounded context copied into linked persisted child session
  -> child AgentRuntime with profile model/thinking/tool/skill/extension policy
  -> child journal phase/turn mapped to parent subagent.* events
  -> synchronous result returned to the tool, or background run polled by SubagentPanel
  -> completion/failure/stopped attention -> StatusCenter + open/stop/acknowledge APIs
```

Keep delegation on the shared `AgentRuntime`; a separate provider loop would bypass persistence, trust, hooks and cancellation. Context, history and run registries must remain bounded. A profile with empty allowlists inherits the parent policy; non-empty lists only reduce it. At maximum depth, `spawn_subagent` must be removed from the child tool set.

### Plugin package administration

```text
explicit POST install/update
  -> strict npm:/Git HTTPS/path parsing + workspace/scope trust
  -> npm without lifecycle scripts, or shallow Git clone, in staging
  -> bounded symlink-free manifest/convention inventory
  -> atomic package/state replacement and catalogue invalidation

GET /api/plugins
  -> workspace-isolated, metadata-only catalogue; never network or install

POST /api/plugins/reload [sessionId]
  -> resolve in-memory or persisted session and verify its workspace
  -> validate every active visible package into a candidate generation
  -> discover bounded extension files without symlinks
  -> import candidate and atomically replace executable commands/tools/providers/UI/hooks
  -> invalidate separately discovered resource catalogues; rollback the old generation on failure
```

Keep package administration explicit: a read must never install, update, contact npm/Git, or execute code. State and managed files must roll back together. Project resources stay hidden/inactive until trust, scans never follow symlinks, extension modules are capped at 5 MiB, and diagnostics exclude resource bodies, command output and credentials. On workspace change, a failed candidate clears handlers from the old cwd rather than leaking them.

### Extension interaction

```text
extension tool/hook -> context.requestInteraction(declarative request)
  -> AgentRuntime stores one pending request in the run snapshot
  -> extension.ui event + optional attention Push
  -> ChatView renders text/form controls without arbitrary HTML
  -> POST response/cancel with active session + request IDs
  -> AgentRuntime revalidates kind, field IDs/types/options and size
  -> suspended extension resumes, or receives cancellation
```

Only an active run may request interaction. Keep widget content plain text and custom dialogs schema-driven; never introduce extension-provided React, DOM, script, style or unsanitized HTML. Focus trapping, Escape, restoration and reconnection are part of the transport contract, not cosmetic behavior.

### Session persistence

Both CLI and server default to `~/.ai-harness/sessions/<session-id>.jsonl`, so they can share conversations when running as the same OS user. `--no-session` disables CLI persistence. RPC can override the directory with `AI_HARNESS_SESSIONS_DIR`.

Server state under `AI_HARNESS_DATA_DIR` includes atomic `config.json`, `providers.json`, `usage-metrics.json`, `plugins.json`, `subagents.json` and trust/session files. `credentials.enc`, `provider-secrets.enc` and `push.enc` exist only when `AI_HARNESS_MASTER_KEY` enables encrypted persistence; their corresponding secrets/subscriptions otherwise remain process-memory only. Never put secrets into the non-secret JSON stores, fixtures, API status objects or browser persistence.

Use `SessionManager` for domain operations, `JsonlSessionStore` for storage behavior, and `serializeSession`/`deserializeSession` at JSON boundaries. Avoid direct mutation of manager internals. Every write is asynchronous and should be awaited before reporting success. A clone is an independent root (`metadata.clonedFromSessionId`); a fork alone keeps `parentId`/branch lineage.

## 5. Cross-Package Change Guides

### Add or change a provider

Review all of the following, not only the core implementation:

1. `core/src/types/index.ts`: provider/config/model metadata, capabilities, compatibility and pricing contracts.
2. `core/src/providers/index.ts`: implementation, validation, discovery, defaults, factory, streaming/reasoning/tools and usage normalization.
3. `core/src/index.ts`: public exports.
4. `cli/src/commands/handler.ts` and `rpc/rpc-server.ts`: environment and headless support.
5. `server/src/api/proxy.ts`: built-ins/adapters, usage persistence and all non-agent provider call paths.
6. `server/src/runtime/{model-catalog,provider-registry,provider-oauth}.ts` plus matching routes: custom lifecycle, secrets, discovery and OAuth.
7. `web/src/store/session-store.ts`, `services/api.ts` and `components/{SettingsView,EcosystemSettings}.tsx`: catalogue/defaults/admin UI.
8. Provider/Core/server/Web tests, intercepted API fixtures, Settings/axe/visual journeys and user/architecture documentation.

Do not assume every surface supports every provider automatically. CLI and server configuration paths are separate. Never expose access tokens/API keys, recover secrets through a shell command, or treat a remote model catalogue as trusted unbounded input.

### Change messages, sessions, or JSONL entries

Update the shared type, JSONL reader/writer/append methods, `SessionManager`, CLI import/export, server serializers and routes, Web API/store hydration, and all fixtures. Explicitly test old persisted data when compatibility matters. Remember that JSON transports dates as strings while core uses `Date`.

### Add or change a CLI command

Update the command registry and tests in `commands/handler.*`, then check dispatch/completion in `cli/src/index.ts` and help in both `terminal-ui.ts` and `fullscreen-ui.ts`. Document user-visible commands in `docs/users/fr/user-guide.md`.

### Add or change an HTTP or streaming contract

Update `server/src/index.ts` or `server/src/api/proxy.ts`, the matching `web/src/services/api.ts` function, consuming store/component code, server tests, browser API tests, and documentation. Verify HTTP status, auth behavior, malformed input, transport framing, and serialization. Add live server integration coverage when Playwright's mocked API cannot prove the behavior.

### Change extensions, skills, prompts, or plugin packages

The shared extension contracts and bounded module loader belong in `core/src/extensions`; CLI orchestration belongs in `cli/src/extensions`, `resources`, and `security`. Server package/registry contracts live in Core types, while source validation, transactional installation, metadata inventory and runtime composition belong in server services. Browser UI must stay declarative/text-only: never move command execution, arbitrary HTML/DOM or filesystem paths there. Preserve managed ownership, unload cleanup, response validation and atomic rollback. Project code/resources remain blocked until trusted, reads stay side-effect free, and skill downloads require bounded HTTPS plus SHA-256. Update `docs/contributors/fr/extensions-cli.md` and `docs/contributors/fr/extensions-web.md`, or the resource/package sections of `docs/users/fr/user-guide.md`.

### Change startup, packaging, native dependencies, or static assets

Check root scripts, package scripts, both `copy-assets.mjs` files, `web-cli.ts`, production Docker stages, native build/runtime libraries, executable permissions, and the relative location of `packages/web/dist`. `node-pty` requires its install script plus Python/C++ build tooling in dependency stages and compatible runtime libraries in the production image. Validate with a production image, not only TypeScript tests.

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
- `AI_HARNESS_AUTH_TOKEN` protects API access; a distinct `AI_HARNESS_ADMIN_TOKEN` separates dangerous capabilities, but otherwise falls back to the auth token. Browser login creates an opaque HttpOnly cookie; `AI_HARNESS_MASTER_KEY` enables encrypted built-in/custom provider credentials and Push subscriptions.
- Resolve every file, command, Git and agent cwd through `WorkspaceManager`, then require `ProjectTrustManager` before execution. Never use a browser-supplied path directly.
- Bind to loopback by default. The server rejects a non-loopback bind without authentication unless the explicit insecure override is set; production still requires a trusted HTTPS reverse proxy or private network.

Formatting is defined by `.editorconfig` and `.prettierrc.json`. Avoid broad formatting passes during focused work, especially in a dirty working tree.
## 7. Documentation Status and Authority

| Surface | Language | Audience | Versioning | Status and intended use |
|---|---|---|---|---|
| `docs/ai/index.md`, `project-map.md`, `AGENTS.md` | English | Agents | Versioned | Navigation, repository authority, and maintenance rules |
| `docs/ai/topics/providers.md` | English | Agents | Versioned | Provider execution, catalogue, registry and OAuth |
| `docs/ai/topics/sessions.md` | English | Agents | Versioned | JSONL v2, serialization, compaction, pagination and branches |
| `docs/ai/topics/extensions.md` | English | Agents | Versioned | JavaScript extensions, packages, reload and declarative interactions |
| `docs/ai/topics/cli-reference.md` | English | Agents | Versioned | Regular/fullscreen CLI and JSONL RPC |
| `docs/ai/topics/server-api.md` | English | Agents | Versioned | REST, SSE, WebSocket and detached runtime contracts |
| `docs/ai/topics/web-app-architecture.md` | English | Agents | Versioned | React stores/components, browser persistence, PWA and validation |
| `docs/ai/topics/security.md` | English | Agents | Versioned | Workspace trust, auth, secrets and executable-code boundaries |
| `docs/ai/topics/child-agents.md` | English | Agents | Versioned | Profiles, delegation limits, linked sessions and parent events |
| `docs/ai/acceptance/`, `docs/ai/workflows/` | English | Agents | Versioned | Acceptance criteria and task-specific documentation workflows |
| `docs/audit/documentation/AUDIT-1` | English | Agents + humans | Versioned | Current documentation audit; plain path intentionally omits `.md` |
| `docs/users/{fr,en}/` | French/English | End users | Versioned | Complete user guides, container guidance and language indexes |
| `docs/contributors/{fr,en}/` | French/English | Contributors | Versioned | Parallel architecture, extension and i18n guides |
| `docs/screenshots/` | English/French | Humans | Versioned | Playwright-derived documented product states and capture inventory |
| `README.md`, `CHANGELOG.md` | English/French | Everyone | Versioned | Product overview and history; changelog planning notes are not a roadmap |

Load human-facing files only when the user explicitly requests their audit or maintenance. The current documentation audit is `DONE`; reopen it only when a criterion regresses or a recorded re-examination trigger occurs.

Authority for behavior, from strongest to weakest:

1. Executable code and tests.
2. Package/root configuration and Dockerfiles.
3. This map for navigation and required workflow.
4. Feature documentation and README examples.
5. Changelog planning notes.

When code and documentation disagree, verify the behavior against source/tests and fix the owning document; do not encode the discrepancy here as if it were intended behavior.

## 8. Validation

### Required environment

The `Makefile` explicitly requires tests and type checks to run in Docker. Do not run `npm test`, Vitest, Playwright, or TypeScript validation directly on the host. Preferred commands:

```bash
make lint-docs       # Validate local Markdown targets, anchors and versioning boundaries
make typecheck       # Build the test image and run workspace TypeScript checks
make test            # Build the test image and run all root Vitest tests
make test-e2e        # Build the test image and run Playwright with Chromium
make test-coverage   # Optional full coverage run
make build-prod      # Build the complete production image
```

Use `make lockfile` after an intentional dependency or package metadata change; it regenerates `package-lock.json` in Docker.

For a focused Playwright test during iteration, pass arguments through the Makefile, for example `make test-e2e E2E_ARGS='e2e/performance.spec.ts -g "virtualise" --retries=0'`. For focused Vitest work, use `make shell` and run the relevant npm command inside that container. Final validation should still use the standard targets below.

### Validation matrix

| Changed area | Minimum validation |
|---|---|
| Documentation only | Check claims/commands against source; run `make lint-docs` and `git diff --check` |
| Core types/providers/sessions/extensions | `make typecheck` and `make test` |
| CLI behavior/TUI/RPC/resources/security | `make typecheck` and `make test` |
| Server/API/auth/credentials/WebSocket | `make typecheck` and `make test` |
| React components/store/API client/CSS | `make typecheck`, `make test`, and `make test-e2e` |
| Cross-package streaming or session flow | `make typecheck`, `make test`, and `make test-e2e` |
| Launcher, build scripts, dependencies, Docker, static asset serving | Relevant tests plus `make build-prod` |

Playwright starts Vite and a disposable real Express server. Most scenarios still isolate the browser with `e2e/fixtures/mock-api.ts`; `e2e/live-server.spec.ts` is the deliberate browser-to-server smoke path. Visual changes use Docker-generated Light/Dark desktop/tablet/mobile baselines under `e2e/*-snapshots/` with a 2 % pixel-diff ceiling. After reviewing changed baselines, `make sync-doc-screenshots` refreshes the subset embedded in human documentation. `make test-e2e` tests the baselines embedded in its freshly built image, retains the container until completion, then copies the HTML report, test artifacts and snapshot directory back with `docker cp`, even after failure; this avoids stale bind mounts in nested Docker environments and lets `E2E_ARGS='e2e/visual.spec.ts --update-snapshots=all'` update the working tree. Keep focused server tests for exhaustive auth, malformed input, credential and persistence behavior. A production Web build also runs `packages/web/scripts/check-bundle-budget.mjs`; a size regression above its eager, async or CSS limits is a build failure.

### Before finishing

1. Review `git diff -- <files-you-changed>` and `git diff --check`.
2. Confirm no unrelated user changes or generated files were modified.
3. Run the validation required by the matrix, or state clearly which commands could not run and why.
4. Summarize changed files, behavioral impact, and validation results.
