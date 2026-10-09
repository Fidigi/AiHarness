# CLI Interface

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

`ai-harness` has two interactive terminal renderers, a final-text print path, a one-shot JSONL event path, and a bidirectional JSONL RPC path. All execution modes reuse Core provider hooks, bounded retry, persistence, active-tool selection, and the multi-turn tool loop. RPC adds a typed command/response and asynchronous event adapter while retaining the former `method`/`params` requests as deprecated compatibility input.

Conversation persistence follows [`sessions.md`](./sessions.md), while extension hooks follow [`extensions.md`](./extensions.md). The built-in workspace tools are implemented once in Core and registered by both CLI and server startup. Core also owns package installation/state/inventory, model catalogue assembly/discovery/resolution, bounded all/one-at-a-time steering and follow-up scheduling, direct shell parsing, bounded process execution, cancellation, replay and command persistence; the CLI, RPC and Web/Server surfaces provide presentation or transport adapters around those contracts. Instruction discovery, system-prompt composition, protected-resource inventory and exact/inherited allow/refuse trust decisions likewise live once in Core and feed CLI plus Web/server adapters. The [public contract policy](../../contributors/en/public-contract-policy.md) defines compatibility and the independent golden harness for these surfaces.

## Architecture

```text
packages/cli/src/index.ts
  |-> package command -> Core PluginService -> shared plugins.json
  |-> mcp command -> Core inventory/mutations/Test -> shared mcp.json
  |-> Core model catalogue -> startup selection / --list-models / scoped cycling
  |-> Core instruction resolver -> composed provider system prompt
  |-> --mode rpc / --rpc -> rpc/rpc-server.ts
  |-> --mode json -> versioned JSONL event encoder
  |-> --print or redirected stream -> final-text print execution
  `-> terminal mode -> regular readline OR fullscreen raw input
         |-> active Enter / Alt+Enter -> Core AgentMessageQueue -> next turn/task
         |-> lone Escape -> active-operation cancellation + queued-input restoration
         |-> ! / !! -> CLI shell adapter -> Core ShellCommandRuntime
         `-> resource/command dispatch -> Core runToolLoop + McpSessionHost -> provider
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/cli/src/index.ts` | Startup, modes, sessions, trust, resources, hooks, streaming and shutdown |
| `packages/cli/src/cli/args.ts` | Strict option parsing, help/version, redirected-mode resolution and bounded stdin |
| `packages/cli/src/cli/json-output.ts` | Versioned session header plus agent/message/tool/retry/compaction JSONL encoding with guarded stdout |
| `packages/cli/src/cli/shell-controller.ts` | Interactive `!`/`!!` trust, streaming, cancellation and TUI adapter |
| `packages/cli/src/cli/model-list.ts` | Configured-provider `--list-models` metadata table and fuzzy filtering |
| `packages/cli/src/cli/package-command.ts` | Strict top-level package parsing, scopes, filters and Core service adapter |
| `packages/cli/src/cli/{mcp-command,mcp-oauth-command}.ts` | Thin top-level configuration/hidden/per-tool exposure and explicit OAuth login/logout adapters over Core MCP contracts |
| `packages/core/src/mcp/{session-host,oauth-provider-factory,oauth,oauth-flow}.ts` | Persistent per-session stdio/HTTP connections, passive encrypted OAuth use/refresh, detached explicit OAuth flows, and direct tool declarations/invocation shared by CLI, RPC and Web |
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
| `packages/core/src/plugins/plugin-service.ts` | Shared npm/Git/local package lifecycle, locked state, filters and sanitized resource inventory |
| `packages/cli/src/tui/terminal-ui.ts` | Regular readline output, help and streaming writer |
| `packages/cli/src/tui/fullscreen-{ui,input}.ts` | Alternate-screen rendering and raw-mode line editor |
| `packages/cli/src/tui/{mode,theme-manager}.ts` | Mode precedence and built-in/custom themes |
| `packages/cli/src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.ts` | Strict-LF dispatch, state/queue/session commands and extension-dialog bridge |
| `packages/cli/src/resources/resource-manager.ts` | Markdown prompts/resources, frontmatter and expansion |
| `tests/functional-parity/` | Manifest-driven process, transcript, session, extension and SDK golden probes |

