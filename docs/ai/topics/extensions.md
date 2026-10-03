# Extensions and Plugin Packages

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

JavaScript extensions register commands, tools, providers, plain-text terminal UI components, lifecycle listeners, and cancellable `before:*` hooks. CLI and Server share the bounded Core loader but own discovery context, trust checks, and runtime composition.

Server plugin packages are a separate administration layer: they inventory package resources and make enabled executable extension files available only during explicit resource reload. See [`security.md`](./security.md) for trust and executable-code boundaries.

## Architecture

```text
ExtensionModuleLoader -> candidate JS modules -> ExtensionRegistry generation
CLI loader -> global/project/explicit files -> terminal runtime
PluginService -> install/state/inventory -> enabled extension files
Server reload -> trusted workspace generation -> AgentRuntime/Web metadata
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/extensions/extension-registry.ts` | Owned registrations, hooks, execution, cleanup and rollback |
| `packages/core/src/extensions/module-loader.ts` | Bounded discovery/import and atomic managed generations |
| `packages/cli/src/extensions/extension-loader.ts` | Explicit CLI extension paths and loader orchestration |
| `packages/cli/src/resources/resource-manager.ts` | Markdown prompts and model-invocable resource discovery |
| `packages/server/src/runtime/plugin-service.ts` | npm/Git/path package state, staging, inventory and updates |
| `packages/server/src/api/plugin-routes.ts` | Explicit package administration and reload routes |
| `packages/server/src/runtime/services.ts` | Server loader composition and workspace generation switching |

## Extension Contracts

`ExtensionAPI` supports:

| Registration | Contract |
|---|---|
| `registerCommand` | Slash command handler with runtime context |
| `registerTool` | Model/manual tool with JSON schema, AbortSignal and structured result |
| `registerProvider` | Runtime `AiProvider` factory and optional defaults |
| `registerUI` | Plain-text `header`/`status` terminal component |
| `before` | `before:agent`, `before:provider`, or `before:tool` transform/cancellation hook |
| `on` | Session/message/compaction lifecycle listener |

Prompts, package skills, and themes are discovered resources, not `ExtensionAPI` registrations. Web interaction requests use `ExtensionRuntimeContext.requestInteraction`; they are suspended runtime requests rather than executable browser components.

## Critical Flows

### Load or reload JavaScript

1. Discover explicit/global files and trusted project files without following symlinks.
2. Bound candidates to 200 paths, 1,000 directory entries, and 5 MiB per module.
3. Import every candidate for the next generation.
4. Atomically replace loader-owned registrations.
5. On any discovery/import/registration error, keep or restore the previous generation.
6. On workspace change, clear old handlers if the new candidate cannot commit.

### Administer a plugin package

```text
explicit install/update
  -> parse npm:/HTTPS Git/allowed local path
  -> stage without npm lifecycle scripts or with shallow Git clone
  -> bounded symlink-free manifest/convention inventory
  -> atomically replace package and non-secret state
  -> expose extension files only to explicit reload
```

`GET /api/plugins` is metadata-only: it must not execute code, install, update, or contact npm/Git. Enabled package resources are workspace/scope filtered; project resources remain hidden until trust.

### Request declarative UI

```text
extension tool/hook -> context.requestInteraction(schema)
  -> active AgentRuntime stores one pending request
  -> extension.ui event -> ChatView text/form controls
  -> response/cancel endpoint validates IDs, kind, fields, options and size
  -> extension resumes or receives cancellation
```

Never accept extension-provided React, DOM, script, style, or arbitrary HTML. Focus trap, Escape, restoration, reconnect recovery, and cancellation are transport behavior.

## Security Invariants

- Treat every extension and package as executable code.
- Require project trust before exposing or loading project code/resources.
- Keep catalogue reads side-effect free and diagnostics free of source bodies, command output, and secrets.
- Preserve registration ownership so unload removes every command/tool/provider/UI/hook/listener.
- Pass cancellation to active tool and interaction work.
- Validate package source, bounds, symlinks, and rollback before changing active state.

## Associated Tests

- `packages/core/src/extensions/extension-registry.test.ts` — ownership, hooks, tools, providers, UI and atomic replacement
- `packages/cli/src/extensions/extension-loader.test.ts` — explicit path parsing and loader behavior
- `packages/server/src/runtime/plugin-service.test.ts` — source validation, inventory and transactional package state
- `packages/server/src/web-server.test.ts` — plugin/reload HTTP, trust and runtime integration
- `e2e/settings.spec.ts` — package administration flows
- `e2e/chat.spec.ts` and `e2e/accessibility.spec.ts` — widgets, interactions, focus and response handling

## Common Changes

### Add an extension registration

Change Core contracts/registry/public exports, both runtime compositions, cleanup/rollback tests, and declarative Web handling only if browser-visible.

### Change module discovery

Update the Core loader and CLI/Server configuration. Test bounds, symlinks, trust, duplicate ownership, failed generations, and workspace switching.

### Change plugin administration

Update Core package metadata types, Server service/routes, Web API/settings, auth capability tests, rollback tests, and human extension documentation together.

## Related Domains

- [`providers.md`](./providers.md) — extension provider factories and provider hooks
- [`server-api.md`](./server-api.md) — plugin reload and interaction endpoints
- [`security.md`](./security.md) — trust, package sources and diagnostics
- [`web-app-architecture.md`](./web-app-architecture.md) — declarative rendering and focus behavior
