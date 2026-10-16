# Model-window compaction and scoped RPC settings — 2026-10-16

**Accepted scoped implementation: CLI-CFG-06 only.** Parent `748b03412dbf47f40dc941bc3fde80196621daae`; DEC-87 / E-AH-CONTEXT-SETTINGS-01. This reconciles the whole named criterion, not a reduced passing-test manifest. The audit remains **95 DONE / 57 PARTIAL / 152 (62.5%)**, not complete. Retain [navigation/context](./session-navigation-summaries.md), [statistics/management](./session-statistics.md) and earlier configuration/admission evidence.

## Every CLI-CFG-06 clause

| Requirement | Implementation and direct or conserved proof |
|---|---|
| Session directory/environment/settings precedence | Existing `sessions/startup-session.ts`, CLI/RPC startup and Core settings resolution retain explicit selection, `AI_HARNESS_SESSIONS_DIR`, trusted `sessionDir` and defaults. `startup-session.test.ts`, `cli/invocation.test.ts` and settings tests pass in the whole 3,342-test gate. Actual native `thresholds` retains the original durable file/entry IDs after reload, despite a changed setting; the trap directory is never created. No store relocation or session-directory reload is claimed. |
| Global enablement and session opt-out | Existing Core global setting and session choice remain independent. `get_state.autoCompactionEnabled` now reports their conjunction. Lifecycle controls and actual `gates` prove that session enable cannot override global disable, opt-out survives a global-enable reload, and only both-enabled work compacts. Original effective-state RED is preserved. |
| Reserve-trigger versus keep/cut semantics | The optional validated non-persisted manager window gates automatic work at strict `estimateContextTokens > contextWindow - reserveTokens`; existing keep/cut selection follows it. Published limits are passive; unknown non-mock models use a 128,000-token policy fallback, not invented metadata. Absent/mock policy preserves the legacy trigger. Original actual gpt-4o 128,000/reserve10,000-or30,000 control passes unchanged; Core equality/invalid/clearing/passive/race cases and actual print/JSON/RPC below/above controls pass. Manual compaction targets/settings shape remain unchanged. |
| Exact per-model overrides and default restoration | Unchanged `resolveAgentCompactionSettings`, command `/model` and RPC tests cover exact provider/model matching, defaults after leaving an override, invalid-selection conservation and newly selected keep targets. Native `thresholds` makes an exact model reserve beat its contradictory base setting; fresh explicit reload changes admission without moving the selected model or journal. |
| Live current-model policy after selection/reload/session switch | The existing CLI startup/refreshed-startup/command and RPC refresh paths now supply the manager window alongside reserve/keep. `commands/handler.test.ts`, `rpc-controller.test.ts`, compiled `cli/invocation.test.ts` and whole native/PTY controls retain model/provider selection, scoped cycling, saved-session switching, opt-out and host-without-settings-reader behavior. No provider discovery is added. |
| Branch-summary reserve and skipPrompt | Conserved explicit navigation uses current `branchSummary.reserveTokens` and treats skipPrompt as no implicit summary authority. The actual new file snapshot uses reserve300 and produces `max_tokens:150` only for explicit summary; plain navigation produces no provider work. Navigation unit/RPC/process/PTY/public controls pass unchanged; branch summaries remain distinct from manual branch-summary creation. |
| Explicit RPC settings-file reread | `reload_context_settings` accepts only type/id, remains idle-only and returns correlated `{cancelled:false,reloaded:["compaction","branchSummary"]}` or `{cancelled:true,reloaded:[]}`. Server preparation pins startup roots/process trust policy, rereads fresh saved trust and bounded settings, refuses any diagnostic and replaces only those two settings families. Actual global/trusted/untrusted/saved-trust cases prove reload, invalid-file refusal/recovery, trusted-project removal, saved refusal ignoring a poisoned project body, and later saved allow. A changed executable trap never runs; no provider/model/thinking/resource/session-store reload is granted. |
| Scoped publication/lifetime and public compatibility | Preparation runs outside publication; controller rechecks signal, lifetime and own-data capability identity before synchronous publication. Safe reads/abort remain available; competing foreground work, pending navigation, ignored aborts, EOF/close and invalid/accessor/extra fields have direct cases. Window/settings/callback/session checks withdraw stale automatic output across waits/queue admission; a separate actual compiled public-store control on Node24 and26 changes the window while queued and refuses publication, but preserves an already admitted durable write. Equivalent refresh retains authority. Installed NodeNext positive/negative declarations and actual PATH-bin threshold/EOF cases preserve Core API major1, JSONL session schema major2 and absence of a facade setter. |