## Execution Modes

| Mode | Selection | Notes |
|---|---|---|
| Fullscreen | Default on a supported TTY, `--tui-mode fullscreen`, legacy `--fullscreen`, or `AI_HARNESS_TUI_MODE=fullscreen` | Falls back safely when unsupported. |
| Regular | `--tui-mode regular`, legacy `--regular` / `--no-fullscreen`, unsupported terminal, or environment value | Uses Node readline. |
| Print | `-p` / `--print`, or redirected stdin/stdout | Runs supplied prompts and writes only the final assistant text to stdout. |
| JSON | `--mode json` | Runs supplied prompts, emits a session header and lifecycle events as strict JSONL, then exits. |
| RPC | `--mode rpc` or legacy `--rpc` | Bypasses interactive TUI selection and reads JSONL on stdin. |

Regular rendering prints status only at startup/prompt boundaries; fullscreen lays out header/transcript/editor/footer with compact/resize fallback for physically short screens. `tui/status.ts` projects actual raw journal accounting (active ancestors including pre-compaction vs full abandoned history), effective estimated context, known/partial/unknown costs, model/thinking, cwd/session persistence and loaded resources/instructions. Never traverse arbitrary progress details for billing or retroactively price old usage with the current model. `terminal-text.ts` statefully strips untrusted OSC/CSI/DCS/APC/C1/bidi controls while preserving trusted harmless SGR; conventional grapheme/cell widths are not a universal emulator guarantee. `PromptBoundaryRefresh` and composition invalidate old snapshots/prompts at every input/provider start/shutdown and guard current session/stream before synchronous display. Focused tests cover huge combining clusters, emoji widths, delayed refreshes and unchanged accounting; real regular/fullscreen PTYs exercise sessions, resize, shell-control suppression and cleanup.

CLI flags override `AI_HARNESS_TUI_MODE`; terminal capability determines whether fullscreen can actually run. Unknown options and missing values fail before loading sessions or executable resources. `--help` and `--version` are metadata-only exits. `--approve` (`-a`) and `--no-approve` (`-na`) provide opposing one-process project-trust overrides and never mutate `trust.json`; combining them is rejected.

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

## Credentials and Provider Network

CLI and Server compose the same Core `ProviderCredentialService`, encrypted-store format, network policy and process-local `CredentialRedactor`. Resolution order is environment, trusted `providerApiKeyCommands`, process memory, then AES-256-GCM storage when `AI_HARNESS_MASTER_KEY` is available. Conventional custom-provider variables are `AI_HARNESS_<ID>_API_KEY` and `<ID>_API_KEY`. `/credentials` lists value-free descriptors, `/login <provider>` performs bounded Device Flow, `/logout <provider>` removes the local record, and only exact `/credential reveal <provider>` may return a raw value—and only in an interactive local terminal.

`transport`, `httpProxy`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, and `retry.provider.{timeoutMs,maxRetries,maxRetryDelayMs}` flow into every built-in and extension/custom provider. Defaults are `auto`, 300-second request/idle deadlines, a 15-second WebSocket handshake and zero provider-level retries. Core uses bounded proxy dispatchers and stable errors without URL/body/header/proxy detail. OpenAI Responses supports SSE, WebSocket and session-cached WebSocket continuation; its cache has exclusive leases and bounded age/cardinality, and it falls back to SSE only before any WebSocket event.

Credential command configuration is executable trusted configuration. Its bounded stdout remains in memory and is immediately registered for raw/URI/base64/base64url/hex/JSON-escaped redaction. Independent streaming redactors protect provider/tool/shell/extension output, sessions, JSON/RPC channels and diagnostics even when a credential crosses chunk boundaries.

## Agent Settings

