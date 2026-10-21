# Pinned Provider Scope and Native Configuration Map

> **Navigation:** See [`project-map.md`](../project-map.md) for ownership and Docker validation; [providers](./providers.md) owns executable native contracts.

## Scope and provenance

This is a gap inventory for MOD-01/02, **not an implementation or live-service certificate**. Factory identities/auth below come from Pi 1.2.0 commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, `packages/ai/src/providers/{all,<id>}.ts` and their auth helpers. No automatic update or foreign configuration loading is authorized.

Model counts come separately from the locally installed `@earendil-works/pi-ai@1.2.0` package's `dist/providers/data/*.json`: 42 files, 1,649 typed API entries (1,554 chat, 34 classifier, 61 image). Counts include repeated identities across APIs/types, not unique usable native models. Every file matches its manifest SHA-256. Manifest schema 6, generated `2026-10-12T22:50:30.032Z`, manifest SHA-256 `a4c0a81f2cc4323b81d4c5d3886b343dc226939168f33e8eb731c928a81cfce9`. Generated data is absent from the source checkout; matching package version/factory IDs does not establish a reproducible release build or vendor availability.

## Provider, API and authentication matrix

API abbreviations preserve upstream IDs: C=`openai-completions`, R=`openai-responses`, A=`anthropic-messages`, G=`google-generative-ai`, V=`google-vertex`, B=`bedrock-converse-stream`, M=`mistral-conversations`, D=`openai-decisions`, T=`typesafe-system-one`, I=`openrouter-images`, P=`pi-messages`, S=`cloudflare-workers-ai-system-one`, AZ=`azure-openai-responses`, CX=`openai-codex-responses`.

Native column: **subset** means an existing built-in, never complete catalogue/auth parity; **candidate** means explicit custom HTTP configuration can express at least one corresponding dialect, but no dedicated provider/default catalogue/auth integration or per-provider qualification is delivered; **missing** means a required dedicated API is absent. A candidate is not an automatically configured or certified provider. All rows still lack full pinned live-account qualification.

