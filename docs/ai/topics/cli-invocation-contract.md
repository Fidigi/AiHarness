# CLI Invocation Contract and Pi Mapping

> **Navigation:** See [`project-map.md`](../project-map.md) for ownership and Docker validation, and [CLI reference](./cli-reference.md) for detailed native behavior.

## Overview

**Native contract version 1, reviewed 2026-10-19; CLI package 0.1.0.** This is the bounded `CLI-01` command/option/channel map for the user-approved independent product, not a Pi argv, wire, credential or session compatibility adapter. Reference: [Pi 1.2.0 CLI](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/docs/cli.md), including that commit's `src/cli/args.ts`. Pi Web service management is separate (`CLI-04` in [AUDIT-5](../../audit/pi/AUDIT-5.md)).

Process qualification is Linux x64 under the pinned Docker runtime; macOS/Windows signal qualification remains `QUA-03`.

Version 1 records native syntax/output and the active headless signal behavior added for CLI-01. It does not change JSON event header v3, RPC envelopes, Core/extension API 1 or JSONL session v2. The native goldens remain authoritative; no reference library is imported by executable probes. Revisit this map explicitly for upstream or native contract changes.

## Main Entry Points

| Repository-root path | Ownership |
|---|---|
| `packages/cli/src/cli/args.ts` | Strict two-phase argv parsing, modes, metadata help and bounded piped input |
| `packages/cli/src/index.ts` | Standalone dispatch, ordered inputs, startup and owned one-shot signal/cleanup lifetime |
| `packages/cli/src/cli/json-output.ts` | Serialized/backpressured JSONL and existing aborted-message/settled records |
| `packages/cli/src/rpc/{rpc-server,rpc-controller}.ts` | Native command correlation, concurrent events, abort and EOF drain |
| `packages/cli/src/sessions/startup-session.ts` | Native session selection, naming, copies and storage precedence |
| `packages/cli/src/cli/{package-command,mcp-command,provider-auth-command,export-command}.ts` | Before-agent standalone parsers, help, scopes and channel/exit policy |

## Public Contracts: Invocation and Inputs

| Pi 1.2.0 surface | AiHarness v1 mapping / retained difference |
|---|---|
| `pi [options] [--] [@files...] [messages...]` | `ai-harness` with the same high-level input kinds; native options end at the first positional message or `--`. Later dash-prefixed prompt tokens are data. `@path` remains a file reference even after `--`. |
| Interactive terminal default | Both stdin and stdout must be TTYs; regular/fullscreen selection follows capability and native settings. Physical terminal equivalence is `CLI-02`, not certified here. |
| `-p`, `--print` | Run supplied prompts sequentially; stdout is only the **last** final assistant text plus LF, not an incremental transcript. |
| `--mode text` | Does not force one-shot execution on a TTY. Either redirected stream selects print. |
| `--mode json` | One-shot native JSONL session header and lifecycle for every supplied prompt, then cleanup/exit. Not Pi wire equality. |
| `--mode rpc` | Persistent native JSONL requests/responses/events; no startup positional messages, `@files`, `--print` or interactive `--resume`. Native `--rpc` is an alias. |
| Piped stdin | Print/JSON read up to 2 MiB, trim outer whitespace, and prepend it to the first prompt. RPC stdin is protocol, never prompt text. |
| `@path` | Core workspace-confined bounded UTF-8/image loading; text/image file labels and payloads accompany the first prompt, then later positional messages remain separate prompts. |
| `--export <input> [output]` | No flag alias: use native `export --session <path-or-prefix> --format html --output <path.html>`. Explicit output, native trust and format checks remain mandatory. |
| `-h`, `--help`; `-v`, `--version` | Metadata-only built-in exits. Unlike contributed Pi help, native `--help-extensions` explicitly admits eligible trusted extension code; `--completion <prefix>` uses its bounded metadata. Invalid syntax is still rejected. |

The first prompt is the concatenation of trimmed stdin, Core's file text/labels and the first positional message, with no invented separator; later messages execute in order. Print/JSON positional slash text stays literal, not a command. Empty one-shot input exits 2. Unsafe/oversized file or stdin input fails before provider execution; syntax-invalid RPC file input fails before extension execution or session admission.

### Model and Session Options