The CLI and RPC first call `resolvePreTrustAgentDirectory()`. `AI_HARNESS_AGENT_DIR` is used only when its canonical symlink-free location is outside the workspace; otherwise Core chooses an independent home/XDG/UID-temporary fallback or fails closed. This prevents project-controlled settings or `trust.json` from authorizing themselves. The resulting `<agent-dir>/settings.json` is merged with trusted `<cwd>/.ai-harness/settings.json`. Project settings are not opened before project trust; project `sessionDir` joins storage precedence only after trust resolves. Settings files must be hardlink-free, nonsymlink regular UTF-8 JSON objects no larger than 256 KiB by default. Unknown or invalid fields are ignored independently with bounded path-and-field diagnostics that do not print values. Legacy `queueMode`, `websockets`, skill-object, and `retry.maxDelayMs` forms migrate in memory; AiHarness does not rewrite either file.

Objects merge recursively, project scalar/array values override user values, and resource arrays are combined. A project `defaultTools` list containing only `+name`/`-name` entries modifies the user list; a list containing plain names replaces it. `cacheWarming`, `defaultProjectTrust`, `httpProxy`, and `deviceId` are agent-directory-only. `/settings` displays selected effective values and their `global`/`project` provenance without exposing proxy values or credentials.

Implemented runtime settings are startup provider/model, `enabledModels`, default/per-model thinking, default tools, session directory, compaction enable/reserve/keep values and exact model overrides, agent and provider retry timing, provider transport/proxy/deadlines, trusted API-key commands, interactive/RPC steering and follow-up queues plus their delivery modes for detached trusted Web runs, `defaultProjectTrust`, theme and TUI mode, `quietStartup: true`, external editor, shell path/prefix, local extensions, skills/prompts and `enableSkillCommands`. Explicit CLI options remain strongest. Session storage resolves an explicit session path, `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, settings `sessionDir`, then the AiHarness default.

Interactive `/reload` re-reads saved trust and settings, credentials, network policy, provider/model/thinking selection, package inventory, instructions, resource selectors, extensions, skill commands, default-tool additions, steering/follow-up delivery modes, shell callbacks and the active theme. Session-only and command-line trust decisions remain process-local across reload. Session directory, terminal renderer kind, RPC queue defaults and existing persisted-session location remain startup values. Built-in extension switches, branch-summary generation, cache warming, configurable npm commands, detailed terminal/image/Markdown options, updates, telemetry and warnings are not yet applied by the CLI.

Configured skill and prompt paths resolve relative to the declaring agent directory or project `.ai-harness` directory. Ordered plain/`+` includes and exact/glob `-`/`!` exclusions are applied around automatic user/project roots. Discovery is trust-gated, symlink-free, bounded to 10,000 files, and each Markdown source is a race-checked, hardlink-free UTF-8 regular file capped at 1 MiB. Core records metadata-only scope/source/origin/selector/trust provenance. CLI, RPC and Server skill catalogues require frontmatter with non-empty `name` and `description`; the normalized name must exactly match its directory, and `disable-model-invocation`, when present, must be `true` or `false`. Local extension includes and ordered exclusions are honored; extension files are revalidated as bounded nonlinked regular files before import. Enabled package extensions, skills, prompts and themes join the same interactive/print/JSON/RPC startup and reload paths; a selected package theme can be addressed by its JSON filename stem. Built-in extension switches and settings extension include globs remain outside the current custom loader.

## MCP Administration and Runtime

MCP configuration is shared with the Web server: global entries live in `<agent-dir>/mcp.json`, project entries in `<cwd>/.ai-harness/mcp.json`, and project reads or writes require a saved exact/inherited allow. Process-only `--approve` does not unlock MCP project bodies. Top-level administration exits before providers, sessions, extensions or the TUI:

```bash
ai-harness mcp list --global
ai-harness mcp list --project --json
ai-harness mcp add docs --url https://docs.example.test/mcp
ai-harness mcp add local -- node ./server.mjs
ai-harness mcp test local
ai-harness mcp disable local
ai-harness mcp exposure docs deferred
ai-harness mcp exposure docs hidden --tool lookup
ai-harness mcp login docs --no-open --timeout 120
ai-harness mcp logout docs
ai-harness mcp remove local
```

`list` is file-only and value-free. `test` rereads one exact target and uses Core's bounded short-lived diagnostic. Add/mutation commands use the same schema, revision, trust, lock and atomic writer as Settings; the adapter never serializes removed entry data. `ai-harness mcp --help` is authoritative. Top-level `mcp login <name>` uses Core's detached loopback/paste flow, requires encrypted durable storage before network access, and opens a browser unless `--no-open`. Authorization/callback addresses go to stderr; paste is available on a TTY. `--timeout` is an integer 1–300 seconds (default 300); SIGINT/SIGTERM cancels and closes the listener (exit 130), expiry/failure exits 1 and success 0. `mcp logout <name>` removes local credentials without issuer revocation. `--scope global|project` and `--json` use the common management adapter. Interactive slash/RPC sign-in commands are not provided. When `AI_HARNESS_MASTER_KEY` and the same independently trusted agent/data directory are configured, CLI and RPC persistent hosts reuse Core's encrypted MCP OAuth state and passive provider factory: ordinary prompts may use/refresh stored credentials but never publish an authorization URL. One-shot `mcp test` remains OAuth-free.

Interactive `/mcp` reports the current process-local persistent states; `/mcp tools` prepares and lists direct tools, and `/mcp reconnect` closes the session's records before a fresh preparation. Interactive, print/JSON and modern RPC prompts all use Core's `McpSessionHost`. It rereads config/trust before every prompt, reuses unchanged exact connections, awaits only `direct` servers, and exposes provider-safe names such as `mcp__docs__lookup`; normalized collisions receive stable hash suffixes. Session `chat-only` exposes none, while `read-only` accepts only server-declared `readOnlyHint` tools. Disabled, hidden, codemode and deferred tools are not direct declarations. Exposure accepts `direct|codemode|deferred|hidden`; `--tool <exact-remote-name>` atomically writes a `toolExposure` override instead of the server default. Hidden tools are excluded from discovery and nested execution; wholly hidden servers do not connect for prompts unless a non-hidden override makes them eligible.

When an allowed codemode/deferred MCP or extension tool exists, Core declares the synthetic model-only `tool_search` tool without declaring candidate schemas. It ranks bounded name, description, schema and namespace text with BM25 (eight matches by default), waits for indirect MCP metadata only after a search, and makes successful deferred matches available on the next provider call—not later calls in the same response. The activation list is persisted on the search result and follows the active branch through resume and fork. Every restoration reapplies the current preset, `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, extension policy and MCP `readOnlyHint`; forged/stale names cannot bypass declarations. `codemode` exposure is searchable but remains script-only, even after activation; it never manufactures sandbox permission. Static, discovered and direct MCP calls all pass through the same Core hooks/events and persistence loop, with bounded/redacted results and cancellation. Connections close after the post-prompt idle window or process shutdown.

