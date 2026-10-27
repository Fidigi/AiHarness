# MOD-01 — Delivery Tasks and Local Acceptance

> **Status: IN PROGRESS** (2026-10-27)

> **Authority:** [AUDIT-5](./AUDIT-5.md), MOD-01; [pinned provider/API/auth inventory](../../ai/topics/provider-matrix.md). Target Pi 1.2.0 commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, not the installed agent's moving release.

## Scope and acceptance

The requested outcome is usable provider/model integrations, including the approved API-key, OAuth and subscription methods, not a list of names. The reference inventory has 42 factory identities and 1,649 API/type entries; these are not 1,649 distinct usable models.

On 2026-10-26 the user authorized integration, validation and commits of existing MOD-01 changes, excluding unrelated changes. The user also confirmed that real accounts are unavailable: execute local acceptance without them. This removes live-account testing from this execution's gates; it does **not** waive missing authentication implementations or certify vendor access, entitlements, current availability, billing, regional TLS or service interoperability. Keep that limit in the final receipt.

Use disposable credentials and loopback/intercepted transports. OAuth controls must use an owned HTTPS issuer with a test CA, not disabled certificate verification. Catalogue reads and offline startup must not trigger credential commands, login, refresh or discovery. Record unknown costs as unknown, never free.

## Delivery order

Each task requires implementation, focused regression evidence, documentation and a bounded commit. Preserve old failed receipts; a new successful gate does not explain or erase them. Reuse existing Core/provider, emitted CLI, installed-package, HTTP and browser families rather than adding another test framework.

### 0. Secure the existing implementation

| Task | Work and acceptance | State |
|---|---|---|
| MOD-01.00a | Select the pending native adapters, shared metadata/API provenance, SDK/CLI/custom Server/Settings composition and their existing tests. Exclude unrelated audit changes. Capture an isolated source tree before validation. | Done; frozen selection integrated as `cec97e5`, with the source receipt in AUDIT-5 |
| MOD-01.00b | Run Docker typecheck, full root tests, independent public parity, browser suite and production build on that source. Diagnose concrete failures without loosening assertions, budgets or product safety controls. | Partial acceptance: original standard-gate failures retained. The linked-read oracle is corrected and 43 linked browser cases pass on the 2026-10-27 input below; native crashes and visual failures remain unresolved |
| MOD-01.00c | Commit the integrated implementation and documentation with actual gate outcomes and this remaining-work register. Do not mark the whole criterion DONE. | Delivered: `cec97e5` plus this audit/register delivery; criterion remains open |

### 1. Complete the executable catalogue and mapping

| Task | Work | Local acceptance |
|---|---|---|
| MOD-01.01a | Reconcile every pinned `(provider, model, API, type)` row with the actual native adapter, supported operations, metadata and host admission. Start from the existing 42-row inventory and adapter declarations. | Delivered local reconciliation (2026-10-27), with exhaustive typed identities/hashes, separate API/media/host projections and focused regressions; receipt below. This does not close native wire/profile qualification or the failing shared typecheck/parity gates. |
| MOD-01.01b | Complete the remaining original built-in model policies: OpenAI, Anthropic, Google, Azure, Vertex and Bedrock. | **IN PROGRESS:** Anthropic metadata/accounting, ceilings and six non-managed adaptive dialects delivered; five managed-effort and six numeric profile policies have bounded local checks below. Google/Vertex add 35 scoped metadata/usage/thinking/output and response-policy controls. Required root/parity gates remain failed; remaining policies for all six originals stay open. Per-model request/response fixtures for physical APIs, caps, reasoning, tools, usage and defaults; API identity must not depend on an operator alias. |
| MOD-01.01c | Implement native Radius/Pi Messages and Codex Responses paths. | Bounded native framing, terminal/error authority, tools, cancellation and once-only observed accounting; genuine public package controls. |
| MOD-01.01d | Implement GitHub Copilot's per-model A/C/R dispatch and gateway dispatch for Cloudflare AI Gateway and Vercel AI Gateway. | Exact operation-owned paths/headers and mixed-API overlap fixtures; no generic compatible-endpoint claim. |
| MOD-01.01e | Implement the three Qwen token-plan variants, three Xiaomi regional token plans and Z.ai coding CN. | Explicit region/plan construction, pinned profiles and safe overrides; no region inferred from provider/model aliases. |

### 2. Complete connection methods

| Task | Work | Local acceptance |
|---|---|---|
| MOD-01.02a | Anthropic bearer/subscription OAuth and workload federation. | Owned issuer/token/federation fixtures; expiry, cancellation, refresh/CAS/logout and native auth/header/replay policy. |
| MOD-01.02b | OpenAI ChatGPT/Codex and GitHub Copilot subscription exchange. | Owned authorization, exchange and refresh flows; model/account filtering, encrypted persistence and exact native transport admission. |
| MOD-01.02c | OpenRouter and Radius OAuth. | Callback/state/PKCE, token replacement and account-catalogue fixtures; secrets remain server-side and reads remain passive. |
| MOD-01.02d | Complete Kimi Coding host composition, Meta Muse and xAI/Grok subscription flows. | Kimi's explicit helper/login/Bearer subset is retained, not counted as automatic refresh/host completion; test each issuer separately. |
| MOD-01.02e | Vertex API-key/ADC and the wider AWS profile, ECS and web-identity credential chain/region policy. | Owned metadata/token endpoints and disposable profile files, precedence, refusal, redaction and cancellation; preserve existing explicit Bedrock Bearer/SigV4. |

