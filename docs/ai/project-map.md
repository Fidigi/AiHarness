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
| Interactive, print, JSON event, and JSONL RPC CLI | `packages/cli/src/index.ts` | `ai-harness`, `packages/cli/dist/index.js` |
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
| `.docker/` | Test, production, and lockfile Dockerfiles; bounded E2E artifact helpers archive only screenshots added or byte-changed by that run so concurrent cleanup cannot restore stale baselines |
| `e2e/*.spec.ts`, `e2e/fixtures/`, `e2e/*-snapshots/` | Playwright journeys with reusable intercepted API fixtures, a real-server smoke path and Docker-generated visual baselines |
| `tests/functional-parity/` | Manifest-driven public CLI/JSON/RPC/session/extension/SDK goldens plus genuine outside-checkout Core/CLI pack/install/PATH-bin/worker probes; local archives, not public registry distribution |
| `docs/` | User, architecture, extension, container, and agent documentation |
| `demo/`, `.github/workflows/demo-pages.yml` | Separate synthetic React/Vite static demo, bounded offline assets, Docker validation/export and build-only PR/separately admitted Pages pipeline; no backend/host tools |

Use npm from the repository root so workspace packages are linked consistently. Treat `package-lock.json` as authoritative for dependency changes.

### `packages/core`: shared domain and infrastructure

Start at `packages/core/src/index.ts`, which defines the public package exports.

| Area | Files | Responsibility |
|---|---|---|
| Shared contracts | `src/{index,public-api-version}.ts`, `src/types/{index,resource-batches}.ts` | Versioned public entry point plus `Message`, `Session`, provider/model metadata and pricing, OAuth/custom providers, tools, skill registry, plugins/sub-agents, extension interactions and run snapshots |
| Provider abstraction | `src/providers/{index,provider-network,credentials,model-metadata}.ts`, `src/security/credential-store.ts` | `AiProvider`, factory/built-ins, bounded SSE/WebSocket streaming and cached continuation, proxy/deadline/retry policy, process-local credential lifecycle/redaction, encrypted persistence, discovery, usage/cache normalization and shared non-secret metadata |
| Specialized models | `src/providers/specialized-models.ts`, `src/types/codemode.ts` | Credential-private typed classifier/image SDK and guest bridges, live availability, bounded hooks/results and host-correlated nested progress/accounting |
| Model catalogue | `src/providers/model-catalog.ts` | Shared published/configured/discovered/custom assembly, bounded discovery, exact/fuzzy/full-ID-first lookup, ordered scopes and non-secret protocol descriptors |
| Session persistence | `src/sessions/session-manager.ts`, `src/sessions/serialization.ts` | `SessionManager`, bounded/private/locked v2 JSONL, atomic rewrites, commands, branches, cloning, summaries, per-session setting overrides, effective context and secret redaction |
| Session SDK | `src/sdk/{index,agent-session,types,session-store,resource-loader}.ts` | Explicit API-1 factory/facade, true memory/borrowed structural stores, fresh canonical trust, copied/redacted inputs/observers, existing runtime/history/resource methods, durable stop/wait and last-handle-owned cleanup; no implicit discovery/executable/MCP/auth loading |
| Compaction | `src/sessions/compaction.ts`, `src/sessions/session-manager.ts` | Token estimation, target selection, summary prompts, inherited automatic policy, metrics and cancellation-safe application |
| Detached agent | `src/agent/runtime.ts`, `src/agent/tool-loop.ts`, `src/agent/provider-turn.ts`, `src/agent/events.ts`, `src/agent/message-queue.ts`, `src/agent/interaction-handle.ts` | Shared model/tool loop, provider hooks/stream retry, bounded all/one-at-a-time steering and follow-up scheduling, runs, stop, full bounded tool outputs, extension interactions and sequenced journal |
| Coding tools, discovery and commands | `src/tools/` | Shared CLI/Web `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`; prompt-local `tool_search` with bounded BM25 ranking, deferred declarations and branch-persisted activation metadata; inactive-by-default QuickJS `codemode` in a disposable bounded worker with live authorized nested calls, script-only exposure and success-only branch store; browser-safe `!`/`!!` parsing; detached direct-shell runtime; bounded/backpressured process execution, filtered environments, tree cancellation, private output retention, exact edits, trust gates and common active-tool selection |
| Prompt inputs and instructions | `src/prompts/{prompt-input,instruction-context}.ts` | Canonical bounded `@path` UTF-8/image loading plus shared CLI/Web independently trusted agent-directory, trusted project-context and system-prompt discovery/composition; stable nonlinked files, aggregate limits and source precedence are enforced once in Core |
| Resources and themes | `src/resources/resource-manager.ts`, `src/themes/theme-manager.ts` | Trust-gated stable Markdown discovery, selectors/collisions/provenance and strict skills; rich custom themes plus bounded adaptive terminal palette probing and OSC/CSI response filtering |
| Agent settings | `src/config/agent-settings.ts` | Pre-trust-independent agent-directory resolution, bounded stable `settings.json` loading, schema diagnostics, legacy migration, trusted global/project merge, global-only fields, provenance, resources, provider network/credential commands and tool/model/thinking/compaction resolution |
| MCP configuration, OAuth, test and session host | `src/mcp/{config-inventory,config-import,import-shell,server-test,session-host,oauth,oauth-provider-factory,oauth-flow,oauth-fetch}.ts` | File-only JSON/JSONC parsing, strict diagnostics, persisted-trust project gate, redacted descriptors, bounded paste conversion/reparse and atomic local mutations; encrypted name/URL-isolated OAuth providers plus detached explicit loopback/paste flows and passive refresh; shared one-shot stdio/HTTP Test; and the persistent per-session host used by CLI, RPC and Web with fresh pre-prompt config/trust reads, direct-startup waits, lazy codemode/deferred discovery, deterministic tool names, read-only enforcement, invocation/result redaction, reconnect/idle/shutdown bounds and config-keyed runtime status |
| Plugin packages | `src/plugins/{plugin-service,package-command}.ts` | Shared CLI/Web immutable literal npm argv, exact-source fresh/explicit process trust, shell-free bounded runner, npm/Git/local source policy, staging, trust/scopes, per-resource filters, bounded group activation with per-entry outcomes, symlink-free inventory, checks/updates, rollback, locked owner-only atomic state and sanitized catalogues |
| Linked-directory consent | `src/security/linked-directory-{consent,store,types,helpers}.ts` | Explicit metadata and Linux descriptor-scoped read grants; never expands roots/trust or execution authority; see [linked directories](./topics/linked-directories.md) |
| Workspace security | `src/security/` | Canonical allowed roots, symlink boundary, 500-entry directory browsing, one-direct-child creation, bounded project-resource inventory and nested breadth scan, shared exact/inherited allow/refuse trust decisions, serialized fresh-folder trust-plus-write with exact rollback, and force-classified Git/worktree operations |
| Extension API/loader | `src/extensions/{extension-registry,module-loader,startup-options}.ts` | Versioned owned commands/tools/providers/plain-text UI, bounded boolean/string startup options/help/completion, hooks/listeners, symlink-free discovery and atomic fresh ESM/CommonJS entry generations |
| Host integration | `src/system/open-external.ts` | Shared shell-free macOS/Windows/Linux URL or directory opener with a bounded spawn and secret-free environment |
| Utilities | `src/utils/index.ts`, `src/utils/event-emitter.ts` | IDs, formatting, retry helpers, typed event infrastructure |

Provider implementations currently include OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex Gemini, AWS Bedrock, local OpenAI-compatible servers, and mock. OpenAI/Anthropic/Gemini expose bounded model discovery where their APIs permit it; reasoning deltas and input/output/cache usage are normalized. Core's `src/providers/model-metadata.ts` owns versioned non-secret published capabilities, context/output limits and cache-aware prices. `src/providers/model-catalog.ts` merges those with configured, bounded/deduplicated live and custom definitions, then supplies the full-ID-safe resolver, thinking suffixes, fuzzy filtering, glob scopes and RPC descriptors reused by CLI and Server. Public Core additions must be re-exported from `src/index.ts`.

