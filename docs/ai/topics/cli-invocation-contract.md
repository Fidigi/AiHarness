# CLI Invocation Contract

> **Navigation:** See [`project-map.md`](../project-map.md) for ownership and Docker validation, and [CLI reference](./cli-reference.md) for detailed behavior.

## Overview

Native contract version 1 describes AiHarness command syntax, options, channels and cancellation. JSON event header v3, RPC envelopes, Core/extension API 1 and JSONL session v2 are separate versioned contracts. Native goldens are authoritative; executable probes do not import a reference implementation. Linux Docker evidence does not certify other operating systems or physical terminals.

## Main Entry Points

| Repository-root path | Ownership |
|---|---|
| `packages/cli/src/cli/args.ts` | Strict two-phase argv parsing, modes, metadata help and bounded piped input |
| `packages/cli/src/index.ts` | Standalone dispatch, ordered inputs, startup and owned one-shot signal/cleanup lifetime |
| `packages/cli/src/cli/json-output.ts` | Serialized/backpressured JSONL and aborted-message/settled records |
| `packages/cli/src/rpc/{rpc-server,rpc-controller}.ts` | Native command correlation, concurrent events, abort and EOF drain |
| `packages/cli/src/sessions/startup-session.ts` | Session selection, naming, copies and storage precedence |
| `packages/cli/src/cli/{package-command,mcp-command,provider-auth-command,export-command}.ts` | Before-agent standalone parsers, help, scopes and channel/exit policy |

## Public Contracts: Invocation and Inputs

Use `ai-harness [options] [--] [@files...] [messages...]`. Options end at the first positional message or `--`; later dash-prefixed prompt tokens are data. `@path` remains a file reference even after `--`.

| Input or mode | Contract |
|---|---|
| Interactive default | Both stdin and stdout must be TTYs; regular/fullscreen selection follows capabilities and settings |
| `-p`, `--print` | Execute supplied prompts sequentially; stdout contains only the last final assistant text plus LF |
| `--mode text` | Does not force one-shot execution on a TTY; either redirected stream selects print |
| `--mode json` | One-shot JSONL session header and lifecycle for every supplied prompt, followed by cleanup/exit |
| `--mode rpc`, `--rpc` | Persistent JSONL requests/responses/events; no startup positional messages, `@files`, `--print` or interactive `--resume` |
| Piped stdin | Print/JSON read at most 2 MiB, trim outer whitespace and prepend it to the first prompt; RPC stdin is protocol |
| `@path` | Workspace-confined bounded UTF-8/image loading; file labels and payloads accompany the first prompt |
| `-h`, `--help`; `-v`, `--version` | Metadata-only built-in exits; invalid syntax still rejects |
| `--help-extensions`, `--completion <prefix>` | Explicitly admit eligible trusted extension code; completion consumes bounded contributed metadata |

The first prompt concatenates trimmed stdin, Core's file text/labels and the first positional message without an invented separator. Later messages execute separately in order. Print/JSON positional slash text is literal, not a command. Empty one-shot input exits 2. Unsafe/oversized file or stdin input fails before provider execution; syntax-invalid RPC file input fails before extension execution or session admission.

### Model and Session Options

| Option | Contract |
|---|---|
| `--provider <name>` | Requires `--model` or `--models` |
| `--model <pattern>` | Full-ID-first/exact/fuzzy `provider/model[:thinking]`; ambiguity requires qualification or a sole available credential |
| `--models <patterns>` | Ordered exact/fuzzy/glob scope, per-entry thinking pins and fixed stderr-only unresolved-entry diagnostics |
| `--api-key <key>` | Process-only override requiring model/scope; never persisted or printed |
| `--thinking <level>` | `off` through `max`, subject to native capability clamping |
| `--list-models [search]` | Configured-provider metadata and bounded optional discovery, not account entitlement |
| `-c`, `--continue` | Newest session in the current workspace |
| `-r`, `--resume` | Interactive selector; rejected in RPC |
| `--session <path-or-id>` | Native file/exact/unambiguous-prefix lookup, without foreign file conversion |
| `--session-id <id>` | Exact ID open/create; bounded identifier grammar; conflicts with continue/resume/session |
| `--fork <path-or-id>` | Related startup copy; incompatible with session/continue/resume/no-session; optional new exact ID |
| `--session-dir <dir>` | Lookup/storage override; an explicitly selected file keeps its parent directory |
| `--no-session` | Process-local memory journal; incompatible with persisted source selectors/fork |
| `-n`, `--name <name>` | Nonempty startup display name |

