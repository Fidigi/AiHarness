# Numeric thinking budgets — acceptance, 2026-10-13

**Qualified scope, not audit completion.** CLI-MOD-07 remains PARTIAL. The [audit](../AUDIT-2.md) still has 88 DONE / 64 PARTIAL / 152 criteria; [completion review](./completion-review.md) remains authoritative about the open objective.

## Implemented contract

Base: clean `75f9bf3793d21ff90b5224417864efc1df6bc854`.

- Core publicly exports readonly `ThinkingBudgets` for `ChatOptions` and `StreamProviderTurnOptions`; the existing `AgentSettings` budget map remains mutable and structurally compatible. Its optional minimal/low/medium/high fields accept safe nonnegative integers. Inert own fields are copied before provider hooks; undefined/inherited fields do not override defaults, and malformed maps/accessors fail with a value-free error.
- Interactive, print, JSON and RPC composition now supplies the merged global/trusted-project snapshot at each provider turn. Hooks receive a separate map, not the mutable settings object. Interactive `/reload` updates it; RPC settings files still require restart.
- Anthropic numeric chat/stream uses overrides within 1,024–32,768, retaining temperature omission and the existing output-limit expansion to budget + 1,024. Its old invalid 512-token minimal default consequently becomes 1,024.
- Gemini/Vertex share the numeric body builder and conservative bounds: 128–32,768 for 2.5 Pro, 0–24,576 for 2.5 Flash, 0–8,192 otherwise. Enabled numeric requests revalidate budgets after hooks.
- Missing overrides preserve other defaults. Absent/off thinking is not enabled by this setting. Direct Core xhigh/max retains its legacy defaults; CLI capability clamping may instead select high. Effort-only APIs do not consume the numeric map.

See the [owning provider contract](../../../ai/topics/providers.md#numeric-reasoning-budgets) and [EN](../../../users/en/user-guide.md) / [FR](../../../users/fr/user-guide.md) guides. Those guides also remove the stale unsupported-`codemode` claim: the existing CLI/RPC settings wiring is already present and remains covered by the full suite.

## Requirement-to-proof mapping

| Requirement slice | Concrete proof |
|---|---|
| Reach provider payloads, not just parse settings | `core/src/providers/thinking-budgets.test.ts`: chat and stream capture actual loopback HTTP bodies for Anthropic, Google and Vertex; limits, defaults, missing/off levels, effort-only exclusion and output/temperature behavior |
| Reject malformed active budgets before provider HTTP | Same leaf: nine malformed maps, accessor refusal without invoking the getter, optional/inherited handling; zero requests on refusal |
| Preserve configuration ownership and next-turn changes | Same leaf: hook mutation affects only its copied options, and a following turn observes changed source values without changing the preceding captured map |
| CLI/RPC composition and trust | `cli/src/cli/thinking-budgets-process.test.ts`: six emitted print/JSON/RPC × trusted/refused cases; three additional emitted CLI → actual Core Anthropic adapter → HTTP payload cases |
| Live interactive refresh | Genuine Linux PTY: first turn, unchanged active snapshot after disk edits, `/reload`, changed next turn, clean `/quit` |
| Public declaration/runtime contract | Outside-checkout strict NodeNext consumer imports the public readonly type and all three option surfaces, preserves existing mutable settings, rejects readonly mutation and unsupported level/string values, then executes emitted Core with a frozen caller map and an isolated hook copy |
| Causal control | All 47 new cases against original image `sha256:2384a78339d61665ad8c17a91c620e5a9191015293257c524b2555a0f7f537ce`: **32 failed / 15 passed**, exit 1, OOM false. Six existing product-owner hashes match the base commit; only the new tests were overlaid |

The HTTP fixtures are local protocol captures, **not live vendor conformance**. Adaptive dialects, complete per-model capability maps/defaults, broader provider support and Web/server budget-settings composition are not implemented by this scope. Conservative reasoning budgets are not total-output or monetary spending caps. This delivery does not newly certify browser, physical-device or remote publication behavior.

## Exact-source qualification

Nine product/test owner hashes match final test image `sha256:eff3e7ed215bba2afaa42040a84dbfbf5fae2738aa8b0902c6ddf3081f8c2168`; the standard full-unit build exports that same image manifest.

| Gate | Result |
|---|---|
| `make typecheck` | Workspace and parity declarations pass |
| Strict two new test leaves | Docker NodeNext check in the final strict/lint/focused chain passes, exit 0 / OOM false |
| Owning ESLint | Direct Node invocation over all nine owners: zero errors/warnings; final chain exit 0 / OOM false |
| Focused tests | **70 passed**: 47 new + 7 settings + 6 provider-turn + 10 length-stop; final image, exit 0 / OOM false |
| `make test` | **218 files / 2,221 tests passed** |
| `make test-parity` | **32 passed**, unchanged expectations |
| `make build-prod` | Pass; entry 148 KiB / eager 159 KiB gzip, 17 JS chunks |
| Emitted artifacts | Fourteen JavaScript/declaration hashes from seven product owners match test and production images |
| Production smoke | Network-disabled Node 26.11.1: actual emitted Core chat and CLI streaming numeric payloads, refused-project exclusion, health/HTML/emitted-JS HTTP 200; exit 0 / OOM false |
| Documentation and whitespace | `make lint-docs`: 91 Markdown files / 619 local links; staged and unstaged whitespace checks pass |

Production image: `sha256:dc6dceda6222bd4c1a74535387c065566e08af5160c3dc021525bcac39f4481d`.

Final local evidence: `/tmp/aih-budgets-compatible-{types,units,parity,prod,focused,base-control,production-smoke}.*`, `/tmp/aih-budgets-compatible-{owner,image,test-emitted,prod-emitted}-hashes.txt`, `/tmp/aih-budgets-base-{owner,image}-hashes.txt`, `/tmp/aih-budgets-docs.*`. Earlier checkpoints remain under `/tmp/aih-budgets-accepted-*`, `/tmp/aih-budgets-final-*` and `/tmp/aih-budgets-lint-reproduction.*`. These are local artifacts, not published CI evidence.

## Retained failures and compatibility review

After an earlier successful strict/lint/70-test focused run, the pre-compatibility image `sha256:9fc23028a25d60132858928e071c9fda49de9d81a201d220c208433319a82130` chained strict/lint/focused command passed its strict check, then its `npx eslint` process exited **SIGSEGV/139**, OOM false, before Vitest started. Logs/state remain under `/tmp/aih-budgets-accepted-focused.*`. The subsequent isolated direct Node ESLint and focused Vitest commands passed unchanged sources. They **do not diagnose** the native crash or explain the previously recorded native/shell failures. No assertion, timeout, model payload expectation or engine flag was relaxed to obtain those passes.

Final review preserved the previously mutable `AgentSettings.thinkingBudgets` declaration rather than narrowing an existing API-1 contract. The strengthened public consumer verifies mutable settings plus readonly new provider-budget options. All final gates and the 47-case original-source control above were rerun after this correction.

Initial documentation lint correctly refused four links to the ignored, not-yet-staged receipt (`/tmp/aih-budgets-docs-prestage.log`). Force-staging that receipt made it versioned; subsequent documentation checks passed without changing lint policy.
