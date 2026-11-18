# Application Architecture Audit — AiHarness

> **Status: DONE** (2026-11-17)
>
> All16 criteria are DONE from implemented behavior/classification and scoped evidence. Canonical-only RPC/input budgets, reviewed internal/public removal/Core API2, fresh authenticated metadata, safe staged hydration, owner-preserving extractions, bounded CI enforcement and actual browser profiles are delivered. Current targeted CLI/worker/installed checks,108 owning-browser cases, production build and existing production SDK fixture pass. Per the user's explicit later instruction, verified non-reproduced incidents are OK/non-blocking with no speculative patch; original failed full-root/parity/E2E/build receipts remain failed records, not relabeled PASS. [Requirement-by-requirement completion audit](./evidence/remediation-07/README.md#completion-audit). Decisions/documentation alone are not implementation evidence.

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | AiHarness 0.1.0: Core, CLI, Server and Web architecture, dead-code candidates, performance and compatibility debt |
| Audited instance | Initial clean application checkout at `120b4d46352def7170967599f260846c07a0e02c`; current runtime remediation differs and is identified separately in the journal |
| Audit date | 2026-11-17 |
| Pinned source | `https://github.com/Fidigi/AiHarness/tree/120b4d46352def7170967599f260846c07a0e02c` |
| Runtime | Docker test image `sha256:479ef95ecbd4a046acd48d964b06b406bcd0d469e99e39b3e11d0f121122be0c`; Node 24.15.0; environment in [environment.json](./evidence/environment.json) |
| Source correspondence | Image AST inventory and checkout lexical inventory share the ordered 454-source digest `95b9c40d931559783e462ddca102da115df0201adb6a16c439fc48166c0f7862` |
| Detailed references | [Import inventory](./evidence/inventory.json), [reference screening](./evidence/references.json), [synthetic probes](./evidence/probes.json), [focused tests](./evidence/focused-tests.txt), [bundle budgets](./evidence/bundle-budget.txt), [build transcript](./evidence/build.txt) |

**Objective:** Identify evidenced architectural coupling, distinguish removable internal code from public/dynamic contracts, measure bounded performance opportunities, and identify compatibility layers that need an explicit retirement decision rather than indefinite duplication.

### Initial assessment limitations (remediation evidence is journaled separately)

- The import graph covers 454 source TS/TSX modules, excluding tests, declarations and fixture directories. It follows literal imports/re-exports/require, including deferred imports; it is not a full runtime call graph. The 18 unresolved entries are stylesheet imports/queries, not demonstrated missing code.
- Lexical screening covers 1,302 tracked code files including tests/scripts. Comments and strings count as references. Computed names, external consumers, wildcard public exports and worker URLs require separate inspection. Neither scanner proves whole-repository absence of dead code.
- Runtime probes use disposable synthetic data and `--network none`. They do not read personal credential stores or contact real providers. No account/service verification, production load test or browser rendering profile was performed.
- Startup samples have warm OS caches, no competing-load control and only five observations. Session loading has one two-pass sequence per size. These are local observations, not p95/p99, scalability guarantees or measured optimization gains.
- `make build-test` reused cached build layers. Focused tests and probes ran against that emitted image, not a new production image. The source digest covers the stated TS/TSX scope, not every Docker context input.
- No full `make test`, parity, E2E, production build or fresh workspace typecheck was run. No screenshots are applicable to this unchanged UI; missing browser performance evidence remains VAL-02.
- Any target evolution requires a separately journaled re-audit. Only the removals and RPC input policy explicitly recorded in §5 are user-approved; other recommendations are not implementation approval or accepted compatibility gaps.

## 2. Result

All 16 criteria have been assessed. Statuses describe the **target condition/remediation**, not the percentage of investigation performed. A finding does not become `DONE` merely because it has been documented.

| Status | Count | Details |
|---|---:|---|
| `DONE` | 16 | All implemented/classified criteria have requirement-specific evidence; current targeted qualification and explicit non-reproduction policy complete acceptance |
| `PARTIAL` | 0 | No criterion is reclassified as partial assessment |
| `ABSENT` | 0 | All required deliverables/evidence exist |
| `TO BE DEFINED` | 0 | The four requested product decisions are resolved |
| `BLOCKED` | 0 | Non-reproduced incidents are explicitly non-blocking under the subsequent user instruction |
| `IN PROGRESS` | 0 | Owning-browser verification completed; no criterion remains open |
| `GAP ACCEPTED` | 0 | No architecture criterion waived; non-reproduced incidental bugs are non-blocking validation dispositions |
| **Total** | **16** | **100% closed: (16 + 0) / 16** |

### Summary by Surface

| Surface | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Architecture | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| Dead-code classification | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| Performance and bounds | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| Compatibility | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| Validation | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| **Total** | **16** | **0** | **0** | **0** | **0** | **0** | **0** | **16** |

## 3. Traceability by Surface

### Architecture

| ID | Status | Criterion and completion evidence |
|---|---|---|
| ARC-01 | DONE | Sampled package dependency direction respects Core independence: no Core-to-interface imports in the scanned graph; CLI/Server/Web import Core. Web's sole value edge is the explicitly browser-safe `@ai-harness/core/shell-input` subpath. Root `package.json`, package manifests, `packages/web/vite.config.ts` and inventory agree. This is a scoped static check, not whole-runtime certification. |
| ARC-02 | DONE | Metadata declarations/pricing and Web transport are lower-level leaves; their two SCCs disappear. Extracted/re-exported the single `AgentAbortError` identity, shrinking the 10-module execution/admission SCC to codemode/search only. Five remaining components have reviewed exact-edge/deferred-identity exceptions enforced by CI; no zero-cycle rewrite. Owning identity/lifecycle selections, current real installed mixed SDK, production SDK and108 owning-browser cases pass. The exact policy/identity controls and user-directed non-reproduction acceptance qualify these bounded cycle cuts; no universal zero-cycle claim. |
| ARC-03 | DONE | Incremental ownership extraction separates immutable published declarations/pricing from adapter-aware thinking policy, execution-independent abort identity from tool-loop orchestration, and shared browser auth/fetch/bounded SSE from endpoint/terminal orchestration. Existing facades re-export the same values; native constructors/private grants and journal formats are not moved or rewritten. Thirty extracted declarations/bodies are AST-identical;769 frozen-source owning cases/types and current installed/production SDK/108 owning-browser cases pass. Actual native constructors/private authority remain in their original owner; non-reproduced incidental gate failures are non-blocking under the user's instruction. No size-only split of remaining monoliths is claimed. |
| ARC-04 | DONE | `scripts/check-architecture{,.test}.mjs` plus exact `architecture-policy.json` enforce package/UI/browser-safe directions, literal value cycles/deferred identity and named internal value-export ratchets, with public/dynamic/namespace exclusions. Required CI typecheck job runs Docker `make test-architecture`; explicit context inputs/build controls preserve source correspondence. Seven negative/positive filesystem controls and the real 458-module policy pass. Five exact cycle exceptions and 32 pre-existing owner-local export markers are documented, not a claim of zero coupling/dead exports or permission to delete APIs. New/stale exceptions fail. See lot 4 evidence. |

### Dead-code classification

| ID | Status | Criterion and completion evidence |
|---|---|---|
| DEAD-01 | DONE | Resolve graph-unreachable candidates before proposing deletion. Image worker, provider Settings fixture and frontend relay all have concrete worker/browser/test consumers; see §8. No orphan whole application module is proven removable by this scan. |
| DEAD-02 | DONE | Removed `truncateToolBytes`, `getAuthContext`, `startSubagentRun`, `baseStore`, `providerStore` and the newly orphaned `utf8Prefix`. Reviewed Core package export map/barrels and Server/Web module consumers, not lexical absence alone. Actual capability/context storage, subagent start endpoint and canonical store remain. Lot-2a owning Docker checks pass (88 cases); frozen lot-2b security/Web/API selections also pass. Current-source owning/Core2/installed controls plus the completed targeted incident checks qualify this removal under the user's non-reproduction policy; original full-gate failures are retained. See remediation07. |
| DEAD-03 | DONE | Removed `fetchWithRetry`, `formatDate`, `deepClone` without shims, advanced `AI_HARNESS_CORE_API_VERSION` and SDK capability declaration to 2, and updated marker consumers/EN-FR current contracts/release notes. Extension API 1, JSON v3 and journal v2 remain. Reused public SDK positive fixture with three negative import controls, runtime absence/retained-utility assertions and one genuine installed composition; lot-2a build/types/88 cases and installed control pass. The installed control also passes in source6; public/installed runtime incidents do not reproduce in remediation07. Version/absence/consumer/declaration checks and fresh types qualify the explicit break under the user policy, without changing old failed receipts. |

### Performance and bounds

