# A3-CLI-05 — Guest Intrinsics and Physical Worker Lifetime

> **Status: NOT QUALIFIED — 2026-10-18.** Candidate after `d1ba9cb`. Types, focused and installed parity pass; the required full root fails on an existing module-entry CLI child (`null`/`SIGSEGV`). The earlier failed overlay remains separate evidence. A3-CLI-05 and A3-CLI-09 remain PARTIAL; the ten-closure mandate remains 1/10.

## Whole-criterion checklist

| Existing clause | Implementation and evidence |
|---|---|
| Bounded output and linear assembly | Existing Core `tools/codemode.ts` counts aggregate UTF-8 bytes/records before appending to an array, then joins/redacts once at settlement. Existing limits stay unchanged. New real-worker test emits 900 Unicode records and verifies one complete redactor call, retained schema text and zero surviving workers; existing output/record/serialization budgets remain controls. |
| Frozen guest built-ins | Sole product change: `tools/codemode-worker.ts` recursively freezes available named intrinsic graphs/prototypes, accessor functions and async/generator/iterator prototypes before guest execution. Core tests inspect 36 named objects, reachable prototypes and pollution attempts. Captured Object/JSON/Error preserve bridge data authority when globals are shadowed. |
| Native Error compatibility | Retain the original guest Error constructor and call it through QuickJS rather than assigning inherited frozen fields. Explicit error handles preserve existing host-callback limit failures and nested rejection text. Core controls include shadowed Error and exact output/input/call-limit/nested failures. No generic-error substitution is accepted. |
| Visible schema constraints and misplaced options | Exact native hosted schema is visible inline and through `describeTool`; public probe preserves enum, string/array/item bounds, required fields and additionalProperties. Seven malformed/misplaced hosted inputs refuse before creating a worker or invoking a nested tool. No unrelated universal schema/accessor policy is introduced. |
| Terminate non-interruptible computation | Real workers run loops, promise chains, excessive allocation/output and catastrophic regex. Completion/abort/deadline returns only after exit, with immediate subsequent capacity reuse. Public Core probes preserve exact deadline/abort messages and forward nested cancellation. |
| Count physical workers until exit under storms | Existing quota **8**, counter and awaited `worker.terminate()` already implement admission; no quota defect is invented. A subclass of the real Worker tracks creation through exit. Twelve eight-worker abort rounds (96 workers) and three eight-worker deadline rounds (24 workers) refuse the ninth admission, retain peak 8 and have zero surviving workers at every round. |
| Real host/public/installed boundaries | 26 actual Core/print/JSON/RPC scenarios cover freezing/global replacement, exact errors, schema/options/output, Core deadline/abort, nested effect receipts, persisted tool results and success-only store state. The matching 26 outside-checkout installed package/PATH-bin cases require their genuine package gate; their presence is not a passing result. |

No public export/signature, tool schema, persisted format, provider protocol, runtime flag or dependency changes. All original ceilings remain: timeout 10,000 ms, VM 32 MiB, stack 256 KiB, interrupts 10,000, calls 64, concurrency 4, source/input/output 64 KiB, nested results 256 KiB and workers 8. New tests use existing host-only limit reduction; no old deadline, selector, snapshot, retry or suite ownership changes.

## Retained iterations

1. Initial isolated parent at `784a7ba`: **39 failures / 53 controls**, 92 cases. Initial intrinsic-freezing candidate: **91 passed / 1 existing diagnostic regression** (`Nested tool is not enabled.` became generic script failure). This was not a passing qualification.
2. Investigation of the shipped QuickJS library confirmed `newError` allocates and assigns name/message properties, incompatible with inherited frozen fields. Native guest construction/explicit error handles correct that compatibility issue. Corrected isolated candidate: **4 files / 96 passed**, 7.81 s. This does not diagnose native Node/V8 exits.
3. Expanded isolated public review: candidate **5 files / 122 passed**, 17.27 s. Parent **FAILED**, 41 failed / 57 passed of 122, 1 unhandled worker error and 24 cases unfinished, 18.65 s. V8 printed `Check failed: GenerateCodeFromTurboshaftGraph(&linkage, turboshaft_pipeline, &pipeline, data.osr_helper_ptr()).`; Vitest retained **SIGTRAP** during `codemode-intrinsics-review.test.ts`. This is not a complete causal count.
4. Before main freeze the Core leaf was renamed `codemode-intrinsics.test.ts` and one explicit eight-worker deadline-storm control was added. Main promotion preserves committed home/model installed cases; only the new installed block was merged.
5. Final frozen overlay comparison against actual parent model image `bc1a2fce9bc292cbdaebb3d0870967869cdb7d1adc11da796d709f5887d52758`: parent **47 failed / 76 controls**, 5 files / 123 cases, 17.88 s. Candidate **FAILED: 122 passed / 1 failed**, 20.21 s. All 58 Core intrinsic/lifetime cases pass, including the new deadline storm; the actual `rpc/error` outer probe child closes **code null / SIGSEGV**, empty stdout/stderr, at process assertion line 17. No native cause is established.

