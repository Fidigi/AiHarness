# Subscription Providers

> **Navigation:** See [`project-map.md`](../project-map.md) for ownership and Docker validation.

## Overview

GitHub Copilot has a bounded native subscription implementation, distinct from API-key OpenAI, Anthropic and Google. It does **not** complete MOD-03 or the subscription-provider scope. ChatGPT/Codex remains unimplemented; a Copilot model whose name contains `codex` does not implement ChatGPT authentication.

[IMPORTANT] Server OAuth now has a native Copilot device-login path as well as existing-credential composition. Web Settings has separate emitted-Server/static-Web EN/FR fixture journeys; interactive CLI now has a separate explicit issuer path and bounded terminal fixtures; full profile/account acceptance remains incomplete. Do not infer live account acceptance from service/HTTP/browser fixtures.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/providers/github-copilot-oauth.ts` | Explicit public-client configuration, durable GitHub grant exchange, restricted inference endpoint and account catalogue |
| `packages/core/src/providers/github-copilot.ts` | Immutable 35-model declarations, account intersection, A/C/R headers and request lowering |
| `packages/core/src/providers/index.ts` | Public `GitHubCopilotProvider`, private protocol delegates and exact native-replay admission |
| `packages/core/src/providers/credentials.ts` | Explicit subscription selector, issuer-bound refresh, one-shot OAuth publication and redaction |
| `packages/core/src/security/credential-store.ts` | Encrypted persistence, document revision and atomic compare-and-set |
| `packages/core/src/providers/model-catalog.ts` | Account-authoritative availability without published/custom fallback grants |
| `packages/cli/src/cli/provider-auth-command.ts`, `packages/cli/src/commands/handler.ts`, `packages/cli/src/security/oauth-device.ts` | Explicit standalone/interactive issuer login, guarded publication and abortable device transport |
| `packages/cli/src/providers/{provider-runtime,configured-providers}.ts` | Native canonical-label composition with a fresh credential resolver |
| `packages/server/src/runtime/{github-copilot,provider-oauth}.ts`, `packages/server/src/api/{provider-registry-routes,proxy}.ts` | Explicit native device login, guarded publication, lifetime-bound credential composition, legacy streaming and detached agent access |
| `packages/server/src/runtime/model-catalog.ts` | Revalidated local account availability; failed discovery cannot retain an old grant |

## Public Contracts and Invariants

- Construct `GitHubCopilotProvider(config, credentialSource)` with a pinned model and asynchronous credential source. The adapter fixes owner `github-copilot`; API-key/base-URL configuration is not subscription authority. There is no API-key `ProviderFactory` registration.
- `ProviderOAuthCredential.subscription.provider` records the issuer separately from its storage label. Only `resolve(..., { subscriptionProvider: 'github-copilot' })` obtains it. Generic consumers cannot flatten it into an ordinary API key; subscription consumers cannot resolve environment, command, API-key or generic OAuth records.
- `refreshToken` stores the durable GitHub grant. Refresh repeats Copilot exchange and catalogue retrieval, not a generic `refresh_token` POST. The inference token and expiry are distinct from the grant and model catalogue.
- Token-selected endpoints are restricted to Individual, Business and Enterprise Copilot tiers. An enterprise domain is explicit operator input, never authority inferred from token text.
- Discovery does not enable model policies. No implicit policy POST, subscription purchase or interactive login is allowed.
- `GITHUB_COPILOT_MODELS` contains 11 Messages, six Chat Completions and 18 Responses models. Immutable declarations and image limits do not establish entitlement, image preparation or complete output/context allocation. Raw API list prices are not exposed as subscription billing metadata.
- `isModelDiscoveryAuthoritative()` requires discovered account IDs for availability, including custom/configured entries. Default discovery retries are zero for these adapters. Ordinary providers retain their existing cache/retry behavior.
- Each inference turn resolves current local credentials and revalidates model/expiry/tier. The account catalogue is fetched during exchange/refresh, not remotely refetched for every prompt. External native-store withdrawal is observed; instant remote entitlement revocation is not promised.

## Critical Flows

### Standalone CLI login and inference

```text
ai-harness auth login github-copilot --issuer github-copilot
  -> reserve one-shot encrypted publication
  -> explicit device authorization and GitHub grant
  -> Copilot inference-token exchange and account catalogue
  -> compare generation/document revision; persist encrypted credential
  -> later CLI invocation constructs native provider from canonical label
  -> each turn resolves credential again and routes its actual model/API
