# Automatic compaction: captured-store save admission

Date: 2026-10-16. Decision: DEC-92. Evidence: E-AH-COMPACTION-STORE-01.

## Scope and acceptance boundary

This repairs an independently demonstrated automatic-compaction admission defect within [CLI-SES-07](../AUDIT-2.md). It does **not** complete that criterion or the global implementation. The matrix remains **97 DONE /55 PARTIAL /152**. Complete manual/automatic hooks and lifetimes,overflow recovery and full system/tool wire-token policy remain open;independent manual RPC abort/close REDs below are not repaired here. [Completion review](./completion-review.md) retains all55 open IDs.

Only `packages/core/src/sessions/session-manager.ts` changes product behavior. No SDK facade/store requirement,API-major/schema change,new dependency,credential/resource/trust authority change,provider/model selection change or frontend-specific compactor is introduced. Existing public mutable callback arrays and borrowed provider/store/registry ownership remain unchanged. See [owning session policy](../../../ai/topics/sessions.md) and the separately qualified [context settings](./compaction-context-settings.md).

## Causal RED,not a missing-method assertion

Immutable `/tmp/aih-compaction-store-admission-control.mjs`,SHA256 `2cea7e28f40140b697199470e55294cbfe0ef5a8395cddf88a7ee65edc82b60a`,runs the real emitted Core and JSONL persistence on accepted parent `2883ebf73b586c11bb33ee808938ec3e46b612b5`. The four complete original configurations are Node24 test/Node26 production × native/structural borrowed store. Each ends Make2/container1 with `Compaction must withdraw before a captured store save; started saves must still finish.` Parent emitted manager SHA256 is `f4b26da0fa150029f7e18a2bd94bd30913717f689b5a6a7e17418c3a1ca34138`.

- Replacement during inherited policy or summary wrongly reports applied/end and publishes the old result into the replacement store. Source bytes alone may remain unchanged while destination inventory is polluted.
- Replacing then restoring the original store during summary wrongly publishes into the source:identity-only checking misses the intervening generation.
- Structural raw-entry preparation also wrongly permits abort,replacement and replace→restore to persist the source.
- Already-started native/structural save abort/replacement correctly finishes in the parent. Those eight positive observations across the four original configurations are conserved,not reclassified as defects.

All26 original observations include18 failures and8 admitted-write non-regressions. Complete logs/exits/states/events and full available temporary roots/observations remain under `/tmp/aih-compaction-store-admission-parent-{test,production}-{native,structural}*`;native five/structural eight scenarios run before each final assertion. Failed roots remain available. Initial artifacts are not erased by the independent GREENs.

## Repair and 21 distinct additions

`setStore` advances a process-local generation only when identity changes. Automatic work captures both store and generation before awaited policy and includes both in existing session/leaf/settings/window/callback/policy admission. Replace→restore withdraws the old work;setting the identical store without replacement preserves it.

`applyCompactionResult` passes the existing validator in persistence's fourth admission slot,after awaited structural preparation and immediately before the captured save. Queue acquisition/legacy reads alone are not the final save boundary. No rollback or cross-process compare-and-swap is claimed:after a native/structural save starts,abort/replacement still completes and reports admitted durable success.

`packages/core/src/sessions/session-compaction-store-admission.test.ts` adds21 cases:seven native/fourteen structural. Real borrowed stores delegate the existing public contract without a new capability. Tests cover policy/summary replacement and restore,policy/summary same-store conservation,prepare abort/replacement/restore/settings/window/callback withdrawal,prepare same-store conservation,and save abort/replacement completion. Withdrawal asserts exact source bytes/raw entries/session snapshot,no replacement sessions/no write,no false end and correctly cancelled/redacted events. Accepted cases assert one compaction,all six historical messages,provider/model/usage,reload leaf and effective context. Successful roots are deliberately removed;failed test roots are retained.

## Frozen qualification

Parent,source paths/hash list,two-path archive,drivers,Make wrappers,strict config,logs/exits,states/events and control snapshots are retained under `/tmp/aih-compaction-store-v1*`. No owner source changed during these runs.

- Two-input manifest SHA256 `fa2d4484c259b4fc4f961d409c30c18ae7eef36b79607eddf4de599894c64cb5`;archive SHA256 `94e9b6944e78450d6928f045f3aaaa2988a7b5780b86439d5057fc28833021dc`.
- Manager SHA256 `d7d69470b6cea3a96266d2b95f306455d27a8a4dbd3f8e951d9c24541eaf4aff`;new test `7ef396c542c18dfdbcaa3a9ad96b968d8500f878475ddc9f4b4fb1d5a7029e46`.
- Test image `sha256:84743e84abc0d846d3b4062cea1e152463def6c0f852afd11a8790a9d441af5e`;authoritative inspected ID,not the distinct build-output config digest.
- Production image `sha256:8e1e5a2f8763d6220d2ef1f836099becf5eeee339090ef17cf5a1b8107684648`;actual Node26 builder `sha256:8d6ae160bccd1dea963ad31d8f6bfe018895daed7645520225170d8f0366098a`.

