# Extensions and Plugin Packages

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

JavaScript and TypeScript extensions register commands, tools, providers, plain-text terminal UI components, lifecycle listeners, and cancellable `before:*` hooks. CLI and Server share the bounded Core loader but own discovery context, trust checks, and runtime composition.

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
| `packages/core/src/extensions/builtin-extensions.ts` | Bounded immutable optional-capability policy for CLI/RPC; no imports or trust grants |
| `packages/core/src/extensions/{module-loader,module-manifest,native-module-alias,extension-selectors,module-format,typescript-module}.ts` | Shared executable formats, bounded literal main/suffix resolution and pre-import selection, descriptor-admitted TypeScript evaluation and atomic managed generations |
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

Core owns at most 16 pending requests per run, 128,000 UTF-8 JSON bytes per normalized request and 512,000 aggregate bytes. Oversized admission/update throws `409 EXTENSION_INTERACTION_QUEUE_FULL` without changing prior state. A supplied timeout must be finite, nonnegative and at most 2,147,483,647 ms; otherwise `400 INVALID_EXTENSION_INTERACTION_TIMEOUT`. No active run returns a cancelled Promise. Responses validate the latest schema and settle once; late controls return false. `extensionRequests` is the complete ordered reconnect snapshot; `extensionRequest` remains its first-entry compatibility projection. The Web adapter reads the complete ordered queue (explicit empty plural wins over the compatibility alias), presents its head and waiting count, and suppresses restored attention replay. Client admission remains separate from exactly-once Core settlement and backend cancellation.

