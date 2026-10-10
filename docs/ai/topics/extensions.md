# Extensions and Plugin Packages

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

JavaScript extensions register commands, tools, providers, plain-text terminal UI components, lifecycle listeners, and cancellable `before:*` hooks. CLI and Server share the bounded Core loader but own discovery context, trust checks, and runtime composition.

Package administration is also Core-owned. CLI commands and the Server/Web routes use the same `PluginService`, `plugins.json`, source validation, resource filters, locking, inventory and update behavior. Enabled package extensions, skills, prompts and themes feed each runtime through interface-specific composition; see [`security.md`](./security.md) for trust and executable-code boundaries.

## Architecture

```text
ExtensionModuleLoader -> candidate JS modules -> ExtensionRegistry generation
Core PluginService -> install/locked state/filtered inventory/bounded batch state -> enabled resources
  |-> CLI package commands + CLI/RPC startup/reload
  `-> Server API adapter + trusted workspace generation -> AgentRuntime/Web metadata
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/extensions/extension-registry.ts` | Owned registrations, hooks, execution, cleanup and rollback |
| `packages/core/src/extensions/module-loader.ts` | Bounded discovery/import and atomic managed generations |
| `packages/cli/src/extensions/extension-loader.ts` | Explicit, configured and package extension paths plus loader orchestration |
| `packages/cli/src/resources/resource-manager.ts` | Local/package Markdown prompts and model-invocable resource discovery |
| `packages/cli/src/cli/package-command.ts` | Top-level package lifecycle, scope and resource-filter adapter |
| `packages/core/src/plugins/plugin-service.ts` | Shared npm/Git/path package state, staging, filters, inventory, locks and updates |
| `packages/server/src/runtime/plugin-service.ts` | Thin compatibility re-export of the Core service |
| `packages/server/src/api/plugin-routes.ts` | Explicit Web package administration and reload routes |
| `packages/server/src/runtime/services.ts` | Server loader composition and workspace generation switching |

## Extension Contracts

`ExtensionAPI` is an AiHarness-owned versioned contract. Core exports `AI_HARNESS_EXTENSION_API_VERSION` (`1`) and supplies the same literal as `api.version` before an extension registers behavior.

| Registration | Contract |
|---|---|
| `version` | Read-only extension API major used for compatibility checks |
| `registerOption` / `getOption` | Owned bounded boolean/string startup flags, defaults, generated help and literal completion |
| `registerCommand` | Slash command handler with runtime context |
| `registerTool` | Model/manual tool with JSON schema, AbortSignal and structured result |
| `registerProvider` | Runtime `AiProvider` factory and optional defaults |
| `registerUI` | Plain-text `header`/`status` terminal component |
| `before` | `before:agent`, `before:provider`, `before:tool`, or `before:model` transform/cancellation hook |
| `on` | Session/message/compaction lifecycle listener |

A registered tool can set `exposure` to `direct`/`model-only` for immediate declaration, `deferred` for schema-free discovery followed by next-turn declaration through `tool_search`, `codemode` for searchable but permanently script-only exposure, or `hidden` to remain unavailable to model dispatch. Optional namespace metadata enriches ranking and the bounded [QuickJS namespace helpers](./codemode.md). Exposure does not grant trust, authorization, or sandboxing: normal selection policy, declaration checks, hooks, cancellation, and runtime guards still apply, and static selected tools win dynamic name collisions.

Registered and hosted tools may await `context.onProgress({version: 1, content, details})`. Core owns immutable outer-call correlation, monotonic timing, one in-flight sink/latest pending snapshot, submission/delivery/output bounds and once-only terminal persistence. Replacement snapshots retain omitted fields; details are display-only JSON, never accounting/store/activation authority. Cancellation drops pending/late updates. Oversized strings are suppressed before redaction to avoid credential-prefix leaks; accepted arrays preserve bounded JSON index shape without invoking getters/toJSON. Producers, proxy traps, enumeration internals and redactors remain privileged code, not a CPU/memory sandbox. CLI JSON/RPC share the awaited encoder; print remains final-text-only. See `agent/tool-progress.ts` and its real child-process tests.

`before:model` receives `{type, request, context, signal}` for hosted classifier/image requests. It can transform `request` or cancel; the host revalidates kind, live model identity, exact request fields and cancellation after the hook, within the model deadline. This additive API is separate from conversational `before:provider`; the code-mode outer result owns usage/persistence. No hook can supply guest credentials or increase sandbox budgets.

Prompts, package skills, and themes are discovered resources, not `ExtensionAPI` registrations. Declarative interactions use `ExtensionRuntimeContext.requestInteraction`, returning an awaitable `ExtensionInteractionPromise`; adapters may omit controls. Detached Core hosts return an `ExtensionInteractionHandle` with readonly host ID and closure-owned `update(replacement)` / `close()`. The ID alone grants neither capability. Updates replace display/schema in place, retaining admission order, created time and the original signal/deadline; snapshots omit both signal and timeout.

Core owns at most 16 pending requests per run, 128,000 UTF-8 JSON bytes per normalized request and 512,000 aggregate bytes. Oversized admission/update throws `409 EXTENSION_INTERACTION_QUEUE_FULL` without changing prior state. A supplied timeout must be finite, nonnegative and at most 2,147,483,647 ms; otherwise `400 INVALID_EXTENSION_INTERACTION_TIMEOUT`. No active run returns a cancelled Promise. Responses validate the latest schema and settle once; late controls return false. `extensionRequests` is the complete ordered reconnect snapshot; `extensionRequest` remains its first-entry compatibility projection. The current Web adapter still has singular interaction state and reads that compatibility snapshot; its complete browser queue/attention/focus behavior is a separate unaccepted delivery.

## Critical Flows

### Load or reload JavaScript

1. Discover explicit/global files and trusted project files without following symlinks.
2. Bound candidates to 200 paths, 1,000 directory entries, and 5 MiB per module.
3. Import every candidate for the next generation.
4. Atomically replace loader-owned registrations.
5. On any discovery/import/registration error, keep or restore the previous generation.
6. On workspace change, clear old handlers if the new candidate cannot commit.

CLI startup loads one trusted generation before strict contributed-option parsing and reuses it in interactive, print, JSON and RPC modes. Built-in help/version never import extensions; `--extension-help` and `--completion` are explicit trust-gated operations. Reload gives ESM and CommonJS entries a fresh identity after successful or failed attempts, without replacing preexisting CommonJS cache entries. Dependencies retain ordinary caches; executable side effects are not transactional. See the [EN startup-option contract](../../contributors/en/extension-startup-options.md) and [FR contract](../../contributors/fr/extension-startup-options.md).

### Administer a plugin package

```text
explicit CLI or Web install/update
  -> Core parses npm:/HTTPS Git/allowed local path
  -> stage without npm lifecycle scripts or with shallow Git clone
  -> bounded symlink-free manifest/convention inventory
  -> apply package-relative include/exclude filters
  -> lock and atomically replace package plus non-secret state
  -> expose enabled resources to the selected runtime composition
