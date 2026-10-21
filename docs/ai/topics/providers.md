# AI Providers and Models

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Providers normalize chat, streaming, reasoning, tool calls, images, discovery, retries, and usage across built-in and extension-defined backends. Core owns provider execution, network policy, credential lifecycle/storage contracts, redaction, and non-secret published model metadata. Server composes those contracts for catalogue merging, custom providers/models, OAuth, and usage persistence; CLI uses the same Core services directly.

Provider responses become persisted messages through the conversation paths described in [`sessions.md`](./sessions.md); do not add a direct call path that bypasses hooks, cancellation, or persistence.

## Architecture

```text
Core ProviderFactory -> AiProvider -> built-in or extension provider
Core model metadata -> shared published capabilities, limits and prices
Server registry -> credentials/custom dialect -> Core provider instance
Server ModelCatalog -> Core published + discovered + custom model entries
CLI/Web runtime -> streamChat -> normalized response and usage
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/providers/index.ts` | `AiProvider`, factory, built-ins, bounded payloads/streams, OpenAI Responses SSE/WebSocket transport, discovery, retry and usage normalization |
| `packages/core/src/providers/azure-config.ts` | Shared explicit Azure endpoint/protocol/environment composition and bounded deployment mapping; `AzureResponsesProvider` lives in `index.ts` |
| `packages/core/src/providers/anthropic-thinking.ts` | Shared native defaults and per-call numeric/adaptive request policy for the explicitly qualified published Anthropic profile |
| `packages/core/src/providers/provider-output-budget.ts` | Internal first-party output-policy registration and descriptor-only configured-model capture; no mandatory provider capability |
| `packages/core/src/agent/provider-request-{estimate,options,payload}.ts` | Bounded canonical request estimate, passive known option slots and owned post-hook/redactor payload copies |
| `packages/core/src/providers/thinking-budgets.ts` | Public readonly budget type, inert per-turn copies and conservative numeric-dialect bounds |
| `packages/core/src/providers/provider-endpoints.ts` | Strict based-path discovery endpoint normalization |
| `packages/core/src/providers/tool-arguments.ts` | Internal fixed-error final JSON decoding, shared by the text-argument dialects; no repair or raw-input fallback |
| `packages/core/src/providers/provider-network.ts` | Shared HTTP proxy, request/idle/connect deadlines, bounded retry and cached WebSocket leases |
| `packages/core/src/providers/credentials.ts` | Process-local credentials, OAuth refresh, command/environment resolution and recursive/streaming redaction |
| `packages/core/src/security/credential-store.ts` | Private atomic AES-256-GCM credential persistence and inter-process locking |
| `packages/core/src/providers/specialized-models.ts` | Typed virtual classification/native images, credential-private descriptors, availability, bounded hooks/requests/results and SDK cancellation |
| `packages/core/src/providers/model-metadata.ts` | Versioned shared published capabilities, context/output limits, prices and conservative inference |
| `packages/core/src/config/agent-settings.ts` | Agent startup model/scope/thinking and compaction/retry setting resolution |
| `packages/core/src/types/index.ts` | `ProviderConfig`, shared model/custom-provider contracts and capabilities |
| `packages/server/src/api/proxy.ts` | Built-in configuration, legacy chat paths, usage/cost persistence |
| `packages/server/src/runtime/model-catalog.ts` | Merge of Core published metadata, discovery and custom model definitions |
| `packages/server/src/runtime/provider-registry.ts` | Custom provider/model state and secret separation |
| `packages/server/src/runtime/provider-administration.ts`, `packages/server/src/config/config-store.ts` | Awaited host leases, unsupported reference guards, bounded optimistic rebind and private offline-recovery intent |
| `packages/web/src/services/provider-lifecycle.ts`, `packages/web/src/components/{ProviderRenamePanel,OAuthPastePanel}.tsx` | Identity-only submission, canonical outcome reconciliation and passive inline controls |
| `packages/server/src/runtime/provider-oauth.ts` | OAuth Device Flow lifecycle |
| `packages/server/src/api/{model,provider-registry}-routes.ts` | Catalogue, activation, OAuth and custom resource HTTP routes |

## Public Contracts