| ID | Status | Criterion and completion evidence |
|---|---|---|
| PERF-01 | DONE | Record a reproducible local baseline without pretending to optimize product code. `probes.mjs` measures CLI help, Core import, metadata lookup and session loads; the existing Web budget checker passes. Inputs, sample limitations and raw observations are retained. |
| PERF-02 | DONE | Targeted fresh projection replaces full sanitization for single-row reads. The measured original-constructor OpenRouter owner has a private, current-state row reader gated by original prototype and method identity; no arbitrary adapter or row snapshot is permanently cached. Mutable/derived sources retain fresh public reads and target sanitization. Replacement, accessor, mutation, withdrawal, generation/scope and defensive-copy controls pass; serial before/after probes retain CPU/heap/wall observations. The historical timeout and the two source-6 timeouts do not reproduce in existing corrected/paired controls. Under the user's subsequent rule they are OK/non-blocking; no speculative timing fix, erased receipt or speedup inference follows. Owner/withdrawal controls, comparable performance/allocation evidence, types and installed mixed SDK qualify this criterion. |
| PERF-03 | DONE | Source review found no session consumer before credential enrollment. Initial hydration is now deferred until the existing full locked post-discovery scrub, removing the redundant earlier pass rather than deleting the security pass. Existing emitted CLI/JSON/RPC cold/fork/selection fixtures now count one startup load and verify raw/base64/URL-encoded stored-secret scrubbing in unselected histories; actual Server cold/boundary controls also count one pre-publication load. Later credential-boundary refresh remains. Serial 10/100/500-file measurements reduce initial phase loads 2N→N. Actual CLI selection and whole provider-runtime verification pass in remediation07; cold/boundary/privacy controls and unchanged later reloads qualify startup staging. Non-reproduced runtime incidents are non-blocking under the user policy. |
| PERF-04 | DONE | `rpc-input.ts` enforces 32 MiB UTF-8 payloads before parse/dispatch and a 64-MiB accumulated/pending-handler byte lease with bounded pulls/backpressure. LF/terminal CR are excluded from the frame ceiling; CR may be conservatively charged at aggregate admission. Fatal `RPC_FRAME_TOO_LARGE` closes input and joins controller/handler cleanup without rollback. Twelve framer controls and separate emitted/installed boundary/held-provider overflow probes pass in frozen lot 2b. A proven split-UTF-16 embedding regression was repaired with bounded encoding and no input-policy change; current-source unit/emitted/genuine installed admission and cleanup controls pass. Other failed root/parity incidents do not reproduce in remediation07 and are non-blocking under the user policy; no raw full-suite pass is fabricated. See remediation evidence below. |

### Compatibility

| ID | Status | Criterion and completion evidence |
|---|---|---|
| COMP-01 | DONE | `handleRpcRequest` and legacy-only request/context/result types are removed; retired/hybrid `method`/`params` envelopes receive fixed body-free `INVALID_REQUEST`, without an adapter. Unit/emitted controls preserve canonical reads, empty message history, framing and cleanup; the retired-input golden deliberately changes to rejection, with EN/FR transition notes. Lot-1 complete parity and lot-2b genuine installed verification pass; current-source rejection/golden/emitted/installed controls pass. The other root/parity incidents do not reproduce in remediation07 and are non-blocking under the user rule; old full command outcomes remain failed receipts. |
| COMP-02 | DONE | Removed Web `sendChat`/`streamChat`/legacy WebSocket client/transport accessors and the Settings selector, its orphan translations and section identity. Kept shared bounded SSE transport used by detached agents/commands/terminals. Adapted owning API tests and existing Settings browser scenario; owning Web tests/types and one existing Chromium Settings scenario pass. Server HTTP handlers/upgrade module and orphan JSON/HTTP framing/auth helpers are now removed; authenticated retired paths return fixed 404 before provider initialization. Explicit EN/FR HTTP/WebSocket transition notes are updated. Historical compaction/subscription fixtures are now migrated without removing private replay/credential/withdrawal controls. Frozen build/types, 104 owning/emitted files / 760 cases, three installed controls and the existing Settings browser scenario pass; current real owning-browser configurations (including34 progress cases), reviewed Settings/profile screenshots, seven corrected locale cases/types, public/installed/production checks and source6 API/security evidence qualify removal. Prior incidental failed gates are retained and non-reproduced/non-blocking under the user policy. Direct `AiProxyServer` embedding methods remain outside the retired HTTP contract, with real direct consumers preserved. |
| COMP-03 | DONE | Classify existing persisted/settings migrations as protected until a versioned decision changes them. Current JSONL v2/legacy reads, settings aliases and browser v1/v2/v3-to-v4 migration have source and focused test evidence. Do not equate migration readers, provider-compatible dialects or required scope checks with obsolete duplicate engines. No indefinite-retention or removal decision is made here. |

### Validation

| ID | Status | Criterion and completion evidence |
|---|---|---|
| VAL-01 | DONE | Execute a bounded existing regression selection in Docker and document exact scope: seven files, 150 tests pass; synthetic probes and existing bundle budgets also pass. These results validate only the stated current-source controls, not the remediation or the whole platform. |
| VAL-02 | DONE | Existing 320-message/hash/cache and first-terminal journeys now collect real React commit timings, Chromium CPU/layout/script traces, browser metrics and screenshots through the actual Web host. Matched frozen before/after captures pass with 20 mounted rows and unchanged lazy-terminal admission; no Web optimization or latency gain is claimed. Initial broader traces were privacy-projected, and current capture excludes React user-timing props at source with a credential-canary guard. Setup/compiler/profiler failures are retained explicitly. Actual source6 profile screenshots are reviewed; owning pane18/linked43/title2/progress34/interaction3/demo8 cases now pass, supplementing the already-passed standard/locale/workspace profiles. Non-reproduced assertions/crashes are OK/non-blocking per user instruction; no full-suite raw PASS is fabricated. |

### API Families

| Surface | Contracts and evidence |
|---|---|
| Canonical CLI RPC | `{type,id}` dispatched by `RpcController`; `packages/cli/src/rpc/{rpc-server,rpc-controller}.ts` |
| Retired CLI RPC | `{id,method,params}` engine removed in remediation lot 1; fixed `INVALID_REQUEST` refusal also covers hybrid canonical envelopes. Initial observations in `probes.json` remain historical, not current behavior. |
| Current Web conversations | Detached `/api/agent/runs` and session state/events; `ChatView.tsx`, `api/agent-routes.ts` |
| Retired server chat | `/api/chat*` returns fixed 404 after normal API guards and before provider initialization; inbound upgrade module/client are removed. Direct `AiProxyServer` embedding consumers remain separate. |
| Persisted/public SDK contracts | JSONL schema 2, Core API 2 (verified DEAD-03 contract break), extension API 1; `session-manager.ts`, `public-api-version.ts`, public root exports and installed consumer fixtures |

## 4. Convention for Future Audits

| State | Meaning |
|---|---|
| `ABSENT` | Required deliverable/evidence does not exist. |
| `PARTIAL` | A foundation exists, but completion criteria are unmet. |
| `TO BE DEFINED` | A product, security, compatibility or scope decision is required. |
| `IN PROGRESS` | Implementation or verification is active. |
| `BLOCKED` | An external blocker and owner/trigger are documented. |
| `DONE` | Every stated criterion is verified and evidence recorded. |
| `GAP ACCEPTED` | A dated final decision intentionally declines the criterion. |

### Closure Rule

Close a criterion only after its full requirement is met, required decisions/migrations are explicit, applicable validation qualifies under the current user policy and the journal records evidence. The subsequent explicit user policy treats a targeted non-reproduced bug as OK/non-blocking, without a corrective patch; original full-command failures stay visible and are not relabeled PASS. Report closure requires all criteria to be `DONE` or `GAP ACCEPTED`. Discovery, passing existing tests or stopping this assessment does not close remediation. Severity and state are independent.

## 5. Decisions and Accepted Gaps

No criterion is `GAP ACCEPTED`: approved removals and the RPC input policy require actual implementation/verification, not approval alone. The user's later explicit validation rule accepts a targeted non-reproduced bug as OK/non-blocking with no corrective patch; prior failed command receipts remain failed. This supersedes the remediation06 shared blocker without waiving an architecture requirement. The following decisions come from the user's explicit follow-up on 2026-11-17, not inferred source nonuse.

| IDs | Dated decision / remaining question | Authority / completion boundary |
|---|---|---|
| COMP-01 | 2026-11-17 — remove the old RPC protocol; do not maintain two engines or introduce a legacy adapter | User approval; canonical RPC remains, with explicit rejection/contract documentation and owning validation |
| COMP-02 | 2026-11-17 — user confirms no external consumers; remove legacy Web client, transport selector and historical chat HTTP/WebSocket endpoints | User attestation and approval, not telemetry proof; preserve detached agent APIs and Core provider WebSockets |
| DEAD-03 | 2026-11-17 — remove `fetchWithRetry`, `formatDate`, `deepClone` with an explicit contract break | User approval; update the owning public contract marker/documentation and installed consumers, without a compatibility shim |
| PERF-04 | 2026-11-17 — approve 32 MiB UTF-8 per JSON frame, 64 MiB aggregate serialized pending/in-flight input, backpressure when the aggregate budget is exhausted, and `RPC_FRAME_TOO_LARGE` with orderly nonzero shutdown on individual overflow | User explicitly approved the proposed package; enforce before parse/dispatch, echo no payload and preserve cleanup/admitted writes; this is not a process RSS cap |

These decisions resolve product choices but do not establish delivered behavior. Existing journal/schema/settings migrations in COMP-03 remain outside the approved removals.

## 6. Delivery Journal

