# Security and Trust Boundaries

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Security spans canonical workspace resolution, explicit project trust, HTTP/WebSocket authorization, secret storage, executable packages/extensions, and safe browser rendering. Every external path, ID, credential, package source, provider response, and extension payload is untrusted.

Review [`server-api.md`](./server-api.md) for route guards and [`extensions.md`](./extensions.md) before changing executable-code loading.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/security/workspace-manager.ts` | Allowed roots, realpath boundary, file kind and Git/worktree operations |
| `packages/core/src/security/project-trust.ts` | Canonical project allow-list in `~/.ai-harness/trust.json` |
| `packages/server/src/security/request-security.ts` | Roles, capabilities, Origin checks, limits, WebSocket auth and safe errors |
| `packages/server/src/security/credential-store.ts` | Optional AES-GCM encrypted credential persistence |
| `packages/server/src/runtime/provider-registry.ts` | Separation of custom-provider metadata and secrets |
| `packages/cli/src/security/oauth-device.ts` | CLI provider OAuth Device Flow |
| `packages/core/src/extensions/module-loader.ts` | Bounded, symlink-free executable module discovery |

## Authentication and Capabilities

| Identity | Capabilities |
|---|---|
| Anonymous when auth is configured | None; protected `/api` requests return 401 |
| User token/session | `chat`, `sessions`, `workspace:read`, `files:read` |
| Admin token/session | User capabilities plus workspace/file writes, terminal, configuration, credentials and packages |
| No configured tokens | Local requests receive admin capabilities; bind policy still applies |

`AI_HARNESS_AUTH_TOKEN` identifies a user when a distinct admin token is configured. `AI_HARNESS_ADMIN_TOKEN` identifies an admin and falls back to the user token when omitted, so a lone auth token has admin capabilities. Browser login exchanges a token for a random in-memory `aih_session` cookie with `HttpOnly`, `SameSite=Strict`, expiry, and `Secure` on HTTPS. The Settings compatibility path may instead keep an explicitly entered Bearer token in per-tab `sessionStorage`.

Origin checks cover mutations and WebSocket upgrades. Browser WebSockets use cookie auth or an encoded subprotocol token; a query token remains compatibility-only.

## Workspace Boundary

```text
browser/CLI path
  -> WorkspaceManager.resolve (tilde, absolute path, realpath, allowed root, kind)
  -> ProjectTrustManager.isTrusted(canonical cwd)
  -> operation-specific capability and trust check
  -> file/Git/command/agent/PTY work
```

Trust is a global canonical-path allow-list stored atomically in `~/.ai-harness/trust.json`; it is not a project marker such as `.ai-harness/trusted`. Symlinks may not escape allowed roots. Never pass a browser-supplied path directly to `fs`, Git, a shell, PTY, package installer, or AgentRuntime.

Read-only workspace browsing still requires `workspace:read`; dangerous writes/execution additionally require admin capabilities and, where applicable, project trust.

## Secret Storage

| Data | Persistence |
|---|---|
| Built-in provider credentials | `credentials.enc` only with `AI_HARNESS_MASTER_KEY`; otherwise memory |
| Custom provider secrets | `provider-secrets.enc` only with master key; otherwise memory |
| Push private key/subscriptions | `push.enc` only with master key; otherwise volatile |
| Non-secret configuration | Atomic `config.json`, `providers.json`, `plugins.json`, `subagents.json` |

Never expose provider keys, OAuth tokens, server-side authorization headers, passwords, master keys, VAPID private keys, or subscriptions through API responses, diagnostics, logs, sessions, fixtures, browser storage, or command recovery. The explicit compatibility Bearer is the narrow exception: it may live only in per-tab `sessionStorage`, never `localStorage`, workspace caches, logs, or documentation. Session/provider serializers redact secret-like config fields, but callers must still avoid placing secrets in generic metadata.

## Executable Extensions and Packages

- Load project code/resources only after trust.
- Refuse symlinked extension modules and modules over 5 MiB.
- Keep GET catalogues metadata-only and side-effect free.
- Parse only supported npm, HTTPS Git, and allowed local sources.
- Disable npm lifecycle scripts and use shallow Git clones in staging.
- Validate a complete candidate before atomic replacement; preserve or clear the previous generation according to workspace context.
- Exclude resource bodies, source code, command output, and credentials from diagnostics.

These controls reduce exposure; they do not sandbox trusted third-party JavaScript from the server OS user.

## Browser Content Security

- Render extension widgets as text and interactions from a fixed schema.
- Sanitize supported Markdown/KaTeX/Mermaid output; keep raw HTML non-executable.
- Validate uploads by count, size, name, collision policy, and canonical destination.
- Store provider credentials only server-side; bounded session caches explicitly strip key-like fields.
- Use focus traps and safe cancellation/reconnection for extension dialogs; accessibility behavior is part of the security contract.

## Network Boundary

The launcher binds to `127.0.0.1` by default. A non-loopback bind without authentication is rejected unless the explicit insecure override is set. Public deployment still requires a trusted HTTPS reverse proxy or private network, correct allowed origins, and proxy-level request limits.

## Associated Tests

- `packages/core/src/security/workspace-manager.test.ts` — roots, realpath, symlinks, Git and worktrees
- `packages/cli/src/security/project-trust.test.ts` — persisted trust behavior
- `packages/cli/src/security/oauth-device.test.ts` — bounded OAuth polling and cancellation
- `packages/server/src/security/request-security.test.ts` — tokens, cookies, capabilities, Origin, limits and upgrades
- `packages/server/src/security/credential-store.test.ts` — encryption, permissions and memory-only fallback
- `packages/server/src/web-cli.test.ts` — bind/auth launcher policy
- `packages/server/src/web-server.test.ts` and `e2e/live-server.spec.ts` — end-to-end route/workspace/secret boundaries

## Common Changes

### Add a capability or protected route

Update `ApiCapability`, role sets, route middleware, browser behavior, and anonymous/user/admin plus Origin tests.

### Change paths, files, commands, or PTYs

Resolve through `WorkspaceManager`, require the correct capability/trust state, bound all input/output, and test traversal, escaping symlinks, mismatched workspace IDs, and cancellation.

### Change secret persistence

Keep non-secret metadata separate, require master-key encryption for disk persistence, use atomic restrictive files, redact diagnostics, and test restart plus no-key behavior.

## Related Domains

- [`server-api.md`](./server-api.md) — middleware and protected route families
- [`extensions.md`](./extensions.md) — executable modules, packages and declarative UI
- [`sessions.md`](./sessions.md) — serialization and redaction
- [`providers.md`](./providers.md) — credentials, OAuth and untrusted catalogues