```

`ai-harness package list` and `GET /api/plugins` are metadata-only: they must not execute code, install, update, or contact npm/Git. CLI package actions exit before agent startup. Enabled package resources are workspace/scope filtered; project resources remain hidden until trust. Interactive `/reload` re-resolves package resources for the CLI generation, while Server reload validates and publishes its own runtime generation.

### Change a Web package group

`PluginSettings` offers **Enable all** and **Disable all** independently for Project and Global packages. It submits only rows whose enabled state changes in one bounded `PATCH /api/plugins/enabled` request. Core validates at most 100 unique selectors, evaluates trust per entry, applies allowed changes under one inter-process lock and commits them in one atomic state write. The response preserves input order and reports each selector as `changed`, `unchanged`, or `failed`; missing and untrusted project entries do not erase allowed global changes. Only `enabled` and `updatedAt` change, so resource filters remain intact. Disabling an untrusted project entry is safe cleanup, while enabling it is refused. If an affected package contains executable extensions, Web keeps an explicit reload-pending notice until **Reload resources** succeeds. Because Core must not reopen an untrusted project package to classify its resources, disabling one conservatively raises the same notice in case its prior runtime generation still contains executable code.

### Request declarative UI

```text
extension tool/hook -> context.requestInteraction(schema)
  -> active AgentRuntime admits a bounded ordered request and issues an awaitable handle
  -> extension.ui event -> ChatView text/form controls
  -> response/cancel endpoint validates IDs, kind, fields, options and size
  -> extension resumes or receives cancellation