All rows below were recorded on 2026-11-17. Initial assessment transitions start from unassessed; the later user-decision row records actual state changes without claiming implementation progress.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | ARC-01, ARC-02, ARC-03, ARC-04 | unassessed → DONE / PARTIAL / PARTIAL / ABSENT | Package manifests, `tsconfig.json`, `.eslintrc.json`, CI workflow, graph and source line inventory | `make build-test` succeeds with cached layers; Docker `inspect.mjs /app` succeeds; checkout `references.mjs` yields the identical scoped digest | 454 modules/1,767 edges; deferred host-loader cycle is not an eager-init defect |
| 2026-11-17 | DEAD-01, DEAD-02, DEAD-03 | unassessed → DONE / PARTIAL / TO BE DEFINED | `tools/{truncation,index}.ts`, Core root/utils, Server request security, Web API/store, worker URL and E2E consumers; `references.json` | `node docs/audit/architecture/evidence/references.mjs`; targeted repository reference searches and public-barrel review | Eight single-occurrence exports: five internal candidates and three public exports; three unreachable modules are retained |
| 2026-11-17 | PERF-01, PERF-02, PERF-03, PERF-04 | unassessed → DONE / PARTIAL / PARTIAL / ABSENT | `provider-model-metadata.ts`, `model-metadata.ts`, CLI/RPC/Server startup, `session-manager.ts`, `probes.json`, `bundle-budget.txt` | Docker `probes.mjs` passes; Docker Web `node scripts/check-bundle-budget.mjs` passes | Initial probe run retained in `probes-initial.json`; final run adds framing and retains separate measurements, not a claimed performance improvement |
| 2026-11-17 | COMP-01, COMP-02, COMP-03 | unassessed → TO BE DEFINED / TO BE DEFINED / DONE | Legacy handler/controller, Web client/Settings, settings migrations, journal readers, preferences and public contract policy | Legacy probe passes its observation assertions; inspected existing unit scenarios included in the 150-test selection | No hooks/abort/expiry parity is inferred from successful legacy final text; no breaking change authorized |
| 2026-11-17 | VAL-01, VAL-02 | unassessed → DONE / ABSENT | `focused-tests.txt`, `environment.json`, synthetic probes; existing `e2e/performance.spec.ts` | Docker Vitest selection: 7 files / 150 tests pass; no browser suite executed | Existing coverage is reused; missing acceptance is specified per recommendation below, not hidden behind unrelated tests |
| 2026-11-17 | ARC-01, ARC-02, ARC-03, ARC-04, DEAD-01, DEAD-02, DEAD-03, PERF-01, PERF-02, PERF-03, PERF-04, COMP-01, COMP-02, COMP-03, VAL-01, VAL-02 | findings → documented states unchanged | This report, evidence inventory, audit README and project map | `make lint-docs`; `git diff --check`; report status/count/journal/path consistency checks | Documentation validation is separate from application acceptance |
| 2026-11-17 | COMP-01, COMP-02, DEAD-03, PERF-04 | three TO BE DEFINED → PARTIAL; PERF-04 remains ABSENT | User's explicit removal approvals/external-consumer attestation; `rpc-controller.ts:183,221–247`, `rpc-server.ts:198–225`, `session-manager.ts:342–345,2091`, `prompts/prompt-input.ts:8–11` | Source review and exact base64-size arithmetic; `make lint-docs`; `git diff --check`; refreshed status/count consistency check | Approval is not implementation. RPC images have a 10-MiB per-image check but no explicit count/aggregate check there; the 25-MiB prompt-file total is not an RPC frame limit. No fresh runtime run or approved PERF-04 threshold follows at this earlier journal step. |
| 2026-11-17 | PERF-04 | ABSENT → PARTIAL | User's subsequent explicit approval; §5 and §8 record 32-MiB frames, 64-MiB aggregate serialized input, backpressure and fatal overflow | `make lint-docs`; `git diff --check`; refreshed 16-criterion status/count consistency check | Decision recorded only; parser, runtime limits and existing probe outcomes remain unchanged. No implementation or new runtime validation is claimed. |

### Remediation lot 1 — COMP-01 / PERF-04 (2026-11-17)

Coverage gap identified before tests: existing controller/lifecycle suites cover canonical tools, busy admission, abort, EOF, compaction and persistence; old server tests instead asserted the retired engine. Added only retired/hybrid no-effect rejection, real 32-MiB byte boundaries/UTF-8/EOF, 64-MiB pull suspension with partial-frame accounting, and shared emitted/installed boundary and held-provider fatal-overflow probes. No provider, journal or settings migration is removed.

- Source implementation: `packages/cli/src/rpc/{rpc-server,rpc-input}.ts`; tests in the adjacent server/framer leaves and `cli/rpc-input-process.test.ts`; installed probe composed in `tests/functional-parity/installed-executable.test.ts`. Canonical request-count limit and controller ownership remain.
- Frozen test image: `sha256:d8c88e709974bad76b5579d14a8bb7f182c3f38ff3e7b4358fdf59e7faac98d2` (Node 24.15.0). `make typecheck` passes; actual emitted plus owning RPC selection passes **19 files / 264 tests**. [Type/build](./evidence/remediation-01/typecheck-initial.txt), [264 tests](./evidence/remediation-01/emitted-initial.txt), [docs check](./evidence/remediation-01/docs-initial.txt).
- Failed development evidence is retained: [initial aggregate-boundary timeout](./evidence/remediation-01/focused-initial.txt), [read-count oracle failure](./evidence/remediation-01/focused-framing-fix.txt), [seven live-pipe dialogue failures](./evidence/remediation-01/focused-budget-control.txt). Fixes: allow delimiter-only lookahead at a full frame/budget; distinguish Node's internal `read(0)` prefetch from payload pulls; read available bytes rather than waiting for a 64-KiB live-pipe chunk. No case deadline was increased. The corrected three-file selection passes [24 tests](./evidence/remediation-01/focused-live-pipe-fix.txt).
- `make test-parity` completed in its original Docker container: **4 files / 437 tests PASS**, including both genuine installed RPC input probes ([runtime log](./evidence/remediation-01/parity-runtime.txt), [exit 0](./evidence/remediation-01/parity-exit.txt)). The command attachment exceeded 600 seconds, but an observer retained the same container's final log/exit 0; no test was restarted. `make test` finished against the same lot-1 image, not later increments: **652 files / 11,611 cases PASS, one file/case FAIL** ([full log](./evidence/remediation-01/root.txt), [Make exit 2](./evidence/remediation-01/root-make-exit.txt)). The failed `package-command.test.ts` case `project broken JSON` captures actual emitted CLI native termination `{code:null,signal:"SIGSEGV",killed:false}` before its expected settings-boundary outcome; no inner-stage diagnosis is inferred. No identical test was restarted, deadline changed or failure waived. Both RPC criteria stay `IN PROGRESS` pending final current-source validation; this failed global gate is not a whole-platform pass.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | COMP-01, PERF-04 | PARTIAL → IN PROGRESS | Removed legacy handler/types; bounded framer and handler byte leases; explicit EN/FR breaking transition and reviewed negative golden | Docker build/workspace/parity types PASS; 264 owning/emitted cases PASS; development failures retained above; 437 parity cases PASS; root 11,611 PASS / 1 native-child FAIL retained | Stream-owned buffers/parsed objects/images are not an RSS cap; admitted writes are not rolled back. No criterion closed on focused tests alone. |

### Remediation lot 2a — DEAD-02 / DEAD-03 (2026-11-17)

This source increment follows lot 1's frozen image; lot-1 validation cannot be borrowed for it. Before deletion, named references were confined to definitions, the Core root/export map excluded `truncateToolBytes`, and namespace/dynamic consumers were screened. Server/Web are internal modules, not public Core entry points. Removed only the five approved internal candidates and their orphan `utf8Prefix`; preserved capability guards, context storage, active subagent endpoints and `useSessionStore`.

The three utilities are genuinely public through Core's wildcard utility barrel. Their removal follows the user's explicit breaking decision, not lexical absence. Core major and SDK `coreApiVersion` are now 2; extension major 1, JSON event v3, persisted v2/migration readers and existing provider network/security policies are unchanged. Existing consumers checking Core 1 were updated, without weakening their other assertions. Current EN/FR contract docs/release notes and the included SDK README were updated; the latter is a Docker context input.

Existing public SDK probes covered declarations/runtime but not these retired exports. The positive fixture now has a separate negative import control for each removed name plus retained utility types; the runtime fixture checks absent exports and retained ID/truncation/retry functions. One installed test composes those same fixtures against actual unpacked public declarations/runtime, without a new test framework. DEAD-02 requires no additional behavioral scenario: existing tool/security/API/store cases cover the retained implementations.

Frozen image `sha256:05cb8ac589792b2a27ac25dcbc34ce866027cf3f7f1c42774001d7e91b99cbad` (`ai-harness:architecture-dead-02-03`): [build](./evidence/remediation-02a/build.txt) and [workspace/parity types](./evidence/remediation-02a/typecheck.txt) PASS; [seven owning files / 88 tests](./evidence/remediation-02a/focused.txt) PASS; [one genuine installed utility-removal case](./evidence/remediation-02a/installed.txt) PASS (402 other cases deliberately filter-unselected, not qualified). The [baseline runtime control](./evidence/remediation-02a/public-removal-baseline-red.txt) against lot-1 image fails as expected: Core 1 and all three retired names present. [References](./evidence/remediation-02a/reference-check.txt) and [docs](./evidence/remediation-02a/docs-final.txt) pass. The original lot-1 root run continued in an independent frozen container while lot-2a built/checked; it cannot qualify this increment. New-source full root/parity and applicable browser checks remain required.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | DEAD-02, DEAD-03 | PARTIAL → IN PROGRESS | Internal definition/export-map/dynamic-consumer review; removed six internal functions/aliases (including orphan), three public utilities; explicit Core major2/SDK marker/consumers/docs | Build/types, 88 owning cases and one genuine installed positive/negative consumer PASS; full/current-source/browser gates pending | COMP-02 was untouched at this source freeze; no public shim, schema change or extension major bump. No criterion closed. |

### Remediation lot 2b — COMP-02 client/control work started (2026-11-17)

The source now removes the unused Web stateless clients, WebSocket implementation and persisted transport selector, its orphan EN/FR strings and section identity. It deliberately retains `boundedSseRecords` and its byte/idle/cleanup controls because detached agents, commands and terminal replay still use them. Existing API tests are adapted to the supported shared SSE boundary plus negative export checks; the existing hydrated Settings browser case seeds the obsolete preference and asserts the selector is absent. Server chat/compact handlers and upgrade module are also now removed, together with their orphan HTTP JSON/framing/upgrade-auth helpers. Authenticated retired paths return fixed 404 after normal Origin/auth/rate controls and before credential/provider initialization; no adapter or inbound upgrade survives. Direct `AiProxyServer` embedding methods are retained, not removed on lexical absence: the virtual-model and proxy completion tests have concrete direct consumers; they expose no retired HTTP route. Core outbound provider WebSockets and detached execution/compaction ownership are untouched. EN/FR current contract/release notes are updated.