## QuickJS Code Mode

Core's [bounded code-mode contract](./codemode.md) is shared by CLI/JSON/RPC and Web. The helper is inactive by default: explicitly include `codemode` and permitted nested tools in `--tools` or `defaultTools`. Trusted `codemode.mode` selects `on`/`only`, and `codemode.inlineBudget` accepts 0–3000 estimated tokens. Existing replacement allowlists, exclusions, no-tools/no-builtins, extension ownership and presets still apply. Automatic activation is possible with configured code-mode settings and eligible indirect tools.

User source is an async body evaluated only inside QuickJS in a disposable resource-limited worker. It exposes eligible `tools`, `ALL_TOOLS`, bounded metadata/namespace helpers, async parallel calls, text/console/return/exit and branch-local JSON store/load. Nested tools return redacted text and pass through the common hooks; hidden/model-only controls, recursive code mode and `spawn_subagent` are unavailable. Every call, including queued calls, reapplies eligibility and MCP read-only policy. Guest scripts have no Node/files/network/timers, and classifier/image execution is unsupported. Deadline, fuel, VM/stack, source/input/output, aggregate results, call/concurrency and store ceilings are documented in the Core topic. Failure/cancellation terminates the worker, aborts outstanding tools and discards new store values; already performed host effects are not rolled back.

