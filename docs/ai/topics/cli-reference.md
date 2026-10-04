# CLI Interface

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

`ai-harness` has two interactive terminal renderers, a final-text print path, a one-shot JSONL event path, and a bidirectional JSONL RPC path. All execution modes reuse Core provider hooks, bounded retry, persistence, active-tool selection, and the multi-turn tool loop. RPC adds a typed command/response and asynchronous event adapter while retaining the former `method`/`params` requests as deprecated compatibility input.

Conversation persistence follows [`sessions.md`](./sessions.md), while extension hooks follow [`extensions.md`](./extensions.md). The built-in workspace tools are implemented once in Core and registered by both CLI and server startup. Core also owns model catalogue assembly/discovery/resolution, direct shell parsing, bounded process execution, cancellation, replay and command persistence; the CLI, RPC and Web/Server surfaces provide presentation or transport adapters around those contracts. Instruction discovery and system-prompt composition likewise live once in Core and feed every CLI mode plus trusted Web agent runs.

## Architecture

```text
packages/cli/src/index.ts
  |-> Core model catalogue -> startup selection / --list-models / scoped cycling
  |-> Core instruction resolver -> composed provider system prompt
  |-> --mode rpc / --rpc -> rpc/rpc-server.ts
  |-> --mode json -> versioned JSONL event encoder
  |-> --print or redirected stream -> final-text print execution
  `-> terminal mode -> regular readline OR fullscreen raw input
         |-> ! / !! -> CLI shell adapter -> Core ShellCommandRuntime
         `-> resource/command dispatch -> Core runToolLoop -> provider
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/cli/src/index.ts` | Startup, modes, sessions, trust, resources, hooks, streaming and shutdown |
| `packages/cli/src/cli/args.ts` | Strict option parsing, help/version, redirected-mode resolution and bounded stdin |
| `packages/cli/src/cli/json-output.ts` | Versioned session header plus agent/message/tool/retry/compaction JSONL encoding with guarded stdout |
| `packages/cli/src/cli/shell-controller.ts` | Interactive `!`/`!!` trust, streaming, cancellation and TUI adapter |
| `packages/cli/src/cli/model-list.ts` | Configured-provider `--list-models` metadata table and fuzzy filtering |
| `packages/cli/src/providers/configured-providers.ts` | Shared interactive/print/JSON/RPC provider environment and startup model resolution |
| `packages/cli/src/sessions/startup-session.ts` | New/continue/resume/open/fork/exact-ID/name selection and session-directory precedence |
| `packages/cli/src/commands/handler.ts` | Built-in command registry and execution context |
| `packages/cli/src/agent/{tool-loop,provider-turn}.ts` | Thin re-exports of Core execution primitives |
| `packages/core/src/tools/{workspace-tools,tool-selection}.ts` | Shared, workspace-bounded coding tools and active-tool policy used by CLI and Web execution |
| `packages/core/src/tools/{process-execution,shell-command-runtime,shell-input}.ts` | Shared filtered process execution, direct shell lifecycle/persistence and browser-safe `!`/`!!` parsing |
| `packages/core/src/prompts/prompt-input.ts` | Bounded, workspace-safe text/image `@file` ingestion |
| `packages/core/src/prompts/instruction-context.ts` | Bounded instruction hierarchy, trust-separated system files, text-or-file overrides and prompt composition shared with Server |
| `packages/core/src/config/agent-settings.ts` | Validated agent settings layers, migration, merge/global-only policy, provenance and shared value resolvers |
| `packages/core/src/providers/model-catalog.ts` | Non-secret catalogue assembly, bounded discovery, exact/fuzzy lookup, thinking suffixes, ordered glob scopes and protocol descriptors |
| `packages/cli/src/tui/terminal-ui.ts` | Regular readline output, help and streaming writer |
| `packages/cli/src/tui/fullscreen-{ui,input}.ts` | Alternate-screen rendering and raw-mode line editor |
| `packages/cli/src/tui/{mode,theme-manager}.ts` | Mode precedence and built-in/custom themes |
| `packages/cli/src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.ts` | Strict-LF dispatch, state/queue/session commands and extension-dialog bridge |
| `packages/cli/src/resources/resource-manager.ts` | Markdown prompts/resources, frontmatter and expansion |