Session files are versioned JSONL (current schema: v2). Entry types include `metadata`, `message`, `command`, `compaction`, and `branch_summary`; old unversioned message-only files remain readable. New messages track their active parent, command/message leaves advance together, clones remap internal IDs, and `SessionManager.getRawEntries()` retains persisted pre-compaction history for projections. Runtime timestamps are `Date` objects, API dates are ISO strings, and persisted entry timestamps are Unix milliseconds. Rich message blocks, usage/cost, agent/workspace metadata and branch relationships must round-trip. Provider secrets must be redacted before API or disk serialization. Update loading, saving, appending, exports/imports, API hydration and compatibility tests together.

### `packages/cli`: terminal product and automation

| Area | Files | Responsibility |
|---|---|---|
| Composition root | `src/index.ts` | Strict startup arguments, interactive/print/JSON/RPC modes, session loading, resources, trust, extensions, input dispatch, hooks, streaming, shutdown |
| Command router | `src/commands/handler.ts` | Built-in slash commands, provider initialization, model/session operations, import/export/share/login |
| Startup sessions | `src/sessions/startup-session.ts` | New/continue/resume/open/fork/exact-ID/name selection and storage-directory precedence |
| Agent execution adapters | `src/agent/{tool-loop,provider-turn}.ts` | Thin re-exports of Core execution primitives; startup registers Core's workspace coding tools for the current cwd |
| Regular TUI | `src/tui/terminal-ui.ts`, `src/tui/{status,status-prompt-refresh,terminal-text}.ts` | Readline output/help/transcript/streaming plus actual journal/context/resource status at guarded prompt boundaries, late-refresh exclusion and stateful control-safe grapheme/cell projection |
| Fullscreen TUI | `src/tui/fullscreen-ui.ts`, `src/tui/fullscreen-input.ts`, `src/tui/terminal-escape.ts` | Header/transcript/editor/footer with actual active/full-history usage and known/unknown cost, short-screen resize fallback, alternate-screen cleanup, concurrent steering/follow-up, lone-Escape/Alt+Enter, history/completion/scrolling and bounded extension panels |
| Mode and themes | `src/tui/{mode,theme-manager,theme-input-filter}.ts` | Terminal mode selection, Core-backed rich/adaptive themes, live replacement and filtered probe input for readline/fullscreen |
| Extensions | `src/extensions/extension-loader.ts` | JavaScript extension discovery, dynamic import, reload |
| Skills/prompts | `src/resources/resource-manager.ts` | Markdown front matter, discovery, prompt expansion, model-invocable skills |
| Provider runtime and security | `src/providers/provider-runtime.ts`, `src/security/` | Shared Core credentials/network composition, independent pre-trust store selection and bounded provider OAuth Device Flow |
| Direct shell | `src/cli/shell-controller.ts` | Trust-aware interactive `!`/`!!` adapter over Core's CLI/Web shell runtime, with regular/fullscreen streaming and abort |
| Package commands | `src/cli/package-command.ts` | Strict top-level lifecycle aliases/actions, global/project scopes, per-kind filters and JSON/text adapter over Core `PluginService` |
| Standalone credentials/export | `src/cli/{provider-auth-command,export-command}.ts`, matching tests, `src/security/oauth-device.ts`, `src/utils/session-export.ts` | Before-startup passive credential metadata, explicit encrypted device login/local logout with caller body abort/verbatim codes/monotonic deadline, selected no-follow trusted workspace export over existing Core/slash ownership |
| Models | `src/cli/model-list.ts`, `src/providers/configured-providers.ts` | Configured-provider listing, shared startup exact/fuzzy/scope resolution, settings defaults/scopes, ephemeral API-key override and mode-independent provider construction |
| Agent settings and resources | `src/index.ts`, `src/resources/resource-manager.ts` | Global/trusted-project settings integration, safe ordered skill/prompt discovery, startup precedence, `/settings`, and interactive reload |
| Headless JSON | `src/cli/json-output.ts` | Versioned session/lifecycle/retry/compaction JSONL encoding plus serialized backpressure-aware stdout isolation over the shared Core loop |
| Headless RPC | `src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.ts` | Strict LF-framed command/response/events, next-turn steering/follow-up, cached/scoped models, usage-aware raw session trees, bounded provider and shell streaming, expiring retained output, extension dialogs, and deprecated method/params compatibility |
| Integration helpers | `src/utils/` | Keybindings, exports, clipboard, external editor |

The CLI has regular, fullscreen, print, one-shot JSON event, and RPC paths. A change to shared conversation behavior may need coverage in more than one path. The repository-owned functional-parity manifest invokes the real CLI process and consumes only AiHarness public interfaces; its narrow canonicalizer may replace temporary roots, UUIDs, timestamps, durations and generated workspace IDs, but preserves protocol records, order, values, framing and channel assignment. The bilingual [public contract policy](../contributors/en/public-contract-policy.md) governs golden changes, migrations and Core/extension major markers. Interactive and RPC steering/follow-up delivery plus detached Web queues use Core's bounded all/one-at-a-time scheduler; trusted Web runs resolve the same Core delivery-mode settings at startup, while terminal adapters only own key dispatch, lone-Escape/Alt+Enter disambiguation, cancellation feedback and editor restoration. All paths resolve Core's same model, instruction, agent-settings, credential/network and project-trust contracts: startup model/scopes, thinking, tools, compaction/retry, session directory, resources, shell behavior, supported TUI preferences, nearest saved allow/refuse decisions and `defaultProjectTrust` use explicit CLI → environment/process → trusted project → agent-setting precedence where applicable. Before trust, Core rejects an agent directory inside the workspace and locates `trust.json` in an independent symlink-free directory. Interactive startup prompts only when bounded metadata discovery finds protected project resources; `--approve`/`--no-approve` and headless RPC use one-process decisions without mutating the shared store. Documented context filenames and replace/append flags feed every provider turn; `/settings` reports effective source scopes and `/reload` refreshes settings, trust, credentials/network/providers, model/thinking, instructions, resources, themes, extensions, tools and shell callbacks. Startup-only session location, renderer kind and RPC defaults still require a restart. `/model` and RPC cycle against the shared ordered scope, and `--list-models` reports settings diagnostics but exits before session/resource startup. Built-in command metadata lives in `commands/handler.ts`, while user-visible help also exists in both TUI implementations.

Project extensions are executable code. User extensions are loaded from `~/.ai-harness/extensions`; project extensions and project package resources require project trust. CLI discovery/orchestration remains in `cli/src/extensions`, while bounded `ExtensionModuleLoader` and package lifecycle/state/inventory implementations are shared from Core. Top-level package actions exit before agent startup; enabled package extensions, skills and prompts feed interactive/print/JSON/RPC startup and reload, while package themes can be selected by filename stem. The server uses the same Core service and module loader through thin adapters during explicit startup/reload to atomically host enabled standalone/package extensions and their declarative Web surfaces; catalogue GETs and list operations never execute extension code or contact npm/Git.

### `packages/server`: API, transport, persistence, and Web launcher