## Package Administration

Package commands exit before provider, session, executable-extension or TUI startup. Use `ai-harness package --help` for the complete action help. `install`, `remove`/`uninstall`, `update`, `list`, and `config` are direct aliases; every action also has the explicit `package` form:

```bash
ai-harness package install npm:@scope/review-kit@^2.0.0 --global
ai-harness package install ./workspace-kit --project --approve
ai-harness package list --json
ai-harness package configure @scope/review-kit \
  --extensions='extensions/*.mjs,!extensions/unsafe.mjs' \
  --skills='+skills/review' --prompts='prompts/**' --themes=
ai-harness package check @scope/review-kit
ai-harness package update @scope/review-kit
ai-harness package disable @scope/review-kit
ai-harness package reload
ai-harness package remove @scope/review-kit
```

Sources are explicit `npm:<package>[@version]`, `git:<https-url>[#ref]`, or absolute/`./`/`../` local paths. Registry and Git installs are staged under the agent directory with npm lifecycle scripts disabled and shallow Git clones; local sources remain in place. `list` and `reload` never contact a remote source, while `check`, `install`, and `update` may. `--json` emits the sanitized catalogue or update result. A selector may be the stable key, normalized source, package name, or resolved local path; ambiguous names require `--scope global|project`.

`package configure` can narrow each manifest-declared resource kind with comma-separated package-relative paths or globs. `+path` is an exact include, `-path` an exact exclusion, and `!glob` a glob exclusion; an empty option such as `--themes=` disables that kind. `--reset` restores manifest defaults. Filters never add a resource the package did not declare.

The shared Core service persists non-secret state in `<agent-dir>/plugins.json`, serializes inter-process mutation with a heartbeat lock, performs owner-only atomic writes, validates paths and bounded manifests without following resource symlinks, and rolls back failed managed-package replacements. Project installation, configuration, enabling, updating, and resource loading require resolved project trust; disabling and removal remain available as safe cleanup, and `--approve` is only a one-process decision. The Server/Web API uses the same service through a thin adapter, so package state, source policy, inventory and updates are not maintained twice.

## Instructions and System Prompts

Every interactive, print, JSON and RPC provider turn receives the same composed prompt from Core. The agent directory is `AI_HARNESS_AGENT_DIR` when set, otherwise `~/.ai-harness`. Context discovery chooses at most one file per directory in this order: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. The user-level agent-directory file loads independently; after resolved project trust, ancestor files are appended from filesystem root to the startup cwd. `--no-context-files` (or `-nc`) disables both context sources, but does not disable system-prompt files.

Base prompt precedence is `--system-prompt <text|path>`, then trusted `<cwd>/.ai-harness/SYSTEM.md`, then `<agent-dir>/SYSTEM.md`, then Core's default coding prompt. Repeatable `--append-system-prompt <text|path>` values are appended in command-line order and replace automatic append-file discovery; without the flag, trusted `<cwd>/.ai-harness/APPEND_SYSTEM.md` takes precedence over `<agent-dir>/APPEND_SYSTEM.md`. For CLI values, an existing path is read and a nonexistent value is literal text. The server treats request/configuration prompt values as literal text and uses the same file discovery for trusted Web runs.

Instruction files must be nonsymlink regular UTF-8 files. Reads are capped at 256 KiB per source, 64 context files and 2 MiB total; binary, invalid, oversized or race-changed discovered files are diagnosed and skipped, while unsafe explicit path inputs fail startup. Contents resolved from disk are passed ephemerally to providers rather than copied into session settings. Interactive `/reload` recomputes the hierarchy and current trust state.

```bash
ai-harness --system-prompt ./SYSTEM.md \
  --append-system-prompt "Prefer small changes." \
  --append-system-prompt ./review-rules.md
ai-harness --print --no-context-files --system-prompt "Answer concisely." "Explain this diff"
```

## Public Contract and Parity Policy