| Pi option(s) | AiHarness v1 mapping / retained difference |
|---|---|
| `--provider <name>` | Same spelling; native requires `--model` **or** `--models`, not only `--model`. |
| `--model <pattern>` | Same spelling; full-ID-first/exact/fuzzy `provider/model[:thinking]` selection. Provider ambiguity requires qualification or a sole available credential. |
| `--models <patterns>` | Same spelling; ordered exact/fuzzy/glob scopes, per-entry thinking pins and fixed stderr-only unresolved-entry diagnostics. |
| `--api-key <key>` | Same spelling; process-only override requiring model/scope, never persisted or printed. |
| `--thinking <level>` | Same seven names (`off` through `max`); native capability clamping remains authoritative. |
| `--list-models [search]` | Same spelling; configured-provider native metadata and bounded optional discovery, not proof of Pi's complete catalogue. |
| `-c`, `--continue` | Newest session for the current native workspace. |
| `-r`, `--resume` | Native interactive selector; rejected in RPC. |
| `--session <path-or-id>` | Native file/exact/unambiguous-prefix lookup; no Pi file conversion or cross-project Pi picker guarantee. |
| `--session-id <id>` | Native exact ID open/create, bounded identifier grammar; conflicts with continue/resume/session. |
| `--fork <path-or-id>` | Native related startup copy; incompatible with session/continue/resume/no-session, optional new exact ID. |
| `--session-dir <dir>` | Native lookup/storage override; an explicit selected file keeps its parent directory. |
| `--no-session` | Native process-local memory journal; cannot combine with persisted source selectors/fork. |
| `-n`, `--name <name>` | Nonempty native startup display name. |

Provider availability/auth/transport completeness remains `MOD-01–03`; session/context semantics remain `SES-*`. Mapping their CLI selectors does not close those families.

### Tools, Resources and Process Options

| Pi option(s) | AiHarness v1 mapping / retained difference |
|---|---|
| `-t`, `--tools <list>` | Native names/`*` replacement or exact ordered `+name,-name` adjustment. **No Pi MCP exception:** native current declarations/allowlists still restrict hosted tools. |
| `-xt`, `--exclude-tools <list>` | Native names/`*` exclusions win after selection, including hosted tools. |
| `-nbt`, `--no-builtin-tools`; `-nt`, `--no-tools` | Same switches; native defaults/explicit adjustments, presets, exposure and trust remain authoritative. |
| `-e`, `--extension <path>` | Same repeatable switch and native `builtin:name`; native API only, not an unchanged Pi extension ABI. |
| `-ne`, `--no-extensions` | Disable automatic/configured/package discovery and optional built-ins; explicit `-e` remains eligible behind trust. |
| `--no-mcp` | Native hosted-capability denial wins even over explicit `-e builtin:mcp`; standalone MCP administration remains explicit and available. |
| `--skill`; `--prompt-template` | Same repeatable path/selectors; native roots, argument expansion and trust, not Pi resource-file compatibility. |
| `-ns`, `--no-skills`; `-np`, `--no-prompt-templates` | Disable discovery, retaining explicit paths and all safety checks. |
| `--theme <path>` | For loading sources use native repeatable `--theme-source <path>`; native `--theme <name-or-file>` selects a palette. |
| `--use-theme <name>` | Native `--theme <name-or-file>`; no foreign option alias. |
| `--no-themes` | Disable native discovery; explicit sources/direct selection remain eligible, not universally disabled. |
| `-nc`, `--no-context-files` | Disable native context-file discovery, not separately controlled system prompts. |
| `--system-prompt <text-or-path>` | Same switch, native bounded/trusted resolution and precedence. |
| `--append-system-prompt <text-or-path>` | Same repeatable switch; ordered native append inputs. |
| `--tui-mode <fullscreen-or-regular>` | Same names; native legacy `--fullscreen`, `--regular`, `--no-fullscreen` remain accepted. |
| `--verbose` | Native full startup override, never a headless banner; `-v` is version. |
| `-a`, `--approve`; `-na`, `--no-approve` | Opposing one-process native trust decisions, never persisted; combining them is invalid. Saved trust is still required for MCP project bodies. |
| `--offline` / `PI_OFFLINE` | Native flag / `AI_HARNESS_OFFLINE=1\|true\|yes`; suppress automatic discovery, credential commands and OAuth refresh, not explicit actions or a network firewall. |
| Pi agent/session directories | Native `AI_HARNESS_AGENT_DIR`, `AI_HARNESS_SESSIONS_DIR` and `.ai-harness` settings; no Pi-directory import/write. |

### Standalone Commands

