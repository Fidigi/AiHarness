# Server API and Transports

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

The Express server exposes authenticated REST, SSE, and legacy WebSocket chat; owns runtime services and persistence; and optionally serves the built Web bundle. Fixed session routes are declared before `/:id` routes, and domain routers are mounted under explicit `/api/*` prefixes.

The browser contract is summarized in [`web-app-architecture.md`](./web-app-architecture.md); session and event invariants live in [`sessions.md`](./sessions.md).

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/server/src/index.ts` | App composition, auth, legacy chat, sessions, sharing and static assets |
| `packages/server/src/runtime/services.ts` | Shared service construction, extension reload and shutdown |
| `packages/server/src/api/agent-routes.ts` | Detached runs, queues, state/events, interactions, commands and compaction |
| `packages/server/src/api/mcp-routes.ts`, `packages/server/src/runtime/mcp-inventory-service.ts` | Canonical workspace adapter for Core's redacted MCP inventory and admin-only local mutations; bounded opaque undo storage |
| `packages/server/src/api/*-routes.ts` | Workspace, files, terminals, configuration, models, tools, packages and child agents |
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
| Workspaces/files | `/api/workspaces/default|validate|browse|trust|worktrees`; `/api/files`, content/download/index/upload/watch and Git status/diff |
| Terminals | `/api/terminals` plus per-terminal events/input/resize/delete |
| Configuration | `/api/configuration` and legacy `/api/settings` alias; effective values include provenance |
| Models | `GET /api/models`; `PATCH /api/models/enabled` |
| Provider registry | `/api/provider-registry/auth`, OAuth flows, tests, custom providers and custom models |
| MCP configuration | `GET /api/mcp` for global configuration; optional canonical `?cwd=` adds trust-gated project data; `POST /api/mcp/actions` performs admin-only activation/removal/restoration |
| Tools/packages/resources | `/api/tools`; `/api/plugins` plus `PATCH /api/plugins/enabled`; `/api/skills`; `/api/push` |
| Child agents | settings; profile list/create/update/delete/duplicate; run list/start/get/stop/acknowledge under `/api/subagents` |
| Legacy chat | `POST /api/chat`, `/stream`, `/compact`; WebSocket upgrade at `/api/chat/ws` |

`GET /api/sessions/:id/export` is a read, not a POST. Detached state and SSE are keyed by `sessionId`, while stop and queue mutations are keyed by `runId`. Child runs use `/api/subagents/runs`, not `/spawn` or a generic `/:id` route.

## Detached Agent Flow

```text
POST /api/agent/runs
  -> canonical trusted cwd + effective scoped configuration
  -> create/reuse session and persist user input
  -> AgentRuntime continues after HTTP 202
  -> GET /sessions/:sessionId/state?messageLimit=80
  -> GET /sessions/:sessionId/events?after=<sequence> (SSE)
```

The run applies/removes only declared session overrides. Provider/tool turns, automatic compaction, queues, retries, extension interactions, and persistence share one AbortSignal and sequenced journal.

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

## MCP Configuration Invariants

`GET /api/mcp[?cwd=<absolute-or-tilde-path>]` requires `workspace:read`, resolves a supplied cwd through `WorkspaceManager`, sets `Cache-Control: no-store`, and delegates all parsing/redaction policy to Core. Without a cwd it returns only `<data-dir>/mcp.json`. With a cwd it always returns project trust/file metadata, but opens `.ai-harness/mcp.json` only for an effective persisted allow (`decision: true`, exact or inherited). A missing decision, explicit refusal or unreadable store produces a locked project file descriptor while the safe global inventory remains available.

The response contains file existence/read flags, opaque keyed revisions and typed diagnostics, redacted server descriptors, exact-name global/project shadowing, and trust provenance. It contains no env/header values or source excerpts. Listing is not a connectivity probe: it must not expand references, run command-backed values, spawn stdio, make HTTP requests, initialize OAuth, or read/create an OAuth store.

`POST /api/mcp/actions` additionally requires the administrator-only `configuration` capability and the standard mutation Origin check. Its strict union accepts `set-enabled` with one to 100 unique names, `remove` with one name, or `restore` with an opaque token. Core reopens current bytes under its lock, checks the supplied revision, validates trust and file safety, then commits at most one atomic replacement. Project actions require a fresh persisted allow before reading and again before commit. Responses contain a newly redacted inventory and value-free outcomes; removal adds only a random token and expiry. Literal removed entries stay in a server-only FIFO capped at 100 records and are physically expired after 60 seconds. Restore consumes a token once, refuses stale content/name conflicts, and rechecks project trust.

Error bodies contain a fixed code and `uncertain` flag. A stale or policy refusal is known not to have committed; an unexpected failure at or after rename is uncertain. HTTP clients must reload after uncertain failures or timeouts rather than assuming rollback. This route still cannot add/import/edit servers, change exposure, test/connect, resolve values, start a process, contact a URL or initialize OAuth.

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

- `packages/server/src/web-server.test.ts` — broad HTTP, auth, sessions, providers, files, PTY, MCP trust/redaction/admin mutation/opaque undo, packages and runtime integration
- `packages/server/src/api/session-pagination.test.ts` — bounded message windows and cursors
- `packages/server/src/security/request-security.test.ts` — roles, capabilities, origins, limits and WebSocket auth
- `packages/web/src/services/api.test.ts` — browser request/response contracts, including MCP typed certainty/timeouts and one-request package group activation
- `e2e/live-server.spec.ts` — Vite to real Express/mock provider/JSONL smoke flow
- `e2e/chat.spec.ts`, `e2e/sessions.spec.ts`, and `e2e/settings.spec.ts` — mocked browser protocol flows

## Common Changes

### Add or change an endpoint

Update the owning router, capability/origin validation, Web API client, malformed-input/auth server tests, fixtures, and live integration when mocks cannot prove behavior.

### Change SSE or snapshots

Update Core event types/journal, AgentRuntime writer, state serializer, browser parser/store, fixtures, reconnection tests, and this document together.

### Change startup or static serving

Check `web-cli.ts`, option precedence, package scripts, Docker stages, asset copying, browser opening, loopback defaults, production image, and graceful shutdown.

## Related Domains

- [`sessions.md`](./sessions.md) — persistence, pagination and compaction
- [`providers.md`](./providers.md) — proxy, registry, OAuth and usage
- [`extensions.md`](./extensions.md) — plugin reload and interactions
- [`web-app-architecture.md`](./web-app-architecture.md) — consuming API/SSE contracts
- [`security.md`](./security.md) — authentication, capabilities and workspace boundaries
