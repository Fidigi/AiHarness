# Application Architecture Audit — AiHarness

> **Status: IN PROGRESS** (2026-11-17)
>
> Initial assessment delivered; the user approved COMP-01/COMP-02/DEAD-03 removals on 2026-11-17. The user also approved PERF-04's 32-MiB frame / 64-MiB aggregate budget and fatal-overflow policy on 2026-11-17. Implementation remains open for ARC-02–04, DEAD-02–03, PERF-02–04, COMP-01–02 and VAL-02; the four requested product decisions are resolved. No application code was removed or optimized by this audit.

## 1. Audit Reference

| Element | Value |
|---|---|
| Target observed | AiHarness 0.1.0: Core, CLI, Server and Web architecture, dead-code candidates, performance and compatibility debt |
| Audited instance | Clean application checkout at `120b4d46352def7170967599f260846c07a0e02c`; subsequent worktree additions are this report, its evidence and audit navigation only |
| Audit date | 2026-11-17 |
| Pinned source | `https://github.com/Fidigi/AiHarness/tree/120b4d46352def7170967599f260846c07a0e02c` |
| Runtime | Docker test image `sha256:479ef95ecbd4a046acd48d964b06b406bcd0d469e99e39b3e11d0f121122be0c`; Node 24.15.0; environment in [environment.json](./evidence/environment.json) |
| Source correspondence | Image AST inventory and checkout lexical inventory share the ordered 454-source digest `95b9c40d931559783e462ddca102da115df0201adb6a16c439fc48166c0f7862` |
| Detailed references | [Import inventory](./evidence/inventory.json), [reference screening](./evidence/references.json), [synthetic probes](./evidence/probes.json), [focused tests](./evidence/focused-tests.txt), [bundle budgets](./evidence/bundle-budget.txt), [build transcript](./evidence/build.txt) |

**Objective:** Identify evidenced architectural coupling, distinguish removable internal code from public/dynamic contracts, measure bounded performance opportunities, and identify compatibility layers that need an explicit retirement decision rather than indefinite duplication.

### Known limitations

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
| `DONE` | 5 | Bounded layer check, dynamic-entry classification, local baseline, retained migration classification and focused validation |
| `PARTIAL` | 9 | Existing foundations with coupling, cleanup/performance work or approved but unimplemented removals/input policy |
| `ABSENT` | 2 | Dedicated architectural CI guard and current browser profiling evidence |
| `TO BE DEFINED` | 0 | The four requested product decisions are resolved |
| `BLOCKED` | 0 | No audit-wide external blocker |
| `IN PROGRESS` | 0 | No application remediation started |
| `GAP ACCEPTED` | 0 | No remediation waived; approved removals are not yet implemented or closed |
| **Total** | **16** | **31.25% closed: (5 + 0) / 16** |

### Summary by Surface

| Surface | Done | Partial | Absent | To define | Blocked | In progress | Gap accepted | Total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Architecture | 1 | 2 | 1 | 0 | 0 | 0 | 0 | 4 |
| Dead-code classification | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 3 |
| Performance and bounds | 1 | 3 | 0 | 0 | 0 | 0 | 0 | 4 |
| Compatibility | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 3 |
| Validation | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 2 |
| **Total** | **5** | **9** | **2** | **0** | **0** | **0** | **0** | **16** |

## 3. Traceability by Surface

### Architecture

| ID | Status | Criterion and completion evidence |
|---|---|---|
| ARC-01 | DONE | Sampled package dependency direction respects Core independence: no Core-to-interface imports in the scanned graph; CLI/Server/Web import Core. Web's sole value edge is the explicitly browser-safe `@ai-harness/core/shell-input` subpath. Root `package.json`, package manifests, `packages/web/vite.config.ts` and inventory agree. This is a scoped static check, not whole-runtime certification. |
| ARC-02 | PARTIAL | Reduce unnecessary value cycles, with explicit exceptions for intentional deferred host loading. Seven strongly connected components remain; inventory records every internal edge/line and distinguishes deferred imports. Completion needs reviewed cycle cuts/allowlist and relevant lifecycle/identity regressions. |
| ARC-03 | PARTIAL | Separate implementation responsibilities behind existing contracts. Provider composition/codecs, journal storage/domain operations, CLI startup and Web orchestration remain concentrated in large modules. Completion needs incremental owner-preserving extraction plus unchanged public/installed/host behavior, not a line-count-only rewrite. |
| ARC-04 | ABSENT | Enforce the audited dependency directions/cycle policy automatically. `.eslintrc.json`, root scripts and `.github/workflows/ci.yml` contain no dedicated cross-package/cycle/unused-export gate. Existing `noUnusedLocals`/`noUnusedParameters` do not enforce these properties. Completion needs a bounded CI check with dynamic/public exclusions and negative controls. |

### Dead-code classification

| ID | Status | Criterion and completion evidence |
|---|---|---|
| DEAD-01 | DONE | Resolve graph-unreachable candidates before proposing deletion. Image worker, provider Settings fixture and frontend relay all have concrete worker/browser/test consumers; see §8. No orphan whole application module is proven removable by this scan. |
| DEAD-02 | PARTIAL | Remove or justify five internal exports with no other lexical code occurrence: `truncateToolBytes`, `getAuthContext`, `startSubagentRun`, `baseStore`, `providerStore`. The first is absent from the supported Core barrel; the others are internal Server/Web exports. Completion needs scoped reference checks, removal of newly orphaned helpers and owning checks; no deletion has occurred. |
| DEAD-03 | PARTIAL | User approved removal of `fetchWithRetry`, `formatDate`, `deepClone` with an explicit contract break on 2026-11-17. All three are still exported by the unchanged Core root. Completion requires implementation, the appropriate contract marker/release documentation and positive/negative installed declaration/runtime coverage. |