| Whole configuration | Actual result |
|---|---|
| Docker workspace/parity typecheck,new strict test config,zero-warning owning ESLint | All0 |
| Owning focus,11 complete leaves | 285 tests,8.60s;start20:12:01Z;all21 additions |
| Unchanged emitted Node24 original native/structural controls | All13 scenarios,all0 |
| Default suite | 288 files/3,727 tests,672.28s;start20:12:39Z;Make/wait0 |
| Standalone parity | Two files/69 tests,87.24s;start20:23:53Z;Make/wait0 |
| Actual Node26 production controls and HTTP | Both complete control modes,13 scenarios;health/HTML/JS200,child exit0;all0 |
| Actual Node26 whole owning configuration | Workspace/strict types and zero-warning lint0;11 files/285 tests,9.38s;start20:41:30Z;all21 additions;Make/wait0 |
| Node26 whole installed-executable leaf | 43 tests,77.68s;start20:25:55Z;exit0;genuine outside-checkout PATH executable cases |
| Original canonical `make test-e2e E2E_ARGS=` | Eight complete configurations/536 passed;demo7 passed/1 SIGSEGV failure;Make2/wait1/driver1;remains failed |
| Independent entire demo configuration | Eight passed,23.7s;Make/wait/driver0;no filter/retry/assertion change |

Browser coverage is544 across nine complete admitted configurations:the eight original whole passes536 plus the independent entire demo8. The original failed demo contributes **none** of its seven successes. `-browser-composed-admission.json` verifies original embedded HTML ZIP identities against the conserved544-test catalogue,fresh report times,exact source/image,one worker/result and zero errors/skips/flaky/retries in every admitted configuration. `canonicalCommandPassed:false` is retained. The original failing test is mobile-dark responsive Chat/Files/Git/Terminal/Models/Tools visual/axe/overflow;its worker exited with code=null/SIGSEGV. No causal diagnosis is established. Original logs/HTML/report ledger/events/start state/source/image remain under `-canonical-*`;final container state/roots are unavailable after existing `--rm` cleanup,with the failed inspect stderr preserved. The separate `-demo-whole-v2-*` configuration preserves all eight identities,including that case;it neither erases nor diagnoses the original failure.

The69 parity cases are already included in default3,727;21 is the distinct addition count,not a sum of repeated executions. Eighteen emitted JS/declaration files across Core manager/context/SDK/store/registry/root exports,CLI/RPC and Server are byte-equal between test and actual production builds;manifest SHA256 `ed12a9b3e7a1a6673f9ed45654aeb3bfc9389a88ff7c73fca32f4b7b88d68fa5`. Both stopped containers retain an identical control snapshot. Root guides are excluded from Docker context and separately hashed;`.git` and nested SDK README are not assumed excluded. Canonical in-container hashes and exact inspected image identity must match the freeze.

Production smoke runs20:25:50.159171319Z→20:25:51.536520352Z,exit0/OOMfalse/empty engine error. The literal final health state is **unhealthy**,FailingStreak0/no completed check. Neither HTTP200 nor the short successful child certifies watchdog health,uptime,release,deployment,physical-device behavior or live-vendor correctness. Bundle budgets remain148KiB entry/159KiB eager gzip/17 JS chunks. No compiler target,resource budget,deadline,retry,screenshot,tolerance or assertion was relaxed.

## Explicitly open manual cancellation defects

Unchanged `/tmp/aih-manual-compaction-cancellation-control.mjs`,SHA256 `dbdf8b01a76b142d450297ecea962841e18e0dc1d1826aa799359b0a93a5d477`,uses accepted-parent real emitted RpcController/public Core. Four complete Node24/26 × memory/durable configurations hold the first summary callback before persistence,then abort or close. All eight still persist `LATE_MANUAL_COMPACTION`,change raw history/leaf and,in durable mode,source bytes,and report successful completion. Abort acknowledges success without aborting its signal;close aborts the signal but ignored output still publishes after close settles. Final assertion:`Aborted or closed unpublished manual compaction must not persist a late summary.` All Make2/wait1,retained roots/raw observations/states/events remain under `/tmp/aih-manual-compaction-cancellation-parent-*`. These are separate unresolved CLI-SES-07 defects,not failed acceptance of the automatic-store boundary and not repaired/hidden by it.

Auxiliary collector setup errors are retained in `/tmp/aih-compaction-store-v1-artifact-collection-setup.md`:one nonexistent `.id` lookup before any product execution and a second-precision since-after-until event collection. Known original containers were recollected with nanosecond bounds/control snapshots;no product probe was rerun or its original result replaced. Existing unrelated historical native/compiler/auth/browser failures retain their original scope and remain undiagnosed.

## Documentary and exact-tree admission

The original unstaged working-document check failed on five links to this ignored new receipt;its log/Make2 is preserved as `-final-docs-working.*`. Force-adding the exact allowed receipt is required so normal validation includes it,not an exemption from link rules. Earlier pre-acceptance documentation checks were113 files/803 links,all0.

Final admission requires the seven-path allowlist,source/archive hashes,all152 named rows and statuses,whole owning/browser admissions,documentation/link/versioning/inventory checks and exact candidate/index/commit/postcommit reconciliation. These artifacts live under `/tmp/aih-compaction-store-v1-{allowlist,matrix*,final*}`;the owning and composed-browser admission logs/JSON/exits are separate from the original failed canonical/acceptance-driver results. The old rows/evidence and all55 explicit open IDs are conserved;CLI-SES-07 stays PARTIAL and no status transition is authorized. A green source suite alone is not exact-tree acceptance. No push,deployment or global-completion claim is made.