Provider/authentication contracts belong to [providers](./providers.md); journal/context semantics belong to [sessions](./sessions.md). A selector does not establish transport support or account access.

### Tools, Resources and Process Options

| Option | Contract |
|---|---|
| `-t`, `--tools <list>` | Names/`*` replacement or ordered `+name,-name` adjustment; current declarations and allowlists still restrict hosted tools |
| `-xt`, `--exclude-tools <list>` | Names/`*` exclusions win after selection, including hosted tools |
| `-nbt`, `--no-builtin-tools`; `-nt`, `--no-tools` | Defaults/explicit adjustments, presets, exposure and trust remain authoritative |
| `-e`, `--extension <path>` | Repeatable path or native `builtin:name`; native extension API only |
| `-ne`, `--no-extensions` | Suppress automatic/configured/package discovery and optional built-ins; explicit `-e` remains trust-gated |
| `--no-mcp` | Hosted-capability denial wins over explicit `-e builtin:mcp`; standalone administration remains available |
| `--skill`, `--prompt-template` | Repeatable paths/selectors with native roots, argument expansion and trust |
| `-ns`, `--no-skills`; `-np`, `--no-prompt-templates` | Suppress discovery, retaining explicit paths and safety checks |
| `--theme-source <path>`, `--theme <name-or-file>` | Repeatable loading sources versus selected palette |
| `--no-themes` | Suppress discovery; explicit sources/direct selection remain eligible |
| `-nc`, `--no-context-files` | Suppress context-file discovery, not independently controlled system prompts |
| `--system-prompt <text-or-path>` | Bounded/trusted resolution and precedence |
| `--append-system-prompt <text-or-path>` | Repeatable ordered append inputs |
| `--tui-mode <fullscreen-or-regular>` | Mode selection; legacy `--fullscreen`, `--regular`, `--no-fullscreen` remain accepted |
| `--verbose` | Full startup override, never a headless banner; `-v` means version |
| `-a`, `--approve`; `-na`, `--no-approve` | Opposing process-only trust decisions; combination rejects; saved trust still required for MCP project bodies |
| `--offline`, `AI_HARNESS_OFFLINE=1\|true\|yes` | Suppress automatic discovery, credential commands and OAuth refresh; not an explicit-action ban or network firewall |
| `AI_HARNESS_AGENT_DIR`, `AI_HARNESS_SESSIONS_DIR` | Native independent agent/session directories and `.ai-harness` settings, without foreign-directory import/write |

### Standalone Commands

- `package install/check/update/remove/list/configure/enable/disable` owns package administration, literal source policy, scopes and sanitized inventory. Native `install`, `remove`, `uninstall`, `list`, `config` and package `update` aliases retain their parser contracts. Package updates are not application self-updates; no lifecycle scripts run.
- `auth list [--json]` reports stored/operator presence metadata without commands or refresh. `auth login <provider>` uses an independent storage label and an explicit `--issuer` when selecting native OAuth. Absent a selector, operator-configured device flow remains available. `auth logout <provider>` removes only local stored credentials. No bulk secret-printing/export aliases exist.
- `mcp list [--json]` is passive file/trust inventory, never a connection. `mcp test <name>` explicitly requests one bounded OAuth-free diagnostic; interactive `/mcp tools` inspects hosted tools. `mcp add/remove` uses strict native schemas/scopes; `mcp login/logout <name>` owns explicit encrypted loopback/paste and local logout. No implicit sign-in occurs on inventory or ordinary prompts.
- `export --session <path-or-prefix> --format html --output <path.html>` requires explicit output and native trust/format checks. JSON/Markdown/JSONL formats retain their owning help contracts.
- Every standalone command exposes its own `--help`. No automatic application/catalogue update or arbitrary extension execution is implied.

