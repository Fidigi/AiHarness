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
| MOD-01.01b | Complete the remaining original built-in model policies: OpenAI, Anthropic, Google, Azure, Vertex and Bedrock. | **IN PROGRESS:** Anthropic static-metadata/observed-accounting and output-ceiling sub-lots below; remaining policies for all six originals stay open. Per-model request/response fixtures for physical APIs, caps, reasoning, tools, usage and defaults; API identity must not depend on an operator alias. |
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
