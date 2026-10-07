# Security and Trust Boundaries

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Security spans canonical workspace resolution, explicit project trust, HTTP/WebSocket authorization, secret storage, executable packages/extensions, file-only MCP inspection, confirmation-gated atomic import/replacement—including a serialized fresh-project trust-plus-first-write transaction—and local mutation, and safe browser rendering. Every external path, ID, credential, package source, provider response, and extension payload is untrusted.

Review [`server-api.md`](./server-api.md) for route guards and [`extensions.md`](./extensions.md) before changing executable-code loading.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/security/workspace-manager.ts` | Allowed roots, realpath boundary, file kind and Git/worktree operations |
| `packages/core/src/security/project-trust.ts` | Shared bounded resource inventory, exact/inherited allow/refuse resolution, broad/nested fresh-folder analysis, serialized trust-plus-write rollback and atomic v2 trust store |
| `packages/core/src/tools/workspace-tools.ts` | Shared CLI/Web path resolution, mutation trust gates, exact edits, bounded searches and command execution |
| `packages/core/src/prompts/instruction-context.ts` | Shared trust-separated, bounded, regular-file-only instruction and system-prompt resolution |
| `packages/core/src/config/agent-settings.ts` | Bounded no-follow settings reads, schema filtering, trust-gated layers, global-only policy and value-free diagnostics |
| `packages/core/src/mcp/{config-import,config-inventory}.ts` | Side-effect-free MCP reads/previews plus original-text reparse, confirmation-gated insertion—including the first fresh-project write—or one-entry replacement, and trust-gated stale-safe activation/exposure/removal/restoration with bounded locking and atomic mode-aware writes |
| `packages/core/src/plugins/plugin-service.ts` | Shared package source policy, trust gates, bounded inventory, owner-only locked state and rollback |
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
  -> inspectProjectTrustResources(canonical cwd), metadata only
  -> ProjectTrustManager.getStatus / resolveProjectTrust
  -> operation-specific capability and resolved trust check
  -> file/Git/command/agent/PTY work
```

Trust is a shared canonical-path decision map in the agent-directory `trust.json`; it is not a project marker such as `.ai-harness/trusted`. Each exact path may store an allow or refusal, and the nearest ancestor decision applies to descendants. Thus an exact child refusal overrides a parent allow, while an exact child allow overrides a parent refusal. Resolution order is process override, nearest saved decision, no protected resources, global `defaultProjectTrust`, then an interactive prompt or fail-closed fallback. `--approve`/`--no-approve` and session-only prompt choices never persist. Symlinks may not escape allowed roots. Never pass a browser-supplied path directly to `fs`, Git, a shell, PTY, package installer, or AgentRuntime.

Read-only workspace browsing still requires `workspace:read`; dangerous writes/execution additionally require admin capabilities and, where applicable, resolved project trust. In the CLI, the same Core tools are rooted at the startup cwd: `read`, `grep`, `find`, and `ls` remain read-only, while `bash`, direct `!`/`!!`, `edit`, and `write` require the current canonical workspace to resolve trusted. In the CLI, a folder with no protected resource resolves true for operations in that process without persisting a decision, but its separate project-body gate remains false so a resource that appears after inventory is not opened through a check/load race; reload re-inspects metadata before loading newly appeared resources. The Web treats first workspace use and agent execution themselves as protected capabilities, so an empty folder still needs an explicit saved allow. Its status route keeps Core’s resource-sensitive `requiresTrust`/`trusted` result and reports the distinct saved-capability result as `operationTrusted`, while both use the same canonical nearest-decision store. The MCP first-import flow may create that saved exact allow only after a separate explicit fresh-folder confirmation and only inside Core’s serialized trust-plus-write transaction; resource-sensitive `trusted: true` alone never authorizes it. Core process execution shared by CLI, RPC and Web filters API keys, access keys, tokens, secrets, authorization/cookie/password/credential-like parent environment names before spawning children; do not bypass it with raw `spawn` for agent- or user-controlled commands. Cancellation terminates the process group on POSIX and the process tree through `taskkill` on Windows, then escalates after a grace period.

Instruction text is executable only in the model-policy sense, but it is still untrusted input sent to a provider. Core separates user-owned files under `AI_HARNESS_AGENT_DIR` or `~/.ai-harness` from project sources. Before trust, it may inspect only bounded `lstat` metadata for `.ai-harness` settings/resource/system paths, project skill/prompt directories, and the selected ancestor context filenames; it never reads their bodies. Interactive `ask` prompts only if this inventory is non-empty, whereas print/JSON/RPC `ask` refuses safely. Ancestor context files and `<cwd>/.ai-harness/{SYSTEM,APPEND_SYSTEM}.md` are opened only after resolved trust. Explicit CLI text-or-file flags are an intentional user read, while Web configuration values are always literal and cannot turn into arbitrary server file reads. Every discovered file must be a nonsymlink regular UTF-8 file and is subject to per-file, file-count and aggregate limits plus an open/stat identity check. Resolved disk contents are ephemeral provider options and are not copied into session metadata. Do not move project body discovery before the trust check or expose resolved bodies through capabilities/catalogue APIs.

