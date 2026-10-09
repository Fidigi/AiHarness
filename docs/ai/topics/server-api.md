# Server API and Transports

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

The Express server exposes authenticated REST, SSE, and legacy WebSocket chat; owns runtime services and persistence; and optionally serves the built Web bundle. Fixed session routes are declared before `/:id` routes, and domain routers are mounted under explicit `/api/*` prefixes.

The browser contract is summarized in [`web-app-architecture.md`](./web-app-architecture.md); session and event invariants live in [`sessions.md`](./sessions.md).

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/server/src/index.ts` | App composition, auth, legacy chat, sessions, sharing and static assets |
| `packages/server/src/runtime/services.ts` | Shared service construction, Core `McpSessionHost` injection, extension reload and bounded shutdown |
| `packages/server/src/api/agent-routes.ts` | Detached runs, queues, state/events, interactions, commands and compaction |
| `packages/server/src/api/mcp-routes.ts`, `packages/server/src/runtime/mcp-inventory-service.ts` | Canonical workspace adapter for Core's redacted MCP inventory, explicit bounded one-shot Test, non-mutating import/replacement preview and atomic local actions; owns capability/shape checks, explicit Core OAuth status/start/poll/paste/cancel/logout adapters, config-keyed Test plus persistent-runtime status decoration, shutdown and bounded opaque undo storage |
| `packages/server/src/api/{workspace-routes,workspace-file-manager}.ts` | Bounded workspace browsing/direct-child creation, Git worktree force classification, and loopback-only host file-manager policy |
| `packages/server/src/api/*-routes.ts` | Files, terminals, configuration, models, tools, packages and child agents |
| `packages/server/src/api/websocket.ts` | Minimal RFC 6455 legacy chat transport |
| `packages/server/src/security/request-security.ts` | Auth context, capabilities, Origin checks, limits and safe errors |
| `packages/server/src/web-cli.ts` | Combined API/static production launcher |

## Route Families

| Prefix | Representative contracts |
|---|---|
| Public/auth | `GET /health`, `GET /share/:token`, `GET /api/auth/status`, `POST /api/auth/login|logout` |
| App status | `GET /api/app-update` with optional refresh query |
| Sessions | `GET|POST /api/sessions`; fixed `/tree`, `/search`; `GET|PATCH|DELETE /:id`; messages/info/export/share/fork/clone/auto-name |
| Agent | `POST /api/agent/runs`; `GET /runs/:runId`; stop/queue; `/sessions/:sessionId/state|events|compact|capabilities|extensions|commands|interactions` |
| Workspaces/files | `/api/workspaces/default|validate|browse|file-manager|trust|worktrees`; `/api/files`, content/download/index/upload/watch and Git status/diff |
| Terminals | `/api/terminals` plus per-terminal events/input/resize/delete |
| Configuration | `/api/configuration` and legacy `/api/settings` alias; effective values include provenance |
| Models | `GET /api/models`; `PATCH /api/models/enabled` |
| Provider registry | `/api/provider-registry/auth`, OAuth flows, tests, custom providers and custom models |
| MCP configuration | `GET /api/mcp` for global configuration; optional canonical `?cwd=` adds trust-gated project data and fresh volatile Test/runtime status; admin-only `POST /api/mcp/test` connects one fresh file entry once; `/preview` reparses paste without writing; `/actions` performs atomic import/replacement or local mutations. Agent runs use a separate Core-owned persistent host, not these administration routes |
| Tools/packages/resources | `/api/tools`; `/api/plugins` plus `PATCH /api/plugins/enabled`; `/api/skills`; `/api/push` |
| Child agents | settings; profile list/create/update/delete/duplicate; run list/start/get/stop/acknowledge under `/api/subagents` |
| Legacy chat | `POST /api/chat`, `/stream`, `/compact`; WebSocket upgrade at `/api/chat/ws` |

`GET /api/sessions/:id/export` is a read, not a POST. Detached state and SSE are keyed by `sessionId`, while stop and queue mutations are keyed by `runId`. Child runs use `/api/subagents/runs`, not `/spawn` or a generic `/:id` route.

Workspace descriptors returned by `default`, `validate` and worktree creation distinguish resource-sensitive `trusted` from `operationTrusted`. The latter is true only for a readable persisted allow decision and is the gate clients must use before agent, file, terminal or project-configuration operations; a fresh folder that currently has no trust-requiring resource can therefore be `trusted: true` while remaining `operationTrusted: false`.

## Workspace Filesystem Invariants

`GET /api/workspaces/browse` canonicalizes the directory through Core and returns at most 500 entries plus `truncated`. `POST /api/workspaces/browse` requires `workspace:write`, accepts exactly bounded `{ parent, name }`, and asks Core to create one direct child only. Separators, traversal names, control/format characters, escaping links, existing targets and unknown request keys are rejected with stable codes.

`GET /api/workspaces/file-manager` is a no-store availability probe. `POST` additionally requires `workspace:write`, accepts exactly `{ cwd }`, resolves that directory through `WorkspaceManager`, and launches only when both the HTTP Host and socket peer are loopback and the platform is macOS, Windows or Linux. Core passes one argument to a platform command without a shell, bounds startup, and allowlists desktop environment variables rather than inheriting provider/server secrets. Unsupported, remote, invalid-path and launch failures are explicit and do not expose process details.

Worktree removal first rejects local changes as `409 force-required`. The browser must obtain a second explicit confirmation and resend `force: true`; Core canonicalizes linked paths against the repository worktree inventory before invoking Git.

## Detached Agent Flow

```text
POST /api/agent/runs
  -> canonical trusted cwd + effective scoped configuration
  -> create/reuse session; register detached run and return HTTP 202
  -> Core rereads MCP config/trust and awaits eligible direct connections
  -> persist user input only if preparation was not stopped
  -> AgentRuntime continues provider/tool work
  -> GET /sessions/:sessionId/state?messageLimit=80
  -> GET /sessions/:sessionId/events?after=<sequence> (SSE)
```

The run applies/removes only declared session overrides. Provider/tool turns, MCP preparation/invocation, automatic compaction, queues, retries, extension interactions, and persistence share one AbortSignal and sequenced journal. Stopping during MCP preparation releases that session's host records and does not persist the unsent user input. Interrupted tool results and completed nested usage are persisted before the journal's terminal stop event; cleanup never starts automatic compaction or another model request. Stop waits at most five seconds for durable settlement. If a privileged extension ignores abort, the acknowledgement returns the still-nonterminal run snapshot so clients keep replaying rather than resynchronizing too early; queues and new dialogs are already refused/cancelled, and another run cannot reuse that session until cleanup settles. Core's immediate `stop()` cancellation acknowledgement is distinct from `wait()` and the authoritative state/replay snapshot.

`PATCH /api/sessions/:id` can change `thinking` while an agent is active. Immediately before each provider/tool-loop turn and queued prompt, Core calls the host's `resolveThinking` policy on the latest session; Server reapplies the same session/project/global/environment precedence as startup. `thinking: null` restores inheritance, invalid levels fail without mutation, and `max` maps to the supported provider level `xhigh`. A request already in flight keeps its captured options; changing reasoning neither restarts nor stops the run and does not change its provider/model.

### Current event contract

Events include `run.started`, `run.phase`, `message.start|delta|completed`, `tool.started|completed`, `queue.updated`, `retry.scheduled`, `compaction.completed`, `subagent.*`, and `extension.ui`; SSE begins with `connection.ready`. Sequence IDs, snapshot reset, partial-message restoration, and no-duplicate replay are one cross-package contract.

Underscore events such as `message_start`, `text_delta`, and `message_end` belong only to legacy chat compatibility.

## Authentication and Authorization

- Without configured auth tokens, requests receive admin capabilities; non-loopback binding is still guarded by launcher policy.
- Bearer tokens or opaque `aih_session` HttpOnly cookies establish `user` or `admin` roles.
- User capabilities cover chat, sessions, workspace read, and file read; admin adds writes, terminals, configuration, credentials, and packages.
- Origin checks protect mutations and WebSocket upgrades.
- Route and login limiters are in-process; production replicas also need proxy-level limits.
- Safe errors hide unexpected server details.

See [`security.md`](./security.md) before changing credentials, capability guards, workspace paths, uploads, terminals, or package routes.

## Tool Settings and Sandbox

`GET /api/tools[?cwd=...&projectId=...]` returns selected tool descriptors, availability and visible restriction/conditional reasons (`chat-only`, `read-only`, `not-selected`, `hidden`, `automatic`, `sandbox-unavailable`), plus `codemode: { enabled, mode, inlineBudget, selfTest: { state, engine } }`. Selection is not the same as effective permission under a preset. The health result comes from a fixed-script startup self-test cached per process; GET does not execute user source or start another test.

Administrator `PATCH /api/tools` accepts the existing `enabledTools`, `toolPreset`, `powershellEnabled`, optional canonical `cwd`/`projectId`, and optional `codemodeEnabled` (boolean), `codemodeMode` (`on`/`only`) and `codemodeInlineBudget` (integer 0–3000). Unknown fields and invalid budgets fail before atomic scoped persistence; the response is canonical readback. Global/project values use normal effective-configuration precedence. Web Automatic mode does not turn an allowlist entry into activation: eligible indirect tools are required. Failed/unavailable self-test disables Web execution. The [Core sandbox contract](./codemode.md) defines VM, nested-call, cancellation and transactional store boundaries; guest isolation does not sandbox real host tools.

## MCP Configuration Invariants

The passive overview additionally reports `command: { owner, extensionId?, conflict }` from the current extension generation. An extension owning `/mcp` replaces its builtin palette entry; Web revalidates ownership on submission (including while streaming) and invokes that owner. Only bare, unowned `/mcp` navigates to the focused Settings section. Navigation neither stops the run nor queues a provider prompt. Command conflicts do not alter MCP transport state; Settings identifies the owner, and unload restores builtin navigation. Interactive CLI likewise dispatches an owned `/mcp` before its builtin and restores management after unload; a second extension owner is rejected. Other builtin command precedence is unchanged.

`GET /api/mcp[?cwd=<absolute-or-tilde-path>]` requires `workspace:read`, resolves a supplied cwd through `WorkspaceManager`, sets `Cache-Control: no-store`, and delegates all parsing/redaction policy to Core. Without a cwd it returns only `<data-dir>/mcp.json`. With a cwd it always returns project trust/file metadata, but opens `.ai-harness/mcp.json` only for an effective persisted allow (`decision: true`, exact or inherited). A missing decision, explicit refusal or unreadable store produces a locked project file descriptor while the safe global inventory remains available.

The response contains file existence/read flags, opaque keyed revisions and typed diagnostics, redacted server descriptors, exact-name global/project shadowing, trust provenance, and only a value-free eligibility/reason for a possible fresh-project first-write transaction. Internal breadth paths are not serialized. It contains no env/header values or source excerpts. Listing itself is not a connectivity probe: it never resolves or opens a transport, and the exact inventory GET bypasses credential initialization without opening or creating an OAuth store. A prior Test may add volatile `testStatus`, and the shared agent host may add volatile `runtimeStatus`, only while the entry's scope/source/name/config key still match; an observed edit drops stale status.

`POST /api/mcp/test` requires the administrator-only `configuration` capability and mutation Origin check. Its strict body is exactly `{ scope, name, cwd? }`; configuration, headers, commands, URLs, revisions and unknown keys from the browser are rejected. Server canonicalizes cwd through `WorkspaceManager`, then Core rereads the selected global or trust-gated project entry from disk, revalidates schema and any configured cwd/trust, and may test a disabled entry. Identical in-flight targets join; tests whose runtime env/header values invoke `!command` share one bounded queue. Test never resolves OAuth client secrets. Core resolves only the fresh entry, filters the stdio child environment, connects stdio or Streamable HTTP, lists paginated tools/resources/templates/prompts under item/page/request/whole-test bounds, and always closes with a bounded wait. A 401 returns `needs-auth` but does not start OAuth. The response is `{ scope, name, configKey, result }`, where result contains only redacted/bounded state, timing, cwd/server identity, capability counts, tool name/one-line description/read-only hint/exposure, and optional stderr/error/timeout/truncation flags. Test never invokes tools or persists credentials. Target refusals use fixed `invalid-request`, `trust-required`, `trust-unavailable`, `config-unavailable`, `server-not-found`, `server-invalid` or `working-directory-unavailable` codes.

Agent execution does not call `/api/mcp/test`. Before each prompt, the Core host rereads the same inventory/targets and persisted trust, closes stale records, and keeps unchanged exact stdio/HTTP connections per session. It awaits any effective direct exposure under the connection deadline; `codemode` and `deferred` do not delay the prompt or expose direct definitions. `toolExposure` overrides the server default by exact remote name; hidden tools are absent from declaration, discovery and nested execution. Wholly hidden servers do not connect for prompts unless a non-hidden override makes them eligible. Exposure writes invalidate prior config-keyed Test/runtime status. If an eligible indirect source exists, Core can declare `tool_search` and the policy-eligible Automatic `codemode` helper; bounded BM25 lookup waits abortably for metadata on demand and adds only deferred definitions on the next provider turn. Codemode-exposed tools remain script-only. Search activation is persisted on the tool-result message, follows the active session branch across durable resume and fork, and is re-filtered against current preset, allowlist, exclusions, extension ownership and MCP `readOnlyHint`. Calls omitted from that turn's fixed declaration set remain rejected, including a discovered tool called beside its search. Static, discovered and direct MCP tools use the same loadout and extension hook/event pipeline without mutating the registry. MCP calls use deterministic collision-safe `mcp__<server>__<tool>` names, bounded input/output, credential redaction, cancellation and per-call timeout. Tool-list notifications refresh future declarations. An explicit post-prompt idle window, stop/session release and server shutdown bound connection/process lifetime. Session capabilities may include `mcpToolCount`; Settings receives only redacted volatile states. Stored MCP OAuth state is used/refreshed through Core's passive provider factory without starting interactive authorization. The separate bounded QuickJS helper shares the same hosted hooks, selected dynamic source and current read-only checks without declaring script-only candidates directly.

`POST /api/mcp/preview` requires the administrator-only `configuration` capability and standard mutation Origin check, but has no write capability. Its strict body is `{ text, syntax?, cwd?, replacement? }`: the browser supplies original text, never a trusted normalized configuration, and optional `syntax` is exactly `foreign` or `aiharness` (default `foreign`). `replacement`, when present, is exactly `{ scope, name, revision }`; Server verifies fresh project trust, target validity and the opaque revision before excluding only that target from same-scope name-collision notes. Both route and Core enforce the 256 KiB UTF-8 limit; Core additionally caps the preview at 20 servers, 128 fields, depth 64, 128 collection items, 256 shell words and 16 KiB per string/word. Server passes only host environment names and a fresh redacted inventory into Core. The response exposes structural field names, masked targets, variable names, fixed diagnostics and per-scope reasons/confirmations—never current target values, env/header/OAuth values, literal arguments/secrets, source excerpts or writable normalized configuration. It sets `Cache-Control: no-store` and cannot write, resolve, execute, contact a URL, initialize OAuth or open/create a credential store.

`POST /api/mcp/actions` additionally requires the administrator-only `configuration` capability and the standard mutation Origin check. Its strict union accepts `import`, `replace`, `set-enabled` with one to 100 unique names, `set-exposure` with one name, exactly `direct`, `codemode`, `deferred` or `hidden`, and optional `tool` (exact remote name) for a `toolExposure` override, `remove` with one name, or `restore` with an opaque token. Import requires `{ scope, revision, text, syntax, entryIndex }` plus optional bounded `name`, `values`, `secretReferences`, `confirmations`, `cwd` and the literal `trustProject: true`; replacement requires the same fields except `trustProject`, plus `targetName`. `trustProject` is valid only for project scope with `revision: null` and represents the separate fresh-folder confirmation shown by preview. Both actions explicitly reject a `configuration` object and unknown/prototype-smuggled keys. Server gives Core only environment names. Core reparses the original text, applies values only to rediscovered missing fields, rechecks schema/shell/reference/secret policy, and requires literal-secret and exact remote-variable approvals where applicable. Ordinary project actions require a fresh persisted allow before reading and again before commit. For a confirmed first import, Core instead holds the trust-store heartbeat lock, revalidates canonical identity/resources/nearest decisions and bounded broad/nested reach, persists one exact allow, rechecks after acquiring the MCP lock, and commits the first project file. The nested scan is fail-closed on links, special types, read/identity races, more than 256 inspected paths, more than 2,000 directories or depth beyond four; a nested subtree protected by its own nearest decision does not silently inherit the new allow. Write failure removes only that decision; rollback failure returns `trustKept: true`. `replace` changes or renames exactly one valid target in place, removes omitted fields, preserves root/sibling fields, rejects name collisions and leaves exact no-ops byte-stable. Import responses add only selected `scope`/`name`; replacement adds only `scope`/`previousName`/`name`; both accompany a newly redacted inventory. Activation responses carry value-free outcomes; exposure returns only the newly redacted inventory; removal adds only a random token and expiry. Literal removed entries stay in a server-only FIFO capped at 100 records and are physically expired after 60 seconds. Restore consumes a token once, refuses stale content/name conflicts, and rechecks project trust.

Preview rejects unknown body keys, invalid cwd/syntax/text and oversize text as `invalid-request`; unexpected failures use the fixed `preview-failed` code. Import additionally classifies incomplete fields, invalid reparsed entries, blocked scopes, reserved variables, missing confirmations, `folder-not-fresh`, `trust-too-broad` and `trust-unavailable` without returning values. Action error bodies contain a fixed code and `uncertain` flag, plus `trustKept: true` only when an exact combined-transaction rollback itself failed. A stale or policy refusal is known not to have committed; an unexpected failure at or after rename is uncertain. HTTP clients discard revision-backed controls and reload both inventory and selected-workspace trust after write failures, network errors or timeouts rather than assuming rollback or mutating trust optimistically. Preview/actions can append one reviewed import, replace one valid entry and change local metadata, but remain unable to resolve or connect. `/test` is the separate explicit bounded diagnostic exception; it can resolve the selected entry and connect once, but cannot initialize OAuth, write credentials or invoke tools. Agent session hosting occurs only in the Core runtime path described above, never as a side effect of an administration route.

### Explicit MCP OAuth

All `/api/mcp/oauth/*` routes require `workspace:read` plus administrator `configuration` capability, use no-store responses, and retain credentials server-side. Mutations also pass the standard Origin check. Missing master-key-backed storage returns `503 oauth-unavailable`; no plaintext fallback exists. Core owns the encrypted manager, SDK providers and detached flow registry; Server only canonicalizes workspace/target requests and presents stable public state.

| Method/path | Strict input and public result |
|---|---|
| `POST /api/mcp/oauth/status` | `{ servers: [{ scope, name, configKey }], cwd? }`; revalidate each bounded selector and return matching boolean statuses, never credentials or URLs |
| `POST /api/mcp/oauth/start` | `{ scope, name, configKey, cwd? }`; revalidate eligible enabled HTTP target, join/start detached flow, return phase/flow ID/expiry and optional authorization/callback URLs |
| `GET /api/mcp/oauth/flows/:flowId` | Poll phase and bounded stable outcome/failure; no tokens, client secrets or verifier |
| `POST /api/mcp/oauth/flows/:flowId/redirect` | `{ redirectUrl }`; accept only the full matching loopback origin/path/state/code |
| `DELETE /api/mcp/oauth/flows/:flowId` | Cancel discovery/authorization/exchange/verification independently of the originating HTTP request |
| `POST /api/mcp/oauth/logout` | `{ scope, name, configKey, cwd? }`; invalidate old writers, remove credential material, retain an encrypted non-secret revocation marker and close matching process-local host connections |

Flows expire after five minutes, retain terminal state for one minute, and are capped at 32 active/100 retained. The callback binds only `127.0.0.1` at `/oauth/callback`; pasted redirects support browsers running on another host. Core rereads configuration/trust/path/config key before writes and post-login passive MCP verification. SDK discovery/PKCE/configured-client or DCR/exchange/refresh, response/deadline bounds, provider-local CAS snapshots, random revisions and logout generations are detailed in [`security.md`](./security.md). Logout does not revoke issuer-side tokens. One-shot Test remains OAuth-free; only explicit start may publish an authorization URL.

## Plugin Group Mutation

`PATCH /api/plugins/enabled` accepts one to 100 unique `{ key, scope, enabled }` selectors plus canonical workspace context. It requires the `packages` capability and the normal mutation Origin check. The Server adapter validates shape only; Core owns lookup, trust, locking, rollback and persistence. Allowed entries are committed in one atomic state write, while ordered outcomes report changed, unchanged, missing and trust-refused entries independently. Project enables require resolved trust; project disables remain available for cleanup. The returned catalogue reflects the committed state, resource selectors are untouched, and `reloadRequired` tells Web when executable extension changes need the separate atomic reload endpoint. An untrusted project cleanup is conservatively flagged without reopening package files, because a prior trusted runtime generation may still contain its code.

## Session HTTP Invariants

1. Register `/tree` and `/search` before `/sessions/:id`.
2. Return metadata-only lists and bounded message windows.
3. Hydrate API dates as ISO strings; Core keeps `Date` values.
4. Generate full exports server-side rather than materializing all history in Web.
5. Require explicit recursive-cascade confirmation for sessions with descendants.
6. Treat IDs, cursors, cwd, upload names, and route bodies as untrusted.

## Associated Tests

- `packages/server/src/web-server.test.ts` — broad HTTP, auth, sessions, providers, files, PTY, MCP Test fresh-target/config-smuggling/trust/redaction/status behavior, import-and-replacement preview/persistence/exposure/admin mutation/opaque undo, packages and runtime integration
- `packages/server/src/api/mcp-oauth-routes.test.ts` and `packages/core/src/mcp/{oauth,oauth-provider-factory,oauth-flow,oauth-integration}.test.ts` — passive inventory, explicit routes, unavailable storage, bounded public state, paste/cancel/logout guards, SDK discovery/PKCE/DCR/callback/refresh and token non-disclosure
- `packages/server/src/api/tool-settings.test.ts` and `packages/core/src/tools/codemode.test.ts` — cached sandbox health, exact scoped settings/readback, visible reasons, budgets and nested execution
- `packages/server/src/api/session-pagination.test.ts` — bounded message windows and cursors
- `packages/server/src/security/request-security.test.ts` — roles, capabilities, origins, limits and WebSocket auth
- `e2e/settings.spec.ts` — browser Test request minimality plus identity/cwd/capability/tool reporting; import/replacement/local mutation and focus flows
- `e2e/live-server.spec.ts` — Vite to real Express/mock provider/JSONL smoke flow
- `e2e/chat.spec.ts` and `e2e/sessions.spec.ts` — mocked conversation protocol flows

## Common Changes

### Add or change an endpoint

Update the owning router, capability/origin validation, Web API client, malformed-input/auth server tests, fixtures, and live integration when mocks cannot prove behavior.

### Change SSE or snapshots

Update Core event types/journal, AgentRuntime writer, state serializer, browser parser/store, fixtures, reconnection tests, and this document together.

### Change startup or static serving

Check `web-cli.ts`, option precedence, package scripts, Docker stages, asset copying, browser opening, loopback defaults, production image, and graceful shutdown.

## Related Domains

- [`codemode.md`](./codemode.md) — shared sandbox execution and health
- [`sessions.md`](./sessions.md) — persistence, pagination and compaction
- [`providers.md`](./providers.md) — proxy, registry, OAuth and usage
- [`extensions.md`](./extensions.md) — plugin reload and interactions
- [`web-app-architecture.md`](./web-app-architecture.md) — consuming API/SSE contracts
- [`security.md`](./security.md) — authentication, capabilities and workspace boundaries
