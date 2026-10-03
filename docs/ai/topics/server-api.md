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
| Tools/packages/resources | `/api/tools`, `/api/plugins`, `/api/skills`, `/api/push` |
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

## Session HTTP Invariants

1. Register `/tree` and `/search` before `/sessions/:id`.
2. Return metadata-only lists and bounded message windows.
3. Hydrate API dates as ISO strings; Core keeps `Date` values.
4. Generate full exports server-side rather than materializing all history in Web.
5. Require explicit recursive-cascade confirmation for sessions with descendants.
6. Treat IDs, cursors, cwd, upload names, and route bodies as untrusted.

## Associated Tests

- `packages/server/src/web-server.test.ts` — broad HTTP, auth, sessions, providers, files, PTY, packages and runtime integration
- `packages/server/src/api/session-pagination.test.ts` — bounded message windows and cursors
- `packages/server/src/security/request-security.test.ts` — roles, capabilities, origins, limits and WebSocket auth
- `packages/web/src/services/api.test.ts` — browser request/response contracts
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