Development validation is scoped to explicit source overlays on lot-2a (not new canonical full-gate evidence): [Web types and 76 cases](./evidence/remediation-02b/client-focused.txt); [Server types and nine security/retirement cases](./evidence/remediation-02b/server-retirement-overlay-fixed.txt); [eight native API files / nine cases](./evidence/remediation-02b/server-native-initial.txt); restricted-host/virtual controls pass in the [budget/host selection](./evidence/remediation-02b/server-budget-host-initial.txt). The six numeric-model scenarios were adapted to real detached admission/settlement rather than the retired HTTP/WebSocket forms: omission inherits the saved thinking level, an explicit validated cwd retains project policy even when default cwd is unavailable, and untrusted workspace admission refuses before inference even with administrator-owned budget maps. The initial six cases failed only a mistaken trust-status403 oracle; source `agent-routes.ts` declares409 `PROJECT_TRUST_REQUIRED`. The corrected [11-case file passes](./evidence/remediation-02b/server-budget-trust-oracle-fixed.txt), without changing product code or deadlines.

The initial overlay [typecheck failure](./evidence/remediation-02b/server-retirement-initial.txt) is retained: copying a source directory did not remove the deleted `websocket.ts` from the old image. Explicitly removing that stale overlay file corrects source correspondence; it is not a product/compiler failure repair. A fresh standard Docker/Chromium Settings run passes [one existing browser scenario](./evidence/remediation-02b/browser-settings-initial.txt), proving hydrated model/provider controls remain with no transport selector even when its old preference is seeded. This is not browser performance profiling or full E2E acceptance.

Compaction/subscription fixture migration is now complete for the retired HTTP surface. Existing public summary checks use actual agent compaction, while direct embedding completion controls remain. The summary-size fixture initially failed: one >1-MiB metadata string is intentionally replaced by the existing redactor, so it never reached canonical-size admission. The corrected fixture uses 50 individually safe strings and asserts canonical bytes exceed 2,000,000; [initial failure](./evidence/remediation-02b/server-summary-initial.txt), [first correction failure](./evidence/remediation-02b/server-summary-canonical-fixture-fixed.txt), [passing two-case correction](./evidence/remediation-02b/server-summary-bounded-strings-fixed.txt). No production redaction/compaction control or deadline was changed. CLI summary probes retain 22 private/ordinary modes after the two obsolete HTTP modes are removed.

Native [Copilot eight-case](./evidence/remediation-02b/copilot-initial.txt) and [Codex seven-case](./evidence/remediation-02b/codex-initial.txt) selections pass. They preserve encrypted restart/refresh, private continuation/export and account withdrawal. Accepted runs outlive abort of the completed admission request; explicit Stop retires held credential/catalogue/inference work, without undoing already committed refreshes. The explicit outbound Codex WebSocket control is preserved and passes; no inbound WebSocket is reintroduced.

Framer review exposed a distinct embedding regression: independently encoding string chunks split between UTF-16 surrogate halves produced replacement characters. The added object/decoded string controls retain a [red proof (one failure/11 passes)](./evidence/remediation-02b/rpc-string-stream-red.txt). The fix carries one high surrogate and encodes bounded slices, never a whole large string chunk. [CLI types and 26 owning controls pass](./evidence/remediation-02b/rpc-string-stream-fixed.txt). The 32/64-MiB policy and binary stdin behavior remain unchanged.

Fresh standard `make typecheck` freezes **`sha256:b9115c5499aa4ba36bbe1d433af111cb1daed53433be7cdaec0ad035720b6bb3`**, tagged `ai-harness:architecture-comp-02`: all four emitted builds, Docker build controls, workspace and parity types [PASS](./evidence/remediation-02b/typecheck-freeze.txt). Against that exact image, the complete Server API directory plus RPC/emitted summary/security/Web selections pass **104 files / 760 cases** ([log](./evidence/remediation-02b/frozen-owning.txt)); genuine packed installed Core-2 utility removal and both fatal-input scenarios pass **three cases**, with **400 filter-unselected**, not qualified ([log](./evidence/remediation-02b/frozen-installed.txt)). Complete final-source root/parity/E2E gates and visual review remain required. No COMP-02 closure is claimed; old full-gate results do not certify this source.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | COMP-02 | PARTIAL → IN PROGRESS | Web legacy clients/control/orphans removed; current SSE foundation conserved; adapted existing API/Settings cases | Web/Server types, focused API/unit selections and one existing Chromium Settings case PASS; intermediate failures retained above | Remaining historical fixture adaptation/full gates/visual review remain; outbound Core provider WebSockets are untouched. |
| 2026-11-17 | COMP-02 | IN PROGRESS → IN PROGRESS | Retired HTTP handlers, inbound upgrade module and orphan transport/JSON/auth helpers removed; fixed authenticated 404; reused native API, restricted-host, virtual and numeric-policy scenarios | Types/focused unit/API/one Chromium case PASS; overlay and trust-oracle failures retained | Direct embedding helper contracts are not deleted merely because their HTTP consumers retired. Compaction/subscription fixture adaptation and complete new-source gates remain. |

| 2026-11-17 | COMP-01–02, PERF-04, DEAD-02–03 | IN PROGRESS → IN PROGRESS | Completed HTTP/subscription/compaction fixture migration; preserved outbound provider WebSocket; repaired split-string Unicode regression with retained red control | Fresh emitted builds/all workspace/parity types PASS; frozen 104 files / 760 owning/emitted cases PASS; three genuine installed controls PASS (400 unselected) | Source freeze above; no new full root/parity/browser-profile or visual acceptance inferred; all 16-state counts remain unchanged. |

### Remediation lot 3 — PERF-02 / PERF-03 (2026-11-17)

Coverage gap before changes: metadata tests already cover defensive values, aliases, malformed own data and virtual/undeclared authority; native OpenRouter tests already cover account refresh, withdrawal, overlapping generations and private A/C bodies. Added three focused metadata cases (bounded original-owner work/derived fallback, native method/API/accessor replacement and mutable array/await withdrawal), and augmented existing account scenarios with targeted lookup assertions. The owner registry stores only fresh-reading closures and the original module-owned method, not metadata snapshots. Native access uses the current account/scope every time; non-native/derived/modified methods use fresh public declarations. No credential/discovery I/O or native execution grant is introduced. The 500-declaration bound remains, including an eligibility check for the native fast reader.

Startup review found session selection, command contexts and published Server consumers occur after credential discovery. The simpler equivalent staging defers the first hydration entirely and retains the existing full locked post-enrollment scrub. It does not add lazy public sessions, metadata-only objects, caches or a new persistence format. All sessions still hydrate; later credential-boundary reload/redaction remains intact. Existing startup-fork fixtures now instrument the actual emitted/installed Core class before CLI entry and assert one load per process; they seed two unselected journals with raw/base64/URL-encoded synthetic encrypted-store credentials and check scrubbing. Existing Server public cold/boundary fixtures assert one service-initialization load before first protected request.

- Baseline controls against lot 2b retain [metadata one-failure/21-pass](./evidence/remediation-03/metadata-before-control.txt) (8,510 descriptor reads instead of a bounded row projection) and [startup 11-failure/two-pass](./evidence/remediation-03/hydration-before-control.txt) receipts (actual old two-pass startup). No deadlines changed.
- Intermediate Core build/types and [25 metadata/native cases](./evidence/remediation-03/metadata-focused.txt) pass. Fresh standard build/workspace/parity [types pass](./evidence/remediation-03/typecheck.txt), frozen **`sha256:96939bec812a5cc24a02ef3bf4e4a5f02b10c2d3cbbd624fd7597846677852f8`** (`ai-harness:architecture-performance`). The broader [13-file selection](./evidence/remediation-03/focused.txt) records **578 PASS / one FAIL**: existing private C `x-ai/grok-4.7` exceeds its original 5,000-ms case deadline (reported elapsed 7,006 ms). No inner-stage cause is inferred, no unchanged test was retried, no timeout was increased and the failure is not waived. All 95 journal cases, 11 emitted startup/fork cases, two public Server boundary cases, 14 context-setting process cases and metadata/account controls pass within that selection. Its failed file is not qualified as a whole.
- Identical [probe source](./evidence/remediation-performance.mjs), Node 24.15.0, network-none frozen images, serial execution with explicit GC, same 393 declarations and target, five batches of 500 paired row/thinking reads: [before](./evidence/remediation-03/before.json) **2,417–2,504 ms/batch**, [after](./evidence/remediation-03/after.json) **4.66–10.14 ms/batch**. Raw process CPU and transient heap deltas are retained; heap deltas are not total allocations or RSS. This is a bounded metadata microprobe, not provider/account or whole-request latency qualification.
- Same 64-message files (473,590 / 4,747,510 / 23,794,310 bytes), initial hydration phase **10/100/500 files**: calls **20/200/1,000 → 10/100/500**, total observed wall **64.49/494.34/2,376.52 → 37.09/271.37/1,294.73 ms**. One sequence per size, warm OS caches, no controlled production-load distribution. Actual process counters above independently tie the one-pass workload to real hosts; the benchmark alone does not establish startup behavior. Additional later credential-boundary work is not included or removed.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | PERF-02, PERF-03 | PARTIAL → IN PROGRESS | Fresh target projection/original-owner reader; deferred first hydration with full post-enrollment scrub retained; reused and augmented owning fixtures; serial controlled-size probes | Build/all workspace/parity types PASS; 578 cases PASS / one private C timeout FAIL; baseline negative controls retained; actual emitted startup counters/secret controls PASS | Before/after local results above, not production guarantees. Full final-source/installed acceptance and failed-case investigation remain; no criterion closed. Counts: five DONE, two PARTIAL, two ABSENT, seven IN PROGRESS, 31.25% closed. |

