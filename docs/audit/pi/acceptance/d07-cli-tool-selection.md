# D07 — CLI tool patterns and adjustments

> **Status: REVIEW — implementation delivered; required full qualification failed** (2026-10-19)
>
> Scope: [AUDIT-4 D07](../AUDIT-4.md#4-convention-and-delivery-queue). A4-SEL remains PARTIAL. This is not D08 restoration, a new Core/Server selector ABI, an MCP prefix denial or Q03 native-failure diagnosis. D06 and all historical failed qualifications retain their states.

## Existing coverage and precise gap

`packages/core/src/tools/tool-selection.test.ts` already proves exact replacement allowlists, exclusions, presets, no-tools/no-builtins and extension policy. Core `tool-search.test.ts`/`codemode.test.ts` cover discovery and helper gates. CLI `args.test.ts` covers plain comma lists; six existing `no-mcp-process.test.ts` scenarios plus the genuine installed consumer prove native hosted denial across all five hosts, two terminal reloads, ordinary `mcp__ordinary` conservation and a real stdio no-flag control.

The missing behavior was CLI syntax resolution: raw patterns and signed entries reached Core's deliberately exact selector and unknown-name check. No new test framework or general suite rewrite is introduced. Additions are six focused private-adapter cases and eight native scenarios in the existing owning probe, reused as one new genuine installed case. The existing six native cases, all previous installed bodies/goldens, deadlines and assertions are preserved. Only two exact installed-help lines change to describe the implemented grammar.

Pinned Pi1.3 source `71023aec1546d6d677a65669c5665c0927ce0dd0`, `core/settings-manager.ts`/`core/mcp-servers.ts` and `cli/args.ts`, confirms the intended distinction: replacement names/star patterns versus ordered exact-only signed adjustments; no mixed lists or wildcard modifiers. AiHarness retains its own defaults, metadata/exposure and public contracts rather than copying Pi's SDK selector API.

## Requirement-to-source/evidence map

| D07 clause | Owning source / invariant | Concrete evidence |
|---|---|---|
| Resolve CLI patterns to concrete names | New private `packages/cli/src/cli/tool-selection.ts`; only star is special, case-insensitive full-name matching, punctuation literal, no user regex. Unmatched patterns select nothing; literal unknown checks preserve the existing hosted/helper placeholders | New adapter test covers repeated stars, literal brackets/question mark, empty matches, ordinary MCP-prefixed extension and exact public Core `allowedTools:['read*']` refusal. Native pattern scenarios inspect exact declarations in print/JSON/RPC with a real stdio MCP peer |
| Replacement differs from adjustment | Plain lists replace defaults. All-signed lists start from configured defaults and independently eligible extensions/hosted tools; exact additions/removals apply in order. `args.ts` retains repeated modifiers, accepts negative-leading values and rejects mixed/empty/wildcard signed entries | Six adapter cases cover configured defaults, duplicate removals, no-tools/no-builtins bases and explicit opt-in. Native signed scenarios in all five hosts use configured ls, then find, then ls after two real regular/fullscreen reloads; read remains removed and grep added |
| Exclusions always win | Private allow/deny getters resolve only current metadata, then unchanged Core applies exact exclusions, ownership, preset and exposure policy | Every new native scenario excludes ordinary-prefix tools; signed scenarios also exclude bash by pattern. Unit cases cover literal add versus explicit exclusion and all-star denial; lazy metadata publication/withdrawal updates concrete allow/deny lists |
| Preserve helper/capability policy | Ordinary adjustments do not accidentally make inactive code mode explicit; existing configured/eligible indirect activation remains. No-tools with only removals suppresses hosted preparation; `--no-mcp` remains native capability denial, never a string-prefix policy | Adapter helper-activation/no-builtins/preset controls, original Core search/code-mode controls, six unchanged native no-MCP scenarios and their genuine installed counterpart |
| All CLI adapters, no Core/Server ABI change | `packages/cli/src/index.ts` and `src/rpc/rpc-server.ts` use the same private translator, retain captured prompt metadata and forward concrete lists to Core. Deferred metadata getters do not execute/discover by themselves | Existing probe is extended, not replaced: print/JSON/RPC patterns and adjustments plus both terminal signed/reload scenarios. Existing Core/source/export files and SDK README remain unchanged; literal public Core semantics are separately asserted |
| Truthful parser boundary and metadata | `args.ts` validates actual lists; bootstrap guesses after unknown contributed arity cannot reject apparent flags later identified as prompt text. Two help lines document names/star and +/- semantics | One narrowly reproduced V1 parser regression and added assertions in the new adapter test; existing extension-option and credential-arity controls remain unchanged in final focus. Installed exact help equality remains mandatory |
| Genuine installed authority | `tests/functional-parity/installed-executable.test.ts` adds one case running the same eight scenarios with an outside-checkout packed Core and actual PATH bin | No workspace alias substitutes for installed Core/bin; the established explicit dependency root is used only by the test PTY driver and is not forwarded to product environment |

Selection preserves registry declaration order. No persisted active-tool intent, branch restoration, CLI pattern policy in Server/Web, public selector callback, schema version, trust grant, dependency, build flag, transport timeout, provider retry or screenshot change is introduced. Existing CLI argument byte/count bounds remain; this is not a new general pattern language or arbitrary remote-schema admission claim.

## Actual iteration chronology

All product tests, TypeScript and parser execution run in Docker. Entry checkout `29cff24d9372177ee829c45e6972e03c2636180a` was clean; D06's implementation is preserved, not retried or rewritten.

| Candidate/run | Actual result | Limit / reason |
|---|---|---|
| Parent D06 image plus only new native witnesses | RED:8fail/6notselected,23.15s | Six headless cases reject previously unknown patterns/modifiers; two PTYs never reach ready after the same early refusal. Parent runtime/emitted code is unchanged; no later assertions on failed cases are counted as proof |
| V1 fresh image | Types0, strict changed-test compile0, seven focused files70pass,17.90s | Original Core/CLI controls plus six private-adapter and eight native additions pass. Actual image inspection1234present/6context-only/Git/source+SDK matches |
| V1 re-reading actual parser | Deterministic exit1 | `--review-check hello --tools read,+grep`: definitive contributed boolean arity keeps the last two tokens in the prompt, but bootstrap wrongly rejects a mixed list. This is a demonstrated new D07 grammar defect, not a native-crash diagnosis |
| V1 parity | Intentionally cancelled/superseded, not a complete qualification | Candidate withdrawn for that concrete parser defect before a final matrix. Raw log, Make result and explicit stop receipt remain; no unrelated native failure was observed before cancellation, no full suite started and no green aggregate is claimed |
| V2 corrected candidate | Eight source/test files frozen before final build | Only args validation's bootstrap ambiguity guard and its new focused assertions differ from V1. Existing product retry/deadline/assertion controls are not relaxed |

Raw differential/iteration artifacts use `/tmp/aih-a4-d07-red.*` and `/tmp/aih-a4-d07-v1-*`, including `bootstrap-repro`, `withdrawn.txt`, `stop` and `parity`. An initial V1 inspection setup failed because the background preparation had not written the separate SDK manifest; setup was corrected before the successful image observation, without another product test. These transient artifacts supplement this versioned source/outcome map; they are not its only definition of acceptance.

## Final frozen CLI qualification

V2 uses the original CLI matrix: `make typecheck`, `make test-parity`, `make test`, plus strict changed-test compilation and nine owning/control files. Eight source/test witnesses and separate unchanged SDK README are frozen alongside all1,240 checkout path/mode/single-link/byte identities. Sources cannot change during final qualification. Audit/root documentation is excluded by existing Docker policy; nested SDK documentation is not. Actual immutable-image inspection is required to reconcile included inputs and exact context exclusions.

No Server/Core/Web product implementation, launcher, dependency or asset is changed; browser/production qualification is neither substituted for CLI tests nor claimed. Whole-current-candidate Q03, D06 and historical native failures are separate from D07's applicable CLI validation.

| Gate | Actual V2 outcome |
|---|---|
| Original `make typecheck IMAGE_TYPECHECK=aih-a4-d07-v2:test` | PASS, workspace and parity types, exit0 |
| Strict changed CLI-test compilation | PASS, exit0 |
| Nine focused files | PASS,102/102,52.00s, including both real terminal reloads and25 unchanged credential-arity process controls |
| Original `make test-parity IMAGE_TEST_RUN=aih-a4-d07-v2:parity` | PASS,264/264 across3files,303.63s; the new outside-checkout PATH-bin case executes all eight added scenarios, and the original no-MCP installed case remains passing |
| Original `make test IMAGE_TEST_RUN=aih-a4-d07-v2:full` | **FAILED**,6155pass/1fail of6156;396filespass/1fail of397,1197.87s, Make2. One unchanged installed theme declaration compiler terminates natively; the new D07 installed case and owning tests pass |
| Browser/production/assets | Not applicable to these CLI-only source changes; not run or claimed |
| Actual image/context/source conservation | PASS,1234present/6context-only, actual paths/modes/link identities/bytes, Git absence, all eight changed source witnesses and separate SDK README |

Actual test/parity/full image: `sha256:9fdb8412fa6ba861bdd1bb57bd0c2c70ce67599f552dbcaa74780a6d38e92321`, Node24.15.0/V8 `13.6.233.17-node.48`, Linux x64. All1,240 frozen input identities are checked before/after each final executed stage. The context-only exclusions are exactly `.docker/Dockerfile.lockfile`, `.docker/Dockerfile.prod`, `LICENSE`, `Makefile`, `scripts/check-doc-versioning.sh` and `scripts/sync-doc-screenshots.sh`; included SDK documentation is not confused with excluded audit documentation.

| Frozen source/test witness | SHA-256 |
|---|---|
| `packages/cli/src/index.ts` | `5b0838bc06bad875b35e4a4e20ed29144052d9b59b6ceb548dd2a316e28ec46a` |
| `packages/cli/src/rpc/rpc-server.ts` | `5177443076f3d9f8e2a833beac653de31792eb62b09a4715b0894ac40ed58373` |
| `packages/cli/src/cli/args.ts` | `8af3f2d8ff94e2e23db43cede48b27a4b596a9482a245a730466417a727ee86d` |
| `packages/cli/src/cli/tool-selection.ts` | `4bab252e89918ee79cd9c4e381f49e5a1c75525cd3cfe055cdc45ec5bacdb6d1` |
| `packages/cli/src/cli/tool-selection.test.ts` | `f878115351a833171fcbdac3cae410fc31c7b93f892ecb52118f3a7e72d61643` |
| `packages/cli/src/cli/fixtures/no-mcp-probe.mjs` | `17369461b1a3a831905a9e5c1a4c4ba67ad15cb614411c0da9c5d4134ae10780` |
| `packages/cli/src/cli/no-mcp-process.test.ts` | `7217a9cf03552bf1862502ff698dbbd31ab2578448108625df1c32a61b9a1365` |
| `tests/functional-parity/installed-executable.test.ts` | `7af362e2f2002cc734f7bf44c79fac1c520cc33fc6c9f38fb9fcc4723127694a` |

Separate unchanged `packages/core/src/sdk/README.md`: `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`. Final raw logs/exits/checks use `/tmp/aih-a4-d07-v2-*`. No source overlay, test filtering or retry replaces the mandatory complete targets.

The failed full case is `discovers themes through installed readonly Core declarations and the actual PATH bin`. Actual command: `/usr/local/bin/node /app/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node theme-public.ts`; captured code null, SIGSEGV, empty stdout/stderr in the retained assertion. The original installed body and compiler invocation are byte-conserved. The same case passed the separate complete parity gate; that does not waive the full failure or diagnose a cause. No engine/compiler flags, memory limits, launcher, deadlines, assertions, process helper or dependency changes, no native repair and no unchanged rerun follow this failure. A further bounded instruction is required before diagnosis/requalification.

Final full log SHA-256: `7ad0e92a335798673f5317ef21f4da4cf09e9157321bfd1dd7f6a81487ae38f1`; parity log SHA-256: `2c3310156dabe374685981b7ebf496cac80b4d56a0422b7fad3a5d8db7493dd5`. Source/context checks remain unchanged after settlement. Final static reconciliation passes: all49 other task rows, all29 family states, Q01/Q02 and product decisions unchanged; all prior installed bodies and six native controls byte-conserved; Core/Server/Web/build inputs and D06's interrupted-output body unchanged. `make lint-docs` PASS (160 Markdown files/1,270 local links); both worktree/staged whitespace checks PASS. The new ignored audit receipt is explicitly staged without changing ignore/linter policy. These documentary checks cannot override the failed full gate.

## Residual scope

D07 remains REVIEW, not DONE: bounded behavior is delivered and types/focused/complete parity pass, but required full verification failed. Missing green qualification is not permission to rewrite the selection adapter or diagnose an unproven native cause. A4-SEL and its original CLI-CFG-05/WEB-BASE-05/WEB-TOOL-05/A3-CLI-01 clauses stay PARTIAL. D08 still owns saved active intent, resume/fork restoration and modifier application over that restored base, including newer-owner/default/dynamic/inactive behavior. Existing deferred branch activation is reused, not counted as a new restoration implementation. Q01/Q02/Q03 failed evidence is not retrospectively diagnosed, waived or replaced by this candidate. No next queue task, remote action, release or physical-device acceptance is authorized.