AiHarness owns its executable syntax, JSON/RPC envelopes, session schema, extension API and Core exports. Functional comparison never requires a reference package import or a drop-in foreign interface. `AI_HARNESS_CORE_API_VERSION` and `AI_HARNESS_EXTENSION_API_VERSION` are currently `1`; extension factories receive the latter as `api.version`. Session JSONL is v2, and the JSON event header is v3. The legacy RPC `method`/`params` shape is migration input only.

`tests/functional-parity/fixtures/manifest.json` maps behavior-level scenarios to every `CLI-RUN-*`, `CLI-SES-03–04`, `CLI-EXT-02` and `CLI-AUT-*` audit family requested by the harness. Checked-in positive and negative goldens cover process exits/channels, JSON/RPC transcripts, current and legacy sessions, extension loading/interactions, and built-package TypeScript/runtime probes. Mapping a criterion means its public boundary is guarded; it does not close behavior that remains incomplete inside that criterion.

Canonicalization is intentionally narrow: temporary paths, UUIDs, timestamps, measured durations, generated workspace IDs and JSON object-key order are unstable. Event order, record count, payload meaning, usage, failures, exit status and stdout/stderr assignment remain exact. Goldens have no implicit update mode and must be edited and reviewed deliberately. Run the focused Docker target with `make test-parity`; the root `make test` includes the same suite.

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

Built-in metadata and handlers live in `commands/handler.ts`; extension commands are resolved after built-ins. The registry includes conversation/session lifecycle, provider/model/thinking, compaction/branching, import/export/share, resources, read-only effective `/settings`, extensions/tools/trust/reload, clipboard/search, and quit operations. `/trust` reports exact versus inherited provenance, can save an exact allow or refusal, can allow the parent for descendants, can forget the exact decision, and lists both positive and negative decisions. `/share [hours]` accepts only 1–168 hours, sends credentials only to an HTTPS server or direct loopback HTTP server, disables redirects, and bounds/validates the response before displaying its value.

While an interactive response is active, `Enter` queues steering for the next model boundary and `Alt+Enter` (or `Ctrl+Q` where the terminal reserves modified Enter) queues a follow-up after steering work settles. Core applies `steeringMode` and `followUpMode`: `one-at-a-time` delivers one queued message per response, while `all` delivers the pending kind as one boundary batch. `Alt+Up` restores pending text to the editor; interruption restores it automatically. Both terminal renderers accept input without serializing it behind the active provider call. Commands and direct shell input are restored rather than run concurrently. Their shared terminal decoder waits briefly to distinguish lone `Escape` from split `Alt+Enter`; lone `Escape` aborts active provider/tool/shell work or cancels multiline input, but does not exit an idle CLI. `Ctrl+C` retains the idle-exit behavior.

Interactive input beginning with `!` bypasses provider execution and runs in the trusted startup cwd. `!!` sets `excludedFromContext`; both variants stream into regular/fullscreen renderers, persist a parented command entry, participate in input/session history, and are cancelled with `Escape` or `Ctrl+C`. Core bounds stored output to 50 KiB for this adapter and retains complete truncated output in an owner-only temporary file for 24 hours. Agent settings `shellPath` and `shellCommandPrefix` apply to direct commands and the model `bash` tool and refresh interactively. The same parser and `ShellCommandRuntime` serve Web direct commands; the server file is only a compatibility re-export.

User-visible command help also exists in both TUI implementations. Never add a command only to the handler.

## Critical Conversation Flow

```text
input
  |-> Core instruction resolver -> bounded trust-aware system prompt
  |-> ! / !! -> trust check -> Core shell runtime -> stream + persist command
  `-> prompt/resource expansion or built-in/extension command
       -> before:agent -> persist user message
       -> Core McpSessionHost refresh -> direct declarations
       -> Core runToolLoop
            -> before:provider -> provider stream
            -> before:tool -> tool -> persisted call/result
            -> consume bounded steering batch before the next model turn
       -> consume steering before follow-up work
       -> persist assistant response -> lifecycle events/rendering
