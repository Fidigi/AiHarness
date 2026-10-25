# AiHarness Project Map for AI Agents

This is the canonical navigation and validation guide for repository work. Read it before changing code. It explains where behavior lives, which contracts cross package boundaries, and how changes must be validated. It is not a replacement for reading the relevant implementation and colocated tests.

## 1. Working Rules

1. Read the nearest `AGENTS.md` and this file before editing.
2. Run `git status --short` first. The working tree may contain unrelated user changes; preserve them and never reset, overwrite, or reformat them accidentally.
3. Read the implementation, its tests, and the relevant documentation before making a change. Do not infer current behavior from filenames or the changelog alone.
4. Keep changes in the owning package. Move shared contracts and reusable behavior into `@ai-harness/core`; do not create reverse dependencies from `core` to an interface package.
5. Use npm workspaces. The root `package.json` defines the workspaces, and `package-lock.json` is the single workspace lockfile. Do not hand-edit lockfiles or generated output.
6. Do not edit `node_modules/`, `dist/`, coverage output, Playwright reports, or other generated files.
7. Tests and type checks are required to run in Docker in this repository. Use the `Makefile` workflow described in [Validation](#8-validation).
8. Never commit credentials, tokens, local session data, or `.env` files. Tests must use mocks or disposable values.
9. Keep this map current when package boundaries, entry points, persistence formats, documentation status, or validation commands change.

## 2. Platform at a Glance

AiHarness is a strict TypeScript, ESM, npm workspaces monorepo with four packages:

```text
                                      ┌──────────────────────┐
                                      │ @ai-harness/core     │
                                      │ types, providers,    │
                                      │ sessions, extensions │
                                      └──────────▲───────────┘
                                                 │
                         ┌───────────────────────┼───────────────────────┐
                         │                       │                       │
                 ┌───────┴────────┐      ┌───────┴────────┐      ┌───────┴────────┐
                 │ CLI            │      │ Express server │      │ React Web      │
                 │ ai-harness     │      │ API + launcher │◄─────│ browser client │
                 └────────────────┘      └────────────────┘ HTTP └────────────────┘
```

Dependency direction:

- `@ai-harness/cli` -> `@ai-harness/core`
- `@ai-harness/server` -> `@ai-harness/core`
- `@ai-harness/web` -> `@ai-harness/core` for shared types, and -> server at runtime over HTTP/SSE/WebSocket
- `core` must remain independent of CLI, server, React, and browser concerns

Primary runtime entry points:

| Runtime | Source entry point | Built command/output |
|---|---|---|
| Interactive, print, JSON event, and JSONL RPC CLI | `packages/cli/src/index.ts` | `ai-harness`, `packages/cli/dist/index.js` |
| API server | `packages/server/src/index.ts` | `packages/server/dist/index.js` |
| Combined production Web launcher | `packages/server/src/web-cli.ts` | `ai-harness-web`, `packages/server/dist/web-cli.js` |
| React application | `packages/web/src/index.tsx` | `packages/web/dist/` |

Development ports differ from the combined launcher:

- Vite Web development server: `3080`
- Express development server: `3099`
- Vite proxies `/api` and WebSocket upgrades to `127.0.0.1:3099`
- `ai-harness-web` serves the API and built Web assets together on `127.0.0.1:3080` by default

## 3. Repository Navigation

### Root

| Path | Purpose |
|---|---|
| `package.json` | Workspace scripts and shared development dependencies |
| `package-lock.json` | Authoritative npm workspace dependency lockfile |
| `tsconfig.json` | Strict shared TypeScript options; source uses ESM |
| `vitest.config.ts` | Canonical root unit-test discovery and source aliases |
| `playwright.config.ts`, `.docker/e2e-suites.mjs`, `.github/workflows/ci.yml` | Development browser discovery, complete local suite runner and four isolated CI partitions; optional assets retain their owning preview/static hosts |
| `Makefile` | Authoritative Docker build and validation workflow; E2E artifacts and Docker-generated baselines are copied out of the completed container |
| `.docker/` | Test, production, and lockfile Dockerfiles; bounded E2E artifact helpers archive only screenshots added or byte-changed by that run so concurrent cleanup cannot restore stale baselines |
| `e2e/*.spec.ts`, `e2e/fixtures/`, `e2e/*-snapshots/` | Playwright journeys with reusable intercepted API fixtures, a real-server smoke path and Docker-generated visual baselines |
| `tests/functional-parity/` | Manifest-driven public CLI/JSON/RPC/session/extension/SDK goldens plus genuine outside-checkout Core/CLI pack/install/PATH-bin/worker probes; local archives, not public registry distribution |
| `docs/` | User, architecture, extension, container, and agent documentation |
| `demo/`, `.github/workflows/demo-pages.yml` | Separate synthetic React/Vite static demo, bounded offline assets, Docker validation/export and build-only PR/separately admitted Pages pipeline; no backend/host tools |

Use npm from the repository root so workspace packages are linked consistently. Treat `package-lock.json` as authoritative for dependency changes.

### `packages/core`: shared domain and infrastructure

Start at `packages/core/src/index.ts`, which defines the public package exports.

| Area | Files | Responsibility |
|---|---|---|
| Shared contracts | `src/{index,public-api-version}.ts`, `src/types/{index,resource-batches}.ts` | Versioned public entry point plus `Message`, `Session`, provider/model metadata and pricing, OAuth/custom providers, tools, skill registry, plugins/sub-agents, extension interactions and run snapshots |
| Provider abstraction | `src/providers/{index,azure-config,provider-network,credentials,model-metadata,thinking-budgets,anthropic-thinking,provider-output-budget}.ts`, `src/security/credential-store.ts` | `AiProvider`, factory/built-ins, shared explicit Azure SSE Responses endpoint/deployment composition, bounded SSE/WebSocket streaming and cached continuation, proxy/deadline/retry policy, process-local credential lifecycle/redaction, explicit fail-closed encrypted persistence and generation/revision-owned refresh, discovery, usage/cache normalization and shared non-secret metadata |
| Specialized models | `src/providers/{specialized-models,classification-questions}.ts`, `src/types/codemode.ts` | Credential-private label/finite-question probability/image SDK and guest bridges, actual vision adapter inputs, bounded native image presentation/hooks/results and correlated once-only accounting |
| Model dispatch policies | `src/providers/{virtual-models,cache-warmer,cache-notices}.ts`, `src/agent/provider-turn.ts` | Selectable extension routing versus physical credentials/provenance, bounded branch state, per-session physical compaction, direct summaries and economic/time-bounded non-context cache usage and derived historical CLI/Web notices; see [dispatch policies](./topics/model-dispatch-policies.md) for profile/host/qualification limits |
| Model catalogue | `src/providers/model-catalog.ts` | Shared published/configured/discovered/custom assembly, bounded discovery, full-ID-first lookup, provider-local fuzzy choice with credential-aware ambiguity, plural ordered scopes and non-secret protocol descriptors |
| Session persistence/context | `src/sessions/{session-manager,session-context,session-branch-admission,session-branch-summary,branch-summarization,provider-branch-summarizer,session-custom-data,session-context-state,session-accounting,serialization}.ts` | Bounded/private/locked v2 journal, owned custom state/context, parent-based reconstruction, explicit tool-free navigation summaries with stale/cancelled admission, serialized active-state snapshots, read-only native journal snapshots and shared rich startup/related/independent copies, ordered revocable branch/summary admission, statistics, append-only context edits/private request-loadout deltas/checkpoints and redaction |
| Session SDK | `src/sdk/{index,agent-session,types,session-store,resource-loader}.ts` | Explicit API-1 factory/facade, true memory/borrowed structural stores, fresh canonical trust, copied/redacted inputs/observers, existing runtime/history/resource methods, durable stop/wait and last-handle-owned cleanup; no implicit discovery/executable/MCP/auth loading |
| Compaction | `src/sessions/{compaction,compaction-model-messages,summary-model-messages,compaction-cut,compaction-preparation,compaction-generation,session-manager}.ts` | Owned canonical input/atomic tool cuts,separate provider-only public summary projection,bounded descriptor-only generation and response evidence,legacy estimates and optional model-window-minus-reserve gate,prompts/metrics,exact manager-local source leases and signal/journal/store-generation revalidation through structural preparation;admitted writes are not cancellation rollback |
| Detached agent | `src/agent/{runtime,prestart-admission,work-retention,tool-loop,nested-tools,tool-result,provider-turn,provider-request-estimate,provider-request-options,provider-request-payload,events,message-queue,interaction-handle}.ts` | Shared model/tool loop,hooks/stream retry,owned post-hook payloads and optional known-window canonical/native-output guard,boundary-owned steering/follow-up,useful one-budget overflow/length recovery,trusted readonly batches,bounded nested execution and owned rich results,runs/stop,full tool outputs,interactions and sequenced journal |
| Coding tools, discovery and commands | `src/tools/` | Shared CLI/Web `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`; prompt-local `tool_search` with bounded BM25 ranking, deferred declarations and branch-persisted activation metadata; inactive-by-default QuickJS `codemode` in a disposable bounded worker with live authorized nested calls, script-only exposure and success-only branch store; browser-safe `!`/`!!` parsing; detached direct-shell runtime; bounded/backpressured process execution, filtered environments, tree cancellation, private output retention, exact edits, trust gates and common active-tool selection |
| Prompt inputs and instructions | `src/prompts/{prompt-input,instruction-context}.ts` | Canonical bounded `@path` UTF-8/image loading plus shared CLI/Web independently trusted agent-directory, trusted project-context and system-prompt discovery/composition; stable nonlinked files, aggregate limits and source precedence are enforced once in Core |
| Resources and themes | `src/resources/{resource-manager,file-selectors}.ts`, `src/themes/{theme-manager,theme-sources}.ts` | Trust-gated Markdown with literal declaring-directory selectors, independent discovery/all-loading policies and bounded metadata-only theme selection, collisions/provenance, strict skills/palettes and adaptive terminal probing with OSC/CSI filtering |
| Agent settings | `src/config/{agent-settings,codemode-limits}.ts` | Validated trusted code-mode reductions with unchanged absolute ceilings; pre-trust-independent agent-directory resolution, bounded stable `settings.json` loading, native diagnostics/migration/trust/merge/global-only/provenance and runtime resolution; separate public owned global/project editor projection, never file or execution authority |
| MCP configuration, OAuth, test and session host | `src/mcp/{config-inventory,config-import,import-shell,registered-servers,server-test,session-host,resource-tools,resource-content,oauth,oauth-provider-factory,oauth-flow,oauth-fetch}.ts` | File-only JSON/JSONC parsing, strict diagnostics, persisted-trust project gate, redacted descriptors, bounded paste conversion/reparse and atomic local mutations; encrypted name/URL-isolated OAuth providers plus detached explicit loopback/paste flows and passive refresh; shared one-shot stdio/HTTP Test; and the persistent per-session host used by CLI, RPC and Web with fresh pre-prompt config/trust reads, direct-startup waits, lazy codemode/deferred discovery, deterministic tool names, read-only enforcement, invocation/result redaction, server-bound resources/templates, owned structured/image results and opaque binary retention, reconnect/idle/shutdown bounds and config-keyed runtime status |
| Plugin packages | `src/plugins/{plugin-service,package-command}.ts` | Shared CLI/Web immutable literal npm argv, exact-source fresh/explicit process trust, shell-free bounded runner, npm/Git/local source policy, staging, trust/scopes, per-resource filters, bounded group activation with per-entry outcomes, symlink-free inventory, checks/updates, rollback, locked owner-only atomic state and sanitized catalogues |
| Linked-directory consent | `src/security/linked-directory-{consent,store,types,helpers}.ts` | Explicit metadata and Linux descriptor-scoped read grants; never expands roots/trust or execution authority; see [linked directories](./topics/linked-directories.md) |
| Workspace security | `src/security/` | Canonical allowed roots/defaults, display-only home labels, unavailable-default refusal, symlink boundary, 500-entry directory browsing, one-direct-child creation, bounded project-resource inventory and nested breadth scan, shared exact/inherited allow/refuse trust decisions, serialized fresh-folder trust-plus-write with exact rollback, and force-classified Git/worktree operations |
| Extension API/loader | `src/extensions/{extension-registry,module-loader,module-manifest,module-format,typescript-module,native-module-alias,extension-selectors,builtin-extensions,startup-options}.ts` | Versioned owned commands/tools/providers/MCP servers/plain-text UI, bounded boolean/string startup options/help/completion, hooks/listeners, literal main/suffix entry resolution, symlink-free metadata-only glob/exact selection, descriptor-backed TypeScript transformation and atomic fresh ESM/CommonJS entry generations |
| Host integration | `src/system/open-external.ts` | Shared shell-free macOS/Windows/Linux URL or directory opener with a bounded spawn and secret-free environment |
| Utilities | `src/utils/index.ts`, `src/utils/event-emitter.ts` | IDs, formatting, retry helpers, typed event infrastructure |

Provider implementations currently include OpenAI, Anthropic, Google Gemini, Azure OpenAI, Vertex Gemini, AWS Bedrock, local OpenAI-compatible servers, and mock. OpenAI-compatible SSE explicit errors fail before mixed-frame output or pending tools, with a fixed body-free diagnostic and unchanged shared retry/prefix rules; Core `providers/stream-error-frames.test.ts`, CLI `cli/stream-error-process.test.ts` and genuine installed consumers own that narrow boundary. CLI print/JSON and RPC await durable redacted failed text/reasoning with `metadata.outputError` before settlement, without pending tools or invented usage; ordinary stream failure does not trigger compaction. Recognized structured overflow and length exhaustion have separate bounded useful recovery; see [native recovery](./topics/run-lifecycle.md#bounded-useful-context-recovery). See [provider errors](./topics/providers.md#explicit-openai-compatible-sse-errors). OpenAI/Anthropic/Gemini expose bounded model discovery where their APIs permit it; reasoning deltas and input/output/cache usage are normalized. Core's `src/providers/model-metadata.ts` owns versioned non-secret published capabilities, context/output limits and cache-aware prices. `src/providers/model-catalog.ts` merges those with configured, bounded/deduplicated live and custom definitions, then supplies the full-ID-safe resolver, thinking suffixes, fuzzy filtering, glob scopes and RPC descriptors reused by CLI and Server. Core `providers/model-resolution-ambiguity.test.ts`, CLI `providers/startup-model-resolution.test.ts`/`cli/model-resolution-process.test.ts` and genuine installed consumers guard provider-order independence, sole-credential selection/refusal, plural scopes, preserved first thinking pins, trailing commas and fixed stderr-only unresolved-scope warnings, including with an explicit startup model. Public Core additions must be re-exported from `src/index.ts`. CLI/RPC pass copied per-turn `thinkingBudgets` through shared hooks to Anthropic and Gemini/Vertex numeric adapters; `providers/thinking-budgets.ts` owns safe-integer admission and conservative provider-local clamps. `providers/anthropic-thinking.ts` separately gives the exact published Sonnet 4.6 profile native adaptive effort/off payloads, with per-call model reevaluation and conserved output defaults. Detached HTTP runs additionally copy `StartAgentRunRequest.thinkingBudgets` before admission and use administrator-scoped whole-map configuration over trusted-file fallback; Web defaults edit the map with EN/FR numeric/inheritance help. Prompt bodies do not grant budget authority. See the [pinned provider/configuration matrix](./topics/provider-matrix.md) for all 42 factory identities and remaining API/auth/catalogue gaps. This does not add child-agent/legacy-chat composition, signed thought replay or complete adaptive/model dialects; see [providers](./topics/providers.md#numeric-reasoning-budgets).

Session files are versioned JSONL (current schema: v2). Entry types include `metadata`, `message`, `command`, `compaction`, `branch_summary`, `custom`, `custom_message`, `context_edit` and `loadout`; old unversioned message-only files remain readable. Custom state/details stay outside model context; custom content remains model-visible even with `display: false`. Navigation injects destination summaries, respects compaction and complete tool groups, and never follows summary source provenance as a parent. New messages track their active parent, command/message leaves advance together, clones remap internal IDs, and `SessionManager.getRawEntries()` retains persisted pre-compaction history for projections. Awaited `getActiveBranchEntries(id)` instead returns owned parent-first active ancestry, including private pre-compaction state, last append projections and complete-ancestry refusal. Related forks preserve selected custom ancestry/stable IDs through the same bounded copy path used by independent clones; only clones remap IDs. Custom type names are conventions, not extension isolation. Core `sessions/session-active-entries.test.ts`, actual CLI `cli/extension-session-state-process.test.ts` and installed consumers own state/branch/compaction/copy/restart/generation and declaration proof. Runtime timestamps are `Date` objects, API dates are ISO strings, and persisted entry timestamps are Unix milliseconds. Rich message blocks, usage/cost, agent/workspace metadata and branch relationships must round-trip. Provider secrets must be redacted before API or disk serialization. Update loading, saving, appending, exports/imports, API hydration and compatibility tests together.

`SessionManager.navigateTree` grants provider authority only through explicit `summarize: true`; the provider adapter declares no tools. Bounded owned requests are generated outside the mutation queue, then signal/session/journal identity is rechecked before durable publication. CLI `/navigate` requires explicit summary/no-summary choice unless `branchSummary.skipPrompt` defaults to no summary; RPC `navigate_tree` retires pending admission on EOF/close as well as aborting registered work. Legacy metadata-only compaction background has a bounded ancestry-scoped prefix, including reload/later compaction and cloned anchors, not unrelated roots. Native and structural SDK stores preserve journals independently of filesystem-path availability. The high-level SDK facade adds no navigation/custom mutation methods; see [sessions](./topics/sessions.md).

Core's `session-branch-admission.ts` owns bounded ordered cancel-only leases, separate from concurrent/error-isolated lifecycle observers. Manager copy/in-place methods and explicit navigation summaries recheck caller/source/store/generation before durable admission; admitted writes finish. Registry `before:session:branch` and output-only `before:session:summary` bridge through independently borrowed bindings, including SDK per-handle disposal without stealing host lifecycle ownership. Last defined validated summary override wins; a later veto cancels, fallback keeps the original caller signal, and no implicit model work/private transcript data is authorized. CLI/RPC retain nondestructive busy refusal and publication-only dialog retirement. Server `api/session-copy-request.ts` withdraws unpublished disconnected fork/clone work while preserving running-source persisted-target copies. Tests live in owning Core session/extension/SDK branch/summary leaves, CLI RPC/real emitted+installed terminal fixtures and Server request/live-mutation leaves; see [sessions](./topics/sessions.md#fork-versus-clone) and [extensions](./topics/extensions.md#ordered-branch-and-summary-admission).

Explicit manager compaction accepts optional fifth-slot own-data signal/source options; capture an exact frozen manager-local source view before generation, not after it. Core owns journal/legacy/store-generation validation and single-use final save admission without new facade/store methods. RPC tracks manual compaction through abort/EOF/close and callback-safe retries, publishing through its captured canonical ID without a late Session ID accessor read; CLI forwards its captured input lifetime, selection and passively validated canonical ID; SDK captures source authority before start observers and forwards its handle lifetime. These explicit publications validate canonical own-data IDs without redirecting an unpublished write or executing identity accessors; siblings/borrowed resources remain independent. Core now shares owned prior-summary/custom/command model input and atomic assistant/tool cuts through `getCompactionModelMessages`, `prepareCompactionContext` and `selectCompactionCut`;arrays remain mutable but do not alias history. Native publication/reload/navigation/copies preserve nonordinary retained boundaries and known projected command links,not private payload IDs. Server manual agent/proxy requests now reuse authentic disconnect ownership;agent generation uses shared structured prefix preparation and captured Core source/save authority,while administration follows actual awaited settlement. Already-admitted saves finish;exclusive legacy refusal remains. Core now also owns bounded generation/known-response copying across CLI/RPC/HTTP and rich automatic adapters;mutable callback arrays grant no source/cut authority. Shared ordinary turns now own payloads before/after JSON redaction,retain awaited observer mutations and guard canonical input plus explicit/exact first-party Anthropic native output when a known manager budget exists. Unknown-to-known/effective-model/media policy,CLI/RPC budget composition,renderer/hooks/provenance,invalid/withdrawn accounting,general pre-start authority,physical settlement and useful overflow remain separate;see [bounded request admission](./topics/providers.md#bounded-ordinary-request-admission). See [sessions](./topics/sessions.md#effective-context-and-compaction) and [SDK ownership](./topics/session-sdk.md).

Core privately reserves same-session startup before trust/agent-hook/provider awaits, captures request values and borrows optional `StartAgentRunRequest.signal`; registry `before:agent` pins its optional readonly host signal through transforms. SDK owns each prompt lifetime from call admission, refuses duplicate starts, retires unpublished work on stop/dispose and preserves earlier serial mutations/borrowed resources. Ignored callbacks may physically continue; admitted metadata saves finish without rollback. Core prestart/helper/process, SDK lifetime and genuine installed declarations/runtime leaves own this narrow boundary; [SDK pending ownership](./topics/session-sdk.md#pending-prompt-ownership) separates it from unimplemented typed-system/custom-trigger/queue facade methods. The [native RUN model](./topics/run-lifecycle.md) joins admitted work and cleanup, including handle-free promises, and documents queue boundaries, useful one-budget context recovery, trusted readonly batches, nested execution and owned rich results. Core owning tests, real CLI/JSON/RPC/SDK/PTY probes, installed consumers and genuine HTTP/browser controls cover distinct boundaries; only executed receipts in AUDIT-5 establish qualification. RUN-01's functional delivery is closed in AUDIT-5; native compiler failures and incomplete whole-platform qualification remain separately under QUA-01, without a V8/environment repair task or transfer of an older whole-platform receipt.

Core root `getSummaryModelMessages` separately owns filtered summary-provider input: public text/tool/image/command data survives; reasoning, private metadata/replay, retained full outputs and download links do not. Original canonical and final projected bounds remain; estimates, atomic cuts, raw history and trusted SDK callbacks are unchanged. Default CLI/RPC and Server manual/automatic adapters use this view; branch rendering conserves rich/compatibility text in its existing inert transcript. Legacy compact alone preserves typed public traces through that whitelist; ordinary legacy chat remains role/content-only. Core `sessions/summary-{model-messages,branch-public-text}.test.ts`, CLI command/Bugreport/native host leaves, Server `api/summary-public-http.test.ts` and genuine installed consumers own these controls. This is not exact vendor tokenization or a CLI-SES-07 closure.

CLI/RPC automatic compaction applies published model limits or a 128,000-token non-mock fallback to `estimateContextTokens > window - reserveTokens`, then shared complete-unit cut/keep rules. Root `SessionManager.setCompactionContextWindow` supplies an optional validated non-persisted host limit (manager-wide by default, optionally session-specific for physical routing); absent/mock policy and manual targets retain legacy semantics. RPC `reload_context_settings` passively rereads only compaction/branch-summary settings through fresh trust and startup-pinned roots, retaining prior policy on diagnostics and withdrawing unpublished preparation on abort/EOF/close. It does not reload providers, executables, thinking budgets or session storage. Estimates omit full system/tool wire overhead and unknown metadata stays unknown; bounded useful overflow/length recovery preserves policy/source/cut checks and authentic accounting as specified in [the run contract](./topics/run-lifecycle.md#bounded-useful-context-recovery). Owning controls are `sessions/compaction-context.test.ts`, the three RPC context-policy/lifecycle leaves, actual eleven-scenario `cli/context-settings-process.test.ts` and the installed public consumer; see [sessions](./topics/sessions.md#effective-context-and-compaction).

### `packages/cli`: terminal product and automation

| Area | Files | Responsibility |
|---|---|---|
| Composition root | `src/index.ts` | Strict two-phase startup arguments, diagnostic-only bootstrap credential guesses versus definitive runtime redaction authority, interactive/print/JSON/RPC modes, session loading, resources, trust, extensions, input dispatch, hooks, streaming, shutdown |
| Command router | `src/commands/handler.ts` | Built-in slash commands, provider initialization, model/session operations with current-model compaction overrides, import/export/share/login |
| Startup sessions | `src/sessions/startup-session.ts` | New/continue/resume/open/fork/exact-ID/name selection and storage-directory precedence |
| Agent execution adapters | `src/agent/{tool-loop,provider-turn}.ts` | Thin re-exports of Core execution primitives; startup registers Core's workspace coding tools for the current cwd |
| Regular TUI | `src/tui/terminal-ui.ts`, `src/tui/{editor-state,terminal-settings,status,status-prompt-refresh,terminal-text}.ts` | Readline output/help/transcript/streaming plus shared Core journal accounting/context/resource status at guarded prompt boundaries, late-refresh exclusion and stateful control-safe grapheme/cell projection |
| Fullscreen TUI | `src/tui/fullscreen-ui.ts`, `src/tui/fullscreen-input.ts`, `src/tui/terminal-escape.ts` | Header/transcript/editor/footer with actual active/full-history usage and known/unknown cost, short-screen resize fallback, alternate-screen cleanup, concurrent steering/follow-up, lone-Escape/Alt+Enter, history/completion/scrolling and bounded extension panels |
| Mode, startup and themes | `src/cli/{startup-display,offline-mode,theme-sources}.ts`, `src/tui/{mode,theme-manager,theme-input-filter}.ts` | Quiet/header/full startup, process-only passive offline policy, terminal mode, trusted theme source/selection precedence and suppression, live replacement and filtered adaptive probe input |
| Extensions | `src/extensions/extension-loader.ts` | JavaScript/TypeScript discovery and Core loader orchestration |
| Skills/prompts | `src/resources/resource-manager.ts` | Markdown front matter, discovery, prompt expansion, model-invocable skills |
| Provider runtime and security | `src/providers/provider-runtime.ts`, `src/security/` | Shared Core credentials/network composition, independent pre-trust store selection and bounded provider OAuth Device Flow |
| Direct shell | `src/cli/shell-controller.ts` | Trust-aware interactive `!`/`!!` adapter over Core's CLI/Web shell runtime, with regular/fullscreen streaming and abort |
| Package commands | `src/cli/package-command.ts` | Strict top-level lifecycle aliases/actions, global/project scopes, per-kind filters and JSON/text adapter over Core `PluginService` |
| Standalone credentials/export | `src/cli/{provider-auth-command,export-command}.ts`, matching tests, `src/security/oauth-device.ts`, `src/utils/session-export.ts` | Before-startup passive credential metadata, explicit encrypted device login/local logout with caller body abort/verbatim codes/monotonic deadline, selected no-follow trusted workspace export over existing Core/slash ownership |
| Models | `src/cli/model-list.ts`, `src/providers/configured-providers.ts` | Configured-provider listing, shared startup exact/fuzzy/scope resolution, settings defaults/scopes, ephemeral API-key override and mode-independent provider construction |
| Agent settings and resources | `src/index.ts`, `src/resources/resource-manager.ts` | Global/trusted-project settings integration, safe ordered skill/prompt discovery, startup precedence, `/settings`, and interactive reload |
| Tool intent | `src/cli/tool-selection.ts` | CLI-only name/star-pattern replacement or ordered exact +/- adjustment of defaults; current metadata resolves to exact Core allow/deny lists, exclusions win, no public Core/Server selector ABI change. See [CLI selection](./topics/cli-reference.md#cli-tool-selection). |
| Headless JSON | `src/cli/json-output.ts` | Versioned session/lifecycle/retry/compaction JSONL encoding plus serialized backpressure-aware stdout isolation over the shared Core loop |
| Headless RPC | `src/rpc/{rpc-server,rpc-controller,rpc-extension-ui}.ts` | Strict LF-framed command/response/events, next-turn steering/follow-up, cached/scoped models with compaction-policy refresh on model/session switch, passive explicit context-settings reload with abort/EOF retirement, effective global/session enablement, usage-aware raw session trees, bounded provider and shell streaming, expiring retained output, bounded extension dialogs/presentation with explicit replay/capabilities and EOF cancellation, and deprecated method/params compatibility |
| Terminal keybindings | `src/utils/{keybinding-manager,keybinding-config,keybinding-source,terminal-actions,keypress-gate,hotkey-view}.ts`, `schemas/keybindings.schema.json` | Bounded trusted literal config/reload, 29 host-owned actions, inert bounded bracketed paste and passive filter/pages with exact draft/caret/undo restoration; shared grapheme/word/multiline editor and exact application history; schema copied into installed assets |
| Native editor schemas | `schemas/editor-schemas.mjs`, `schemas/{keybindings,theme}.schema.json`, `scripts/copy-assets.mjs`, Core `src/{config/agent-settings,providers/model-editor-schema,themes/theme-manager}.ts` | Public owned settings/project/model-metadata projections emitted in normal CLI assets; original keybinding/theme JSON and 58 tokens byte-conserved. Native file/trust/state/privilege/defaults remain authoritative; no CLI models.json loader/private credential format. See [editor schemas](./topics/editor-schemas.md). |
| Integration helpers | `src/utils/` | Exports, clipboard, external editor |

The [CLI invocation contract v1](./topics/cli-invocation-contract.md) maps pinned Pi commands/options to native argv, inputs, channels and retained differences. Active print/JSON/RPC signals pin 130/143, abort owned work and retain handlers through cleanup; RPC ignores only its intentional signal-induced input close, preserving other transport failures. Real emitted and outside-checkout installed probes cover held SSE cancellation, repeat signals during async shutdown, JSON settlement and journal readback. The installed harness's `compilerNodeArgs` applies explicit `--no-maglev` only to the exact resolved TypeScript entry; application argv, captured native termination evidence and deadlines stay unchanged, with no retries. This is CLI-01 delivery, not complete terminal/provider/host parity.

The CLI has regular, fullscreen, print, one-shot JSON event, and RPC paths. A change to shared conversation behavior may need coverage in more than one path. The repository-owned functional-parity manifest invokes the real CLI process and consumes only AiHarness public interfaces; its narrow canonicalizer may replace temporary roots, UUIDs, timestamps, durations and generated workspace IDs, but preserves protocol records, order, values, framing and channel assignment. The bilingual [public contract policy](../contributors/en/public-contract-policy.md) governs golden changes, migrations and Core/extension major markers. Interactive and RPC steering/follow-up delivery plus detached Web queues use Core's bounded all/one-at-a-time scheduler; trusted Web runs resolve the same Core delivery-mode settings at startup, while terminal adapters only own key dispatch, lone-Escape/Alt+Enter disambiguation, cancellation feedback and editor restoration. All paths resolve Core's same model, instruction, agent-settings, credential/network and project-trust contracts: startup model/scopes, thinking, tools, compaction/retry, session directory, resources, shell behavior, supported TUI preferences, nearest saved allow/refuse decisions and `defaultProjectTrust` use explicit CLI → environment/process → trusted project → agent-setting precedence where applicable. Before trust, Core rejects an agent directory inside the workspace and locates `trust.json` in an independent symlink-free directory. Interactive startup prompts only when bounded metadata discovery finds protected project resources; `--approve`/`--no-approve` and headless RPC use one-process decisions without mutating the shared store. Documented context filenames and replace/append flags feed every provider turn; `/settings` reports effective source scopes and `/reload` refreshes settings, trust, credentials/network/providers, model/thinking, instructions, resources, themes, extensions, tools and shell callbacks. Terminal keybindings use the independently trusted agent-directory `keybindings.json` or startup-captured literal `AI_HARNESS_KEYBINDINGS`; `/reload` replaces complete validated layers, while passive F1/Alt+K browsing never executes actions or enters input history. Both real hosts own all 29 callbacks and reserved native safety controls; regular transcript keys print actual bounded buffered pages, not a complete terminal capability contract. See [keyboard ownership](./topics/cli-reference.md#terminal-keybindings-and-passive-view) and the [native capability/action/settings map](./topics/terminal-contract.md). Both hosts use bounded undo/grapheme/word operations and exact application history; bracketed paste inserts sanitized multiline text without dispatch. Interactive unsupported-setting warnings and `/settings` distinguish stored preferences from active palette/renderer behavior. Session location and renderer kind stay startup-only; RPC file defaults outside the explicit compaction/branch-summary reload still require restart. `quietStartup` selects full, header-only or no welcome/initial snapshot; `--verbose` restores the full display without persistence. Both renderers retain the installed version and safe title handling; startup detail suppression survives empty input/redraws until nonempty submission restores normal live status. Fullscreen chrome/editor, resource loading, trust prompts, warnings and headless channel purity remain independent. Reload never replays startup presentation. Strict `--offline` or trimmed case-insensitive `AI_HARNESS_OFFLINE=1|true|yes` captures a process-only automatic-startup policy: no provider discovery, credential commands/cache consumption or OAuth refresh at startup/reload. Environment policy is captured before trusted extension loading; flag policy uses the definitive parse. Catalogue commands use published/configured metadata, and due-for-refresh OAuth stays unchanged/unavailable. Explicit turns/auth/package/MCP/tools/extensions retain their normal privileges: this is not a network firewall, Server/Web switch or persisted catalogue cache. Core's additive `discover`, `allowCommands` and `allowRefresh` options default to previous behavior. `/model` and RPC cycle against the shared ordered scope, and `--list-models` reports settings diagnostics but exits before session/resource startup. Built-in command metadata lives in `commands/handler.ts`, while user-visible help also exists in both TUI implementations.

Project extensions are executable code. User extensions are loaded from `~/.ai-harness/extensions`; project extensions and project package resources require project trust. CLI discovery/orchestration remains in `cli/src/extensions`, while bounded `ExtensionModuleLoader` and package lifecycle/state/inventory implementations are shared from Core. CLI/RPC pass global then trusted-project settings selectors to Core without prematurely reducing them to path strings; include globs and exact add/remove/exclusions operate on discovered files before imports, with fail-closed bounds and fresh reload selection. Core `paths` remains literal; `selectors` is additive, retaining literal cwd/declaring-directory identity separately from glob patterns. A separate bounded Core policy selects optional `builtin:mcp`, `builtin:codemode` and `builtin:tool-search` capabilities. CLI/RPC `--no-extensions` suppresses automatic/settings/environment/package executable discovery while preserving explicit `-e` requests and ordinary tools/resources. Interactive reload retires disabled MCP sessions and reenables lazily; RPC retains its startup snapshot. This does not compose Server/Web switches or sandbox privileged modules. Core's shared format predicate now admits `.ts`, `.mts`, `.cts` and `.tsx` beside the three JavaScript formats, excluding declaration files from discovery/package activation. Lazy pinned `jiti` evaluates the already admitted entry bytes with private transformed dependency graphs and the actual host Core root namespace; it does not type-check, load implicit tsconfig aliases or sandbox Node code. CLI/RPC and emitted Server reload use the same ownership/trust guards. Uninstalled directory manifests now resolve exact confined `aiHarness.extensions`/legacy `pi.extensions` entries before sibling discovery, behind stable metadata descriptors and shared operation limits; declared module directories additionally use confined, bounded Node main/index resolution, not recursive resource manifests or arbitrary exports maps. Native JavaScript also resolves the exact host Core root through contextual hooks and a leased, owned-caller CommonJS require adapter, conserving foreign wrappers and native cache identities; bounded URL metadata covers cached transitive dependencies. No private aliases, cache revocation or sandbox are implied. Missing literal module requests now support JS-first suffix lookup and exact output-to-TypeScript suffix mappings. Automatic CLI/RPC/Server roots retain explicit directory intent, never sibling module fallback; resolved files remain trust-gated and deduplicated. Main indirections and aggregate candidate probes are bounded; ordinary resource roots/package globs keep their separate semantics. See [extensions](./topics/extensions.md) for scope and limits. Markdown CLI/RPC settings now use `resolveAgentResourceSelectors` and readonly `{ pattern, baseDir }` records; their literal declaring directories never become glob syntax. Legacy Core paths and explicit CLI selectors also expand home after optional `+`/`-`/`!`, preserving literal home identity and existing trust. Core `resource-home-selectors.test.ts`/`resource-template-arguments.test.ts`, actual `resource-home-process.test.ts` and installed consumers cover home/exclusion ordering and conserved empty-position/default semantics; see [resource arguments](./topics/cli-reference.md#agent-settings). Automatic/package roots and relative-CLI cwd stay literal; Core retains legacy mutable string path options and unchanged `resolveAgentResourcePaths` output, with scoped options additive in the same layer. Absolute selectors inside a scoped base preserve that literal base in both Markdown and shared extension/theme selection. Legacy Markdown strings recover only their longest already configured cwd/agent/home root; relative strings keep cwd semantics and arbitrary outside-base/nested patterns remain globs. There is no stat-based root guessing or extra trust; use consistent roots or explicit scoped/exact identities. `resource-absolute-selectors.test.ts`, its real emitted CLI leaf and installed Core/SDK/PATH consumer own the absolute-root boundary. CLI/RPC `--no-skills` / `--no-prompt-templates` suppress automatic/settings/package candidates while retaining explicit paths through optional Core `discoverSkills` / `discoverPrompts` (default true). Legacy `disableSkills` / `disablePrompts` still disable all loading, including explicit paths. Trust/stable-file checks remain mandatory; CLI reload retains discovery choice and refreshes explicit bytes. Print/JSON positional slash text stays literal; RPC and terminal input expand resource commands. Core/process leaves `resource-discovery-policy.test.ts` and `resource-discovery-process.test.ts`, plus the genuine installed consumer, own this boundary. Top-level package actions exit before agent startup; enabled package extensions, skills and prompts feed interactive/print/JSON/RPC startup and reload, while terminal themes combine automatic roots, enabled packages, declaring-directory selectors and literal explicit sources behind trust. `--no-themes` suppresses automatic admission, not explicit selection or built-ins; `/reload` refreshes candidates and exact active identity. See [terminal themes](./topics/themes.md) for bounds and mode-specific contracts. The server uses the same Core service and module loader through thin adapters during explicit startup/reload to atomically host enabled standalone/package extensions and their declarative Web surfaces; catalogue GETs and list operations never execute extension code or contact npm/Git.

### `packages/server`: API, transport, persistence, and Web launcher

| Area | Files | Responsibility |
|---|---|---|
| Server composition | `src/index.ts`, `src/runtime/services.ts` | Synchronous Express app construction, awaited bootstrap/retired-generation refusal, unavailable-default recovery with valid explicit roots and no implicit executable generation, middleware, routes, static assets and lifecycle |
| Detached execution | `src/api/agent-routes.ts`, `src/runtime/command-runtime.ts` | Agent state/SSE/queues/stop, effective setting overrides, Core-resolved trusted instruction prompts, exact preset capabilities, Core-backed shell command output/replay/cancel, manual and automatic compaction; `command-runtime.ts` is a thin re-export |
| Interactive terminals | `src/api/terminal-routes.ts`, `src/runtime/terminal-runtime.ts` | Owned `node-pty` processes, byte/event-bounded ANSI replay by native UTF-8 cursor with expired/interior/future reset and zero-width exit, no-store input/resize/status, removed-lease closure, instance limits and shutdown |
| Sidebar organisation | `src/api/sidebar-routes.ts`, `src/runtime/sidebar-state.ts`, Core `src/types/sidebar-state.ts` | Independent private bounded `sidebar-state.json`, fresh revisions, atomic bulk family pin/archive and ordered project display names, single-use expiring undo and cooperating-process exclusion; no journal/leaf mutation |
| Session windows/copies | `src/api/{session-pagination,session-copy-request}.ts`, `src/index.ts` | Metadata-only lists with canonical child hint, bounded tail/before/around pages with active-ancestry cache-notice projection, saved exact-entry clones through Core without source-runtime preparation, disconnect ownership, full server-side export, provider title generation and recursive cascade guard |
| Linked-directory browsing | `src/runtime/linked-directories-service.ts`, `src/api/linked-directories-routes.ts` | No-store selectors, capabilities/Origin, fresh source trust and redaction; composed through existing workspace routes |
| Workspaces and files | `src/api/{workspace-routes,workspace-file-manager,file-routes}.ts`, Core `src/{security,system,tools}/` | Trust, bounded browse/direct-child creation, loopback-only host file-manager launch, force-retry Git/worktrees, shared bounded coding tools, fuzzy index, collision-aware upload, source/media download, Git stats/diffs and file-watch SSE |
| Scoped configuration | `src/api/config-routes.ts`, `src/config/{config-store,effective-configuration}.ts` | Validated nullable global/project/session values, global-only Web cache-notice visibility independent of billing, runtime/environment precedence, provenance and atomic non-secret storage |
| Providers/models | `src/api/{model,provider-registry}-routes.ts`, `src/runtime/{model-catalog,provider-registry,provider-oauth,provider-administration,resource-batches}.ts` | Published/discovered/custom models, custom dialect providers, OAuth Device Flow, default-OFF restricted provider rename with awaited administration leases/private recovery intent, capabilities/prices, exact scoped activation batches and persist-before-use encrypted secrets; secret mutations fail closed without durable storage |
| Tools | `src/api/tool-routes.ts`, `src/runtime/services.ts`, Core `src/tools/` | Effective registry inventory, shared coding-tool registration, scoped presets/enabled tools, cached QuickJS self-test, global/project code-mode presentation/budget, visible restriction reasons, model capability filtering and Windows-only opt-in PowerShell |
| MCP configuration, OAuth, test and hosting | `src/api/mcp-routes.ts`, `src/runtime/mcp-inventory-service.ts`, Core `src/{mcp,tools}/` | Passive authenticated redacted overview plus admin-only paste/replacement preview, atomic local mutations, explicit one-shot Test and active OAuth status/start/poll/paste/cancel/logout adapters; the composition root injects Core's encrypted OAuth manager, detached flow registry, per-session MCP host and branch-persistent deferred-search loadout into `AgentRuntime`. Runtime status is decorated onto the same redacted inventory while OAuth tokens remain server-side; authenticated session-owned binary downloads stay inert/no-store |
| Plugin packages | `src/api/plugin-routes.ts`, `src/runtime/{plugin-service,configured-plugin-service,services}.ts`, Core `src/plugins/` | Operation-local fresh eligible npm settings for explicit actions (no HTTP approval override); HTTP adapter and executable generation composition over shared Core npm/Git/path administration, inventory, trust/scopes, filters, bounded bulk activation, locking and transactional updates/checks |
| Skills | `src/api/skill-routes.ts`, `src/runtime/{skill-catalog,skill-content-reference,skill-markdown,skill-registry}.ts` | Metadata-only catalogue plus separate explicit trust/key-bound bounded Markdown reads, declaring-directory confinement and no GET execution; independent exact-group frontmatter edits with owned receipt rollback/canonical failure readback, and HTTPS/SHA-256 registry installs/updates by trusted scope |
| Web Push | `src/api/push-routes.ts`, `src/runtime/push-service.ts` | VAPID lifecycle, public-endpoint validation, encrypted-or-volatile subscriptions, categories and stale cleanup |
| Child agents | `src/api/subagent-routes.ts`, `src/runtime/{subagent-service,subagent-runtime}.ts`, `src/runtime/services.ts` | Native version-1 profiles, owned parent policy intersections, fresh trust/MCP, sanitized linked context, pending cancellation and settlement-owned concurrency/depth; `spawn_subagent`, bounded results and parent attention events |
| Release status | `src/runtime/app-update.ts` | Bounded Web/agent versions, timed and cached release lookup, safe diagnostics without automatic installation |
| Request security | `src/security/request-security.ts` | Cookie/Bearer roles and capabilities, Origin checks, rate limits, safe errors, WebSocket auth context |
| Provider proxy/usage | `src/api/proxy.ts` | Built-in/custom provider setup, credentials, persistent cache-aware usage/cost, legacy chat/compaction and SSE |
| Detached SSE reconstruction | `src/api/{sse-channel,agent-event-policy}.ts` | Opt-in bounded draining, exact session/run/message/tool queued replacement and lifecycle preservation; legacy channels remain fail-closed |
| WebSocket transport | `src/api/websocket.ts` | Upgrade authentication without bearer reflection/query tokens, strict bounded RFC 6455 framing, cancellation/backpressure and legacy chat event payloads |
| Credential storage | `src/security/credential-store.ts` | Adapter over Core encrypted stable persistence; credential/OAuth mutation paths fail closed when the master-key-backed store is unavailable |
| Production launcher | `src/web-cli.ts`, `src/web-cli-options.ts` | `ai-harness-web` flags, environment precedence, static bundle location, browser opening |

Main HTTP surfaces:

- Public/auth: `GET /health`, temporary `GET /share/:token`, `/api/auth/status|login|logout`
- Application release status: authenticated `GET /api/app-update`, optionally refreshed without automatic installation
- Detached agent: `/api/agent/runs`, run queues/stop, session state/events/capabilities/compaction, commands/events
- Workspaces: `/api/workspaces/default|validate|browse|file-manager|trust|worktrees`; bounded browse supports strict direct-child creation, host file-manager launch is loopback/platform/path gated, and trust status includes protected-resource metadata plus exact/inherited allow/refuse provenance, while distinct `operationTrusted` keeps Web first-use capability explicit even when an empty fresh workspace has resource-sensitive `trusted: true`
- Files/Git: `/api/files`, content/download/index/upload/watch and `git/status|diff`; authenticated bounded `/api/files/preview` supplies PDF attachment bytes or inert DOCX main-document text, never browser-provided converter/remote URLs
- Terminals: `/api/terminals`, per-terminal events/input/resize/delete
- Configuration: scoped/effective nullable values under `/api/configuration`; legacy built-in credentials remain under `/api/config`
- Models: grouped published/discovered/custom catalogue and refresh under `/api/models`; qualified global/project activation under `/api/models/enabled` and exact bounded provider/displayed batches at `/enabled/batch`, with canonical post-error readback
- Provider registry: auth status/OAuth flows, tests, custom provider/model CRUD and imports under `/api/provider-registry`
- Tools: effective inventory and scoped preset/enabled-tool mutations under `/api/tools`; project IDs require their canonical cwd
- MCP: authenticated, `workspace:read`-guarded, redacted file-only `GET /api/mcp[?cwd=...]`; admin `configuration` capability for `POST /api/mcp/test`, non-mutating `POST /api/mcp/preview`, `POST /api/mcp/actions`, OAuth status/start/pasted redirect/logout, flow polling and cancellation; Test accepts only scope/name/cwd, rereads the entry and trust state in Core, opens one bounded stdio/HTTP connection and returns redacted capabilities without OAuth. Explicit OAuth keeps credentials server-side, revalidates config/trust before writes and verification, and uses detached expiring flows. Agent runs independently ask Core's per-session host to reread eligible configuration before each prompt, passively use/refresh stored OAuth state and expose connected direct tools
- Plugins: metadata-only scoped catalogue plus explicit install/enable/disable/remove/update/check, one-request bounded group activation at `PATCH /api/plugins/enabled`, and atomic session-aware executable reload under `/api/plugins`
- Skills: trust-aware catalogue/activation, separate no-store authenticated `/api/skills/content` reads, exact bounded `/api/skills/enabled/batch` frontmatter/scoped-list mutations and HTTPS registry search/install/update under `/api/skills`; Settings-only `SkillContentPane.tsx`, `services/skill-content.ts` and `skill-content-messages.ts` conserve body/reference lifetime, lazy budgets and existing checkbox/batch authority.
- Push: public VAPID key plus authenticated status/subscribe/unsubscribe under `/api/push`
- Child agents: scoped settings/profile CRUD and run list/start/get/stop/acknowledge under `/api/subagents`
- Sidebar presentation: authenticated `GET|POST /api/sessions/ui-state`, shared server-side revisioned family pins/archive, project order/display names and bounded undo; see [native sidebar API](./topics/server-api.md#independent-sidebar-organisation)
- Sessions: list/search/create/get/update/delete, model-assisted `auto-name`, recursive cascade confirmation, paged messages, info/export, append, fork, clone, tree and share
- Legacy chat: `POST /api/chat`, `/api/chat/stream`, `/api/chat/compact`; WebSocket upgrade at `/api/chat/ws`

All protected `/api` routes accept optional Bearer authentication or an opaque HttpOnly Web-session cookie when auth is configured. User/admin roles map to explicit capabilities; credential and dangerous workspace mutations require admin. Origin checks cover mutations and WebSocket upgrades. Express route declaration order matters: fixed paths such as `/tree` and `/search` must be registered before conflicting `/:id` routes.

The server has adapter/proxy code in addition to the provider implementations in `core`. Provider changes often need updates in both places.

### `packages/web`: React browser client

| Area | Files | Responsibility |
|---|---|---|
| App/router/auth | `src/App.tsx`, `src/index.tsx`, `src/components/LoginView.tsx` | Auth bootstrap, urgent router identity alongside synchronous external-store publication, workspace/session/provider/model/skill hydration, deep-link restoration, detached-run polling, chat/settings routes and lazy Sidebar/Settings/terminal boundaries |
| Session/provider state | `src/store/session-store.ts` | Canonical v1 workspace-selection persistence/recovery, Date hydration, indexed windows, bounded v1→v2 session-view cache, drafts/attachments, sequenced workspace model/skill catalogues, provider/model selection, summaries, runs and per-session settings |
| Preferences | `src/store/preferences.ts`, `src/store/{settings-navigation,mcp-selection}.ts` | Validated v4 appearance/input/notifications/panels/keybindings and migrations/own-write/cross-tab updates; separate v1 canonical-cwd/no-project Settings section/group/row/scope memory and MCP scope/name detail intent, each bounded to 24 contexts/65,536 code units; never configuration, inventory, trust, Test or OAuth authority |
| API client | `src/services/{api,mcp-api,push,resource-batches}.ts` | Cookie/Bearer fetch and SSE plus sessions/workspaces/direct-child creation/host file manager/files/Git force retry, provider registry/OAuth, tools, redacted MCP inventory, bounded one-shot test, explicit MCP OAuth status/start/poll/paste/cancel/logout, original-text import/replacement preview and persistence, explicit fresh-project trust-plus-write, and lazy local actions with authoritative workspace/uncertain-failure reconciliation, skill registry, plugins, Push and child agents |
| Process and reply reconstruction | `src/components/{process-turns,scroll-restoration,prepare-image}.ts`, `src/components/{ProcessBlockBoundary,ProcessBlock,AnsiOutput}.tsx` | Loaded-order grouping, retired layout work, stable native optional controls and attachment-only preparation; Core evidence remains authoritative |
| Chat | `src/components/{ChatView,SelectionActions,composer-submit,MarkdownContent,MarkdownContentRenderer,SubagentPanel}.tsx`, `src/agent.css` | Reconnection/history, IME-safe submission, rich rendering, Process/Response and full output, optional view/session/workspace-owned native-range selection geometry, resource palette, declarative extension widgets/interactions, drafts/images/queues, settings/compaction/branches and child agents |
| Extension interaction form | `src/components/{ExtensionInteractionBoundary,ExtensionInteractionDialog}.tsx`, `src/components/extension-interaction-dialog.css` | Ordered pending-head-only JS/CSS, waiting count, local loading/error/Close/Cancel and cached-reload warning; abortable transport, compatible drafts/IME and view/newer-focus/head-scoped coarse-editing guards |
| Markdown semantics | `src/components/markdown-{semantics,paste,list-continuation}.ts` | Shared currency/math, CJK/raw-text and frontmatter semantics, memoized rich/noninteractive projections, authoritative plaintext/inert bounded link metadata and IME/send-aware list/caret behavior |
| Navigation | `src/components/{Sidebar,session-links,SessionRowCopyMenu}.tsx`, `src/components/session-row-copy-target.ts`, `src/services/{navigation-base,session-row-copy}.ts`, `src/sidebar.css` | Lazy workspace/trust/worktree navigation, bounded browse/create/file-manager/force retry; native persisted/search/project anchors/contextmenu and safe basename/missing identity; exact saved-row copies capture source identity before awaits and retire on route/workspace/Sidebar inactivity without backend authority; drafts/actions remain buttons |
| Sidebar organisation | `src/hooks/useSidebarOrganisation.ts`, `src/components/sidebar-organisation.ts`, `src/components/SidebarProjects.tsx`, `src/services/sidebar-state.ts` | Active/focus/15-second canonical readback, bulk family actions/undo/conflicts, archive/run/attention visibility and project order/name controls with native keyboard/mobile links; [contract](./topics/web-app-architecture.md#durable-sidebar-organisation) |
| Linked-directory controls | `src/components/{LinkedDirectoryBoundary,LinkedDirectoryModal}.tsx`, `src/services/linked-directories.ts` | Optional local JS/CSS loading/error, exact metadata/confirmation, scoped reads and retired modal lifetimes |
| Workspace panel | `src/components/{WorkspacePanel,WorkspacePanelBoundary,DocumentPreview,PdfPreview}.tsx`, `src/components/{workspace-panel-messages,delimited-preview,file-preview-messages}.ts`, `src/services/document-preview.ts`, `src/workspace-panel.css` | Keyed optional JS/CSS and latest file intent; real Git/tree/watch/upload/trust, eight metadata-only file tabs with fresh reads, bounded PDF canvas/DOCX text/CSV-TSV previews and retired request/worker ownership; [native contract](../audit/pi/WEB-04.md) |
| Terminal | `src/components/TerminalPanel.tsx`, `src/services/terminal-replay.ts`, `src/terminal.css` | Lazy multi-tab xterm with workspace-keyed bounded metadata/restoration, validated UTF-8 byte replay, serialized bounded non-retried input, once-only clipboard framing, online SSE renewal, expired-ID refusal and owned request retirement |
| Mobile keyboard | `src/hooks/{useMobileKeyboard,mobileKeyboardStyles}.ts`, `src/hooks/mobile-keyboard.css` | View-tuple-owned conservative viewport observer, lazily owned chat-only styles and bounded cleanup; no physical-keyboard certification |
| Global keyboard/accessibility | `src/components/{CommandPalette,StatusCenter,SubagentMonitor}.tsx`, `src/services/{keyboard,escape-stack,notices}.ts`, `src/hooks/{useFocusTrap,useEscapeLayer}.ts` | Capture-phase nearest-layer Escape/IME/repeat ownership, guarded existing Stop, Settings return, coarse-safe focus with suspended-parent invokers, bounded notices and bootstrap shortcuts |
| Settings | `src/components/{SettingsView,EcosystemSettings,McpSettings,McpImportPreview,PluginSettings,SubagentSettings,ResourceBatchControls}.tsx`, `src/components/settings-navigation.ts`, `src/store/{use-settings-scope,workspace-refresh}.ts` | Stable presentation boundary/keyed id-cwd-trust business body, fresh unique row/group restoration, metadata-only scope memory, canonical trust/catalogue withdrawal and guarded visible focus return; provider lifecycle/custom resources, defaults/tools with cached sandbox health and scoped code-mode controls/reasons, model/skill registry, exact filter-preserving model/skill-group batches with retired-view guards and owned Markdown rollback, redacted MCP files with a workspace/trust-keyed panel, persistent per-workspace/no-project selected detail, explicit Test reports, volatile persistent-runtime state and server-side OAuth sign-in/paste/cancel/logout state, paste preview, confirmation-gated atomic import/replacement, row/group activation, exposure, removal/undo, grouped package controls, child profiles, auth, appearance, Push preferences, versions and shortcuts |
| PWA shell | `src/components/PwaStatus.tsx`, `src/services/push.ts`, `public/{manifest.webmanifest,sw.js,offline.html}` | Install/update/offline shell plus explicit Web Push subscription, visible-client deduplication and notification routing |
| Internationalization | `src/hooks/useI18n.tsx`, `src/i18n/`, `src/components/LanguageSelector.tsx`, `src/components/{mcp-import-messages,mcp-entry-messages,tool-progress-messages,settings-locale}.ts`, `src/components/SettingsLocaleBoundary.tsx` | Browser locale detection, English fallback, registered packages/persisted selection, typed-code-only EN/FR MCP diagnostics, execution/progress copy and conserved lazy Settings dictionaries; legacy technical details untouched, fill-only registration/custom overrides and translated loading/error/Close/reload retry |
| Styling | `src/{index,settings}.css`, `src/agent.css`, component CSS | Global/chat layout plus route-split Settings styles, themes and responsive behavior |
| Tooling | `vite.config.ts`, `vitest.config.ts`, `scripts/check-bundle-budget.mjs` | Source aliases, development proxy, package test settings, production chunks and failing bundle budgets |

The server is the source of truth for persisted Web sessions. A `draft:*` session stays browser-local until `POST /api/agent/runs`; the detached run becomes stoppable first, Core completes the abortable pre-prompt MCP preparation, and only then does the server persist the user message and begin provider execution. Stopping during that preparation therefore withdraws the unsent prompt; later model/tool turns persist normally. `ChatView` may hold a temporary streamed assistant message, but terminal events must resynchronize it with the canonical session without duplicates. The optional per-tab workspace cache is schema v2 with explicit v1 migration; it must remain bounded, favor draft text over binary previews, strip provider API keys and be discarded or reconciled whenever the server revision changes. PTY React state and stored IDs are keyed by workspace so a cwd switch unmounts the previous surfaces before restoring the target workspace. Scroll state uses a separate versioned, 24-entry/24-hour per-workspace `sessionStorage` map; capture it at scroll time (not from reused DOM during route cleanup), debounce writes, and rematerialize a missing virtual anchor through the paged `around` API before correcting its measured offset.

The declarative root `BrowserRouter` disables internal transitions so route identity updates stay urgent alongside Zustand workspace/session publication; the browser URL must not advance while a previous mounted route epoch remains available for a valid file intent that a delayed commit then retires. Preserve genuine navigation cancellation rather than carrying intent across replacement scopes.

The optional file pane loads its real component and original CSS together only when open with an eligible workspace. Pending presentation/file intent is keyed by workspace ID/cwd, session, route key and pathname/search/hash; address fields protect stateless history entries that reuse a fallback key. Close or navigation retires it. Delayed Markdown file-link dispatch additionally belongs to its original connected element/address, so it cannot publish into a replacement view. Local translated loading/error never suspends chat, composer or Stop. Rejection stays cached until explicit page reload, with an unsent-text warning. Parent capture survives DOM commit until child passive registration; deferred replay survives development StrictMode and is cancelled or superseded rather than replayed into a replacement scope. `e2e/workspace-asset-load.spec.ts` tests actual production assets with controlled API fixtures; `e2e/live-server.spec.ts` separately protects actual file/PTY/server behavior, awaiting workspace bootstrap and opening the uploaded file through its mounted explorer row rather than a synthetic event racing lazy hydration. `useFocusTrap.test.ts`, `preferences-bootstrap.test.ts` and production-preview `e2e/pane-lifetime.spec.ts` cover bootstrap registration, own preference retention, newer-focus/remount ownership and nested-modal safety.

The Web uses the server's real mock provider; there is no client-side demo response path. Most Playwright tests intercept API requests and model the detached protocol, including OAuth/custom providers/models, tool settings, redacted MCP inventory/one-shot test/import preview/atomic import/whole-entry replacement/local mutations, skill registry, plugin/reload, extension interactions, Web Push, profile CRUD and child runs. `e2e/live-server.spec.ts` traverses Vite → Express → mock provider → JSONL/reload and exercises real PTY/files/security. `web-server.test.ts` provides broader HTTP/provider/persistence/security and disposable Git/PTY/child-runtime coverage. Accessibility tests run axe plus focus/keyboard checks; performance tests protect bounds/cache/lazy loading. The 122 visual cases protect historical surfaces plus provider/model editors, registry, Process blocks, and extension dialogs across Light/Dark desktop/tablet/mobile variants; the redacted MCP state and import-preview matrix has dedicated Light/Dark desktop/mobile coverage.

## 4. Important Runtime Flows

### CLI conversation

```text
CLI positional/@file/piped input or interactive input
  -> strict mode/tool selection and bounded Core prompt-file loading
  |-> interactive ! / !! -> trust check -> Core ShellCommandRuntime
  |      -> filtered process + bounded stream/tree cancellation
  |      -> parented command persistence, optional model context and private full output
  `-> mode-specific dispatch (interactive expansion/commands; print/JSON literal text)
       -> before:agent extension hook
       -> SessionManager.addMessage(user)
       -> active Enter / Alt+Enter input -> Core steer/follow-up queue
       -> lone Escape -> abort active provider/tool/shell work and restore queued input
       -> runToolLoop
            -> before:provider hook
            -> AiProvider.streamChat
            -> optional tool calls -> before:tool hook -> extension tool
            -> persist tool call/result and continue provider turns
       -> persist final assistant message
       -> lifecycle events and TUI updates
```

Cancellation must propagate through `AbortSignal` to provider, active tool work and direct shell process trees. Interactive, final-text-only print, one-shot JSON event, RPC prompting, and the detached Web runtime use the same Core tool loop and provider-turn hooks; interactive CLI and Web direct commands separately share Core's `ShellCommandRuntime` and `parseShellCommandInput`. Provider implementations must await each stream callback; Core serializes delivery and bounds pending bytes/events so a non-cooperative extension cannot create an unbounded queue. JSON mode writes its version-3 session header and lifecycle records through `cli/json-output.ts`; RPC reuses that event encoder without the header. Do not add a provider or shell process path that bypasses hooks/persistence where applicable, retry, backpressure, environment filtering or cancellation without an explicit reason.

Standalone `ai-harness auth` and `export` dispatch before conversation startup; root help advertises their strict help surfaces. Authentication reuses Core's independent encrypted credential service and the bounded device client with caller signal, never a process-global fetch replacement. Export opens only the selected existing session, normalizes a detached memory-only projection and reuses slash rendering/Core atomic output; JSONL is message-only, not a journal backup. See the [EN](../users/en/standalone-operations.md) / [FR](../users/fr/standalone-operations.md) operator contract; these operations neither create sessions nor initialize providers/extensions/TUI.

The [native run lifecycle](./topics/run-lifecycle.md) owns RUN-01 across CLI/JSON/RPC/SDK/HTTP: unpublished retirement is distinct from admitted-work settlement. Core terminal replay follows durable writes and MCP cleanup; RPC/JSON final settlement follows accepted continuations and cleanup, not each intermediate agent-end. HTTP disconnect cancels only unpublished admission and transfers accepted work to the detached runtime. Keep privileged callback retirement distinct from physical termination, and retain independent RPC extension-command/UI concurrency.

### Web detached conversation

```text
React ChatView + local draft
  -> GET /api/configuration/effective (value + provenance)
  -> POST /api/agent/runs (trusted canonical cwd + explicit settingOverrides)
  -> server creates/reuses session, applies or removes only declared overrides, and persists user message
  -> AgentRuntime continues independently of the HTTP request
       -> shared provider/tool loop with effective model/thinking/tool preset
       -> optional auto-compaction under the same AbortSignal
       -> incremental persistence + sequenced events
  -> browser GET state?messageLimit=80, then GET events?after=<last sequence>
  -> older/target windows through messages?before= or ?around=
  -> temporary assistant delta keyed by messageId
  -> canonical session resync on terminal/tool events
```

The current protocol uses dotted event names such as `run.started`, `message.delta`, `tool.completed`, `extension.ui`, `queue.updated`, `retry.scheduled`, and `compaction.completed`, plus `connection.ready` for SSE setup. Sequence IDs, snapshot reset semantics, partial-message/interaction restoration and no-duplicate replay are one contract. The underscore event names (`message_start`, `text_delta`, `message_end`) belong only to legacy `/api/chat*` and WebSocket chat compatibility. Update Core events, server writer, browser parser/store, fixtures, integration tests and documentation together.

Detached SSE now selectively replaces only queued complete outer-tool updates and message deltas covered by exact complete checkpoints. Core records explicit length/failed-output evidence and authoritative compaction phase; Web owns copied DTOs, loaded-order Process groups and stable optional disclosures. See [detached streams](./topics/detached-streams.md) for limits and tests; running progress is process-local, not crash-durable.

Session-scoped command notices retain active-run correlation but omit `runId` when the current run is completed/failed/stopped; captured run-bound tool notices retain their original ID. See [the session event contract](./topics/server-api.md#current-event-contract); this does not certify browser notice presentation or full Web queue delivery.

ChatView’s canonical title metadata does not define SSE lifetime: title refresh preserves the subscription, existing notifications read the stored canonical title at dispatch, and session/cwd replacement or unmount retains cancellation. See [Web architecture](./topics/web-app-architecture.md#detached-conversation-flow); this is not full-address SSE or plural queue/attention/progress admission.

### Child-agent delegation

```text
parent AgentRuntime tool loop -> spawn_subagent(profile, task, background)
  -> SubagentService resolves effective global/project profile
  -> concurrency + depth + trust checks
  -> bounded context copied into linked persisted child session
  -> child AgentRuntime with profile model/thinking/tool/skill/extension policy
  -> child journal phase/turn mapped to parent subagent.* events
  -> synchronous result returned to the tool, or background run polled by SubagentPanel
  -> completion/failure/stopped attention -> StatusCenter + open/stop/acknowledge APIs
```

Keep delegation on the shared `AgentRuntime`; a separate provider loop would bypass persistence, trust, hooks and cancellation. Context, history and run registries must remain bounded. A profile with empty allowlists inherits the parent policy; non-empty lists only reduce it. At maximum depth, `spawn_subagent` must be removed from the child tool set.

### MCP configuration, explicit Test, persistent prompt hosting and local mutations

The [native MCP-04 registration contract](../audit/pi/MCP-04.md) adds owner-only extension registration/removal, bounded copied native configuration and loader-owned workspace/trust provenance. Files win even when disabled/invalid. Registry changes retire all session tools/content synchronously before cleanup; replacement connects only on explicit preparation. CLI/RPC/Server inject `registry.mcpServers`; workspace reload retires the old root before rebind. OAuth identity is registration-generation isolated, and terminal/Web management keeps file-only mutations separate from explicit Test/login/logout. Installed declarations/real stdio, emitted CLI modes, HTTP and EN/FR live browsers provide separate evidence; this adds no SDK auto-hosting or foreign compatibility.

The [native MCP-01 contract](../audit/pi/MCP-01.md) maps every pinned configuration/OAuth field to native admission, bounded request-timeout reductions, configured loopback callbacks, metadata overrides and operator-owned CIMD. `mcp list` stays passive; explicit shell/interactive management shares Core and retires changed connections. Real terminal and browser/issuer journeys remain separate from exposure/resource/registration and whole-platform qualification.

The [native MCP-02 exposure/selection contract](../audit/pi/MCP-02.md) preserves missing-field `direct`, script-only/deferred/hidden presentation and final native allowlist/exclusion/read-only authority. Prompt-local MCP descriptors keep executor identity on passive reads but rotate it on remote replacement, preserving nested before-hook admission. Shell/terminal help and EN/FR Web control descriptions expose the same contract; the high-level SDK still has no automatic MCP hosting.

The [native MCP-03 resource/payload contract](../audit/pi/MCP-03.md) adds server-bound read-only resource/list/template helpers, one-page bounded metadata and fresh target/trust checks around cancellable reads. Owned structured JSON/images use existing result and code-mode budgets. Other binary stays process-local under expiring session/connection references, never file paths: RPC `read_mcp_content` is current-session-only and HTTP `GET /api/mcp/content/:sessionId/:id` requires `workspace:read` plus canonical workspace/binding checks. Built Web renders explicit inert downloads; no MCP App runtime or SDK auto-hosting is added. Core resource/content, emitted CLI/RPC, authenticated HTTP and genuine EN/FR browser controls own distinct evidence; broader failures remain under QUA-01.

```text
Settings › MCP -> GET /api/mcp?cwd=<selected workspace>
  -> workspace:read capability + canonical allowed-root directory resolution
  -> Core reads the global <data-dir>/mcp.json as a bounded regular nonsymlink file
  -> Core resolves fresh project trust from trust.json
       |-> effective saved allow: read <cwd>/.ai-harness/mcp.json safely
       `-> no allow/refusal/store error: inspect metadata only; never open the body
  -> JSON/JSONC parse + strict shallow schema and depth/count limits
  -> targetless project entries may override only enabled/exposure/toolExposure of a valid readable same-name global target
  -> reject own target/type ambiguity, forbidden authority fields and orphan bases with value-free typed diagnostics
  -> inherited exact-generation keys bind both parsed sources; runtime/Test/writes share the resolver without flattening targets/secrets
  -> redact command paths/arguments/URL credentials and paths; return names/references only
  -> retain legacy value-free diagnostics; add optional typed invalid-entry reasons, omitted for valid DTOs
  -> render global/project entries, shadowing and trust; localize app codes in EN/FR, never English API text

paste URL/command/install link/JSON -> POST /api/mcp/preview
  -> workspace:read + administrator configuration capability + Origin check
  -> browser sends original text (maximum 256 KiB), syntax mode and optional cwd, never a trusted config object
  -> Core parses at most 20 entries and keeps only recognized AiHarness fields
  -> conservative shell lexer rejects operators, substitutions, shell evaluators and multiple commands
  -> foreign literals are escaped in resolved fields; references are allowed only in env/header/OAuth client-secret values
  -> classify missing fields, literal secrets, available/missing/reserved variable names and remote-value confirmation
  -> derive scope eligibility from redacted inventory plus fresh persisted project trust
       |-> saved effective allow: ordinary project import is eligible
       `-> decision-free fresh folder with bounded safe breadth: require explicit trust-plus-first-write confirmation
  -> return fixed notes and redacted persisted shapes; perform no write, resolution, process, network, OAuth or store access

selected preview + completed fields + explicit confirmations -> POST /api/mcp/actions (import)
  -> browser resends original text, entry index, target name/scope and bounded completion/reference choices, never a normalized config
  -> Core reparses the original paste, reapplies completion, rejects reserved/unsupported references and revalidates the final entry
  -> project rejects every remaining literal secret; global requires literal-secret confirmation
  -> each available host variable sent by header/OAuth requires explicit name-bound confirmation
  -> ordinary project import compares the target revision under the shared lock, rechecks saved trust and appends atomically
  -> confirmed first import into a decision-free fresh folder acquires the trust-store lock, rechecks folder identity/resources/nearest decisions plus root/home/data/known/nested breadth, persists one exact allow, then rechecks under the MCP lock and writes
       |-> write failure: remove only that exact allow
       `-> rollback failure: return typed retained-trust state and force canonical inventory/workspace reload
  -> return only a fresh redacted inventory plus added scope/name; never return the written entry or source literals

valid row Edit -> POST /api/mcp/preview with replacement scope/name/revision -> POST /api/mcp/actions (replace)
  -> browser supplies a complete replacement paste; current hidden values are never loaded into the form
  -> preview excludes only the selected target from same-scope collision checks and remains fully redacted
  -> write resends original text, selected entry and the same bounded choices/confirmations as import
  -> Core reparses and reapplies all import policy, then replaces or renames exactly that valid target under the lock
  -> omitted target fields are removed; siblings and root keys survive; an unchanged entry/name is byte-stable
  -> return only a fresh redacted inventory plus scope/previous-name/new-name

row/group switch, exposure choice or confirmed remove/undo -> POST /api/mcp/actions
  -> workspace:read + administrator configuration capability + Origin check
  -> canonical cwd; project action requires a fresh persisted allow
  -> compare opaque file revision under a bounded inter-process lock
  -> parse current JSON/JSONC; reject malformed, stale, linked or nonregular targets
  -> apply at most 100 unique activation selectors, one direct/codemode/deferred/hidden server-default or exact remote-name / '*' pattern override change, or one removal/restoration
  -> preserve unknown keys, first bounded indentation and LF/CRLF policy
  -> owner-only global mode, existing project mode or 0644 for a new project file
  -> fsync same-directory temporary file + atomic rename + fresh redacted GET inventory
  -> removal body stays in a 60-second/100-record server-only store; browser receives one opaque token

valid row Test -> POST /api/mcp/test with only scope/name/cwd
  -> administrator configuration capability + Origin check + canonical allowed-root cwd
  -> Core rereads that exact entry from disk; project scope requires a fresh persisted allow
  -> configured stdio cwd is canonicalized inside allowed roots and its project trust is checked again
  -> resolve only that entry's runtime env/header values; OAuth client secrets remain untouched because Test never starts OAuth
  -> command-backed values take a single serialized slot; identical concurrent tests join
  -> connect stdio with a filtered child environment or Streamable HTTP with configured headers
  -> bound per-request and whole-test time, pagination/items, stderr/error text and close wait
  -> close on success, failure, deadline and server shutdown; HTTP 401 reports needs-auth without starting OAuth
  -> return only redacted identity/cwd/server info/capability counts/tool summaries/read-only hints/exposure
  -> keep status in server memory only while scope/source/name/config key still match
```

```text
eligible HTTP row OAuth Sign in -> POST /api/mcp/oauth/start with scope/name/configKey/cwd
  -> administrator configuration capability + encrypted-store availability
  -> reread exact config, canonical cwd and persisted trust; derive opaque SHA-256 name/normalized-URL identity
  -> Core joins or creates one detached random-UUID flow with five-minute TTL and bounded registry
  -> bind only 127.0.0.1 /oauth/callback, reuse a registered loopback port when available, otherwise use an ephemeral port
  -> MCP SDK discovery + PKCE + configured client or dynamic registration
  -> poll GET /api/mcp/oauth/flows/:id; open the bounded safe authorization URL
  |-> issuer redirects to the loopback listener
  `-> user pastes the full redirected URL to POST /redirect
       -> exact origin/path/state/code validation; no verifier, client secret or token crosses to Web
  -> reread target before runtime resolution, connection, each encrypted credential write and post-login passive MCP verification
  -> persist one bounded CAS-protected encrypted document; show only stable phase/outcome/failure state

ordinary CLI/RPC/Web MCP connection -> passive Core OAuth provider
  -> use or refresh stored credentials after an HTTP challenge
  -> never publish an authorization URL or begin interactive registration

OAuth cancel/logout -> abort detached work / increment write generation before credential removal
  -> persist a non-secret revocation marker; stale provider-local CAS snapshots cannot restore credentials
  -> close target process-local MCP sessions and abort outstanding passive OAuth fetches
```

Core `mcp/config-inheritance.test.ts`, Server `api/mcp-inheritance-http.test.ts`, CLI `cli/mcp-inheritance-process.test.ts`, genuine packed consumers and `e2e/mcp-inheritance-live.spec.ts` cover fresh persisted trust, forbidden targetless fields/orphan diagnostics, exact dual-source generations, raw atomic project-only controls, real Test with zero tool effects and five public modes. Valid inherited descriptors expose only optional `inheritsGlobal:true`; explicit full targets remain replacements and the default stays direct. Preserve explicit inherited true/direct on writes and raw controls on undo; an explicit local tool map replaces its inherited map. Native browser coverage uses emitted Server/static Web with normal auth/Origin and EN/FR diagnostics, not intercepted inheritance responses.

`POST /api/mcp/oauth/status` is the only credential-status read and returns booleans keyed to the revalidated scope/name/config key. The exact `GET /api/mcp` inventory path bypasses credential initialization and remains a passive file/trust read. OAuth endpoints require the administrator `configuration` capability, never return tokens/client secrets/verifiers, and return `oauth-unavailable` when the master-key-backed store is absent. Callback listeners, remote responses, request time, flow count, redirect length, credential documents and shutdown are bounded. Shared fetch deadlines remain linked through finite OAuth response bodies, including passive refresh during tool calls; cancellation closes a callback listener even when its driver ignores abort. Command-backed initial connections serialize in the host and detached flows serialize per credential identity, not in one process-wide slot. Cancellation and sign-out do not revoke an issuer-side token; operators needing remote revocation must do so at the authorization server.

GET, preview, import, replacement and local actions remain side-effect-free with respect to MCP resolution/transports. The explicit Test action may expand supported values and open one short-lived transport, but never invokes tools or writes credentials. Separately, immediately before an agent prompt, `McpSessionHost` rereads the bounded inventory and each exact target, rechecks persisted trust and configuration identity, closes replaced/disabled connections before replacement, and starts at most 32 enabled servers for that session. Connecting `direct` servers are awaited within the connection deadline; `codemode` and `deferred` servers continue without delaying the prompt and publish no direct definitions. Core adds one synthetic `tool_search` declaration only when an eligible indirect source exists. Its bounded BM25 index covers names, descriptions, schemas and namespaces, waits abortably for indirect metadata only after an explicit search, and activates only selected deferred matches for the next provider turn; codemode matches remain script-only. Activation is recorded on the tool-result message, restored from the active session branch after resume or fork, and re-filtered through current preset, allowlist, exclusions, extension ownership and MCP read-only annotations; a second call in the same provider response remains undeclared and is rejected. Connected tools use deterministic provider-safe names, all normalized collisions receive a stable hash suffix, read-only runs retain only `readOnlyHint` MCP tools, and invocation rechecks the prepared binding, bounds input/output, omits binary payloads and redacts configured/resolved credentials. Unchanged connections survive prompts, failed/disconnected records retry on the next prompt, tool-list notifications refresh future declarations, and an explicit post-prompt idle window plus bounded runtime shutdown closes transports/processes. Stop aborts preparation or discovery before unsafe continuation. CLI interactive/print/JSON, RPC and Server/Web compose the same loadout and Core tool loop; neither dynamic path mutates `ExtensionRegistry`. `ai-harness mcp` remains only a thin management adapter, including explicit master-key-backed `login`/`logout` and exact remote-name / `*` pattern `exposure ... --tool` overrides. Core resolves original remote names exact-first, then the first matching pattern in property order, then the unchanged server default (`direct` if absent); only `*` is special. Web uses current config-keyed Test exposure for inherited display, never a duplicate browser matcher or generated provider namespace. `packages/core/src/mcp/tool-exposure-{patterns,runtime}.test.ts`, `packages/cli/src/cli/mcp-pattern-process.test.ts` and the genuine installed consumer cover bounded matching, real stdio effects and both scopes; `e2e/mcp-exposure.spec.ts` guards canonical display/exact-only writes. The session SDK still has no automatic MCP hosting. Hidden tools are absent from declarations, discovery and nested calls; wholly hidden servers do not connect for prompts unless a non-hidden override makes them eligible. Web bare `/mcp` navigates locally to the focused MCP Settings section. The separate bounded QuickJS helper is implemented through that same selected loadout; discovery never grants execution authority.

### Code mode sandbox

Core's `tools/{codemode,codemode-worker,tool-search}.ts` owns the [QuickJS contract](./topics/codemode.md), independent of MCP discovery. User source executes only inside a disposable QuickJS worker with no ambient Node/files/network/timers. `config/codemode-limits.ts` owns trusted timeout/memory/call/output reductions, unchanged defaults/absolute ceilings and copied per-loadout admission; CLI agent/project files, explicit Core options and administrator HTTP scoped configuration retain the documented native precedence, with no guest option authority. VM/stack/fuel/time/source/input/output/call/concurrency limits and abort propagation bound guest execution; listed guest intrinsic graphs/prototypes, including QuickJS-specific InternalError, are frozen before scripts run, while bridge serialization/native Errors retain captured intrinsics despite global shadowing. Physical worker termination precedes capacity release, and output uses bounded records with one final join/redaction. Core `tools/codemode-intrinsics.test.ts`, actual `cli/codemode-intrinsics-process.test.ts` and genuinely installed public consumers own those additional controls. Nested tools retain their real privileges and current selection/MCP read-only checks, even after a queue wait and after nested before-hooks. Hidden/model-only/recursive/subagent controls cannot be nested. Successful redacted JSON store changes persist only on the active session branch; failure does not undo host effects. Core's credential-private `providers/specialized-models.ts` supplies typed virtual classification/native image SDK methods and guest helpers from the current provider, with live availability, a dedicated cancellable `before:model` hook, request/result/deadline bounds and shared provider network policy. `providers/classification-questions.ts` adds native boolean/choice/finite-score questions over JSON state with validated model-reported (not calibrated) distributions; published vision capabilities feed actual adapter image blocks. `await image(...)` attaches bounded native outer-result images, including Web replay; no Pi ABI/provider breadth or inline terminal protocol is implied. Stable parented nested progress lives only inside the outer active tool/snapshot/result; known usage/cost is accounted once, and the specialized Web card displays cost completeness, omitted calls and plain-text script/output with legacy fallback. CLI/JSON/RPC opt-in and Web Automatic/Always on, on/only and inline-budget settings share the same Core loadout. Server startup caches a sandbox health probe; inventory GET only reads it. Scoped save/readback, visible reasons, budgets, real CLI execution outside the installation, and reviewed Light/Dark desktop/mobile controls have dedicated regressions in `tools/codemode.test.ts`, `api/tool-settings.test.ts`, and `e2e/codemode.spec.ts`.

### Plugin package administration

```text
explicit CLI or POST install/update
  -> shared Core strict npm:/Git HTTPS/path parsing + workspace/scope trust
  -> immutable literal npm selection + fresh declaring-source trust at each npm/Git boundary
  -> npm without lifecycle scripts, or shallow Git clone, in staging
  -> bounded symlink-free manifest/convention inventory + per-kind filters
  -> heartbeat lock + refreshed state + owner-only atomic package/state replacement

CLI package list / GET /api/plugins
  -> workspace-isolated, metadata-only catalogue; never network or install

CLI/RPC startup or interactive /reload
  -> expose enabled package extensions, skills and prompts behind trust
CLI startup / interactive reload
  -> Core metadata-only automatic/settings/package/explicit theme discovery behind trust
  -> select a palette by filename stem or direct path; admit its body separately

POST /api/plugins/reload [sessionId]
  -> resolve in-memory or persisted session and verify its workspace
  -> validate every active visible package into a candidate generation
  -> discover bounded extension files without symlinks
  -> import candidate and atomically replace executable commands/tools/providers/UI/hooks
  -> invalidate separately discovered resource catalogues; rollback the old generation on failure
```

Keep package administration explicit: a read must never install, update, contact npm/Git, or execute code. Core owns source policy, state, filters, inventory, checks/updates and locking; CLI and Server own only command/HTTP presentation and runtime generation composition. State and managed files must roll back together. Project resources stay hidden/inactive until trust, scans never follow symlinks, extension modules are capped at 5 MiB, and diagnostics exclude resource bodies, command output and credentials. On workspace change, a failed Server candidate clears handlers from the old cwd rather than leaking them.

### Extension action hooks

Core `extensions/execution-hooks.ts`, registry and shared tool loop own bounded final text/public top-level result replacement plus ordered turn-end/pre-settlement custom continuations. Runtime/SDK custom starts persist native `custom_message`, never fake user entries. All work retains the existing round budget and host cancellation; authenticated usage/store/activation is not transformable, stale generations cannot publish, and foreign event names/retired registration APIs refuse. See the [native extension/embedding map](./topics/native-extension-contract.md) for per-host UI/import/resource support and actual process/installed/HTTP controls. The explicit SDK still performs no automatic executable/auth/MCP discovery.

### Extension interaction

```text
extension tool/hook -> context.requestInteraction(declarative request)
  -> AgentRuntime admits a bounded ordered request with a host-owned awaitable handle
  -> extensionRequests stores the complete queue; extensionRequest projects its first entry
  -> extension.ui event + optional attention Push
  -> ChatView mounts a local boundary; pending request imports the real declarative form and own CSS
  -> POST response/cancel with active session + request IDs
  -> AgentRuntime revalidates kind, field IDs/types/options and size
  -> suspended extension resumes, or receives cancellation
```

Only an active run may request interaction. Core owns admission, schema replacement, exactly-once settlement and cancellation; Server binds command requesters before awaits and clears them on executable/tool-generation commit or failed-workspace safety retirement. Failed same-cwd candidates and passive reads preserve the current epoch. The Web adapter presents ordered heads/counts with restoration-aware attention; local admission receipts and full-address lifetimes do not imply backend settlement or a general fork-transaction guarantee. See [extensions](./topics/extensions.md) for limits, handles and tests. Keep widget content plain text and custom dialogs schema-driven; never introduce extension-provided React, DOM, script, style or unsanitized HTML. Focus trapping, Escape, restoration and reconnection remain adapter responsibilities. The optional form's nonmodal loading/error keeps chat and Stop available; failed imports remain cached until explicit reload with an unsent-text warning. Its full view tuple retires response transport and late presentation, without undoing an already accepted server response. Same-ID compatible drafts/connected IME survive updates; initial and return focus respect newer intent/modal/view ownership, with coarse editable return allowed only after owned manual editing of the current head. `services/interaction-scope.ts`, `store/run-retirement-filter.ts` and store guards keep bounded negative history and privately witnessed current discovery/reply admission. `e2e/interaction-single-asset-load.spec.ts` tests real production assets and `interaction-live-boundary.spec.ts` tests actual extension/HTTP validation and mock-provider resumption.

### Session persistence

Core `sessions/session-accounting.ts` provides readonly-input `getSessionAccounting` for active ancestry (including pre-compaction work) versus the full journal. `/session`, regular/fullscreen status and RPC reuse it: historic explicit provider/model pricing only, unknown/partial costs, authenticated outer nested usage once, and no progress/user/metadata billing. Context remains a separate effective estimate. Optional copied summary-call provider/model/usage preserves v2, reload and clone behavior without automatic generation. RPC opts into additional scope details with strict boolean `includeAccounting`; default empty-session framing stays unchanged. `/delete` requires an inactive session, and `/switch` numeric selection rejects malformed prefixes. See [sessions](./topics/sessions.md#journal-statistics).

Both CLI and server default to `~/.ai-harness/sessions/<session-id>.jsonl`, so they can share conversations when running as the same OS user. The custom v2 journal retains parent-linked active and abandoned entries; RPC fork moves the active leaf in place, while `--no-session` keeps an equivalent process-local journal. CLI and RPC resolve path-selected sessions first, then `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, and the merged agent/trusted-project setting `sessionDir`; interactive-only `--resume` is rejected in RPC in favor of `--session`. The persisted format remains AiHarness JSONL v2.

Server state under `AI_HARNESS_DATA_DIR` includes independent revisioned `sidebar-state.json` (presentation only, never session journal/leaf authority) and atomic `config.json`, `providers.json`, `usage-metrics.json`, `plugins.json`, `subagents.json` and trust/session files. Explicit restricted single-writer provider rename also retains a bounded private `config.json.provider-intent.json`; pending/unsafe state blocks startup and requires offline reconciliation (see [providers](./topics/providers.md)). An operator-managed `mcp.json` may also live there; its Web surface is bounded and redacted, and admin-only local activation/exposure/removal/restoration uses locked atomic replacement plus server-only undo, but the file may contain literal values that must still be treated as secrets. `trust.json` v2 stores bounded canonical boolean decisions; the nearest ancestor decision applies, explicit refusals override inherited allows, v1 allow-lists migrate on the next mutation, and async reads refresh across CLI/Web processes. `credentials.enc`, `provider-secrets.enc` and `push.enc` exist only when `AI_HARNESS_MASTER_KEY` enables encrypted persistence. Built-in provider and name/normalized-URL-isolated MCP OAuth state share the bounded Core `credentials.enc` store under disjoint opaque keys; MCP tokens, refresh tokens, dynamic-client secrets and PKCE verifiers never enter browser state. Built-in login/API-key, MCP OAuth and custom-provider secret mutations refuse success without the applicable durable store; environment/command/explicit CLI credentials may remain process-local, while Push subscriptions remain volatile. Never put secrets into the non-secret JSON stores, fixtures, API status objects or browser persistence.

Use `SessionManager` for domain operations, `JsonlSessionStore` for storage behavior, and `serializeSession`/`deserializeSession` at JSON boundaries. Avoid direct mutation of manager internals. Every write is asynchronous and should be awaited before reporting success. Session IDs are capped at 256 bytes, files at 64 MiB and inventory at 10,000 entries; files are stable UTF-8 regular files with one link under a private symlink-free directory. Cooperating append/save/delete operations share a bounded heartbeat lock, rewrites use `fsync` plus atomic rename, and loaded legacy data is rewritten after credential redaction. A clone is an independent root (`metadata.clonedFromSessionId`); RPC in-place fork retains descendants in one journal, while startup/copy forks keep related-session lineage.

Branch-relative `context_edit` entries change only future model projection, never transcript or accounting. Private post-hook `loadout` field deltas and complete compaction checkpoints reconstruct historical prompts/tools through branches, copies and restart without granting execution authority. Core/SDK/RPC own bounded editing; ordinary CLI/RPC/SDK/HTTP turns share loadout recording. Output-only compaction overrides/veto conserve source/cut/accounting and admitted-write ownership. Local journals remain private; browser DTOs and ordinary RPC tree nodes omit prompt/schema/checkpoint bodies. See [session context state](./topics/session-context-state.md) for native format/downgrade limits, file-path provenance and scenario coverage.

## 5. Cross-Package Change Guides

### Add or change a provider

Review all of the following, not only the core implementation:

1. `core/src/types/index.ts`: provider/config/model metadata, capabilities, compatibility and pricing contracts.
2. `core/src/providers/{index,provider-network,credentials,model-metadata,model-catalog}.ts` and `core/src/security/credential-store.ts`: implementation, bounded payloads/streams, proxy/deadline/retry and WebSocket policy, credential/redaction/storage contracts, discovery, catalogue assembly/resolution, defaults, reasoning/tools and usage normalization.
3. `core/src/index.ts`: public exports.
4. `cli/src/{commands/handler,providers/configured-providers,providers/provider-runtime,cli/model-list}.ts` and `rpc/rpc-server.ts`: environment/command/encrypted credentials, startup/listing, network settings, interactive and headless support.
5. `server/src/api/proxy.ts`: built-ins/adapters, usage persistence and all non-agent provider call paths.
6. `server/src/runtime/{model-catalog,provider-registry,provider-oauth}.ts` plus matching routes: custom lifecycle, secrets, discovery and OAuth.
7. `web/src/store/session-store.ts`, `services/api.ts` and `components/{SettingsView,EcosystemSettings}.tsx`: catalogue/defaults/admin UI.
8. Provider/Core/server/Web tests, intercepted API fixtures, Settings/axe/visual journeys and user/architecture documentation.

Do not assume every surface supports every provider automatically, but do not duplicate Core network or credential policy in a product adapter. Never expose access tokens/API keys. `providerApiKeyCommands` is operator-owned executable configuration: run it only through the bounded Core resolver, retain stdout only in process memory and register it with the shared redactor. Treat every remote model catalogue, JSON body, SSE event and WebSocket event as untrusted bounded input.

### Change messages, sessions, or JSONL entries

Update the shared type, JSONL reader/writer/append methods, `SessionManager`, CLI import/export, server serializers and routes, Web API/store hydration, and all fixtures. Explicitly test old persisted data when compatibility matters. Remember that JSON transports dates as strings while core uses `Date`.

### Add or change a CLI command

For conversational commands, update registry/tests in `commands/handler.*`, dispatch/completion in `cli/src/index.ts` and both TUI help surfaces. Standalone before-startup operations instead own strict parsers/help/process tests in `cli/src/cli/` and early dispatch in `index.ts`; preserve exact installed root-help equality and package/MCP behavior. Document user-visible commands in both `docs/users/{en,fr}/user-guide.md` and owning guides/navigation.

### Add or change an HTTP or streaming contract

Update `server/src/index.ts` or `server/src/api/proxy.ts`, the matching `web/src/services/api.ts` function, consuming store/component code, server tests, browser API tests, and documentation. Verify HTTP status, auth behavior, malformed input, transport framing, and serialization. Add live server integration coverage when Playwright's mocked API cannot prove the behavior.

### Change extensions, skills, prompts, or plugin packages

Shared extension contracts and the bounded module loader belong in `core/src/extensions`; shared package source validation, state, filters, locking, installation, checks and inventory belong in `core/src/plugins`. CLI orchestration belongs in `cli/src/{extensions,resources,security,cli/package-command.ts}`. Server package code must remain a thin API/runtime-composition adapter over Core; do not fork an installer or state schema there. Browser UI must stay declarative/text-only: never move command execution, arbitrary HTML/DOM or filesystem paths there. Preserve managed ownership, unload cleanup, response validation and atomic rollback. Project code/resources remain blocked until trusted, reads stay side-effect free, and skill downloads require bounded HTTPS plus SHA-256. Update `docs/contributors/{en,fr}/extensions-cli.md`, relevant Web contributor docs, and the bilingual resource/package user-guide sections.

### Change startup, packaging, native dependencies, or static assets

Check root scripts, package scripts, both `copy-assets.mjs` files, `web-cli.ts`, production Docker stages, native build/runtime libraries, executable permissions, and the relative location of `packages/web/dist`. `node-pty` requires its install script plus Python/C++ build tooling in dependency stages and compatible runtime libraries in the production image. Validate with a production image, not only TypeScript tests.

## 6. Coding and Contract Conventions

- TypeScript is strict and enables unused-symbol and implicit-return checks.
- Source is ESM (`"type": "module"`). Relative TypeScript imports use `.js` specifiers so emitted JavaScript resolves correctly.
- Use `import type` for type-only dependencies when practical.
- Keep public core APIs exported through `packages/core/src/index.ts`.
- Prefer shared typed contracts over duplicated ad hoc shapes, but do not expose server- or React-specific concerns from `core`.
- Keep implementation tests next to source as `*.test.ts` or `*.test.tsx`. Cross-package public-contract probes are the deliberate exception under `tests/functional-parity/`; the root Vitest config remains the canonical all-package configuration.
- Mock network calls in unit tests. Provider tests must not depend on real credentials or external services.
- Preserve streaming semantics: chunks are incremental, final content is assembled once, and errors must terminate cleanly without double completion.
- Treat session IDs and request input as untrusted at HTTP, RPC, import, and extension boundaries.
- Escape content rendered into standalone HTML or share pages. React-rendered text should remain text unless it has been deliberately sanitized.
- Never expose provider credentials in API responses, logs, session files, browser local storage, or error text.
- `AI_HARNESS_AUTH_TOKEN` protects API access; a distinct `AI_HARNESS_ADMIN_TOKEN` separates dangerous capabilities, but otherwise falls back to the auth token. Browser login creates an opaque HttpOnly cookie; `AI_HARNESS_MASTER_KEY` enables encrypted built-in/custom provider credentials and Push subscriptions.
- Resolve every file, command, Git and agent cwd through `WorkspaceManager`, then require `ProjectTrustManager` before execution. Never use a browser-supplied path directly.
- Bind to loopback by default. The server rejects a non-loopback bind without authentication unless the explicit insecure override is set; production still requires a trusted HTTPS reverse proxy or private network.

Formatting is defined by `.editorconfig` and `.prettierrc.json`. Avoid broad formatting passes during focused work, especially in a dirty working tree.
## 7. Documentation Status and Authority

| Surface | Language | Audience | Versioning | Status and intended use |
|---|---|---|---|---|
| `docs/ai/index.md`, `project-map.md`, `AGENTS.md` | English | Agents | Versioned | Navigation, repository authority, and maintenance rules |
| `docs/ai/topics/providers.md` | English | Agents | Versioned | Provider execution, catalogue, registry and OAuth |
| `docs/ai/topics/provider-matrix.md` | English | Agents | Versioned | Pinned factory/API/auth inventory, installed catalogue provenance, native configuration map and detached numeric host composition |
| `docs/ai/topics/model-dispatch-policies.md` | English | Agents | Versioned | Virtual selection/physical dispatch, direct summary routing, branch state, billable cache policy/usage, page/branch-owned historical notices and independent global Web visibility |
| `docs/ai/topics/sessions.md` | English | Agents | Versioned | JSONL v2, serialization, compaction, pagination and branches |
| `docs/ai/topics/session-context-state.md` | English | Agents | Versioned | Branch-relative context edits, private post-hook loadout deltas/checkpoints, final-output compaction hooks and native SES scenario map |
| `docs/ai/topics/session-sdk.md` | English | Agents | Versioned | High-level Core SDK ownership, lifecycle, safe copies and genuine public package/declaration proof |
| `docs/ai/topics/run-lifecycle.md` | English | Agents | Versioned | Native RUN-01 admission, cancellation acknowledgement, durable settlement and physical limits across hosts |
| `docs/ai/topics/extensions.md` | English | Agents | Versioned | JavaScript/TypeScript extensions, packages, reload and declarative interactions |
| `docs/ai/topics/native-extension-contract.md` | English | Agents | Versioned | Native EXT host/import/event/result/UI/package/SDK adaptation map, typed triggers and bounded action hooks |
| `docs/ai/topics/codemode.md` | English | Agents | Versioned | QuickJS isolation, budgets, nested authorization, branch store, settings and explicit limitations |
| `docs/ai/topics/cli-reference.md` | English | Agents | Versioned | Package/auth/export standalone commands, regular/fullscreen/print CLI, JSON events and JSONL RPC |
| `docs/ai/topics/cli-invocation-contract.md` | English | Agents | Versioned | CLI-01 v1 pinned Pi/native option mapping, input/channel/exit policy and emitted/installed cancellation acceptance |
| `docs/ai/topics/terminal-contract.md` | English | Agents | Versioned | Native terminal capability/action/settings map, bounded paste/multiline/Unicode/undo and actual PTY/installed boundaries |
| `docs/ai/topics/themes.md` | English | Agents | Versioned | Bounded passive theme sources, CLI precedence/suppression/reload and actual palette identity |
| `docs/ai/topics/editor-schemas.md` | English | Agents | Versioned | Owned native editor data, actual installed schema assets and independent runtime-authority limits |
| `docs/ai/topics/server-api.md` | English | Agents | Versioned | REST, SSE, WebSocket and detached runtime contracts |
| `docs/ai/topics/web-app-architecture.md` | English | Agents | Versioned | React stores/components, bounded live reading/reconnect and view retirement, browser persistence, PWA and native browser validation |
| `docs/ai/topics/detached-streams.md` | English | Agents | Versioned | Selective buffered delivery, reply/phase evidence, owned DTOs and optional process reconstruction |
| `docs/ai/topics/static-demo.md` | English | Agents | Versioned | Independent synthetic static demo, base-safe offline artifact, publication limits and Pages policy |
| `docs/ai/topics/linked-directories.md` | English | Agents | Versioned | Metadata-only inventory, exact read consent, independent trust and optional modal lifetime |
| `docs/ai/topics/security.md` | English | Agents | Versioned | Workspace trust, auth, secrets and executable-code boundaries |
| `docs/ai/topics/native-security-contract.md` | English | Agents | Versioned | Native field/resource and instruction precedence, fresh tool trust, credential lifecycle/export policy and trusted-proxy admission |
| `docs/ai/topics/child-agents.md` | English | Agents | Versioned | Native profiles/policy, settlement limits, linked journals, lazy scoped Web controls and [WEB-06 qualification](../audit/pi/WEB-06.md) |
| `docs/ai/acceptance/`, `docs/ai/workflows/` | English | Agents | Versioned | Acceptance criteria and task-specific documentation workflows |
| `docs/audit/documentation/AUDIT-1` | English | Agents + humans | Versioned | Current documentation audit; plain path intentionally omits `.md` |
| `docs/audit/pi/AUDIT-5` | English | Agents + humans | Versioned | Sole active Pi 1.2.0 / Pi Web 0.12.2 comparison: 43 stable criteria, compatibility decisions, source/coverage register and prioritized work packages; static baseline, not runtime certification |
| `docs/users/{fr,en}/` | French/English | End users/operators | Versioned | User guides, operator runbooks, container guidance and language indexes |
| `docs/contributors/{fr,en}/` | French/English | Contributors | Versioned | Parallel architecture decisions, extension, session SDK, public-contract/parity and i18n guides |
| `docs/screenshots/` | English/French | Humans | Versioned | Playwright-derived documented product states and capture inventory |
| `README.md`, `CHANGELOG.md` | English/French | Everyone | Versioned | Product overview and history; changelog planning notes are not a roadmap |

Load human-facing files only when the user explicitly requests their audit or maintenance. The current documentation audit is `DONE`; reopen it only when a criterion regresses or a recorded re-examination trigger occurs.

For parity work, select one criterion and a bounded task from `docs/audit/pi/AUDIT-5`; reuse its source/coverage register and state the precise missing acceptance before adding tests. Resolve the affected compatibility/security decisions before changing native contracts. Keep task delivery, whole-criterion closure and global qualification separate. Earlier reports and acceptance files were deleted in the observed working tree: do not restore them or reuse their closure counts implicitly. No old count-based mandate or automatic full-suite rerun is revived by this static baseline.

The operator runbook ([EN](../users/en/operations.md)/[FR](../users/fr/operations.md)) covers host preparation, MCP/code mode, files/access, sessions, models/tools/settings, reload and incident recovery. The architecture decisions ([EN](../contributors/en/architecture-decisions.md)/[FR](../contributors/fr/architecture-decisions.md)) map those contracts to source/tests and explicit limits. They document implemented behavior, not missing feature or deployment acceptance.

Authority for behavior, from strongest to weakest:

1. Executable code and tests.
2. Package/root configuration and Dockerfiles.
3. This map for navigation and required workflow.
4. Feature documentation and README examples.
5. Changelog planning notes.

When code and documentation disagree, verify the behavior against source/tests and fix the owning document; do not encode the discrepancy here as if it were intended behavior.

## 8. Validation

### Required environment

The test Dockerfile pins supported Node 24.15.0 LTS with npm 12.1.0. Retain earlier Node 26 signal exits (including `pure virtual method called` / SIGABRT) as failed runtime evidence; an LTS run is not a causal diagnosis of all historical crashes. Do not loosen product budgets/assertions or retry a failed case to hide a worker exit.

Freeze every build-context input before qualification, including nested package documentation: `.dockerignore` excludes `docs/` and root Markdown, but `packages/core/src/sdk/README.md` still changes image identity. Hash included documentation separately from linted code; do not assume every documentary edit is outside the image. The shared context policy excludes checkout `.git` metadata, including worktree pointer files; `.docker/test-build.test.mjs` uses `lstat` to reject an accidentally copied directory, file or symlink. `.github` workflows and runtime-created Git fixtures remain eligible. Earlier images copied `.git`, so staging excluded documents changed their context; preserve those historical qualification limits rather than retrospectively treating their product-file hashes as proof of full-context identity.

The test image builds Core, CLI, Server and the real Web bundle before Vitest starts: subprocess tests consume their emitted JavaScript independently of Vitest's TypeScript aliases, and emitted Server recovery tests require the genuine static bundle even without a browser. `.docker/test-build.test.mjs` runs during the image build to check emitted entries/declarations, the nonempty Web index, executable modes and real CLI help outside the checkout. Workspace builds/typechecks and the parity typecheck use `scripts/run-typescript.mjs`; Web builds use `packages/web/scripts/build.mjs`. Both launch their tools with explicit `--no-maglev` after native compiler/build exits were observed on Node 24.15.0 (including a TypeScript crash reproduced under Maglev stress). This is a scoped toolchain mitigation, not a causal diagnosis of every historical native failure; application runtime flags, sandbox budgets and assertions stay unchanged. `.dockerignore` retains only this required root script, and build-time controls verify flag/argument forwarding plus fail-fast, no-retry termination evidence. Root Vitest serializes CI test files because executable tests already spawn Node children; preserve existing case deadlines and assertions rather than increasing them to mask cross-file CPU contention. The private `tests/functional-parity/installed-process.ts` runner retains exact captured channels/legacy result shape and emits only code/signal to the test runner's diagnostic log on native termination; independent real-process controls live in `installed-process.test.ts`. Earlier reports that discarded signals remain undiagnosed.

The `Makefile` explicitly requires tests and type checks to run in Docker. Do not run `npm test`, Vitest, Playwright, or TypeScript validation directly on the host. Preferred commands:

```bash
make lint-docs       # Validate local Markdown targets, anchors and versioning boundaries
make typecheck       # Build the test image and run workspace TypeScript checks
make test            # Build the test image and run all root Vitest tests
make test-parity     # Run focused public CLI/JSON/RPC/session/extension/SDK golden probes
make test-e2e        # Build the test image and run Playwright with Chromium
make test-coverage   # Optional full coverage run
make build-prod      # Build the complete production image
```

Use `make lockfile` after an intentional dependency or package metadata change; it regenerates `package-lock.json` in Docker.

The independent static demo has its own Docker target: `bash demo/run-docker.sh`, optionally with `DEMO_BASE=/` or `DEMO_BASE=/preview/AiHarness/`. It validates types, fixture/build/export policy, bounded static artifacts, eight Chromium journeys and 28 captures without starting the agent/backend. It publishes only validated generated `demo/dist/`; explicit updates export bounded screenshot deltas. See [static-demo.md](./topics/static-demo.md) for offline/deployment boundaries; local validation never enables Pages or deploys remotely.

`make test-e2e` delegates to `npm run test:e2e`: `.docker/e2e-suites.mjs` builds the product, then runs all nine whole-file configurations serially with one worker and zero retries. Development discovery excludes only files that the runner explicitly executes under their owning preview/static hosts; `.docker/e2e-suites.test.mjs` guards that ownership and the container entry/preparation inputs. `.dockerignore` explicitly retains the runner, declarations, controls and test Dockerfile; the test-image build executes these controls after `COPY . .`, so validation observes the filtered build context rather than relying on a later source overlay. `e2e/interaction-queue.config.ts` includes the complete queue/admission/asset matrix. Independent artifacts use `test-results/<suite>` and `playwright-report/<suite>`; any failed suite keeps the overall command nonzero while remaining siblings still run. Demo policy/type tests precede rebuilding the selected `DEMO_BASE`. Browser CLI execution explicitly uses `node --no-maglev`; this is not a diagnosis of historical default-engine crashes.

GitHub Actions runs four independent E2E jobs with `make test-e2e E2E_ARGS='--ci-partition=N/4'` (N = 1–4). Each job builds its own image and owns its checkout, container, servers, data and quotas; do not run concurrent Make E2E targets in a shared checkout. The standard fully-parallel configuration is divided with Playwright `--shard=N/4`, while dedicated configurations remain whole: partition 1 owns interactions; 2 linked/pane; 3 locale/workspace/title; 4 progress/demo. The dispatcher still enforces one worker and zero retries inside each job, rejects filtering/ownership overrides in partition mode, and keeps local no-argument execution complete. CI uses `fail-fast: false`, unique uploaded artifacts and an aggregate success gate requiring every job to succeed. Reports live under `playwright-report/partition-N/<suite>` and `test-results/partition-N/<suite>`; `test-results/e2e-suites.json` records the partition and standard shard. Real child-command results additionally preserve raw `code`/`signal` and a bounded `spawnErrorCode` when spawning fails; the aggregate remains numeric/nonzero on failure. Native termination is logged without command arguments, paths, environment or native error messages. A later receipt cannot retroactively diagnose a historical report that omitted the signal. `.docker/e2e-suites.test.mjs` checks matrix/dispatcher agreement and exact dedicated-suite ownership. Parallel wall time depends on runner availability and suite duration; a local partition discovery is not a measured remote speedup.

Application cases reserve real protected-read/auth quota from response headers through `e2e/fixtures/test-budget.ts`; disposable-host journeys pass their actual base URL to the same reservation helper. Production rate limits and assertion waits are unchanged, and an in-case 429 is not retried. Visual relative dates are fixed without stopping timers. Static demo cases keep their separate fixture.

For a focused Playwright test during iteration, pass arguments through the Makefile, for example `make test-e2e E2E_ARGS='e2e/performance.spec.ts -g "virtualise" --retries=0'`. The E2E container receives a 1 GiB shared-memory ceiling by default to prevent Chromium worker crashes; override `E2E_DOCKER_ARGS` only for a runner-specific need. Use `make test-parity` for the focused public-contract harness. For other focused Vitest work, use `make shell` and run the relevant npm command inside that container. Final validation should still use the standard targets below.

### Validation matrix

| Changed area | Minimum validation |
|---|---|
| Documentation only | Check claims/commands against source; run `make lint-docs` and `git diff --check` |
| Core types/providers/sessions/extensions | `make typecheck` and `make test` |
| CLI behavior/TUI/RPC/resources/security | `make typecheck`, `make test-parity`, and `make test` |
| Server/API/auth/credentials/WebSocket | `make typecheck` and `make test` |
| React components/store/API client/CSS | `make typecheck`, `make test`, and `make test-e2e` |
| Cross-package streaming or session flow | `make typecheck`, `make test`, and `make test-e2e` |
| Launcher, build scripts, dependencies, Docker, static asset serving | Relevant tests plus `make build-prod` |

Playwright starts Vite and a disposable real Express server. Most scenarios still isolate the browser with `e2e/fixtures/mock-api.ts`; `e2e/live-server.spec.ts` is the deliberate browser-to-server smoke path. Visual changes use Docker-generated Light/Dark desktop/tablet/mobile baselines under `e2e/*-snapshots/` with a 2 % pixel-diff ceiling. After reviewing changed baselines, `make sync-doc-screenshots` refreshes the subset embedded in human documentation. `make test-e2e` tests the baselines embedded in its freshly built image, retains the container until completion, then copies the HTML report, test artifacts and only added or byte-changed snapshot files back with `docker cp`, even after failure; unchanged source baselines are not copied, so concurrent cleanup cannot overwrite another run's newly generated images. The collector rejects linked artifacts and bounds count, depth and byte sizes; validate it in the test image with `node --test .docker/baseline-artifacts.test.mjs`. The test image adds CJK glyphs while `.docker/test-fonts.conf` preserves historical generic Latin/emoji fallbacks; validate these with `node --test .docker/test-fonts.test.mjs`, without restyling unrelated baselines. This avoids stale bind mounts in nested Docker environments and lets `E2E_ARGS='e2e/visual.spec.ts --update-snapshots=all'` update the working tree. Keep focused server tests for exhaustive auth, malformed input, credential and persistence behavior. A production Web build also runs `packages/web/scripts/check-bundle-budget.mjs`; a size regression above its eager, async or CSS limits is a build failure.

### Before finishing

1. Review `git diff -- <files-you-changed>` and `git diff --check`.
2. Confirm no unrelated user changes or generated files were modified.
3. Run the validation required by the matrix, or state clearly which commands could not run and why.
4. Summarize changed files, behavioral impact, and validation results.