Session-scoped extension-command `notify` uses `AgentRuntime.publishSessionEvent`: notices omit `runId` when the current session run is `completed`, `failed` or `stopped`, while nonterminal correlation is retained. Run-bound tool-context `notify` callbacks retain their original run ID after termination. This changes event correlation only, not interaction admission or browser queue/notice acceptance; see [the session event contract](./server-api.md#current-event-contract).

### Session state and active ancestry

Commands/tools receive the actual public `SessionManager`; capture `currentSessionId` before awaits. Core owns `appendCustomEntry`, `appendCustomMessage`, explicit navigation, compaction and related/independent copies. Private own JSON/details stay outside model context; custom content is model-visible even with `display:false`. Exact custom types are conventions, not ownership or a sandbox.

`getActiveBranchEntries(id)` serializes with manager mutations, returns an owned parent-first path including pre-compaction state, ignores summary-source provenance/abandoned branches and refuses incomplete ancestry or host store/leaf replacement during its read. Last append projection wins per ID; clocks do not choose parents. It is not raw history, model context, cross-process CAS or an atomic read-modify-write helper. Related forks preserve selected stable IDs/custom state; clones remap internal IDs, using the same bounded1,024-extra-entry copy path. Arbitrary payload IDs and exhaustive lifecycle hooks are separate.

Interactive `/reload` refreshes executable factories, not the journal; restore closure state from the selected path. Failed candidates retain/restore the previous generation without undoing privileged Node effects. RPC executable generations still require restart; scoped context-settings reload does not grant executable authority. Durable private state survives restart; memory-only state does not. Hosts retain foreground admission, especially for navigation/copies during active model/tool work. The high-level facade adds no custom/active-path method. See the [EN](../../contributors/en/extensions-cli.md#session-state-context-and-generations) / [FR](../../contributors/fr/extensions-cli.md) contract and Core `sessions/session-active-entries.test.ts`, CLI `cli/extension-session-state-process.test.ts` and installed public consumers.

### RPC UI adapter

RPC additionally supplies optional `context.ui` with immutable mode/capabilities and plain-text status/widget/title/editor intents. The bounded adapter issues same-ID request update/close capabilities, validates current-schema replies, preserves the original host signal/deadline and exposes explicit `get_extension_ui` replay without repeating notifications. Abort/session replacement and EOF/signals retire dialogs before command waits; closed bridges reject later admission. This is process-local state, not a custom-component/terminal renderer or cross-process durability. See [EN](../../contributors/en/rpc-extension-ui.md) / [FR](../../contributors/fr/rpc-extension-ui.md) for wire records and limits. This RPC delivery does not close broader interactive or Web extension UI behavior.

## Critical Flows

### Load or reload executable modules

1. Discover explicit/global files and trusted project files without following symlinks.
2. Refuse ordinary path/directory overflow (200 paths, 1,000 entries per directory); retain stable nonlinked, single-link, at-most-5-MiB modules. Apply ordered global/trusted-project CLI settings via additive Core `selectors`: unmarked glob expansion, exact `+path`, exact/subtree `-path`, and `!glob` filtering of actual discovered files. Core `paths` stays literal; containment includes filesystem roots. `ExtensionModuleSelector` retains literal declaring directories through `{ pattern, baseDir }` (absolute base), so directory metacharacters never become wildcard authority; an absolute pattern under that base is first made relative to it. String entries use the loader cwd with the same absolute-under-base rule. Outside-base patterns and nested wildcard segments retain explicit glob semantics; no filesystem probe guesses a literal prefix. Nonempty selection is bounded to 200 selectors/32 KiB each (combined pattern/base for scoped entries) and 1,000 candidates at any step; glob scans share 10,000 entry visits, 256 directory visits and eight descendant levels. Overflow fails the generation, never imports an arbitrary prefix. Nonrecursive patterns avoid deeper traversal.
3. Import every selected candidate for the next generation; excluded entry bodies are not imported by discovery. Selected Node code may still import them as dependencies; this is not a sandbox.
4. Atomically replace loader-owned registrations.
5. On any discovery/import/registration error, keep or restore the previous generation.
6. On workspace change, clear old handlers if the new candidate cannot commit.

CLI startup loads one trusted generation before strict contributed-option parsing and reuses it in interactive, print, JSON and RPC modes. Ordinary startup and reload retain the independently eligible configured agent-directory location rather than reverting to the home default; callbacks reread ordered selectors on reload. Built-in help/version never import extensions; `--help-extensions` and `--completion` are explicit trust-gated operations. Reload gives ESM and CommonJS entries a fresh identity after successful or failed attempts, without replacing preexisting CommonJS cache entries. Native JavaScript dependencies retain ordinary caches; executable side effects are not transactional. Transformed TypeScript dependencies use the separate private evaluation graph described below. See the [EN startup-option contract](../../contributors/en/extension-startup-options.md) and [FR contract](../../contributors/fr/extension-startup-options.md).

### TypeScript entry evaluation

Core admits `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts` and `.tsx` entries; `.d.ts`, `.d.mts` and `.d.cts` are declarations, never factories. Package inventory, standalone listing and enabled-file selection share this format predicate. Child index lookup preserves existing JavaScript priority (`index.mjs`, `.js`, `.cjs`) before `.ts`, `.mts`, `.cts`, `.tsx`. Distinct source/compiled entry paths remain distinct: select one explicitly rather than autoloading duplicate implementations.

Pinned lazy runtime `jiti` evaluates the **already opened descriptor's source**, not a reopened entry pathname, with native entry loading and filesystem/global module caches disabled. Existing before/open/after identity, size, link, trust and generation checks remain. Each typed entry has a private transformed dependency cache; reload creates a new graph, including after failed attempts. Ordinary native dependencies keep Node caching. Relative/extensionless and late imports work; the exact `@ai-harness/core` root resolves to the host's actual public namespace without another package instance. CommonJS exports, enums, parameter properties and classic JSX are supported; JSX is syntax support, not React/Web UI hosting.

This is transpile-only, not type checking. No implicit `tsconfig` path aliases are loaded, and entry checks do not sandbox dependency imports or Node effects. Parser/evaluation failures return `TypeScript extension evaluation failed.` without source/code frames. CLI ordinary/contributed startup, all headless modes and PTY reload use this path; actual emitted Server HTTP reload/tool execution conserves trust, same-cwd failure retention and failed-workspace retirement. Directory manifests use the bounded literal resolution below; native JavaScript now shares the exact public Core root identity through its own cache-conserving adapter.

### Native JavaScript host identity

Admitted `.js`/`.mjs`/`.cjs` entries and their native file dependencies resolve the exact `@ai-harness/core` root to the actual host namespace, including static, late and cleanup imports. This is not an alias for private subpaths, CLI/Server packages or third-party UI libraries. Native entry format/filename/descriptor checks remain unchanged; JavaScript is not passed through the TypeScript transpiler.

`native-module-alias.ts` owns a contextual Node resolve hook and a scoped CommonJS `Module.prototype.require` adapter. The latter is necessary because Node's same-directory CJS cache can bypass resolve hooks; owned Core requests bypass that cache without deleting/replacing it. Other require calls delegate normally, including preexisting virtual adapters. Hooks/adapters retire with their final owner; a newer foreign require wrapper is never overwritten, and a retained delegate is inert without owned contexts. Unrelated importers retain their own Core installation.

Pending imports hold temporary leases through whole-candidate registration/refusal. Wrapped factories own active leases through awaited user cleanup, including throwing cleanup and direct registry unload. Failed registration restores preceding factory leases. Bounded URL-only dependency edges survive retirement because Node's native modules do; cached CJS children are adopted without mutation. Already-created native exports, caches and privileged effects are not refreshed or revoked by this bookkeeping. Alias context is module identity, not a sandbox or execution permission.

Limits: 1,000 URLs per native graph / 32 KiB per URL; 10,000 active resolver contexts / 20,000 ownership associations; retained process-lifetime metadata of 10,000 parent URLs / 20,000 dependency edges / 16 MiB edge bytes. Cached CJS traversal also bounds nodes and per-node children to 1,000. Overflow fails with `Extension module resolution exceeds its limits.`. Restart clears retained metadata; no Node cache deletion is performed. Literal main/suffix entry selection is separate from this native dependency cache adapter. Exports-only directories and recursively interpreted extension manifests are not entry-resolution rules in the inspected reference loader.

### Directory manifests

Automatic child directories and explicit/environment/settings directory paths may declare exact entries in `package.json` under `aiHarness.extensions` or legacy `pi.extensions`. Native fields override legacy fields individually. An absent extensions field preserves ordinary shallow/index discovery; `[]` explicitly selects nothing. A declared list replaces sibling/index autodiscovery for that directory, while normal outer settings selectors may still remove or explicitly add files. Entries are literal directory-relative paths (portable backslash separators included), not globs/selector operators; metacharacters in declaring directories and filenames stay literal. Installed package resource-pattern semantics are unchanged.

An entry may name a supported file, a missing file request with the suffix fallbacks below, or a module directory. A declared module directory uses its stable `package.json` `main` before a supported index; absent `main` preserves JavaScript-first index priority. Only literal confined descendants are allowed, with at most eight main indirections. Malformed/escaping/self main values never fall back to an index. Nested extension arrays and exports-only directory maps are not reinterpreted. Declarations/non-executable regular files remain ignored as direct declarations; an unresolved, unsafe or nonexecutable main target fails the generation, never imports a prefix or fallback siblings.

Core holds a stable directory and manifest descriptor, compares open/read/path identities, decodes bounded fatal UTF-8 and never executes metadata. Caps: 256 KiB per manifest, 100 exact entries per manifest, 32 KiB per string; one discovery operation shares 200 manifest reads, 4 MiB metadata bytes and 1,000 declared-entry visits across ordinary paths and selectors. Duplicate paths still deduplicate before import; repeated metadata work counts toward bounds. Invalid/mutating metadata returns fixed `Extension manifest is invalid or exceeds its limits.` without quoting source. Failure retains the preceding managed generation; Server workspace retirement still clears prior handlers.

### Literal module requests

A missing explicit/environment/literal-selector or manifest file request without a suffix tries `.mjs`, `.js`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`, in that order. A missing output filename maps only `.js` → `.ts`, `.mjs` → `.mts`, `.cjs` → `.cts`, or `.jsx` → `.tsx`. An existing exact file wins; a safe nonexecutable/declaration file is ignored without selecting a sibling. A physical `.jsx` entry is still outside the executable-format whitelist. Deduplication and exclusions use **resolved actual file paths**, not request aliases. Installed-package resource globs keep their existing actual-file semantics.

Automatic discovery roots remain directories. CLI ordinary/contributed/RPC and Server mark their configured automatic directory paths with a trailing platform separator; Core and exact selectors preserve that directory intent before normalizing paths. A missing `extensions/` must never activate adjacent `extensions.ts`, and `-e ./review.ts/` must not evaluate a file. A bare ordinary directory without resource declarations retains shallow/index discovery; its `main` is not an automatic resource selector. Main resolution applies to **declared module directory targets**.

Example: a discovery directory declares `{"aiHarness":{"extensions":["module"]}}`; `module/package.json` may specify `{"main":"src/review.js"}` backed by `module/src/review.ts`. The shared stable metadata limits above remain in force. Module resolution additionally bounds resolved candidate paths to 32 KiB and shares 10,000 candidate probes per discovery operation, including missing candidates and repeated work. Overflow/unsafe required candidates use the fixed manifest diagnostic and refuse the complete generation. All actual files still undergo entry descriptor admission and fresh trust selection; these conveniences add no glob, package-specifier, filesystem-root or execution authority.

### Optional built-in capabilities

CLI/RPC own three optional hosted capabilities: `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`. Core exports frozen `BUILTIN_EXTENSION_NAMES`, readonly `BuiltinExtensionPolicy` and pure `resolveBuiltinExtensionPolicy`. For virtual IDs, global `!glob` exclusions apply first, exact `+builtin:name` additions next and exact `-builtin:name` removals last. The last matching **trusted** project override wins over global policy; plain IDs do not override exclusions. Explicit `-e builtin:name` wins last. Exact unknown IDs fail with a value-free error. Each global/project/explicit input admits at most 200 strings of 32 KiB; these virtual names are never filesystem paths. A leading `./` instead denotes a literal path.

`--no-extensions` / `-ne` disables automatic global/project, configured, environment and enabled-package executable discovery plus those optional capabilities. Explicit `-e` files/directories and known built-in IDs still work, behind the unchanged project trust/stable-file rules. Discovery/trust flags must precede contributed options. Core's additive `includeEnvironmentPaths: false` complements the loader's existing global/project location controls; default SDK behavior is unchanged.

This does not disable mandatory workspace tools, skill/prompt/theme resources, providers or explicit administration, and is not an offline/no-tools/sandbox flag. Enabling codemode capability does not override its separate activation, preset or allowlist policy. Disabling the synthetic `tool_search` preserves previously activated eligible tools and third-party replacements, not new hosted search calls. Privileged explicit modules can still execute arbitrary Node code.

Interactive `/reload` refreshes the policy; disk edits alone do not. RPC optional-built-in policy remains a startup snapshot: [scoped context-settings reload](./cli-reference.md) rereads only compaction/branch-summary settings, not executable or built-in generations. `McpSessionHost.setEnabled(false)` retires all owned sessions before awaiting transport closure, blocks captured invocations and late discovery, and prevents prompt-time configuration/credential/connection work. Reenablement is lazy; shutdown cannot reopen. Explicit MCP inspection/Test/admin remains separate and never implicitly reenables prompt hosting. Cancellation cannot undo an already admitted remote effect. File-generation rollback remains separate from the refreshed settings/capability policy. Server/Web settings composition is unchanged.

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

### Optional Web form lifecycle

`ChatView` delegates ordered-head presentation to `components/ExtensionInteractionBoundary.tsx`; only an actual pending request loads `ExtensionInteractionDialog.tsx` and its own CSS. Loading/error is a local nonmodal region with translated Close/Cancel, not a global Suspense or focus trap. Failed imports remain cached on reopen; explicit page reload warns about unsent text.

The boundary aborts its response transport on schema/request replacement or view retirement. Chat suppresses an aborted reply before updating state; abort does not undo a response already accepted by Server. Workspace ID/cwd, session, run and the full route tuple own presentation. Same-ID/kind compatible fields retain drafts and connected composition; changed controls reset. The mounted form suppresses IME/legacy-229 Enter acknowledgement and Escape propagation without preventing native editing. Ordinary post-composition Enter can submit once.

Initial focus is admitted before the renderer exists and checked again at its first frame: newer focus (including focus then blur), another modal, or re-presentation of the same request in a replacement route defeats it. Return needs the current view, unchanged available fallback and no newer focus/modal. Coarse pointers avoid unsolicited editable autofocus; guarded composer return remains possible after owned manual editing, whose intent is cleared by external focus. Head changes retain the modal but reset owned editable intent; browser-local receipts distinguish accepted duplicate observations from rejected stale callbacks. Exact same-version HTTP head removal requires a private captured reply witness. These are adapter controls, not new runtime authority, crash durability or a general fork-transaction guarantee.

## Security Invariants

- Treat every extension and package as executable code.
- Require project trust before exposing or loading project code/resources.
- Keep catalogue reads side-effect free and diagnostics free of source bodies, command output, and secrets.
- Preserve registration ownership so unload removes every command/tool/provider/UI/hook/listener.
- Pass cancellation to active tool and interaction work.
- Validate package source, bounded manifests/state, package-relative filters, symlinks, and rollback before changing active state.
- Serialize CLI/Server mutations with the Core heartbeat lock and owner-only atomic state writes; group activation remains bounded, uses one write, and returns value-free per-entry failures.

## Associated Tests

- `packages/server/src/api/session-notice-process.test.ts` — public Core/real built Server process coverage for completed/failed/stopped session-command notice correlation, active correlation and captured tool callbacks over HTTP/SSE; not browser queue delivery
- `packages/core/src/extensions/extension-registry.test.ts` — API version, ownership, hooks, tools, providers, UI and atomic replacement
- `packages/core/src/agent/runtime-interaction-queue.test.ts` and `runtime-interaction-process.test.ts` — order, updates, exactly-once settlement, bounds, signal/deadline and original subprocess controls
- `packages/server/src/api/{interaction-queue-http,queue-reconciliation-http,queue-generation-http,queue-generation-process}.test.ts` — latest-schema HTTP validation, stop accounting before terminal replay, same-cwd preservation and revocation while the run remains active
- `packages/core/src/tools/{tool-search,codemode}.test.ts` — deferred/script-only exposure, BM25 ranking, activation/store provenance, bounded QuickJS, policy revalidation and branch restoration
- `packages/cli/src/extensions/extension-loader.test.ts` — explicit path parsing and loader behavior
- Core `extensions/module-entry-resolution.test.ts`, CLI `cli/module-entry-process.test.ts`, Server `api/module-entry-process.test.ts` — main/suffix selection, exact boundaries, independent alias and dedup proofs, automatic-directory conservation, actual source/mode/startup paths, PTY reselection, nested descriptor race and real HTTP/tool/rollback behavior
- Core `extensions/native-module-alias-process.test.ts`, CLI `cli/native-module-alias-process.test.ts` and Server `api/native-module-alias-process.test.ts` — actual host/foreign namespace identity, CJS fast-cache and cached transitive conservation, pending/disposal/rollback ownership, exact bounds, foreign adapters, all native formats/modes/startup paths, real PTYs and HTTP tool/cleanup
- Core `extensions/module-manifest.test.ts`, CLI `cli/extension-manifests-process.test.ts` and the Server manifest variant — field precedence, literal containment and no-fallback bounds, all directory source/mode/startup combinations, genuine PTY metadata reload, actual descriptor-open replacement refusal and HTTP ownership conservation
- Core `extensions/typescript-modules.test.ts`, CLI `cli/typescript-extensions-process.test.ts` and Server `api/typescript-extensions-process.test.ts` — typed formats/alias/dependency execution, all source/mode/startup combinations, declarations/trust/suppression, genuine PTY and descriptor-replacement proof, public emitted Core and real Server HTTP/tool generations
- `packages/core/src/extensions/builtin-extensions.test.ts`, Core `mcp/session-host.test.ts` and CLI `cli/builtin-extensions-process.test.ts` — policy precedence/bounds/trust, synchronous retirement, real stdio hosting, all three emitted modes, suppressed global/project/settings/environment/package imports, explicit preservation, genuine PTY reload and strict external public consumers
- `packages/core/src/extensions/extension-selectors.test.ts` — actual-file glob/exact selection, trust, literal paths/bases and scoped-input validation, stable files, operation/file/depth bounds and managed-generation preservation
- `packages/cli/src/cli/extension-selectors-process.test.ts` — emitted print/JSON/RPC global/project selection and refusal, single startup import and provider hooks, genuine Linux PTY selector reload/agent-directory conservation and public declaration/emitted Core reload outside the checkout
- `packages/core/src/plugins/plugin-service.test.ts` — source validation, filters, trust, bounded one-write group activation, partial outcomes, concurrency, inventory and transactional package state
- `packages/cli/src/cli/{package-command,invocation}.test.ts` — strict command parsing and real package resource startup
- `packages/server/src/web-server.test.ts` — plugin/reload HTTP, trust and runtime integration
- `e2e/settings.spec.ts` — package administration flows
- `e2e/chat.spec.ts` and `e2e/accessibility.spec.ts` — widgets, interactions, focus and response handling
- `packages/web/src/components/extension-interaction-dialog.test.ts` — native declarative fields, inert output, CSS ownership, transport-only abort, bilingual cached-failure copy and compatible drafts
- `e2e/interaction-single-asset-load.spec.ts` with `interaction-asset-load.config.ts` — actual production JS/CSS delay/refusal, cached reload, singular head/draft lifetime, held-response retirement, IME and newer-focus/coarse-pointer controls; controlled API fixtures
- `e2e/interaction-queue.spec.ts`, `interaction-admission.spec.ts`, `interaction-asset-load.spec.ts` and `queue-reconciliation.spec.ts` — ordered queue/attention, stale response/Stop retirement, bootstrap and full-address ownership, optional assets and App discovery guards with controlled HTTP/SSE
- `e2e/interaction-live-boundary.spec.ts` — real extension/runtime/HTTP latest-schema rejection and form response/cancellation through the mock provider
- `tests/functional-parity/functional-parity.test.ts` — native extension positive/negative fixtures, RPC interaction and public type/runtime probes

## Common Changes

### Add an extension registration

Change Core contracts/registry/public exports, both runtime compositions, cleanup/rollback tests, and declarative Web handling only if browser-visible.

### Change interaction lifecycle

Keep contracts in Core's `extensions/extension-registry.ts` and `agent/{events,interaction-handle,runtime}.ts`; preserve compatibility snapshots, capability ownership, original deadlines and active-run epoch tests. Revalidate genuine installed declarations/runtime and unchanged CLI/RPC goldens. Do not infer browser queue acceptance from Core/Server tests. Preserve the optional renderer's local loading/error, cached-reload warning, transport retirement, IME and initial/return-focus controls; validate the genuine production assets and unchanged mobile interaction journeys.

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