### 3. Make the adapters usable across native hosts

| Task | Work | Local acceptance |
|---|---|---|
| MOD-01.03a | Add native CLI credential/settings composition for Mistral and existing supplied-key SDK adapters that currently require trusted extension registration. | Environment/command/encrypted precedence, startup defaults/scopes, offline listing and actual print/JSON/RPC prompts without an extension. Preserve bare `mistral` registrations. |
| MOD-01.03b | Add Server/Settings composition for SDK-only Ant Ling, Baseten, Fireworks, Hugging Face, Kimi Coding, Meta, MiniMax global/CN, OpenCode Go/Zen, Together, xAI and Xiaomi; expose intended built-in slots separately from custom dialects. | Authenticated CRUD/import/Test/key rotation/restart and actual Settings-to-loopback requests. Non-discovery adapters must refuse Connection Test honestly. |
| MOD-01.03c | Complete specialized classifier/image host composition, including TypeSafe and mixed gateways. | Native scalar versus finite-distribution contracts, declared/effective vision, guest failures and once-only usage retained through public packages and host tools. |

### 4. Finish effective profiles

| Task | Work | Local acceptance |
|---|---|---|
| MOD-01.04a | Complete per-model defaults, context/output reserves, sampling/tool strictness and capability descriptors. | Omitted and explicit values compared separately to pinned policy; metadata does not manufacture effective defaults. |
| MOD-01.04b | Complete supported media preparation and private/signed/encrypted reasoning continuation. Coordinate the reasoning portion with MOD-03. | Actual bounded media inputs, same-provider replay, foreign-model switches and multi-turn controls; reject unsupported paths before I/O. |

### 5. Define freshness and offline behaviour

| Task | Work | Local acceptance |
|---|---|---|
| MOD-01.05a | Specify static/discovered/operator catalogue precedence, freshness and invalidation for all admitted integrations, including account-filtered rows. | Current/expired/missing/malformed catalogue scenarios and exact source ownership; no silent reference-version update. |
| MOD-01.05b | Complete offline startup/reload/selection and failure behaviour across CLI/RPC/Server/Settings. | Zero unintended discovery/command/refresh requests, retained usable static metadata, honest unknown availability and rejected stale authority. |

### 6. Qualify the completed local scope

| Task | Work | Local acceptance |
|---|---|---|
| MOD-01.06a | Bind implemented rows to Core wire, installed public declarations/runtime, emitted CLI/RPC and authenticated HTTP evidence. | Success, malformed/failed response, cancellation and accounting coverage for every selected operation; no coverage credited to filtered cases. |
| MOD-01.06b | Exercise Settings/configuration and real native conversation paths with loopback upstreams. | Browser-to-Server controls, save/reload, keyboard and pointer paths; no force-click or offline/PWA spoof to conceal an obstruction. |
| MOD-01.06c | Freeze final inputs and run the standard Docker gates; reconcile requirements, results and commits in AUDIT-5. | All required local gates actually executed; keep real-account/service acceptance explicitly unperformed. QUA-01 remains independent. |

## Current limitations retained

The supplied-key SDK increments and custom-host controls already in the tree are reusable delivery, not completion of tasks 1–6. The original E77/E78 evidence availability problem is historical and separate: do not reconstruct or seal their missing receipts from current source or later tests. A fresh receipt qualifies only its own captured inputs.

## MOD-01.00b — Linked-read oracle follow-up (2026-10-27)

The existing [linked-modal regression](../../../e2e/linked-modal-boundary.spec.ts) incorrectly expected the raw server error `refused-linked-read` in a notification. `WorkspacePanel.tsx` deliberately uses the fixed `readFailed` copy from `file-preview-messages.ts`. The test now requires that public message and explicitly rejects the raw server text, preserving newer-composer focus, draft and absence-of-dialogue assertions. No product behavior, baseline, budget or deadline changes.

The first isolated `make test-e2e E2E_ARGS='--config=e2e/linked-modal-boundary.config.ts'` fails before tests: Core's compiler reports `code=null, signal=SIGTRAP`, with V8's `predecessors.size()` assertion and no TypeScript diagnostic. Its patch and make exit 2 remain retained. A newer combined source tree `099cb57f3634f85f98089a78ee7dabefee52b0ef` on `af3e718` includes the census's finite-question revision plus this unchanged oracle correction: the same canonical browser target passes **43/43**, one worker/zero retries. All 1,431 declared source hashes/modes match its image; that manifest is not a claim to hash every Docker-context input. Raw logs, image identity and browser artifacts are local at `test-results/mod01-tasks-20261027/00b/`.

This closes only the linked-read oracle defect. Native crashes, original visual failures and the broader 00b acceptance remain open; later compilation/browser success is not a causal diagnosis or a replacement for the failed first attempt.

## MOD-01.01a — Typed reconciliation receipt (2026-10-27)

The derived [reference fixture](../../../tests/fixtures/provider-reference.json) retains all 42 factories and 1,649 `(provider, model, API, type)` identities: 1,554 chat, 34 classifier and 61 image. Generated catalogue bytes come from the pinned `@earendil-works/pi-ai@1.2.0` package, not generated files in the source checkout. The separate factory hashes match the checkout at the target commit above. [Capture and validation](../../../tests/functional-parity/provider-reference.mjs) verify every catalogue digest against the original schema-6 manifest, preserve its exact bytes and pin the factory/typed-row aggregate hashes. Manifest SHA-256 is `a4c0a81f2cc4323b81d4c5d3886b343dc226939168f33e8eb731c928a81cfce9`; derived rows SHA-256 is `458975f575e8c576c083fff689ce4b8dd3ade1af25745a1f2be14908359a6738`.

