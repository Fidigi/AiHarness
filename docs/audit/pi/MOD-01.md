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
| MOD-01.01a | Reconcile every pinned `(provider, model, API, type)` row with the actual native adapter, supported operations, metadata and host admission. Start from the existing 42-row inventory and adapter declarations. | Exhaustive missing/implemented mapping against pinned data and hashes; distinguish shared IDs across APIs and declared versus executable media. |
| MOD-01.01b | Complete the remaining original built-in model policies: OpenAI, Anthropic, Google, Azure, Vertex and Bedrock. | Per-model request/response fixtures for physical APIs, caps, reasoning, tools, usage and defaults; API identity must not depend on an operator alias. |
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