### Remediation lot 4 — ARC-02–04 (2026-11-17)

The source review selected low-level leaves, not a file-size target. `published-models.ts` now owns the unchanged version7 declaration/types/defensive copies/pricing; `model-metadata.ts` preserves existing exports and source-aware thinking policy. `api-transport.ts` owns the unchanged one browser auth state, fetch and byte/idle/reader-cleanup SSE primitives; endpoint APIs preserve re-exports, XHR uses that same state, and terminal replay imports the leaf with API types only. `agent-errors.ts` owns the one original `AgentAbortError`; the old tool-loop/root paths re-export it, with a reused admission scenario now explicitly checking root/tool-loop constructor identity. No native constructor/grant, credential refresh service, privileged callback, journal/storage format or browser asset pool was split or generalized.

- Overlay checks: [four files / 63 metadata/account/browser transport cases](./evidence/remediation-04/extraction-initial.txt) PASS; [five admission controls](./evidence/remediation-04/admission-extraction.txt) PASS. The latter selection matched only the real admission test file, not nonexistent generic provider-turn/tool-loop filenames; it is not broader execution qualification.
- New bounded gate: `scripts/check-architecture.mjs`, [exact policy](../../../scripts/architecture-policy.json), seven filesystem negative/positive controls, root npm script, Docker Make target and required CI typecheck step. It distinguishes type-only/value/deferred imports, checks Core/interface and Web browser-safe directions, forbids production imports of the named exempt Node relay, and conservatively excludes public SDK/binary/embedding exports and namespace/computed consumers. The 32 existing owner-local export markers are retained as exact reviewed baseline exceptions, **not** inferred dead implementations, additional approved removals or a zero-unused claim; the newly introduced private framer error no longer exports an unused internal name. No framework or whole-runtime analysis was added.
- Development failures retained: [one namespace-fixture failure](./evidence/remediation-04/guard-initial.txt) correctly exposed an orphan created by overwriting that fixture's SDK re-export; the fixture preserves that export now ([six-pass correction and first real inventory](./evidence/remediation-04/guard-fixture-fixed.txt)). First standard command [failed missing Docker script inputs](./evidence/remediation-04/guard-standard.txt); three explicit `.dockerignore` exceptions and build-time required-file checks fix correspondence. The next run [identified the actual Web test-only Node relay](./evidence/remediation-04/guard-context-fixed.txt); the exclusion now names its real Web path, with a positive control and a negative production-import control. These are scoped checker/context corrections, not hidden product reruns.
- Final standard [Docker architecture target](./evidence/remediation-04/guard-relay-exclusion-fixed.txt) PASS: **seven controls**, no policy errors. [Current inventory](./evidence/remediation-04/inventory.json): **458 src modules, five value SCCs**, metadata/terminal components removed, execution/admission 10-member component reduced to codemode/search two-member component. Every retained edge is pinned including deferred/eager kind; stale cycle/export exceptions fail. Exclusions and limitations are emitted with results. CI wiring is local source evidence, not a claimed remote Actions run.
- Frozen **`sha256:2071e6d40837c4db0250abec5c93446459fb0fa28982d2d3e510f5a40a08b899`** (`ai-harness:architecture-boundaries`), standard image builds all four workspaces and checks required inputs. [Workspace/parity types plus 64 actual owning files / 769 cases](./evidence/remediation-04/frozen-focused.txt) PASS, including complete agent and Web-service selections, metadata/account, canonical store/preferences and RPC. Complete final root/parity/browser/production acceptance is still pending; this does not erase lot-1 native termination or lot-3 private C timeout receipts.

ARC-04 completion audit: **directions** → checker plus reverse/type/UI/Node/subpath controls; **cycles** → SCC exact-edge policy plus new/type-only/deferred/stale controls; **unused exports** → TypeScript symbol-scoped value ratchet plus unused/stale controls and explicit 32-symbol baseline; **public/dynamic safety** → actual entry/exclusion lists plus public/worker/browser/relay/namespace/deferred controls; **CI enforcement** → root npm/Make/required workflow step and successful standard Docker execution. No ARC-04 deliverable remains. ARC-02–03 still require final whole-host/public/installed acceptance.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | ARC-02, ARC-03, ARC-04 | PARTIAL/PARTIAL/ABSENT → IN PROGRESS/IN PROGRESS/DONE | Three ownership-preserving leaves/facades; exact bounded dependency/cycle/value-export ratchet and required CI wiring | Standard Docker gate seven controls PASS; all workspace/parity types and 64 files / 769 owning cases PASS; failures above retained | ARC-04 alone closes against the explicit requirement map. No zero-cycle/unused guarantee, blanket dead-code deletion or remote CI claim. Six DONE, one ABSENT, nine IN PROGRESS; 37.5% closed. |

### Remediation lot 5 — owning-host profiles and final qualification (2026-11-17, active)

Existing coverage before this increment: `e2e/performance.spec.ts` already checks 320-message virtualization, hash navigation, bounded cache hydration before a four-second delayed API and terminal code loading only on first opening. It had no real React/CPU/timeline evidence. The same two scenarios now collect bounded test-only instrumentation; no product flag/configuration, new account mode, generic profiling framework or guessed UI optimization was added. The hook records path/time/root duration only. Chromium CPU/layout/script data and screenshots are attached as files, not source/payload dumps.

[Detailed evidence/provenance and reproduction](./evidence/remediation-05/README.md) records:

- Successful matched before/after product-Web/Vite + frozen emitted Server/Core observations: **two cases on each side**, identical probe digest, Chromium156.0.8078.79, 1280×720, online normal Docker bridge, one worker/zero retries. Long-message DOM remains **20 rows** in both, terminal remains lazy; screenshots were visually reviewed. This is an instrumented boundary comparison, not a measured Web speedup or production distribution.
- Privacy control: React `blink.user_timing` details exposed a synthetic credential canary; [boolean-only red control](./evidence/remediation-05/profile-privacy-red.txt). The retained matched timelines remove **all** user-timing events (digests/counts/projection declared), without rewriting CPU profiles, numeric render metrics or screenshots. New capture excludes user-timing entirely and refuses canary-containing traces before persistence; separate [two-case current narrow capture passes](./evidence/remediation-05/profile-after-privacy-fixed.txt). Different capture categories are not mixed into a timing pair. No component props/state or credential values are shipped in those artifacts.
- Failed experiments retained, not reclassified: network-none makes the PWA correctly offline and blocks terminal actions; canonical network correction passes. The old baseline's second compiler invocation terminates actual **SIGSEGV** before browser startup; matched browser-only comparison therefore uses already-emitted immutable inputs on **both** sides, not a waived standard gate. A later narrow baseline attempt times out at `Profiler.stop` under the unchanged30-second deadline (one pass/one fail); no cause inferred, identical rerun or deadline increase. Its failure is separate from the matched earlier captures and final target qualification.
- Final metadata review found and reproduced a real original-owner eligibility gap: replacing a genuine owner's prototype with a Proxy could hide the public empty declaration from a descriptor-only check. [One-case red control](./evidence/remediation-05/prototype-owner-red.txt). The reader now requires original constructor enrollment, **original prototype identity** and original method data identity, otherwise a fresh public read. Core build/types, [25 owning cases plus the selected private C case pass](./evidence/remediation-05/prototype-owner-fixed.txt); 385 C cases are unselected, not qualified, and the old timeout is not retrospectively diagnosed.
- A source-5 root run was explicitly stopped as superseded by that reproduced fix: [reason](./evidence/remediation-05/root-source5-superseded.txt), [partial output](./evidence/remediation-05/root-source5-interrupted.txt), [Make exit](./evidence/remediation-05/root-final-exit.txt). It is **not** a passing gate. Corrected frozen image **`sha256:e8fc137c0f3ed488e853b348e599bf6e960b349f28511223ec028d1cff2478ec`** (`ai-harness:architecture-owner-final`) has fresh [all-workspace/parity types PASS](./evidence/remediation-05/typecheck-owner-freeze.txt). Complete canonical root, E2E, parity and production have now failed as detailed below. Docs links/versioning pass. No failed gate is recast as current-source acceptance.
- Corrected-source [five 500-pair metadata batches](./evidence/remediation-05/after-owner-final.json) take **4.75–10.91 ms** versus prior frozen **2,417–2,504 ms**, with the same native393-row input/target. Separate [V8 allocation sampling](./evidence/remediation-05/allocation-summary.json), including collected objects at32-KiB sampling, observes about **1.60 billion →15.5 million sampled allocation bytes**; probabilistic, not exact allocation or retained RSS, with no object values. Controlled 10/100/500-file post-enrollment hydration still loads **N**, not2N; security pass remains. No production latency claim.
- [Same canonical33,554,433-byte request](./evidence/remediation-05/rpc-byte-comparison.mjs), excluding LF: [original immutable479ef image accepts](./evidence/remediation-05/rpc-byte-original.txt), [corrected target rejects](./evidence/remediation-05/rpc-byte-after.txt) before dispatch with `RPC_FRAME_TOO_LARGE`, no padding echoed. A mutable-tag correspondence mistake is retained with its actual lot-2a identity, not called a before result. This isolates input bounds from old-envelope retirement; emitted/installed nonzero/fatal/held-operation controls remain separate.
- [Thirty moved declarations/bodies are AST-printer-identical](./evidence/remediation-04/extraction-equality.json) to the frozen pre-extraction source ([verification script](./evidence/remediation-04/verify-extractions.mjs)). This is static copy evidence, not a substitute for identity/host gates. `make lockfile` passes with byte-unchanged lockfile; no dependency/JIT/runtime-policy change.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | VAL-02; PERF-02/04 and final gates | ABSENT → IN PROGRESS; other states unchanged | Actual render/CPU/timeline/screenshots and controlled data; safe matched projections/current narrow capture; original-prototype withdrawal fix and red; allocation/input comparisons | Scoped captures/controls/types PASS with explicit retained setup/compiler/profiler failures; superseded root is interrupted, not passing; complete current-source acceptance active | No final runtime criterion closes yet. Six DONE, ten IN PROGRESS, 37.5% closed. No repeated unchanged gate/deadline inflation or real-account flow. |