The [census](../../../tests/functional-parity/provider-coverage.mjs) constructs the actual operation-specific public Core adapters, original Factory instances and automatic CLI compositions. Separately, it exercises actual builtin/custom-registry chat-record admission and custom-dialect construction with disposable encrypted storage and an inert structural proxy; it does not exercise HTTP or Settings. Each typed row records native metadata, API projection, operation descriptors and separate Factory/CLI/builtin-record/custom-host results. Builtin record admission does not prove a configured Server connection. Native scalar questions/image requests on specialized SDKs are separate from finite/guest contracts and are not credited to mixed custom hosts that do not expose them. Missing native ownership is never inferred from another provider's same model ID. CN custom routes are explicitly operator-URL-only, not automatic regional composition.

The classifications below are **declarations, not implemented/usable-model certificates**. `Native declaration` means an API-matching adapter/profile declaration without an observed image-descriptor mismatch. `Partial` means transport-only/incomplete profile or declared-but-not-effective classifier vision. `Missing` means no owned native adapter/API projection. Effective defaults, media/continuation and operation-by-operation wire/public/HTTP/browser acceptance remain tasks 01b–06c. Absent pricing remains `null`, including nineteen NVIDIA rows. Preserved zero-only declarations are not a free-service certificate.

| Pinned provider | Entries | Native declaration | Partial | Missing |
|---|---:|---:|---:|---:|
| amazon-bedrock | 193 | 0 | 193 | 0 |
| ant-ling | 3 | 3 | 0 | 0 |
| anthropic | 17 | 0 | 17 | 0 |
| azure | 45 | 0 | 45 | 0 |
| baseten | 22 | 22 | 0 | 0 |
| cerebras | 2 | 2 | 0 | 0 |
| cloudflare-ai-gateway | 57 | 0 | 0 | 57 |
| cloudflare-workers-ai | 21 | 21 | 0 | 0 |
| deepseek | 2 | 2 | 0 | 0 |
| fireworks | 22 | 22 | 0 | 0 |
| github-copilot | 35 | 0 | 0 | 35 |
| google-vertex | 13 | 0 | 13 | 0 |
| google | 22 | 0 | 22 | 0 |
| groq | 7 | 7 | 0 | 0 |
| huggingface | 78 | 78 | 0 | 0 |
| kimi-coding | 4 | 4 | 0 | 0 |
| meta | 6 | 6 | 0 | 0 |
| minimax-cn | 3 | 3 | 0 | 0 |
| minimax | 3 | 3 | 0 | 0 |
| mistral | 40 | 40 | 0 | 0 |
| moonshotai-cn | 4 | 4 | 0 | 0 |
| moonshotai | 4 | 4 | 0 | 0 |
| nvidia | 21 | 21 | 0 | 0 |
| openai-codex | 9 | 0 | 0 | 9 |
| openai | 45 | 45 | 0 | 0 |
| opencode-go | 31 | 31 | 0 | 0 |
| opencode | 85 | 85 | 0 | 0 |
| openrouter | 475 | 469 | 6 | 0 |
| qwen-token-plan-cn | 20 | 0 | 0 | 20 |
| qwen-token-plan-individual | 9 | 0 | 0 | 9 |
| qwen-token-plan | 20 | 0 | 0 | 20 |
| radius | 29 | 0 | 0 | 29 |
| together | 17 | 17 | 0 | 0 |
| typesafe | 1 | 1 | 0 | 0 |
| vercel-ai-gateway | 251 | 0 | 0 | 251 |
| xai | 4 | 4 | 0 | 0 |
| xiaomi-token-plan-ams | 4 | 0 | 0 | 4 |
| xiaomi-token-plan-cn | 4 | 0 | 0 | 4 |
| xiaomi-token-plan-sgp | 4 | 0 | 0 | 4 |
| xiaomi | 6 | 6 | 0 | 0 |
| zai-coding-cn | 4 | 0 | 0 | 4 |
| zai | 7 | 7 | 0 | 0 |
| **Total** | **1,649** | **907** | **296** | **446** |

[Focused regressions](../../../tests/functional-parity/provider-coverage.test.mjs) retain overlapping OpenAI R/D and OpenRouter C/I IDs, the six effective vision refusals among OpenRouter classifiers, native scalar versus finite operations, absent Qwen ownership, Mistral's missing automatic CLI slot, Cerebras's existing automatic CLI/custom dialect but absent builtin Server record slot, and specialized SDK operations absent from mixed hosts. They also reject altered rows/provenance and assert zero fetches and no disposable-key disclosure. Root Vitest now discovers these `.test.mjs` cross-package probes; `make test-parity` includes them without another framework.

Validation snapshots remain separate:

