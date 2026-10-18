# Final Tool-Argument JSON — A3-CLI-11 Subset

> **Status: PARTIAL for A3-CLI-11 — 2026-10-18.** The malformed final JSON subset is implemented and passes the complete unit/public CLI gates. Integrated E2E FAILED on one Chromium page crash; all nine configurations completed. The other clauses of the review remain open.

## Scope and Reproduction

The source finding in `docs/audit/pi/AUDIT-3.md` is reproduced, not inferred from an upstream fix: OpenAI-compatible chat/stream, OpenAI Responses SSE/WebSocket and Anthropic streaming converted a failed final argument parse into `{ raw: ... }`. A provider response containing a valid first tool and a malformed second tool could consequently execute both through the ordinary loop.

Implement only refusal of malformed textual final arguments before any complete tool-call publication/execution, stable private diagnostics and terminal classification of that failure. This is not acceptance of the whole A3-CLI-11 review, provider parity, general schemas, accessors or output-size policy.

## Owning Changes

- Core `providers/tool-arguments.ts` supplies one internal parser and fixed `ProviderToolArgumentsError`. It does not export a new root SDK API or copy a reference-product contract. Nonempty malformed JSON is neither repaired nor converted to raw tool input. Nonstring values passed directly to this parser fail without coercion/serializers/getters.
- `providers/index.ts` uses that parser at all three existing final string-assembly owners. Each parses the complete batch before publishing any complete `tool_call` or returning a successful response. OpenAI-compatible nonstream chat shares the same parser. Responses SSE/WebSocket share their finalizer; an already-started WebSocket failure retains no cached continuation/socket and cannot replay through SSE.
- `agent/provider-turn.ts` treats the internal protocol error as terminal even when no text delta preceded it. Ordinary transient-error retry, hooks, cancellation, message framing and tool selection are unchanged. An explicit later request remains allowed.
- Preserve existing empty/absent no-argument `{}` behavior and the `unknown` input ABI for valid JSON objects, arrays, primitives and null. This is not a new object-only or JSON Schema rule. Native object-input provider paths are not parsed as strings. Existing byte ceilings and all goldens remain unchanged.

## Clause → Concrete Evidence

| Delivered subset | Evidence |
|---|---|
| Invalid final JSON rejected | `packages/core/src/providers/tool-arguments.test.ts`: six malformed forms across three dialects, fragmented arguments, valid earlier call and fixed error; nonstream Completions negative/positive |
| No earlier valid tool or hook escapes the failed batch | Same real HTTP test executes `runToolLoop` and `streamProviderTurn` with registered effect counters and a `before:tool` counter; both remain zero, with only the original user entry retained |
| No automatic retry / duplicate effects | Same tests request three retries and verify one failed request before/after visible text; valid controls execute two tools once and complete normally |
| Preserve existing valid data | Eight valid/empty forms per dialect include Unicode, nested arrays/null, scalar/array/null roots; helper tests preserve inert own prototype-looking keys |
| Passive helper admission | `packages/core/src/providers/tool-arguments-admission.test.ts`: nonstrings with `toString`/`toJSON`/`Symbol.toPrimitive` accessors refuse without invoking them; this is not proof about the entire extension response graph |
| Actual WebSocket failure cannot fall back/reuse | Four added cases in `provider-websocket.integration.test.ts`: real RFC 6455 cached/auto paths, before/after text, zero tool events, no HTTP/SSE request, closed failed socket and a fresh connection for explicit recovery |
| Real emitted CLI and public SDK | `packages/cli/src/cli/tool-json-process.test.ts` / `fixtures/tool-json-probe.mjs`: 36 cases across print/JSON/RPC/SDK, three dialects, malformed-before-text/malformed-after-text/valid; exact exits/channels, fixed error, no tool effects/retries, history and SDK explicit recovery |
| Installed package, not source aliases | 24 additional cases in `tests/functional-parity/installed-executable.test.ts` copy the same public probe outside the checkout, consume genuine packed/installed Core and PATH-bin CLI and exercise invalid/valid cases for all four modes/three dialects |
| Maintainer and user contract | `docs/ai/topics/providers.md`, `docs/users/{en,fr}/user-guide.md` |