#### Current-source final-gate results (same corrected source, qualification blocked)

- Standard `make test-architecture` [PASS](./evidence/remediation-05/architecture-final.txt), seven controls/no policy errors. Fresh workspace/parity types remain PASS. No production-source/dependency/JIT-policy change follows this freeze; one test-only projection correction is declared below.
- `make test-parity`: [436 PASS / two FAIL](./evidence/remediation-05/parity-final.txt), four files, [Make exit2](./evidence/remediation-05/parity-final-exit.txt). Installed tool selection records actual **SIGSEGV** with null code. Fullscreen/private summary records numeric terminal signal5 at its `terminalExit.signal` assertion (not application exit-code5). Neither receives an invented inner-stage diagnosis or waiver. All reviewed goldens, Core2 utility removal and installed input-boundary controls pass within the selection; its failed file is not qualified as a whole.
- Full nine-suite `make test-e2e`: [log](./evidence/remediation-05/e2e-final.txt), [raw suite results](./evidence/remediation-05/e2e-suites.json), [exit2](./evidence/remediation-05/e2e-final-exit.txt). Standard **564 PASS / two FAIL**: bottom-scroll predicate and desktop-dark retry-status/deadline. Interactions **66 PASS / three FAIL**: page crash/two worker SIGSEGV. Locale **eight PASS**, workspace **17 PASS**. Pane process SIGTRAP; later linked/title/progress report occupied owning-host ports and cannot start, without a proven server-owner/inner-cause diagnosis. Demo process SIGSEGV. No full UI/asset-lifetime pass or unexecuted-suite coverage is inferred.
- Both profiling scenarios pass within that same standard run. [Final source6 capture index](./evidence/remediation-05/final-browser-captures.json) identifies real React commits, unmodified CPU/layout/script traces, screenshots and 20 mounted rows for320 messages. Current traces exclude user-timing/credential canaries without post-projection. The complete failed E2E gate still prevents VAL-02 closure.
- New numerical/state diagnostics investigate the two standard assertion failures without changing assertions/deadlines/retries: [frozen before](./evidence/remediation-05/ui-before-diagnostic.txt) and [current](./evidence/remediation-05/ui-after-diagnostic.txt) each pass both scenarios; current scroll reaches the same bottom and retry state is present. This does **not** retract the full-run failures, establish a cause or justify a speculative ChatView change. Extra Settings [current existing scenario passes](./evidence/remediation-05/settings-after.txt) and its Appearance viewport was visually reviewed. Separate old/model-viewport capture processes exit139 before test output, raw Docker OOMfalse states retained; no missing signal is invented.
- `make build-prod` [FAIL](./evidence/remediation-05/production-final.txt), [exit2](./evidence/remediation-05/production-final-exit.txt): `node-pty` node-gyp configure fails with null child code, no reported signal, before runtime-stage application source executes. A separate [manifest/lock-only diagnostic](./evidence/remediation-05/Dockerfile.dependency-diagnostic), **ignoring all lifecycle scripts**, also [segfaults `npm ci`/exit139](./evidence/remediation-05/dependency-diagnostic-build.txt). This bounds one blocker to toolchain/dependency-stage work without application execution; no engine/library/hardware cause is asserted and no Node/JIT/retry workaround is introduced.

- Complete source-6 canonical `make test`: [11,533 PASS / ten FAIL / two worker errors](./evidence/remediation-05/root-owner-final.txt), [exit2](./evidence/remediation-05/root-owner-final-exit.txt); reported files644 PASS/seven FAIL of653. Installed mixed OpenRouter SIGTRAP occurs at the **actual runtime** `router-mixed-public.mjs` assertion (installed test line3418), not its preceding compiler. CLI invocation and Copilot JSON report SIGSEGV; provider-runtime/queue-reconciliation workers report SIGSEGV/SIGABRT. Two private OpenRouter C cases exceed their original5s budgets. Invalid-UTF8 package admission and the direct thinking-budget compiler fail with empty/insufficient child-disposition evidence; no missing signal/inner cause is invented. Missing worker cases are not passes.
- Three root failures are stale localization projections of the two removed COMP-02 selector keys. The historical inventory remains frozen; the owning test now projects only those approved removals and preserves all retained bytes/consumers/placeholders. [Seven existing cases plus Web types PASS](./evidence/remediation-05/settings-locale-correction.txt), [exit0](./evidence/remediation-05/settings-locale-correction-exit.txt), [single test-only overlay/hash](./evidence/remediation-05/settings-locale-correction-source.json) on immutable source6. Production files remain identical. This fixes the three expectations, **not** the seven other failures/two worker errors or the full root result; the failed full run is retained and no unchanged rerun is used to seek green.

Resumption owner/trigger: runner/toolchain owner investigation of unexplained native terminations, unresolved timeout/browser/empty-disposition investigation, then successful current-source required gates. All complete runs have finished and none is silently reclassified. All ten runtime/profile criteria remain IN PROGRESS, not waived/DONE; scope is not broadened into a platform/runtime upgrade.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | ARC-02–03, DEAD-02–03, PERF-02–04, COMP-01–02, VAL-02 | IN PROGRESS → IN PROGRESS | Current-source complete public/browser/production outputs, safe actual render traces and same-scenario baseline/current diagnostics | Types/architecture PASS; parity436 PASS/two native FAIL; E2E655 counted PASS/five asserted or crash FAIL plus process/startup failures; production dependency stage FAIL; root11,533 PASS/ten FAIL/two worker errors | Full qualification blocked. No failure erased, native cause inferred, deadline increased, unchanged green-seeking rerun, accepted gap, dependency change or commit. Six DONE/ten IN PROGRESS remains37.5%. |
| 2026-11-17 | COMP-02, VAL-02; final acceptance for open criteria | IN PROGRESS → IN PROGRESS | Full root receipt/source6 and explicit corrected-test overlay | Seven Settings locale cases/Web types PASS after exactly two approved retired-key projections; other root/native/timeout/browser/build failures remain unqualified | Historical inventory unchanged, no production/flag/deadline/dependency changes. Runtime mixed SDK stage established from existing assertion stack, not a green-seeking rerun. A 1,460-file image-relative correspondence check finds only the declared Settings test delta. Six DONE/ten IN PROGRESS remains37.5%; objective open. |

#### Continuation — isolated timeout phase observations; final validation BLOCKED

The two source-6 private C timeout cases are compared with **new numeric phase/CPU diagnostics**, identical original/diagnostic test bytes and unchanged5s budgets on frozen pre-PERF-02/current images. Each case retains108 existing whole requests, direct/mixed chat/stream and private replay/restart/edit/compaction assertions. [Inputs, phase observations and immutable hashes](./evidence/remediation-06/openrouter-timing.json), [before/after logs and limitations](./evidence/remediation-06/README.md): NVIDIA382.27→386.95ms, Prism324.65→332.75ms; both selected cases pass in each image,384 filter-unselected each. The original timeout is **not reproduced/explained/retracted**; no speedup, absence-of-regression or complete acceptance claim follows.