- `AiProvider.chat()` returns one normalized `ChatResponse`.
- `AiProvider.streamChat()` emits incremental text/reasoning/tool events, awaits each `StreamChunkCallback`, and completes once. Built-ins provide producer backpressure; the shared turn rejects extension providers that overrun its bounded pending-event/byte queue instead of awaiting callbacks.
- `AiProvider.getAvailableModels()` returns bounded discovered identifiers when supported.
- `AiProvider.canDiscoverModels()` reports discovery eligibility, including explicit keyless HTTP(S) bases; it is not a connection/authentication probe.
- `AiProvider.getSpecializedModels()`, `classify()` and `generateImages()` supply virtual/native capabilities through the bounded `SpecializedModels` SDK. Current-provider-only guest integration, supported native image models and exact ceilings are documented in [Code mode](./codemode.md). `before:model` (not conversational `before:provider`) gates hosted calls; the outer tool owns persistence/accounting. Remote image URLs are not fetched and provider credentials never enter guest descriptors/options.
- RPC now loads explicitly requested/trust-eligible extension generations before resolving custom provider/model selection, matching print/JSON. Even invalid custom selection may initialize those extensions; their stdout is still diverted to stderr, and no prompt is executed.
- `ChatOptions.signal` carries cancellation; `sessionId` supplies a bounded transport-continuation identity without becoming a credential; tools, thinking, model and retry options remain optional.
- `ProviderFactory` creates OpenAI/Azure, Anthropic, Gemini/Vertex, Bedrock, local OpenAI-compatible, mock, and registered extension providers.
- `ModelCatalogEntry` distinguishes `published`, `discovered`, `configured`, `custom`, and `virtual` sources with availability, capabilities, compatibility, context/output limits, and optional cache-aware pricing.

Published non-secret metadata lives in Core so CLI and Web use the same descriptors. Explicit thinking maps define supported levels (`null` means unsupported), while unknown models use conservative capabilities and remain unpriced. RPC caches and deduplicates live model discovery briefly, and can resolve CLI model-scope globs for cycling. Server alone merges live/custom catalogue state, but both composition roots use `ProviderCredentialService`. Raw keys/tokens stay in process memory or `EncryptedCredentialStore`; custom API keys use `provider:<private identity>` and headers use `provider-headers:<private identity>`. First-use identities retain the existing ID namespace; rename preserves that private identity, and old-ID reuse receives a fresh identity when it is reserved by a renamed record. Descriptors omit it. Catalogue, descriptor, RPC and HTTP objects are non-secret.