## Execution Modes

| Mode | Selection | Notes |
|---|---|---|
| Fullscreen | Default on a supported TTY, `--tui-mode fullscreen`, legacy `--fullscreen`, or `AI_HARNESS_TUI_MODE=fullscreen` | Falls back safely when unsupported. |
| Regular | `--tui-mode regular`, legacy `--regular` / `--no-fullscreen`, unsupported terminal, or environment value | Uses Node readline. |
| Print | `-p` / `--print`, or redirected stdin/stdout | Runs supplied prompts and writes only the final assistant text to stdout. |
| JSON | `--mode json` | Runs supplied prompts, emits a session header and lifecycle events as strict JSONL, then exits. |
| RPC | `--mode rpc` or legacy `--rpc` | Bypasses interactive TUI selection and reads JSONL on stdin. |

CLI flags override `AI_HARNESS_TUI_MODE`; terminal capability determines whether fullscreen can actually run. Unknown options and missing values fail before loading sessions or executable resources. `--help` and `--version` are metadata-only exits.

## Model Catalogue and Selection

Core assembles the non-secret model catalogue used by CLI startup, `/model`, RPC and Server/Web from published metadata, configured IDs, bounded live discovery and server custom definitions. Discovery validates IDs, deduplicates them, caps each result at 500, applies a timeout and bounded retry policy, and never stores credentials. CLI listing and interactive discovery use a shorter two-second, no-retry request; RPC caches its bounded result for 30 seconds, while Server keeps the last successful cached discovery when refresh fails.

`--model <[provider/]model[:thinking]>` supports case-insensitive exact IDs/names and stable partial matching, preferring aliases over dated IDs and then the lexically newest candidate. Bare exact IDs shared by providers use the sole configured match; otherwise the diagnostic requires `provider/model`. Resolution tests the complete ID before interpreting the last colon as `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, so routed IDs containing `/` and provider IDs such as Bedrock's `:0` suffix are preserved. `--provider` constrains resolution and requires either `--model` or `--models`.

`--models <patterns>` accepts an ordered comma-separated scope of exact/fuzzy references and case-insensitive `*`, `?` or bracket globs. A valid `:thinking` suffix is carried per scope entry, duplicates keep their first position, and the first available match becomes the startup model unless `--model` explicitly selects another. Interactive `/model cycle` and RPC `cycle_model` reuse the same scope across configured providers and clamp its thinking level to model capabilities. `/model <reference>` uses the same full-ID-first resolver.

`--list-models [search]` validates and diagnoses settings, then exits before session/resource startup and prints provider, ID, context, maximum output, reasoning and image columns for configured-provider models. Search is case-insensitive subsequence matching with whitespace or slash-separated terms. `--api-key` requires a model or scope and creates only an in-memory provider override; it is never copied into model catalogues, RPC descriptors or sessions. Prefer environment or protected secret storage for durable credentials because command-line arguments may be visible in shell history or process listings.

```bash
ai-harness --list-models "sonnet 4"
ai-harness --model openai/o3:high --api-key "$OPENAI_API_KEY" --print "Review this patch"
ai-harness --models 'openai/o*:high,anthropic/*sonnet*:medium' --mode rpc
```

## Agent Settings

The CLI and RPC load `<agent-dir>/settings.json`, where the agent directory is `AI_HARNESS_AGENT_DIR` or `~/.ai-harness`, then merge trusted `<cwd>/.ai-harness/settings.json`. Project settings are blocked before project trust except for `sessionDir`, which startup resolves before trust. Settings files must be nonsymlink regular UTF-8 JSON objects no larger than 256 KiB. Unknown or invalid fields are ignored independently with bounded path-and-field diagnostics that do not print values. Legacy `queueMode`, `websockets`, skill-object, and `retry.maxDelayMs` forms migrate in memory; AiHarness does not rewrite either file.

Objects merge recursively, project scalar/array values override user values, and resource arrays are combined. A project `defaultTools` list containing only `+name`/`-name` entries modifies the user list; a list containing plain names replaces it. `cacheWarming`, `defaultProjectTrust`, `httpProxy`, and `deviceId` are agent-directory-only. `/settings` displays selected effective values and their `global`/`project` provenance without exposing proxy values or credentials.

Implemented runtime settings are startup provider/model, `enabledModels`, default/per-model thinking, default tools, session directory, compaction enable/reserve/keep values and exact model overrides, agent retry timing, RPC steering/follow-up queues, theme and TUI mode, `quietStartup: true`, external editor, shell path/prefix, local extensions, skills/prompts and `enableSkillCommands`. Explicit CLI options remain strongest. Session storage resolves an explicit session path, `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, settings `sessionDir`, then the AiHarness default.