## Owning inputs and positive/negative controls

Seven product owners: Core `config/agent-settings.ts`, root `index.ts`, `sessions/session-manager.ts`; CLI `index.ts`, `commands/handler.ts`, `rpc/{rpc-controller,rpc-server}.ts`. Five new TS leaves plus one actual CLI/local-provider fixture, the installed consumer and nested SDK README make **15 included inputs**. Root documentation is separately composed; no dependencies, lockfile, compiler target, masks, goldens, tolerance, budget, retry or existing deadline change.

- Core `sessions/compaction-context.test.ts`:25 cases.
- RPC boundary2, reload12 and lifecycle3 cases.
- Actual `cli/context-settings-process.test.ts`:11 cases (`thresholds`, `gates`, `untrusted`, `trusted`, `saved-trust`, `abort`, `eof`, print/JSON below/above).
- Genuine installed public declarations and PATH-bin threshold/EOF:3 cases, also exercised by parity; do not double-count them. **56 new distinct cases** in the full unit count, of which three are in parity.

Original REDs remain meaningful and unchanged where stated:

1. `/tmp/aih-compaction-context-parent-*`: original published-window control exits1, one failed/one passed; parent owner hashes and image `sha256:1f34d1da5bad94ba5be72e013708d4ea23c4aa7f44cea555d283f5bbedbcc0cf` retained. Original control SHA-256 `8b2b3b55370ce9dc8695f9dbe9b87e1d7f9ef390555533f14c43377e4bc17458` passes two cases unchanged on the qualified image.
2. `/tmp/aih-context-settings-reload-red.*`: selected startup case passes, explicit publish fails unknown command; exit1/one failed/one passed. It is not a full-suite baseline claim.
3. `/tmp/aih-context-settings-lifecycle-red.*`: effective global-disable state incorrectly reports true; exit1/one failed/two passed. Other lifecycle controls already passed.
4. `/tmp/aih-compaction-context-native-parent-{print-below,json-below}*`: both original actual process controls exit1 on `2 !== 1` provider requests. Original failed synthetic roots, containers, states and logs remain. The original ten-case native fixture hash is `3553e4e1a4c43229545124fe498fddd4147cf471d45885879a27ab02a4dc9f6e`; exact bytes are retained separately and the whole original ten-case probe passes on Node24 and26. The newer eleven-case fixture adds saved-trust coverage; it is not relabelled byte-identical.

Supplemental unchanged-image public control `/tmp/aih-context-settings-window-queue-control.mjs` (SHA-256 `f4e7b783fc58c156889635dd01773adc7edf0021779bff4a8b76b17f251e6169`) passes both queued-withdrawal and already-admitted-write cases on Node24.15.0 and26.12.0. It delegates real `JsonlSessionStore` writes behind public controlled waits, compares durable bytes and all14 emitted files, and patches no implementation. Its expected queued refusal logs `[SessionManager] Auto-compaction failed.`; both whole two-case probes exit0. These manual controls are separate from the56 new Vitest cases.

Development1/v2/v3 are separate preliminary retired contexts:472/537/550 focused passes respectively. Their invalidation files precede added reload, lifecycle/native, then installed/SDK-document inputs. None qualifies later source. The final context freezes all15 inputs after those retirements.

## Exact-source gates

Prefix `/tmp/aih-context-settings-qualified-*`.