Standalone auth accepts separate/equal login-only `--issuer` forms and rejects duplicate/unknown selectors. Kimi host precedence is `KIMI_CODE_OAUTH_HOST`, `KIMI_OAUTH_HOST`, then the explicit helper default, never a storage-label/model/token inference. Login's monotonic 1–300 second timer starts after credential-service loading, issuer selection and client construction; it links transport/body cancellation and device expiry. See [credential publication/export boundaries](./native-security-contract.md#credential-lifecycle-and-export-scope): a later failure/cancellation does not universally prove no publication occurred.

## Output, Exit and Cancellation Invariants

| Boundary | Contract |
|---|---|
| Print stdout | Last final assistant text + LF on success; no protocol/logs/startup chrome or final success text after active interruption |
| JSON stdout | LF JSON objects, header v3 and lifecycle; `message_end` is authoritative, `agent_settled` ends the owned run |
| RPC stdout | Correlated `{type:"response",command,success,data-or-error}` plus interleaved lifecycle; legacy `method/params` remains migration input |
| Stderr | Diagnostics, fixed warnings and redirected extension noise; registered credentials stay redacted across channels and journals |
| Conversation exits | 0 success; 2 invalid argv/missing prompt/selection; 1 execution/input/output-limit failure; one failed RPC request need not terminate the process |
| Active print/JSON/RPC signals | First SIGINT/SIGTERM pins 130/143, aborts active work, prevents later initial prompts and emits `Error: Request interrupted.` + LF on stderr; join cleanup/JSON flush without forced exit across admitted writes |
| JSON interruption | Aborted assistant/end/settled records remain JSONL; partial text is not successful final output or fabricated usage |
| RPC signal / EOF | Signal shutdown cancels and joins work, suppressing only its intentional premature stdin close; clean EOF drains accepted work and normally exits 0 |

Written output cannot be retracted. Signal ownership begins after startup admission, before header/prompts, and lasts through cleanup. [Run lifetimes](./run-lifecycle.md) distinguish earlier native OS termination, logical callback retirement, admitted writes and physical containment. A cancelled provider turn retains the admitted user message without inventing a successful assistant entry. An `abort` acknowledgement is not a durable-settlement barrier.

## Critical Flow

Strict argv → standalone exit or stream/mode selection → trust/resources/session → file/stdin/ordered prompts → shared hooks/provider/tool loop → final text or JSON/RPC events → awaited cleanup. Headless handlers pin the first signal and remain installed through owned cleanup. They do not change Core budgets, global Node flags or interactive key handling.

## Associated Tests

- `packages/cli/src/cli/{args,invocation}.test.ts`: strict options/conflicts, TTY modes, help, ordered inputs, real regular/fullscreen PTYs and channel purity.
- `packages/cli/src/cli/{headless-signal-process,interactive-settlement-process}.test.ts`: emitted print/JSON/RPC held SSE/hooks, repeated signals, cleanup/settlement, durable readback and terminal shutdown joining admitted writes.
- `tests/functional-parity/{functional-parity,installed-executable}.test.ts`: native goldens and the same probes through genuine outside-checkout pack/install/PATH-bin, including RPC rejection before noisy extensions.
- `tests/functional-parity/installed-process{,.test}.ts`: exact compiler-process flags, immutable arguments and native termination receipts, without failed-invocation retries.
- `packages/cli/src/sessions/startup-session.test.ts` and `cli/{model-list,tool-selection,package-command,mcp-command,mcp-oauth-command,provider-auth-command,export-command}.test.ts`: selectors, standalone grammar, trust, encrypted storage, channels and cancellation.
- `packages/cli/src/cli/{model-resolution-process,no-mcp-process,resource-discovery-process,offline-mode-process,length-stop-process}.test.ts` and installed consumers: actual selection/denial/resource/offline/output-limit boundaries. [CLI reference](./cli-reference.md#associated-tests) expands coverage.

Use the repository's Docker workflow for types and relevant tests. Test presence alone does not certify accounts, operating systems or production deployments.

## Common Changes

- Change argv/channel policy in `args.ts` and `index.ts`, this map, installed help and only intentionally affected goldens. Preserve strict parsing and redaction.
- Change cancellation through the composition-root lifetime and existing emitted/installed probes. Preserve transport/tool budgets, native payloads and settlement after cleanup.

## Related Domains

- [CLI reference](./cli-reference.md)
- [Security](./security.md)
- [Sessions](./sessions.md)