```

An `AbortController` must reach provider and active tool work. Fullscreen and regular input share cancellation semantics; RPC accepts commands concurrently so abort and UI responses can resolve active asynchronous work without corrupting JSONL framing.

Interactive/print startup and the Web server register the same `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools from Core, plus `powershell` on Windows. Core also owns selection: CLI defaults expose `read,bash,edit,write` plus extension tools; `--tools`, `--exclude-tools`, `--no-builtin-tools`, and `--no-tools` are reapplied after reload. The detached Web runtime retains its scoped preset/allowlist behavior through that same selector. A provider call cannot execute a registered tool omitted from its run declarations.

Reads, searches, and CLI `@path` inputs are canonicalized inside the active workspace. `@path` accepts bounded UTF-8 text and signature-validated PNG/JPEG/GIF/WebP images; traversal, escaping links, binary text and oversized payloads fail before the provider call. `bash`, direct `!`/`!!`, `edit`, and `write` additionally require resolved project trust; command output, file reads, directory listings, and search results are bounded. All shared shell paths receive a filtered environment that removes credential-like variable names and terminate process trees with escalation; RPC streams raw output chunks without putting diagnostics on stdout.

## Persistence, Trust, and Extensions

- A normal invocation creates a new session. `--continue` reopens the newest session for the current workspace; `--resume` shows an interactive selector; `--session <path|id>` opens a file or ID prefix; `--session-id <id>` opens or creates an exact valid ID; and `--fork <path|id>` copies a source into a new session.
- `--name` applies a startup title. An explicit `--session <path>` keeps that file's parent directory; otherwise directory precedence is `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, settings `sessionDir`, then `~/.ai-harness/sessions`. `--no-session` disables persistence.
- Global JavaScript extensions load from `~/.ai-harness/extensions`; settings can add local exact file/directory paths. Enabled package extensions come from the shared Core package catalogue.
- Project extensions under `.ai-harness/extensions`, project package resources, and package themes remain blocked until `ProjectTrustManager` resolves the canonical cwd as trusted.
- Before inspecting project resource bodies, Core inventories bounded path metadata for `.ai-harness` settings/resources/system prompts, project skills/prompts and enabled ancestor context candidates. Interactive `ask` mode prompts only when that inventory is non-empty; print/JSON/RPC `ask` mode refuses it safely, while global `always`/`never` and process flags resolve without a prompt. An implicitly safe empty folder may use operations, but its separate body-loading gate stays closed against resources that appear after inventory.
- Saved trust is a canonical v2 decision map shared with the Web server. The nearest exact/ancestor allow or refusal wins, v1 allow-lists migrate on mutation, reads refresh across processes, unsafe store files fail closed, and writes are lock-serialized, private and atomic.
- Project settings/resources, ancestor context files and project `.ai-harness` system files are blocked until the resolved process trust allows them, including project `sessionDir`; user-owned files under the agent directory remain a separate source boundary. Run `/reload` after changing a saved decision during an interactive session.
- `--extension` and `AI_HARNESS_EXTENSIONS` add explicit loader paths above settings.
- `/reload` re-resolves settings/resources and replaces the managed extension generation atomically; startup-only values require restart.
- Themes `dark`, `light`, and `system` are built in. `system` immediately supplies a contrast-safe fallback, then performs a 100 ms bounded OSC 10/11 and ANSI 0–15 probe, accepts valid late/light-dark notification reports, and live-renders the updated palette. Readline/fullscreen receive a filtered input stream so OSC/CSI reports never become keystrokes. Custom themes support bounded variables, named/hex/ANSI-index colors, rich renderer tokens and optional export colors; project-located themes require trust even when selected explicitly. `/theme [name]` applies a live replacement.
- Theme/keybinding files are user configuration; malformed input must fail or fall back safely without reflecting file bodies.

## Associated Tests

