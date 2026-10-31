# MOD-01 — Execution Board

> **Status: IN PROGRESS** (2026-10-31)
>
> MOD-01 and MOD-01.01b remain open. Current-candidate typecheck and parity are accepted; the nine-suite E2E attempt failed (599 passed, 137 failed). The internal-only browser diagnostic passes; six provider/model visual pairs still show baseline drift beyond the offline banner. All 38 retained visual pairs now have coarse review, not acceptance. Next: owner decision on targeted fresh captures/baseline changes, not an unchanged replay.

## 1. Authority and operating rule

This is a short operational index, not a new audit or a replacement acceptance register. [AUDIT-5](./AUDIT-5.md) owns whole-criterion status; [MOD-01](./MOD-01.md) owns requirements and historical delivery. Read this board before resuming MOD-01 work; update it in place after each bounded batch instead of creating another competing status draft. Resolve contradictions against concrete source and receipts, not whichever narrative is newest.

Snapshot scope: the existing 23-task register, selected retained receipts E1–E9 below, and the latest isolated candidate. The entire historical journal has **not** been freshly reconciled. Unreviewed history earns no additional closure credit. No implementation, test, source integration, publication, cleanup or accepted gap is authorized by creating this board.

Ownership: the coding agent prepares and verifies bounded work; the user decides contract changes, accepted gaps and delivery authorization. Record any different named owner before calling a dependency externally blocked.

## 2. Whole-MOD-01 navigation

These are the existing 23 tasks, not 23 newly assessed statuses. Only MOD-01.01b is expanded in section 3; do not infer that other work is absent or complete.

| Workstream | Existing IDs | Completion question |
|---|---|---|
| Secure existing delivery | MOD-01.00a, MOD-01.00b, MOD-01.00c | Is the selected implementation frozen, validated and delivered with truthful limits? |
| Catalogue and native integrations | MOD-01.01a, MOD-01.01b, MOD-01.01c, MOD-01.01d, MOD-01.01e | Are exact model/API/type identities and their effective native policies implemented and qualified? |
| Connection methods | MOD-01.02a, MOD-01.02b, MOD-01.02c, MOD-01.02d, MOD-01.02e | Do required key, OAuth, subscription and credential-chain flows work with owned fixtures? |
| Host composition | MOD-01.03a, MOD-01.03b, MOD-01.03c | Can the intended CLI/RPC/Server/Settings and specialized hosts actually use them? |
| Effective profiles and continuation | MOD-01.04a, MOD-01.04b | Are defaults, reserves, media and reasoning continuation effective, not merely declared? |
| Freshness and offline behavior | MOD-01.05a, MOD-01.05b | Are precedence, invalidation and passive offline behavior implemented across required hosts? |
| Cross-boundary acceptance | MOD-01.06a, MOD-01.06b, MOD-01.06c | Are wire, installed package, CLI/RPC, HTTP, browser and final Docker gates bound to the delivered source? |

Global closure and a global percentage require reconciliation of these 23 tasks against their full criteria. A completed technical incident, a commit or a larger test count does not close a parent task.

## 3. MOD-01.01b work packages

Board-local IDs below partition the active work; they do not add new parent requirements. Every provider package covers all six axes: **output, defaults, reasoning, tools, usage, API**. An axis needs the required physical request **and response** semantics and owning regressions, bound to the actual model/API/type and candidate; hashes, normalized replies and fixture joins alone are insufficient.

