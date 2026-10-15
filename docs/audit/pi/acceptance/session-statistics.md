# Session statistics and safe CLI management acceptance

Status: **qualified CLI-SES-06 closure only**. Every named requirement is mapped below; AUDIT-2 records91 DONE/61 PARTIAL. Documentary staging/admission and commit are finalized separately; the whole goal is not complete.

Accepted parent: `15fe3af5a403c85342d80fff7e7b8c9f88db1c31`. Scope is the complete CLI-SES-06 criterion, not automatic branch-summary generation, the global picker, a new journal format, browser/device certification or the remaining audit.

## Requirement-to-evidence map

| Named requirement | Implementation and direct acceptance |
|---|---|
| Name sessions | Existing `/name`/`/rename`; real manager tests plus actual regular/fullscreen rename and subsequent prompt state |
| File and ID | Full `/session` identity; passive `JsonlSessionStore.getSessionFilePath`, actual persisted path versus memory-only output; installed PATH-bin RPC |
| Messages | Shared `getSessionAccounting` counts raw history versus active ancestors, not just retained context; summaries are not synthetic messages |
| Tokens and cost | Assistant/compaction/branch-summary/outer nested usage once; persisted cost precedence, explicit historical provider/model published fallback, unknown/zero/partial distinction and safe bounded totals |
| Context | Independent `estimateContextTokens`; opt-in RPC reports unknown window/percent as null rather than substituting an accounting sum |
| Search and resume | Title/content search, fresh-manager exact-ID reload and actual terminal search/switch; malformed numeric prefixes do not select another session |
| Safe deletion | Active deletion refuses before mutation; conserved `index.ts:dispatchLine` foreground admission prevents overlapping interactive mutations; inactive deletion awaits Core persistence; actual terminal file removal/other-session conservation and linked-file refusal without losing memory state |

## Contract

Core owns the readonly-input accounting helper and independent active/history results. Active includes pre-compaction ancestors; history includes abandoned branches. Missing, cyclic or duplicate active ancestry is explicitly incomplete. Repeated logical IDs retain the last append-order projection once, and mark history partial instead of double-counting charges. `requests` counts accountable journal entries, including unmeasured summaries, not individual nested network calls. User/system/metadata/progress/nested details never supply billing authority. Authenticated outer codemode usage is counted once and its incomplete-cost marker remains authoritative.

`BranchSummaryAccounting` is additive to manager/store summary methods and JSONL v2. Own-data provenance is captured before awaits; invalid fields/counters and accessors are refused. Reload, volatile projections and clones retain the optional fields. Old unmeasured summaries remain readable and unpriced. No navigation-time generation, schema-version change or new SDK facade mutation is claimed.

`/session` and both terminal status renderers use the same Core calculation. RPC `get_session_stats` keeps its default legacy full-history shape; strict boolean `includeAccounting: true` adds scope details and separate context. Invalid values yield correlated errors. Existing goldens are unchanged. `/delete` now requires an inactive session; `/switch` numeric indexes must be complete positive safe integers.

## Test scope and preserved histories

- 25 Core cases: journal versus ancestry/pre-compaction, zero/missing/invalid/partial costs, nested authority, explicit historic pricing, unrecognized provider names, missing/cyclic/duplicate paths, overflow, projection ownership and real memory/durable summary snapshot/reload/clone/admission.
- Nine command cases: file/ID/counts/usage/context, names and title/content search, exact reload/resume, malformed numeric selection, active refusal/inactive deletion, and no-follow linked-file conservation.
- Eight RPC cases: durable/volatile scopes, summary/nested accounting, unproven historic models, unknown context/measurements, strict opt-in and default framing.
- Four genuine PTY cases: regular/fullscreen × memory/durable, actual provider turns for memory, exact durable ancestor/history subtotals, rename, search/switch, active refusal/inactive file deletion and clean exit.
- Two genuine installed cases: strict public Core declarations with positive/negative calls; actual public Core ESM plus PATH-bin RPC and legacy framing.

Evidence prefix: `/tmp/aih-session-statistics-*`. The first parent setup refused a nonexistent image tag without executing tests; its empty identity and refusal are retained. The initial mixed fixture used a returned Session ID as an entry ID; the first overlay retained two failures/145 passes. The corrected fixture captures the actual active leaf. The first expanded strict check retained four type errors, corrected without lowering strictness. The next exploratory overlay passed 228 cases, including both installed cases and unchanged parity. The later expanded overlay passed the final 46 Core/CLI cases, strict four-leaf types and ten-owner zero-warning lint.

The final accepted-parent control runs the unchanged final command/RPC leaves against the immutable accepted image: **15 failures/two passes over 17 cases**. Fourteen are semantic assertion failures; one is absence of the newly added informational store getter in the old version, not evidence of an old linked-deletion defect. Original controls and failed fixtures remain separate from final acceptance; later passes do not diagnose historical native failures.