```

`GITHUB_COPILOT_ENTERPRISE_DOMAIN` is optional explicit configuration. `AI_HARNESS_MASTER_KEY` is required for login/logout persistence. Arbitrary storage labels remain passive; only `github-copilot` is composed automatically. CLI offline startup disables refresh and does not advertise account models from a static fallback. The native interactive and emitted print/JSON/RPC fixture evidence below is separate from real-account and complete profile qualification.

`prepareOAuthLogin` returns a one-shot publisher. A later in-process mutation or **any** encrypted-document write rejects publication, including unrelated credential changes. This deliberately conservative document-wide check avoids adding durable per-provider tombstones. Even deleting an absent store key publishes a new encrypted document revision, so logout during first login cannot be lost. Cancellation after a write rolls back only that exact value; it cannot replace a newer writer's credential. The encrypted document format remains version 1 and files remain owner-only. This guard is wired to standalone Copilot login and the native Copilot branch of Server OAuth. Generic Server OAuth remains a separate path; it does not gain subscription authority.

### Interactive CLI and runtime lifetime

`/login <storage-label> --issuer github-copilot` uses the same explicit public client and guarded publisher. Equal-form issuer syntax is also accepted; naming a label `github-copilot` alone does not select this issuer. Encrypted storage is required before transport. The five-minute operation limit is shortened to the issuer's device lifetime. Caller cancellation reaches both response bodies and uncooperative pending fetch promises without replacing process-global fetch; late response bodies are abandoned. User codes altered by terminal formatting, UTF-8 or credential redaction are refused.

Successful canonical-label login makes the native provider available in the current registry, but retains the current selected provider/model. Other storage labels remain passive. Model selection remains explicit, and account/model-policy mutation is never part of login. Escape owns pending native login in both regular and fullscreen terminals. Runtime closure, replacement and parent shutdown retire subscription resolution/refresh; successful login does not bind future turns to the already-finished foreground login signal. Already committed login is removed by explicit logout, not remote revocation.

RPC now passes the subscription runtime to native provider composition, rather than only its ordinary credential map. An owned startup-refresh abort preserves SIGINT/SIGTERM disposition; unrelated initialization failures still fail. Normal EOF continues to drain accepted prompt work before runtime cleanup.

Owning command/client/runtime tests reuse the Core grant/catalogue boundaries. The same TLS/PTY probe is used for emitted and genuinely outside-checkout installed regular/fullscreen CLI: explicit login, held-catalogue Escape, native Responses inference/journal, logout and shutdown during a held subsequent login. Its installed print/JSON/RPC branches use standalone login, native Responses inference/journal and post-logout refusal without new vendor calls. A bounded overlapping privacy window checks all PTY bytes without retaining every fullscreen redraw. The existing standalone inference scenario separately covers emitted print/JSON/RPC; RPC additionally stops a held startup refresh without renewing the encrypted record. These journeys use disposable local TLS/vendor responses and one Responses model, not real GitHub consent, all-35-profile host coverage or complete A/C/R lifecycle qualification.

### Late transport response ownership

Cancellation also retires HTTP response bodies returned later by an uncooperative fetcher. Server device authorization/token polling and Core inference-token exchange/account discovery cancel those late bodies instead of retaining unread streams. This does not await the abandoned transport, publish credentials, retry, or change any deadline. The existing held-login fixture now checks all four stages; it previously checked withdrawal but not late stream release. Two additional device/exchange controls cover cancellation interleaved with promise settlement, so disposal and response ownership transfer use the same handler. See the [bounded follow-up](../../audit/pi/evidence/MOD-03-copilot-late-body.json) for four stage/two settlement RED cases, strict types and103 Core/service/HTTP cases. Earlier CLI/browser/production and failed full-root campaigns keep their original scopes; this follow-up does not rerun or repair them.

### Native protocol and continuation

The selected model routes to `/v1/messages?beta=true`, `/chat/completions` or `/responses`. All use Copilot Bearer/intent headers. Logical history determines initiator and vision before synthetic tool-image lowering. Both Core facades consume SSE, await callbacks and require successful protocol completion. Private-only redacted/signature/encrypted output is not a successful producer.

Exact facade/private delegate membership admits native replay; mutable labels, forged fields and subclasses do not. Ordered foreign visible thoughts survive as text without private fields. The continuation fixture preserves an explicit privacy divergence: Core omits a data-less `redacted_thinking` block emitted by the reference after expurgation. Across both facades, 738 continuation requests comprise **716 exact bodies and 22 deliberate omissions**, not 738 exact parity matches.

### Server composition

Startup prepares a canonical subscription resolver and checks runtime lifetime before proxy publication. Tokens never pass through `setApiKey`. Copilot is reserved against custom-provider namespace replacement. The catalogue rechecks local account discovery rather than retaining stale availability after failure. Legacy `/api/chat` reports late failure as an SSE error after HTTP 200, without a successful `message_end`.

`POST /api/provider-registry/auth/github-copilot/oauth` fixes the issuer to the native public client, independently of generic `AI_HARNESS_OAUTH_GITHUB_COPILOT_*` settings. It is a reserved subscription endpoint, not arbitrary-label issuer inference. The optional enterprise domain remains explicit server configuration. Encrypted storage is required before contacting GitHub. The service reserves a one-shot publication before the device request; starting a replacement login cancels the previous pending start/flow. Request disconnect before device metadata is returned withdraws that start. Once returned, the bounded flow is detached and uses the existing administrator-only poll/cancel routes.

The durable GitHub grant is exchanged for a separate inference token and account catalogue before publication. Native composition never calls `setApiKey`, changes selected providers or enables model policies. Cancellation, logout, expiry and runtime shutdown retire pending publication, including unpublished device requests and stalled catalogue responses. Startup and post-login resolvers borrow host/caller signals through passive refresh. Refresh now withdraws only its own exact durable publication when cancellation wins during the write; it never restores over logout or another writer.

The owning HTTP scenario starts without credentials, logs in through authenticated HTTP, then retains its two-generation A/C/R calls, Responses agent journal and external-withdrawal checks. Separate real HTTP logout/shutdown controls hold the first-login catalogue and verify a fresh server/store cannot recover the withdrawn login. Cancellation withdraws unpublished login; an already committed login is removed by explicit Disconnect, not implicit remote revocation. Local outbound vendor responses are fixtures; these are not live GitHub or browser sign-in evidence.

### Web Settings

The existing provider lifecycle pane uses the reserved native OAuth endpoint for Copilot. Each start/poll belongs to one cancellable operation. Cancel is available before the device response; replacing the login or retiring the mounted pane aborts request transport and cancels a known pending flow. Disconnect retires local polling before Server logout. Delayed old responses cannot restore the retired pane or publish an old canonical reload. Successful login performs a selection-bound canonical readback, not a provider/model-policy mutation.

`e2e/copilot-subscription-live.spec.ts` drives actual emitted Server/static Web and encrypted storage in EN/FR. Only outbound GitHub/Copilot responses are synthetic. It covers initial passive display, cancellation before a flow ID and during account discovery, encrypted login, preserved provider selection, reload, and logout while a real connected poll response is delayed at the browser boundary. Its release-check fixture is deliberately separate from subscription traffic. This is local browser evidence, not a real GitHub authorization, vendor entitlement, installed CLI or production-image certificate.

## Associated Tests and Evidence

- `packages/core/src/providers/github-copilot-oauth.test.ts`: bounded exchange, endpoint authority, cancellation and no policy mutation.
- `packages/core/src/providers/credential-lifecycle.test.ts`, `packages/core/src/security/credential-store.test.ts`: issuer isolation, refresh/logout/replacement and initial-publication concurrency.
- `packages/core/src/providers/github-copilot.test.ts`: immutable declarations, headers, route admission and metadata.
- `packages/core/src/providers/github-copilot-transport.test.ts`: 420 basic complete-body comparisons, continuation projections, terminal/callback/privacy and private-admission controls.
- `packages/cli/src/{security/oauth-device,providers/provider-runtime,cli/provider-auth-command}.test.ts`: device flow, native selection and actual emitted CLI login/inference/journal/logout, including another process logging out during a held first-login catalogue response.
- `packages/server/src/runtime/provider-oauth-copilot.test.ts`: explicit issuer, durable login, no API-key flattening, pending start/catalogue retirement and borrowed refresh lifetimes. Generic OAuth controls remain in `provider-oauth.test.ts`.
- `packages/server/src/{runtime/model-catalog,api/proxy,api/github-copilot-http}.test.ts`: account availability, actual HTTP login/routing, encrypted restart, administration refusal and withdrawal.
- [Routing fixture](../../../tests/fixtures/github-copilot-routing-reference.json) and [continuation fixture](../../../tests/fixtures/github-copilot-continuation-reference.json): independent pinned SDK execution, not live vendor entitlement.
- [Original source-bound receipt](../../audit/pi/evidence/MOD-03-copilot-subscription.json): original development selections, retained failures, final gate dispositions and source/full-mode identity.
- [Server/Settings increment](../../audit/pi/evidence/MOD-03-copilot-server-web.json): guarded native login/refresh, focused871/81 files/six strict roots (including all71 Web unit files), distinct emitted-Web EN/FR2 and separate production smoke. The earlier introduced i18n source-witness regression is corrected by preserving actual consumer lines; dictionaries, inventory and assertions are unchanged. The final root passes10,424 cases/533 files. The wider Settings selection on its earlier snapshot still fails64/1 with a new Playwright worker SIGSEGV; it is not covered by the earlier three-incident user waiver or repaired by the final Copilot-only browser pass. Full-gate/source boundaries and raw failures remain in that receipt. Counts from different selections must not be added into one campaign.

- [Interactive CLI increment](../../audit/pi/evidence/MOD-03-copilot-interactive-cli.json): workspace/parity types plus five focused strict test roots, owning158/six files, installed five-mode selection and full parity416. Separate production Node26 JSON login/inference/logout has five synthetic vendor responses. A new fullscreen failure was causally traced to `CERT_NOT_YET_VALID` before any issuer request; the local certificate helper backdates NotBefore without disabling verification or changing login/test deadlines. It is shared only by the encountered TLS fixtures, not introduced into production transport. The latest full root remains HOLD at10,447 PASS/2 FAIL/535 files: installed tool-selection V8 termination (PTY signal5) and an unchanged5000ms OpenRouter C timeout. Pre-TLS root10,446/3, generic HTTPS and earlier browser failures retain their own dispositions; neither later passes nor the historical waiver repair those measurements. Bounded identity checks cover20 source/fixture/toolchain paths and nine compiled outputs, not the whole build or package.

The original checkpoint's final development selection builds Core/CLI/Server, strictly checks 13 owning test roots and passes 284 tests. Its vendor fixtures are disposable local HTTPS or intercepted fetch; HTTP application requests and emitted CLI processes are distinct evidence. Prior native compiler failures and the broader nine-root/45-diagnostic hold remain unresolved. Canonical, installed, browser and production acceptance must be read from the receipt, not inferred from this focused pass.

## Common Changes

- To change routing or replay, update the independently acquired owner/API/model fixture and `github-copilot.ts` plus private delegate admission. Compare whole bodies; shared wire syntax grants no other-owner authority.
- To extend Web login, retain actual Server/browser separation and the operation-owned start/poll/cancel controls. Server/service fixtures alone do not establish browser acceptance. Never flatten subscription tokens or silently enable model policies.
- To add ChatGPT/Codex, independently qualify its account OAuth and dedicated `openai-codex-responses` transport. Do not relabel API-key OpenAI or borrow Copilot grants.

## Related Domains

- [Providers](./providers.md) — shared provider, streaming and metadata contracts.
- [Provider matrix](./provider-matrix.md) — pinned owner/API inventory and remaining gaps.
- [Security](./security.md) — credential privacy, administrator and persistence boundaries.
- [Sessions](./sessions.md) — durable provenance, opaque retention and guarded export.