- Initial tree `c53112626c9e34219b59edea8d247580bd4d1d15` on `af3e718`: canonical Docker `make test-parity` passes 362/362 across four files; `make typecheck` passes.
- Finite-question tree `36e004ab68b18fd61a39808e851ac1706f982117`: parity again passes 362/362, but the new typecheck attempt **fails**, make exit 2: Server's no-emit compiler terminates with `code=null, signal=SIGSEGV`. No successful final typecheck is substituted for it.
- Operation-specific SDK tree `b7ebb612f1398e5054a832db98c381ce3d4cf08d`: the three census cases pass, but the unfiltered parity gate **fails**, 360 pass/two fail/362, make exit 2. Installed strict consumers `dispatch-public.ts` and `minimax-public.ts` each terminate with `code=null, signal=SIGSEGV`. No retry or waiver of those failures.
- Delivery tree `460b91e69d9e7fa0831cc40d68c5889ee3f4247d` on `bddfe50` additionally records builtin chat-record admission. A retained temporary Makefile driver invokes the unchanged canonical `build-test` target, then the existing Vitest selector in that freshly built image with network disabled: **3/3 census cases pass**, no filtered case credited. The final offline export has 1,649 rows, 28 native scalar-question and 61 native-image operation declarations, and the totals above. All 1,431 declared source hashes/modes match its image. This final focused result is not a replacement for failed typecheck/full parity or a full-context identity certificate.

Local patches, source trees, raw successful/failed logs, Makefile driver, image identities and JSON exports are retained under `test-results/mod01-tasks-20261027/`. Full root, all nine browser suites and production build are not rerun for this census-only delivery; the 43 linked cases above qualify their own earlier captured input, not the later report refinements. Neither these results nor the earlier successes diagnose or erase native crashes, visual failures or absent E77/E78 originals. No real-provider or whole-platform acceptance is claimed.

### MOD-01.01b — first Anthropic metadata/accounting sub-lot (2026-10-27; IN PROGRESS)

The original direct `AnthropicProvider` now owns seventeen pinned static declarations in [anthropic-profiles.ts](../../../packages/core/src/providers/anthropic-profiles.ts): names, physical A API, published context/output limits and base input/output/cache prices. Legacy declarations remain; derived compatible transports do not inherit the new ownership or pricing. Static reads perform no authentication, command, refresh or discovery. The independent [catalogue fixture](../../../tests/fixtures/anthropic-reference.json) is captured from the pinned generated package data, not claimed as a file in the reference Git checkout; its bytes are checked against the approved full catalogue digest in `provider-reference.json`.

Captured-request JSON/SSE accounting now uses those seventeen physical model prices rather than the response model or operator alias. Haiku 5.5 selects its strictly-above-100,000 tier using uncached input plus cache reads/writes, never output tokens. Observed one-hour writes cost twice the selected input rate; a requested long TTL does not imply observed one-hour writes. Nullable SSE deltas preserve earlier counters and explicit zero remains authoritative. Incomplete/malformed required observations do not manufacture complete usage or cost. Known native responses carry `anthropic-messages` independently of the operator label; unknown-model cost remains unknown.

[Focused regressions](../../../packages/core/src/providers/anthropic-profiles.test.ts) cover every pinned profile in JSON/SSE with short/long retention, independent fixture provenance, the tier boundary, nullable/zero/absent one-hour observations, malformed counters, defensive metadata, unknown models and derived-transport isolation. Review additionally withholds unmigrated reasoning controls (`thinkingLevelMap: null`) on the sixteen newly declared profiles. Existing Sonnet 4.6 controls/cache eligibility remain; no additional profile gains paid warming. Published limits are declarations, not completion of wire-cap/default policies. No default model/output, request dialect, tool/media/replay policy, compiler setting or global budget is migrated or relaxed here.

This is an accounting/metadata foundation only: Anthropic request/default/reasoning/tool/terminal policies and complete original OpenAI, Google, Azure, Vertex and Bedrock model policies remain open. No real account, entitlement, regional availability, provider invoice or full-profile interoperability is certified. MOD-01.01b and MOD-01 remain **IN PROGRESS**.

Validation inputs/results are retained separately on base `2f06d84`:

- Red fixture tree `64dc78aa36b6df29f679e4c795d4d43cc3593b7b`: canonical `build-test` plus the retained Makefile selector, network disabled, gives 70 pass/21 fail across six files; the twenty-one new failures expose missing metadata/accounting behavior.
- Initial implementation tree `3b3fa6c6dd1dc919112815b51e0c8acc04526ca2`: the same Docker selector passes **91/91** across six files. This precedes the reasoning-control guard and final fixture refinements.
- Pre-guard general tree `bcdb4859a21a576d040a8298813ec27f12edc35b`: canonical Docker `make typecheck` passes; unfiltered `make test` **fails**, 7,426 pass/one fail/7,427 across 523 files, make exit 2. The installed strict `dispatch-public.ts` compiler terminates with `code=null, signal=SIGSEGV` and no TypeScript diagnostic.
- Guarded delivery tree `4095656f927f19525112900c801ef265e374eeae`: canonical Docker `make typecheck` passes; unfiltered `make test` again **fails**, 7,426 pass/one fail/7,427 across 523 files, make exit 2. This time the installed strict `cerebras-public.ts` compiler terminates with `code=null, signal=SIGSEGV`. The twenty-two new profile tests, sixty-nine adjacent Anthropic/derived-transport cases and three census cases all pass within this failed full run. This real source revision withholds unqualified reasoning controls; it is not a compiler remediation. No unchanged individual compiler retry, union of successful cases or green full-suite claim is substituted for either failure.

The retained final image `ai-harness:mod01-anthropic-qualified-20261027` runs Node `v24.15.0`. Its 1,434 declared source hashes/modes match both the frozen source manifest and the delivered working sources; this is not an every-context-entry or compiled-output identity certificate. The first proof attempt cannot read a bind-mounted manifest (`EISDIR`) and checks no source files; its failure is retained. A separate copy-based driver corrects that input transport and verifies every declared file. The final network-disabled census export has **924 native declarations / 279 transport-only or partial profiles / 446 missing**, still 1,649 tuples. The seventeen new metadata matches do not certify seventeen usable/fully qualified integrations.

