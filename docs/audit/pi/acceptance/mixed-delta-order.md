# Mixed Reasoning/Text Order — A3-CLI-11 Subset

> **Status: PARTIAL for A3-CLI-11 — 2026-10-18.** Mixed-input ordering remains **uncommitted work on base `81129d5`**. Complete unit/public parity checks pass, but integrated E2E FAILED: eight application configurations failed and only demo executed successfully. Implementation is paused for the user-requested [active tracker](../AUDIT-3.md) reconciliation. No whole-review or integrated acceptance is claimed.

## Narrow Contract and Owning Changes

One OpenAI-compatible SSE delta may contain both `reasoning_content` and `content`; JSON property order is not a semantic emission order. `packages/core/src/providers/index.ts` now publishes and **awaits** reasoning before text in that one delta, inherited by Azure and local adapters. `packages/core/src/agent/provider-turn.ts` similarly publishes/awaits reasoning before text when one extension callback supplies both text and a `reasoning_delta` event.

This is not global transcript sorting. Separate SSE records/callbacks retain their original order even when transported in one HTTP write. Empty values remain absent. Final content, reasoning, tool calls, usage normalization, length-stop evidence, byte/event ceilings, callback backpressure and protocol versions remain unchanged. Independent stateful redactor buffering/final flush is untouched; this does not guarantee an earlier visible private/redacted suffix or change other dialects' ordered blocks, signed replay or admission rules.

The code only moves the two existing blocks at each owner. There is no new setting, sorting buffer, provider method, public SDK export, automatic retry, golden update, permission or extra resource discovery.

## Requirement → Evidence

| Delivered subset | Evidence |
|---|---|
| Reasoning first regardless of property order | `packages/core/src/providers/mixed-delta-order.test.ts`: native real HTTP/SSE fixtures for OpenAI, Azure and local, with both key orders |
| Preserve distinct event order and final data | Same file: separate text→reasoning records, empty pairs, repeated mixed fields and Unicode values, with/without a final tool call; exact content/reasoning, cache usage, length-stop and complete-tool event |
| Await each consumer before the next block | Native callbacks yield asynchronously and assert exact start/end order, including the following tool event; shared-turn callbacks do the same |
| Combined extension callback | Same file: real shared `streamProviderTurn` with one text+reasoning callback, immediate redaction, separate-callback control and no duplicate final assembly |
| Observer failure remains terminal | Same file: reasoning observer throws before text delivery; no text callback, automatic retry or second provider attempt |
| Emitted print/JSON/RPC/public SDK | `packages/cli/src/cli/mixed-delta-process.test.ts` and `fixtures/mixed-delta-probe.mjs`: 12 cases over four modes × native mixed SSE / combined callback / separate callback control; exact exits/channels, delta order/content/indices, final blocks, SDK journal events, persistent history and final-text-only print |
| Genuine outside-checkout installed consumer | 12 additional cases in `tests/functional-parity/installed-executable.test.ts` copy that public probe outside the repository and consume the actual packed/installed Core root and PATH-bin CLI |
| Maintainer/user contract | `docs/ai/topics/providers.md` and `docs/users/{en,fr}/user-guide.md` |

All services, directories, trust and credentials are disposable/local. The public probe resolves only the supported `@ai-harness/core` root through Node package resolution, not private/source aliases. The extension used for the generic callback is an explicit trusted fixture; the SDK receives a borrowed instance and does not implicitly load extensions.

## Validation Actually Executed