Interactive `/reload` re-reads trust and settings, instructions, resource selectors, extensions, skill commands, default-tool additions, and reloadable shell callbacks. Session directory, startup model/thinking, terminal renderer/theme, queue defaults, compaction policy and retry policy are startup values and require a restart. The loader validates and reports the remaining documented fields, but package installation/built-in switches, custom theme resources, branch-summary generation, codemode, cache warming, provider transport/proxy/timeouts/retries, npm commands, detailed terminal/image/Markdown options, updates, telemetry and warnings are not yet applied by the CLI.

Configured skill and prompt paths resolve relative to the declaring agent directory or project `.ai-harness` directory. Ordered plain/`+` includes and exact/glob `-`/`!` exclusions are applied around automatic user/project roots. Discovery is trust-gated, symlink-free, bounded to 10,000 files, and each Markdown source is a race-checked UTF-8 regular file capped at 1 MiB. Local extension includes and ordered exclusions are honored; package resources, built-in extension switches and extension include globs remain outside the current custom loader.

## Instructions and System Prompts

Every interactive, print, JSON and RPC provider turn receives the same composed prompt from Core. The agent directory is `AI_HARNESS_AGENT_DIR` when set, otherwise `~/.ai-harness`. Context discovery chooses at most one file per directory in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. The user-level agent-directory file loads independently; after explicit project trust, ancestor files are appended from filesystem root to the startup cwd. `--no-context-files` (or `-nc`) disables both context sources, but does not disable system-prompt files.

Base prompt precedence is `--system-prompt <text|path>`, then trusted `<cwd>/.ai-harness/SYSTEM.md`, then `<agent-dir>/SYSTEM.md`, then Core's default coding prompt. Repeatable `--append-system-prompt <text|path>` values are appended in command-line order and replace automatic append-file discovery; without the flag, trusted `<cwd>/.ai-harness/APPEND_SYSTEM.md` takes precedence over `<agent-dir>/APPEND_SYSTEM.md`. For CLI values, an existing path is read and a nonexistent value is literal text. The server treats request/configuration prompt values as literal text and uses the same file discovery for trusted Web runs.

Instruction files must be nonsymlink regular UTF-8 files. Reads are capped at 256 KiB per source, 64 context files and 2 MiB total; binary, invalid, oversized or race-changed discovered files are diagnosed and skipped, while unsafe explicit path inputs fail startup. Contents resolved from disk are passed ephemerally to providers rather than copied into session settings. Interactive `/reload` recomputes the hierarchy and current trust state.

```bash
ai-harness --system-prompt ./SYSTEM.md \
  --append-system-prompt "Prefer small changes." \
  --append-system-prompt ./review-rules.md
ai-harness --print --no-context-files --system-prompt "Answer concisely." "Explain this diff"
```

## JSON Event Contract

`--mode json` reserves stdout for LF-delimited JSON objects through a serialized writer that waits for stream acceptance. Its first object is a version-3 session header; each supplied prompt then emits agent, turn, user/assistant message, text/reasoning delta, tool execution start/update/end, result, usage, terminal agent, and settled events. Assistant updates omit cumulative message/partial snapshots, tool-call starts retain normalized `id` and `toolName`, and streamed tool snapshots stay bounded. Diagnostics and accidental extension writes are redirected to stderr.

```bash
ai-harness --mode json --no-session "Review this repository" 2>/dev/null
```

