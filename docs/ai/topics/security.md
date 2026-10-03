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
| `packages/core/src/tools/workspace-tools.ts` | Shared CLI/Web path resolution, mutation trust gates, exact edits, bounded searches and command execution |
| `packages/core/src/prompts/instruction-context.ts` | Shared trust-separated, bounded, regular-file-only instruction and system-prompt resolution |
| `packages/core/src/config/pi-settings.ts` | Bounded no-follow settings reads, schema filtering, trust-gated layers, global-only policy and value-free diagnostics |
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

Read-only workspace browsing still requires `workspace:read`; dangerous writes/execution additionally require admin capabilities and, where applicable, project trust. In the CLI, the same Core tools are rooted at the startup cwd: `read`, `grep`, `find`, and `ls` remain read-only, while `bash`, direct `!`/`!!`, `edit`, and `write` require the current canonical workspace to be trusted. Core process execution shared by CLI, RPC and Web filters API keys, access keys, tokens, secrets, authorization/cookie/password/credential-like parent environment names before spawning children; do not bypass it with raw `spawn` for agent- or user-controlled commands. Cancellation terminates the process group on POSIX and the process tree through `taskkill` on Windows, then escalates after a grace period.

Instruction text is executable only in the model-policy sense, but it is still untrusted input sent to a provider. Core separates user-owned files under `PI_CODING_AGENT_DIR` or `~/.pi/agent` from project sources: ancestor context files and `<cwd>/.pi/{SYSTEM,APPEND_SYSTEM}.md` are not inspected until the canonical workspace is trusted. Explicit CLI text-or-file flags are an intentional user read, while Web configuration values are always literal and cannot turn into arbitrary server file reads. Every discovered file must be a nonsymlink regular UTF-8 file and is subject to per-file, file-count and aggregate limits plus an open/stat identity check. Resolved disk contents are ephemeral provider options and are not copied into session metadata. Do not move project discovery before the trust check or expose resolved bodies through capabilities/catalogue APIs.

Pi settings use the same source boundary: agent-directory `settings.json` is user-controlled, while project `.pi/settings.json` is ignored until canonical project trust. The sole pre-trust exception is a schema-validated `sessionDir`, matching Pi's need to locate startup sessions; no project extension, resource, command prefix, model, proxy, or tool setting crosses that boundary. Reads are capped at 256 KiB and reject links, non-files, invalid UTF-8/JSON, NULs, and identity/timestamp races. Validation keeps valid fields while omitting unknown or invalid values, and diagnostics never include setting values. `/settings` intentionally omits proxy and opaque telemetry identifiers.

CLI skill and prompt discovery loads project roots only after trust, does not traverse symbolic links, caps selection at 10,000 files, and opens each Markdown resource with no-follow identity/race checks and a 1 MiB limit. Settings resource exclusions operate on resolved paths; local extension code still passes the extension loader's separate regular-file, size and trust checks.

Truncated interactive CLI and direct RPC shell output is retained under an owner-only temporary directory and returned as `fullOutputPath`; the Web command adapter uses the same runtime without exposing a server-local path. Retained output expires after 24 hours by default through an unreferenced per-file timer and safe scavenger; cleanup validates candidate directory kinds and never follows symbolic-link roots. Clients may still delete files immediately after consumption, and operators should treat the temp directory as sensitive.

## Secret Storage

| Data | Persistence |
|---|---|
| Built-in provider credentials | `credentials.enc` only with `AI_HARNESS_MASTER_KEY`; otherwise memory |
| Custom provider secrets | `provider-secrets.enc` only with master key; otherwise memory |
| Push private key/subscriptions | `push.enc` only with master key; otherwise volatile |
| Non-secret configuration | Atomic `config.json`, `providers.json`, `plugins.json`, `subagents.json` |

Core model catalogues contain descriptors only: provider/ID/name, availability/source, capabilities, limits, prices and non-secret compatibility flags. Remote discovery is timeout/retry/result bounded and validated before a descriptor reaches CLI, RPC or Web. `--api-key` constructs an in-memory provider override and must never be copied into catalogue entries, protocol descriptors or session settings; users should still prefer environment or protected secret storage because command-line arguments can be exposed by shell history and process inspection.

Never expose provider keys, OAuth tokens, server-side authorization headers, passwords, master keys, VAPID private keys, or subscriptions through API/RPC responses, diagnostics, logs, sessions, fixtures, browser storage, shell child environments, or command recovery. The explicit compatibility Bearer is the narrow exception: it may live only in per-tab `sessionStorage`, never `localStorage`, workspace caches, logs, or documentation. Session/provider serializers strip broad API-key/secret/token/password/cookie/credential field variants, but callers must still avoid placing secrets in generic metadata.

## Executable Extensions and Packages

- Load project code/resources and model instructions only after trust.
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

- `packages/core/src/security/workspace-manager.test.ts`, `packages/core/src/config/pi-settings.test.ts`, `packages/core/src/prompts/instruction-context.test.ts`, and `packages/core/src/tools/{workspace-tools,shell-command-runtime}.test.ts` — roots, settings/instruction trust/precedence/bounds, realpath, symlinks, shared shell persistence/cancellation/backpressure, retention and child-environment filtering
- `packages/cli/src/resources/resource-manager.test.ts` — trusted roots, ordered selectors, no-follow resource loading and project precedence
- `packages/cli/src/security/project-trust.test.ts` and `packages/cli/src/cli/shell-controller.test.ts` — persisted trust and interactive shell gating/abort behavior
- `packages/cli/src/security/oauth-device.test.ts` — bounded OAuth polling and cancellation
- `packages/server/src/security/request-security.test.ts` — tokens, cookies, capabilities, Origin, limits and upgrades
- `packages/server/src/security/credential-store.test.ts` — encryption, permissions and memory-only fallback
- `packages/server/src/web-cli.test.ts` — bind/auth launcher policy
- `packages/core/src/sessions/session-manager.test.ts` and `packages/cli/src/rpc/pi-rpc-server.test.ts` — session-file symlinks, retained output permissions/expiry, protocol purity and bounded shell output
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