Agent settings use the same source boundary: agent-directory `settings.json` is user-controlled, while project `.ai-harness/settings.json` is not opened until canonical project trust. Project `sessionDir`, extensions, resources, command prefixes, models, proxies and tool settings all remain behind that boundary. Reads are capped at 256 KiB and reject links, non-files, invalid UTF-8/JSON, NULs, and identity/timestamp races. Validation keeps valid fields while omitting unknown or invalid values, and diagnostics never include setting values. `/settings` intentionally omits proxy and opaque telemetry identifiers.

The MCP Settings reader follows a narrow file-only contract. Core may read `<data-dir>/mcp.json`, but it opens `<cwd>/.ai-harness/mcp.json` only when the nearest persisted trust decision is `true`; implicit resource-sensitive trust for an empty folder is not enough. Before that it uses `lstat` metadata only, so a file that appears after an empty-folder check is still not opened. Both files must be regular and nonsymlink, are capped at 1 MiB, and pass open/stat race checks, JSON/JSONC syntax, depth 64, server-count 200 and strict shallow entry validation. Parse errors are fixed text that never quote source. API descriptors omit env/header values, identify command-backed fields and variable names without resolving them, escape hidden characters, and redact executable paths, literal arguments, URL credentials/path/query/hash. Opaque revisions are keyed per process so they detect stale bytes without becoming a browser-visible hash oracle for low-entropy literals.

MCP paste preview is a separate non-mutating Core contract. The browser sends the original text, an explicit `foreign` or `aiharness` syntax choice and optional cwd; an edit preview additionally identifies one existing scope/name/revision, but it never sends a normalized object for the server to trust. Core reparses at most 256 KiB, 20 servers, 128 fields, depth 64, 128 collection items, 256 shell words and 16 KiB per string/word. Its shell lexer treats commands as data and refuses operators, redirections, substitutions, multiple commands and evaluator forms such as `sh -c`, `cmd /c` and `pwsh -Command`. It accepts a bounded subset of direct commands, client add commands, JSON/JSONC shapes and Cursor/VS Code/Visual Studio/Copilot install links, drops unknown keys with typed counts, and refuses SSE, WebSocket and unsupported schemes.

Foreign `$...` and initial `!` literals are escaped before any future persistence shape is described; explicit variable forms in supported shell/client commands remain references, while only an AiHarness-syntax choice or recognized `ai-harness mcp add` command recognizes native command-backed fields. References are permitted only in env values, header values and `oauth.clientSecret`, never URL/command/arguments. Server supplies only `Object.keys(process.env)`, never environment values. The public preview contains structural field names, masked targets, variable names and fixed diagnostics, but no normalized raw configuration, literal secret, argument text, header/env/OAuth value or source excerpt. Literal secrets make project scope ineligible; remote available-variable references require explicit confirmation; `AI_HARNESS_AUTH_TOKEN`, `AI_HARNESS_ADMIN_TOKEN` and `AI_HARNESS_MASTER_KEY` references make every scope ineligible. Project collision/trust decisions come from a fresh redacted inventory, so project file content is still never opened without an effective persisted allow. A decision-free folder with no trust-requiring resource is project-eligible only when the bounded breadth check excludes filesystem/home/data roots, other known folders and unprotected nested projects; its fail-closed scan inspects at most 256 paths and 2,000 directories through depth four, rejecting links, special types, read/identity races and exceeded depth. A nested subtree with its own nearest decision is already protected and does not inherit the candidate allow. Preview then reports a `fresh-project-trust` confirmation rather than granting trust. Preview does not write files, resolve a value, run a process, contact a URL, initialize OAuth or open/create a credential store.

Import and replacement persistence do not trust the preview or a browser-built object. The browser resends the original paste plus one entry index, target scope/name, bounded missing-field values or variable names, literal-secret approval and exact remote host-variable approvals. Replacement also supplies the exact existing target name and its inventory revision; current hidden values are never loaded into the form. Core reparses the original text, applies only fields it independently rediscovered, escapes literal completion in reference-capable locations, and rechecks schema, shell/management commands, unsupported/reserved references, final secret locations and confirmations. A project write refuses every remaining literal secret; a global write with remaining literals requires explicit approval; an available host variable referenced by a remote header or OAuth secret requires name-bound approval. The write then uses the same opaque revision, trust checks, lock, no-follow reread and atomic file replacement as other mutations. A confirmed `trustProject: true` is accepted only for a project import with a missing target revision. Core serializes it on the trust-store lock, rechecks canonical folder identity, direct/ancestor trust resources, nearest allow/refusal and bounded breadth, persists one exact allow, acquires the MCP lock, revalidates again, then writes. A failed write removes only that exact newly introduced decision; a failed rollback carries typed `trustKept` state, and every failure causes canonical inventory and workspace trust reload. A replacement changes or renames exactly one valid entry, removes omitted fields, preserves siblings, and refuses collisions. Neither success nor failure returns the normalized/written entry, old values, source literals or host values.