Tests use disposable directories, explicit local trust, local HTTP/SSE/WebSocket fixtures and disposable credentials. They contact no external provider, auth, MCP or package-registry service. The reusable public probe imports only the Core package root, never the new private parser. Print/JSON use their existing failure exit 1 and diagnostic channel; RPC remains alive with the existing error-message/settled grammar, while SDK uses the existing failed-run state. Visible failed text in the detached SDK runtime retains its existing durable output-error evidence.

## Validation Actually Executed

- RED on pre-change Docker image `ai-harness:test-latest-run-1792302848573139815` (product source corresponding to parent `7174970`), with only the new loopback test leaf copied in: **25 failures / 31 passing controls**. Malformed batches returned/emitted calls and the invalid loop cases resolved after tool effects instead of rejecting. No missing-module or changed-timeout failure is used as causal proof.
- `make typecheck IMAGE_TYPECHECK=aih-a3-tool-json:test`: **exit 0**, pinned Node 24.15.0; workspace checks and parity TypeScript check pass.
- Focused Docker command `npx vitest run packages/core/src/providers/tool-arguments.test.ts packages/core/src/providers/tool-arguments-admission.test.ts packages/core/src/providers/provider-websocket.integration.test.ts packages/cli/src/cli/tool-json-process.test.ts`: **101/101 passed**, four files; exit 0. This includes two pre-existing WebSocket controls, not 101 new tests.

- `make test-parity IMAGE_TEST_RUN=aih-a3-tool-json:parity`: **105/105 passed**, two files, exit 0; includes all 24 new installed cases and unchanged existing goldens.
- `make lint-docs`: **137 Markdown files / 1,110 local links**, no link or versioning-boundary violation. `git diff --check`: passed.
- The nine changed/new executable source/test files have identical SHA-256 values in the working tree and the full-test image `aih-a3-tool-json:full`.

- `make test IMAGE_TEST_RUN=aih-a3-tool-json:full`: **338 files / 5,021 tests passed**, exit 0, 832.01 seconds. Includes existing provider retry, length-output, public CLI/SDK, HTTP and persistence regressions; no filtered passing selection.

## Integrated E2E — FAILED, Not Waived

`make test-e2e IMAGE_TEST=aih-a3-tool-json:e2e`: **Make exit 2 / runner status 1**, **569 passing / 1 failing test** over all nine configurations. E2E started only after the unit suite, with the owned one-worker/zero-retry commands; there was no filtered rerun or green replacement of the failing aggregate.

| Configuration | Actual outcome |
|---|---|
| standard | 387 passed |
| interactions | 68 passed / **1 failed** |
| locale | 8 passed |
| workspace | 11 passed |
| pane | 18 passed |
| linked | 43 passed |
| title | 2 passed |
| progress | 24 passed |
| demo | 8 passed |

The failure is `[chromium] interaction-single-asset-load.spec.ts:108` → `late production chunk after terminal cannot reopen or steal focus`: `page.goto: Page crashed` at line 112 while initially navigating to the intercepted-fixture page. It occurs before the test's terminal transition and focus assertions. Chromium reports `154.0.8037.92` on Debian 12. That observation does **not** diagnose a browser bug, demonstrate a pre-existing failure or prove the Core patch unrelated. No E2E acceptance is claimed. No browser flag, selector, assertion, timeout, retry, snapshot or test ownership was changed to bypass it.

The runner preserved the aggregate in `test-results/e2e-suites.json` (`interactions: 1`, all eight other entries `0`) and the per-test `test-results/interactions/interaction-single-asset-l-540b0-annot-reopen-or-steal-focus-chromium/error-context.md`. Logs for this run are `/tmp/aih-a3-tool-json-{red,focused,typecheck,parity,full,e2e}.log`. Bundle budgets and the root/nested-base demo artifact checks passed, but are not substituted for the failed aggregate. This failure remains open for the integrated Web/release qualification work.

## Explicitly Still Open

A3-CLI-11 remains PARTIAL: busy/capacity/upstream retry policy, strict-tools fallback, thinking/text ordering, streaming Unicode conformance, Claude/Bedrock error-image ordering, complete argument/schema/accessor/size admission across arbitrary providers/extensions, and every remaining cross-platform race are not accepted by this subset. Existing empty/no-argument and native-object conventions are retained, not generalized into new grants. No browser/HTTP contract, vendor certification, E2E or production deployment qualification is claimed. The implementation changes only Core decoding/retry classification; CLI process and installed tests qualify its existing adapters. Existing AUDIT-2/AUDIT-3 draft edits are preserved and excluded from the implementation commit.