- `packages/cli/src/cli/{args,json-output,invocation,shell-controller,package-command}.test.ts` — strict options and package parsing, JSON events, package/resource process integration, modes, process exits/stdout purity, real pseudo-terminal steering/follow-up ordering and direct shell trust/stream/abort/persistence
- `packages/cli/src/cli/{mcp-command,mcp-oauth-command}.test.ts` — strict management/exposure parsing and a real loopback PKCE login, encrypted persistence/logout, invalid storage/timeout, cancellation/expiry and listener closure
- `packages/core/src/tools/codemode.test.ts` — sandbox budgets, isolation, live nested authorization and transactional branch store
- `packages/core/src/plugins/plugin-service.test.ts` — npm/Git/local source policy, filters, trust, symlink rejection, atomic state and concurrent mutation
- `packages/core/src/providers/{model-catalog,credentials,provider-network,provider-websocket.integration}.test.ts` and `packages/cli/src/cli/model-list.test.ts` — shared assembly/discovery, credential/network bounds, real local WebSocket/proxy behavior, full-ID-first resolution, scopes, fuzzy listing and protocol metadata
- `packages/cli/src/providers/configured-providers.test.ts` — common environment, startup scopes and non-persistent key overrides
- `packages/cli/src/sessions/startup-session.test.ts` — startup selectors, exact IDs, naming, forking, cwd filtering and directory precedence
- `packages/cli/src/commands/handler.test.ts` — built-in commands, sessions, providers and import/export
- `packages/cli/src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.test.ts` — legacy migration requests, command envelopes/events/queues/state, compaction and extension dialogs
- `packages/core/src/config/agent-settings.test.ts` and `packages/core/src/security/project-trust.test.ts` — safe schema loading, migration, trusted merge/global-only policy, provenance, resource-sensitive exact/inherited/refused trust, cross-process refresh and path resolution
- `packages/core/src/prompts/{prompt-input,instruction-context}.test.ts` and `packages/core/src/tools/{tool-selection,shell-command-runtime,workspace-tools}.test.ts` — shared file/instruction ingestion, trust/precedence/bounds, tool policy and CLI/Web shell lifecycle
- `packages/cli/src/resources/resource-manager.test.ts` and `packages/cli/src/security/project-trust.test.ts` — AiHarness roots, CLI trust adapter, ordered resource selectors, precedence and bounded Markdown loading
- `packages/cli/src/agent/{tool-loop,provider-turn}.test.ts` — CLI re-exports and bounded pre-delta retry
- `packages/cli/src/extensions/extension-loader.test.ts` — explicit extension paths and reload
- `packages/cli/src/tui/mode.test.ts` — flag/environment/capability precedence
- `packages/core/src/agent/{message-queue,runtime}.test.ts` — common queue modes/bounds plus detached Web scheduling
- `packages/cli/src/tui/{terminal-ui,fullscreen-ui,fullscreen-input,theme-manager,theme-input-filter}.test.ts` — rendering, concurrent input, queue shortcuts/editor restoration, adaptive themes and OSC/CSI-to-keypress filtering
- `tests/functional-parity/functional-parity.test.ts` — positive/negative CLI and automation goldens, stdout purity, session migration, extension API versioning and built-package SDK probes

## Common Changes

### Add a slash command

Register and test it in `commands/handler.ts`, verify dispatch/completion in `index.ts`, update regular and fullscreen help, then update both language versions of the user guide.

### Change terminal input or rendering

Update both interactive paths where behavior is shared. Test narrow dimensions, ANSI/Unicode width, history/completion, cancellation, external editor transitions, and terminal restoration.

### Change RPC

Keep stdout strictly JSONL, validate untrusted IDs/params, update RPC tests, affected functional-parity transcripts and automation documentation, and preserve cancellation/persistence semantics. A deliberate golden change follows the bilingual public contract policy and requires migration/version handling when breaking.

## Related Domains

- [`codemode.md`](./codemode.md) — shared sandbox, ceilings and branch store
- [`providers.md`](./providers.md) — provider initialization and streaming
- [`sessions.md`](./sessions.md) — JSONL persistence, branches and compaction
- [`extensions.md`](./extensions.md) — commands, hooks, tools and trusted loading
- [`security.md`](./security.md) — project trust and credential handling
