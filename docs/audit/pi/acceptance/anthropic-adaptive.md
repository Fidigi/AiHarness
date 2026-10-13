# Published Anthropic adaptive dialect — acceptance, 2026-10-13

**Qualified request slice, not audit completion.** CLI-MOD-07 remains PARTIAL; the [audit](../AUDIT-2.md) still has 88 DONE / 64 PARTIAL / 152 criteria.

Base: clean `cada89658aacd83dc05fca87a97176975af6e11c` (the preceding [numeric-budget delivery](./thinking-budgets.md)).

## Contract and boundaries

Core `providers/anthropic-thinking.ts` owns one per-call policy shared by Anthropic chat and streaming. The exact published `claude-sonnet-4-6` profile sends native adaptive thinking and `output_config.effort`: minimal → low; low/medium/high unchanged; max → max; unsupported xhigh clamps upward to max using the existing metadata. Explicit off sends disabled; an absent option stays absent. Temperature remains omitted while enabled.

This profile does not consume numeric budget overrides. Explicit `ChatOptions.maxTokens` stays exact. Without it, the previous per-requested-level output ceilings remain 2,048/2,048/5,120/9,216/17,408/33,792 for minimal/low/medium/high/xhigh/max. CLI/RPC already clamp xhigh to max before calling Core, so their ceiling is 33,792. Off/absent calls retain the constructor's 1,024 default. These are preserved AiHarness output defaults, not vendor maxima. Classic and unqualified/lookalike model IDs retain numeric behavior, including the previously accepted budget clamps. Invalid non-undefined thinking values fail before provider HTTP.

Selection follows the actual request model, not a cached constructor decision. No public API shape/version, metadata version, session schema, streaming event schema, credential or network policy changes.

This **does not add signed thinking-block preservation/replay across tool continuations**, other adaptive profiles, complete model defaults/capabilities, adaptive Gemini, Web budget-settings composition or vendor certification. Existing visible text/reasoning projection is not an opaque provider transcript. CLI-MOD-07 therefore cannot close. See the [owning contract](../../../ai/topics/providers.md#published-anthropic-adaptive-profile) and [EN](../../../users/en/user-guide.md) / [FR](../../../users/fr/user-guide.md) guides.

## Requirement-to-proof mapping

| Slice | Concrete evidence |
|---|---|
| Real request dialect and all seven levels | `core/src/providers/anthropic-thinking.test.ts`: loopback HTTP chat and stream payloads, native effort/disabled fields, no numeric budget field, explicit output cap, temperature, system/tools conservation and visible reasoning |
| Preserve defaults and reselect per call | Same leaf: all six enabled output defaults, absent option, configured-model changes, per-call overrides, classic/unqualified IDs and no stale effort/output fields |
| Negative admission | Same leaf: null, uppercase/unknown strings, number and object thinking values cause zero HTTP requests on both model paths; direct adaptive calls never consume numeric budget accessors |
| Advertised capability must work | Same leaf checks that the existing published native-max claim produces native max on the wire, rather than only making a menu option selectable |
| Emitted real built-in integration | `cli/src/cli/anthropic-thinking-process.test.ts`: twelve print/JSON/RPC × minimal/max/xhigh/off cases; actual provider construction, metadata, selection and HTTP body generation. A preload redirects only the approved Anthropic origin to loopback and refuses other destinations |
| Changes between calls | Same leaf: five RPC prompts with low → max → classic model/high clamp → adaptive model/high → off, using real set-thinking/set-model commands, catalogue fixture, frames and EOF cleanup |
| Original-source control | All 32 new cases on original image `sha256:eff3e7ed215bba2afaa42040a84dbfbf5fae2738aa8b0902c6ddf3081f8c2168`: **29 failed / 3 passed**, exit 1 / OOM false. The original owning provider source matches the base commit; only new tests were overlaid |

## Qualification

Four product/test owner hashes match `sha256:34ec4b799f58ebf91246afa94c4565dfe7dfa97efc322f621f4eb7d864fcaa5c`; the standard full-unit build exports that same image manifest.

| Gate | Result |
|---|---|
| `make typecheck` | Workspace and parity declarations pass |
| Strict new leaves, owning lint, focused suite | Docker NodeNext check, four-owner zero-warning ESLint, then **102 tests passed**: 32 new + 70 preceding budget/settings/provider-turn/length cases; exit 0 / OOM false |
| `make test` | **220 files / 2,253 tests passed** |
| `make test-parity` | **32 passed**, unchanged expectations |
| `make build-prod` | Pass; entry 148 KiB / eager 159 KiB gzip, 17 JS chunks |
| Emitted artifacts | Four JavaScript/declaration hashes from both product owners match test and production images |
| Documentation/matrix | 92 Markdown files / 628 local links; actual backtick-delimited matrix parses as 152 unique rows, 88 DONE / 64 PARTIAL; staged and unstaged whitespace checks pass |
| Production smoke | Network-disabled Node 26.11.1: emitted Core adaptive max/off and classic budgets, explicit cap, actual built-in CLI high/default ceiling, health/HTML/emitted-JS HTTP 200; exit 0 / OOM false |

Production image: `sha256:3e0e2d4fc0ee9579d356b0e36857fc3b2a5f2c65db06261ad6bad29549647753`.

Local evidence: `/tmp/aih-adaptive-{types,focused,units,parity,prod,base-control,production-smoke}.*`, `/tmp/aih-adaptive-{owner,image,base-owner,base-image}-hashes.txt` and `/tmp/aih-adaptive-{test,prod}-emitted-hashes.txt`. These are local protocol fixtures and artifacts, not live vendor or published CI evidence. This batch does not newly certify browser/physical-device/Pages behavior. Its green runs do not diagnose the native ESLint SIGSEGV/139 or other historical failures retained by prior deliveries.

Auxiliary bookkeeping: initial staging stopped on the ignored acceptance directory, before documentation lint; explicit force-staging kept the existing versioning policy. A host matrix helper first lacked `python3`, then a Node helper assumed unquoted status cells and matched zero. Reading the actual backtick-delimited table corrected that helper, not the requirements or statuses. Both production smoke invocations passed; the final fixture also supplies an explicit user message to each direct Core call.
