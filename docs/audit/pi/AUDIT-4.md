# AUDIT-4 — Current Pi / Pi Web Gaps and Deliverable Backlog

> **Status: IN PROGRESS — sole active parity tracker** (2026-10-19)
>
> **29 remaining gap families, 50 bounded delivery tasks, no execution quota.** Existing implementations are distinguished from missing behavior and missing qualification. No functional criterion is closed by this documentation migration. Start with the [delivery queue](#4-convention-and-delivery-queue); use the [gap register](#3-traceability-and-current-gap-register) for complete scope and the [qualification register](#7-integrated-qualification) for global failures.

## 1. Audit Reference

| Element | Pinned observation |
|---|---|
| AiHarness | `d27916eb89ed40fabfc92c7822a7eea4d8f83336`, `feature/v0.1.1`; clean Git tree at entry; origin `https://github.com/Fidigi/AiHarness.git` |
| Audit date / scope | 2026-10-19; documentary consolidation of current committed work, existing evidence and remaining requirements; not a new runtime qualification |
| Pi CLI target | Installed `@earendil-works/pi-coding-agent` **1.3.0**; [source](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0) `71023aec1546d6d677a65669c5665c0927ce0dd0` |
| Pi Web target | Installed `@agegr/pi-web` **0.12.2**; [source](https://github.com/agegr/pi-web/tree/b017cd48425d05aa4952051db2e4fc031c134094) `b017cd48425d05aa4952051db2e4fc031c134094` |
| Embedded agent | Pi Web embeds **Pi 1.2.0**, not 1.3.0; [reference](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff). Do not attribute CLI-1.3-only changes to Web |
| Predecessors | [AUDIT-3](./AUDIT-3.md) contains the 99-entry matrix and original receipts; [AUDIT-2](./AUDIT-2.md) retains full inherited wording and 102 earlier acceptances |
| Current committed increments | `a173202` editor schemas/navigation; `a95619c` hosted-MCP denial; `3e683ad` prestart ownership; `3375999` exact-entry copies; `a0e0834` MCP inheritance; `d27916e` terminal **WIP** |
| Detailed evidence | The versioned coverage index in §8 and the archived receipts; temporary logs/images are supplementary, not the only definition of completion |

**Objective:** maintain a readable, prioritized account of the remaining behavior relevant to AiHarness, with independently deliverable tasks and explicit parent-criterion obligations.

### Authority and limits

- Installed package versions and the two source checkout commits were reread. No registry/latest-version search, upstream upgrade, external upload, provider login or product suite was executed for this consolidation. Pi Web's npm gitHead differs from the comparison tag; AUDIT-3 §1.2 records the version-only metadata difference. No installed-package/checkout byte equivalence is newly claimed.
- Code/test inspection corroborates key delivered boundaries: exact Core tool allowlists, three-control MCP inheritance, public editor factories, pending SDK ownership and terminal-only browser storage. Other unqualified clauses are carried forward as requirements to verify, **not newly reproduced defects or fresh absence proofs**.
- This document replaces the active backlog, not history. All 99 predecessor IDs are accounted for: 93 open IDs map exactly once to §3; six accepted delta IDs appear in §2. The 102 older acceptances remain historical and are not silently reopened.
- For every mapped ID, retain the complete original acceptance clauses in AUDIT-3 §§3–4 and AUDIT-2 §3. Short summaries below do not waive omitted subclauses. Additional cross-family dependencies do not duplicate the canonical mapping.
- Five explicit product choices are binding (§5). Remaining policy choices are named in the queue. No ten-task target, automatic implementation sequence or perpetual validation loop is authorized.

## 2. Result and Preserved Baseline

These totals count **remaining capability families in §3**, not old IDs, commits or tasks.

| Status | Count |
|---|---:|
| DONE | 0 |
| PARTIAL | 28 |
| ABSENT | 1 |
| TO BE DEFINED | 0 |
| BLOCKED | 0 |
| IN PROGRESS | 0 |
| GAP ACCEPTED | 0 |
| **Total** | **29** |

Remaining-family administrative closure is `(0 DONE + 0 GAP ACCEPTED) / 29 = 0.0%`: no family is newly qualified by migration. **This is not 0% product completion or a parity percentage.** The previous matrix remains 6 DONE / 91 PARTIAL / 2 ABSENT = 99, with 93 open IDs; grouping changes the denominator, not their historical outcomes. Task states in §4 are a separate delivery view and must never be added to these totals.

### Accepted delta baseline — not work to redo

| Historical ID | Accepted behavior | Delivery / retained evidence |
|---|---|---|
| A3-CLI-05 | Bounded QuickJS assembly, intrinsic freezing and physical worker settlement | `ca9b155` after `4a77e57`; [worker/intrinsic receipt](./acceptance/codemode-intrinsics-and-worker-lifetime.md) |
| A3-CLI-09 | Credential-aware model resolution and ordered plural scopes | `ca9b155`, implementation `d1ba9cb`; [model receipt](./acceptance/model-resolution-and-scopes.md) |
| A3-CLI-13 | Preserve capped output, warn on stderr, exit nonzero | `7174970`; [print receipt](./acceptance/print-output-limits.md) |
| A3-CLI-16 | Home selectors and conserved empty template arguments | `13c1aa1`; [resource receipt](./acceptance/home-selectors-and-template-arguments.md) |
| A3-CLI-19 | Public summary input without private reasoning/replay | `ca9b155`; [summary receipt](./acceptance/summary-provider-projection.md) |
| A3-WEB-11 | Confined lazy skill instructions and Markdown references | `72bd88b`; [skill receipt](./acceptance/skill-content-pane.md) |

Their original failed iterations remain failed. Historical acceptance is not proof that the current whole application has passed qualification.

## 3. Traceability and Current Gap Register

`A4-*` identifies a capability family, not an implementation-sized task. **P0** protects authority, integrity or truthful outcomes; **P1** delivers important capability; **P2** covers optional experience/distribution. Priorities are proposed delivery order, not confirmed vulnerability ratings. The legacy column is the lossless canonical crosswalk; related work may consult other families without remapping IDs.

### Runtime, providers and terminal CLI

| Family | Status | Priority | Delivered foundation → remaining behavior | Legacy scope |
|---|---|---|---|---|
| A4-SEL | PARTIAL | P0 | Exact Core selection, defaults, deferred activation and `--no-mcp` exist → CLI pattern/modifier resolution, pinned/default/dynamic restoration across reload/resume/fork, current-owner denial after async refresh. | CLI-CFG-05, WEB-BASE-05, WEB-TOOL-05, A3-CLI-01 |
| A4-MCP | PARTIAL | P0 | Inheritance/exposure, arbitrary JSON stringification/isError, Test/OAuth and native HTTP/browser delivery exist → final slice/JSON conformance review; extension-owned registration/aliases/reach/types, resource routing, Web switches and metadata-only trust-dialog accessibility. | CLI-EXT-04, WEB-BASE-02, WEB-SET-08, A3-CLI-02, A3-CLI-04, A3-WEB-12 |
| A4-AUTH | PARTIAL | P0 | Encrypted provider device flows and MCP PKCE/loopback/paste exist → provider browser registrations; MCP CIMD/OIDC/issuer validation and discovery/refresh/callback cancellation/deadline conformance. | CLI-MOD-03, A3-CLI-03 |
| A4-PROV | PARTIAL | P0 | Native adapters, bounded discovery and selected thinking profiles exist → missing provider categories, classifier-image/decision routing, endpoint/profile/sampling/replay/price/usage contracts; first-turn discovery and general shared-runtime rename recovery. | CLI-MOD-01, CLI-MOD-02, CLI-MOD-07, CLI-MOD-10, WEB-SET-07, A3-CLI-07, A3-CLI-10, A3-WEB-13 |
| A4-CAT | PARTIAL | P1 | Shared in-memory catalogue and Server custom models exist → tenant/key-isolated durable offline metadata, CLI custom-catalogue composition, local-model routing and authoritative live RPC mutations. | CLI-MOD-04, CLI-MOD-05, CLI-AUT-04, A3-CLI-08 |
| A4-ERR | PARTIAL | P0 | Final JSON, mixed reasoning/text and SSE-error refusal are delivered → durable failed CLI prefixes; wider retry/capacity/strict-tools fallback, Unicode/error-image ordering, safe schema/accessor/size admission and shell/retry races. | CLI-AUT-05, A3-CLI-11 |
| A4-RUN | PARTIAL | P0 | Pending Core/SDK reservation/withdrawal and canonical JSONL/RPC exist → typed user/custom triggers, stable system, next-turn and settled-aborted semantics; full hook set, command ordering/rebind, queue/abort/new-session/shutdown windows across hosts. | CLI-RUN-06, CLI-EXT-02, CLI-EXT-03, CLI-AUT-01, CLI-AUT-02, CLI-AUT-03, A3-CLI-12 |
| A4-CTX | PARTIAL | P0 | Source/store/generation-bound compaction and known-window guards exist → useful overflow recovery, final system/tool/media wire budgets, effective-model switches, hooks/provenance and physical settlement/retired-generation accounting. | CLI-SES-07 |
| A4-CFG | PARTIAL | P1 | Published editor factories/assets and startup/reload theme validation exist → final schema delivery review and actual runtime effects/UI for remaining terminal/fullscreen/image/Markdown/Mermaid settings. Never invent a CLI models.json loader. | CLI-CFG-07, A3-CLI-14 |
| A4-TUI | PARTIAL | P1 | Regular/fullscreen hosts, 22 actions, safe themes and status exist → editing/IME/searchable selectors, mouse/selection/scroll/resize, collapse/notices, image/OSC/clipboard/cursor contracts, renderer fallback and interactive extension UI. | CLI-RUN-02, CLI-RUN-10, CLI-TUI-03, CLI-TUI-05, CLI-TUI-06, CLI-TUI-09, CLI-EXT-06, A3-CLI-15, A3-CLI-20 |
| A4-MEDIA | PARTIAL | P0 | Startup image ingestion, specialized generation and bounded tools exist → interactive attachment gestures, image-tool/nested/MCP transport, private retained-file provenance/revocation/cleanup and cross-provider/export continuity. | CLI-TUI-04, CLI-MOD-08, CLI-TOOL-02, A3-CLI-06 |
| A4-PRG | PARTIAL | P1 | Correlated live/nested progress and final accounting exist → crash-durable journal/replay of in-flight updates; process-local updates are not durable proof. | CLI-TOOL-10 |

### Sessions, Web and operations

| Family | Status | Priority | Delivered foundation → remaining behavior | Legacy scope |
|---|---|---|---|---|
| A4-SES | PARTIAL | P0 | Native JSONL v2, selectors, trees/copies and bounded metadata pages exist → project/global indexed discovery, external append/rewrite invalidation, safe cross-project picker/rebind/export, append-only metadata/labels/filter evolution and virtualized project ordering. | CLI-RUN-08, CLI-SES-01, CLI-SES-02, CLI-SES-03, CLI-SES-04, CLI-AUT-06, A3-WEB-02, A3-WEB-27 |
| A4-NAV | PARTIAL | P1 | Exact-entry copy/owner retirement and native anchors are committed → final delivered-slice review and project/worktree composer transfer with drafts/images/model/focus, late-intent retirement and no extra backend authority. | A3-WEB-04, A3-WEB-05, A3-WEB-06 |
| A4-ARCH | ABSENT | P1 | No qualified server pin/archive state contract in the inherited inspection → separate bounded revisioned UI state, family handling, Undo and cross-client reconciliation without journal movement. | A3-WEB-01 |
| A4-DEL | PARTIAL | P0 | Confirmed cascade deletion exists → bounded bulk selection, current per-ID authority/active checks, child-first results/reparenting and safe selection after partial failure. | A3-WEB-03 |
| A4-FILE | PARTIAL | P0 | Root/trust/scoped consent, lazy pane, Git and collision-aware upload exist → prove no session-derived grant; per-project file tabs, Git visibility/refresh/nested repos, targeted drops and bounded CSV/HTML/language previews. Authority checks are P0. | WEB-FILE-06, A3-WEB-07, A3-WEB-08, A3-WEB-09, A3-WEB-10 |
| A4-SUB | PARTIAL | P0 | Shared runtime, profiles, inherited allowlists and persisted child sessions exist → resource switches/snapshots, thinking/input-file/context admission, worktree isolation, durable queued/run/restart lifecycle and read-only child views with separate accounting. | A3-WEB-14, A3-WEB-15, A3-WEB-16, A3-WEB-17 |
| A4-UI | PARTIAL | P1 | Declarative interactions, Settings navigation/locale and MCP detail exist → missing migration capabilities, typed command buttons/shelves/dialog fitting and reusable list/detail/scope/save/reason/focus behavior across resources. | WEB-BASE-01, WEB-SET-02, A3-WEB-18 |
| A4-CHAT | PARTIAL | P1 | Process groups, replay and loaded history windows exist → display:false projection, custom/compaction headers, reply/error/Stop→Compact semantics; stable live/history DOM keys, lazy block/thinking rendering, signatures, minimap and deep export bounds. | A3-WEB-19, A3-WEB-20 |
| A4-NOTICE | PARTIAL | P1 | Usage/cache/attention/push foundations exist → effective cache notices versus actual warming, branch-derived metrics/costs and once-only attention/audio across tabs/background; cancellation is not completion. | A3-WEB-21, A3-WEB-26 |
| A4-MOB | PARTIAL | P1 | Terminal keys/theme committed as **WIP**, isolated Web573/browser25 pass; controlled keyboard detector exists → delivered-slice/final Main qualification and separate physical Android/iOS/Safari zoom/IME/rotation/browser-bar evidence. | WEB-CHAT-11, A3-WEB-22 |
| A4-PREF | PARTIAL | P2 | Existing themes, sizes and bounded preference persistence exist → decide font/palette expansion, safe CSS/migration, contrast and retained code colors without mandatory network fonts. | A3-WEB-23 |
| A4-LIFE | PARTIAL | P0 | Bounded process/runtime shutdown and restricted launcher exist → extension-owned disposer/dependency lifetimes, descendant/filtering/late-write evidence, exact-instance status/stop/open/check records and cross-platform cleanup. | CLI-EXT-07, CLI-SEC-06, A3-WEB-24 |
| A4-DIST | PARTIAL | P2 | npm/Docker, installed consumers, existing sharing server and update status exist → supported-chain pins/PATH/dependencies, remaining warning/settings/reload effects and fixed-server confirmation/redaction/failure review. No new channel/destination is requested. | CLI-CFG-10, A3-CLI-17, A3-CLI-18 |
| A4-PWA | PARTIAL | P0 | Fixed AiHarness manifest and native auth/Origin exist → service-worker cache-write lifetime and private-cache/logout/upgrade/origin qualification; no runtime name or preview mode. | A3-WEB-25 |
| A4-NET | PARTIAL | P0 | Shared proxy/timeout/retry/abort policy exists → explicit connect/idle/CONNECT policy and CLI/Server conformance for header/body stalls, NO_PROXY, cancellation and secret handling; no copied two-second default. | A3-WEB-28 |
| A4-QA | PARTIAL | P0 | Nine-suite runner, four CI partitions, build-context guards, receipts and local demo exist → explain or correctly disposition retained failures and qualify an explicitly selected integrated candidate; release approval remains separate. | WEB-OPS-04, A3-WEB-29 |
| A4-PUB | PARTIAL | P2 | Local synthetic demo and permission-separated Pages pipeline exist → authorized and observed remote settings/approvals/publication. Local success is not deployment. | WEB-OPS-02 |

## 4. Convention and Delivery Queue

### Criterion states

| State | Meaning |
|---|---|
| ABSENT | Required deliverable/evidence does not exist. |
| PARTIAL | A foundation exists, but completion criteria are unmet. |
| TO BE DEFINED | A product/security/scope decision is required. |
| IN PROGRESS | Implementation or verification is actively underway. |
| BLOCKED | An external blocker and owner/trigger are documented. |
| DONE | Every criterion is verified and evidence recorded. |
| GAP ACCEPTED | A dated final decision intentionally declines the criterion. |

### Three separate outcomes

| Outcome | Required evidence | What it does not imply |
|---|---|---|
| Delivery task DONE | Its exact acceptance is met, existing/missing proof is accounted for, code/docs are committed and required validation outcomes are recorded truthfully. If required verification is incomplete, keep REVIEW/QUEUED. | No automatic parent-family, legacy-criterion, release or physical-device closure |
| Family DONE | All mapped original clauses, adapted explicit decisions, dependent slices and applicable integrated obligations are satisfied; journal the complete clause map. | No deletion or retroactive success of historical failed runs |
| Integrated/release qualified | Exact selected candidate passes the required original Docker gates, actual-image/asset/context checks and separately authorized remote/device/release requirements. | No inference from a clean Git tree or a passing subset |

### Read this before selecting work

1. **One task in progress at a time.** Start only the user-selected task; this document is not permission to run the queue autonomously. Suggested first review: D01, then choose D02–D05 or a P0 behavior task with the user.
2. `REVIEW` = code already committed; reconcile existing proof and identify the exact missing acceptance, do not rewrite it. `READY` = bounded first slice to implement/verify. `QUEUED` = named dependency must settle first. `DECISION` = obtain the stated contract choice. `WAIT` = explicit external authorization/access is required. `DONE` requires the complete task acceptance and commit/evidence.
3. Every task is a **slice of its family**, not a renamed whole legacy criterion. Completing it removes only its stated gap. Remaining clauses stay in §3; introduce another bounded task before working on them. Do not silently enlarge the current task to finish its parent.
4. Before adding tests, identify existing coverage (§8) and the precise missing behavior. Reuse owning fixtures; add only the missing proof. Separate real CLI/API/browser boundaries where needed. No general test refactor or new framework.
5. For changed code, retain the Docker validation required by [project-map §8](../../ai/project-map.md#8-validation). A task can record a delivered implementation and bounded acceptance while global qualification is failed/pending; it cannot claim the required integrated gate passed. Never turn an incomplete verification task into DONE by excluding a required test.
6. If an unrelated aggregate fails, record the result once in §7 and its effect on this task. Do not start an unchanged full rerun, speculative repair or another workstream. Await a bounded next instruction. No timeouts/retries/assertions/snapshots are relaxed to obtain green results.

`E01`…`E20` refer to concrete existing coverage in §8. A coverage file's presence is not a newly passing test result. No delivery task is marked DONE by this migration.

### Already implemented — review before adding code

| Task | Family / priority | Deliverable and complete task acceptance | Existing coverage; missing proof / dependency | State |
|---|---|---|---|---|
| D01 | A4-MCP / P0 | Final clause/source review of the delivered three-control inheritance and ordered exposure slice; account for trust, dual-source generation, raw writes/undo and public/installed/browser authority without changing defaults. | E01; a0e0834 and bounded V4 evidence already exist. Reconcile final source/authority obligations; required complete Main gates remain in Q03, not silently waived. | REVIEW |
| D02 | A4-CFG / P1 | Final published-schema delivery review: five native assets, strict public factories/declarations, outside-checkout use and identical startup/reload validation; explicitly exclude a CLI models.json loader. | E02; a173202. Reuse the existing clause map and actual-image asset evidence; record unfulfilled integrated acceptance under Q03. | REVIEW |
| D03 | A4-NAV / P1 | Final exact-entry-copy review: saved displayed identity captured before awaits, active source supported without runtime preparation, strict refusal/provenance/title/source conservation and owner retirement. | E03; 3375999. Use native/API/installed/active-source/owner receipts; distinguish admitted copy persistence from late-navigation retirement. Global gate Q03 is still open. | REVIEW |
| D04 | A4-NAV / P1 | Final native-link review: plain/modified/middle/context-menu intent, canonical missing-session refusal and root/prefix router identity without token copying. | E04; a173202 and root repair. Preserve urgent router/store ownership; reconcile existing browser proof and outstanding Q03 rather than regenerate screenshots. | REVIEW |
| D05 | A4-MOB / P1 | Review terminal WIP for extra-key bytes, one-shot modifiers, focus/availability and independent live theme without PTY remount; name any missing clause before changing code. | E05; d27916e, isolated types/strict16/Web573/build/browser25 pass. Main V6 only typecheck settled; Q03 is pending. Physical devices are D36, not implied by emulation. | REVIEW |

### Safety and shared-runtime slices

| Task | Family / priority | Deliverable and complete task acceptance | Existing coverage; missing proof / dependency | State |
|---|---|---|---|---|
| D06 | A4-ERR / P0 | Retain the received Unicode assistant prefix durably after a CLI print/JSON streaming failure; final error/exit remains truthful, no duplicate prefix or replayed tool effects after reload. | E06; encoder already retains an event prefix, so locate the persistence boundary first. Add only missing native failure/reload proof; valid/length/refusal controls stay unchanged. | READY |
| D07 | A4-SEL / P1 | Resolve CLI tool patterns and +/- adjustments to concrete names in the CLI adapter; replacement and adjustment differ correctly and exclusions win. | E07; Core/Server allowedTools remains exact, including literal read*. No mcp__ prefix denial or allowedTools ABI change. | READY |
| D08 | A4-SEL / P0 | Restore branch-active tool intent on resume, then reapply current owner/preset/exclusion policy after dynamic refresh; revoked tools cannot reappear through nested/search calls. | E07; depends on D07's selection contract. Preserve existing deferred activation rather than replace its journal. | QUEUED |
| D09 | A4-AUTH / P0 | Bound one MCP OAuth lifetime across discovery, callback and refresh; issuer/state/redirect validation and cancel/deadline prevent late credential publication. | E08; use local real issuer fixtures and current CAS/logout behavior. No vulnerability claim from an upstream advisory alone. | READY |
| D10 | A4-AUTH / P1 | Define one supported provider browser/PKCE registration and headless fallback; record implementable acceptance without exposing tokens to Web. Implementation is a subsequent slice. | E08; provider and usable registration must be explicitly selected first. This is not MCP OAuth and authorizes no live login during audit work. | DECISION |
| D11 | A4-MCP / P1 | Qualify existing structuredContent JSON formatting for arrays/null/primitives, isError, size/redaction and unchanged text fallback; add transport only if a concrete comparison demonstrates missing behavior. | E01; session-host.ts already stringifies arbitrary JSON and retains isError. Do not invent a typed-result API requirement. Extension aliases/resources remain separate work. | REVIEW |
| D12 | A4-RUN / P0 | Publish an unambiguous settled-aborted outcome for one accepted agent lifetime, including prestart withdrawal, without duplicate settlement or schema-breaking legacy events. | E09; reservations/SDK stop already exist. Add only the missing settled-event compatibility proof, not a second admission engine. | READY |
| D13 | A4-RUN / P1 | Define and expose the typed user/custom trigger union with a value-owned stable system boundary; custom triggers cannot bypass the existing admission lifetime. | E09; settle the public payload/version contract before code. Queue/next-turn and all remaining hooks are not silently bundled here. | DECISION |
| D14 | A4-CTX / P0 | Refuse an over-budget final system/tool/media request at an effective-model switch before provider effects, including unknown-to-known limits; retained history is unchanged. | E10; canonical preparation and known-window admission are already implemented. Identify the missing wire/model case first; estimates are not exact vendor tokenization. | READY |
| D15 | A4-DEL / P0 | Recheck busy state and per-session authority at bulk-delete admission; return bounded per-ID outcomes and preserve sessions that became active after confirmation. | E11; existing cascade is the foundation. Contract must define retained-ancestor selection and child-first handling before UI integration. | READY |
| D16 | A4-FILE / P0 | Review file access entry points against the approved roots/scoped-consent policy; transcript/MCP/codemode paths never create read/write/execute authority. | E12; distinguish existing descriptor-scoped reads from root/trust expansion. Record only uncovered boundaries; no dynamic session-derived grant. | REVIEW |
| D17 | A4-SUB / P0 | Apply an owned child resource-policy snapshot with explicit MCP/codemode inheritance/denial; refresh/resume cannot exceed parent/current trust or expose nested model-only tools. | E13; existing allowlists reduce authority. Define switch semantics before implementing; no extra executable factory privilege. | READY |
| D18 | A4-SUB / P0 | Persist a child's queued/running/interrupted terminal state across restart, including stop before MCP readiness; reopening the record starts no runtime. | E13; depends on a durable run-state contract distinct from the existing saved conversation. Missing cwd must be refused, never recreated. | READY |
| D19 | A4-LIFE / P0 | Track extension-owned disposers and await bounded physical cleanup on unload/reload; borrowed resources and foreign processes survive. | E14; existing registry/process shutdown is reused. Demonstrate the specific blocked-owner and late-write boundary, not unsupported-platform containment. | READY |
| D20 | A4-NET / P0 | Decide explicit connect-versus-idle deadlines and CONNECT/proxy ownership for CLI and Server, with a slow-proxy compatibility rationale. | E15; old stalled-connect probes are observations, not a proven cause or approval of two seconds. Implementation follows a separately accepted contract. | DECISION |
| D21 | A4-PWA / P0 | Review service-worker private-cache/logout/upgrade and cache-write lifetime; authenticated content cannot become offline-public or survive logout contrary to policy. | E16; fixed AiHarness name, no preview mode. Repair only a demonstrated native gap; no copied upstream proxy architecture. | REVIEW |

### Feature slices — ordered after the selected safety/review task

| Task | Family / priority | Deliverable and complete task acceptance | Existing coverage; missing proof / dependency | State |
|---|---|---|---|---|
| D22 | A4-PROV / P1 | Verify/add Azure Foundry Chat Completions payload/endpoint conformance for one explicit native profile, including model-switch thinking isolation. | E17; preserve native provider IDs. This task does not claim all providers/prices/sampling profiles are complete. | READY |
| D23 | A4-PROV / P1 | Add bounded image input to classifier requests and their guest bridge; text-only/decision models reject unsupported chat/image routing before effects. | E17; retain private credential resolution, output/hooks/cost bounds and current bridge ownership. | READY |
| D24 | A4-CAT / P1 | Persist non-secret catalogue metadata with key/tenant identity isolation and config/auth invalidation; offline reads never disclose another tenant's models or invented prices. | E17; process-only offline startup is not this cache. No credential bytes in cache keys/files. | READY |
| D25 | A4-CAT / P1 | Compose the existing Server custom-provider catalogue into CLI startup through shared native contracts, preserving encrypted-secret authority and explicit scope. | E17; settle the existing shared-storage interface first; no new CLI models.json/private providers.json format. | READY |
| D26 | A4-TUI / P1 | Make Home/End versus Ctrl+Home/End preserve intended line/buffer cursor behavior in the actual fullscreen editor, with multiline/IME controls conserved. | E18; use the current editor and native PTY driver, not a TUI rewrite. Other mouse/OSC/selector clauses stay in the family. | READY |
| D27 | A4-MEDIA / P1 | Define one private image-tool result lifecycle: bounded readable content, explicit provenance/permission and revocation/cleanup across reload/export. | E19; settle the transport contract before extending read or nested/MCP results. Existing image ingestion is conserved. | DECISION |
| D28 | A4-PRG / P1 | Journal bounded in-flight progress so a crash/reload reconstructs parentage and interrupted state without duplicating usage or pretending a live update was already durable. | E19; existing final-result accounting and process-local replay are controls, not proof of a progress journal. | READY |
| D29 | A4-SES / P1 | Incrementally discover external session append/deletion/rewrite with inode/header/generation invalidation and bounded index rebuilds. | E11; conserve current pagination and metadata-only lists; include same-size rewrites and concurrent readers. | READY |
| D30 | A4-SES / P1 | Require explicit cwd confirmation when selecting a foreign-project session; cancellation preserves the displayed session, draft and workspace. | E11; reuse exact/path/prefix selectors and copies. Global index D29 may supply results but must not grant cwd authority. | READY |
| D31 | A4-ARCH / P1 | Add the server pin/archive state contract, separate from journals: bounded revisions, auth and concurrent canonical readback; no active-leaf/file movement. | E11; native API/storage contract is the first delivery. Undo/family Sidebar presentation remains a subsequent slice, not hidden inside this task. | READY |
| D32 | A4-FILE / P1 | Deliver exact-subfolder upload/drop with explicit skip/overwrite and per-file outcomes; skipped mentions refer to the existing file, never a browser-local path. | E12; reuse the trust-gated writer and collision controls. Late workspace/subfolder changes cannot redirect an admitted upload. | READY |
| D33 | A4-UI / P1 | Add typed declarative extension command-button intent with current owner/capability/busy validation and retirement on unload. | E14; no command inference from text/ANSI, arbitrary HTML/React or extra browser execution authority. | READY |
| D34 | A4-CHAT / P1 | Hide display:false custom entries from transcript presentation while preserving their native persisted/model content and correct turn grouping. | E20; verify live, reload and branch projections; never filter the canonical model context to hide UI rows. | READY |
| D35 | A4-NOTICE / P1 | Make the existing cache-miss preference drive one branch-derived notice without duplicate replay or cross-clock timing; incomplete costs stay explicit. | E20; actual cache warming is a separate network capability, not implied by showing a notice. | READY |
| D36 | A4-MOB / P1 | Record physical Android/iOS/Safari keyboard/zoom/IME/rotation/browser-bar observations and failures with device/browser metadata. | E05; controlled Chromium coverage is reused but not substituted. Device access is only a prerequisite for this physical-evidence task. | WAIT |
| D37 | A4-PREF / P2 | Agree a bounded local font/palette preference contract, safe CSS values/migration and contrast/code-color preservation. | E20; no mandatory downloaded fonts. Implement only the selected expansion after the product choice. | DECISION |
| D38 | A4-LIFE / P1 | Implement exact-owned-instance status/stop records that refuse foreign/reused PIDs and stale records; passive status/check never installs an update. | E14; preserve existing shutdown and explicit command authorization. An update installer is outside the approved scope. | READY |
| D39 | A4-DIST / P2 | Review npm/Docker internal pins, dependency chain, executable modes and installed PATH behavior against actual package assets. | E02/E18; existing installed probes first; no Nix, managed installer, automatic updater or speculative dependency churn. | REVIEW |
| D40 | A4-DIST / P2 | Review the fixed existing sharing-server boundary: confirmation, redaction, auth and failure without destination fallback. | E11; explicitly disposition the legacy missing destination-setting delta against the user's single-destination choice. No Gist/Radius/real external upload is required. | REVIEW |
| D41 | A4-PUB / P2 | Perform and record an authorized Pages publication with correct base path, remote settings and observed artifact. | E16; requires explicit remote permission and target first. Local demo success/CI workflow presence does not complete this task. | WAIT |
| D42 | A4-UI / P1 | Reuse one Settings save-target/reason/focus primitive across two named resource forms without losing trust/scope ownership. | E20; identify the concrete duplication/missing behavior before refactoring. Existing navigation and locale are not work to redo. | READY |
| D43 | A4-CHAT / P1 | Preserve one live assistant entry's DOM identity when it becomes persisted history, including late pagination and branch replacement. | E20; keep Markdown semantics, scroll/focus and private signature boundaries. Other rendering optimizations need separate measured slices. | READY |
| D44 | A4-SUB / P1 | Expose a paged read-only child transcript with separate known/partial usage, without starting a provider/MCP runtime or double-counting the parent. | E13; depends on child identity/authority, not on implementing a new child runtime. | READY |
| D45 | A4-ERR / P0 | Implement one explicit busy/capacity versus strict-tools fallback policy with bounded pre-output retry and no prefix/tool replay. | E06; select the provider error dialect and preserve default zero retries. Do not classify arbitrary remote English strings as trusted error codes. | DECISION |
| D46 | A4-SES / P1 | Append a versioned metadata/label evolution entry and reconstruct it across load/export/copy; old journal history remains lossless. | E11; use AiHarness v2 compatibility/migration, not Pi's storage format. | READY |
| D47 | A4-FILE / P1 | Define per-project file-tab placement/restoration and bounded metadata memory; content/secrets and retired-view focus cannot leak across projects. | E12; choose the preference/retention contract before implementation and retain lazy-pane ownership. | DECISION |
| D48 | A4-FILE / P2 | Add a bounded progressive CSV/TSV reader with quoting/multiline/BOM/UTF-8 record boundaries and inert source fallback. | E12; no active HTML execution, unlimited row buffering or eager language bundle. | READY |
| D49 | A4-SUB / P0 | Define worktree-isolated child creation/result ownership and missing-cwd refusal; cleanup never force-deletes unrelated changes. | E13; no worktree creation until lifecycle/keep/remove/report contract is approved. Durable run state D18 must remain independent of physical cwd availability. | DECISION |
| D50 | A4-NAV / P1 | Transfer the exact draft/images/model intent on explicit project/worktree choice, including late image preparation and cancellation, without sending twice or stealing new focus. | E03/E04; saved-source copying is separate and must not be reused as a draft-transfer shortcut. | READY |

## 5. Decisions and Accepted Gaps

User decisions were explicitly given on 2026-10-19 and recorded in AUDIT-3 §9.3. They remain binding; do not ask the same five questions again or create excluded integrations as backlog tasks.

| Decision | Approved scope and reason | Re-examination trigger |
|---|---|---|
| File authority | Explicit roots/scoped consents only; conversation/tool/MCP/codemode text grants no access. More restrictive native security is intentional. | A separate explicit grant decision, never a mentioned path |
| Pretrust MCP | Already available metadata only; do not open an unapproved project body or add a content-preview consent flow. Existing administrator paste/import preview is different and retained. | Explicit request for pre-approval content inspection |
| Distribution | npm/Docker only; no Nix/managed installer/automatic updater. User selected the existing supported channels. | Explicit request for another distribution channel |
| Sharing | Existing sharing server only; no Gist/Radius/extra destination or automatic fallback. | Explicit request for another destination |
| PWA | Fixed AiHarness name; no runtime naming or implicitly authorized preview mode. Cache/auth review remains required. | Explicit per-instance branding or independently requested preview capability |
| Work scope | Ten-additional-closures mandate withdrawn. Subsequent work follows the selected task, not a quota. | A new explicit user objective; never inferred from this backlog |

**No whole A4 family is GAP ACCEPTED.** Excluded upstream options are documented product differences, not fabricated completed implementations. In particular, D40 must reconcile the old destination-setting absence rather than reintroduce an unwanted selector. Contract steps in D10/D13/D20/D27/D37/D45/D47/D49 are not eight new mandatory user questions: resolve engineering contracts from existing owners where possible; ask only for a genuine product/security choice. None reopens the five answers.

## 6. Delivery Journal

Only record actual transitions, decisions and concise outcome references. Do not copy full run logs into this table.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-10-19 | A4-SEL, A4-MCP, A4-AUTH, A4-PROV, A4-CAT, A4-ERR, A4-RUN, A4-CTX, A4-CFG, A4-TUI, A4-MEDIA, A4-PRG, A4-SES, A4-NAV, A4-ARCH, A4-DEL, A4-FILE, A4-SUB, A4-UI, A4-CHAT, A4-NOTICE, A4-MOB, A4-PREF, A4-LIFE, A4-DIST, A4-PWA, A4-NET, A4-QA, A4-PUB; D01–D50; Q01–Q03 | Initial consolidation:28PARTIAL/1ABSENT; no new runtime closure | d27916e source/evidence baseline; exact99-ID succession; user-approved restructuring and retained decisions | Node structural checks PASS:99IDs/29families/50tasks, paths/history/inventory; make lint-docs PASS:157Markdown/1,250links; git diff --check PASS; no runtime command | AUDIT-4 becomes the sole active tracker. AUDIT-3 is archived without altering its historical matrix/journal; no old requirement or failed run is erased. |

### Documentary validation

Executed: source/receipt reads, installed-version/source-commit observations, Node identifier/crosswalk/count/task-reference/path/history/inventory checks, `make lint-docs` and `git diff --check`. All final documentary checks pass; the first inline Node attempt had a syntax error before assertions and was corrected. No product suite, typecheck, build or screenshot generation ran. These checks cannot qualify D01–D50, Q01–Q03 or the application.

## 7. Integrated Qualification

These are qualification work items, not additional parity families or tasks added to the §2 denominator. **No complete qualification of d27916e is claimed.**

| Item | Observed state | Bounded next action / completion |
|---|---|---|
| Q01 — installed native child | Last complete Main MCP parity:260pass/1fail of261; old print/Anthropic valid-tool-JSON child code null / SIGSEGV. Child channels and outer native signal were not retained. | Preserve the original failure and capture actionable metadata on a naturally occurring/explicitly approved diagnostic failure. Do not infer an Anthropic/parser/compiler/MCP cause or loop full parity retries. |
| Q02 — package settings boundary | Last complete root:6093pass/1fail of6094; old real CLI global-broken-JSON child failed with code/signal/channels unretained. One bounded same-image diagnostic then passed1selected/29notselected; seven observed children had4success/3expected code1. | Diagnostic is finished: original failure was not reproduced or explained, so no speculative product repair or unchanged diagnostic rerun is queued. New evidence is required to reopen diagnosis; qualify the next genuinely selected candidate under Q03. |
| Q03 — next integrated candidate | MCP Main a0e0834 aggregate FAILED despite633browser/production/assets passes. Terminal d27916e is later WIP: isolated573Web/25browser and Main V6 typecheck0; remaining complete Main review interrupted by user. | For authorized runtime delivery under the project-map matrix, or a separate explicit qualification request, select/freeze the candidate and execute the applicable original typecheck/parity/full/nine-suite-E2E/production/assets workflow once. Preserve raw results, input/SDK hashes and actual images. Stop on unexplained failures rather than rerun until green. |

All seven previous complete Main aggregates remain FAILED in [AUDIT-3 §9](./AUDIT-3.md#9-current-implementation-journal--2026-10-18), including V18's Node fork-worker SIGSEGV during unfinished context close. That last recorded step is not a native stack or a Chromium/GPU diagnosis. Older production/native/fixture/capture failures remain in their receipts. Optional core/other-runner evidence is not a prerequisite for ordinary feature work.

Remote Pages authorization belongs to D41 and physical keyboard evidence to D36. They are not satisfied by Q03 or prerequisites for unrelated local tasks. The old counts/images describe their own frozen candidates, not current d27916e.

## 8. Existing Coverage and Owners

Reuse these sources/tests/receipts before adding proof. Source and test paths below are repository-relative. Where one family is broader than the named files, inspect the existing owning domain before selecting its next slice.

| Ref | Owner / concrete existing coverage | What is known; what it does not prove |
|---|---|---|
| E01 | `packages/core/src/mcp/config-inventory.ts`, `packages/core/src/mcp/config-inheritance.test.ts`; `packages/server/src/api/mcp-inheritance-http.test.ts`; `e2e/mcp-inheritance-live.spec.ts`; [MCP receipt](./acceptance/native-mcp-inheritance-browser.md) | Real trust/global-local/raw-write/generation/Test/browser/installed inheritance evidence; no whole current Main qualification |
| E02 | `packages/core/src/config/agent-settings-editor-schema.test.ts`; `packages/server/src/runtime/model-editor-schema.test.ts`; `packages/cli/src/cli/editor-schema-process.test.ts`; [schemas](./acceptance/native-editor-schemas.md) | Public factories, five assets, actual strict engine and installed/theme flows; no private credential format or invented loader |
| E03 | `packages/core/src/sessions/session-row-copy.test.ts`; `packages/server/src/api/session-row-copy-http.test.ts`; `e2e/session-row-copy-live.spec.ts`, `e2e/session-row-copy-owner.spec.ts`; [copy receipt](./acceptance/native-session-row-copy.md) | Saved leaf, active-source, source conservation, late-owner retirement and public/installed copies; whole Main V18 failed |
| E04 | `packages/web/src/components/session-links.tsx`; `e2e/native-session-links-live.spec.ts`; [navigation receipt](./acceptance/native-session-links.md) | Native link intent and router boundaries; earlier root/PTY/native failures remain historical |
| E05 | `packages/web/src/components/terminal-controls.test.ts`, `packages/web/src/store/terminal-theme.test.ts`; `e2e/terminal-controls.spec.ts`, `e2e/terminal.spec.ts`, `e2e/live-server.spec.ts` | V5 bounded573Web/25browser, real PTY versus controlled transport distinguished; four repaired inspected captures unchanged in d27916e; not physical certification |
| E06 | `packages/core/src/providers/stream-error-frames.test.ts`; `packages/cli/src/cli/stream-error-process.test.ts`, `packages/cli/src/cli/json-output.test.ts`; [SSE](./acceptance/stream-error-frames.md), [final JSON](./acceptance/final-tool-json.md) | Refusal before effects and encoder event behavior; durable CLI failed-prefix gap remains, wider retry dialects unqualified |
| E07 | `packages/core/src/tools/tool-selection.ts`, `packages/core/src/tools/tool-selection.test.ts`; `packages/cli/src/cli/no-mcp-process.test.ts`; [denial receipt](./acceptance/native-mcp-host-denial.md) | Core exact allowlists and hosted-owner denial exist; not complete CLI pattern/restoration semantics |
| E08 | `packages/core/src/mcp/oauth-integration.test.ts`; `packages/cli/src/security/oauth-device.ts`; [security topic](../../ai/topics/security.md) | Native MCP PKCE/issuer and provider device-flow foundations; not complete provider browser registration/CIMD coverage |
| E09 | `packages/core/src/agent/runtime-prestart.test.ts`, `packages/core/src/sdk/prestart-lifetime.test.ts`; [pending ownership](./acceptance/native-prestart-admission.md), [extensions](../../ai/topics/extensions.md) | Busy reservation/withdrawal and admitted-save behavior; not physical termination or full typed-trigger/hook/queue coverage |
| E10 | `packages/core/src/sessions/compaction-model-messages.test.ts`, `packages/core/src/sessions/session-compaction-store-admission.test.ts`; [request admission](./acceptance/provider-request-admission.md) | Canonical preparation, source/store lifetime and known-window guards; not all wire/media/switch/overflow cases |
| E11 | `packages/core/src/sessions/session-manager.ts`; `packages/cli/src/cli/session-navigation-pty.test.ts`; [sessions topic](../../ai/topics/sessions.md), [statistics](./acceptance/session-statistics.md) | Native journal/tree/copy/cascade/export/share foundations; not a new archive/index/bulk contract |
| E12 | `packages/server/src/api/file-routes.ts`, `packages/web/src/components/WorkspacePanel.tsx`; `e2e/live-server.spec.ts`, `e2e/pane-lifetime.spec.ts`; [linked consent](../../ai/topics/linked-directories.md) | Roots/trust/scoped consent, actual files, collision/lazy ownership; not arbitrary transcript authority, full tab/drop/CSV behavior |
| E13 | `packages/server/src/runtime/subagent-service.ts`, `packages/server/src/runtime/subagent-runtime.test.ts`; [child agents](../../ai/topics/child-agents.md) | Shared runtime/profile/allowlist/current-cwd foundation; not worktree isolation or durable run restart equivalence |
| E14 | `packages/core/src/extensions/extension-registry.ts`; `packages/server/src/web-cli.ts`; [extensions](../../ai/topics/extensions.md), [declarative RPC UI](./acceptance/rpc-extension-ui.md) | Owned declarative interfaces, loader and bounded process lifetimes; no arbitrary browser components or full disposer/instance-command proof |
| E15 | `packages/core/src/providers/provider-network.ts`, `packages/core/src/providers/provider-network.test.ts`; [providers](../../ai/topics/providers.md) | Shared network policy and bounded fixtures; existing CONNECT observations are not an approved new deadline |
| E16 | `packages/web/public/sw.js`, `packages/web/public/manifest.webmanifest`; `.github/workflows/demo-pages.yml`; [static demo](../../ai/topics/static-demo.md) | Fixed PWA and separate local demo/pipeline; not cache security requalification or observed remote publication |
| E17 | `packages/core/src/providers/model-catalog.ts`, `packages/core/src/providers/specialized-models.test.ts`; `packages/server/src/runtime/provider-registry.test.ts`; [providers](../../ai/topics/providers.md) | Current adapters/catalogue/specialized bridges; remaining dialect/image/cache/rename claims require their own exact cases |
| E18 | `packages/cli/src/tui/fullscreen-ui.ts`, `packages/cli/src/tui/fullscreen-input.ts`; `packages/cli/src/utils/terminal-actions.test.ts`; `tests/functional-parity/installed-executable.test.ts` | Existing editor/actions, installed packaging and declarations; not complete mouse/IME/OSC/platform certification |
| E19 | `packages/core/src/tools/workspace-tools.ts`, `packages/core/src/agent/events.ts`; [code mode](../../ai/topics/codemode.md), [detached streams](../../ai/topics/detached-streams.md) | Bounded tool/media/nested result/progress foundations; not private image lifecycle or per-update crash durability |
| E20 | `packages/web/src/components/process-turns.test.ts`, `packages/web/src/store/preferences.ts`, `packages/web/src/store/settings-navigation.ts`; [Web architecture](../../ai/topics/web-app-architecture.md) | Existing renderer/state/navigation/locale/attention/preferences; not all delta presentation, metrics or accessibility claims |

## 9. Glossary

| Term | Meaning |
|---|---|
| A4-* | Current capability-family ID; exactly one status and a lossless legacy-ID crosswalk in §3 |
| D01–D50 | Independently bounded delivery slices; their operational states do not redefine parent requirements |
| Q01–Q03 | Integrated qualification/failure follow-up, separate from feature delivery and parity-family counts |
| E01–E20 | Existing source/test/receipt index, not newly executed test evidence |
| Legacy ID | One of the99 AUDIT-3 entries; original acceptance wording remains in the archived report and AUDIT-2 |
| WIP | Committed work with incomplete acceptance/qualification; clean Git is not a green application |
| Historical acceptance | Preserved delivery evidence at its own pinned candidate, not an assertion of current global health |
