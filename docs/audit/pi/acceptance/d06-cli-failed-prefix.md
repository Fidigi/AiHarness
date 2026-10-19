# D06 — Durable CLI failed-stream prefixes

> **Status: REVIEW — implementation delivered; required CLI qualification failed** (2026-10-19)
>
> Scope: [AUDIT-4 D06](../AUDIT-4.md#4-convention-and-delivery-queue), print/JSON failed-prefix persistence. A4-ERR remains PARTIAL. Historical [SSE failures and qualification](./stream-error-frames.md), Q01/Q02 and all previous Main outcomes are preserved.

## Existing coverage and exact missing behavior

Core already refuses explicit OpenAI-compatible SSE error frames before pending tools execute and prevents retry after visible text/reasoning. `packages/cli/src/cli/json-output.test.ts` already verifies live error records; `stream-error-process.test.ts` and the genuine installed consumer already exercise 20 print/JSON/RPC/SDK scenarios. The missing boundary was durable non-RPC CLI history: a rejected `streamProviderTurn` never returns a response for `runToolLoop` to save.

No new provider error classifier, retry setting, tool schema, public Core API, journal format or test framework is introduced. No RPC persistence repair, cancelled-output publication, redactor-buffer flush, renderer overhaul or whole A4-ERR acceptance is claimed.

## Implementation and acceptance map

| D06 requirement | Source authority | Focused evidence |
|---|---|---|
| Keep the received Unicode prefix durably | `packages/cli/src/index.ts`: per-turn closure collects only delivered, already-redacted text/reasoning; terminal error awaits `SessionManager.addMessage` using captured session ID and effective provider/model | Reused native probe loads the JSONL through a fresh public manager and asserts exactly one failed prefix, rich reasoning/text blocks, model/provider, no invented usage and bounded `metadata.outputError` |
| Truthful error/exit and no false successful history | Error still rejects the shared turn. Print stdout stays empty on failure, stderr retains the fixed error and exit1; JSON retains its existing error lifecycle/exit1. `packages/cli/src/cli/json-output.ts` projects the existing string output-error marker as error while retaining content; legacy `isError` fallback stays unchanged | Native print/JSON assertions plus one new `json-output.test.ts` projection case, with existing successful/length/legacy/nonstring controls |
| No duplicate prefix or replayed tool effects after reload | Error append includes no pending tool calls or usage, skips auto-compaction and carries the operation signal; cancelled/empty turns do not append. Each provider turn gets a new accumulator | New `print/durable-prefix` and `json/durable-prefix` scenarios execute one real tool before the later failed turn, reject another pending call, restart the actual CLI on the saved session and verify historical prefix/tool-call/result occur once in the next provider request; old journal entry values are conserved and effects remain exactly one hook+execution |
| Preserve refusal/retry/valid/length controls | No shared Core/parser/retry changes. Failed prefix does not become an automatic retry or a complete tool response | Existing 20 SSE scenarios, Core error-frame cases, CLI tool-loop/final-JSON/length-stop controls and original full/public parity gates |
| Genuine installed boundary | `tests/functional-parity/installed-executable.test.ts` adds only the same two durable scenarios to its existing packed Core/PATH-bin probe | Complete unchanged parity target includes public declarations, pack/install and both new scenarios outside checkout; no workspace alias substituted |

The Unicode witness uses combining marks, CJK and a ZWJ/skin-tone emoji, split text/reasoning SSE deltas and an HTTP write split inside a multibyte character. A disposable credential split across deltas must be redacted in live output, journal and resumed request. Newline-terminated safe output avoids relying on the unchanged redactor's withheld credential-prefix suffix. A prior completed tool group must survive, while a later uncompleted tool fragment must not enter history or execute. The same source probe runs emitted and installed; no test assertion, timeout, retry or screenshot is relaxed.

## Differential and iteration evidence

All product execution is in Docker. Initial checkout `0f2ceae6ed7ab23eaa8f1e6b60b1df6bba7f7995` was clean. Parent test image `aih-a3-terminal-controls-main-v6:test` supplies unchanged emitted CLI/Core; only new witnesses are copied for RED. GREEN rebuilds the changed CLI inside that parent for bounded iteration, then final qualification builds a fresh image normally.

| Run | Actual outcome | Interpretation |
|---|---|---|
| Initial RED | Two failures | Print fails the missing durable-prefix assertion; JSON first reaches an incorrect fixture assumption about a redactor-withheld suffix. No later assertions on that JSON failure are causal evidence |
| First fixture correction / initial GREEN | RED remains failed; GREEN one projection pass/two native failures | A trailing `n` still forms a credential-prefix suffix. Safe newline termination is added to the new reasoning fixture, not a product flush or assertion relaxation |
| Final identical RED/GREEN witnesses | RED three failures/30 not selected; GREEN three pass/30 not selected | Both native modes now fail on absent journal prefix in parent; projection fails as false `stop`. Candidate passes the three selected witnesses. Old 20 process and ten encoder cases are not counted as executed in this differential subset |
| First fresh candidate types / strict changed-test compile | Workspace/parity types0; strict compile2 | Four existing encoder test sinks returned `Array.push`'s number instead of void. Only those four callbacks are braced in the owning file, preserving emitted records/assertions; the failed result is retained |
| Final candidate | Six source/test files frozen after that test-only typing correction | No further executable input changes are permitted during qualification |

Raw differential artifacts: `/tmp/aih-a4-d06-{red,red-v2,red-v3,green,green-v2}.{log,exit}`. Initial type/strict artifacts use `/tmp/aih-a4-d06-*`; final frozen candidate artifacts use `/tmp/aih-a4-d06-v2-*`. These versioned source/acceptance maps and outcomes remain authoritative if temporary logs expire.

## Frozen final CLI qualification

Freeze: six changed executable/test files plus separate unchanged `packages/core/src/sdk/README.md`; all 1,238 checkout input path/mode/single-link/byte identities are captured independently of excluded root/audit documentation. Actual immutable test image inspection verifies 1,232 included inputs plus the six exact context exclusions and Git absence. No source overlay is used for final gates.

Required CLI matrix: original `make typecheck`, `make test-parity`, `make test`; additional strict changed-test compilation and focused existing controls. No Server/Core/Web implementation, launcher, dependency, build policy or asset is changed, so browser/production gates are not substituted for CLI tests or claimed as executed. Whole-current-candidate Q03 remains separate from this applicable CLI matrix.

| Gate | Settled outcome |
|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a4-d06-v2:test` | PASS, workspace and original parity types, exit0 |
| Additional strict changed CLI-test compilation | PASS, exit0; no changed test excluded |
| Six focused files | PASS,160/160,125.43s: encoder11, CLI tool loop8, Core SSE69, final JSON36, native SSE22, length-stop14 |
| `make test-parity IMAGE_TEST_RUN=aih-a4-d06-v2:parity` | **FAILED**,261pass/2fail of263,288.99s, make exit2. The two new installed durable scenarios and the original20 SSE scenarios pass; two unchanged installed public-type controls fail |
| `make test` | **NOT RUN**: qualification driver stops at failed parity; no inference from previous candidates |
| New browser/production/assets | Not applicable to this CLI-only source change and not run; whole-current-candidate Q03 remains unqualified |
| Source/context/image conservation | PASS, all six source hashes and SDK README unchanged; all1,238 frozen identities checked before/after each executed gate and at final settlement; immutable-image1232/6 check0 |

The failed installed controls are `ships native editor schemas and public declarations outside the checkout` (`tsc editor-schema-public.ts`, code null, SIGSEGV) and `preserves scoped Markdown selectors through installed readonly declarations, runtime and PATH bin` (`tsc resource-public.ts`, code null, SIGABRT). The latter's actual child stderr records `FATAL ERROR: Zone Allocation failed - process out of memory` and its native stack. These commands, channels and signals were retained in the single complete run. This is observed evidence, **not a diagnosis** of resource limits, a source compiler defect, the prior Q01/Q02 failure or this delivery. No compiler/runtime flags, assertions, deadline, process helper, launcher, dependency or retry policy is changed. No unchanged rerun, additional diagnostic or full-suite attempt follows the failure; a further bounded instruction is required.

Both final tags resolve to immutable image `sha256:0897f4dd005a5d29c300e988e1a7785d69a49636c607aa06063943da62ddab72` (Node24.15.0/V8 `13.6.233.17-node.48`, Linux x64). Parent product sources for both modified runtime files match Git baseline0f2ceae; the parent is not called the final candidate. Final parity log SHA-256: `b4a8d5845dc7613f3d3d645804bede0e9fbcd490d00e7fc1f9414fe949f90796`.

Frozen executable source witnesses (SHA-256):

| File | Digest |
|---|---|
| `packages/cli/src/index.ts` | `4177a5f4eaf8e45ed982f12b91ebb30e003d4ee47d5b9cf62306b67dc6c23be8` |
| `packages/cli/src/cli/json-output.ts` | `2b8823828846479ad76350edd7ca7e05021632c933768fad5822d657dbcc1af7` |
| `packages/cli/src/cli/json-output.test.ts` | `422538bb19e46f16744e0c13978c285e7c4e73261f1700a0e8d560aed28222f9` |
| `packages/cli/src/cli/stream-error-process.test.ts` | `39852c30a4f216f7d1e312527117d9bdd6cb2bbe57eed6c7b29854baff979465` |
| `packages/cli/src/cli/fixtures/stream-error-probe.mjs` | `a01b70426b5d22ca654487e9ba09a1578747d07a077fd465acbff00bb56fad1a` |
| `tests/functional-parity/installed-executable.test.ts` | `15c66a514ae795614ce9f0d100049d19ace4b7b74d7f3aba00771b8c4aa70cb3` |

Separate unchanged SDK README witness: `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`. The actual image excludes `.git` and exactly the six declared context-only inputs: `.docker/Dockerfile.lockfile`, `.docker/Dockerfile.prod`, `LICENSE`, `Makefile`, `scripts/check-doc-versioning.sh`, `scripts/sync-doc-screenshots.sh`. Included/excluded documentation is distinguished rather than claiming that a docs edit forces a source rebuild.

Documentary validation: `make lint-docs` PASS (159 Markdown files/1,263 local links); `git diff --check` and staged whitespace checks PASS. The new receipt is explicitly staged under the existing audit ignore policy; no ignore/linter policy changes. These checks do not override the failed runtime gate.

## Residual scope

D06 stays REVIEW, not DONE: code and bounded native/installed evidence exist, but the required CLI matrix is incomplete after failed parity. No family/legacy criterion is closed. Only this exact gap could later close after the missing qualification and commit/evidence review. RPC's separate persistence adapter still loses failed prefixes; SDK behavior is unchanged. Wider capacity/strict-tools fallback, error-image ordering, arbitrary schema/accessor/size admission and shell/retry races remain open in A4-ERR. Failure/cancellation does not claim successful completion, usage, compaction or permission to replay tools. No remote service, provider credential, browser, physical-device, deployment or release approval is involved.