Local MCP insertion, whole-entry replacement, activation, exposure changes, removal and restoration retain the same no-resolution boundary. The administrator route passes original import text plus bounded choices, or local mutation selectors, together with an opaque revision to Core; Core serializes cooperating processes with a bounded owner-only heartbeat lock, rereads under that lock, rejects stale/malformed/linked/nonregular files, and writes a same-mode same-directory temporary file before fsync and atomic rename. One request inserts or replaces exactly one selected entry, changes at most 100 unique activation selectors, or changes one valid entry to `direct`, `codemode` or `deferred`, and publishes at most one file replacement. Exposure is configuration metadata only: selecting it never loads tools or opens a transport, and choosing the `direct` default removes the optional property. Global writes force `0600`; project writes retain existing permission bits or use `0644` for a new file. Accepted JSONC is normalized to JSON with the first bounded indentation style, original LF/CRLF style and one final newline while unknown keys survive. Project trust is checked before any directory/body access, again inside the lock and immediately before commit.

Removal literals, including possible secrets, remain only in a server-memory FIFO of at most 100 records and expire through unreferenced 60-second timers. The browser gets only a random token and ISO expiry. Restoration consumes that token, compares the deletion revision, rejects name conflicts and rechecks project trust; neither failures nor API responses serialize the held entry. The route and Web still must never expand a variable, execute `!command`, spawn a server, contact a URL, initialize OAuth or create a credential file. There is no MCP runtime yet; do not mistake a `Configured` inventory row for a live connection.

CLI skill and prompt discovery loads project roots only after trust, does not traverse symbolic links, caps selection at 10,000 files, and opens each Markdown resource with no-follow identity/race checks and a 1 MiB limit. Settings resource exclusions operate on resolved paths; local and package extension code still passes the extension loader's separate regular-file, size and trust checks. Core exposes project package paths only after the same trust decision, and the package filters can only narrow resources already declared by a validated manifest. Custom and package theme files use bounded no-follow identity-checked reads.

The trust store accepts only bounded absolute paths and boolean decisions. Reads are size-capped and regular-file-only; malformed, linked or unsafe stores fail closed. Mutations re-read under a bounded heartbeat lock, merge decisions, write owner-only temporary files and rename atomically so CLI and Web processes do not silently overwrite one another. Fresh-folder transactions hold that same inter-process lock across their first write, so concurrent trust mutations cannot be overwritten and a rollback restores the exact prior decision map. Async status checks refresh when the file identity changes. Legacy v1 `trustedProjects` entries are read as allows and migrate to v2 on the next mutation; no project-controlled file can grant trust.

Truncated interactive CLI and direct RPC shell output is retained under an owner-only temporary directory and returned as `fullOutputPath`; the Web command adapter uses the same runtime without exposing a server-local path. Retained output expires after 24 hours by default through an unreferenced per-file timer and safe scavenger; cleanup validates candidate directory kinds and never follows symbolic-link roots. Clients may still delete files immediately after consumption, and operators should treat the temp directory as sensitive.

## Secret Storage

| Data | Persistence |
|---|---|
| Built-in provider credentials | `credentials.enc` only with `AI_HARNESS_MASTER_KEY`; otherwise memory |
| Custom provider secrets | `provider-secrets.enc` only with master key; otherwise memory |
| Push private key/subscriptions | `push.enc` only with master key; otherwise volatile |
| MCP configuration literals | Operator-managed `mcp.json`; pasted import/replacement text and field completion remain transient browser/server request data, preview/inventory/action responses are redacted, confirmed global writes may persist literals, project writes may not, replaced values are never returned, deleted literals remain briefly in bounded server memory for undo, and files still need OS-level protection |
| Non-secret configuration | Atomic `config.json`, `providers.json`, `plugins.json`, `subagents.json` |

Core model catalogues contain descriptors only: provider/ID/name, availability/source, capabilities, limits, prices and non-secret compatibility flags. Remote discovery is timeout/retry/result bounded and validated before a descriptor reaches CLI, RPC or Web. `--api-key` constructs an in-memory provider override and must never be copied into catalogue entries, protocol descriptors or session settings; users should still prefer environment or protected secret storage because command-line arguments can be exposed by shell history and process inspection.