Logs are `/tmp/aih-a3-codemode-{review,final-review,public-review}-{red,green}.log` and `/tmp/aih-a3-codemode-frozen-{red,green}.{log,exit}`. Original launcher `/tmp/aih-a3-codemode-qualification.sh` stopped after that failed overlay. `/tmp/aih-a3-codemode-required-gates.sh` continues only the independently planned fresh-image typecheck/focused/parity/full gates; it does not repeat, overwrite or replace either overlay result. No failed-case-only rerun, workaround or compiler/Node flag is introduced. Passing subsets never replace a failed aggregate.

## Frozen inputs and qualification

Thirteen source/test files (the five code-mode inputs plus unchanged model inputs) and included SDK README are separately hashed in `/tmp/aih-a3-codemode-{sources,included-docs}.sha256`. `/tmp/aih-a3-codemode-checkout-inputs.json` additionally freezes **1,154** tracked/nonignored checkout inputs as a superset of the Docker context, excluding only Docker-excluded docs/root Markdown; checks compare paths, file modes, link identities and bytes before/after gates. No executable edits follow the freeze. Other candidates stay in detached worktrees.

| Gate | Observed result |
|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-codemode:test` | Passed, Make 0; workspace/parity types, packaging **4/4** and dispatcher **19/19**. |
| Fresh focused code-mode and model leaves | Passed, **11 files / 198 tests**, 26.84 s, runner 0; separate from the failed overlay comparison. |
| `make test-parity IMAGE_TEST_RUN=aih-a3-codemode:parity` | Passed, **3 files / 237 tests**, 244.36 s, Make/runner 0; all 26 new installed code-mode cases pass. |
| `make test IMAGE_TEST_RUN=aih-a3-codemode:full` | **FAILED:** 354 files / 5,571 tests passed; 1 file / 1 test failed, 1072.09 s, Make 2 / runner 1. All 110 added code-mode Core/emitted/installed cases pass; no subset replaces this failed aggregate. |

All three fresh tags (`:test`, `:parity`, `:full`) share **`sha256:7d65eaf0feb001b6e5c5b73391fa69502bc780258c015c492819c3ba34174d23`**, retained in `/tmp/aih-a3-codemode-all-image-ids.txt`. Actual inspected files match all thirteen source/test hashes and the separately unchanged SDK README (`c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`); `lstat` proves Git metadata absent. Runtime: Node **v24.15.0**, V8 **13.6.233.17-node.48**, Linux x64. Receipts `/tmp/aih-a3-codemode-{test-image-id.txt,image-source-check.log,image-source-check.exit}` retain the inspection (exit 0).

```text
75f6492753daab29ac580ce9248508bd9b8c78a4ead3cd4874765996a299679a  packages/core/src/tools/codemode-worker.ts
f330e36d2386c313d8b7779b4b8d3461c9da8c837b14071308a68cd2fb6d2134  packages/core/src/tools/codemode-intrinsics.test.ts
2681007daf3e0b703840bb805e531604a7f424e595a7fcadd30c69351ddab797  packages/cli/src/cli/codemode-intrinsics-process.test.ts
ce75a9ead4267e8f8c2209dff85e17bc8573e095e20cdf5ea9899f88d1c70921  packages/cli/src/cli/fixtures/codemode-intrinsics-probe.mjs
844f8031ef25ee9d6ef0f4da984dd7eab1d4d53bd7cbc5b27d107362748b5ffa  tests/functional-parity/installed-executable.test.ts
```

The other eight inputs exactly retain the [model delivery's hashes](./model-resolution-and-scopes.md); the installed test changes only to append the 26 code-mode cases. Host metadata observed read-only: x86_64, Intel Core i7-14700KF, Microsoft virtualization, WSL2 kernel 6.18.33.2-microsoft-standard-WSL2. These identifiers are **not a diagnosis** of any native/compiler/browser failure and authorize no host/runtime mitigation.

## Required aggregate failure retained

The existing `packages/cli/src/cli/module-entry-process.test.ts` case `rpc: direct .jsx entry to .tsx with exact-source deduplication` fails through `invoke` at line 27, called at line 36:243. Its actual emitted CLI child closes **code null / SIGSEGV**. The assertion retains the signal; its displayed mismatch omits the captured stdout/stderr fields, so this report does not assert both channels were empty. No native cause is established. Logs `/tmp/aih-a3-codemode-full.{log,exit}` and the settled required-gates launcher preserve the nonzero result. All thirteen source/test hashes, separate SDK README and 1,154-input checkout snapshot still pass after the full gate.

## Post-gate inventory — remaining engine-specific gap

A supplemental, file-launched public Core probe in the same inspected image (`/tmp/aih-a3-codemode-global-inventory{.mjs,-corrected.log}`) finds QuickJS's additional **`InternalError` constructor/prototype still mutable**. The other unfrozen object/function globals it reports are script API helpers, not language intrinsics. This real coverage gap is another reason not to qualify A3-CLI-05. Add it to the freeze graph and strengthen constructor/prototype and public-host controls in a subsequent genuine frozen candidate; do not rewrite this candidate's receipts. An initial `--input-type=module` inventory invocation returned only a generic sandbox failure and no inventory (`/tmp/aih-a3-codemode-global-inventory.log`); its failure is retained, not diagnosed or counted as evidence for the intrinsic finding.

No fresh E2E or production result is claimed for this guest-bootstrap increment. Historical failed aggregates/context evidence, all five unresolved product decisions and A3-CLI-09's failed full-root compiler receipt remain intact. Only an explicit whole-clause and required-gate review may promote a criterion to DONE.