Consumers must read stdout continuously and split only on LF. `message_end.message` is authoritative. The mode exits after all supplied prompts and returns nonzero when execution fails. Provider failures before the first delta use bounded retry and emit `auto_retry_start`/`auto_retry_end`; threshold compaction is wired through `compaction_start`/`compaction_end`, including summary usage when available. Usage separates uncached input, cache read/write and output; unknown models do not receive fabricated zero prices. Steering/follow-up queues and summarization-retry records remain RPC/runtime-only or incomplete.

## RPC Contract

The canonical request has a `type` and optional string `id`. Its correlated response is `{type:"response",command,success,data|error}`; uncorrelated lifecycle events can arrive between responses. Input and output are strict LF-framed JSONL—U+2028/U+2029 inside strings are not delimiters—and stdout is reserved before extensions load. Responses and events share one backpressured delivery queue; an asynchronous sink failure is terminal, stops later delivery, and is surfaced during command handling or shutdown.

```json
{"type":"get_state","id":"state-1"}
{"type":"prompt","id":"prompt-1","message":"Review this repository"}
{"type":"follow_up","id":"follow-1","message":"Now summarize it"}
```

Implemented groups include prompt/images and discovered prompt/skill expansion; immediate extension commands; steer/follow-up/queue clearing/abort and new sessions; state/messages and bounded cached configured-provider model listing, switching and cycling through the shared catalogue and ordered `--models` exact/fuzzy/glob scopes with per-entry thinking; capability-clamped thinking/queue modes; manual and threshold compaction; provider and summarization retry controls; trusted bounded bash with awaited incremental chunks, abort, private truncated `fullOutputPath` files and 24-hour cleanup; raw-history usage plus known-model context estimates; export/switch/in-place fork/clone/raw-entry/nested-tree/name/command discovery. Prompts acknowledge `started`, `queued`, `handled`, or errors before asynchronous events complete. Steering is injected after tool results before the next model turn, while follow-ups start a later agent lifecycle. Queue, thinking, session-info, retry, compaction, bash-update, and extension UI request records share the serialized stdout writer, and `abort_bash` waits for command cleanup before acknowledging. Built-in providers await stream consumers; a bounded pending queue terminates extension providers that ignore callback backpressure. Remaining functional gaps include authoritative metadata for every dynamic model, append-only schema evolution, exact branch/clone labels and summaries, complete tree accounting, every UI/extension method, exact concurrent ordering, and a complete native extension lifecycle.

The old `{id,method,params}` calls (`system.ping`, custom session/provider methods, and `chat.send`) remain accepted for migration but are not the primary contract. Normal startup session flags work in RPC; use `--session` instead of interactive-only `--resume`. `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, or settings `sessionDir` can isolate persistence, and `--no-session` keeps it in memory. Startup provider/model/API-key/thinking, instructions, settings resources, queues/retry/compaction, extensions, and tool selection are honored. Never write logs or TUI control sequences to stdout.

## Command Contract

Built-in metadata and handlers live in `commands/handler.ts`; extension commands are resolved after built-ins. The registry includes conversation/session lifecycle, provider/model/thinking, compaction/branching, import/export/share, resources, read-only effective `/settings`, extensions/tools/trust/reload, clipboard/search, and quit operations.

Interactive input beginning with `!` bypasses provider execution and runs in the trusted startup cwd. `!!` sets `excludedFromContext`; both variants stream into regular/fullscreen renderers, persist a parented command entry, participate in input/session history, and are cancelled with `Ctrl+C`. Core bounds stored output to 50 KiB for this adapter and retains complete truncated output in an owner-only temporary file for 24 hours. Agent settings `shellPath` and `shellCommandPrefix` apply to direct commands and the model `bash` tool and refresh interactively. The same parser and `ShellCommandRuntime` serve Web direct commands; the server file is only a compatibility re-export.

User-visible command help also exists in both TUI implementations. Never add a command only to the handler.

## Critical Conversation Flow

```text
input
  |-> Core instruction resolver -> bounded trust-aware system prompt
  |-> ! / !! -> trust check -> Core shell runtime -> stream + persist command
  `-> prompt/resource expansion or built-in/extension command
       -> before:agent -> persist user message
       -> Core runToolLoop
            -> before:provider -> provider stream
            -> before:tool -> tool -> persisted call/result -> next turn
       -> persist assistant response -> lifecycle events/rendering
```