| Area | Files | Responsibility |
|---|---|---|
| Server composition | `src/index.ts`, `src/runtime/services.ts` | Synchronous Express app construction, awaited runtime bootstrap before listen with retired-generation refusal, middleware, routes, sharing, static assets and lifecycle |
| Detached execution | `src/api/agent-routes.ts`, `src/runtime/command-runtime.ts` | Agent state/SSE/queues/stop, effective setting overrides, Core-resolved trusted instruction prompts, exact preset capabilities, Core-backed shell command output/replay/cancel, manual and automatic compaction; `command-runtime.ts` is a thin re-export |
| Interactive terminals | `src/api/terminal-routes.ts`, `src/runtime/terminal-runtime.ts` | Owned `node-pty` processes, bounded ANSI replay by UTF-8 offset, input/resize/exit, instance limits and shutdown |
| Session windows | `src/api/session-pagination.ts`, `src/index.ts` | Metadata-only lists, bounded tail/before/around pages, stable message cursors, full server-side export, provider title generation and recursive cascade guard |
| Linked-directory browsing | `src/runtime/linked-directories-service.ts`, `src/api/linked-directories-routes.ts` | No-store selectors, capabilities/Origin, fresh source trust and redaction; composed through existing workspace routes |
| Workspaces and files | `src/api/{workspace-routes,workspace-file-manager,file-routes}.ts`, Core `src/{security,system,tools}/` | Trust, bounded browse/direct-child creation, loopback-only host file-manager launch, force-retry Git/worktrees, shared bounded coding tools, fuzzy index, collision-aware upload, source/media download, Git stats/diffs and file-watch SSE |
| Scoped configuration | `src/api/config-routes.ts`, `src/config/{config-store,effective-configuration}.ts` | Validated nullable global/project/session values, runtime/environment precedence, provenance and atomic non-secret storage |
| Providers/models | `src/api/{model,provider-registry}-routes.ts`, `src/runtime/{model-catalog,provider-registry,provider-oauth,provider-administration,resource-batches}.ts` | Published/discovered/custom models, custom dialect providers, OAuth Device Flow, default-OFF restricted provider rename with awaited administration leases/private recovery intent, capabilities/prices, exact scoped activation batches and persist-before-use encrypted secrets; secret mutations fail closed without durable storage |
| Tools | `src/api/tool-routes.ts`, `src/runtime/services.ts`, Core `src/tools/` | Effective registry inventory, shared coding-tool registration, scoped presets/enabled tools, cached QuickJS self-test, global/project code-mode presentation/budget, visible restriction reasons, model capability filtering and Windows-only opt-in PowerShell |
| MCP configuration, OAuth, test and hosting | `src/api/mcp-routes.ts`, `src/runtime/mcp-inventory-service.ts`, Core `src/{mcp,tools}/` | Passive authenticated redacted overview plus admin-only paste/replacement preview, atomic local mutations, explicit one-shot Test and active OAuth status/start/poll/paste/cancel/logout adapters; the composition root injects Core's encrypted OAuth manager, detached flow registry, per-session MCP host and branch-persistent deferred-search loadout into `AgentRuntime`. Runtime status is decorated onto the same redacted inventory while OAuth tokens remain server-side |
| Plugin packages | `src/api/plugin-routes.ts`, `src/runtime/{plugin-service,configured-plugin-service,services}.ts`, Core `src/plugins/` | Operation-local fresh eligible npm settings for explicit actions (no HTTP approval override); HTTP adapter and executable generation composition over shared Core npm/Git/path administration, inventory, trust/scopes, filters, bounded bulk activation, locking and transactional updates/checks |
| Skills | `src/api/skill-routes.ts`, `src/runtime/{skill-catalog,skill-markdown,skill-registry}.ts` | Metadata-only discovery/invocation, independent exact-group frontmatter edits with owned receipt rollback and canonical failure readback, plus HTTPS/SHA-256 registry installs/updates by trusted scope |
| Web Push | `src/api/push-routes.ts`, `src/runtime/push-service.ts` | VAPID lifecycle, public-endpoint validation, encrypted-or-volatile subscriptions, categories and stale cleanup |
| Child agents | `src/api/subagent-routes.ts`, `src/runtime/{subagent-service,subagent-runtime}.ts`, `src/runtime/services.ts` | Atomic global/project profiles, `spawn_subagent`, bounded linked child sessions, shared trusted instruction composition, concurrency/depth, lifecycle and parent journal events |
| Release status | `src/runtime/app-update.ts` | Bounded Web/agent versions, timed and cached release lookup, safe diagnostics without automatic installation |
| Request security | `src/security/request-security.ts` | Cookie/Bearer roles and capabilities, Origin checks, rate limits, safe errors, WebSocket auth context |
| Provider proxy/usage | `src/api/proxy.ts` | Built-in/custom provider setup, credentials, persistent cache-aware usage/cost, legacy chat/compaction and SSE |
| WebSocket transport | `src/api/websocket.ts` | Upgrade authentication without bearer reflection/query tokens, strict bounded RFC 6455 framing, cancellation/backpressure and legacy chat event payloads |
| Credential storage | `src/security/credential-store.ts` | Adapter over Core encrypted stable persistence; credential/OAuth mutation paths fail closed when the master-key-backed store is unavailable |
| Production launcher | `src/web-cli.ts`, `src/web-cli-options.ts` | `ai-harness-web` flags, environment precedence, static bundle location, browser opening |

Main HTTP surfaces:

- Public/auth: `GET /health`, temporary `GET /share/:token`, `/api/auth/status|login|logout`
- Application release status: authenticated `GET /api/app-update`, optionally refreshed without automatic installation
- Detached agent: `/api/agent/runs`, run queues/stop, session state/events/capabilities/compaction, commands/events
- Workspaces: `/api/workspaces/default|validate|browse|file-manager|trust|worktrees`; bounded browse supports strict direct-child creation, host file-manager launch is loopback/platform/path gated, and trust status includes protected-resource metadata plus exact/inherited allow/refuse provenance, while distinct `operationTrusted` keeps Web first-use capability explicit even when an empty fresh workspace has resource-sensitive `trusted: true`
- Files/Git: `/api/files`, content/download/index/upload/watch and `git/status|diff`
- Terminals: `/api/terminals`, per-terminal events/input/resize/delete
- Configuration: scoped/effective nullable values under `/api/configuration`; legacy built-in credentials remain under `/api/config`
- Models: grouped published/discovered/custom catalogue and refresh under `/api/models`; qualified global/project activation under `/api/models/enabled` and exact bounded provider/displayed batches at `/enabled/batch`, with canonical post-error readback
- Provider registry: auth status/OAuth flows, tests, custom provider/model CRUD and imports under `/api/provider-registry`
- Tools: effective inventory and scoped preset/enabled-tool mutations under `/api/tools`; project IDs require their canonical cwd
- MCP: authenticated, `workspace:read`-guarded, redacted file-only `GET /api/mcp[?cwd=...]`; admin `configuration` capability for `POST /api/mcp/test`, non-mutating `POST /api/mcp/preview`, `POST /api/mcp/actions`, OAuth status/start/pasted redirect/logout, flow polling and cancellation; Test accepts only scope/name/cwd, rereads the entry and trust state in Core, opens one bounded stdio/HTTP connection and returns redacted capabilities without OAuth. Explicit OAuth keeps credentials server-side, revalidates config/trust before writes and verification, and uses detached expiring flows. Agent runs independently ask Core's per-session host to reread eligible configuration before each prompt, passively use/refresh stored OAuth state and expose connected direct tools
- Plugins: metadata-only scoped catalogue plus explicit install/enable/disable/remove/update/check, one-request bounded group activation at `PATCH /api/plugins/enabled`, and atomic session-aware executable reload under `/api/plugins`
- Skills: trust-aware catalogue/activation, exact bounded `/api/skills/enabled/batch` frontmatter/scoped-list mutations and HTTPS registry search/install/update under `/api/skills`
- Push: public VAPID key plus authenticated status/subscribe/unsubscribe under `/api/push`
- Child agents: scoped settings/profile CRUD and run list/start/get/stop/acknowledge under `/api/subagents`
- Sessions: list/search/create/get/update/delete, model-assisted `auto-name`, recursive cascade confirmation, paged messages, info/export, append, fork, clone, tree and share
- Legacy chat: `POST /api/chat`, `/api/chat/stream`, `/api/chat/compact`; WebSocket upgrade at `/api/chat/ws`

All protected `/api` routes accept optional Bearer authentication or an opaque HttpOnly Web-session cookie when auth is configured. User/admin roles map to explicit capabilities; credential and dangerous workspace mutations require admin. Origin checks cover mutations and WebSocket upgrades. Express route declaration order matters: fixed paths such as `/tree` and `/search` must be registered before conflicting `/:id` routes.

