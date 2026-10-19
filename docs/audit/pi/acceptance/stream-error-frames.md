# Explicit OpenAI-compatible SSE error frames

> **Status: PARTIAL — narrow subset delivered; local qualification passed** (2026-10-18)
>
> Narrow A3-CLI-11 correction on parent `f213422`. User explicitly authorized resuming qualification. No whole-criterion, native-cause or release acceptance.

> **2026-10-19 follow-up:** [D06](./d06-cli-failed-prefix.md) implements durable CLI print/JSON Unicode prefixes and adds native/installed reload/resume evidence. It remains REVIEW: required parity failed261/2; full was not run. RPC persistence is unchanged. The gap and all outcomes below describe this original historical candidate, not a waiver or current whole-criterion acceptance.

## Contract and boundaries

`packages/core/src/providers/index.ts` refuses an own truthy top-level SSE `error` before processing mixed-frame text/reasoning, usage or tool fragments and before normal completion publishes pending tool calls. OpenAI, Azure and local share this parser. The existing error callback receives only `The provider reported a streaming error.`; upstream error body/code/message are not copied into diagnostics, events or history. Absent/null/false controls keep normal completion, tools and usage. The added `OpenAiStreamChunk.error?: unknown` is private, not a public ABI change.

Existing shared retries apply before visible output. Core/SDK default to three attempts; CLI/RPC default to four with unchanged 2/4/8-second delays and existing settings authority. Text/reasoning already delivered prevent replay; direct adapter error callbacks do not automatically retry this SSE body. Existing byte/event/tool bounds, cancellation, malformed-final-JSON terminal policy, protocol versions, channel assignment and explicit SDK/RPC follow-up remain unchanged. Neither a new transient-error classifier nor strict-tools fallback is implemented.

**Known remaining gap:** SDK messages/history retain the interrupted prefix with error metadata. JSON/RPC streamed assistant error records retain text, but durable CLI/RPC history loses that failed prefix. This subset does not repair or qualify full Unicode/partial-stream retention. Other A3-CLI-11 dialect/retry/fallback/error-image/schema/accessor/size/race clauses remain open.

## Differential evidence

All product execution below is in Docker. Parent Core source hash matches `f213422`; overlays are iteration evidence, not fresh qualification.

| Run | Actual result | Evidence |
|---|---|---|
| Parent Core, new leaf only | **60 failures / 9 controls**, exit 1: complete callback called despite explicit error, or shared turn resolves instead of rejecting | `/tmp/aih-a3-stream-error-red.{log,exit}` |
| Candidate Core plus existing order/final-JSON leaves | **3 files / 170 passed**, exit 0, 898 ms: 69 new + 45 ordering + 56 final-JSON | `/tmp/aih-a3-stream-error-green.{log,exit}` |
| Initial public parent/candidate | Parent **16 failures / 4 controls**; candidate **11 passed / 9 failed**. Six new-fixture watchdogs (6 seconds shorter than existing CLI backoff) and three assumed durable-prefix assertions fail | `/tmp/aih-a3-stream-error-public-{red,green}.{log,exit}` |
| First corrected public parent/candidate | Parent **16 failures / 4 controls**; candidate **14 passed / 6 failed**. Existing CLI defaults now observed correctly, streamed prefix assertions pass, but new tests hit Vitest's 5-second default after 14.44-second execution | `/tmp/aih-a3-stream-error-corrected-{red,green}.{log,exit}` |
| Identical final public parent/candidate | Parent **16 failures / 4 controls**; candidate **20/20**, exit 0, 101.40 seconds. Four modes × recover/exhausted/prefix/queued/normal; parent queued cases activate real hooks/effects, candidate zero. SDK/RPC explicit subsequent request succeeds | `/tmp/aih-a3-stream-error-final-public-{red,green}.{log,exit}` |

Combined final causal proof: **76 failures / 13 controls across 89 new Core/public cases**, plus 101 existing Core controls. The first failed fixture iterations remain recorded; they are not replaced or counted as passing gates. Only new scenarios receive explicit 20-second test deadlines and an 18-second child watchdog to cover unchanged CLI defaults. Existing tests, budgets and product retry settings are not edited. Removing the newly assumed durable-prefix assertion does not declare that behavior acceptable or fixed; the gap remains explicit above and in AUDIT-3.

## Frozen qualification

Five changed executable/test files were frozen before typecheck; `/tmp/aih-a3-stream-error-sources.sha256`:

```text
3dc17ee745a2e25953f98c5e5d7c2bd1d97120796c03bfb9336c173840af8ab2  packages/core/src/providers/index.ts
a1917a1358f970db1597e5b983efba73273392d9ec2d6edcde0d67b9d28556f6  packages/core/src/providers/stream-error-frames.test.ts
e3296523a630a8d2e17e480a280cc5d4f6b70274cd4411da037e5c7a25b15fab  packages/cli/src/cli/stream-error-process.test.ts
952b79f8c30793fb36d460787e1b6a48782b06a39bfa05adb62fe5b3c7ba6854  packages/cli/src/cli/fixtures/stream-error-probe.mjs
c31ec25c0bf808c6258ef116598cce5eb6ee9f9ec1345a31e3f57e34c50a6d89  tests/functional-parity/installed-executable.test.ts
```