### Performance and bounds

| ID | Status | Criterion and completion evidence |
|---|---|---|
| PERF-01 | DONE | Record a reproducible local baseline without pretending to optimize product code. `probes.mjs` measures CLI help, Core import, metadata lookup and session loads; the existing Web budget checker passes. Inputs, sample limitations and raw observations are retained. |
| PERF-02 | PARTIAL | Avoid rebuilding/sanitizing a complete authoritative model catalogue for repeated single-row reads in one eligible operation. `getProviderPublishedModel` and `getSupportedThinkingLevels` currently obtain full arrays. Completion needs a bounded owner/generation-safe reuse strategy with withdrawal/mutation/derived-owner tests and before/after measurements. |
| PERF-03 | PARTIAL | Avoid redundant full-journal startup materialization while preserving secret enrollment/scrubbing. CLI, RPC and Server intentionally load all sessions twice around credential discovery. Completion needs metadata/selected-session loading or equivalent staged design, cold/resume/list/redaction/restart controls and larger fixture measurements. Simply deleting the second pass is not safe. |
| PERF-04 | PARTIAL | User approved 32 MiB UTF-8 per JSON frame, 64 MiB aggregate serialized pending/in-flight input, backpressure at the aggregate budget and a fixed `RPC_FRAME_TOO_LARGE` diagnostic with orderly nonzero shutdown on individual overflow on 2026-11-17. The parser remains unchanged and unbounded. Completion requires implementation before parse/dispatch, fragmented/no-LF/UTF-8/EOF and byte-budget controls, plus preserved cleanup/admitted-write ownership. |

### Compatibility

| ID | Status | Criterion and completion evidence |
|---|---|---|
| COMP-01 | PARTIAL | User approved removal of legacy `{method,params}` RPC on 2026-11-17, not an adapter or a second engine. Its unchanged `chat.send` still bypasses the shared loop. Completion requires removal, documented stable rejection/contract transition, preserved canonical RPC lifecycle and focused emitted/installed negative-input coverage. |
| COMP-02 | PARTIAL | On 2026-11-17 the user confirmed no external consumers and approved removing the legacy Web client, transport selector and historical chat endpoints. They remain present in the unchanged target. Completion requires removal/rejection and documentation of the HTTP/WebSocket contract break, preserved detached conversations/provider WebSockets and separate owning browser/API evidence. |
| COMP-03 | DONE | Classify existing persisted/settings migrations as protected until a versioned decision changes them. Current JSONL v2/legacy reads, settings aliases and browser v1/v2/v3-to-v4 migration have source and focused test evidence. Do not equate migration readers, provider-compatible dialects or required scope checks with obsolete duplicate engines. No indefinite-retention or removal decision is made here. |

### Validation

| ID | Status | Criterion and completion evidence |
|---|---|---|
| VAL-01 | DONE | Execute a bounded existing regression selection in Docker and document exact scope: seven files, 150 tests pass; synthetic probes and existing bundle budgets also pass. These results validate only the stated current-source controls, not the remediation or the whole platform. |
| VAL-02 | ABSENT | Obtain current browser performance traces and controlled before/after evidence for any Web optimization. `e2e/performance.spec.ts` exists but was not run here; neither a current React render profile nor an optimization comparison is delivered. Completion needs real owning-host traces/scenarios, controlled data sizes and unchanged UI/asset-lifetime behavior. |

### API Families

| Surface | Contracts and evidence |
|---|---|
| Canonical CLI RPC | `{type,id}` dispatched by `RpcController`; `packages/cli/src/rpc/{rpc-server,rpc-controller}.ts` |
| Migration CLI RPC | `{id,method,params}`, including `chat.send`; direct handler in `rpc-server.ts`, unit controls in `rpc-server.test.ts`, synthetic observations in `probes.json` |
| Current Web conversations | Detached `/api/agent/runs` and session state/events; `ChatView.tsx`, `api/agent-routes.ts` |
| Legacy server chat | `POST /api/chat`, `/api/chat/stream`, `/api/chat/compact`; WebSocket `/api/chat/ws`; `api/{proxy,websocket}.ts` and legacy Web client/tests |
| Persisted/public SDK contracts | JSONL schema 2, Core API 1, extension API 1; `session-manager.ts`, `public-api-version.ts`, public root exports and installed consumer fixtures |

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

Close a criterion only after its full requirement is met, required decisions/migrations are explicit, applicable validation passes and the journal records evidence. Report closure requires all criteria to be `DONE` or `GAP ACCEPTED`. Discovery, passing existing tests or stopping this assessment does not close remediation. Severity and state are independent.

## 5. Decisions and Accepted Gaps

No `GAP ACCEPTED` decision exists: approved removals and the RPC input policy must still be implemented and verified, not waived. The following decisions come from the user's explicit follow-up on 2026-11-17, not inferred source nonuse.

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