| ID | State | Scope / retained foundation | Remaining blocker or next concrete action | Exit criterion |
|---|---|---|---|---|
| INV | PARTIAL | E1: 334 chat identities × 6 axes; existing ledger, not a new matrix | Reconcile the 335 unindexed projection cells and ambiguous joins against retained evidence; assign each open cell its missing proof and next action | Every required cell has unambiguous source/receipt bindings and a semantic verdict or an explicitly approved gap |
| OA | PARTIAL | OpenAI: 44 models; historical scoped controls | Select and review an exact model/axis slice from INV; report the missing request/response semantics before adding tests | All required OpenAI cells meet the axis exit criterion |
| AN | BLOCKED | Anthropic: 17 models; bounded historical controls; E4 design HOLD | Agent prepares explicit transcript/tools/systemPrompt precedence and source-binding decisions; user approval is required before changing the contract; never invent historical tool bindings | Approved contract and authentic associations, then all required Anthropic cells qualified |
| GO | BLOCKED | Google: 22 models; E5 structural checks retained | Agent must resolve 234 out-of-window reference rows with authentic evidence or propose an approved replacement; no timestamp rewriting or automatic recapture | Original qualification failure resolved honestly, then all required Google cells qualified |
| AZ | PARTIAL | Azure: 45 models; historical native-path/accounting controls | Select an exact model/axis slice from INV; preserve Responses versus Chat and authentication distinctions | All required Azure cells qualified without transferring historical-source gates |
| VX | PARTIAL | Vertex: 13 models; scoped metadata/usage/thinking controls | Bind its own request/response and credential-path evidence; do not transfer Google verdicts to Vertex | All required Vertex cells qualified with their actual API-key/Bearer/ADC scope |
| BR | PARTIAL | Bedrock: 193 models; E3 distinguishes 23 numeric, 92 additional-level and 78 baseline-only profiles | Resolve the 92-model nonnumeric reasoning composition gap on a named subset first; normalized results are not physical response frames | All required Bedrock cells qualified, including nonnumeric composition and response wire semantics |
| VAL | PARTIAL | E2, E6: selected/root/typecheck/parity accepted; E7: nine-suite E2E failed; E8: bounded network diagnostic passes; E9 completes coarse review of all 38 retained visual pairs | Obtain owner decision before targeted fresh captures/baseline changes for the six provider/model pairs; other visual drift and all 137 E2E failures remain unwaived | All applicable gates accepted on one exact candidate/context; no skipped or filtered case credited as executed |
| DOC | PARTIAL | E7 delivered in `52dc040`, E8 in `3ba8a85`; E9 checkpoint/journal indexed; prior reading gaps and unapplied drafts retained | Reconcile the bounded delivered lot, reading gaps and actual gate results; finish applicable review, lint and exact-diff checks | Canonical status, journal, source and evidence agree; tracked references remain valid |
| DEL | BLOCKED | Candidate remains isolated; user authorized selective commits of validated work on 2026-10-31 | Runtime delivery still requires completed acceptance receipts and a reviewed selective diff; never include unrelated dirty files | Authorized delivery preserves unrelated work and records exact resulting source and limits |

| State | Packages |
|---|---:|
| DONE | 0 |
| PARTIAL | 7 |
| ABSENT | 0 |
| TO BE DEFINED | 0 |
| BLOCKED | 3 |
| IN PROGRESS | 0 |
| GAP ACCEPTED | 0 |
| **Total** | **10** |