- Causal RED: copy only the new Core test leaf into pre-change Docker image `aih-a3-tool-json:full`, whose product code matches parent `81129d5`: **20 failures / 25 passing controls**. Assertions show text before reasoning in both mixed native key orders/repeated pairs, and text delivered before the failing mixed reasoning observer. These are order/effect assertions, not missing-module or timeout failures.
- An initial public-probe iteration had three SDK fixture setup failures (`ERR_MODULE_NOT_FOUND` for a bare import from the disposable outside-checkout module), with 116 other checks passing. Correct only that fixture's public-root resolution; do not modify product loader/trust policy or count those failures as causal evidence. Initial output is retained as `/tmp/aih-a3-mixed-delta-focused-initial.log`.
- Final `make typecheck IMAGE_TYPECHECK=aih-a3-mixed-delta:test`: **exit 0**, supported Node 24.15.0; all workspace/parity TypeScript checks pass.
- Focused Docker command `npx vitest run packages/core/src/providers/mixed-delta-order.test.ts packages/cli/src/cli/mixed-delta-process.test.ts packages/cli/src/agent/provider-turn.test.ts packages/core/src/providers/tool-arguments.test.ts`: **119/119 passed**, four files; 45 new native/shared checks, 12 new emitted/public checks and 62 existing final-JSON/retry/backpressure/redaction controls. Exit 0.

- `make test-parity IMAGE_TEST_RUN=aih-a3-mixed-delta:parity`: **117/117 passed**, two files, exit 0; includes all 12 new genuinely installed cases and unchanged public goldens.
- `make lint-docs`: **138 Markdown files / 1,111 local links**, no link or versioning-boundary violation. `git diff --check`: passed.
- SHA-256 checks match all six changed/new executable source/test files against both parity and full-test images. The included `packages/core/src/sdk/README.md` is separately hashed and also matches both; root documentation is excluded by `.dockerignore`.
- `make test IMAGE_TEST_RUN=aih-a3-mixed-delta:full`: **340 files / 5,090 tests passed**, exit 0, 848.06 seconds. This includes the added 12 installed cases as well as the 57 new focused checks; overlapping gate totals are not added together as unique tests.

## Latest Integrated E2E — FAILED

`make test-e2e IMAGE_TEST=aih-a3-mixed-delta:e2e`: **Make exit 2 / runner status 1**. All nine configurations were attempted with the owned one-worker/zero-retry runner, but the application test bodies were not qualified:

| Configuration | Actual outcome |
|---|---|
| standard | Status 1 after server startup messages, before announcing test execution; termination cause not established |
| interactions | Status 1; `http://127.0.0.1:3099/health` already used |
| locale | Status 1; same occupied 3099 health URL |
| workspace | Status 1; same occupied 3099 health URL |
| pane | Status 1; same occupied 3099 health URL |
| linked | Status 1; `http://localhost:3080/health` already used |
| title | Status 1; same occupied 3099 health URL |
| progress | Status 1; same occupied 3099 health URL |
| demo | **8 passed**, 23.5 seconds |

The current `test-results/e2e-suites.json` preserves those eight failures and demo success; `/tmp/aih-a3-mixed-delta-e2e.log` contains the actual startup/URL errors. Standard's cause and remaining server ownership are **not diagnosed**. Passing bundle/demo checks or the unit/public gates do not replace this failed aggregate. No timeout, browser flag, assertion, selector, retry or suite-ownership change is made to conceal it. Source/test hashes remain frozen; the product patch is not committed by this documentation reconciliation.

## Boundaries Still Open

A3-CLI-11 remains PARTIAL: busy/capacity/upstream retry, strict-tools bounded fallback, complete Unicode streaming conformance, Claude/Bedrock error-image ordering, full arbitrary-provider argument/schema/accessor/size policy and remaining cross-platform races are not accepted here. The malformed-final-JSON subset is separately recorded in [final tool JSON](./final-tool-json.md).

The prior commit's full nine-suite E2E run **failed** on a Chromium page crash during `interactions` navigation (569 passing / one failing). It remains historical failed evidence, not diagnosed or waived by this ordering patch. Its aggregate, failed test context and HTML report were copied to `/tmp/aih-a3-tool-json-e2e-artifacts/` before the next complete run could replace the normal output directories. A subsequent passing run alone would not establish a causal fix of that crash. No deployment, vendor certification, physical-device or global audit completion is claimed. The current checkpoint, remaining clauses and both failed runs are reconciled in AUDIT-3 before further implementation, as requested by the user. AUDIT-2's historical body remains unchanged.