| Pi surface | Native equivalent / explicit boundary |
|---|---|
| `install`, `remove`, `uninstall`, `list` | Native same-name package aliases and explicit `package` actions; literal source policy, sanitized inventory and no lifecycle scripts. |
| `config` | Native alias of data-only `package configure`, not Pi's package-selector TUI. |
| Package `--local`, `-l` | Translate to native `--project` or `--scope project`; default native scope is global. |
| `update <source>` / `update --extensions` | Native `package update [selector]` / package `update` alias; never a self-update. |
| `update`, `--self`, `self`, `pi`, `--all`, `--force`, `--models`, `--extension` update forms | No automatic translation to application/catalogue updates. Application lifecycle delivery remains `CLI-04`; catalogue policy remains `MOD-01/02`. Do not claim these open features were waived. |
| `auth check --provider-or-model` | Native `auth list [--json]` reports **presence metadata**, not Pi resolved readiness, command execution or refresh. |
| `auth print-api-key`, `print-bearer-token`, `--credentials`, `--min-expiry`, `--no-refresh` | No secret-printing aliases. Native encrypted `auth login <provider> [--issuer kimi-coding] [--timeout <1..300>]` selects an explicit public-client issuer independently of the storage label; absent `--issuer`, retain operator-configured device flow. `auth logout <provider>` deletes local stored credentials only; provider/OAuth breadth remains `MOD-01`. |
| `mcp add/remove` | Native `mcp add/remove` with its own strict schema/scopes; do not forward unsupported Pi auth flags as if interchangeable. |
| `mcp list [--json]` | Native passive file/trust inventory, **never connect**. Use explicit `mcp test <name>` for one bounded OAuth-free diagnostic, interactive `/mcp tools` for hosted inspection. |
| `mcp login/logout <name>` | Native explicit encrypted loopback/paste flow and local logout; CLI help owns exact timeout/scope flags. No implicit sign-in on inventory or ordinary prompts. |

Native-only package check/enable/disable/reload, MCP exposure/status/test and standalone JSON/Markdown/JSONL export retain their owning help and safety contracts. `--help` is available on each standalone command. This mapping does not add automatic updates, credential export, arbitrary extension execution or any scope waiver.

Standalone auth accepts separate/equal `--issuer` forms only for login and refuses duplicate/unknown selectors. Kimi host precedence is `KIMI_CODE_OAUTH_HOST`, then `KIMI_OAUTH_HOST`, then the explicit helper default; no label/model/token inference or provider activation is added. Login's monotonic 1–300 second timer starts **after credential-service loading, issuer configuration selection and client construction**, not at process startup; it links cancellation through transport/body reads and remaining device expiry. Issuer configuration is not persisted for later refresh. Keep [credential publication/export boundaries](./native-security-contract.md#credential-lifecycle-and-export-scope): a later failure/cancellation is not a universal no-publication guarantee.

## Output, Exit and Cancellation Invariants

| Boundary | Native contract |
|---|---|
| Print stdout | Last final assistant text + LF on success; no protocol/logs/startup chrome. No final success text after an active interruption. |
| JSON stdout | Strict LF JSON objects, header v3 then existing lifecycle; `message_end` is authoritative, `agent_settled` ends the owned run. |
| RPC stdout | Native correlated `{type:"response",command,success,data-or-error}` plus interleaved lifecycle; legacy `method/params` remains migration input. |
| Stderr | Diagnostics, fixed warnings and redirected extension noise; registered credentials remain redacted in both channels and journals. |
| Conversation exits | 0 success; 2 invalid argv/missing prompt/selection; 1 execution/input/output-limit failure. An error response to one RPC request need not terminate the process. |
| Active print/JSON/RPC `SIGINT` / `SIGTERM` | First signal pins exit 130 / 143, aborts the active operation, prevents later initial prompts and emits fixed stderr `Error: Request interrupted.` + LF. Await owned cleanup/JSON flush; no forced exit across admitted writes. Active owners join cleanup; underlying transport/tool budgets remain unchanged. |
| JSON interruption | Existing aborted assistant/end/settled records remain JSONL; delivered partial text is not a successful final response or fabricated billed usage. |
| RPC signal / EOF | Signal shutdown cancels the controller and closes stdin, settles events/cleanup and returns 130/143 without misreporting its intentional input close as fatal. EOF drains accepted work and normally exits 0. For controlled in-band cancellation use `abort` / `abort_bash`, not a successful prompt acknowledgement as settlement. |