Only DONE and GAP ACCEPTED count as closed: **0/10 board packages closed**. This is not a functionality percentage or the global MOD-01 denominator. States follow [the audit convention](../../ai/acceptance/audit-file-rules.md#7-state-convention-and-transitions); gaps require the user's dated decision and re-examination trigger.

E1's retained ledger records **0/2,004 semantically qualified cells**, including **335 unindexed projection cells**. That is an unreconciled evidence baseline, not proof that no implementation works. No later cell-by-cell qualification is credited here. Count future progress as newly qualified model/axis cells and closed requirements, not requests generated, tests passed, files written or debugger launches.

## 4. Candidate and validation checkpoint

| Field | Recorded state |
|---|---|
| Isolated candidate | `/tmp/aih-mod01-typescript-gc-mitigation-r1/candidate` |
| Commit / tree | `1109513ecef77915ae8805c74d3c64f6130d292b` / `449ef3f93a6ec9879d5945900a2d11e52360e099` |
| Parent | `7d60baa08831b26e1fdb8ce0f43e1d9c75b65413` |
| Mitigation delta | Only `tests/functional-parity/installed-process.ts` and its existing test; add `--no-concurrent-marking` alongside `--no-maglev` only for the exact resolved TypeScript process |
| Selected validation | 7 passed in 2 files; 327 unselected skips, not 334 passes |
| Complete root | Exact `npm test`, 525 files / 9,623 tests passed; one execution on this candidate; native/controller/Make 0 |
| Current-head standalone typecheck / parity | Each accepted once, separately admitted: typecheck with all workspace/parity-typecheck stages; parity 364 tests / 4 files; application/container/controller/Make 0 (E6) |
| E2E / delivery | One complete nine-suite attempt: 736 cases, 599 passed / 137 failed, no skips or flaky outcomes; process/container 1, controller 20, Make 2. Not accepted / not integrated (E7) |
| Browser-network diagnostic | E8: one Chromium launch on an owned internal-only bridge; online → offline → online, two events and restored loopback HTTP200 pass. Native attach/container/controller/Make0; not an application/E2E gate |
| Compiler incident | Actual SIGSEGV captured in V8 concurrent marking; compiler-only mitigation locally exercised; invalid-value origin and shared historical causes remain unknown |

Keep historical failures and absent success files unchanged. The successful root does not repair prior failed roots or prove engine stability permanently. E2 is a candidate-local receipt, not physical-provider acceptance or MOD-01.01b closure.

## 5. Single next batch and non-repetition rule

**Current execution WIP: 0. Completed batch: VAL / read-only review of the remaining 32 retained visual failures (E9).** The unchanged guarded collector copied 62 unique expected/actual images (2,657,353 bytes) from the original stopped container within the prospective 64-reference / 32 MiB / 300-second collection budget. Main/candidate protections and original receipts were unchanged at collection. All 32 unscaled side-by-side pairs were manually inspected; together with E8 this gives coarse review of all 38 retained failure pairs, not visual acceptance. A host-only presenter first failed before output (`a.bitblt is not a function`); its failure is retained and a separate row-copy presenter/output directory was used. No application launch, recapture, baseline change, acceptance promotion or cleanup occurred.

E9 observes the offline banner in 29 of the 32 pairs; three show no banner and retain small rendering/layout differences (including two 565→564-pixel MCP cards). Twelve pairs have obvious additional content/state drift: navigation/header controls, file-tree/preview composition, dark skills group controls, terminal-theme selection, notification groups or an absent Back to bottom pill. These tags are not exhaustive pixel segmentation or proof of common causality. The 32 failures remain open. No new gate, provider cell or parent closure is credited.

The prior batch completed the bounded internal-only browser diagnostic and six-pair provider visual review. The user's 2026-10-31 authorization covers continuation and selective validated commits, not automatic runtime integration. E6's accepted gates are reused; no compiler, root, typecheck or parity replay occurred. E7 adds a failed browser gate, not acceptance: 599 passed / 137 failed across all nine suites. Five suite exits were zero; standard, interactions, pane and progress exited 1. The original failure and absent success result remain unchanged.

Next decision owner: user. Are the implemented Prompt cache and desktop linked-directory/organise-navigation additions intended baseline content, and may the agent prepare fresh internal-network captures and targeted updates for the six provider/model lifecycle baselines? E8 reviews all six expected/actual pairs: Prompt cache is new in all six actual images; the desktop sidebars also add navigation controls. The offline banner is additional, not the only difference. No baseline has been changed or accepted, and the network-none actual images must not become replacement baselines. The other 32 visual mismatches now have E9 observations but remain unaccepted, as do the five reconnect/durable-UI assertions, two interaction reload/IME assertions and four other assertions. No shared-cause conclusion or blanket baseline-update proposal is imported.

E8's repaired, separately sealed controller exercised exactly one Chromium loopback probe on the unchanged image/candidate, with an owned internal-only bridge, no mounts/extra privileges and 1 GiB shared memory. Initial online, explicit offline, restored online, the two events and HTTP200 passed; native attach/container/controller/Make0. The earlier controller's missing JSON brace failed before any resource/browser creation and is retained unchanged. This answers only the bounded network-state question, not whether all 88 PWA interceptions or any of the 137 original failures are resolved. No original application suite or compiler gate was replayed, no successor gate is admitted, and the stopped probe/network remain retained.

E7 retains the stopped non-OOM container/image and all three original artifact roots: 601 files / 28,282,144 bytes. Nine genuine HTML reports were collected with bounded identity-checked reads and their embedded JSON decoded with size/name/CRC checks; the original configurations did not generate the initially expected standalone JSON report files. Two failure DOM snapshots and six provider/model lifecycle expected/actual/diff images were also collected; E7 initially reviewed only the desktop-light/mobile-light expected/actual pairs. E8 subsequently collected the remaining eight provider expected/actual PNGs with the unchanged guarded collector and reviewed all six lifecycle pairs; no new application screenshots were captured. No baseline update, destructive host cleanup or source-container removal occurred. Preserve the original wrapper, 1 GiB shared memory, worker/retry/deadline policies, assertions and teardown in any separately reviewed successor.

Reuse the accepted current-head gates while their source/context remains applicable. Stop at an unexpected failure and update this board before preparing changed inputs. Do not replay spent controllers or the already-green root without an explicit source/context change or a new justified acceptance question. Gate success enables only its stated successor, never automatic integration or global closure.

For every subsequent batch:

1. Select **one** board package and an exact model/axis/requirement slice; record candidate/context, owner, missing proof, exit criterion, execution budget and dependencies before running anything.
2. Search the evidence index and canonical journal first. Reuse an applicable accepted receipt; do not requalify identical inputs simply because a new session started. Changed execution inputs require a new prospective seal and applicability review, not edits to old receipts.
3. Allow at most one implementation/qualification batch in flight. Separate product acceptance from an infrastructure incident; a new debugger or harness investigation needs a concrete failing receipt and bounded objective.
4. On an unchanged failure, update the blocker and its decision/unblock trigger. A new attempt needs changed inputs, a repaired observer or an explicitly new approved diagnostic question. A new directory or date is not justification.
5. Report the delta: requirements/cells newly closed, gates newly accepted, blockers added/resolved, evidence IDs and the single next action. If no acceptance moved, say so explicitly; do not present operational activity as feature progress.
6. If a second consecutive batch changes no acceptance and resolves no named blocker, stop expanding the investigation. Present the missing decision or revised bounded plan to the user before more execution.
7. Update this board's row, seven-state counts, checkpoint and six-column journal together. Closing AN/GO requires their unblock evidence; closing DEL requires authorization. Do not promote every provider because VAL passed.

Park unrelated CLI/codemode investigations, missing E77/E78 originals, live-account acceptance, production advisories and other MOD tasks outside this active lot unless explicitly selected. This parking rule does not waive them or add them silently to MOD-01.01b.

## 6. Evidence index and durability

E1–E5 are **local retained artifacts**, deliberately plain paths, not active links or claims of versioned delivery. E6–E9 add versioned checkpoints containing exact gate/native results, report counts and raw-channel hashes, not the complete local evidence corpus. Preserve original receipts and failures. Before runtime delivery, retain the authorized evidence durably with hashes and bind the delivered candidate; `/tmp` alone is not a durable acceptance archive. If an artifact is unavailable later, mark its binding unavailable rather than regenerating a historical success.

| ID | Exact local artifact(s) | What it establishes / does not establish |
|---|---|---|
| E1 | `/tmp/aih-mod01-model-axis-ledger-20261031-r1/ledger-result.json`; same directory `audit-result.json` | Identity/axis navigation and structural counts; no semantic cell closure |
| E2 | Base `/tmp/aih-mod01-typescript-gc-mitigation-r1/`: `focused-r2/run/installed-result.json`, `root/run/root-result.json`, `source-result.json`, `post-audit.json` | Exact isolated source, selected/root results and original preservation audit; later typecheck/parity in E6; no E2E or runtime delivery |
| E3 | `/tmp/aih-mod01-bedrock-reasoning-ledger-20261031-r1/association-result.json` | Existing associations and 92 static composition gaps; explicitly zero physical response-wire rows |
| E4 | `/tmp/aih-mod01-anthropic-inline-semantic-20261031-r1/core-transcript-design-HOLD.md` | Concrete design choices awaiting review; no implementation admission |
| E5 | `/tmp/aih-mod01-google-terminal-simple-reference-20261030/fixture-qualification.json` | 234 out-of-window rows and `fullIndependentVerdict:false`; structural success is not full qualification |
| E6 | [Current-candidate validation checkpoint](./evidence/MOD-01.01b-1109513-validation.json); `/tmp/aih-mod01-resume-20261031-r1/gate-audit.json` | Fresh typecheck/parity accepted once each at `1109513`; 1,809 source entries / 12 original dirty files preserved. Raw evidence remains local; no E2E or provider-cell closure |
| E7 | [Nine-suite E2E failure checkpoint](./evidence/MOD-01.01b-1109513-e2e-failure.json); base `/tmp/aih-mod01-typescript-gc-mitigation-r1/e2e/`: `run/completion.json`, `failure-audit.json`, `collection/decoded-reports.json`, `collection/failure-classification.json` | One failed attempt, 599 passed / 137 failed; all nine HTML reports decoded, all three artifact roots retained. 67 frozen files / 1,809 source entries / 12 original files verified before this documentation update. Zero new gates accepted or model-axis cells closed |
| E8 | [Browser-network and bounded visual review checkpoint](./evidence/MOD-01.01b-browser-network-context.json); `/tmp/aih-mod01-browser-network-context-r2/run/result.json`, same base `post-audit.json`; failed R1 preserved separately | Internal-only Chromium state transitions pass; all six provider/model visual pairs reviewed, not all 38 visual failures. Nine sealed files / 1,809 source entries / 13 current main files checked before documentation updates. Zero application gates, provider cells or parent closures newly accepted |
| E9 | [Remaining retained visual review](./evidence/MOD-01.01b-retained-visual-review.json); `/tmp/aih-mod01-remaining-visual-review-r1/{plan,collection}.json`, same base `pairs-r2/` | 32 indexed manual observations / 62 hash-matched images; 29 pairs show a banner, three do not; twelve flag obvious additional content/state drift. No fresh screenshots, application gates, baseline changes or acceptance credit; raw evidence remains local |

## 7. Board journal

This journal records operational tracking, not a replacement for parent-task delivery receipts. The first row imports retained facts; no parent requirement changed state and no application command was rerun.

| Date | ID(s) | Old → New | Evidence | Validation | Notes/decision |
|---|---|---|---|---|---|
| 2026-10-31 | VAL | PARTIAL → IN PROGRESS | E9 local `board-at-admission.md` and `plan.json` | Prospective 32-case retained-image review; no application execution admitted | Coding agent owns read-only collection/review only; user retains baseline-intent decision |
| 2026-10-31 | VAL, DOC | IN PROGRESS → PARTIAL; parents unchanged | E9 | 62 original image hashes verified; 32 pairs inspected; protections and original receipts unchanged at collection; `make lint-docs` and `git diff --check` 0 | First host presenter failed before image output and remains retained; separate presenter succeeded. All 137 failures remain unwaived; zero new gates/cells/closures. Stop expansion pending the baseline decision, not a blanket recapture/update |
| 2026-10-31 | INV, OA, AN, GO, AZ, VX, BR, VAL, DOC, DEL | Not recorded here → initial baseline (7 PARTIAL, 3 BLOCKED); no parent-status transition | E1–E5; `docs/audit/pi/MOD-01-tracking.md`; `docs/audit/README.md` | `make lint-docs` (0); `git diff --check` (0); no application gate executed | Introduce one maintained board, exact-source checkpoint and non-repetition rule; preserve all existing dirty files and historical failures |
| 2026-10-31 | VAL, DEL | VAL PARTIAL → IN PROGRESS; DEL remains BLOCKED pending runtime acceptance | User authorized resumption and selective validated commits; current candidate E2 | Repository/candidate identity and empty index inspected; no new application execution yet | Prepare one typecheck; accept stage notices from stdout plus stderr prospectively; no root replay or provider-contract change |
| 2026-10-31 | VAL, DOC | VAL IN PROGRESS → PARTIAL at batch end; parent requirements remain open | E6; typecheck seal `7de51d8a318051ef03fd8d47f61dbda10ba6b49cba67bb3093823cf8a3069040`; parity seal `60bb63e0580c22af4f87fd7f4e4d27d6889235a6ebf4a2274c3c708d32dd9d77` | Typecheck 0 with all stages; parity 364 / 4 files, application/container/controller/Make 0; source/protection audit passed | Two previously missing current-candidate gates accepted; zero new model-axis cells or parent closures. Next: retention-preserving nine-suite browser admission; no compiler/root replay |
| 2026-10-31 | VAL | PARTIAL → IN PROGRESS | Unchanged `1109513`; E6 prerequisites; prospective retained-container E2E plan in section 5 | No new application execution at admission preparation | One complete nine-suite attempt; preserve three artifact roots and raw native failures; no repetition of accepted gates |
| 2026-10-31 | VAL, DOC | VAL IN PROGRESS → PARTIAL; parents stay open | E7; seal `7f8b4f7541238d837501bae721e83e4d3e15a5bed8d251fdba2783589d3123db`; canonical MOD-01/AUDIT-5 checkpoint additions | Docker/Make build 0; nine-suite E2E 599 passed / 137 failed, process/container 1, controller 20, Make 2; readonly source/receipt audit, `make lint-docs` and `git diff --check` passed | Zero gates accepted or cells closed. Keep all failures and stopped resources; review browser-network context and independent visual drift before changed inputs; no unchanged retry or automatic baseline update |
| 2026-10-31 | VAL | PARTIAL → IN PROGRESS | Retained R1 prospective board/admission; manifest `a19a0af11668b9fda5206b115c1cef17e1590d9a6547306ebe8b296ee7944b85` | Diagnostic-only admission, no application gate admitted | Later journal indexing of the retained prospective admission, not retrospective authorization |
| 2026-10-31 | VAL | IN PROGRESS remains; diagnostic admission failed before browser launch | `/tmp/aih-mod01-browser-network-context-r1/run/failure.json`; original malformed metadata channel retained | Controller 20 / Make 2; zero networks/containers created, zero browser/application launches | Second batch without acceptance movement: stop expansion and present revised bounded plan. Correct only the JSON metadata format, prove it by read-only preflight, then admit at most one actual Chromium probe; no E2E replay or product change |
| 2026-10-31 | VAL, DOC | IN PROGRESS → PARTIAL; parents remain open | E8; revised diagnostic seal `304bdfa7e48bd58ec7b487273ce1b7e2d23594b4d260c5350b63154835450758` | One Chromium launch: states true/false/true, events offline/online, loopback HTTP200; native attach/container/controller/Make0; six provider visual pairs reviewed; readonly preservation audit passed | Network-state question answered, not a new application gate or resolution of all 137 failures. Keep both diagnostic histories and original E2E failures. Request targeted baseline-intent/capture decision; no baseline update, forced click, product change, repeated root or whole-parent closure |