The server has adapter/proxy code in addition to the provider implementations in `core`. Provider changes often need updates in both places.

### `packages/web`: React browser client

| Area | Files | Responsibility |
|---|---|---|
| App/router/auth | `src/App.tsx`, `src/index.tsx`, `src/components/LoginView.tsx` | Auth bootstrap, urgent router identity alongside synchronous external-store publication, workspace/session/provider/model/skill hydration, deep-link restoration, detached-run polling, chat/settings routes and lazy Sidebar/Settings/terminal boundaries |
| Session/provider state | `src/store/session-store.ts` | Date hydration, indexed windows, bounded v1→v2 workspace cache, drafts/attachments, sequenced workspace model/skill catalogues, provider/model selection, summaries, runs and per-session settings |
| Preferences | `src/store/preferences.ts` | Validated v4 themes/send key/layout/reasoning/volume and separate sound/local/Push categories, selection/panels/keybindings, v1/v2/v3 migration, synchronous own writes before passive subscription, and cross-tab updates |
| API client | `src/services/{api,mcp-api,push,resource-batches}.ts` | Cookie/Bearer fetch and SSE plus sessions/workspaces/direct-child creation/host file manager/files/Git force retry, provider registry/OAuth, tools, redacted MCP inventory, bounded one-shot test, explicit MCP OAuth status/start/poll/paste/cancel/logout, original-text import/replacement preview and persistence, explicit fresh-project trust-plus-write, and lazy local actions with authoritative workspace/uncertain-failure reconciliation, skill registry, plugins, Push and child agents |
| Chat | `src/components/{ChatView,composer-submit,MarkdownContent,MarkdownContentRenderer,SubagentPanel}.tsx`, `src/agent.css` | Reconnection/history, IME-safe configurable Enter or Mod+Enter submission, rich rendering, Process/Response and full output (including MCP server/tool labels), dynamic resource palette, declarative extension widgets/interactions, drafts/images/queues, settings/compaction/branches and child agents |
| Extension interaction form | `src/components/{ExtensionInteractionBoundary,ExtensionInteractionDialog}.tsx`, `src/components/extension-interaction-dialog.css` | Singular pending-request-only JS/CSS, local nonmodal loading/error/Close/Cancel and cached-reload warning; abortable transport, compatible drafts/IME and view/newer-focus/coarse-editing guards; not full browser queue delivery |
| Markdown semantics | `src/components/markdown-{semantics,paste,list-continuation}.ts` | Shared currency/math, CJK/raw-text and frontmatter semantics, memoized rich/noninteractive projections, authoritative plaintext/inert bounded link metadata and IME/send-aware list/caret behavior |
| Navigation | `src/components/Sidebar.tsx`, `src/sidebar.css` | Lazy workspace/trust/worktree navigation, sequenced bounded directory browsing, focus-trapped direct-child creation, local host-file-manager action, explicit force retry, session search/create/inline rename/model auto-name/cascade-safe delete and run indicators |
| Linked-directory controls | `src/components/{LinkedDirectoryBoundary,LinkedDirectoryModal}.tsx`, `src/services/linked-directories.ts` | Optional local JS/CSS loading/error, exact metadata/confirmation, scoped reads and retired modal lifetimes |
| Workspace panel | `src/components/{WorkspacePanel,WorkspacePanelBoundary}.tsx`, `src/components/workspace-panel-{messages,boundary.test}.ts`, `src/workspace-panel.css` | Keyed optional JS/original-CSS allocation, local loading/error/Close/Cancel and explicit reload warning, latest file intent through listener handoff; real Panel retains Git/tree/viewer/watch/upload/trust ownership |
| Terminal | `src/components/TerminalPanel.tsx`, `src/terminal.css` | Dynamically imported multi-tab xterm UI with keyed workspace boundary, per-workspace tab restoration, input/clipboard/resize and offset reconnection |
| Mobile keyboard | `src/hooks/{useMobileKeyboard,mobileKeyboardStyles}.ts`, `src/hooks/mobile-keyboard.css` | View-tuple-owned conservative viewport observer, lazily owned chat-only styles and bounded cleanup; no physical-keyboard certification |
| Global keyboard/accessibility | `src/components/{CommandPalette,StatusCenter,SubagentMonitor}.tsx`, `src/services/{keyboard,notices}.ts`, `src/hooks/useFocusTrap.ts` | Focus-trapped palettes/dialogs/extensions, bounded status and child notices, lifetime/newer-focus return ownership, active-modal containment and bootstrap layout-phase shortcuts |
| Settings | `src/components/{SettingsView,EcosystemSettings,McpSettings,McpImportPreview,PluginSettings,SubagentSettings,ResourceBatchControls}.tsx` | Provider lifecycle/custom resources, defaults/tools with cached sandbox health and scoped code-mode controls/reasons, model/skill registry, exact filter-preserving model/skill-group batches with retired-view guards and owned Markdown rollback, redacted MCP files with explicit Test reports, volatile persistent-runtime state and server-side OAuth sign-in/paste/cancel/logout state, paste preview, confirmation-gated atomic import/replacement, row/group activation, exposure, removal/undo, grouped package controls, child profiles, auth, appearance, Push preferences, versions and shortcuts |
| PWA shell | `src/components/PwaStatus.tsx`, `src/services/push.ts`, `public/{manifest.webmanifest,sw.js,offline.html}` | Install/update/offline shell plus explicit Web Push subscription, visible-client deduplication and notification routing |
| Internationalization | `src/hooks/useI18n.tsx`, `src/i18n/`, `src/components/LanguageSelector.tsx`, `src/components/{mcp-import-messages,settings-locale}.ts`, `src/components/SettingsLocaleBoundary.tsx` | Browser locale detection, English fallback, registered packages/persisted selection, local bilingual MCP copy and conserved Settings-only dictionaries loaded before controls; fill-only registration, translated local loading/error/Close and explicit page-reload retry |
| Styling | `src/{index,settings}.css`, `src/agent.css`, component CSS | Global/chat layout plus route-split Settings styles, themes and responsive behavior |
| Tooling | `vite.config.ts`, `vitest.config.ts`, `scripts/check-bundle-budget.mjs` | Source aliases, development proxy, package test settings, production chunks and failing bundle budgets |

The server is the source of truth for persisted Web sessions. A `draft:*` session stays browser-local until `POST /api/agent/runs`; the detached run becomes stoppable first, Core completes the abortable pre-prompt MCP preparation, and only then does the server persist the user message and begin provider execution. Stopping during that preparation therefore withdraws the unsent prompt; later model/tool turns persist normally. `ChatView` may hold a temporary streamed assistant message, but terminal events must resynchronize it with the canonical session without duplicates. The optional per-tab workspace cache is schema v2 with explicit v1 migration; it must remain bounded, favor draft text over binary previews, strip provider API keys and be discarded or reconciled whenever the server revision changes. PTY React state and stored IDs are keyed by workspace so a cwd switch unmounts the previous surfaces before restoring the target workspace. Scroll state uses a separate versioned, 24-entry/24-hour per-workspace `sessionStorage` map; capture it at scroll time (not from reused DOM during route cleanup), debounce writes, and rematerialize a missing virtual anchor through the paged `around` API before correcting its measured offset.

The declarative root `BrowserRouter` disables internal transitions so route identity updates stay urgent alongside Zustand workspace/session publication; the browser URL must not advance while a previous mounted route epoch remains available for a valid file intent that a delayed commit then retires. Preserve genuine navigation cancellation rather than carrying intent across replacement scopes.

