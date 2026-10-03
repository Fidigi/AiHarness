# CLI Interface

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

`ai-harness` has two interactive terminal renderers plus a separate JSONL RPC entry path. The regular and fullscreen renderers share input dispatch, commands, resources, extensions, sessions, and the Core tool loop; RPC owns a smaller method dispatcher and provider setup.

Conversation persistence follows [`sessions.md`](./sessions.md), while extension hooks follow [`extensions.md`](./extensions.md). The built-in workspace tools are implemented once in Core and registered by both CLI and server startup.

## Architecture

```text
packages/cli/src/index.ts
  |-> --rpc -> rpc/rpc-server.ts
  `-> terminal mode -> regular readline OR fullscreen raw input
         -> resource/command dispatch -> Core runToolLoop -> provider
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/cli/src/index.ts` | Startup, arguments, sessions, trust, resources, hooks, streaming and shutdown |
| `packages/cli/src/commands/handler.ts` | Built-in command registry and execution context |
| `packages/cli/src/agent/tool-loop.ts` | Backward-compatible re-export of the Core tool loop |
| `packages/core/src/tools/workspace-tools.ts` | Shared, workspace-bounded coding tools used by CLI and Web execution |
| `packages/cli/src/tui/terminal-ui.ts` | Regular readline output, help and streaming writer |
| `packages/cli/src/tui/fullscreen-{ui,input}.ts` | Alternate-screen rendering and raw-mode line editor |
| `packages/cli/src/tui/{mode,theme-manager}.ts` | Mode precedence and built-in/custom themes |
| `packages/cli/src/rpc/rpc-server.ts` | Line-delimited JSON request/response protocol |
| `packages/cli/src/resources/resource-manager.ts` | Markdown prompts/resources, frontmatter and expansion |

## Execution Modes

| Mode | Selection | Notes |
|---|---|---|
| Fullscreen | Default on a supported TTY, `--fullscreen`, or `AI_HARNESS_TUI_MODE=fullscreen` | Falls back safely when unsupported. |
| Regular | `--regular`, `--no-fullscreen`, unsupported terminal, or environment value | Uses Node readline. |
| RPC | `--rpc` | Bypasses interactive TUI selection and reads JSONL on stdin. |

CLI flags override `AI_HARNESS_TUI_MODE`; terminal capability determines whether fullscreen can actually run.

## RPC Contract

Each input line is one request with an ID, method, and optional params; each output line is one result or safe error. Supported methods are defined by the switch in `rpc-server.ts`, including `system.ping`, session list/create/get/delete, `provider.list`, and `chat.send`.

```json
{"id":1,"method":"session.create","params":{"title":"Review"}}
{"id":2,"method":"chat.send","params":{"sessionId":"...","content":"Hello"}}
```

`AI_HARNESS_SESSIONS_DIR` can isolate RPC persistence. Do not write logs or TUI control sequences to stdout in RPC mode.

## Command Contract

Built-in metadata and handlers live in `commands/handler.ts`; extension commands are resolved after built-ins. The registry includes conversation/session lifecycle, provider/model/thinking, compaction/branching, import/export/share, resources, extensions/tools/trust/reload, clipboard/search, and quit operations.

User-visible command help also exists in both TUI implementations. Never add a command only to the handler.

## Critical Conversation Flow

```text
input -> prompt/resource expansion or built-in/extension command
  -> before:agent -> persist user message
  -> Core runToolLoop
       -> before:provider -> provider stream
       -> before:tool -> tool -> persisted call/result -> next turn
  -> persist assistant response -> lifecycle events/rendering
```

An `AbortController` must reach provider and active tool work. Fullscreen and regular input must share cancellation and shutdown semantics; RPC chat must return one terminal response without corrupting JSONL framing.

Interactive startup and the Web server register the same `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools from Core, plus `powershell` on Windows. Reads and searches are canonicalized inside the active workspace. `bash`, `edit`, and `write` additionally require explicit project trust; command output, file reads, directory listings, and search results are bounded.

## Persistence, Trust, and Extensions

- Default sessions use `~/.ai-harness/sessions`; `--no-session` disables CLI persistence.
- Global JavaScript extensions load from `~/.ai-harness/extensions`.
- Project extensions under `.ai-harness/extensions` remain blocked until `ProjectTrustManager` approves the canonical cwd.
- `--extension` and `AI_HARNESS_EXTENSIONS` add explicit loader paths.
- `/reload` replaces the managed generation atomically.
- Theme/keybinding files are user configuration; malformed input must fall back safely.

## Associated Tests

- `packages/cli/src/commands/handler.test.ts` — built-in commands, sessions, providers and import/export
- `packages/cli/src/rpc/rpc-server.test.ts` — JSONL methods, errors and provider chat
- `packages/cli/src/agent/tool-loop.test.ts` — CLI compatibility entry point
- `packages/cli/src/extensions/extension-loader.test.ts` — explicit extension paths and reload
- `packages/cli/src/tui/mode.test.ts` — flag/environment/capability precedence
- `packages/cli/src/tui/{terminal-ui,fullscreen-ui,fullscreen-input,theme-manager}.test.ts` — rendering, input and themes

## Common Changes

### Add a slash command

Register and test it in `commands/handler.ts`, verify dispatch/completion in `index.ts`, update regular and fullscreen help, then update both language versions of the user guide.

### Change terminal input or rendering

Update both interactive paths where behavior is shared. Test narrow dimensions, ANSI/Unicode width, history/completion, cancellation, external editor transitions, and terminal restoration.

### Change RPC

Keep stdout strictly JSONL, validate untrusted IDs/params, update RPC tests and automation documentation, and preserve cancellation/persistence semantics.

## Related Domains

- [`providers.md`](./providers.md) — provider initialization and streaming
- [`sessions.md`](./sessions.md) — JSONL persistence, branches and compaction
- [`extensions.md`](./extensions.md) — commands, hooks, tools and trusted loading
- [`security.md`](./security.md) — project trust and credential handling