## Final integration qualification

Frozen build context comprises eleven code/test owners and the included SDK README, recorded in `qualified-input-hashes.txt`; six accepted-parent owner hashes are retained separately. Documentation under `docs/` is excluded from the image. The producer rechecks every frozen input after each gate and requires identical test-image identities across Make rebuilds.

The first-source qualification passed workspace types, strict four-leaf types, eleven-owner lint, nine-file/277-case focused tests, 252-file/3,080-case units and 50 parity cases. Review then found that the new helper flagged duplicate logical IDs but still summed their usage twice. The existing duplicate case was strengthened: the immutable first-source image fails one case (24 deselected), while the corrected helper passes all 25 Core cases. No deadline, retry or assertion was weakened. The original producer's source-hash guard is intentionally invalidated; those Node passes do not qualify the final helper.

A distinct final producer records all post-correction identities/gates. An attempted strict browser-conservation proof was refused: the image comparison also differed in generated Core `tsconfig.tsbuildinfo`. Its original log/state is retained; the guard was not relaxed. Separately, the initial explicit `--retries=0` argument selected the runner's focused mode: its actual ledger contains one suite/354 passes, not the complete matrix. That successful partial run is not admitted as full browser evidence. The final remaining-gates producer retains the already passed final workspace types/frozen image, runs final owning/unit/parity gates, and invokes the canonical no-argument runner, which itself forces zero retries. Admission explicitly requires all nine named suites at status zero. No conservation is claimed.

The first canonical final-source attempt failed during `tsc && node scripts/copy-assets.mjs` for the CLI build, before any browser test: native exit139, Make exit2. Its build-only ledger, image identity, Docker events and frozen input verification are retained separately. The deleted Make container is not presented as a retained full terminal state; no specific child or root cause is inferred. The unchanged-source canonical rerun is distinct; a later pass cannot diagnose this failure. An observer command initially used a future `--until` time and timed out; its partial output is preserved alongside the completed event query.

- Final workspace types: passed.
- Final strict four-leaf types, eleven-owner lint and nine-file/277-case focused tests: passed.
- Final full units: 252 files/3,080 cases passed.
- Final functional parity: two files/50 cases passed.
- Complete final-source browser coverage: **533 cases/nine configurations**, explicitly composed from the canonical run's 525 successful cases and a separate complete owning Demo lifetime's eight successful cases on the exact same frozen image. The canonical whole command remains failed, not rewritten as passed.
The canonical run's final Demo preparation returned1 after its font checks, before executing eight Demo browser cases; the runner did not log which preparation child/signal failed. Its 525 successful cases and original failed ledger/HTML reports are preserved. A separate Make Demo lifetime passed8 but rebuilt a different image (`sha256:c2f8a8362858b907b90e69e9e034b8c0dfc78cf10f67926ef59f2fe0d461bc7c`): same-image admission correctly refused it. The final owning Demo runner therefore executes directly in a retained container from exact frozen `5ece…`, with the same `CI=true`/owning configuration/preparation and zero-retry runner. It passes8, without rerunning the525 successful configurations.

Admission reads the **original HTML reporters' embedded ZIP summaries**, not nonexistent JSON reporter outputs or a synthesized passing ledger: exact counts, expected/ok cases, one result per case, no skipped/flaky/unexpected cases or report errors, one actual worker, nonstale start times, exact actual container commands/image and twelve equal source hashes. Initial JSON-report/template assumptions and their metadata-admission refusals remain separate. This composed coverage is not a successful canonical Make command, remote CI proof or diagnosis of either preceding setup failure.

- Production build and Node26.12.0 probe: passed. Public Core snapshot/reload/clone and repeated logical-ID accounting; two actual RPC processes (legacy/opt-in/strict error, historical unknown-price independence); four actual regular/fullscreen × memory/durable PTYs covering statistics and safe management; real health/HTML/JavaScript HTTP200 with JavaScript MIME/body;14 emitted hashes equal the tested image.
- Final documentary admission:106 Markdown files/732 local links pass;152 unique criteria, only CLI-SES-06 closes, exact61-ID remaining checklist;22 staged paths/12 frozen source blobs/14 emitted hashes pass admission and whitespace checks. Only this qualified scope is admitted to the commit.

### Frozen final inputs

Final test image: `sha256:5ece4016c3c99925bf917b39086137e1bddd4d318ef2ba7e8eaa24691b8c9308`. Actual canonical browser-container source hashes equal this manifest. Production image: `sha256:d72872067c900f2021cf1f364b3b49417c6ee85b4f9c639b4781cf10e9c026d4`;14 emitted files below are byte-identical to the tested image.