Raw logs, immutable trees/patches, drivers, hashes and exports are retained under `test-results/mod01-original-anthropic-20261027/`. Standalone parity, production and browser suites are not rerun for this Core-only sub-lot. Earlier native/visual failures and absent E77/E78 originals remain unresolved; neither later passes nor these accounting fixtures diagnose or erase them.

### MOD-01.01b — Anthropic output-ceiling sub-lot (2026-10-27; IN PROGRESS)

Direct `AnthropicProvider` JSON/SSE and its captured first-party output preflight now enforce the seventeen pinned published maxima through `anthropic-profiles.ts` and `anthropic-thinking.ts`. Both explicit caller limits and effective prepared limits must be safe positive integers within the selected profile's 64,000/128,000-token ceiling. Invalid explicit limits fail before HTTP with a fixed SDK diagnostic (the existing typed native-output diagnostic at preflight); they are not silently truncated. Public metadata mutations and operator labels cannot raise the private physical ceiling. Captured configured-model authority remains pinned across later changes, while explicit per-call models select their own ceiling.

The existing `anthropic-profiles.test.ts` fixture gains twenty cases: seventeen model-specific JSON/SSE/preflight boundaries plus model capture/override, numeric-allocation safety and derived/unknown-model isolation. With thinking omitted/off, omitted limits retain 1,024 tokens; existing thinking defaults/allocation remain, including numeric thinking raising a valid small explicit limit. This is a profile-ceiling guard, **not** exact explicit-cap semantics under numeric thinking, pinned default/reserve equivalence, adaptive/managed thinking migration or full profile qualification. Derived transports and unknown IDs do not borrow a ceiling from a matching name. No new reasoning controls, paid warming, credential activity, sampling/tool/media/replay policy, global budget or compiler option is introduced.

Validation on base `4a313ca` remains source-bound:

- Red tree `a0f9be1d8eb34246db348b8897056006697b08f4`: retained Makefile driver invokes canonical `build-test` and the seven-file Vitest selector with network disabled; **131 pass/19 fail/150**. Nineteen new failures expose absent ceilings; the derived/unknown compatibility case already passes.
- Delivery tree `f435ba636dd448ac0f4f920dac97a56641e8aeac`: the same selector passes **150/150** across seven files; canonical Docker `make typecheck` passes. Unfiltered `make test` **fails**, **7,446 pass/one fail/7,447** across 523 files, make exit 2. All 150 owning/adjacent cases and 327 genuinely installed public-consumer cases pass in this full run, not as a union across snapshots.
- The full-run failure is `packages/cli/src/cli/provider-auth-command.test.ts`, `bounds the real token-stall body with a deadline and cleans up`: expected exit 124 / `Auth deadline exceeded.`, received exit 1 / `Auth operation failed.`, signal null. The owned HTTPS issuer records `requests: []` and a transport `ECONNRESET`, before the intended token-stall request. This does not demonstrate the intended stalled-body deadline path. The cause remains undiagnosed; neither the auth implementation, oracle, TLS/CA policy nor time budgets are changed, and the failing case is not rerun unchanged or waived.

The retained `ai-harness:mod01-anthropic-caps-qualified-20261027` image uses Node `v24.15.0`; all 1,434 declared source hashes/modes match the frozen inputs and delivered sources. This remains a declared-input check, not an every-context-entry/compiled-output identity certificate. Raw red/final logs, immutable trees/patches, drivers and manifests are retained under `test-results/mod01-anthropic-caps-20261027/`. Standalone parity, production and browser suites are not rerun for this Core-only increment. No real-provider/service qualification or causal repair of earlier compiler/visual failures is claimed. MOD-01.01b remains **IN PROGRESS**: the remaining original-provider defaults/reasoning/tools/wire policies and the other MOD-01 tasks are still open.

### MOD-01.01b — Anthropic non-managed adaptive reasoning sub-lot (2026-10-27; IN PROGRESS)

Direct `AnthropicProvider` now owns the six pinned non-managed adaptive maps: `claude-fable-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6` and `claude-sonnet-5`. `anthropic-profiles.ts` keeps the private maps separate from defensively copied metadata; `anthropic-thinking.ts` applies them to both JSON/SSE and captured native-output preflight, independently of the operator label or response alias. Native adaptive requests use `thinking.type: adaptive`, summarized display and mapped `output_config.effort`, without inspecting numeric budget maps. Unsupported `xhigh` clamps upward to `max` for Opus/Sonnet 4.6; the other four have native `xhigh`. Fable's explicit `off` clamps upward to `minimal`/wire `low`, never a false disabled claim. Other explicit off requests disable thinking. Enabled adaptive thinking omits temperature; Opus 4.7/4.8 omit it even when thinking is off or absent.

This is a bounded request-dialect migration, not complete Pi simple-options behavior. Omitted thinking still omits the preference; omitted output limits and existing per-level output allocation remain unchanged. Explicit valid adaptive caps remain exact, including 64 tokens, and the prior physical ceiling guards still apply. Captured configured models remain pinned while explicit per-call models select their own policy. Unknown IDs and derived compatible transports retain their previous paths, including the derived Sonnet 4.6-only adaptive policy without the new native display field. No new paid warming, authentication, tool/media/terminal policy or signed reasoning replay is introduced.