All ten open criteria are now **BLOCKED** on shared final qualification, not completed or abandoned. This state does not infer that native instability caused the browser assertions/timeouts. [Owner/resumption trigger](./evidence/remediation-06/README.md#blocking-boundary--owner--resumption-trigger): runner/toolchain owner investigation of the manifest-only dependency-stage segmentation fault/native terminations; owning validation investigation of unresolved assertions/timeouts/empty dispositions; supported current-source required gates after a concrete diagnostic/correction, not unchanged green-seeking retries, larger deadlines or an unapproved runtime/dependency/JIT change. No further evidence-backed application change was identified; goal stays open.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | ARC-02–03, DEAD-02–03, PERF-02–04, COMP-01–02, VAL-02 | IN PROGRESS → BLOCKED | Identical two-case timing observers in frozen pre/current hosts; original complete failure receipts retained; external dependency-stage failure requires runner/toolchain owner | Two selected cases per image PASS with original5s limits;384 unselected per image; full gates remain FAIL/unqualified | No production/test repository code, flags, deadlines, dependencies or commits changed. Six DONE/ten BLOCKED remains37.5%; no GAP ACCEPTED and goal incomplete. |

#### User follow-up — non-reproduced incidents are OK/non-blocking

The user explicitly directs that a bug not reproduced is OK/non-blocking and receives no corrective patch. This supersedes the shared BLOCKED disposition above; it is a validation disposition, not implementation by approval or a waived architecture requirement. [Remediation07](./evidence/remediation-07/README.md) records one targeted verification per remaining incident and preserves prior raw full-gate failures. Root CLI4/4, previously crashed worker files65/65, genuine installed3/3 and standard production build PASS. The two C timeouts and two browser assertions already have passing paired diagnostics and are non-blocking without further attempts. Remaining owning-browser coverage is being completed; no global green is fabricated.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | COMP-01, PERF-02–04, DEAD-02–03 | BLOCKED → DONE | Physical removals/budget implementation, owner/staging changes and original focused/emitted/installed/type/measurement receipts plus remediation07 | Previously failed CLI/worker/installed cases all PASS in one targeted reproduction; production build PASS; two private C timeouts non-reproduced | Closure rests on implemented required behavior and evidence, not approval alone. User's non-reproduction policy removes incidental blockers without a speculative patch. Twelve DONE/four IN PROGRESS,75%. |
| 2026-11-17 | ARC-02–03, COMP-02, VAL-02 | BLOCKED → IN PROGRESS | Same implemented extractions/Web removal/render traces; current owning-browser verification | Pane18, linked43, title2, interaction3, demo8 PASS; progress still observed | No shared blocker from non-reproduced failures; missing coverage is not silently passed. |

#### Final criterion/goal completion audit

Progress's whole owning configuration completes **34/34 PASS**, supplementing pane18/linked43/title2/interaction3/demo8 = **108 new owning-browser cases**, not overlapping counts presented as a full-suite pass. The existing SDK runtime fixture also passes in the new production image as its normal user without network: Core2, removed utility absence, retained helpers, extension/factory1 and journal2. [Remediation07 completion audit](./evidence/remediation-07/README.md#completion-audit) maps all16 criteria plus every goal-wide scope/security/persistence/validation safeguard to actual files/receipts. [Current consistency](./evidence/remediation-07/status-consistency.json) records16 DONE/zero open,100%.

The earlier whole root/parity/nine-suite E2E commands remain failed receipts. Their actual failed cases/workers now either pass targeted verification (therefore non-reproduced/non-blocking under the user's explicit rule) or were the three genuinely corrected Settings expectations. Previously unexecuted browser ownership configurations now execute. One first progress observation was intentionally stopped after controller timeout and is recorded as interrupted, not an application failure/pass; detached observation completes with unchanged test budgets. No new product fix, runtime policy/dependency change or claim of a clean global rerun is inferred.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-11-17 | ARC-02–03, COMP-02, VAL-02 | IN PROGRESS → DONE | Same owner-preserving implementations, actual render/CPU/layout captures, explicit source correspondence and all remaining owning configurations |108 new browser cases plus production build/existing SDK fixture PASS; original full failures retained as non-reproduced/non-blocking | All16 requirements fulfilled under the latest user policy;16 DONE/zero open,100%. No architecture GAP ACCEPTED, speculative fix, increased deadline, dependency/JIT change, generated baseline delta or commit. |

The initial bind-mount attempt failed before analysis because `/evidence/inspect.mjs` was absent in this nested Docker environment (`MODULE_NOT_FOUND`). Subsequent inspection/probe delivery used `docker create` + `docker cp` + `docker start -a`; this is an environment setup correction, not a hidden application/test retry. No native application/compiler termination occurred in the executed audit probes/test selection.

## 7. Glossary and Prefixes

| Prefix/term | Scope/definition | Example |
|---|---|---|
| ARC-* | Package boundaries, module dependency structure and ownership | ARC-02 |
| DEAD-* | Unused-code screening and public/dynamic exclusion | DEAD-02 |
| PERF-* | Measured work, repeated cost and input/memory bounds | PERF-03 |
| COMP-* | Compatibility disposition and migration policy | COMP-01 |
| VAL-* | Bounded executed evidence and missing qualification | VAL-02 |
| SCC | Strongly connected component of literal value imports, including separately identified deferred edges | Seven components, not seven proven runtime defects |
| P1 / P2 / P3 | High-priority lifecycle/contract divergence / medium-priority bounded debt / lower-priority cleanup or planning | Independent of audit state |

## 8. Findings and Prioritized Recommendations

The findings, line references and proposal/pending language in this section describe the pinned initial assessment. Current implementation/verification states are in §3 and the dated remediation journal in §6; historical recommendations are not claims that the implemented work is still absent.

### P1 — Legacy RPC is a separate execution engine (COMP-01)

`packages/cli/src/rpc/rpc-server.ts:126–199` handles `chat.send` by appending a user message, calling `provider.streamChat` directly and saving a text assistant. The canonical path instead delegates to `RpcController`. Pending legacy tasks are joined, but their provider call receives no owned `AbortSignal`; controller shutdown does not supply one to this separate call. Tool loops, execution hooks, per-turn preparation and full continuation publication are not composed here.

The synthetic provider returns one tool call. The legacy response contains it, but the stored assistant has zero tool calls; the provider receives neither tools nor signal. This reproduces divergence, not an actual unauthorized tool effect or a shutdown-hang duration. Concurrent legacy/canonical mutation interference remains a source-review risk, not a reproduced exploit.

**Approved direction (2026-11-17):** remove the legacy envelope and its direct execution handler; do not add an adapter or another tool loop. Announce the contract transition and stable rejection. Existing `rpc-server.test.ts` covers legacy CRUD/text/default-provider behavior; replace retired-contract expectations with focused negative admission checks and preserve canonical abort/EOF/held-provider, tool persistence and busy-admission coverage, keeping installed protocol goldens distinct.

### P2 — Cycles and concentrated ownership (ARC-02–04)

The graph has seven value SCCs:

| Component | Members / relevant cause | Interpretation |
|---|---|---|
| Agent/tool/extension cluster | 10 modules, including `tool-loop`, `provider-turn`, `prestart-admission`, `extension-registry`, codemode/search and cache/virtual policies | Error/admission and execution orchestration point back into each other; extract low-level leaves rather than generalize provider authority |
| OAuth/credential cluster | 6 modules across credentials, device polling and four native issuers | Issuer-specific refresh and common service composition are mutually dependent |
| Core root/extension loader | 5 modules; loader helpers dynamically import the actual Core root | Deferred namespace identity is intentional; do not call this an eager initialization bug or remove it as dead code |
| Metadata | `model-metadata` ↔ `provider-model-metadata` | Fallback lookup and authoritative sanitization form a two-way dependency |
| Classifiers | `classification-questions` ↔ `specialized-models` | Shared model-helper policy and specific question logic are mutually dependent |
| Web terminal transport | `services/api` ↔ `terminal-replay` | Fetch/SSE foundations and specific terminal decoder live on both sides |
| Web workspace/store | `session-store` ↔ `workspace-refresh` | Refresh helper directly controls the store that imports it |

Largest source modules: providers `index.ts` 7,353 lines; `session-manager.ts` 3,692; `ChatView.tsx` 2,473; Web `services/api.ts` 2,417; CLI `index.ts` 2,397. Total scanned source is 105,194 lines. Size alone is not a bug; the owning files visibly combine multiple implementation responsibilities.

**Recommendation:** first isolate leaf errors/admission types, transport primitives and metadata contracts; then extract one owning dialect/store/UI responsibility at a time. Preserve class identity, private native-owner grants, cancellation, trust and durable-write admission. Add a CI dependency rule with explicit deferred-loader/test/worker exclusions. Do not start a whole-platform framework or rewrite solely to hit a size target.

### P2 — Full catalogue reconstruction for single-model reads (PERF-02)

`packages/core/src/providers/provider-model-metadata.ts:15–65` clones/sanitizes up to 500 declarations before `.find`; `model-metadata.ts` repeats this approach for thinking levels. Callers include `agent/provider-turn.ts` and `media/image-preparation.ts`.

For the real native mixed OpenRouter declaration source (393 rows), five batches of 500 lookups take **1,155–1,183 ms** per batch, approximately **2.31–2.37 ms per lookup**. A prebuilt request-local Map is much cheaper in this microprobe, but its timings exclude projection construction and all cache invalidation/authority work. They are not a product speedup estimate.

**Recommendation:** consider reuse within a bounded synchronous operation or authentic provider generation, preserving fresh defensive return values and authoritative withdrawal/revalidation around awaits. Do not permanently cache arbitrary mutable adapters in a WeakMap. Existing metadata tests cover published behavior; owning provider tests cover defensive copies/withdrawal. The missing acceptance is bounded reuse plus replacement/mutation/withdrawal and before/after CPU/allocation evidence.

### P2 — Sessions are fully materialized twice at startup (PERF-03)

`SessionManager.loadAllSessions` (`session-manager.ts:2637–2649`) serially calls `store.loadSession` for every ID. Native load reads/parses a snapshot, rereads under the writer lock and checks redaction. CLI (`index.ts:500,1011`), RPC (`rpc-server.ts`) and Server (`runtime/services.ts:149,200`) repeat full loading around credential enrollment. The second pass has an explicit security purpose: newly known secrets must scrub prior journal content.

Synthetic measurements, 64 messages/file:

| Files | Input bytes | First pass | Second pass | Calls across both passes |
|---|---:|---:|---:|---:|
| 10 | 483,930 | 38.1 ms | 30.6 ms | 20 |
| 100 | 4,850,910 | 262.2 ms | 257.0 ms | 200 |

**Recommendation:** design metadata inventory plus selected/needed-journal hydration after credential discovery, or equivalent bounded staging. Preserve list/resume/fork semantics, independent writers, stable-file/owner checks and scrubbing of newly enrolled raw/encoded secrets. Existing 95 session-manager cases include redaction and writer safety; the gap is startup-scale/load-count acceptance with the same security behavior. Do not extrapolate these two fixture sizes into production latency guarantees.

### P2 — RPC has a request-count limit but no frame-byte limit (PERF-04)

`rpc-server.ts` bounds pending requests at 256 but `jsonLines` appends chunks to a string until LF without a byte ceiling. The final probe sends an **8,388,680-byte** valid legacy ping through the real `runRpcMode`; it returns success. This confirms admission of that size, not a measured out-of-memory condition. A stream without LF can continue accumulating before controller validation. The boundary is local stdin/embedding input, not an unauthenticated remote HTTP endpoint.

**Approved direction (2026-11-17):** enforce the 32-MiB frame and 64-MiB aggregate input policy below during chunk accumulation and before parse/dispatch, with stable refusal/cleanup for individual overflow. Keep ordinary LF/CRLF/UTF-8 behavior and cancellation/channel semantics. Do not substitute the 256-task cap for a memory bound.

#### PERF-04 sizing brief — user-approved policy, implementation pending

Source review on 2026-11-17 establishes:

- RPC `optionalImages` in `rpc-controller.ts:221–247` checks each decoded image against 10 MiB, after JSON parsing. It has no explicit image-count or aggregate-image-byte limit at that boundary. `requiredString` checks type, not text bytes.
- Base64 uses `4 × ceil(decodedBytes / 3)` bytes for ordinary ASCII encoding: one 10-MiB image needs 13,981,016 bytes (about 13.33 MiB); two need about 26.67 MiB before the JSON envelope/text.
- `SessionManager.addMessage` later bounds a serialized message at 16 MiB. That later check, potentially after model-owned image preparation, does not protect input accumulation or parsing. Passing a frame limit never guarantees model/persistence admission.
- Core `loadPromptFiles` defaults to 25 MiB total, 10 MiB/image and 2 MiB/text file. Those are file-loader limits, not a maximum for inline RPC JSON.

| Proposed frame ceiling | Approximate capacity with a small text/envelope | Tradeoff |
|---|---|---|
| 16 MiB UTF-8 | One 10-MiB image | Tighter ingress bound; rejects two maximum-sized inline images |
| 32 MiB UTF-8 | Two 10-MiB images | User-approved ceiling; larger batches must be reduced or refused |
| 64 MiB UTF-8 | Four 10-MiB images | More ingress/parse work; still not a guarantee that the resulting message fits persistence/model limits |

All values above apply to the complete JSON payload, not to each field. The user selected 32 MiB; 16/64 MiB remain comparison alternatives, not approved frame ceilings. Measure UTF-8 bytes, not JavaScript character count; define LF/optional CR delimiter treatment explicitly. A 32-MiB ceiling permits small multi-image batches too, not only two images; a separate semantic image-count policy is not established here.

**User-approved package (2026-11-17), not delivered:** 32 MiB per frame, 64 MiB aggregate serialized input retained by pending/in-flight requests, backpressure when the latter budget is exhausted, and a fixed `RPC_FRAME_TOO_LARGE` diagnostic followed by orderly nonzero shutdown for an oversized frame. Reject before dispatch, echo no payload and retire active work through its existing cleanup/admitted-write ownership; never promise rollback. A fatal framing error avoids a new unbounded drain-to-next-LF recovery path. Keeping the connection alive after individual overflow is not the approved behavior; it would require a separate decision and an explicitly bounded discard/resynchronization policy. Ordinary malformed JSON within the size ceiling retains its separate existing handling.

The aggregate budget is separate from the 256-request count: 256 frames of 32 MiB represent 8 GiB of serialized input alone. Neither 32 nor 64 MiB is a process RSS guarantee: parsed objects, decoded images, copies and other runtime state use additional memory. A frame/aggregate ceiling does not replace command-specific validation, queue limits or provider context limits.

### P2/P3 — Remove internal leftovers, not public or dynamic contracts (DEAD-01–03, COMP-02)

| Candidate | Evidence / classification | Proposed scope |
|---|---|---|
| `truncateToolBytes` | Sole lexical code occurrence at `core/src/tools/truncation.ts:157`; not re-exported by `tools/index.ts`. Local `utf8Prefix` is used only by this wrapper | Internal removal candidate; remove the helper only when that removal makes it orphaned |
| `getAuthContext` | Sole occurrence at `server/src/security/request-security.ts:239` | Internal removal candidate; retain actual capability guards/context storage |
| `startSubagentRun` | Sole occurrence at `web/src/services/api.ts:2388` | Unused client wrapper candidate, not proof that the Server start endpoint is unused |
| `baseStore`, `providerStore` | Alias-only exports at `web/src/store/session-store.ts:1264–1265`; all consumers use `useSessionStore` | Remove redundant internal aliases after scoped checks |
| `fetchWithRetry`, `formatDate`, `deepClone` | No named local consumer found; `core/src/index.ts:494` wildcard-exports `utils/index.ts` | User approved an explicit public contract break on 2026-11-17; removal/marker/consumer changes remain undelivered |
| `media/image-worker.ts` | `image-preparation.ts:27` constructs a Worker from its emitted URL | Retain; computed entry, not dead code |
| `provider-settings.fixture.tsx` | `e2e/provider-settings.spec.ts` loads it through Vite HTML | Retain test entry; absence from production bundle is intentional |
| `test-support/native-frontend-relay.ts` | Imported by its unit test and `e2e/native-session-links-live.spec.ts` | Retain test support |
| Web `sendChat` / `streamChat` | Called by `services/api.test.ts`, not by a production Web module in the inspected source; Settings still reads/writes their transport preference | User confirmed no external consumers and approved client/control plus historical endpoint removal on 2026-11-17; implementation remains open |

Internal cleanup is a maintainability opportunity, not a promised bundle-size gain: tree shaking may already eliminate unused Web exports. The application transport preference does not configure Core provider WebSockets; the legacy server WebSocket and active provider WebSocket transports are different contracts.

### Compatibility that must not be removed blindly (COMP-03)

| Existing mechanism | Evidence | Disposition in this audit |
|---|---|---|
| Legacy message-only JSONL and current v2 journals | `session-manager.ts`, `session-manager.test.ts` legacy-date/redaction cases | Preserve data readability pending explicit migration policy; do not delete readers as apparently old code |
| `queueMode`, `websockets`, object-form `skills`, retry `maxDelayMs` settings | `config/agent-settings.ts:483–509`, migration test in `agent-settings.test.ts` | Small normalization layer with real precedence tests; no evidence here justifies breaking files immediately |
| Browser preference v1/v2/v3 migration to v4 | `web/src/store/preferences.ts`, `preferences.test.ts` | Preserve bounded migration; it is not a second conversation engine |
| Public Core/extension markers | `public-api-version.ts`, exported root, public-contract policy and installed fixtures | API major 1 is distinct from package 0.1.0/private-registry metadata; public removals still need an explicit decision |
| Provider-compatible dialects and authority checks | Provider constructors, native ownership tests and shared tools | Coexisting protocols/security boundaries are not automatically unnecessary backwards compatibility |

## 9. Recommended Delivery Order

| Order | Work | Required acceptance before closure |
|---|---|---|
| 1 | Remove legacy RPC and implement the approved 32-MiB frame / 64-MiB aggregate policy | COMP-01 removal/rejection; PERF-04 byte-budget/backpressure/fatal-overflow implementation, lifecycle/framing controls and emitted/installed channel contracts |
| 2 | Remove the approved legacy Web client/control/endpoints and three public utility exports; clean the five internal candidates | Explicit HTTP/WebSocket/Core contract transitions; reference checks and owning unit/type/browser/installed evidence; no compatibility shim |
| 3 | Reuse metadata within authenticated operation/generation limits | PERF-02 owner/withdrawal/defensive-copy regressions and controlled before/after measurements |
| 4 | Stage session hydration without losing secret scrubbing | PERF-03 startup/list/resume/credential-rotation/private restart acceptance and larger datasets |
| 5 | Break incidental dependency cycles and enforce boundaries | ARC-02–04 small owner-preserving changes and bounded CI negative controls |
| 6 | Profile actual Web rendering/asset behavior before further optimization | VAL-02 traces through owning browser hosts; no guessed rerender or worker-pool change |

Existing coverage was identified before proposing new tests. This audit adds only evidence probes, not a new product test framework. Full Docker validation from the project map is required for any subsequent runtime/refactor delivery.

## 10. Evidence and Reproduction

| Artifact | Purpose |
|---|---|
| [inspect.mjs](./evidence/inspect.mjs) / [inventory.json](./evidence/inventory.json) | Literal import graph, SCC edges/lines, scoped package counts and digest |
| [references.mjs](./evidence/references.mjs) / [references.json](./evidence/references.json) | Reproducible tracked-code lexical screening and checkout digest |
| [probes.mjs](./evidence/probes.mjs) / [probes.json](./evidence/probes.json) | Final network-isolated synthetic performance/legacy/framing observations |
| [Initial probe output](./evidence/probes-initial.json) | Earlier successful population before the framing increment; not a before/after optimization |
| [Probe stderr](./evidence/probes-stderr.txt) | Final run has empty stderr |
| [Focused tests](./evidence/focused-tests.txt) | Existing 150-test / seven-file Docker selection; only terminal whitespace normalized for Git |
| [Build transcript](./evidence/build.txt) / [environment](./evidence/environment.json) | Cached test-image build and runtime environment; one trailing display space removed |
| [Web bundle budget](./evidence/bundle-budget.txt) | Existing checker: entry 147 KiB gzip, eager 159 KiB gzip, 28 JS chunks; passes, with limited entry-budget headroom |
| [Documentation validation](./evidence/documentation-checks.txt) | Local targets/anchors and versioning-boundary validation after adding the report/navigation |

Reproduce static screening from a checkout of the pinned commit with the audit evidence files available:

```bash
node docs/audit/architecture/evidence/references.mjs
make build-test
c=$(docker create --network none ai-harness:test-latest node /tmp/inspect.mjs /app)
docker cp docs/audit/architecture/evidence/inspect.mjs "$c:/tmp/inspect.mjs"
docker start -a "$c"
docker rm "$c"
```

Run the probe the same way, replacing `inspect.mjs /app` with `probes.mjs` and copying `probes.mjs`. Do not mount a personal home or credentials, enable network, or interpret rerun timings as a patched-product comparison.

Exact focused selection executed inside the image:

```bash
docker run --rm --network none -e CI=true ai-harness:test-latest npm test -- \
  packages/cli/src/rpc/rpc-server.test.ts \
  packages/core/src/providers/model-metadata.test.ts \
  packages/core/src/config/agent-settings.test.ts \
  packages/core/src/sessions/session-manager.test.ts \
  packages/web/src/store/session-store.test.ts \
  packages/web/src/store/preferences.test.ts \
  packages/server/src/security/request-security.test.ts
```

The report remains open because documented debt is not delivered remediation and no compatibility gap has been accepted.