```text
1aa18bf1a8c73d335a5051527791dc51503591d78b00c8b3e8aaa879147c479a  packages/core/src/index.ts
71fd4d3c528cf9c73d8df8b76b7d7fe0cd6666c99a60f4e4e1617a861fd0735e  packages/core/src/sessions/session-manager.ts
efd761ce68643645944f5e632b126728c7524fb1eff7c04e9dd4334b4ce049aa  packages/core/src/sessions/session-accounting.ts
aa4a0e50f019c5136c8e1a7645a4f360d57d08c166ce50ac6e6485fb6b10e96d  packages/core/src/sessions/session-accounting.test.ts
d7a6befb5707e93e4c52dc68f79a80bd0039ef806a9a479b6fb972851d3852df  packages/cli/src/commands/handler.ts
0512884a989bacd9be5b42b903f716fba14a53f53998566439db3472a2329460  packages/cli/src/commands/session-management.test.ts
5f759260f1bc908b20db09792f6fd7744a41361615926ebd01010e3f4c92d06e  packages/cli/src/rpc/rpc-controller.ts
db91ef328dae8ee62859c040cb77069eb3677583cffe42ba71d310d5580c22a1  packages/cli/src/rpc/session-statistics.test.ts
325b37e95ee68026eea037c6f63d1ce468ff88a081b1518a73865d89670d92ca  packages/cli/src/tui/status.ts
954d6756473477d4d9e3d4c86b804423cf4be6acce0f254d7cec77a54689a1a3  packages/cli/src/cli/session-statistics-process.test.ts
77270a27bbea6e8eb5655738bb91b1ef2a8d9211d0204ab7ae5af5279ab64ecf  tests/functional-parity/installed-executable.test.ts
7cca21c8b238e44a80aafa8c149df8f9097ca32c2a2188e6248efb8989892f40  packages/core/src/sdk/README.md
```

### Actual terminal and emitted proof

Final focused container exits0/OOMfalse at2026-10-15T22:02:42.521057698Z; owning frozen Demo exits0/OOMfalse at22:57:57.441838371Z; production probe exits0/OOMfalse at23:01:52.466272541Z. Actual states/logs and the original canonical exit1 remain under the final evidence prefix. The production terminal Docker health summary is `unhealthy`, failing streak0/log entries0; explicit health/HTML/JS200 is separate evidence, not a watchdog-health or uptime claim.

Production probe SHA256: `510316c6b1ef201c9eec1a6d175c0a9866012ae5002ff4c38907a2b207a5d3e7`. Final original HTML report hashes and exact533-case admission are retained in `final-browser-matrix-admission.json`; no original failed ledger is overwritten.

```text
01cbddba543e468e0a2be0f1e035580c2f8532b34c85df353074135cbdc160e2  packages/core/dist/index.js
c40e3dc9eb741faa5739d977a67856ec09f6db1a715b531634d5872bae71f603  packages/core/dist/index.d.ts
f7f77861f0153e7c06999dc987d99e0f8c92b46643ce630abd727f57e7168042  packages/core/dist/sessions/session-manager.js
2128bb0361b92d76938c4df157eb40d9bc732679e507e87ffaba1dd48e39589e  packages/core/dist/sessions/session-manager.d.ts
7677e74c5b4ffa99889ac72270607751cba93bf18cdd9bea9e0ff5da3da6b323  packages/core/dist/sessions/session-accounting.js
c61d4b9157099ead23f894768118edb989d39b10a3f7de881b76e54e54a2bfdc  packages/core/dist/sessions/session-accounting.d.ts
c14cd34c57dd426cc673bce1d624067a1d9dc9fd7a6ac5155b6e1603d7bf6cc8  packages/cli/dist/index.js
28f6febb9b51e593316bd49c125cf3170875188867bb71d4d4a43f01b274b964  packages/cli/dist/index.d.ts
d3ff7a5290e553a6e980ecfa5f90e4e90c3c46747a80b5da69adcf0aad8964bc  packages/cli/dist/commands/handler.js
c38bb88a7b1f82af302e9730aa1f2a3bc24b3482bbc556f41f7bfdab9c28e036  packages/cli/dist/commands/handler.d.ts
6736909d6984e2e3b35353d14ff136d081cd7bee6104353d964e9ba747c865ef  packages/cli/dist/rpc/rpc-controller.js
0b39a537ddb45bdc6ade89d2b022be7489643557f6d229541bf0f95443b2ce37  packages/cli/dist/rpc/rpc-controller.d.ts
cd83c107516947ff7146f2895399e9767c4346500bc455080a7dcc173046f69a  packages/cli/dist/tui/status.js
8d375bb2c8ac219fbbf646ba336994f73b55850d5f7fa02143dea773e64c57fc  packages/cli/dist/tui/status.d.ts
```

The production probe is limited to this criterion plus launcher/static health; it does not rerun every historical feature smoke chain. No deployment, push, remote CI, live-provider certification or uptime certification is implied. The whole audit remains incomplete.