The optional file pane loads its real component and original CSS together only when open with an eligible workspace. Pending presentation/file intent is keyed by workspace ID/cwd, session, route key and pathname/search/hash; address fields protect stateless history entries that reuse a fallback key. Close or navigation retires it. Delayed Markdown file-link dispatch additionally belongs to its original connected element/address, so it cannot publish into a replacement view. Local translated loading/error never suspends chat, composer or Stop. Rejection stays cached until explicit page reload, with an unsent-text warning. Parent capture survives DOM commit until child passive registration; deferred replay survives development StrictMode and is cancelled or superseded rather than replayed into a replacement scope. `e2e/workspace-asset-load.spec.ts` tests actual production assets with controlled API fixtures; unchanged `e2e/live-server.spec.ts` separately protects actual file/PTY/server behavior. `useFocusTrap.test.ts`, `preferences-bootstrap.test.ts` and production-preview `e2e/pane-lifetime.spec.ts` cover bootstrap registration, own preference retention, newer-focus/remount ownership and nested-modal safety.

The Web uses the server's real mock provider; there is no client-side demo response path. Most Playwright tests intercept API requests and model the detached protocol, including OAuth/custom providers/models, tool settings, redacted MCP inventory/one-shot test/import preview/atomic import/whole-entry replacement/local mutations, skill registry, plugin/reload, extension interactions, Web Push, profile CRUD and child runs. `e2e/live-server.spec.ts` traverses Vite → Express → mock provider → JSONL/reload and exercises real PTY/files/security. `web-server.test.ts` provides broader HTTP/provider/persistence/security and disposable Git/PTY/child-runtime coverage. Accessibility tests run axe plus focus/keyboard checks; performance tests protect bounds/cache/lazy loading. The 118 visual cases protect historical surfaces plus provider/model editors, registry, Process blocks, and extension dialogs across Light/Dark desktop/tablet/mobile variants; the redacted MCP state and import-preview matrix has dedicated Light/Dark desktop/mobile coverage.

## 4. Important Runtime Flows

### CLI conversation

```text
CLI positional/@file/piped input or interactive input
  -> strict mode/tool selection and bounded Core prompt-file loading
  |-> interactive ! / !! -> trust check -> Core ShellCommandRuntime
  |      -> filtered process + bounded stream/tree cancellation
  |      -> parented command persistence, optional model context and private full output
  `-> resource expansion or CommandHandler
       -> before:agent extension hook
       -> SessionManager.addMessage(user)
       -> active Enter / Alt+Enter input -> Core steer/follow-up queue
       -> lone Escape -> abort active provider/tool/shell work and restore queued input
       -> runToolLoop
            -> before:provider hook
            -> AiProvider.streamChat
            -> optional tool calls -> before:tool hook -> extension tool
            -> persist tool call/result and continue provider turns
       -> persist final assistant message
       -> lifecycle events and TUI updates
```

Cancellation must propagate through `AbortSignal` to provider, active tool work and direct shell process trees. Interactive, final-text-only print, one-shot JSON event, RPC prompting, and the detached Web runtime use the same Core tool loop and provider-turn hooks; interactive CLI and Web direct commands separately share Core's `ShellCommandRuntime` and `parseShellCommandInput`. Provider implementations must await each stream callback; Core serializes delivery and bounds pending bytes/events so a non-cooperative extension cannot create an unbounded queue. JSON mode writes its version-3 session header and lifecycle records through `cli/json-output.ts`; RPC reuses that event encoder without the header. Do not add a provider or shell process path that bypasses hooks/persistence where applicable, retry, backpressure, environment filtering or cancellation without an explicit reason.

Standalone `ai-harness auth` and `export` dispatch before conversation startup; root help advertises their strict help surfaces. Authentication reuses Core's independent encrypted credential service and the bounded device client with caller signal, never a process-global fetch replacement. Export opens only the selected existing session, normalizes a detached memory-only projection and reuses slash rendering/Core atomic output; JSONL is message-only, not a journal backup. See the [EN](../users/en/standalone-operations.md) / [FR](../users/fr/standalone-operations.md) operator contract; these operations neither create sessions nor initialize providers/extensions/TUI.

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

Session-scoped command notices retain active-run correlation but omit `runId` when the current run is completed/failed/stopped; captured run-bound tool notices retain their original ID. See [the session event contract](./topics/server-api.md#current-event-contract); this does not certify browser notice presentation or full Web queue delivery.

ChatView’s canonical title metadata does not define SSE lifetime: title refresh preserves the subscription, existing notifications read the stored canonical title at dispatch, and session/cwd replacement or unmount retains cancellation. See [Web architecture](./topics/web-app-architecture.md#detached-conversation-flow); this is not full-address SSE or plural queue/attention/progress admission.

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

### MCP configuration, explicit Test, persistent prompt hosting and local mutations

```text
Settings › MCP -> GET /api/mcp?cwd=<selected workspace>
  -> workspace:read capability + canonical allowed-root directory resolution
  -> Core reads the global <data-dir>/mcp.json as a bounded regular nonsymlink file
  -> Core resolves fresh project trust from trust.json
       |-> effective saved allow: read <cwd>/.ai-harness/mcp.json safely
       `-> no allow/refusal/store error: inspect metadata only; never open the body
  -> JSON/JSONC parse + strict shallow schema and depth/count limits
  -> redact command paths/arguments/URL credentials and paths; return names/references only
  -> render global/project entries, shadowing, trust and fixed diagnostics

paste URL/command/install link/JSON -> POST /api/mcp/preview
  -> workspace:read + administrator configuration capability + Origin check
  -> browser sends original text (maximum 256 KiB), syntax mode and optional cwd, never a trusted config object
  -> Core parses at most 20 entries and keeps only recognized AiHarness fields
  -> conservative shell lexer rejects operators, substitutions, shell evaluators and multiple commands
  -> foreign literals are escaped in resolved fields; references are allowed only in env/header/OAuth client-secret values
  -> classify missing fields, literal secrets, available/missing/reserved variable names and remote-value confirmation
  -> derive scope eligibility from redacted inventory plus fresh persisted project trust
       |-> saved effective allow: ordinary project import is eligible
       `-> decision-free fresh folder with bounded safe breadth: require explicit trust-plus-first-write confirmation
  -> return fixed notes and redacted persisted shapes; perform no write, resolution, process, network, OAuth or store access

selected preview + completed fields + explicit confirmations -> POST /api/mcp/actions (import)
  -> browser resends original text, entry index, target name/scope and bounded completion/reference choices, never a normalized config
  -> Core reparses the original paste, reapplies completion, rejects reserved/unsupported references and revalidates the final entry
  -> project rejects every remaining literal secret; global requires literal-secret confirmation
  -> each available host variable sent by header/OAuth requires explicit name-bound confirmation
  -> ordinary project import compares the target revision under the shared lock, rechecks saved trust and appends atomically
  -> confirmed first import into a decision-free fresh folder acquires the trust-store lock, rechecks folder identity/resources/nearest decisions plus root/home/data/known/nested breadth, persists one exact allow, then rechecks under the MCP lock and writes
       |-> write failure: remove only that exact allow
       `-> rollback failure: return typed retained-trust state and force canonical inventory/workspace reload
  -> return only a fresh redacted inventory plus added scope/name; never return the written entry or source literals

valid row Edit -> POST /api/mcp/preview with replacement scope/name/revision -> POST /api/mcp/actions (replace)
  -> browser supplies a complete replacement paste; current hidden values are never loaded into the form
  -> preview excludes only the selected target from same-scope collision checks and remains fully redacted
  -> write resends original text, selected entry and the same bounded choices/confirmations as import
  -> Core reparses and reapplies all import policy, then replaces or renames exactly that valid target under the lock
  -> omitted target fields are removed; siblings and root keys survive; an unchanged entry/name is byte-stable
  -> return only a fresh redacted inventory plus scope/previous-name/new-name

row/group switch, exposure choice or confirmed remove/undo -> POST /api/mcp/actions
  -> workspace:read + administrator configuration capability + Origin check
  -> canonical cwd; project action requires a fresh persisted allow
  -> compare opaque file revision under a bounded inter-process lock
  -> parse current JSON/JSONC; reject malformed, stale, linked or nonregular targets
  -> apply at most 100 unique activation selectors, one direct/codemode/deferred/hidden server-default or exact remote-name override change, or one removal/restoration
  -> preserve unknown keys, first bounded indentation and LF/CRLF policy
  -> owner-only global mode, existing project mode or 0644 for a new project file
  -> fsync same-directory temporary file + atomic rename + fresh redacted GET inventory
  -> removal body stays in a 60-second/100-record server-only store; browser receives one opaque token

valid row Test -> POST /api/mcp/test with only scope/name/cwd
  -> administrator configuration capability + Origin check + canonical allowed-root cwd
  -> Core rereads that exact entry from disk; project scope requires a fresh persisted allow
  -> configured stdio cwd is canonicalized inside allowed roots and its project trust is checked again
  -> resolve only that entry's runtime env/header values; OAuth client secrets remain untouched because Test never starts OAuth
  -> command-backed values take a single serialized slot; identical concurrent tests join
  -> connect stdio with a filtered child environment or Streamable HTTP with configured headers
  -> bound per-request and whole-test time, pagination/items, stderr/error text and close wait
  -> close on success, failure, deadline and server shutdown; HTTP 401 reports needs-auth without starting OAuth
  -> return only redacted identity/cwd/server info/capability counts/tool summaries/read-only hints/exposure
  -> keep status in server memory only while scope/source/name/config key still match
```

