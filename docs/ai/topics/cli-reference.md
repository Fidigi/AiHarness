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
  |-> auth command -> passive Core credentials / explicit bounded device flow
  |-> export command -> selected Core JSONL projection / existing renderer + atomic writer
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
| `packages/cli/src/cli/startup-display.ts` | Validated quiet/header/full startup presentation and process-only verbose precedence |
| `packages/cli/src/cli/offline-mode.ts` | Process-only offline environment snapshot; authoritative CLI flag composition |
| `packages/cli/src/cli/json-output.ts` | Versioned session header plus agent/message/tool/retry/compaction JSONL encoding with guarded stdout |
| `packages/cli/src/cli/shell-controller.ts` | Interactive `!`/`!!` trust, streaming, cancellation and TUI adapter |
| `packages/cli/src/cli/model-list.ts` | Configured-provider `--list-models` metadata table and fuzzy filtering |
| `packages/cli/src/cli/package-command.ts` | Strict top-level package parsing, scopes, filters and Core service adapter |
| `packages/cli/src/cli/{provider-auth-command,export-command}.ts` | Strict standalone credential metadata/device login/local logout and trusted explicit session export before agent startup |
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
| `packages/cli/src/utils/{keybinding-manager,keybinding-config,keybinding-source,terminal-actions,keypress-gate,hotkey-view}.ts` | Data-only bounded configuration, literal trusted source, declarative actions, pre-native dispatch and passive view |
| `packages/cli/schemas/{keybindings,theme}.schema.json`, `packages/cli/scripts/copy-assets.mjs` | Runtime-documented keyboard/palette grammar and byte-exact installed schema assets; [Core palette authority](./themes.md#shipped-palette-schema) remains separate |
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

`quietStartup` defaults to `false`: show the installed CLI version/title, hints and initial status snapshot. `"header"` keeps the title/hints but suppresses the initial snapshot; `true` skips both. Strict boolean `--verbose` overrides either quiet value without mutating settings; `-v` remains version. Core reserves the long name against extension registration. Both renderers keep startup detail suppression across empty input, palette updates and redraws, then restore normal live status on the first nonempty submitted line or initial prompt. Fullscreen still retains its operational frame/editor. Resource loading, trust prompts and warnings are not suppressed. Headless print/JSON/RPC channels do not acquire startup text. Reload updates the saved preference for a future start, not the current startup phase. `startup-display{,-process}.test.ts` covers policy, control-safe configured titles, real PTYs, trusted layer precedence, reload and headless purity.

CLI flags override `AI_HARNESS_TUI_MODE`; terminal capability determines whether fullscreen can actually run. Unknown options and missing values fail before session/provider startup, but contributed-option discovery may execute eligible trusted extensions. `--help` and `--version` remain metadata-only exits. `--approve` (`-a`) and `--no-approve` (`-na`) provide opposing one-process project-trust overrides and never mutate `trust.json`; combining them is rejected.

An explicit provider `stopReason: length` preserves partial (or empty) text and journal usage. Print and JSON finish their existing output, write one fixed warning to stderr and exit 1 if any supplied prompt reaches the model output limit, even if a later prompt completes. JSON/RPC authoritative assistant messages and RPC history expose `stopReason: "length"`; lifecycle framing and JSON header v3 are unchanged. RPC stays alive for subsequent requests: command acceptance is not proof of a complete model answer. Ordinary text containing “length” and truncated tool results do not trigger this policy.

## Terminal Keybindings and Passive View

`terminal-actions.ts` declares 22 application/editor actions without ambient process/stdout authority; `index.ts` registers real regular/fullscreen callbacks. `KeypressFilteredInput` gates public `keypress` emission before native listeners, after theme-report filtering. Consumed events do not also reach readline; explicit `preventDefault:false` deliberately passes through. Native editor bridges use public methods without recursively entering the stream gate. Ctrl+C/Ctrl+D/Escape retain driver safety ownership, including Node's meta-tagged bare-Escape alias; split Escape/Enter preserves the existing 25 ms decoder and 100 ms grace. Closed editor drivers cannot publish late replacements or reenter raw mode.

The default literal source is `<resolved-agent-dir>/keybindings.json`; a nonempty startup-captured `AI_HARNESS_KEYBINDINGS` overrides it. Relative paths use startup cwd, `~/` uses home, brackets stay literal. The independently trusted agent-directory and project-resource gates remain separate; an explicit project path grants no trust. No automatic project or package-keybinding layer is added. Core's exported `readBoundedResourceText` admits stable regular single-link UTF-8 bytes, with safe ancestors. Print/JSON/RPC never load this terminal configuration.

The strict array grammar caps the file at 65,536 UTF-8 bytes/512 entries, ID/action at 256 bytes and descriptions at 512. Entries require `id`/`keys`; only `action`, `description`, boolean `preventDefault` are optional. Case/aliases normalize one nonmodifier and at most five parts; controls/bidi, unknown fields, duplicate IDs/chords and reserved-key reassignment fail value-free. Unknown actions stay inert until explicitly registered; legacy saved-default IDs synthesize no authority. Configured chords override matching defaults, not every chord for an action. Runtime validation owns byte/normalized/reserved constraints beyond the schema, shipped unchanged to `dist/schemas/keybindings.schema.json`.

`KeyBindingManager` publishes complete owned config layers using latest-request generation; clear/reload/shutdown retire stale reads. Invalid same-source candidates retain published bindings, never partially apply or revive stale unpublished ones. Changed/unavailable sources clear their old layer; an absent default file restores defaults quietly. `/reload` rereads bytes but the environment path remains startup-captured. Programmatic action admission requires own data fields; matching evaluates an eligible predicate once, while view projection invokes neither predicates, handlers nor serializers.

F1/Alt+K opens `HotkeyView`: all 22 actions plus registered/configured inventory, effective chords and reserved/conditional/unavailable/unbound states. Filtering/paging is read-only, bounded to eight rows/page, a 256-codepoint query and cell-clipped output; current registered credentials are redacted on complete metadata/input **before** clipping. `:next`, `:prev`, `:all`, empty Enter and arrows browse; `:close`/Escape/F1/Alt+K close. Modal queries never dispatch commands/providers/external editors or enter native history. Both hosts restore exact draft/caret and preserve underlying transcript/stream/scroll; native safety input remains available.

Regular transcript actions display actual 20-entry older/newer previews with clamped direction, anchored arrivals and one cell-bounded control-safe redacted row per entry. The existing buffer remains capped at 500 entries/16 MiB; paging does not mutate live streaming or editor state. This is not complete journal browsing, mouse/selection/scrollbar/image/hyperlink support or general terminal certification. See the [EN](../../users/en/terminal-keybindings.md)/[FR](../../users/fr/terminal-keybindings.md) operational grammar and action inventory, and [theme source/system contracts](./themes.md).

## Credential Authority During Startup

Trusted contributed options require a bootstrap pass followed by definitive arity parsing. A bootstrap `apiKey` candidate is diagnostic-only: a separate environment/candidate redactor conservatively masks an extension-startup parse error, without adding guessed prompt bytes to the long-lived output/provider redactor. Only the definitive `--api-key` value joins runtime credential authority. Thus a literal `--api-key value` after the first positional prompt stays data; it cannot expurgate that value or replace an earlier genuine key. Environment/resolved credentials and their encoded variants retain normal redaction through print/JSON/RPC, interactive turns and reload. No parser syntax, public option, session or wire schema changes.

## Offline Startup Policy

Strict, reserved and idempotent `--offline`, or trimmed case-insensitive `AI_HARNESS_OFFLINE=1|true|yes`, suppress automatic provider model discovery, credential commands and OAuth refresh. Other environment values leave the default online policy. `--offline=<value>` refuses before executable admission. Capture environment policy before trusted extension registration, then compose it with the **authoritative** parsed flag, never the bootstrap's unknown-arity guess. Thus a prompt token after a contributed boolean remains prompt text. The immutable process choice survives interactive reload and extension environment mutation; it is not a saved setting or wire/session field.

Startup scopes, `--list-models`, `/model` and RPC listing/cycling use configured/published metadata without discovery. `createCliProviderRuntime` passes explicit Core command/refresh denials at initial composition and reload; a selected command is unavailable without executing or consuming its cached value, not replaced by a lower-priority key. OAuth inside the existing 60-second refresh window is unavailable without refresh or credential mutation. Environment/static keys and still-usable OAuth retain their ordinary precedence. Unknown live-only models and authoritative dynamic metadata are not invented. Embedded `runRpcMode({ offline })` can explicitly override its environment default; the controller skips both provider discovery and an injected catalogue callback while offline.

This is not a firewall or sandbox: explicit model requests, authentication/share/package administration, pre-prompt MCP work, tools and privileged extension/provider code retain their normal network/execution authority. No automatic CLI version check or package update is introduced. There is no Server/Web global offline switch, persisted catalogue cache or PWA change. Use host/container network policy for an actual prohibition. Print/JSON/RPC output remains free of an offline banner; the installed exact help adds only the new option/environment lines. Core defaults remain online unless a host supplies its new explicit policies; see [provider policies](./providers.md#explicit-passive-provider-policies).

## Optional Branch Navigation

`/navigate` lists the latest 128 bounded, terminal-safe entry identities without private custom state/details. `/navigate <entry-id> --no-summary` selects one; `--summarize [--instructions "focus"]` explicitly authorizes a tool-free current-provider summary of the abandoned suffix. Without a flag, repeat the command with a choice; `branchSummary.skipPrompt: true` defaults to **no summary**, never automatic generation. `branchSummary.reserveTokens` applies only to requested generation. Conflicting/unknown options and instructions without generation are refused. Print/JSON positional slash text remains literal.

Canonical RPC adds `{type:"navigate_tree",id,entryId,summarize?,customInstructions?,replaceInstructions?}`. Generation is opt-in, booleans are strict, and instructions require `summarize:true`. The correlated response reports `cancelled`, `stale`, `leafId` and optional `summaryEntryId`. `get_entries` exposes custom identity/type and custom-message content/display, not state/details; summary source `fromId` is provenance, not `parentId`. An independent root and an explicitly empty active head retain null parent/head identities.

Both terminals own foreground admission and Esc/Ctrl-C cancellation; RPC permits reads/abort but refuses competing foreground changes. EOF/close retires requests even before awaited admission registers its controller. Source mutation, cancellation before write admission, provider failure and persistence failure cannot publish the navigation; an already admitted durable write is not rolled back. Non-cooperative host callbacks/stores may delay settlement. Core owns context reconstruction and conservative Unicode/input/output budgets; see [sessions](./sessions.md#optional-navigation-summaries). Actual local-provider HTTP, process/EOF, regular/fullscreen PTY and genuine installed Core/PATH-bin probes cover these boundaries.

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

## Standalone Authentication and Export

`index.ts` dispatches `auth` and `export` before global argument/startup composition. Root help advertises both without executing extensions. See [EN](../../users/en/standalone-operations.md) / [FR](../../users/fr/standalone-operations.md) for exact grammar, scopes, channels and limitations.

- `auth list [--json]` is stored/configuration-presence metadata only: no commands, refresh, providers or agents. Login/logout require the independent encrypted Core store. Operator HTTPS device configuration is explicit; there is no bundled registration, browser opener/callback or PKCE here. Caller abort reaches the existing 15-second bounded client transport/body without changing global fetch. Overall login timeout is monotonic (1–300 seconds, default 300), additionally limited by device lifetime. Reject user codes changed by UTF-8, terminal formatting or known-secret redaction before instructions/poll/publication. Instructions use stderr, fixed acknowledgements stdout; exits are 0/2/1/124/130. Local logout is not remote revocation; a started encrypted commit is not cancellation rollback.
- `export` requires exact/unambiguous/path selection and explicit matching-format output. Only the selected existing store/workspace grants input authority; output stays in a freshly approved current workspace. Core no-follow loading, copied/redacted memory-only normalization, shared slash exporter and atomic 0600 writer retain existing ownership. Shared HTML renderer escapes tool labels once, including slash users. No agent/session creation, credential commands/refresh, transcript stdout or source replacement. JSONL is message-only, not a v2 journal/abandoned-branch backup; provider fields/known secrets are scrubbed, arbitrary unknown conversation secrets are not. Failure does not prove unchanged publication; exits 0/2/1.

## Privacy Notices and Diagnostic Risk

`packages/cli/src/security/privacy-warnings.ts` owns fixed value-free notices: validated `/share` emits before its request, supported slash `/export` before destination/publication, and `/bug` before returning its diagnostic URL. The optional synchronous host `writeWarning` sink keeps standalone exports on stderr; ordinary terminals render notices in their command output. A synchronous sink throw stops the operation, but a notice is not a confirmation, authorization or physical-delivery barrier. Quiet startup does not suppress it. Unknown conversation secrets can remain despite registered-credential redaction.

Successful RPC `export_html` retains `data.path` and adds `data.warnings: string[]`, not a raw event or pre-write confirmation. A failed/lost response still does not prove unchanged disk. The [EN](../../users/en/cli-security.md)/[FR](../../users/fr/cli-security.md) guides cover exact channels, offline-versus-firewall/provider-proxy scope, shell aliases/profiles, native Windows CMD/PowerShell/override conventions, terminal fallbacks, ACL limits and reviewed diagnostic collection. No physical Windows/terminal or hostile-descendant containment certification follows.

## Agent Settings

The CLI and RPC first call `resolvePreTrustAgentDirectory()`. `AI_HARNESS_AGENT_DIR` is used only when its canonical symlink-free location is outside the workspace; otherwise Core chooses an independent home/XDG/UID-temporary fallback or fails closed. This prevents project-controlled settings or `trust.json` from authorizing themselves. The resulting `<agent-dir>/settings.json` is merged with trusted `<cwd>/.ai-harness/settings.json`. Project settings are not opened before project trust; project `sessionDir` joins storage precedence only after trust resolves. Settings files must be hardlink-free, nonsymlink regular UTF-8 JSON objects no larger than 256 KiB by default. Unknown or invalid fields are ignored independently with bounded path-and-field diagnostics that do not print values. Legacy `queueMode`, `websockets`, skill-object, and `retry.maxDelayMs` forms migrate in memory; AiHarness does not rewrite either file.

Objects merge recursively, project scalar/array values override user values, and resource arrays are combined. A project `defaultTools` list containing only `+name`/`-name` entries modifies the user list; a list containing plain names replaces it. `cacheWarming`, `defaultProjectTrust`, `httpProxy`, and `deviceId` are agent-directory-only. `/settings` displays selected effective values and their `global`/`project` provenance without exposing proxy values or credentials.

Implemented runtime settings are startup provider/model, `enabledModels`, default/per-model thinking, default tools, session directory, compaction enable/reserve/keep values and exact model overrides, agent and provider retry timing, provider transport/proxy/deadlines, trusted API-key commands, interactive/RPC steering and follow-up queues plus their delivery modes for detached trusted Web runs, `defaultProjectTrust`, theme and TUI mode, all three `quietStartup` modes plus process-only `--verbose`, explicit navigation `branchSummary.reserveTokens`/`skipPrompt`, external editor, shell path/prefix, literal package `npmCommand`, local extensions, skills/prompts and `enableSkillCommands`. Explicit CLI options remain strongest. Session storage resolves an explicit session path, `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, settings `sessionDir`, then the AiHarness default.

Compaction `modelOverrides["provider/model"]` are re-resolved after interactive `/model` (including cycling), `/provider` and `/reload`, RPC `set_model`/`cycle_model`, and RPC `switch_session`. Models without an override restore inherited/default reserve and keep thresholds; a session's automatic-compaction opt-out is unchanged. RPC has no live file watcher: explicit `reload_context_settings` refreshes only compaction/branch-summary files. CLI/RPC gate automatic compaction on the effective context estimate strictly exceeding the selected published window minus reserve; non-mock models without published limits use a 128,000-token policy fallback. Keep thresholds select retained entries, not the window trigger. System/tool wire overhead and exact vendor tokenization/overflow recovery remain separate; unknown-limit presentation stays unknown.

Interactive `/reload` re-reads saved trust and settings, credentials, network policy, provider/model/thinking selection, package inventory, instructions, resource selectors, extensions, skill commands, default-tool additions, steering/follow-up delivery modes, shell callbacks, package command selection and the active theme. Session-only and command-line trust decisions remain process-local across reload. Session directory, terminal renderer kind, RPC queue defaults and existing persisted-session location remain startup values. Cache warming, detailed terminal/image/Markdown options, updates, telemetry and configured billing warnings are not yet applied by the CLI; fixed privacy notices are independent. Navigation summaries remain explicit rather than a startup/reload side effect.

Configured skill and prompt paths resolve relative to the declaring agent directory or project `.ai-harness` directory. Ordered plain/`+` includes and exact/glob `-`/`!` exclusions are applied around automatic user/project roots. Discovery is trust-gated, symlink-free, bounded to 10,000 files, and each Markdown source is a race-checked, hardlink-free UTF-8 regular file capped at 1 MiB. Core records metadata-only scope/source/origin/selector/trust provenance. CLI, RPC and Server skill catalogues require frontmatter with non-empty `name` and `description`; the normalized name must exactly match its directory, and `disable-model-invocation`, when present, must be `true` or `false`. Local extension includes and ordered exclusions are honored; JavaScript/TypeScript entries are revalidated as bounded nonlinked regular files before import. Core evaluates typed entry bytes through a private transpile-only graph with the host's public Core namespace, excluding declarations; no implicit tsconfig aliases or sandbox are added. Missing literal module requests have [bounded main/suffix resolution](./extensions.md#literal-module-requests), without turning automatic extension directories into adjacent files. Native JavaScript has [owned Core root aliases](./extensions.md#native-javascript-host-identity) without replacing dependency caches or foreign require adapters. See [typed extensions](./extensions.md#typescript-entry-evaluation) and [directory manifests](./extensions.md#directory-manifests) for stable, bounded, exact directory-relative entry selection before imports. Enabled package extensions, skills, prompts and themes join the same interactive/print/JSON/RPC startup and reload paths; a selected package theme can be addressed by its JSON filename stem. Core's bounded discovered-file selector also handles ordered settings include globs and exact add/remove operations before imports; declaring directories remain literal. The separate [optional built-in policy](./extensions.md#optional-built-in-capabilities) resolves `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`: global exact removal wins over addition, then the last trusted-project modifier wins, then explicit `-e builtin:name`. `--no-extensions` (`-ne`) disables automatic/settings/environment/package executable discovery and these capabilities, not explicit `-e` code, ordinary tools/resources or explicit administration. Place discovery flags before contributed options. Interactive `/reload` refreshes policy and retires disabled MCP connections; RPC requires restart. Codemode activation and tool authorization remain separate; Server/Web composition is unchanged.

### Markdown discovery suppression

`--no-skills` / `-ns` and `--no-prompt-templates` / `-np` map to Core's additive `discoverSkills: false` / `discoverPrompts: false`, not legacy all-loading denials. Automatic roots, settings selectors and package candidates are omitted for that kind, while repeatable explicit `--skill` / `--prompt-template` paths retain normal exact/glob ordering, deduplication and trust. `/reload` retains CLI policy, refreshes explicit bytes and ignores newly configured automatic candidates; RPC retains its startup snapshot. This does not suppress settings/trust diagnostics, instruction loading, tools, extensions or theme policy.

Core defaults remain true; `disableSkills` / `disablePrompts` still deny every load including explicit paths. A suppressed Core layer is not inspected at manager construction; this is not a promise about arbitrary caller getters or SDK factory spreads. Print/JSON positional slash text remains literal, with exact body admission tested independently; RPC and both terminal modes exercise actual resource expansion.

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

Interactive `/mcp` reports the current process-local persistent states; `/mcp tools` prepares and lists direct tools, and `/mcp reconnect` closes the session's records before a fresh preparation. Interactive, print/JSON and modern RPC prompts all use Core's `McpSessionHost`. It rereads config/trust before every prompt, reuses unchanged exact connections, awaits only `direct` servers, and exposes provider-safe names such as `mcp__docs__lookup`; normalized collisions receive stable hash suffixes. Session `chat-only` exposes none, while `read-only` accepts only server-declared `readOnlyHint` tools. Disabled, hidden, codemode and deferred tools are not direct declarations. Exposure accepts `direct|codemode|deferred|hidden`; `--tool <remote-name-or-pattern>` atomically writes a `toolExposure` override instead of the server default (quote patterns, for example `--tool 'read_*'`). Resolve the original remote name exact-first, then the first matching pattern in property order, then the server default (`direct` if omitted). Only `*` matches zero or more characters; matching is case-sensitive and all other characters are literal. Provider-safe namespaces are not pattern authority. Hidden tools are excluded from discovery and nested execution; wholly hidden servers do not connect for prompts unless a non-hidden override makes them eligible.

When an allowed codemode/deferred MCP or extension tool exists, Core declares the synthetic model-only `tool_search` tool without declaring candidate schemas. It ranks bounded name, description, schema and namespace text with BM25 (eight matches by default), waits for indirect MCP metadata only after a search, and makes successful deferred matches available on the next provider call—not later calls in the same response. The activation list is persisted on the search result and follows the active branch through resume and fork. Every restoration reapplies the current preset, `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, extension policy and MCP `readOnlyHint`; forged/stale names cannot bypass declarations. `codemode` exposure is searchable but remains script-only, even after activation; it never manufactures sandbox permission. Static, discovered and direct MCP calls all pass through the same Core hooks/events and persistence loop, with bounded/redacted results and cancellation. Connections close after the post-prompt idle window or process shutdown.

## QuickJS Code Mode

Core's [bounded code-mode contract](./codemode.md) is shared by CLI/JSON/RPC and Web. The helper is inactive by default: explicitly include `codemode` and permitted nested tools in `--tools` or `defaultTools`. Trusted `codemode.mode` selects `on`/`only`, and `codemode.inlineBudget` accepts 0–3000 estimated tokens. Existing replacement allowlists, exclusions, no-tools/no-builtins, extension ownership and presets still apply. Automatic activation is possible with configured code-mode settings and eligible indirect tools.

User source is an async body evaluated only inside QuickJS in a disposable resource-limited worker. It exposes eligible `tools`, `ALL_TOOLS`, bounded metadata/namespace helpers, async parallel calls, text/console/return/exit and branch-local JSON store/load. Nested tools return redacted text and pass through the common hooks; hidden/model-only controls, recursive code mode and `spawn_subagent` are unavailable. Every call, including queued calls, reapplies eligibility and MCP read-only policy. Guest scripts have no Node/files/network/timers; eligible classifier/image helpers use the host-owned current-provider bridge with bounded requests and fresh availability checks, not script-supplied credentials. Deadline, fuel, VM/stack, source/input/output, aggregate results, call/concurrency and store ceilings are documented in the Core topic. Failure/cancellation terminates the worker, aborts outstanding tools and discards new store values; already performed host effects are not rolled back.

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

`npmCommand` is a copied executable-plus-literal-prefix array (1–64 items, 4,096 UTF-8 bytes/item, 32 KiB total). Core `plugins/package-command.ts` bounds own primitive slots before iteration/allocation, never invoking numeric getters or custom iterators. Relative executable paths resolve from the declaring settings directory; malformed winning/higher layers block without PATH/global fallback, while a clean eligible project command replaces lower invalid policy.

Project-selected executable or prefix retains exact canonical source authority at every npm/Git boundary, including after locks. Explicit CLI flag/session approval supplies a captured host-only `PluginNpmSourceTrustOverride`; false wins over saved allow, true over saved refusal, without persistence. No override means fresh saved trust, not cached/default trust or target scope. Server captures operation-local eligible settings and never accepts HTTP approval. See [EN policy](../../users/en/npm-command.md) / [FR policy](../../users/fr/npm-command.md); no sandbox, executable-byte pin or OS-atomic trust/spawn is claimed.

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

The separate `tests/functional-parity/installed-executable.test.ts` rebuilds Core/CLI, creates real offline npm archives and installs literal tarball paths outside the checkout. It invokes the installed bin through PATH and checks help/version/unknown exits, trusted contributed options, unchanged print/JSON/RPC goldens, genuine public declarations, fresh CommonJS entry reload and QuickJS worker/WASM resolution. Packages remain private: local archive installation is proved, not registry publication or clean online dependency resolution. The [EN](../../contributors/en/installed-cli.md) / [FR](../../contributors/fr/installed-cli.md) guides specify the real copied-dependency/existing-cache fixture and read-only, network-none Docker command.

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

`{"type":"reload_context_settings","id":"context-1"}` passively reloads only `compaction` and `branchSummary` at idle, with fresh trust and startup-pinned source roots. Successful data is `{cancelled:false,reloaded:["compaction","branchSummary"]}`; abort/EOF/close before publication returns `{cancelled:true,reloaded:[]}`. Any settings diagnostic leaves prior policy unchanged. Provider/model, thinking budgets, executables/resources, queues and session directory remain startup/current values, not a general RPC reload. Safe reads and abort remain available during preparation; competing foreground requests are refused. `get_state.autoCompactionEnabled` combines global enablement with session opt-out.

Implemented groups include prompt/images and discovered prompt/skill expansion; immediate extension commands; steer/follow-up/queue clearing/abort and new sessions; state/messages and bounded cached configured-provider model listing, switching and cycling through the shared catalogue and ordered `--models` exact/fuzzy/glob scopes with per-entry thinking; capability-clamped thinking/queue modes; manual and threshold compaction; provider and summarization retry controls; trusted bounded bash with awaited incremental chunks, abort, private truncated `fullOutputPath` files and 24-hour cleanup; raw-history usage plus known-model context estimates; export/switch/in-place fork/clone/raw-entry/nested-tree/name/command discovery. Prompts acknowledge `started`, `queued`, `handled`, or errors before asynchronous events complete. Steering is injected after tool results before the next model turn, while follow-ups start a later agent lifecycle. Queue, thinking, session-info, retry, compaction, bash-update, and extension UI request records share the serialized stdout writer, and `abort_bash` waits for command cleanup before acknowledging. Built-in providers await stream consumers; a bounded pending queue terminates extension providers that ignore callback backpressure. Remaining functional gaps include authoritative metadata for every dynamic model, append-only schema evolution, exact branch/clone labels and summaries, complete tree accounting, every UI/extension method, exact concurrent ordering, and a complete native extension lifecycle.

The old `{id,method,params}` calls (`system.ping`, custom session/provider methods, and `chat.send`) remain accepted for migration but are not the primary contract. Normal startup session flags work in RPC; use `--session` instead of interactive-only `--resume`. `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, or settings `sessionDir` can isolate persistence, and `--no-session` keeps it in memory. Startup provider/model/API-key/thinking, instructions, settings resources, queues/retry/compaction, extensions, and tool selection are honored. Never write logs or TUI control sequences to stdout.

### RPC extension UI

`get_extension_ui` returns a detached version-1 process-local snapshot of pending requests in admission order and last plain-text presentation intents. It accepts only `type` and optional string `id`; replay neither re-admits requests nor repeats notifications. RPC context supplies optional immutable `ui` capability metadata and `setStatus`, `setWidget`, `setTitle`, `setEditorText`; custom/terminal rendering is explicitly unsupported. Request Promises expose host-owned same-ID update/individual close capabilities. Replies validate current schemas, and host cancellation emits `extension_ui_closed`; normal valid replies remain wire-compatible. Signals bypass JSON redaction and retain listener cleanup. Admission/update/state/count/timeout bounds fail without discarding previous state. Abort cancels pending requests; successful session changes retire them; EOF/signals close the bridge before joining commands, preventing an unanswered dialog from hanging shutdown. Presentation is process-wide, not session persistence or executable editor input. See the [EN contract](../../contributors/en/rpc-extension-ui.md) / [FR contract](../../contributors/fr/rpc-extension-ui.md) for exact records, bounds and limitations. Existing JSON/RPC goldens remain unchanged.

### Session accounting and management

`/session [-a|--all]` reports full ID, actual file or memory-only state, active ancestor versus full-history message/command counts, normalized token/cache counters, known/partial/unknown cost and a separate effective-context estimate. The shared Core `getSessionAccounting` includes pre-compaction work and summary-call usage, counts authenticated outer nested usage once and never reads progress/details for billing. Published price fallback requires the historical entry's own provider/model; missing measurements cannot become a free request.

RPC `get_session_stats` retains its legacy full-history response by default. Explicit boolean `includeAccounting: true` adds `accounting: {active, history, activePathComplete}` and context tokens even for unknown context windows (`contextWindow`/`percent`: null). Invalid option values fail with a correlated error. A known subtotal is not an authoritative total when any accountable entry or nested work is unpriced; legacy `cost` is then null. Existing empty-session framing/goldens remain unchanged.

`/name`/`/rename`, `/list [query]` and `/switch <id-or-number>` retain naming/search/resume. A numeric selector must be a complete positive safe integer; malformed prefixes cannot select another session. `/delete <id>` refuses the active session: use `/new` or `/switch` first. Inactive deletion still awaits Core's stable no-follow persistence before removing memory state. This does not deliver the separate full global picker or automatic branch-summary generation.

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

Reads, searches, and CLI `@path` inputs are canonicalized inside the active workspace. `@path` accepts bounded UTF-8 text and signature-validated PNG/JPEG/GIF/WebP images; traversal, escaping links, hardlinks, binary text and oversized payloads fail before the provider call. Core holds/revalidates the parent and a no-follow regular-file descriptor (parent-fd anchored on Linux), rejecting observable file/directory replacement or in-place changes before returning bytes. Canonical safe in-root aliases remain valid, existing MIME/size/count/aggregate limits are unchanged, and abort at empty-file EOF still closes handles with a fixed error. `bash`, direct `!`/`!!`, `edit`, and `write` additionally require resolved project trust; command output, file reads, directory listings, and search results are bounded. All shared shell paths receive a filtered environment that removes credential-like variable names and terminate process trees with escalation; RPC streams raw output chunks without putting diagnostics on stdout.

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
- Core discovers shallow automatic `themes/` roots, ordered global/trusted-project `themes` selectors and eligible package files, then literal repeatable `--theme-source <path>` requests. Later sources win filename collisions; settings support globs, exact `+`/`-` and `!` exclusion. Strict `--no-themes` skips automatic/settings/package admission while retaining built-ins and explicit source/direct-file selection, never bypassing trust. Selection follows CLI → `AI_HARNESS_THEME` → trusted settings → `auto`. Reload refreshes candidates; inventory marks the exact active file and reports a directly loaded palette without giving it discovery authority. See [terminal theme contracts and bounds](./themes.md).
- Theme/keybinding files are user configuration; malformed input must fail or fall back safely without reflecting file bodies.

## Associated Tests

- `packages/cli/src/utils/{keybinding-config,keybinding-manager,keybinding-source,terminal-actions,keypress-gate,hotkey-view,keybinding-schema}.test.ts` — strict owned layers/races, passive metadata, native consumption/pass-through, complete action defaults, full-value redaction before clipping and schema asset parity
- `packages/cli/src/cli/{keybindings-process,keybindings-escape-process,keybindings-scroll-process}.test.ts` — actual emitted regular/fullscreen actions, all-action view/filter/reload/trust/headless purity, draft/caret/history/editor lifetimes, disposable-secret suppression, original split-Escape timing and real persisted history pages
- `packages/cli/src/tui/{terminal-escape,terminal-scroll}.test.ts` — passive split-Enter projection, actual page contents/direction/bounds/arrival anchors, current redaction, controls/width and unchanged live streams; the genuine installed parity leaf adds both packed PATH-bin hosts and schema/reload/modal proof, using disclosed offline dependency seeds

- `packages/cli/src/security/privacy-warnings.test.ts`, `packages/cli/src/cli/export-command.test.ts`, `packages/cli/src/rpc/rpc-controller.test.ts` and the genuine packed installed leaf — fixed bounded notices, warning-before-share/write ordering, synchronous sink failures, four-format stderr hygiene, preserved unknown text/redaction, additive correlated RPC warnings without extra records and installed PATH-bin exports

- `packages/cli/src/cli/startup-credential-arity-process.test.ts`, `extension-args.test.ts` and the installed parity leaf — actual contributed boolean/string arity, exact provider-bound prompt bytes/encoded variants, genuine CLI/env masking, early-error secrecy, RPC framing and four genuine PTY reloads

- `packages/core/src/resources/resource-discovery-policy.test.ts`, `packages/cli/src/cli/resource-discovery-process.test.ts` — independent discovery/all-loading policies, suppressed option fields, exact/zero real body opens, all headless adapters, four genuine PTYs/reloads/fresh invocation and installed Core/SDK/PATH-bin declarations/body admission
- `packages/core/src/providers/offline-policy.test.ts`, `packages/cli/src/cli/offline-mode{,-process}.test.ts` — explicit passive Core policies, flag/environment admission, actual loopback discovery/OAuth/command controls, immutable reload, definitive option arity, six genuine PTYs and conserved explicit network/tools; installed declarations/bin coverage remains in the public parity leaf

- `packages/cli/src/cli/length-stop-process.test.ts`, `json-output.test.ts` and the installed PATH-bin leaf — real loopback-provider partial/empty output limits, normal controls, multi-prompt nonzero status, stderr isolation, unchanged JSONL lifecycles, RPC continuation/history and persisted usage
- `packages/cli/src/cli/{args,json-output,invocation,shell-controller,package-command}.test.ts` — strict options and package parsing, JSON events, package/resource process integration, modes, process exits/stdout purity, real pseudo-terminal steering/follow-up ordering and direct shell trust/stream/abort/persistence
- `packages/core/src/mcp/tool-exposure-{patterns,runtime}.test.ts`, `packages/cli/src/cli/mcp-pattern-process.test.ts` and the genuine installed parity leaf — exact-first/ordered star matching, real stdio metadata/effects, canonical global/project writes, public Core hosting and print/JSON/RPC declarations; SDK sessions still do not automatically host MCP
- `packages/cli/src/cli/{mcp-command,mcp-oauth-command}.test.ts` — strict management/exposure parsing and a real loopback PKCE login, encrypted persistence/logout, invalid storage/timeout, cancellation/expiry and listener closure
- `packages/cli/src/cli/{provider-auth-command,export-command}.test.ts` — actual built/installed PATH-bin HTTPS device/body/poll/cancellation/encrypted publication, unchanged user codes/monotonic timeout, selected no-follow trusted exports, real bytes/modes/redaction and failed publication
- `packages/cli/src/security/oauth-device.test.ts`, `packages/cli/src/utils/session-export.test.ts` — shared caller pre-abort/body cancellation and escaped tool labels without double escaping
- `packages/core/src/tools/codemode.test.ts` — sandbox budgets, isolation, live nested authorization and transactional branch store
- `packages/core/src/plugins/plugin-service.test.ts` — npm/Git/local source policy, filters, fresh source trust through locks/Git, scopes, symlink rejection, atomic state and concurrent mutation
- `packages/core/src/plugins/{package-command,npm-source-override,npm-argv-admission}.test.ts` — real shell-free literal processes, bounded own-slot admission, immutable exact-source explicit choices, revocation and denied-operation cleanup
- `packages/core/src/providers/{model-catalog,credentials,provider-network,provider-websocket.integration}.test.ts` and `packages/cli/src/cli/model-list.test.ts` — shared assembly/discovery, credential/network bounds, real local WebSocket/proxy behavior, full-ID-first resolution, scopes, fuzzy listing and protocol metadata
- `packages/cli/src/providers/configured-providers.test.ts` — common environment, startup scopes and non-persistent key overrides
- `packages/cli/src/sessions/startup-session.test.ts` — startup selectors, exact IDs, naming, forking, cwd filtering and directory precedence
- `packages/cli/src/commands/handler.test.ts` — built-in commands, sessions, providers and import/export
- `packages/cli/src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.test.ts` — legacy migration requests, command envelopes/events/queues/state, compaction and extension dialogs
- `packages/cli/src/rpc/rpc-extension-ui-{state,process,public}.test.ts` — bounded replay/presentation/delivery, schema updates, malformed replies, real redacted signal ownership, actual emitted RPC executable response/abort/session-change/EOF and genuine exported declarations
- `packages/core/src/config/agent-settings.test.ts` and `packages/core/src/security/project-trust.test.ts` — safe schema loading, migration, trusted merge/global-only policy, provenance, resource-sensitive exact/inherited/refused trust, cross-process refresh and path resolution
- `packages/core/src/prompts/{prompt-input,prompt-input-stability,instruction-context}.test.ts` and `packages/core/src/tools/{tool-selection,shell-command-runtime,workspace-tools}.test.ts` — shared file/instruction ingestion, trust/precedence/bounds, tool policy and CLI/Web shell lifecycle
- `packages/cli/src/resources/resource-manager.test.ts` and `packages/cli/src/security/project-trust.test.ts` — AiHarness roots, CLI trust adapter, ordered resource selectors, precedence and bounded Markdown loading
- `packages/cli/src/agent/{tool-loop,provider-turn}.test.ts` — CLI re-exports and bounded pre-delta retry
- `packages/cli/src/extensions/extension-loader.test.ts` — explicit extension paths and reload
- `packages/core/src/themes/theme-sources.test.ts`, `packages/cli/src/cli/theme-sources{,-process}.test.ts` — passive bounded selection, readonly public input, automatic/settings/package/explicit precedence, trust, real PTY reload and headless conservation
- `packages/cli/src/tui/mode.test.ts` — flag/environment/capability precedence
- `packages/core/src/agent/{message-queue,runtime}.test.ts` — common queue modes/bounds plus detached Web scheduling
- `packages/cli/src/tui/{terminal-ui,fullscreen-ui,fullscreen-input,theme-manager,theme-input-filter}.test.ts` — rendering, concurrent input, queue shortcuts/editor restoration, adaptive themes and OSC/CSI-to-keypress filtering
- `tests/functional-parity/functional-parity.test.ts` — positive/negative CLI and automation goldens, stdout purity, session migration, extension API versioning and built-package SDK probes
- `tests/functional-parity/installed-executable.test.ts` — genuine local pack/install outside checkout, PATH bin, read-only/no-network proof, installed public declarations/extensions/QuickJS assets and unchanged protocol goldens

## Common Changes

### Add a slash command

Register and test it in `commands/handler.ts`, verify dispatch/completion in `index.ts`, update regular and fullscreen help, then update both language versions of the user guide.

### Change terminal input or rendering

Update both interactive paths where behavior is shared. Test narrow dimensions, ANSI/Unicode width, history/completion, cancellation, external editor transitions, and terminal restoration. For keyboard changes, keep callbacks in the host, update `utils/terminal-actions.ts` and the packaged schema together, preserve reserved native ownership and test real PTY consumption, passive browsing, full-value redaction, reload and packed PATH consumers.

### Change RPC

Keep stdout strictly JSONL, validate untrusted IDs/params, update RPC tests, affected functional-parity transcripts and automation documentation, and preserve cancellation/persistence semantics. A deliberate golden change follows the bilingual public contract policy and requires migration/version handling when breaking.

## Related Domains

- [`codemode.md`](./codemode.md) — shared sandbox, ceilings and branch store
- [`themes.md`](./themes.md) — bounded theme discovery, adaptive system palette and complete shipped schema
- [`providers.md`](./providers.md) — provider initialization and streaming
- [`sessions.md`](./sessions.md) — JSONL persistence, branches and compaction
- [`extensions.md`](./extensions.md) — commands, hooks, tools and trusted loading
- [`security.md`](./security.md) — project trust and credential handling