Already-written output cannot be retracted; lifecycle records describe only started runs, not an invented assistant for cancellation before prompt admission. Signal ownership for one-shot execution begins after startup admission, before header/prompts, and lasts through cleanup. The [native RUN-01 lifetime](./run-lifecycle.md) separates earlier native OS termination before an active invocation, logical retirement of privileged callbacks, admitted writes and physical containment limits; no universal rollback/forced-termination guarantee is added. A cancelled provider turn retains the admitted user message but does not invent a successful assistant journal entry. See [session ownership](./sessions.md).

## Critical Flow

Strict argv → explicit standalone exit **or** stream/mode selection → trust/resources/native session → file/stdin/ordered prompt input → shared hooks/provider/tool loop → native final text or JSON/RPC events → awaited owned cleanup. Headless signal handlers borrow their active controller, pin the first signal and remain installed through owned cleanup; RPC suppresses only its signal-induced `ERR_STREAM_PREMATURE_CLOSE`, never unrelated input/output failures. They do not change Core budgets, global Node flags or interactive key handling.

## Associated Tests

- `packages/cli/src/cli/{args,invocation}.test.ts`: option/value/conflict inventory, stdin/stdout TTY selection, metadata-only help, sequential input, real regular/fullscreen PTYs and channel purity.
- `packages/cli/src/cli/headless-signal-process.test.ts` and `fixtures/headless-signal-probe.mjs`: twelve emitted print/JSON/RPC signal journeys (held SSE and unpublished hook) against a real held loopback SSE provider; status/signal, physical transport close, complete JSONL/settlement, opposite repeated signal during held async extension shutdown, journal readback and no second prompt.
- `packages/cli/src/cli/interactive-settlement-process.test.ts`: real regular/fullscreen PTYs hold an admitted append through SIGTERM, then require shutdown observers and fresh native readback to see it before natural process exit.
- `tests/functional-parity/{functional-parity,installed-executable}.test.ts`: reviewed source-process native goldens and the same twelve signal probes and two held-append regular/fullscreen shutdown probes through genuine outside-checkout pack/install/PATH-bin; RPC file rejection precedes noisy extension admission in source-process and installed executions. Existing goldens are unchanged.
- `tests/functional-parity/installed-process{,.test}.ts`: only the exact resolved TypeScript process receives explicit `--no-maglev`; compiler arguments stay immutable, application argv and native termination receipts stay unchanged, and no failed invocation is retried.
- `packages/cli/src/{sessions/startup-session,cli/{model-list,tool-selection,package-command,mcp-command,mcp-oauth-command,provider-auth-command,export-command}}.test.ts`: selector/model/tool policies and standalone grammar, trust, storage, channels and bounded cancellation.
- `packages/cli/src/cli/package-command.test.ts`: source parser/API checks plus real emitted CLI package journeys; policy failures retain exact channels, original native error fields and code/signal diagnostics. The Docker build control additionally requires the genuine Web bundle needed by emitted Server tests, not a stub.
- `packages/cli/src/cli/provider-auth-command.test.ts`: equal/separate issuer syntax and independent storage label, genuine HTTPS forms, encrypted refresh before real Bearer dispatch, local logout and monotonic expiry under wall-clock rollback; not installed-CLI/account/subscription acceptance.
- `packages/cli/src/cli/{model-resolution-process,no-mcp-process,resource-discovery-process,offline-mode-process,length-stop-process}.test.ts` and installed consumers: actual native selection/denial/resource/offline/output-limit boundaries; [CLI reference](./cli-reference.md#associated-tests) expands the owning coverage.

Run `make typecheck`, `make test-parity`, `make test` in Docker. The CLI composition-root change does not change Server/Web behavior; broader integration/platform qualification remains separate.

## Common Changes

- **Change argv or channel policy:** update `args.ts` / `index.ts`, this versioned map, exact installed help and only intentionally affected goldens; preserve strict parsing and credential redaction.
- **Change cancellation:** update the composition-root lifetime and reuse the emitted/installed signal probe. Preserve underlying transport/tool budgets and native payloads; final settlement must follow owned cleanup. Do not replace real provider/transport checks with mocked callbacks.

## Related Domains

- [CLI reference](./cli-reference.md) — full native settings, RPC, package and resource semantics
- [Security](./security.md) — project trust, encrypted credentials and privilege boundaries
- [Sessions](./sessions.md) — native persistence, admitted writes and independent lifecycle qualification