```text
eligible HTTP row OAuth Sign in -> POST /api/mcp/oauth/start with scope/name/configKey/cwd
  -> administrator configuration capability + encrypted-store availability
  -> reread exact config, canonical cwd and persisted trust; derive opaque SHA-256 name/normalized-URL identity
  -> Core joins or creates one detached random-UUID flow with five-minute TTL and bounded registry
  -> bind only 127.0.0.1 /oauth/callback, reuse a registered loopback port when available, otherwise use an ephemeral port
  -> MCP SDK discovery + PKCE + configured client or dynamic registration
  -> poll GET /api/mcp/oauth/flows/:id; open the bounded safe authorization URL
  |-> issuer redirects to the loopback listener
  `-> user pastes the full redirected URL to POST /redirect
       -> exact origin/path/state/code validation; no verifier, client secret or token crosses to Web
  -> reread target before runtime resolution, connection, each encrypted credential write and post-login passive MCP verification
  -> persist one bounded CAS-protected encrypted document; show only stable phase/outcome/failure state

ordinary CLI/RPC/Web MCP connection -> passive Core OAuth provider
  -> use or refresh stored credentials after an HTTP challenge
  -> never publish an authorization URL or begin interactive registration

OAuth cancel/logout -> abort detached work / increment write generation before credential removal
  -> persist a non-secret revocation marker; stale provider-local CAS snapshots cannot restore credentials
  -> close target process-local MCP sessions and abort outstanding passive OAuth fetches
```

`POST /api/mcp/oauth/status` is the only credential-status read and returns booleans keyed to the revalidated scope/name/config key. The exact `GET /api/mcp` inventory path bypasses credential initialization and remains a passive file/trust read. OAuth endpoints require the administrator `configuration` capability, never return tokens/client secrets/verifiers, and return `oauth-unavailable` when the master-key-backed store is absent. Callback listeners, remote responses, request time, flow count, redirect length, credential documents and shutdown are bounded. Shared fetch deadlines remain linked through finite OAuth response bodies, including passive refresh during tool calls; cancellation closes a callback listener even when its driver ignores abort. Command-backed initial connections serialize in the host and detached flows serialize per credential identity, not in one process-wide slot. Cancellation and sign-out do not revoke an issuer-side token; operators needing remote revocation must do so at the authorization server.

GET, preview, import, replacement and local actions remain side-effect-free with respect to MCP resolution/transports. The explicit Test action may expand supported values and open one short-lived transport, but never invokes tools or writes credentials. Separately, immediately before an agent prompt, `McpSessionHost` rereads the bounded inventory and each exact target, rechecks persisted trust and configuration identity, closes replaced/disabled connections before replacement, and starts at most 32 enabled servers for that session. Connecting `direct` servers are awaited within the connection deadline; `codemode` and `deferred` servers continue without delaying the prompt and publish no direct definitions. Core adds one synthetic `tool_search` declaration only when an eligible indirect source exists. Its bounded BM25 index covers names, descriptions, schemas and namespaces, waits abortably for indirect metadata only after an explicit search, and activates only selected deferred matches for the next provider turn; codemode matches remain script-only. Activation is recorded on the tool-result message, restored from the active session branch after resume or fork, and re-filtered through current preset, allowlist, exclusions, extension ownership and MCP read-only annotations; a second call in the same provider response remains undeclared and is rejected. Connected tools use deterministic provider-safe names, all normalized collisions receive a stable hash suffix, read-only runs retain only `readOnlyHint` MCP tools, and invocation rechecks the prepared binding, bounds input/output, omits binary payloads and redacts configured/resolved credentials. Unchanged connections survive prompts, failed/disconnected records retry on the next prompt, tool-list notifications refresh future declarations, and an explicit post-prompt idle window plus bounded runtime shutdown closes transports/processes. Stop aborts preparation or discovery before unsafe continuation. CLI interactive/print/JSON, RPC and Server/Web compose the same loadout and Core tool loop; neither dynamic path mutates `ExtensionRegistry`. `ai-harness mcp` remains only a thin management adapter, including explicit master-key-backed `login`/`logout` and exact remote-name `exposure ... --tool` overrides. Hidden tools are absent from declarations, discovery and nested calls; wholly hidden servers do not connect for prompts unless a non-hidden override makes them eligible. Web bare `/mcp` navigates locally to the focused MCP Settings section. The separate bounded QuickJS helper is implemented through that same selected loadout; discovery never grants execution authority.

### Code mode sandbox

Core's `tools/{codemode,codemode-worker,tool-search}.ts` owns the [QuickJS contract](./topics/codemode.md), independent of MCP discovery. User source executes only inside a disposable QuickJS worker with no ambient Node/files/network/timers. VM/stack/fuel/time/source/input/output/call/concurrency limits and abort propagation bound guest execution; nested tools retain their real privileges and current selection/MCP read-only checks, even after a queue wait. Hidden/model-only/recursive/subagent controls cannot be nested. Successful redacted JSON store changes persist only on the active session branch; failure does not undo host effects. Core's credential-private `providers/specialized-models.ts` supplies typed virtual classification/native image SDK methods and guest helpers from the current provider, with live availability, a dedicated cancellable `before:model` hook, request/result/deadline bounds and shared provider network policy. Stable parented nested progress lives only inside the outer active tool/snapshot/result; known usage/cost is accounted once, and the specialized Web card displays cost completeness, omitted calls and plain-text script/output with legacy fallback. CLI/JSON/RPC opt-in and Web Automatic/Always on, on/only and inline-budget settings share the same Core loadout. Server startup caches a sandbox health probe; inventory GET only reads it. Scoped save/readback, visible reasons, budgets, real CLI execution outside the installation, and reviewed Light/Dark desktop/mobile controls have dedicated regressions in `tools/codemode.test.ts`, `api/tool-settings.test.ts`, and `e2e/codemode.spec.ts`.

### Plugin package administration

```text
explicit CLI or POST install/update
  -> shared Core strict npm:/Git HTTPS/path parsing + workspace/scope trust
  -> immutable literal npm selection + fresh declaring-source trust at each npm/Git boundary
  -> npm without lifecycle scripts, or shallow Git clone, in staging
  -> bounded symlink-free manifest/convention inventory + per-kind filters
  -> heartbeat lock + refreshed state + owner-only atomic package/state replacement

CLI package list / GET /api/plugins
  -> workspace-isolated, metadata-only catalogue; never network or install

CLI/RPC startup or interactive /reload
  -> expose enabled package extensions, skills and prompts behind trust