At this sub-lot's delivery, the six numeric profiles and five managed-effort profiles still publish `thinkingLevelMap: null`; their existing direct SDK paths are not certified by that increment. Managed effort requires active/historical control messages and prefix-binding policy, not merely another adaptive flag. Defaults/context reserves, numeric allocation/cap semantics, managed effort, broader continuation and all other original-provider policies remain open.

The existing `anthropic-profiles.test.ts` fixture gains 49 cases: six profiles × seven levels on JSON/SSE/preflight, six omitted/default/invalid-level cases and one model-capture/metadata-mutation/derived-or-unknown isolation case. The approved full catalogue hash still binds the fixture. Existing Sonnet 4.6 wire assertions additionally require summarized display; their output, tool, cache, omission and model-switch assertions remain. The eleven unmigrated profiles retain closed-control assertions.

Validation on base `e7d6bc2` remains source-bound:

- Red tree `4396ddb76473ef9a5f3adb7f819abc8cee9945fc`: retained Makefile driver invokes canonical `build-test` and the seven-file Vitest selector with network disabled; **147 pass/52 fail/199**. The raw failed make log is retained. The driver inherited shell `errexit` and did not save its numeric make exit; this recording limitation is explicit, not repaired by rerunning the tests.
- Initial policy tree `574f3ba53a9e2429350867f416d4824415c47864`: the same selector passes **199/199** across seven files; canonical Docker `make typecheck` passes. Unfiltered `make test` **fails**, **7,486 pass/10 fail/7,496** across 523 files, make exit 2. All ten failures are the existing emitted CLI's exact adaptive payload assertions, which still omit the newly required `display: summarized`; Core and the installed public-consumer suite pass. This failed first general receipt remains retained.
- Delivery tree `d93a3ad2a4b390825f6b1039b2c142063d54990e` additionally updates those CLI assertions and extends their existing fixture to 34 cases, including all six profiles in print/JSON/RPC and Fable's off-to-minimal clamp. CLI's existing level clamp occurs before output allocation, so Sonnet 4.6 `xhigh` selects the `max` default and Fable `off` selects the `minimal` default; the direct SDK still preserves its requested-level allocation. No CLI product code, transport, deadline or safety assertion is relaxed. The eight-file network-disabled selector passes **233/233** on this new source; canonical Docker `make typecheck` passes. No filtered cases or cross-tree union is credited.
- On that same delivery tree, independent `make test-parity` **fails**, **361 pass/one fail/362** across four files, make exit 2: `publishes strict installed journal accounting and additive summary provenance declarations` times out at its unchanged 5,000 ms case deadline (`installed-executable.test.ts:986`; the case writes and compiles `session-accounting-public.ts`, without a captured per-step completion trace). The log also retains a native child termination (`code=null, signal=SIGSEGV`) under the following `accepts installed verbose startup without changing headless print output` test context; the captured output does not establish that child's identity or a causal relation to the timeout. No timeout, compiler option, assertion or helper is changed, and the failed parity gate is not rerun to obtain green.
- Delivery-tree unfiltered `make test` also **fails**, **7,516 pass/one fail/7,517** across 523 files, make exit 2. All 233 owning/adjacent Core/CLI cases, the three census cases and 327 installed public-consumer cases pass within this same failed root run, not as a union with parity. The failure is `packages/cli/src/cli/tool-json-process.test.ts`, `print/responses/invalid rejects malformed arguments without executing the valid first tool`: its probe has `result.error` undefined but `result.status` null instead of zero. The log does not capture the signal; the following signal and JSON/safety assertions are not reached. No cause or native signal is invented, no successful sibling is substituted for it, and the unchanged probe is not rerun or modified.

The retained delivery image `ai-harness:mod01-anthropic-reasoning-delivery-20261027` uses Node `v24.15.0`; all 1,434 declared source hashes/modes match its frozen inputs and the delivered sources. This is not an every-context-entry or compiled-output identity certificate. Red, initial-policy and delivery trees/patches, raw logs including every failed attempt, drivers, image identities and manifests are retained at `test-results/mod01-anthropic-reasoning-20261027/`. Production and browser suites are not rerun for this bounded Core request-policy/CLI-fixture increment. The new passing controls do not diagnose or waive prior native compiler failures, the OAuth token-stall `ECONNRESET`, visual failures or missing E77/E78 originals. No account, entitlement, current availability, regional TLS, billing or real-service interoperability is qualified. MOD-01.01b and MOD-01 remain **IN PROGRESS**.

### MOD-01.01b — Anthropic managed effort and numeric allocation (2026-10-27; IN PROGRESS)

The current direct-owner implementation adds the five pinned managed profiles (`claude-fable-5-1`, `claude-haiku-5-5`, `claude-opus-5`, `claude-opus-5-5`, `claude-sonnet-5-5`). JSON/SSE and native preflight share private maps. Managed requests always use adaptive summarized thinking with `block_binding.prefix_mismatch_behavior: drop_block`, fixed top-level effort `high`, no temperature, and a trailing active-effort system control. Omitted preference selects high; explicit unsupported levels clamp upward through the pinned map. Both required mid-conversation/binding beta headers are merged with configured features. Historical assistant controls accept only a validated physical effort from the same provider and `anthropic-messages`; a logical selection, foreign provider/API or malformed value grants no replay authority. Controls never split a tool-use/result pair.

Physical effort is the additive optional `ChatResponse.providerThinkingLevel`, not the pre-existing logical `thinkingLevel`. Both assistant persistence paths in `packages/core/src/agent/tool-loop.ts` retain it in message metadata, and live/persisted CLI JSON retain validated values. Existing virtual selection semantics and API 1/session schema 2 remain unchanged. The initial candidate reused the logical field; review identified that ambiguity and a separate source/test revision now distinguishes the two. Old candidate results do not qualify this revision.