Never expose provider keys, OAuth tokens, server-side authorization headers, passwords, master keys, VAPID private keys, or subscriptions through API/RPC responses, diagnostics, logs, sessions, fixtures, browser storage, shell child environments, or command recovery. The explicit compatibility Bearer is the narrow exception: it may live only in per-tab `sessionStorage`, never `localStorage`, workspace caches, logs, or documentation. Session/provider serializers strip broad API-key/secret/token/password/cookie/credential field variants, but callers must still avoid placing secrets in generic metadata.

## Executable Extensions and Packages

- Load project code/resources and model instructions only after trust.
- Refuse symlinked extension modules and modules over 5 MiB.
- Keep GET catalogues and CLI `package list` metadata-only and side-effect free.
- Parse only supported npm, HTTPS Git, and allowed local sources; relative local paths are a CLI-only convenience resolved against its canonical cwd.
- Disable npm lifecycle scripts and use shallow Git clones in staging.
- Reject linked package roots/resources, traversal and out-of-package filters; bound state, manifest, scan depth/count and resource count.
- Serialize every CLI/Server mutation under the same heartbeat lock, refresh state inside it, and commit owner-only temporary files by atomic rename.
- Bound group activation to 100 unique entries, authorize each project enable independently, keep project disable available for cleanup, and commit all allowed changes in one state write without altering resource filters; flag untrusted cleanup for runtime reload without reopening package contents.
- Validate a complete managed candidate before atomic replacement and restore its backup if package or state publication fails.
- Exclude resource bodies, source code, command output and credentials from catalogues and diagnostics.

These controls reduce exposure; they do not sandbox trusted third-party JavaScript, which runs with the privileges of the active CLI or server OS user.

## Browser Content Security

- Render extension widgets as text and interactions from a fixed schema.
- Sanitize supported Markdown/KaTeX/Mermaid output; keep raw HTML non-executable.
- Validate uploads by count, size, name, collision policy, and canonical destination.
- Store provider credentials only server-side; bounded session caches explicitly strip key-like fields.
- Use focus traps and safe cancellation/reconnection for extension dialogs; accessibility behavior is part of the security contract.

## Network Boundary

The launcher binds to `127.0.0.1` by default. A non-loopback bind without authentication is rejected unless the explicit insecure override is set. Public deployment still requires a trusted HTTPS reverse proxy or private network, correct allowed origins, and proxy-level request limits.

## Associated Tests

- `packages/core/src/security/{project-trust,workspace-manager}.test.ts`, `packages/core/src/config/agent-settings.test.ts`, `packages/core/src/prompts/instruction-context.test.ts`, `packages/core/src/mcp/{config-import,config-import-mutation,config-inventory,config-mutation}.test.ts`, and `packages/core/src/tools/{workspace-tools,shell-command-runtime}.test.ts` — resource-sensitive trust, roots, settings/instruction/MCP bounds, conservative import grammars, literal/reference/secret scope policy, no-follow reads/writes, stale/concurrent mutation, permissions, redaction, shadowing, shared shell cancellation/backpressure, retention and child-environment filtering
- `packages/core/src/plugins/plugin-service.test.ts` — package source/filter validation, project trust, bounded batch refusal/partial success, linked-resource rejection, atomic persistence and concurrent service mutation
- `packages/cli/src/resources/resource-manager.test.ts` — trusted local/package roots, ordered selectors, no-follow resource loading and project precedence
- `packages/cli/src/security/project-trust.test.ts`, `packages/cli/src/cli/invocation.test.ts` and `packages/cli/src/cli/shell-controller.test.ts` — prompt adapter, process overrides, headless policy and interactive shell gating/abort behavior
- `packages/cli/src/security/oauth-device.test.ts` — bounded OAuth polling and cancellation
- `packages/server/src/security/request-security.test.ts` — tokens, cookies, capabilities, Origin, limits and upgrades
- `packages/server/src/security/credential-store.test.ts` — encryption, permissions and memory-only fallback
- `packages/server/src/web-cli.test.ts` — bind/auth launcher policy
- `packages/core/src/sessions/session-manager.test.ts` and `packages/cli/src/rpc/rpc-controller.test.ts` — session-file symlinks, retained output permissions/expiry, protocol purity and bounded shell output
- `packages/server/src/runtime/mcp-inventory-service.test.ts`, `packages/server/src/web-server.test.ts`, `packages/web/src/services/api.test.ts`, `e2e/settings.spec.ts` and `e2e/live-server.spec.ts` — non-mutating import/replacement preview, original-text atomic import/replacement, field/secret confirmation policy, host-value/process/write leak negatives, bounded/expiring opaque undo, admin routes, MCP redaction/secret boundaries, atomic exposure selection, uncertain-failure reload and browser focus

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