CLI startup
  -> resolve a selected package theme by filename stem behind trust

POST /api/plugins/reload [sessionId]
  -> resolve in-memory or persisted session and verify its workspace
  -> validate every active visible package into a candidate generation
  -> discover bounded extension files without symlinks
  -> import candidate and atomically replace executable commands/tools/providers/UI/hooks
  -> invalidate separately discovered resource catalogues; rollback the old generation on failure
```

Keep package administration explicit: a read must never install, update, contact npm/Git, or execute code. Core owns source policy, state, filters, inventory, checks/updates and locking; CLI and Server own only command/HTTP presentation and runtime generation composition. State and managed files must roll back together. Project resources stay hidden/inactive until trust, scans never follow symlinks, extension modules are capped at 5 MiB, and diagnostics exclude resource bodies, command output and credentials. On workspace change, a failed Server candidate clears handlers from the old cwd rather than leaking them.

### Extension interaction

```text
extension tool/hook -> context.requestInteraction(declarative request)
  -> AgentRuntime admits a bounded ordered request with a host-owned awaitable handle
  -> extensionRequests stores the complete queue; extensionRequest projects its first entry
  -> extension.ui event + optional attention Push
  -> ChatView mounts a local boundary; pending request imports the real declarative form and own CSS
  -> POST response/cancel with active session + request IDs
  -> AgentRuntime revalidates kind, field IDs/types/options and size
  -> suspended extension resumes, or receives cancellation
```

Only an active run may request interaction. Core owns admission, schema replacement, exactly-once settlement and cancellation; Server binds command requesters before awaits and clears them on executable/tool-generation commit or failed-workspace safety retirement. Failed same-cwd candidates and passive reads preserve the current epoch. The existing Web adapter still has singular interaction state; full browser queue/attention delivery is not implied. See [extensions](./topics/extensions.md) for limits, handles and tests. Keep widget content plain text and custom dialogs schema-driven; never introduce extension-provided React, DOM, script, style or unsanitized HTML. Focus trapping, Escape, restoration and reconnection remain adapter responsibilities. The optional form's nonmodal loading/error keeps chat and Stop available; failed imports remain cached until explicit reload with an unsent-text warning. Its full view tuple retires response transport and late presentation, without undoing an already accepted server response. Same-ID compatible drafts/connected IME survive updates; initial and return focus respect newer intent/modal/view ownership, with coarse editable return allowed only after owned manual editing. `e2e/interaction-single-asset-load.spec.ts` tests real production assets and `interaction-live-boundary.spec.ts` tests actual extension/HTTP validation and mock-provider resumption.

### Session persistence

Both CLI and server default to `~/.ai-harness/sessions/<session-id>.jsonl`, so they can share conversations when running as the same OS user. The custom v2 journal retains parent-linked active and abandoned entries; RPC fork moves the active leaf in place, while `--no-session` keeps an equivalent process-local journal. CLI and RPC resolve path-selected sessions first, then `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, and the merged agent/trusted-project setting `sessionDir`; interactive-only `--resume` is rejected in RPC in favor of `--session`. The persisted format remains AiHarness JSONL v2.

Server state under `AI_HARNESS_DATA_DIR` includes atomic `config.json`, `providers.json`, `usage-metrics.json`, `plugins.json`, `subagents.json` and trust/session files. Explicit restricted single-writer provider rename also retains a bounded private `config.json.provider-intent.json`; pending/unsafe state blocks startup and requires offline reconciliation (see [providers](./topics/providers.md)). An operator-managed `mcp.json` may also live there; its Web surface is bounded and redacted, and admin-only local activation/exposure/removal/restoration uses locked atomic replacement plus server-only undo, but the file may contain literal values that must still be treated as secrets. `trust.json` v2 stores bounded canonical boolean decisions; the nearest ancestor decision applies, explicit refusals override inherited allows, v1 allow-lists migrate on the next mutation, and async reads refresh across CLI/Web processes. `credentials.enc`, `provider-secrets.enc` and `push.enc` exist only when `AI_HARNESS_MASTER_KEY` enables encrypted persistence. Built-in provider and name/normalized-URL-isolated MCP OAuth state share the bounded Core `credentials.enc` store under disjoint opaque keys; MCP tokens, refresh tokens, dynamic-client secrets and PKCE verifiers never enter browser state. Built-in login/API-key, MCP OAuth and custom-provider secret mutations refuse success without the applicable durable store; environment/command/explicit CLI credentials may remain process-local, while Push subscriptions remain volatile. Never put secrets into the non-secret JSON stores, fixtures, API status objects or browser persistence.

Use `SessionManager` for domain operations, `JsonlSessionStore` for storage behavior, and `serializeSession`/`deserializeSession` at JSON boundaries. Avoid direct mutation of manager internals. Every write is asynchronous and should be awaited before reporting success. Session IDs are capped at 256 bytes, files at 64 MiB and inventory at 10,000 entries; files are stable UTF-8 regular files with one link under a private symlink-free directory. Cooperating append/save/delete operations share a bounded heartbeat lock, rewrites use `fsync` plus atomic rename, and loaded legacy data is rewritten after credential redaction. A clone is an independent root (`metadata.clonedFromSessionId`); RPC in-place fork retains descendants in one journal, while startup/copy forks keep related-session lineage.

## 5. Cross-Package Change Guides

### Add or change a provider

Review all of the following, not only the core implementation:

1. `core/src/types/index.ts`: provider/config/model metadata, capabilities, compatibility and pricing contracts.
2. `core/src/providers/{index,provider-network,credentials,model-metadata,model-catalog}.ts` and `core/src/security/credential-store.ts`: implementation, bounded payloads/streams, proxy/deadline/retry and WebSocket policy, credential/redaction/storage contracts, discovery, catalogue assembly/resolution, defaults, reasoning/tools and usage normalization.
3. `core/src/index.ts`: public exports.
4. `cli/src/{commands/handler,providers/configured-providers,providers/provider-runtime,cli/model-list}.ts` and `rpc/rpc-server.ts`: environment/command/encrypted credentials, startup/listing, network settings, interactive and headless support.
5. `server/src/api/proxy.ts`: built-ins/adapters, usage persistence and all non-agent provider call paths.
6. `server/src/runtime/{model-catalog,provider-registry,provider-oauth}.ts` plus matching routes: custom lifecycle, secrets, discovery and OAuth.
7. `web/src/store/session-store.ts`, `services/api.ts` and `components/{SettingsView,EcosystemSettings}.tsx`: catalogue/defaults/admin UI.
8. Provider/Core/server/Web tests, intercepted API fixtures, Settings/axe/visual journeys and user/architecture documentation.

Do not assume every surface supports every provider automatically, but do not duplicate Core network or credential policy in a product adapter. Never expose access tokens/API keys. `providerApiKeyCommands` is operator-owned executable configuration: run it only through the bounded Core resolver, retain stdout only in process memory and register it with the shared redactor. Treat every remote model catalogue, JSON body, SSE event and WebSocket event as untrusted bounded input.

### Change messages, sessions, or JSONL entries

Update the shared type, JSONL reader/writer/append methods, `SessionManager`, CLI import/export, server serializers and routes, Web API/store hydration, and all fixtures. Explicitly test old persisted data when compatibility matters. Remember that JSON transports dates as strings while core uses `Date`.

### Add or change a CLI command

For conversational commands, update registry/tests in `commands/handler.*`, dispatch/completion in `cli/src/index.ts` and both TUI help surfaces. Standalone before-startup operations instead own strict parsers/help/process tests in `cli/src/cli/` and early dispatch in `index.ts`; preserve exact installed root-help equality and package/MCP behavior. Document user-visible commands in both `docs/users/{en,fr}/user-guide.md` and owning guides/navigation.

### Add or change an HTTP or streaming contract

Update `server/src/index.ts` or `server/src/api/proxy.ts`, the matching `web/src/services/api.ts` function, consuming store/component code, server tests, browser API tests, and documentation. Verify HTTP status, auth behavior, malformed input, transport framing, and serialization. Add live server integration coverage when Playwright's mocked API cannot prove the behavior.

