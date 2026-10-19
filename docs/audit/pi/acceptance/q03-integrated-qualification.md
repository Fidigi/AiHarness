# Q03 — Integrated qualification of the selected candidate

> **Status: PARTIAL — required full gate failed; downstream gates not run** (2026-10-19)
>
> Scope: [AUDIT-4 Q03](../AUDIT-4.md#7-integrated-qualification). This is local integrated qualification, not a new delivery task, release/deployment approval, physical-device certification or historical native-cause diagnosis.

## Authorization and frozen candidate

The user explicitly selected Q03 after the bounded [D06 completion diagnostic](./d06-cli-failed-prefix.md#authorized-completion-attempt--2026-10-19) did not reproduce or explain the failed compiler controls. Entry checkout was clean at `965d09a7b1344c74f7c8a5e2db800fc98913da7a`, branch `feature/v0.1.1`.

The selected candidate has **exactly the same executable and build-context inputs as D07 V2**, not a newly repaired product. Only excluded audit documentation changed since that candidate. This is one separately user-authorized integrated qualification attempt, not an automatic retry-until-green sequence. D06/D07 and Q01/Q02 historical failures remain failed; passing a later gate does not explain them.

Existing coverage already owns Core/CLI/Server/Web behavior, public declarations, native processes, actual packed consumers and the nine browser configurations. The missing evidence is a complete integrated run on the selected frozen candidate, not another feature fixture. No tests, assertions, timeouts, retries, screenshots, engine/compiler flags, dependencies, build inputs or runtime settings are changed to obtain a pass. No GDB wrapper or private process-helper overlay is used in qualification.

Before qualification, all1,240 checkout input path/mode/single-link/byte identities were frozen. The original Make targets rebuild through their normal Docker cache; they resolve to the existing immutable test image `sha256:9fdb8412fa6ba861bdd1bb57bd0c2c70ce67599f552dbcaa74780a6d38e92321`. Independent actual-image inspection verifies all1,234 included inputs, six declared context exclusions and `.git` absence. The image contains the original private process helper, not the D06 diagnostic edit. Runtime: Node24.15.0/V8 `13.6.233.17-node.48`, Linux x64. Cached build-time packaging/dispatcher controls are not counted as newly executed tests.

The six context-only exclusions are `.docker/Dockerfile.lockfile`, `.docker/Dockerfile.prod`, `LICENSE`, `Makefile`, `scripts/check-doc-versioning.sh` and `scripts/sync-doc-screenshots.sh`. The SDK README remains an included input; excluded audit/root documentation is not confused with included nested documentation. Frozen checkout manifest SHA-256: `699dfe6f856f5e699c555ca5c40ffd63de0db730fae3aaffd9aa3ab54bce82d3`.

## Required gates and actual outcomes

The authorized original matrix is types → complete parity → complete root tests → all nine E2E suites → production build → actual test/production assets and runtime inspection. Each started gate executes once, with before/after frozen-input checks. The driver stops after a nonzero gate; subsequent gates are not called passed or unnecessary. No optional focused pass substitutes for a required aggregate.

| Gate | Actual outcome |
|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a4-q03-v1:test` | PASS, exit0; original workspace and parity types |
| Independent immutable test-image inspection | PASS, exit0;1,234 included/6 context-only inputs, original helper, SDK README and Git absence |
| `make test-parity IMAGE_TEST_RUN=aih-a4-q03-v1:parity` | PASS,264/264 across3files,291.53s, Make0. Includes both D06 durable-prefix cases, the D07 installed tool-selection case and all three previously failing compiler controls |
| `make test IMAGE_TEST_RUN=aih-a4-q03-v1:full` | **FAILED**,6,155pass/1fail of6,156;396filespass/1fail of397,1191.73s, runner1/Make2. One unchanged installed strict consumer compiler terminates with SIGTRAP |
| `make test-e2e IMAGE_TEST=aih-a4-q03-v1:e2e CONTAINER_PREFIX=aih-a4-q03-v1` | **NOT RUN**: driver stopped after failed full gate |
| `make build-prod IMAGE_PROD=aih-a4-q03-v1:prod` | **NOT RUN**: driver stopped after failed full gate |
| Actual test/production asset and runtime inspection | **NOT RUN**: prepared reuse of the existing terminal/schema image inspector was not executed; preparation is not qualification evidence |

The unexecuted E2E/production/asset stages remain required, not waived or declared inapplicable. Their planned commands retain the complete nine-suite runner, one worker, zero retries, rate-budget controls, baselines and production Dockerfile's original Node26 default. No production image/runtime or new browser/asset result is claimed. The driver settled at Make2 and no qualification container remains running.

## Failed full gate and bounded native evidence

The failed case is `validates installed public provider discovery declarations and keyless based-path runtime`, at `tests/functional-parity/installed-executable.test.ts:1333`: the stronger separate strict `consumer.ts` declaration check, not the earlier `provider-public.ts` check or provider runtime assertion. Actual child command:

```bash
/usr/local/bin/node /app/node_modules/typescript/bin/tsc --noEmit --strict \
  --target ES2022 --module NodeNext --moduleResolution NodeNext --types node consumer.ts
```

Captured child code is null, signal SIGTRAP and stdout empty. Stderr contains the native fatal message and stack, not a TypeScript type diagnostic:

```text
# Fatal error in , line 0
# unreachable code
----- Native stack trace -----
```

Read-only `addr2line` symbolization against the same immutable image's Node binary maps the recorded stack through:

| Recorded address | Native symbol |
|---|---|
| `0x2d9bc62` | V8 `LiveRangeBuilder::ProcessInstructions` |
| `0x2d9c60a` | V8 `LiveRangeBuilder::BuildLiveRanges` |
| `0x2acebea` | V8 Turboshaft `Pipeline::AllocateRegisters` |
| `0x28adefb` | V8 `PipelineCompilationJob::ExecuteJobImpl` |
| `0xd09ce0` | V8 `OptimizingCompileTaskExecutor::CompileTask::Run` |
| `0x9b0ab8` | Node `PlatformWorkerThread` |

The Node binary SHA-256 is `d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c`. This locates this observed stop in V8's background optimizing/register-allocation path. It does **not** prove the underlying cause, a safe Node/V8/product fix, resource exhaustion or a common cause with prior SIGSEGV/SIGABRT failures. Symbolization executes no compiler/test command and is not a diagnostic rerun or a passing gate.

The same installed case passes the separate complete parity run. The three historical editor-schema/resource/theme compiler controls and D06/D07 installed/native scenarios pass this full run as well; they do not cancel the new failure. No source repair, altered engine/compiler/runtime setting, debugger, deadline/assertion relaxation or unchanged retry follows. The frozen-input checks remain unchanged after both complete gates.

## Source and included-document witnesses

These are the12 executable/test files changed by D06/D07 relative to `0f2ceae6ed7ab23eaa8f1e6b60b1df6bba7f7995`, plus the separately frozen SDK README. They supplement the full1,240-input manifest and pinned Git candidate; they are not a claim that other inputs may drift.

| Path | SHA-256 |
|---|---|
| `packages/cli/src/cli/args.ts` | `8af3f2d8ff94e2e23db43cede48b27a4b596a9482a245a730466417a727ee86d` |
| `packages/cli/src/cli/fixtures/no-mcp-probe.mjs` | `17369461b1a3a831905a9e5c1a4c4ba67ad15cb614411c0da9c5d4134ae10780` |
| `packages/cli/src/cli/fixtures/stream-error-probe.mjs` | `a01b70426b5d22ca654487e9ba09a1578747d07a077fd465acbff00bb56fad1a` |
| `packages/cli/src/cli/json-output.test.ts` | `422538bb19e46f16744e0c13978c285e7c4e73261f1700a0e8d560aed28222f9` |
| `packages/cli/src/cli/json-output.ts` | `2b8823828846479ad76350edd7ca7e05021632c933768fad5822d657dbcc1af7` |
| `packages/cli/src/cli/no-mcp-process.test.ts` | `7217a9cf03552bf1862502ff698dbbd31ab2578448108625df1c32a61b9a1365` |
| `packages/cli/src/cli/stream-error-process.test.ts` | `39852c30a4f216f7d1e312527117d9bdd6cb2bbe57eed6c7b29854baff979465` |
| `packages/cli/src/cli/tool-selection.test.ts` | `f878115351a833171fcbdac3cae410fc31c7b93f892ecb52118f3a7e72d61643` |
| `packages/cli/src/cli/tool-selection.ts` | `4bab252e89918ee79cd9c4e381f49e5a1c75525cd3cfe055cdc45ec5bacdb6d1` |
| `packages/cli/src/index.ts` | `5b0838bc06bad875b35e4a4e20ed29144052d9b59b6ceb548dd2a316e28ec46a` |
| `packages/cli/src/rpc/rpc-server.ts` | `5177443076f3d9f8e2a833beac653de31792eb62b09a4715b0894ac40ed58373` |
| `tests/functional-parity/installed-executable.test.ts` | `7af362e2f2002cc734f7bf44c79fac1c520cc33fc6c9f38fb9fcc4723127694a` |
| `packages/core/src/sdk/README.md` | `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687` |

## Evidence and remaining acceptance

Supplementary raw commands, logs, exits, manifests, image inspection, runtime-container metadata, native symbolization and original gate driver use `/tmp/aih-a4-q03-v1-*`. All executed gates have before/after1,240-input checks; test/parity/full actual images are identical. The versioned candidate, witness, native-stop and outcome tables remain the durable record if temporary artifacts expire.

| Evidence | SHA-256 |
|---|---|
| Typecheck log | `fd9485d07675bf83edd17774d3f6c4b3b7913f50a203f870e2ea8d1ca2679933` |
| Complete parity log | `d85982e0b302975b7f0735e7c72848ac8fe8cbd7bf026641ad3f92b41ffc8d5d` |
| Complete full-suite log | `d739ed6748b2009f1355a5dd4c9b04131370f0db3bb64558b2e28095b59fa8ba` |

Final static reconciliation PASS: all50 delivery rows, all29 family rows, Q01/Q02, product decisions and previous journal entries are conserved; all13 source/SDK witnesses and actual image identities match. Only this receipt, the Q03 tracker/journal and a D06 forward evidence link change. `make lint-docs` PASS (161 Markdown files/1,276 local links); worktree/staged whitespace checks PASS. The new receipt is explicitly staged under the existing audit ignore policy; no policy, product or generated file changes.

Q03 is PARTIAL, not DONE: the full gate failed and the downstream browser/production/asset gates were not executed. No delivery/family/legacy criterion, Q01/Q02, physical device, remote Pages publication or release is closed by this passing subset. D06 remains PARTIAL; D07's separate delivery review and historical receipt are not silently closed. Further qualification requires an explicitly selected candidate/instruction, not an automatic unchanged retry. The located native stop is retained as actionable evidence, not converted into a diagnosis or accepted gap.