The six 4.5 alias/date profiles now have owned numeric maps. Native defaults are minimal 1,024 / low 2,048 / medium 8,192 / high 16,384 tokens; unsupported xhigh/max clamp to high. Omitted output uses the published 64,000-token ceiling. An explicit answer limit can grow by the requested reasoning budget, capped privately at 64,000. The pinned helper reserves 1,024 answer tokens only when reasoning reaches the total ceiling; otherwise a valid requested thinking budget remains exact, even with a small explicit answer limit. This is not exact explicit-total-cap semantics. Safe custom budgets, including very large values, cannot overflow addition or exceed the physical ceiling. Zero retains the reference's effective 1,024 fallback. Effective thinking below the native 1,024 minimum or consuming the whole output ceiling is refused before HTTP; valid minimal allocations with one or 64 answer tokens are not rejected. Enabled numeric thinking uses summarized display/interleaved beta and omits temperature; off disables it. Unused maps stay opaque; consumed maps are copied without invoking getters.

All seventeen owned maps are now published defensively, without new paid warming or inherited authority for compatible subclasses/unknown IDs. The six non-managed adaptive policies remain unchanged; omitted output on the eleven adaptive/managed profiles has not been migrated to the pinned 128,000-token default. Context reserves, complete default equivalence, tool/media/terminal policies, signed/opaque continuation and the other five original provider families remain open; this is not full Anthropic or MOD-01.01b qualification.

Validation inputs remain separate; this bounded delivery does not close the failed gates or qualify complete profiles:

- Initial managed red: **45 fail / 241 pass / 286**. Initial implementation tree `0bd8918d6d07c0bb8bbbdabc95c99cb1c1b852ae`: the nine-file offline Docker selector passes **302/302**, canonical typecheck passes, and standalone parity passes **362/362**. Root **fails**, **7,577 pass / one fail / 7,578**, 523 files, make exit 2: the installed strict `cloudflare-chat-public.ts` compiler has `code=null, signal=SIGSEGV`. Its cause is not established. These results precede the physical-effort authority revision and added managed installed-runtime assertions.
- Replay-authority revision: red **57 fail / 257 pass / 314**; the ten-file offline selector passes **314/314** and canonical typecheck passes on its separate green snapshot. No standalone parity/root success is inferred for this revision.
- Numeric red: **61 fail / 295 pass / 356**. Combined authority/numeric snapshot `4971f26`: offline selector **386/386**, canonical typecheck pass. Standalone parity **fails**, **360 pass / two fail / 362**, make exit 2: installed `prestart-public.ts` compiler `code=null, signal=SIGSEGV`, plus the new installed managed fixture's wrong base path. Root **fails**, **7,649 pass / one fail / 7,650**, 523 files, make exit 2, on that same fixture. The fixture supplies `/managed/v1` although the existing adapter appends `/v1/messages`; its unmatched request reaches the keyless-discovery branch. No managed-runtime assertion beyond that boundary is credited.
- Source tree `2e67a6c4de77104c16f8fba31c48c63b8a9036c7` corrects only that fixture base to `/managed` and additionally requires all ten exact managed paths. Its offline selector passes **386/386**. An initial one-case installed selector still **fails**, with 326 excluded cases: the managed runtime assertions complete, then strict compilation reports `TS6053` because `consumer.ts` is created by an excluded earlier case. This is a retained selector/preparation failure, not a successful installed case. A separate corrected selector includes that existing prerequisite without removing assertions: **two pass / 325 excluded**, and canonical typecheck passes on the same source tree. On this same tree, standalone parity **fails**, **360 pass / two fail / 362**, make exit 2: strict installed `openrouter-images-public.ts` and `cloudflare-mixed-public.ts` compilers each have `code=null, signal=SIGSEGV`, without a causal diagnosis. Root passes **7,650/7,650**, 523 files; all 1,434 declared source hashes/modes match its image on Node `v24.15.0` (not every context entry or compiled output). This root success does not replace the failed parity gate or qualify the later numeric correction.

Review of pinned `simple-options.ts` then exposes a genuine allocation defect in the candidate: it reserved 1,024 answer tokens unconditionally. The candidate's green tests had codified that wrong oracle. Six independent positive minimal-allocation cases and corrected existing vectors now require the reference's conditional reserve; invalid sub-minimum custom/zero-consuming allocations still refuse. Separate red tree `d9aaa6179865aadd23059e8662c39792e66e5601` exposes **12 fail / 380 pass / 392**. The first corrected tree `066cdf4a2479d4a3fabddc7a89ad564a4cd19095` gives **391 pass / one fail / 392**: the existing model-capture case still expects the old 15,424 budget instead of the pinned 16,384 under an unchanged 16,448 total. General gates do not start after that failure. The one stale oracle is corrected separately in tree `2eb361085a31898ec3a61047c92864139f67fa30`; it is the bounded delivery source below. Earlier green selectors/root are not credited to this correction.

On that final tree, the ten-file offline Docker selector passes **392/392**, canonical typecheck passes, and root passes **7,656/7,656**, 523 files. Standalone parity **fails**, **361 pass / one fail / 362**, make exit 2: installed `minimax-public.ts` strict compiler has `code=null, signal=SIGSEGV`; its cause is not established. The installed managed consumer case passes in this run, but neither it nor the passing root replaces the failed standalone parity gate. All **1,434** declared source hashes/modes match the retained final image on Node `v24.15.0`; this does not certify every Docker context entry or compiled output.