CLI and RPC layer explicit flags over agent settings `defaultProvider`, `defaultModel`, `enabledModels`, `defaultThinkingLevel`, and exact `modelThinkingLevels["provider/model"]`. A saved default inside the enabled scope is preferred; scope suffixes and explicit flags remain stronger, and the final level is capability-clamped. Agent-level retry settings configure shared turn retries. Core applies `transport`, `httpProxy`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs`, and bounded `retry.provider` timeouts/retries to built-in and extension/custom provider adapters. Network errors are stable and never include the request URL, remote body/headers, or proxy credentials.

Credential resolution order is environment, trusted `providerApiKeyCommands`, process memory, then encrypted storage. Command output is bounded, cached only in the process, and immediately registered with the shared redactor. OAuth endpoints and responses are bounded and HTTPS-only; refreshed access/refresh tokens replace the encrypted record without crossing descriptor boundaries. The redactor covers raw, URI, base64/base64url, hex and JSON-escaped variants, recursively bounds JSON traversal, and supplies independent stateful streams for chunked channels.

### Azure Responses

`ProviderFactory.create({ type: 'azure', azureApi: 'responses', ... })` and public `AzureResponsesProvider` use Azure SSE Responses with authoritative `api-key` authentication, not bearer auth or speculative OpenAI WebSockets. The native `/openai/v1` (optionally `/responses`) endpoint also selects Responses. Unversioned `AZURE_OPENAI_ENDPOINT` and absent `azureApi` preserve legacy deployment-based Chat Completions; explicit `azureApi: 'completions'` keeps that choice.

CLI and Server share public `azureEnvironmentConfig(env, apiKey?)`: `AZURE_OPENAI_BASE_URL` wins over `AZURE_OPENAI_RESOURCE_NAME`, then legacy `AZURE_OPENAI_ENDPOINT`. Base/resource variables select Responses, normalize root or `/openai` to `/openai/v1`, and append `/responses?api-version=v1` (or explicit `AZURE_OPENAI_API_VERSION`). URL credentials/query/fragment, legacy deployment URLs and non-HTTP(S) schemes refuse with value-free diagnostics. Loopback HTTP is admitted only through explicit Core/environment configuration; existing HTTP credential configuration still requires HTTPS for Azure.

`AZURE_OPENAI_MODEL` selects the logical catalogue model; optional `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` maps up to 256 comma-separated `model=deployment` pairs. Core accepts the typed `azureDeploymentMap`. Explicit `deployment`/`AZURE_OPENAI_DEPLOYMENT` wins, then the exact map, then the requested model ID; mapping never mutates the configured model. Server credential initialization/rotation retains environment endpoint/version/mapping. Responses preserve genuine upstream deployment/model and Azure attribution, tool replay, streamed arguments and cache-aware usage. Cancellation reports a fixed message; truncated Azure SSE cannot complete successfully. Generic model discovery returns no deployment claims.

This is a locally qualified native request path, not a complete Azure catalogue, issuer availability, durable Web endpoint configuration, signed replay/profile or RPC descriptor-dialect certificate. Existing heuristic catalogue descriptors are not effective transport evidence. The full pinned scope remains open in [the matrix](./provider-matrix.md).

### Mixed reasoning/text deltas

An OpenAI-compatible SSE delta containing both `reasoning_content` and `content` publishes and awaits reasoning before text, regardless of JSON property order. Azure/local inherit that normalization. Shared turns likewise await reasoning before text when one extension callback supplies both. Separate callbacks/SSE events retain their input order; HTTP byte chunks do not define a sorting boundary. Final text/reasoning, usage, tool calls, output ceilings and protocol versions are conserved. Independent stateful redactor buffering/flush remains unchanged; this is not global transcript sorting, signed reasoning replay or conformance for every dialect.

### Explicit OpenAI-compatible SSE errors

OpenAI/Azure/local streaming refuses an own truthy top-level `error` before publishing any other fields from that frame or completing pending tool calls. The existing error callback receives only `The provider reported a streaming error.`, never the upstream body/code/message. Absent/null/false markers preserve normal completion, usage and tool calls. This changes neither ordinary chat nor other provider dialects.

Shared turns apply their existing bounded pre-output retry policy; already delivered text or reasoning prevents replay. Defaults remain three attempts in Core/SDK and four in CLI/RPC (2/4/8-second CLI delays), subject to existing host settings. This is error recognition, not a new busy/capacity classifier, backoff policy, strict-tools fallback or retry-budget change. SDK/RPC permit a later explicit prompt after failure.

CLI print/JSON and RPC await persistence of delivered, already-redacted failed text/reasoning before error settlement, with bounded `metadata.outputError` and effective provider/model. Empty/cancelled turns, pending tool calls and invented usage are not saved; ordinary stream failure does not trigger compaction. Print still emits no failed response on stdout; JSON keeps its error/exit framing. Reloaded JSON/RPC message projection recognizes the existing output-error marker without replacing the prefix with diagnostic text. Native and installed tests cover Unicode/UTF-8 fragmentation, redaction, one prior tool effect and explicit reload/resume without duplication/replay; RPC also covers failed reasoning. Redactor-withheld suffixes remain excluded.

The shared loop separately permits one useful compact-and-retry for recognized local/structured HTTP overflow or tool-free length exhaustion, preserving raw failed history and authentic usage. Classification bounds, policy/source/signal checks and exclusions are in [context recovery](./run-lifecycle.md#bounded-useful-context-recovery). Native OpenAI chat/Responses, Anthropic, Gemini and Bedrock project accepted tool images as attributed user attachments after the complete result batch; synthetic attachments never rewrite persisted history. See [rich results](./run-lifecycle.md#parallel-nested-and-rich-tool-results).

### Final tool-argument JSON

OpenAI-compatible chat/stream, OpenAI Responses SSE/WebSocket and Anthropic streaming share an internal final string decoder. Malformed nonempty JSON refuses the entire batch before any complete `tool_call` event or tool execution, including when an earlier call in that response is valid. The fixed error `The provider tool arguments were invalid JSON.` includes no argument body or parser exception. Shared turns treat this protocol failure as terminal even before text; normal transient-error retries remain unchanged. A started Responses WebSocket failure cannot trigger an SSE replay, and its cached connection is retired.

Empty/absent no-argument strings retain the existing `{}` behavior; valid JSON objects, arrays, primitives and null retain the existing `unknown` input contract. This is not a new object-only or JSON Schema policy, partial-JSON repair, general extension-response/accessor validation or a change to the existing wire/output byte ceilings. Native object-input Gemini/Bedrock/Anthropic-chat paths are not string-decoded. Existing error records, SDK failed-run status and explicit subsequent prompts are reused, not a new protocol version or automatic tool retry.

## Explicit Passive Provider Policies

`collectProviderModelCatalog(providers, { discover: false })` assembles published/configured metadata without invoking discovery capability or model-list callbacks. Existing availability validation and conservative metadata remain; no live-only model or durable cache is invented. The default remains live discovery, preserving Server/Web and embedded-host behavior.

`ResolveProviderCredentialOptions.allowCommands: false` makes a selected command source unavailable before execution **or cached-command consumption**, without falling through to a lower-priority stored key. `allowRefresh: false` leaves OAuth inside the existing 60-second refresh window unavailable and unchanged, without reading refresh settings, calling fetch or publishing credentials. Environment keys, API keys and OAuth outside that window keep their normal precedence. Both options default to the previous behavior; they do not revoke credentials, clear the command cache or prevent an explicit later online resolution. Core never infers these options from a CLI environment variable.

CLI/RPC compose these explicit policies through [offline startup](./cli-reference.md#offline-startup-policy); the environment is captured before trusted extension imports and CLI flags come from the definitive parse. Public Core declarations and actual locally installed consumers exercise the additive booleans. `providers/offline-policy.test.ts` retains encrypted byte identity, real bounded command controls, inert refresh-config getters and positive online refresh/discovery controls. This is startup policy, not a transport firewall or complete offline model catalogue.

## Single model versus plural scope

Core `providers/model-catalog.ts` resolves one model without treating catalogue order as provider authority: exact IDs/names and fuzzy aliases use a sole available configured provider, otherwise shared references remain ambiguous. Alias/date ordering stays provider-local. CLI startup refuses ambiguity before its custom-model/default-provider fallback; explicit qualification and full-ID-first native colon handling remain unchanged.

Non-glob scope entries are intentionally plural: resolve independently within each provider, preserve explicit qualification and deduplicate with first position/thinking pin. Existing glob behavior remains separate. CLI/RPC adapters publish each unresolved scope diagnostic as a fixed stderr warning, including alongside explicit startup `--model`; no new protocol record, persisted setting or public Core API is introduced. See [model selection](./cli-reference.md#model-catalogue-and-selection). Owning Core/CLI ambiguity/startup/process leaves and the genuine installed consumer cover credential states, catalogue permutations, scopes/cycling, trailing commas, native colons and channel purity.

## Numeric reasoning budgets

Core exports readonly `ThinkingBudgets` for `ChatOptions`, `StreamProviderTurnOptions` and `StartAgentRunRequest`, plus the validating `copyThinkingBudgets(unknown)` helper; existing `AgentSettings` budget maps remain mutable and structurally compatible. Its four optional fields are `minimal`, `low`, `medium` and `high`. Settings merge global then trusted-project fields; CLI interactive/print/JSON and RPC read that snapshot at each model call. Interactive `/reload` refreshes it; RPC file changes still require restart. Shared provider-turn admission copies inert own fields before `before:provider`, so hook mutation cannot mutate the source settings. Undefined fields are omitted; inherited fields are ignored. Arrays, unknown keys, accessors and unsafe/negative/fractional/nonfinite values fail with a fixed value-free error. Enabled numeric requests revalidate after hooks.

Anthropic chat/stream use the selected override, clamped to 1,024–32,768, omit temperature with enabled thinking and preserve the existing `max_tokens >= budget + 1024` expansion. The old invalid 512-token minimal default consequently becomes 1,024. Gemini/Vertex share one body builder: 2.5-Pro budgets clamp to 128–32,768, 2.5-Flash to 0–24,576, and other model names to 0–8,192. These are conservative existing-dialect ceilings, not complete model capability discovery. Missing overrides retain defaults; direct Core `xhigh`/`max` keep their distinct legacy defaults, while CLI capability clamping may instead select `high`. Absent/off thinking is not enabled by a budget. Effort-only APIs do not consume numeric overrides.

Detached Web runs now compose the same budgets through administrator-scoped configuration, trusted-file fallback and an EN/FR Settings JSON control. Whole scoped maps replace lower maps; `{}` selects provider defaults, `null` restores inheritance, and prompt bodies cannot override the policy. See the [native configuration map](./provider-matrix.md#reasoning-host-composition) and real-browser wire fixture. This does not implement complete per-model maps/defaults, total-token spending limits, child-agent inheritance or legacy proxy-chat composition. The separately qualified adaptive profile below does not consume numeric overrides. Owning proofs: Core `providers/thinking-budgets.test.ts` captures real loopback HTTP chat/stream payloads and negative admission; CLI `cli/thinking-budgets-process.test.ts` covers emitted print/JSON/RPC hooks and HTTP, trust merge, genuine PTY reload and a strict outside-checkout public-declaration consumer. No live vendor credentials are used.

## Published Anthropic adaptive profile

The exact published `claude-sonnet-4-6` ID now uses one Core policy in both chat and streaming requests. Enabled reasoning sends `thinking: { type: "adaptive" }` and `output_config.effort`, not `budget_tokens`. Capability clamping uses the existing shared metadata: minimal maps to low, low/medium/high remain themselves, max sends native max, and unsupported xhigh clamps upward to max. Explicit off sends `thinking: { type: "disabled" }`; an absent option stays absent. Temperature remains omitted while thinking is enabled.

Numeric `thinkingBudgets` does not apply to this profile. Explicit `ChatOptions.maxTokens` remains exact. Without it, preserve the previous per-requested-level output ceilings: minimal/low 2,048; medium 5,120; high 9,216; xhigh 17,408; max 33,792. CLI/RPC already clamp xhigh to max before the provider call, so that path uses 33,792. This avoids silently reducing enabled adaptive calls to the constructor's 1,024-token default. Off/unspecified calls retain that default. These are AiHarness legacy output limits, not claimed vendor maxima.

Model selection is reevaluated from the actual request model on every call, including configured-model changes and per-call overrides. Only this exact qualified ID selects the new dialect; classic and unqualified/lookalike IDs retain their numeric behavior. Invalid non-undefined thinking values fail before provider HTTP. No new metadata or public API version is invented.

Core `providers/anthropic-thinking.test.ts` captures chat/stream payloads, defaults, overrides, visible reasoning and negative admission. CLI `cli/anthropic-thinking-process.test.ts` runs the actual emitted built-in provider in print/JSON/RPC, plus a five-prompt RPC effort/model/off sequence. Its preload changes only the approved transport origin to a loopback fixture; it does not replace provider construction, metadata, selection or body generation, and refuses other network destinations.

This is a request-dialect qualification, not live vendor certification or full Anthropic support. Other model profiles, adaptive Gemini, complete defaults/capability maps and signed thinking-block preservation across tool continuations remain open. Existing text/reasoning projections are not an opaque provider-transcript round-trip.

## Bounded ordinary request admission

Shared `agent/provider-turn.ts` captures the selected streaming method and redactor bindings before callbacks. Own model-bearing input before extensible JSON redaction and own its result again; reprepare after awaited start observers and on each retry. Mutable hook arrays remain mutable without aliasing the dispatched request. Recognized fields require own data or genuine absence; unrelated legacy getters/serializers are ignored. Keep authentic signal and opaque unused thinking maps outside JSON redaction. Initial malformed hook payloads refuse quietly; later local refusal pairs with the admitted error lifecycle and is not retried unchanged.

Optional `StreamProviderTurnOptions.contextBudget` owns positive safe-integer `contextWindow` and nonnegative `reserveTokens`. Its canonical policy is bounded JSON UTF-8 bytes/4 over projected messages/system/tools,not historical billed usage or vendor tokenization. Reserve the maximum of configured reservation,pre-redaction explicit output and final effective output. Output alone greater than the window refuses before provider work. Core `AgentRuntime` captures an existing known manager policy;private checks revalidate current window/reservation at the guard. Equivalent values/title changes conserve admission,recognized reservation accessors refuse unread and unrelated settings getters remain unused.

Only exact first-party `AnthropicProvider` instances register native output preparation;structural/extension/subclass providers gain no mandatory capability. Capture the configured fallback model before callbacks;prepare used numeric maps after awaited observers without freezing caller maps. Reuse actual `applyAnthropicThinking` and native defaults:1024 without thinking,low budget2048 expands explicit64 to3072,and adaptive high without an explicit maximum produces9216 while explicit64 stays64. Off/adaptive effort-only modes leave unused numeric maps opaque.

[WARNING] Unknown manager windows retain legacy behavior and currently lose later-known ceilings. This is not full effective-model/native-dialect/media admission:unknown media is unmeasured,the current guard only checks independently known non-message overhead in that case,and post-hook model capacity,useful compaction/rebuild/overflow,CLI/RPC budget composition,general lifetime authority and actual-settled accounting remain separate. Do not infer a zero media cost,live-vendor proof or complete compaction from a refusal.

## Critical Flows

### Runtime request

```text
before:provider hook -> own/validate payload -> awaited start observers
  -> re-own redacted payload/native output -> optional canonical budget guard
  -> captured provider.streamChat(messages, callbacks, authentic signal)
  -> awaited, bounded deltas/tool calls
  -> cache-aware normalized usage (uncached input + cache read/write + output)
  -> shared tool loop and message persistence
  -> cost only when provider or published catalogue pricing is authoritative