The included SDK README is separately frozen at `c34253aae578f995a8a1b9b62387deb8e65750b769b3db388524bab888935687`. Actual typecheck image `sha256:09283e09e2dbcd42b9b5d3e250204cbff6d1a0df8a060a162a1a8291f2ccf1d8` matches all six hashes; `.git` absent. Runtime: Node v24.15.0 / V8 13.6.233.17-node.48 / Linux x64. Initial bind-mounted metadata inspection failed (`sha256sum` read error); copying manifests into a disposable container verified the image successfully instead. This inspection correction is not a product-gate rerun. Root docs are excluded; `f11941a` separately qualified Git-metadata exclusion and excluded-doc staging cache identity. No executable input changes after freeze.

| Gate | Actual result | Evidence |
|---|---|---|
| `make typecheck IMAGE_TYPECHECK=aih-a3-stream-error:test` | **Passed**, Make 0, workspace/parity types; fresh image packaging **4/4** and dispatcher **19/19** controls | `/tmp/aih-a3-stream-error-typecheck.{log,exit}` |
| `make test-parity IMAGE_TEST_RUN=aih-a3-stream-error:parity` | **Passed**, 3 files / **151 tests**, 219.03 s, Make/runner 0. All 121 installed cases (20 new), 26 public goldens and 4 receipt controls pass; actual image identical to typecheck | `/tmp/aih-a3-stream-error-parity.{log,exit}` |
| `make test IMAGE_TEST_RUN=aih-a3-stream-error:full` | **Passed**, 347 files / **5,274 tests**, 1014.23 s, Make/runner 0; same actual image as typecheck/parity | `/tmp/aih-a3-stream-error-full.{log,exit}` |
| `make test-e2e IMAGE_TEST=aih-a3-stream-error:e2e` | **Passed**, **571/571** across all nine unchanged configurations, Make/runner 0. Same actual image as typecheck/parity/full; six live-container hashes match | `/tmp/aih-a3-stream-error-e2e.{log,exit}`; `test-results/e2e-suites.json` |
| `make build-prod IMAGE_PROD=aih-a3-stream-error:prod` | **Passed**, Make 0, complete Core/CLI/Server/Web/bundle-budget/final image build. Final image `sha256:14e09c8ab825c162492e2d309410c541d5db29bb331e5b56e37e85063526453c`; Node v26.12.0 / V8 14.6.202.34-node.39 / Linux x64 | `/tmp/aih-a3-stream-error-prod.{log,exit}`, `prod-image-id.txt`, `prod-runtime.json` under the same prefix |

All four test-image receipts (typecheck/parity/full/complete E2E) identify **exactly the same** `09283e…` image. Before/after manifests for every resumed gate, final host verification and actual E2E-container verification match. The original context-drift limitation is not repeated in this run or retrospectively erased from earlier evidence.

| E2E configuration | Passed | Raw command receipt |
|---|---:|---|
| standard | 388 (15.7 min) | status 0 / code 0 / signal null |
| interactions | 69 (1.1 min) | status 0 / code 0 / signal null |
| locale | 8 | status 0 / code 0 / signal null |
| workspace | 11 | status 0 / code 0 / signal null |
| pane | 18 | status 0 / code 0 / signal null |
| linked | 43 (2.4 min) | status 0 / code 0 / signal null |
| title | 2 | status 0 / code 0 / signal null |
| progress | 24 (12.2 min) | status 0 / code 0 / signal null |
| demo | 8 | status 0 / code 0 / signal null |

The resumed serial chain has settled; no qualification container remains running. Prior artifacts are retained under `/tmp/aih-a3-stream-error-parent-e2e-artifacts/`, current complete artifacts under `/tmp/aih-a3-stream-error-complete-e2e-artifacts/`. The sequence retains distinct gate exits and before/after source receipts. Historical full **5,164 passed / 1 module-entry child SIGSEGV**, MCP complete E2E **568 passed / 3 failed**, earlier compiler/worker/browser failures and context drift remain failed historical evidence. New subsets never diagnose or retrospectively replace them. No deployment, external vendor/service, remote CI or physical-device qualification claimed.

Delivery checks pass: **143 Markdown files / 1,135 local links**, tracker **224 paths / 16 owners** with unchanged AUDIT-2 history/counts/journals, working/staged whitespace and final frozen manifests. Static receipt reconciliation (`/tmp/aih-a3-stream-error-completion-check.log`) verifies all five gate exits, four identical test-image IDs, nine raw E2E receipts, exact 571 count and production/runtime identities. A3-CLI-11 remains PARTIAL; overall audit remains 98 open.