| Artifact/gate | Actual evidence |
|---|---|
| Test image | `sha256:bec6a69dde63f9aed5e0e8cc2830abcac3e0a80b0f18806732e988a1a6ea90ca` |
| Included-input manifest SHA-256 | `ae64a80f2a579d8cfe1212a5c8b8017944f3dc3ac6da1b9c7a4003f820c8b5f5` |
| Types/lint | Docker workspace/parity types; seven strict leaves;14-owner zero-warning lint; all exit0 |
| Focused | 35 files/592 tests, exit0; separate original two-case control and whole original10/current11/public-API native chain exit0 |
| Whole units | `make test`,269 files/3,342 tests; Make/wait0,269 isolated workers over serial files |
| Whole parity | `make test-parity`,two files/57 tests; Make/wait0 |
| Browser | 544 cases from nine COMPLETE passing configurations:independent whole standard365 + original other eight179; original embedded HTML ZIP admission, exact test identities/source/image/freshness, one actual worker/result and no skips/flaky/errors/retry |
| Production image | `sha256:98eac88d525c158dcef0151eaf56ab5aa9db098402c09375d074963e46d9c668`; actual Node26.12.0 |
| Whole production-v2 | Independent unchanged public API/original10/current11/four genuine memory-durable×regular-fullscreen PTYs/actual Server HTTP chain exits0;14 emitted JS/declaration files byte-equal to test artifacts |
| Documentation/index | `make lint-docs`; exact27-path/source/index/parent/matrix admission is recorded separately by `-admission.json` before commit |

The canonical no-argument browser command is **failed**, Make2/wait1,543 passes/one failure: mobile-dark MCP per-tool exposure remains `deferred` instead of expected `hidden` at `mcp-exposure.spec.ts:22:27`, with a disabled select and unchanged5,000ms assertion. Its strict all-green admission refuses. Original reports, early error context, events, source/image and exits remain. The failed365-case configuration contributes **zero** cases to final coverage; passing subsets are not admitted. Whole independent standard-v2 passes all365 with identical case identities. Its success does not diagnose the first assertion failure. `canonicalCommandPassed:false`; no green canonical CI or source/assertion/deadline/golden change is implied.

The first production chain exits1 at durable-fullscreen reload with `[SessionManager] Failed to save session.` / `Session persistence failed.`; the generic adapter erases the underlying cause. Earlier probes in that failed chain are not its acceptance. Independent unchanged complete production-v2 passes; **this does not diagnose or erase the first failure**, which remains alongside the similar earlier navigation history. Its original image/container/state/events/log and source/probe hashes remain retained. Production-v2 starts `2026-10-16T10:12:11.519218279Z`, finishes `10:12:21.987325931Z`, exit0/OOMfalse/error empty. Both original and v2 watchdogs are literally `unhealthy`, FailingStreak1, with one exit1/empty-output check. HTTP200 and clean process exit are bounded serving evidence, not watchdog health/uptime or vendor certification.

## Limits and non-closure

The optional manager scalar is lower-level host policy, not persisted vendor metadata or a high-level SDK mutation. Estimates omit the full system/tool wire payload; unknown-limit presentation remains unknown. Reserve and keep are distinct; model-window admission does not implement overflow recovery, every compaction hook/race, signed provider replay or complete wire-token accounting. Explicit scoped reload is not general executable/provider/resource/session-directory reload. Cancellation withdraws unpublished work, not admitted durable effects. No remote CI, release/push/deployment, physical Windows/mobile, live vendor or uptime certification follows.

The first documentation gate refuses five links to the not-yet-staged ignored receipt (109 files/757 links,exit2); its original log is retained. Force-add only the reviewed allowlist before ordinary/staged documentation and index admission; this is documentary admission,not a product failure or a reason to rebuild/relabel the frozen source.

Only CLI-CFG-06 changes status. CLI-SES-07 and broader configuration/automation/provider/extension/TUI/Web/release criteria remain PARTIAL; the global goal remains active. Existing native compiler/browser signals, original auth/persistence failures and all retired-context/setup failures are retained, not explained by later passing runs.