| Pi provider ID | Entries | Pi APIs | Pi connection methods | Native path / remaining gap |
|---|---:|---|---|---|
| amazon-bedrock | 193 | B | AWS bearer, profile, keys, ECS/web identity | `bedrock` subset: SigV4 environment keys; wider credential chain missing |
| ant-ling | 3 | C | API key | Custom candidate |
| anthropic | 17 | A | API key, auth bearer, workload federation, Claude subscription OAuth | `anthropic` subset; issuer/subscription/federation parity missing |
| azure | 45 | AZ, C | API key | `azure` completions plus native Azure SSE Responses request path; pinned catalogue/profile/live-resource qualification still missing |
| baseten | 22 | C | API key | Custom candidate |
| cerebras | 2 | C | API key | Custom candidate |
| cloudflare-ai-gateway | 57 | A, C, R | Cloudflare gateway token/account/gateway configuration | Custom candidate; gateway-specific resolution missing |
| cloudflare-workers-ai | 21 | S, C | Cloudflare token/account configuration | Custom C candidate; S missing |
| deepseek | 2 | C | API key | Custom candidate |
| fireworks | 22 | A, C | API key | Custom candidates; per-model dialect routing missing |
| github-copilot | 35 | A, C, R | Copilot token, subscription OAuth | Missing subscription/token exchange and per-model dispatch |
| google-vertex | 13 | V | Cloud API key, application-default credentials | `vertex` subset: explicit access token; ADC/key parity missing |
| google | 22 | G | Gemini API key | `google` subset |
| groq | 7 | C | API key | Custom candidate |
| huggingface | 78 | C | HF token | Custom candidate |
| kimi-coding | 4 | A | API key, subscription OAuth | Custom A candidate; subscription missing |
| meta | 6 | R | API key, Muse subscription OAuth | Custom R candidate; subscription missing |
| minimax-cn | 3 | A | API key | Custom candidate |
| minimax | 3 | A | API key | Custom candidate |
| mistral | 40 | M | API key | M missing; C compatibility is not Conversations delivery |
| moonshotai-cn | 4 | C | API key | Custom candidate |
| moonshotai | 4 | C | API key | Custom candidate |
| nvidia | 21 | C | API key | Custom candidate |
| openai-codex | 9 | CX | ChatGPT Plus/Pro OAuth | Dedicated subscription adapter missing |
| openai | 45 | D, R | API key, ChatGPT subscription OAuth | `openai` C built-in, custom R adapter; D and subscription parity missing |
| opencode-go | 31 | A, C, R | OpenCode API key | Custom candidates; mixed-dialect routing missing |
| opencode | 85 | A, G, C, R, T | OpenCode API key | Custom candidates; T and mixed routing missing |
| openrouter | 475 | A, C, I, T | API key, OAuth | Custom A/C candidates; OAuth/I/T/per-model routing missing |
| qwen-token-plan-cn | 20 | C | Plan API key | Custom candidate; plan-specific qualification missing |
| qwen-token-plan-individual | 9 | C | Plan API key | Custom candidate; plan-specific qualification missing |
| qwen-token-plan | 20 | C | Plan API key | Custom candidate; plan-specific qualification missing |
| radius | 29 | P | API key, OAuth, configurable gateway | P and issuer integration missing |
| together | 17 | C | API key | Custom candidate |
| typesafe | 1 | T | API key | T missing |
| vercel-ai-gateway | 251 | A, T | Gateway API key | Custom A candidate; T/gateway-specific behavior missing |
| xai | 4 | R | API key, Grok/X subscription OAuth | Custom R candidate; subscription missing |
| xiaomi-token-plan-ams | 4 | C | Regional plan API key | Custom candidate; regional/plan qualification missing |
| xiaomi-token-plan-cn | 4 | C | Regional plan API key | Custom candidate; regional/plan qualification missing |
| xiaomi-token-plan-sgp | 4 | C | Regional plan API key | Custom candidate; regional/plan qualification missing |
| xiaomi | 6 | C | API key | Custom candidate |
| zai-coding-cn | 4 | C | Regional coding-plan API key | Custom candidate; plan qualification missing |
| zai | 7 | C | Coding API key | Custom candidate; plan qualification missing |

Azure's explicit native Responses selection, endpoint/deployment environment map and local Core/emitted CLI/HTTP/installed boundaries are documented in [providers](./providers.md#azure-responses). It does not certify all 45 pinned entries, vendor deployment availability or heuristic RPC dialect descriptors.

Native `local` and `mock` are additional native paths, not substitutions for missing upstream issuers. A generic operator-configured Device Flow is not a tested implementation of one of these subscription protocols. OAuth is not permission to purchase a subscription, start a login, send prompts or use a paid account automatically.

## Native versus foreign configuration

| Intent | Pi location / shape | Native contract |
|---|---|---|
| Default model | Agent model settings and provider-qualified references | Trusted `defaultProvider`/`defaultModel`; explicit CLI/environment precedence; Server scoped `provider`/`model` |
| Ordered model cycling | Model selectors/scopes | Native `enabledModels`, full-ID-first resolution, ambiguity refusal and first-position thinking pins; no implicit foreign aliases |
| Provider endpoints/models | `models.json` provider/API/model definitions | No CLI `models.json` loader. Server explicit custom provider/model CRUD; Core/CLI trusted `registerProvider` |
| Dialect | Per-provider/per-model upstream API IDs | Native custom `openai-completions`, `openai-responses`, `anthropic`, `google`; other IDs are not aliases |
| Credentials | Upstream auth storage, env names and OAuth drivers | Native environment → trusted command → process memory → encrypted store; never import foreign token files |
| Model limits/pricing | Upstream generated/cache/model definitions | Native published/configured/discovered/custom metadata; unknown remains unknown; no automatic catalogue copy |
| Reasoning | Model-specific effort/numeric controls | Native level clamping and four-field `thinkingBudgets`; only qualified native dialects consume them |
| Transport | API-specific SSE/WebSocket behavior | Native network policy and Responses transport; generic C does not grant R/CX/issuer semantics |
| Offline/freshness | Published/cached upstream catalogues | CLI passive offline startup; Server five-minute memory discovery cache. No durable offline catalogue added |
| Prompt-cache policy | `cacheWarming`, `showCacheMissNotices` | Native bounded scheduler and historical CLI/Web notices; independent visibility controls, eligible physical profiles and billable replay limits in [dispatch policies](./model-dispatch-policies.md) |