### Change extensions, skills, prompts, or plugin packages

Shared extension contracts and the bounded module loader belong in `core/src/extensions`; shared package source validation, state, filters, locking, installation, checks and inventory belong in `core/src/plugins`. CLI orchestration belongs in `cli/src/{extensions,resources,security,cli/package-command.ts}`. Server package code must remain a thin API/runtime-composition adapter over Core; do not fork an installer or state schema there. Browser UI must stay declarative/text-only: never move command execution, arbitrary HTML/DOM or filesystem paths there. Preserve managed ownership, unload cleanup, response validation and atomic rollback. Project code/resources remain blocked until trusted, reads stay side-effect free, and skill downloads require bounded HTTPS plus SHA-256. Update `docs/contributors/{en,fr}/extensions-cli.md`, relevant Web contributor docs, and the bilingual resource/package user-guide sections.

### Change startup, packaging, native dependencies, or static assets

Check root scripts, package scripts, both `copy-assets.mjs` files, `web-cli.ts`, production Docker stages, native build/runtime libraries, executable permissions, and the relative location of `packages/web/dist`. `node-pty` requires its install script plus Python/C++ build tooling in dependency stages and compatible runtime libraries in the production image. Validate with a production image, not only TypeScript tests.

## 6. Coding and Contract Conventions

- TypeScript is strict and enables unused-symbol and implicit-return checks.
- Source is ESM (`"type": "module"`). Relative TypeScript imports use `.js` specifiers so emitted JavaScript resolves correctly.
- Use `import type` for type-only dependencies when practical.
- Keep public core APIs exported through `packages/core/src/index.ts`.
- Prefer shared typed contracts over duplicated ad hoc shapes, but do not expose server- or React-specific concerns from `core`.
- Keep implementation tests next to source as `*.test.ts` or `*.test.tsx`. Cross-package public-contract probes are the deliberate exception under `tests/functional-parity/`; the root Vitest config remains the canonical all-package configuration.
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
| `docs/ai/topics/session-sdk.md` | English | Agents | Versioned | High-level Core SDK ownership, lifecycle, safe copies and genuine public package/declaration proof |
| `docs/ai/topics/extensions.md` | English | Agents | Versioned | JavaScript extensions, packages, reload and declarative interactions |
| `docs/ai/topics/codemode.md` | English | Agents | Versioned | QuickJS isolation, budgets, nested authorization, branch store, settings and explicit limitations |
| `docs/ai/topics/cli-reference.md` | English | Agents | Versioned | Package/auth/export standalone commands, regular/fullscreen/print CLI, JSON events and JSONL RPC |
| `docs/ai/topics/server-api.md` | English | Agents | Versioned | REST, SSE, WebSocket and detached runtime contracts |
| `docs/ai/topics/web-app-architecture.md` | English | Agents | Versioned | React stores/components, browser persistence, PWA and validation |
| `docs/ai/topics/static-demo.md` | English | Agents | Versioned | Independent synthetic static demo, base-safe offline artifact, publication limits and Pages policy |
| `docs/ai/topics/linked-directories.md` | English | Agents | Versioned | Metadata-only inventory, exact read consent, independent trust and optional modal lifetime |
| `docs/ai/topics/security.md` | English | Agents | Versioned | Workspace trust, auth, secrets and executable-code boundaries |
| `docs/ai/topics/child-agents.md` | English | Agents | Versioned | Profiles, delegation limits, linked sessions and parent events |
| `docs/ai/acceptance/`, `docs/ai/workflows/` | English | Agents | Versioned | Acceptance criteria and task-specific documentation workflows |
| `docs/audit/documentation/AUDIT-1` | English | Agents + humans | Versioned | Current documentation audit; plain path intentionally omits `.md` |
| `docs/users/{fr,en}/` | French/English | End users | Versioned | Complete user guides, container guidance and language indexes |
| `docs/contributors/{fr,en}/` | French/English | Contributors | Versioned | Parallel architecture, extension, session SDK, public-contract/parity and i18n guides |
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
make test-parity     # Run focused public CLI/JSON/RPC/session/extension/SDK golden probes
make test-e2e        # Build the test image and run Playwright with Chromium
make test-coverage   # Optional full coverage run
make build-prod      # Build the complete production image
```

Use `make lockfile` after an intentional dependency or package metadata change; it regenerates `package-lock.json` in Docker.

The independent static demo has its own Docker target: `bash demo/run-docker.sh`, optionally with `DEMO_BASE=/` or `DEMO_BASE=/preview/AiHarness/`. It validates types, fixture/build/export policy, bounded static artifacts, eight Chromium journeys and 28 captures without starting the agent/backend. It publishes only validated generated `demo/dist/`; explicit updates export bounded screenshot deltas. See [static-demo.md](./topics/static-demo.md) for offline/deployment boundaries; local validation never enables Pages or deploys remotely.

For a focused Playwright test during iteration, pass arguments through the Makefile, for example `make test-e2e E2E_ARGS='e2e/performance.spec.ts -g "virtualise" --retries=0'`. The E2E container receives a 1 GiB shared-memory ceiling by default to prevent Chromium worker crashes; override `E2E_DOCKER_ARGS` only for a runner-specific need. Use `make test-parity` for the focused public-contract harness. For other focused Vitest work, use `make shell` and run the relevant npm command inside that container. Final validation should still use the standard targets below.

### Validation matrix

| Changed area | Minimum validation |
|---|---|
| Documentation only | Check claims/commands against source; run `make lint-docs` and `git diff --check` |
| Core types/providers/sessions/extensions | `make typecheck` and `make test` |
| CLI behavior/TUI/RPC/resources/security | `make typecheck`, `make test-parity`, and `make test` |
| Server/API/auth/credentials/WebSocket | `make typecheck` and `make test` |
| React components/store/API client/CSS | `make typecheck`, `make test`, and `make test-e2e` |
| Cross-package streaming or session flow | `make typecheck`, `make test`, and `make test-e2e` |
| Launcher, build scripts, dependencies, Docker, static asset serving | Relevant tests plus `make build-prod` |

Playwright starts Vite and a disposable real Express server. Most scenarios still isolate the browser with `e2e/fixtures/mock-api.ts`; `e2e/live-server.spec.ts` is the deliberate browser-to-server smoke path. Visual changes use Docker-generated Light/Dark desktop/tablet/mobile baselines under `e2e/*-snapshots/` with a 2 % pixel-diff ceiling. After reviewing changed baselines, `make sync-doc-screenshots` refreshes the subset embedded in human documentation. `make test-e2e` tests the baselines embedded in its freshly built image, retains the container until completion, then copies the HTML report, test artifacts and only added or byte-changed snapshot files back with `docker cp`, even after failure; unchanged source baselines are not copied, so concurrent cleanup cannot overwrite another run's newly generated images. The collector rejects linked artifacts and bounds count, depth and byte sizes; validate it in the test image with `node --test .docker/baseline-artifacts.test.mjs`. The test image adds CJK glyphs while `.docker/test-fonts.conf` preserves historical generic Latin/emoji fallbacks; validate these with `node --test .docker/test-fonts.test.mjs`, without restyling unrelated baselines. This avoids stale bind mounts in nested Docker environments and lets `E2E_ARGS='e2e/visual.spec.ts --update-snapshots=all'` update the working tree. Keep focused server tests for exhaustive auth, malformed input, credential and persistence behavior. A production Web build also runs `packages/web/scripts/check-bundle-budget.mjs`; a size regression above its eager, async or CSS limits is a build failure.

### Before finishing

1. Review `git diff -- <files-you-changed>` and `git diff --check`.
2. Confirm no unrelated user changes or generated files were modified.
3. Run the validation required by the matrix, or state clearly which commands could not run and why.
4. Summarize changed files, behavioral impact, and validation results.