```

Never accept extension-provided React, DOM, script, style, or arbitrary HTML. Stop, settlement, executable/tool-generation commit and failed-workspace safety clear cancel pending requests and revoke captured requesters. Passive inventory and failed same-cwd candidates preserve the current generation. Bind Server command requesters before session/trust awaits; an old command must not inherit a new epoch. Focus trap, Escape, restoration, reconnect recovery, and cancellation remain adapter responsibilities. This queue is in-memory, not crash-durable; inherited completed-run retention is not newly bounded.

## Security Invariants

- Treat every extension and package as executable code.
- Require project trust before exposing or loading project code/resources.
- Keep catalogue reads side-effect free and diagnostics free of source bodies, command output, and secrets.
- Preserve registration ownership so unload removes every command/tool/provider/UI/hook/listener.
- Pass cancellation to active tool and interaction work.
- Validate package source, bounded manifests/state, package-relative filters, symlinks, and rollback before changing active state.
- Serialize CLI/Server mutations with the Core heartbeat lock and owner-only atomic state writes; group activation remains bounded, uses one write, and returns value-free per-entry failures.

## Associated Tests

- `packages/core/src/extensions/extension-registry.test.ts` — API version, ownership, hooks, tools, providers, UI and atomic replacement
- `packages/core/src/agent/runtime-interaction-queue.test.ts` and `runtime-interaction-process.test.ts` — order, updates, exactly-once settlement, bounds, signal/deadline and original subprocess controls
- `packages/server/src/api/{interaction-queue-http,queue-reconciliation-http,queue-generation-http,queue-generation-process}.test.ts` — latest-schema HTTP validation, stop accounting before terminal replay, same-cwd preservation and revocation while the run remains active
- `packages/core/src/tools/{tool-search,codemode}.test.ts` — deferred/script-only exposure, BM25 ranking, activation/store provenance, bounded QuickJS, policy revalidation and branch restoration
- `packages/cli/src/extensions/extension-loader.test.ts` — explicit path parsing and loader behavior
- `packages/core/src/plugins/plugin-service.test.ts` — source validation, filters, trust, bounded one-write group activation, partial outcomes, concurrency, inventory and transactional package state
- `packages/cli/src/cli/{package-command,invocation}.test.ts` — strict command parsing and real package resource startup
- `packages/server/src/web-server.test.ts` — plugin/reload HTTP, trust and runtime integration
- `e2e/settings.spec.ts` — package administration flows
- `e2e/chat.spec.ts` and `e2e/accessibility.spec.ts` — widgets, interactions, focus and response handling
- `tests/functional-parity/functional-parity.test.ts` — native extension positive/negative fixtures, RPC interaction and public type/runtime probes

## Common Changes

### Add an extension registration

Change Core contracts/registry/public exports, both runtime compositions, cleanup/rollback tests, and declarative Web handling only if browser-visible.

### Change interaction lifecycle

Keep contracts in Core's `extensions/extension-registry.ts` and `agent/{events,interaction-handle,runtime}.ts`; preserve compatibility snapshots, capability ownership, original deadlines and active-run epoch tests. Revalidate genuine installed declarations/runtime and unchanged CLI/RPC goldens. Do not infer browser queue acceptance from Core/Server tests.

### Change module discovery

Update the Core loader and CLI/Server configuration. Test bounds, symlinks, trust, duplicate ownership, failed generations, and workspace switching.

### Change plugin administration

Update Core package metadata types, Server service/routes, Web API/settings, auth capability tests, rollback tests, and human extension documentation together.

## Related Domains

- [`codemode.md`](./codemode.md) — hosted nested calls and model-only/script-only boundaries
- [`providers.md`](./providers.md) — extension provider factories and provider hooks
- [`server-api.md`](./server-api.md) — plugin reload and interaction endpoints
- [`security.md`](./security.md) — trust, package sources and diagnostics
- [`web-app-architecture.md`](./web-app-architecture.md) — declarative rendering and focus behavior