## Reasoning host composition

`StartAgentRunRequest.thinkingBudgets` is an optional trusted embedding input. Core copies the inert map before admission awaits; each provider turn receives its own hook copy. The numeric wire/clamp/output-reserve rules remain in [providers](./providers.md#numeric-reasoning-budgets), not in a second host implementation.

Server `ScopedConfigurationValues.thinkingBudgets` accepts the same four safe nonnegative integer fields. Configuration mutations retain administrator capability checks. Global/project/session precedence replaces the **whole** map; `{}` suppresses lower/file overrides and uses provider defaults. Scoped `null` removes that key and restores inheritance. With no winning scoped map, detached HTTP runs use the already trusted agent/project `settings.json` map. A run's JSON body cannot override this policy. File settings keep their existing per-field global/project merge and trust gates.

Settings → Provider and model defaults exposes the JSON map for global/project save, inherited readback and source provenance. Invalid JSON stays local; server schema validation remains authoritative. Empty text sends the existing nullable reset. EN/FR help distinguishes numeric clamps, effort-only ignoring, whole-map precedence and `{}` versus inheritance. Displayed values/provenance describe scoped configuration only, not the trusted-file fallback resolved later at run admission; this is not a complete effective-run preview. CLI/RPC startup/reload semantics are unchanged. Child-agent inheritance and legacy proxy-chat composition are not added by this detached-run path.

## Entry points and evidence

| File | Responsibility |
|---|---|
| `packages/core/src/{providers/thinking-budgets,agent/runtime,agent/provider-turn}.ts` | Shared validation, copied startup input, fresh per-turn options |
| `packages/server/src/{config/config-store,api/agent-routes}.ts` | Scoped validation, trusted-file fallback, no prompt-body authority |
| `packages/web/src/components/EcosystemSettings.tsx`, `reasoning-settings-messages.ts` | Scoped Settings UI and feature-local EN/FR help |

Use Core `providers/thinking-budgets.test.ts` and `agent/runtime.test.ts`, Server `config/config-store.test.ts` and `api/configuration-defaults.test.ts`, CLI `cli/thinking-budgets-process.test.ts` and `e2e/reasoning-budgets-live.spec.ts`. The browser scenario uses actual emitted Web/API/Core/native Anthropic code against a disposable loopback service; it is not live vendor evidence. Status and executed commands belong in [AUDIT-5](../../audit/pi/AUDIT-5.md).

## Common Changes

- To add a provider/issuer, implement its Core adapter and credentials plus CLI/Server registration and Web configuration paths named in [providers](./providers.md#add-a-provider). Qualify each missing API/issuer separately, then update this inventory.
- To change numeric host policy, edit Core `providers/thinking-budgets.ts`, Server `config/config-store.ts`/`api/agent-routes.ts` and Web `EcosystemSettings.tsx`; rerun the named Core, HTTP, CLI and real-browser controls separately.

Preserve explicit account consent, native encrypted storage/redaction, cancellation, real per-model budgets and source freshness. Do not close MOD-01/02 from this inventory, MOD-03 from one numeric host path, MOD-04 from specialized-model `virtual` descriptors, or MOD-05 from parsed settings. Selectable physical routing and economic/time-bounded cache warming are implemented separately; their remaining host/profile/qualification gaps stay explicit in the dispatch policy contract. Economics are not a global monetary cap.

## Related domains

- [Providers](./providers.md) — executable dialect/network/auth contracts and owning tests.
- [Security](./security.md) — credential and administrator boundaries.
- [Sessions](./sessions.md) — native journal/accounting and branch ownership.