```

### OpenAI Responses transport

`OpenAiResponsesProvider` supports SSE plus real RFC 6455 `websocket` and `websocket-cached` modes. `auto` attempts WebSocket and falls back to SSE only before the first WebSocket event. Cache identities hash session, endpoint, account and headers; raw session IDs are not keys exposed to diagnostics. Idle sockets are leased exclusively, bounded to 64 entries, expire after five idle minutes or 55 minutes of age, and concurrent requests use an ephemeral socket rather than sharing an active lease.

A completed response without tool calls may retain `previous_response_id` and a context fingerprint. A subsequent comparable request sends only its bounded delta; missing continuation and connection-limit protocol errors retry once. Continuation context is capped at 512 KiB. Bodies, events, queued events, accumulated output and tool calls all have explicit limits, and no SSE fallback occurs after any WebSocket event because that could replay an operation.

### Catalogue refresh

1. `ModelCatalog` starts with versioned published entries.
2. Configured providers perform bounded discovery where supported.
3. `ProviderRegistry` contributes custom providers and models.
4. Enabled qualified IDs (`provider:model`) are resolved by global/project scope.
5. Web receives metadata only; discovery failure retains safe catalogue entries.

### Custom lifecycle and restricted rename

Discovery accepts explicit keyless HTTP(S) API bases or supported full request endpoints, preserving proxy paths without synthetic authentication. Server discovery caches bind to the actual provider instance; replacement, reload, rename and old-ID reuse discard stale sources and late results. Explicit disconnection persists across reconciliation/restart. Metadata-only edits omit unchanged secrets; PUT cannot change identity.

`POST /api/provider-registry/custom/:id/rename` requires credentials/configuration administrator capabilities and the ordinary Origin boundary. Its only body fields are `{ id, revision }`; built-in IDs are immutable. `GET /custom` retains its array and exposes passive `X-AiHarness-Provider-Rename` capability metadata. Missing/invalid metadata disables Web rename. Settings names exact custom IDs and reloads canonical providers/auth/catalogue/scoped defaults/effective configuration after every outcome, guarded against retired workspace/session/selection results.

[WARNING] Rename is OFF by default. Only `AI_HARNESS_PROVIDER_RENAME_EXCLUSIVE_HOST=1` (exact value) or `providerRenameExclusiveHost: true` opts into a temporary restricted SINGLE-WRITER host. Stop all CLI/other servers/external writers first; independently administer data/session/config/trust/installed-code paths outside editable allowed roots. Activating over a still-owned prior host is refused. This is not OS process isolation or shared-runtime admission.

Actual awaited operation leases cover session/config/profile/start/reload owners, including disconnects and queued child admission. Detached work continuing after HTTP 202 is separately checked through fresh active-run inventories. Rename owns exclusion through registry rollback/reconciliation and the final intent-settlement handshake. Busy agents/PTYs, current or historical session references, qualified disabled child profiles, environment selectors, global/project agent settings and unsafe/legacy/oversized inventories refuse rather than rewrite history or grant trust.

Restricted mode refuses legacy chat/upgrades, shell/PTY, executable package/extension commands, active MCP, file/workspace HTTP (including Git helpers), and unleased model/tool/resource mutations. It imports no third-party Node generation, injects no persistent MCP host into agents, refuses credential commands and cancels bash/PowerShell/Git-search/codemode tools. Default-OFF ordinary host/npm behavior is unchanged. Privileged embedders remain responsible for their own code and manual listeners.

The bounded fresh ConfigurationStore transaction rewrites only exact provider and `oldId:` model/enabled-model references across global/projects/sessions, refuses non-canonical case/whitespace or slash-qualified aliases before publishing an intent, preserves inheritance/siblings and compares publication bytes plus observed file identity for rollback. Registry CAS likewise detects observable replacement/ABA. These are optimistic checks, not hostile-writer atomic compare-exchange.

[WARNING] Two metadata files are NOT crash-atomic. A private bounded `config.json.provider-intent.json` pending/malformed/linked/uncertain intent blocks initialization, listener publication and mutations. Never auto-replay, clear by PID, or force-clear online. With EVERY writer stopped, preserve metadata/credentials/intent/reference inventories, inspect intervening edits and choose/verify one coherent outcome without guessing or moving secrets or rewriting history. Remove the intent only after explicit offline reconciliation, then restart. A settled marker is safe to retain.

Provider OAuth remains Device Flow; it has no pasted callback endpoint. The shared inline `OAuthPasteInput` is used by genuine MCP callback flows. It is inert before explicit flow admission, bounded to 8,192 characters, transient, non-autofocusing and acknowledgement-gated; Enter preserves native composition and legacy keyCode 229 rather than submitting. Original MCP labels/layout/polling/trust/status/cancel ownership remain in the host.

### Add a provider

1. Add the Core implementation and factory mapping.
2. Add Server configuration, credentials, discovery/OAuth, and proxy handling as applicable.
3. Update CLI command/RPC initialization and Web settings/catalogue behavior.
4. Export public Core contracts from `packages/core/src/index.ts`.
5. Test streaming completion, cancellation, malformed remote data, secrets, and usage.

## Associated Tests

- `packages/core/src/providers/azure-responses.test.ts` — Azure endpoint/auth/deployment/environment admission, SSE tools/usage, truncation, cancellation and body-free failures; `packages/cli/src/cli/azure-responses-process.test.ts` — actual emitted print/JSON/RPC and durable physical usage; `packages/server/src/api/azure-responses-http.test.ts` — real environment initialization/key rotation and detached HTTP history/privacy; the installed Azure consumer in `tests/functional-parity/installed-executable.test.ts` separately checks public declarations/runtime

- `packages/core/src/providers/stream-error-frames.test.ts`, `packages/cli/src/cli/stream-error-process.test.ts` and the installed parity consumer — real SSE errors/mixed fields/pending tools, body-free diagnostics, unchanged retry bounds, visible-prefix no-replay, zero hooks/effects on refused calls, explicit SDK/RPC continuation and CLI print/JSON durable Unicode prefix/reload/resume; `cli/json-output.test.ts` separately guards persisted error projection
- `packages/core/src/providers/mixed-delta-order.test.ts`, `packages/cli/src/cli/mixed-delta-process.test.ts` and the installed parity consumer — mixed-field/callback reasoning-first order, separate-event controls, awaited observers, terminal observer failure, exact final output and retained JSON/RPC/SDK framing/history
- `packages/core/src/providers/tool-arguments{,-admission}.test.ts` — real loopback fragmented final JSON, valid/empty/primitive controls, whole-batch refusal before hooks/effects, terminal retry classification and passive nonstring decoding
- `packages/core/src/providers/provider-websocket.integration.test.ts`, `packages/cli/src/cli/tool-json-process.test.ts` and the installed parity consumer — real cached/auto WebSocket no-replay/connection retirement, emitted print/JSON/RPC/SDK errors, no tool effects/retries, valid controls and explicit recovery through the public installed package
- `packages/core/src/providers/{index,provider-network,credentials,provider-websocket.integration}.test.ts` and `packages/cli/src/agent/provider-turn.test.ts` — built-ins, bounded payloads/streaming, real local WebSocket and CONNECT-proxy handshakes, cached continuation/fallback, credentials, tools, images, reasoning, usage and cancellation
- Core `agent/provider-request-{estimate,budget,options,payload,options-flow}.test.ts` and `providers/provider-output-budget.test.ts` — canonical input versus billed history,passive descriptors,redactor ownership/output evidence,late observer mutations,known policy checks and exact first-party native output/lifecycle compatibility
- `packages/server/src/runtime/model-catalog.test.ts` — catalogue merge, capabilities, pricing and refresh bounds
- `packages/server/src/runtime/provider-registry.test.ts` — custom lifecycle and secret separation
- `packages/server/src/runtime/provider-oauth.test.ts` — OAuth flow lifecycle
- `packages/server/src/web-server.test.ts` — HTTP configuration, credentials and provider integration
- `packages/web/src/services/api.test.ts` and `e2e/settings.spec.ts` — browser contracts and settings flow

Never use real credentials or external network calls in tests.

- `packages/core/src/providers/provider-endpoints.test.ts` — based-path/keyless real loopback discovery, bounds and non-reflection
- `packages/server/src/config/provider-reference-transaction.test.ts`, `packages/server/src/runtime/provider-administration.test.ts`, `packages/server/src/runtime/provider-lifecycle.test.ts`, `packages/server/src/api/provider-lifecycle-routes.test.ts`, `packages/server/src/api/provider-host-integration.test.ts` — exact reference transaction, leases, four real SIGKILL windows, observed identity/ABA, fail-closed restart and actual restricted composition
- `e2e/provider-settings.spec.ts`, `packages/web/src/services/provider-lifecycle.test.ts`, `packages/web/src/components/{oauth-paste-panel,provider-rename-panel}.test.ts` — passive capability/paste, identity-only intent and selection-safe reconciliation

## Common Changes

### Change model metadata

Update `packages/core/src/providers/model-metadata.ts`, then verify the Server merge, CLI RPC descriptors/thinking levels, activation, capability filtering, prices, usage, API serialization, and Web selectors.

### Change streaming

Update the Core provider and shared tool loop expectations. Preserve incremental chunks, one final assembly, AbortSignal propagation, reasoning/tool events, and no double completion. Await every chunk callback; consumer delivery errors are terminal and must not be retried, while a non-cooperative extension producer must fail through the bounded queue guard.

### Change provider administration

Update registry/service/routes, `packages/web/src/services/api.ts`, Settings UI, security capability tests, and secret-redaction coverage together.

## Related Domains

- [`model-dispatch-policies.md`](./model-dispatch-policies.md) — selectable virtual routing, physical provenance, billable cache-warming policy/accounting and historical notice presentation
- [`provider-matrix.md`](./provider-matrix.md) — all 42 pinned factory identities, API/auth gaps, distinct installed-data provenance and native settings map
- [`editor-schemas.md`](./editor-schemas.md) — existing native model-registration metadata editor data, never private credentials or a CLI models.json loader
- [`sessions.md`](./sessions.md) — message persistence and usage round trips
- [`extensions.md`](./extensions.md) — provider registration and `before:provider`
- [`server-api.md`](./server-api.md) — model and registry routes
- [`security.md`](./security.md) — credentials and non-secret diagnostics