Raw failed/success logs, immutable source trees/patches, drivers, source/image checks and checksummed artifacts are retained in `test-results/mod01-anthropic-managed-numeric-20261027/`; original captures remain under `/tmp/aih-mod01-originals-20261027/`. Documentation lint checks 114 Markdown files/1,166 local links. No unchanged retry, cross-tree success union, compiler remediation, browser/production or real-service acceptance is claimed.

### MOD-01.01b — Original Google/Vertex scoped policies (2026-10-27; IN PROGRESS)

`google-profiles.ts` owns the 22 Google and 13 Vertex pinned declarations separately, including same-ID tariff/budget differences. Only direct `GeminiProvider`/`VertexGeminiProvider` instances and exact catalogue IDs receive these policies; mutable public metadata, labels, compatible subclasses and similar IDs confer no authority. JSON/SSE capture the selected model before callbacks and attribute the physical API privately. Google uses `x-goog-api-key` for these known IDs; Vertex retains explicit bearer authentication. Catalogue reads remain offline.

Native SDK generation defaults to the declared output maximum; invalid explicit caps/levels refuse before HTTP. Discrete levels, numeric budgets and xhigh/max clamping are scope/model-owned; Flash-Lite minimal is Google 512 versus Vertex 128. Existing conservative consumed-override validation remains, while discrete/off/omitted maps stay opaque. This does not migrate legacy default model IDs or establish full context/default equivalence. Usage subtracts observed cache reads from prompt input, includes observed thoughts in output, and chooses tiers by strict gross-input boundaries. Missing/invalid required counters cannot manufacture usage. Extra unattributed totals retain counts without an inferred cost; zero-only Gemma declarations remain unknown, not free.

Visible `thought:true` parts remain separate from answer text; a signature on ordinary text is not a thinking marker. Native JSON/SSE validate response/part/argument shapes and explicit terminal reasons; missing/error/blocked finishes cannot complete or publish pending tools. SSE awaits ordered text/reasoning delivery, refuses later content after terminal and checks withdrawal before later buffered output/tools/completion. This is not full tool/media/sampling/signed or opaque continuation qualification.

Inputs and attempts remain distinct:

- Initial metadata preparation fails two fixture cases because a deliberately falsified public API method is not restored before a later catalogue lookup. That fixture correction is preserved, not hidden as a product fix.
- Combined metadata/thinking/output red: **130 fail / 184 pass / 314**. Tree `0ecd0cd6d4761b8cbf045a71eda9168a0d6a9390` passes **314/314** and canonical typecheck. General gates are cancelled before starting when review exposes the inherited Anthropic numeric-reserve defect. These results do not qualify the corrected parent or later normalization.
- Native response red tree `7b497d67f0299b1f35248021a2c02720f22e02bd`: **39 fail / 314 pass / 353**. Corrected-parent tree `c22ba48bf880fa44e44c8d228f1bac9554a5e206`: **353/353**, canonical typecheck pass, root **7,823/7,823**, 524 files, and 1,438 declared source hashes/modes match its Node `v24.15.0` image. Standalone parity **fails**, **358 pass / four fail / 362**: installed CLI tool-pattern child `SIGSEGV`, `dispatch-public.ts` compiler `SIGABRT`, `router-classifiers-public.ts` compiler `SIGSEGV`, and Moonshot timeout 60,000ms. A separately logged OpenCode Go child `SIGKILL` is not attributed to those failures. Causes are unknown; no timeouts/assertions/compiler controls are relaxed.

Review then exposes two missing shared-host boundaries despite that passing root: published-price fallback can fill an unknown cost when total tokens contain unattributed components, and string-shaped reasoning events do not reach Core's reasoning observer. Separate red tree `8b0290f3aa9d3da57d4b4b8d5d05cdf019e52c88` gives **39 fail / 319 pass / 358**: existing per-profile SSE shape checks plus native Google/Vertex host cost/progress cases fail; legacy attributable-cost and explicitly observed-cost controls remain. Candidate tree `f176ac76e3b3702f657a33a1b56249a92c98ea3a` passes **358/358** and canonical typecheck. It emits the existing `{ content }` reasoning-event shape and prevents shared fallback pricing unless normalized totals equal priced components; explicit observed costs still win. No public field or schema is added. Standalone parity **fails**, **361 pass / one fail / 362**, make exit 2: installed `cloudflare-mixed-public.ts` strict compiler has `code=null, signal=SIGSEGV`, cause unknown. Root **fails during installed-suite beforeAll**, with **7,501 pass / 327 skipped / 7,828**, 524 files: the Core build exits 1 after its compiler reports `code=null, signal=SIGTRAP, spawnFailed=false` and V8 `unreachable code`. Those installed root cases are not run or credited. All **1,438** declared source hashes/modes match the retained Node `v24.15.0` image (not every context entry or compiled output). The earlier passing root is not credited to this revision and does not replace either failed gate.

Raw captures, immutable snapshots, cancelled preparations, source/image checks and every failed attempt are retained in the checksummed `test-results/mod01-google-vertex-20261027/` receipt; originals remain under `/tmp/aih-mod01-originals-20261027/`. Documentation lint checks 114 Markdown files/1,167 links. Browser/production are not rerun for this increment. Context reserves, complete defaults, strict tools/media, signed/opaque replay, full host/account interoperability and the remaining original families stay open. No executed reference SDK, entitlement, availability, billing or live-service qualification is claimed.
