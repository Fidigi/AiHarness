# E2E Child Termination Evidence — WEB-OPS-04 / A3-WEB-29 Subset

> **Status: PARTIAL — 2026-10-18.** A limited dispatcher observability correction is delivered with this evidence/tracker increment (parent `ca8eb79`). Controlled process regressions, fresh-image typecheck, all **5,090 root tests** and complete **570/570 E2E tests across nine configurations** pass. The production-image build **FAILED** in Server TypeScript compilation with a native allocation error/abort; no release qualification is claimed. This does not diagnose or waive either previous failed E2E run, repair server cleanup or qualify the full Web/release criteria.

## Observed Limitation and Scope

The silent `standard` termination in the mixed-ordering run left only numeric status 1 in the aggregate; later application configurations refused occupied health URLs. Inspection of `.docker/e2e-suites.mjs` shows why that report cannot identify the termination: `execute` discarded the native `code`/`signal`, mapping all signals except SIGINT to 1. This explains the missing evidence, **not the original process failure or remaining servers**.

Preserve actual child-command receipts for the product build, Playwright configurations and demo preparation: numeric aggregate `status` plus raw `code`/`signal`, and a bounded OS `spawnErrorCode` when startup fails. Native signal/start errors also get fixed diagnostic lines. No argv, command path, environment, native error message or transcript is put in the receipt. Numeric injected test runners remain compatible; original SIGINT status 130, other failure status 1, first-failure aggregation, siblings, shards, artifacts, one worker and zero retries are conserved.

Only `.docker/e2e-suites.{mjs,d.mts,test.mjs}` and the owning validation documentation change. No provider/tool/CLI/HTTP/browser API, build target, server reuse, process-tree kill, browser flag, quota, assertion wait, golden or visual baseline is changed. This correction intentionally does not kill processes by a guessed PID/port or pretend that remaining server ownership has been diagnosed.

## Concrete Proof

`.docker/e2e-suites.test.mjs` launches the actual dispatcher in a disposable cwd with an explicitly synthetic local npm/build shim and Node CLI. The product/browser suite is not substituted by these controls; they test process/report ownership only and contact no network/registry.

- A real child sends SIGTERM to **its own PID**; the dispatcher fails with status 1 and retains `code: null`, `signal: "SIGTERM"`.
- A real child sends SIGINT to itself; status 130 and its actual signal remain distinct.
- Real ordinary exit 7 and successful exit 0 retain their numeric code and null signal.
- Missing npm startup retains `ENOENT`, null code/signal and status 1 without leaking the temporary command scope, args or environment.
- Injected receipts verify build failure, a CI standard shard and demo preparation preserve metadata without dropping planned sibling suites. The 13 existing discovery/configuration/shard/preparation/aggregation controls remain unchanged.

## Executed Validation

- Causal RED on pre-change Docker image `aih-a3-mixed-delta:full`, product source matching `ca8eb79`, with only the new test leaf copied in: **4 failures / 13 passing controls**. Each actual-dispatcher case fails because `code`/`signal` are absent from the persisted report, not because a module is missing or a deadline changed.
- Iteration GREEN in that image with only the dispatcher, declaration and tests overlaid: `node --test .docker/e2e-suites.test.mjs` — **19/19 passed**, including six added cases; exit 0. This is a focused iteration, not a fresh-image qualification or a claim that the product E2E suite passed.

- Fresh-image `make typecheck IMAGE_TYPECHECK=aih-a3-e2e-exit:test`: **exit 0**, including all workspace/parity checks. Its filtered Docker build context executes **19/19 dispatcher controls**, not just the iteration overlay.
- All three executable/declaration hashes match the full-test image `aih-a3-e2e-exit:full` and executing E2E image `aih-a3-e2e-exit:e2e-run-26600`; included SDK documentation is separately hashed and matches both. All six frozen ordering source/test inputs also match the E2E container. An initial diagnostic tried the host `/tmp` manifest as an in-container path; passing the same manifest on stdin corrected that path mistake, not a product/test failure.
- `make lint-docs`: **139 Markdown files / 1,133 local links**, passed; whitespace checks passed. Identifier/count/journal checks preserve all 99 entries, 98 open, only A3-CLI-13 DONE, and AUDIT-2's historical body.

- `make test IMAGE_TEST_RUN=aih-a3-e2e-exit:full`: **exit 0; 340 files / 5,090 tests passed** (836.53 seconds). This is the full root aggregate, not only the 19 dispatcher controls.
- `make build-prod IMAGE_PROD=aih-a3-e2e-exit:prod`: **Make exit 2 / Docker build command exit 134**. In the default Node 26 builder, Core and CLI completed; Server `tsc` printed `FATAL ERROR: Zone Allocation failed - process out of memory`, a native stack including the V8 optimizing compile executor, then `Aborted (core dumped)`. Web compilation and final production-image qualification were not reached. Log: `/tmp/aih-a3-e2e-exit-prod.log`. A network-disabled runtime inventory from the exact builder base digest `sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913` reports **Node v26.12.0 / V8 14.6.202.34-node.39 / Linux x64**, saved as `/tmp/aih-a3-e2e-exit-prod-runtime.json`; this inventories that image, not a successful rebuild. This is the observed native outcome, **not proof of host memory exhaustion, a Node-version cause or a dispatcher regression**. No runtime version/flag, memory ceiling, dependency or production Dockerfile is changed to bypass it.
- Complete `make test-e2e IMAGE_TEST=aih-a3-e2e-exit:e2e`: **Make exit 0 / runner status 0; 570/570 passed across all nine configurations**. Standard 387 (16.5m), interactions 69 (1.1m), locale 8 (11.3s), workspace 11 (9.5s), pane 18 (18.3s), linked 43 (3.4m), title 2 (1.6s), progress 24 (12.3m), demo 8 (24.1s). `test-results/e2e-suites.json` records **status 0 / code 0 / signal null for each**, with no failed configuration. Logs: `/tmp/aih-a3-e2e-exit-e2e.log`. This is current local integrated evidence, not a filtered replacement for either historical failure or a native-cause diagnosis.

Frozen executable/declaration inputs in `/tmp/aih-a3-e2e-exit-sources.sha256` match full-test/E2E images; included SDK documentation is separate:

| Input | SHA-256 |
|---|---|
| `.docker/e2e-suites.mjs` | `3f2b845a157755931483bd64f1c746c08515107aae7fb402155b4b974b2b65f7` |
| `.docker/e2e-suites.d.mts` | `2ce40b2b28e8164a1dc9d0df4d2a08f0056569813fb477d210ae468a50f5c6f9` |
| `.docker/e2e-suites.test.mjs` | `0ad256e7116407326429f54c41d88dd85265c297cc0c1287f290f85a938af287` |
| `packages/core/src/sdk/README.md` | `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687` |

## Preserve the Earlier Failures

The original final-JSON run remains failed (569 passing / one Chromium page crash). Its artifacts remain under `/tmp/aih-a3-tool-json-e2e-artifacts/`. The subsequent mixed-ordering run remains failed (eight failed application configurations; only demo reports eight passing tests), now archived under `/tmp/aih-a3-mixed-delta-e2e-artifacts/` before another Make run can replace the normal output directories. Neither report can retrospectively gain a native signal it never captured.

See the [active AUDIT-3 journal](../AUDIT-3.md), [final-JSON evidence](./final-tool-json.md) and [mixed-ordering evidence](./mixed-delta-order.md). Full criterion acceptance, native crash diagnosis, orphan-server settlement, remote CI/deployment and physical-device certification remain open.
