# Subscription Providers

> **Navigation:** See [`project-map.md`](../project-map.md) for ownership and Docker validation.

## Overview

GitHub Copilot has a bounded native subscription implementation, distinct from API-key OpenAI, Anthropic and Google. It does **not** complete MOD-03 or the subscription-provider scope. ChatGPT/Codex remains unimplemented; a Copilot model whose name contains `codex` does not implement ChatGPT authentication.

[IMPORTANT] Server OAuth login and Web Settings integration are not delivered. Server composition can consume an existing native encrypted subscription credential. Do not advertise a working browser sign-in flow or infer live account entitlement from the synthetic fixtures.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/providers/github-copilot-oauth.ts` | Explicit public-client configuration, durable GitHub grant exchange, restricted inference endpoint and account catalogue |
| `packages/core/src/providers/github-copilot.ts` | Immutable 35-model declarations, account intersection, A/C/R headers and request lowering |
| `packages/core/src/providers/index.ts` | Public `GitHubCopilotProvider`, private protocol delegates and exact native-replay admission |
| `packages/core/src/providers/credentials.ts` | Explicit subscription selector, issuer-bound refresh, one-shot OAuth publication and redaction |
| `packages/core/src/security/credential-store.ts` | Encrypted persistence, document revision and atomic compare-and-set |
| `packages/core/src/providers/model-catalog.ts` | Account-authoritative availability without published/custom fallback grants |
| `packages/cli/src/cli/provider-auth-command.ts`, `packages/cli/src/security/oauth-device.ts` | Explicit standalone device login and guarded Copilot credential publication |
| `packages/cli/src/providers/{provider-runtime,configured-providers}.ts` | Native canonical-label composition with a fresh credential resolver |
| `packages/server/src/runtime/github-copilot.ts`, `packages/server/src/api/proxy.ts` | Existing-credential composition, legacy streaming and detached agent access |
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

`GITHUB_COPILOT_ENTERPRISE_DOMAIN` is optional explicit configuration. `AI_HARNESS_MASTER_KEY` is required for login/logout persistence. Arbitrary storage labels remain passive; only `github-copilot` is composed automatically. CLI offline startup disables refresh and does not advertise account models from a static fallback. Interactive `/login` and actual subscription print/RPC journeys remain separately unqualified.

`prepareOAuthLogin` returns a one-shot publisher. A later in-process mutation or **any** encrypted-document write rejects publication, including unrelated credential changes. This deliberately conservative document-wide check avoids adding durable per-provider tombstones. Even deleting an absent store key publishes a new encrypted document revision, so logout during first login cannot be lost. Cancellation after a write rolls back only that exact value; it cannot replace a newer writer's credential. The encrypted document format remains version 1 and files remain owner-only. This guard is wired to standalone Copilot login, not the existing generic Server OAuth service.

### Native protocol and continuation

The selected model routes to `/v1/messages?beta=true`, `/chat/completions` or `/responses`. All use Copilot Bearer/intent headers. Logical history determines initiator and vision before synthetic tool-image lowering. Both Core facades consume SSE, await callbacks and require successful protocol completion. Private-only redacted/signature/encrypted output is not a successful producer.

Exact facade/private delegate membership admits native replay; mutable labels, forged fields and subclasses do not. Ordered foreign visible thoughts survive as text without private fields. The continuation fixture preserves an explicit privacy divergence: Core omits a data-less `redacted_thinking` block emitted by the reference after expurgation. Across both facades, 738 continuation requests comprise **716 exact bodies and 22 deliberate omissions**, not 738 exact parity matches.

### Server composition

Startup prepares a canonical subscription resolver and checks runtime lifetime before proxy publication. Tokens never pass through `setApiKey`. Copilot is reserved against custom-provider namespace replacement. The catalogue rechecks local account discovery rather than retaining stale availability after failure. Legacy `/api/chat` reports late failure as an SSE error after HTTP 200, without a successful `message_end`.

Existing-credential HTTP tests cover two server generations, A/C/R legacy calls, one Responses agent journal and external withdrawal. Auth descriptors identify OAuth, but `provider-oauth.ts` does not yet support Copilot login. Web Settings is not qualified by these HTTP tests.

## Associated Tests and Evidence

- `packages/core/src/providers/github-copilot-oauth.test.ts`: bounded exchange, endpoint authority, cancellation and no policy mutation.
- `packages/core/src/providers/credential-lifecycle.test.ts`, `packages/core/src/security/credential-store.test.ts`: issuer isolation, refresh/logout/replacement and initial-publication concurrency.
- `packages/core/src/providers/github-copilot.test.ts`: immutable declarations, headers, route admission and metadata.
- `packages/core/src/providers/github-copilot-transport.test.ts`: 420 basic complete-body comparisons, continuation projections, terminal/callback/privacy and private-admission controls.
- `packages/cli/src/{security/oauth-device,providers/provider-runtime,cli/provider-auth-command}.test.ts`: device flow, native selection and actual emitted CLI login/inference/journal/logout, including another process logging out during a held first-login catalogue response.
- `packages/server/src/{runtime/model-catalog,api/proxy,api/github-copilot-http}.test.ts`: account availability, actual HTTP routing, encrypted restart, administration refusal and disconnect.
- [Routing fixture](../../../tests/fixtures/github-copilot-routing-reference.json) and [continuation fixture](../../../tests/fixtures/github-copilot-continuation-reference.json): independent pinned SDK execution, not live vendor entitlement.
- [Source-bound receipt](../../audit/pi/evidence/MOD-03-copilot-subscription.json): development selections, retained failures, final gate dispositions and source/full-mode identity. Counts from different selections must not be added into one campaign.

The final development selection builds Core/CLI/Server, strictly checks 13 owning test roots and passes 284 tests. Its vendor fixtures are disposable local HTTPS or intercepted fetch; HTTP application requests and emitted CLI processes are distinct evidence. Prior native compiler failures and the broader nine-root/45-diagnostic hold remain unresolved. Canonical, installed, browser and production acceptance must be read from the receipt, not inferred from this focused pass.

## Common Changes

- To change routing or replay, update the independently acquired owner/API/model fixture and `github-copilot.ts` plus private delegate admission. Compare whole bodies; shared wire syntax grants no other-owner authority.
- To finish Server/Web login, compose the explicit issuer exchange and guarded publication in `runtime/provider-oauth.ts`, revalidate flow/runtime lifetime and add actual HTTP/browser controls. Never flatten subscription tokens or silently enable model policies.
- To add ChatGPT/Codex, independently qualify its account OAuth and dedicated `openai-codex-responses` transport. Do not relabel API-key OpenAI or borrow Copilot grants.

## Related Domains

- [Providers](./providers.md) — shared provider, streaming and metadata contracts.
- [Provider matrix](./provider-matrix.md) — pinned owner/API inventory and remaining gaps.
- [Security](./security.md) — credential privacy, administrator and persistence boundaries.
- [Sessions](./sessions.md) — durable provenance, opaque retention and guarded export.