An `AbortController` must reach provider and active tool work. Fullscreen and regular input share cancellation semantics; RPC accepts commands concurrently so abort and UI responses can resolve active asynchronous work without corrupting JSONL framing.

Interactive/print startup and the Web server register the same `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools from Core, plus `powershell` on Windows. Core also owns selection: CLI defaults expose `read,bash,edit,write` plus extension tools; `--tools`, `--exclude-tools`, `--no-builtin-tools`, and `--no-tools` are reapplied after reload. The detached Web runtime retains its scoped preset/allowlist behavior through that same selector. A provider call cannot execute a registered tool omitted from its run declarations.

Reads, searches, and CLI `@path` inputs are canonicalized inside the active workspace. `@path` accepts bounded UTF-8 text and signature-validated PNG/JPEG/GIF/WebP images; traversal, escaping links, binary text and oversized payloads fail before the provider call. `bash`, direct `!`/`!!`, `edit`, and `write` additionally require explicit project trust; command output, file reads, directory listings, and search results are bounded. All shared shell paths receive a filtered environment that removes credential-like variable names and terminate process trees with escalation; RPC streams raw output chunks without putting diagnostics on stdout.

## Persistence, Trust, and Extensions

- A normal invocation creates a new session. `--continue` reopens the newest session for the current workspace; `--resume` shows an interactive selector; `--session <path|id>` opens a file or ID prefix; `--session-id <id>` opens or creates an exact valid ID; and `--fork <path|id>` copies a source into a new session.
- `--name` applies a startup title. An explicit `--session <path>` keeps that file's parent directory; otherwise directory precedence is `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, settings `sessionDir`, then `~/.ai-harness/sessions`. `--no-session` disables persistence.
- Global JavaScript extensions load from `~/.ai-harness/extensions`; settings can add local exact file/directory paths.
- Project extensions under `.ai-harness/extensions` remain blocked until `ProjectTrustManager` approves the canonical cwd.
- Project settings/resources, ancestor context files and project `.ai-harness` system files are blocked until trust, apart from pre-trust `sessionDir`; user-owned files under the agent directory remain a separate source boundary. Run `/reload` after changing trust during an interactive session.
- `--extension` and `AI_HARNESS_EXTENSIONS` add explicit loader paths above settings.
- `/reload` re-resolves settings/resources and replaces the managed extension generation atomically; startup-only values require restart.
- Theme/keybinding files are user configuration; malformed input must fall back safely.

## Associated Tests

- `packages/cli/src/cli/{args,json-output,invocation,shell-controller}.test.ts` — strict options, JSON events, modes, process exits/stdout purity and direct shell trust/stream/abort/persistence
- `packages/core/src/providers/model-catalog.test.ts` and `packages/cli/src/cli/model-list.test.ts` — shared assembly/discovery, full-ID-first resolution, scopes, fuzzy listing and protocol metadata
- `packages/cli/src/providers/configured-providers.test.ts` — common environment, startup scopes and non-persistent key overrides
- `packages/cli/src/sessions/startup-session.test.ts` — startup selectors, exact IDs, naming, forking, cwd filtering and directory precedence
- `packages/cli/src/commands/handler.test.ts` — built-in commands, sessions, providers and import/export
- `packages/cli/src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.test.ts` — legacy migration requests, command envelopes/events/queues/state, compaction and extension dialogs
- `packages/core/src/config/agent-settings.test.ts` — safe schema loading, migration, trusted merge/global-only policy, provenance and value/path resolution
- `packages/core/src/prompts/{prompt-input,instruction-context}.test.ts` and `packages/core/src/tools/{tool-selection,shell-command-runtime,workspace-tools}.test.ts` — shared file/instruction ingestion, trust/precedence/bounds, tool policy and CLI/Web shell lifecycle
- `packages/cli/src/resources/resource-manager.test.ts` — AiHarness roots, trust, ordered resource selectors, precedence and bounded Markdown loading
- `packages/cli/src/agent/{tool-loop,provider-turn}.test.ts` — CLI re-exports and bounded pre-delta retry
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
