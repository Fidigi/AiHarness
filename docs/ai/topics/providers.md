# AI Providers and Models

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Providers normalize chat, streaming, reasoning, tool calls, images, discovery, retries, and usage across built-in and extension-defined backends. Core owns provider execution and non-secret published model metadata; Server owns credentials, catalogue merging, custom providers/models, OAuth, and usage persistence.

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
| `packages/core/src/providers/index.ts` | `AiProvider`, factory, built-ins, discovery, streaming, retry, usage normalization |
| `packages/core/src/providers/model-metadata.ts` | Versioned shared published capabilities, context/output limits, prices and conservative inference |
| `packages/core/src/config/agent-settings.ts` | Agent startup model/scope/thinking and compaction/retry setting resolution |
| `packages/core/src/types/index.ts` | `ProviderConfig`, shared model/custom-provider contracts and capabilities |
| `packages/server/src/api/proxy.ts` | Built-in configuration, legacy chat paths, usage/cost persistence |
| `packages/server/src/runtime/model-catalog.ts` | Merge of Core published metadata, discovery and custom model definitions |
| `packages/server/src/runtime/provider-registry.ts` | Custom provider/model state and secret separation |
| `packages/server/src/runtime/provider-oauth.ts` | OAuth Device Flow lifecycle |
| `packages/server/src/api/{model,provider-registry}-routes.ts` | Catalogue, activation, OAuth and custom resource HTTP routes |

## Public Contracts

- `AiProvider.chat()` returns one normalized `ChatResponse`.
- `AiProvider.streamChat()` emits incremental text/reasoning/tool events, awaits each `StreamChunkCallback`, and completes once. Built-ins provide producer backpressure; the shared turn rejects extension providers that overrun its bounded pending-event/byte queue instead of awaiting callbacks.
- `AiProvider.getAvailableModels()` returns bounded discovered identifiers when supported.
- `ChatOptions.signal` carries cancellation; tools, thinking, model and retry options remain optional.
- `ProviderFactory` creates OpenAI/Azure, Anthropic, Gemini/Vertex, Bedrock, local OpenAI-compatible, mock, and registered extension providers.
- `ModelCatalogEntry` distinguishes `published`, `discovered`, `configured`, and `custom` sources with availability, capabilities, compatibility, context/output limits, and optional cache-aware pricing.

Published non-secret metadata lives in Core so CLI and Web use the same descriptors. Explicit thinking maps define supported levels (`null` means unsupported), while unknown models use conservative capabilities and remain unpriced. RPC caches and deduplicates live model discovery briefly, and can resolve CLI model-scope globs for cycling. Server alone merges live/custom state and owns credentials. Provider secrets stay in `CredentialStore`, encrypted custom-provider storage, or process memory; catalogue and RPC model objects are non-secret.

CLI and RPC layer explicit flags over agent settings `defaultProvider`, `defaultModel`, `enabledModels`, `defaultThinkingLevel`, and exact `modelThinkingLevels["provider/model"]`. A saved default inside the enabled scope is preferred; scope suffixes and explicit flags remain stronger, and the final level is capability-clamped. Agent-level retry settings configure shared turn retries. Provider transport, proxy, idle timeout and `retry.provider` values are validated and diagnosed but are not yet wired to provider clients.

## Critical Flows

### Runtime request

```text
before:provider hook
  -> provider.streamChat(messages, callbacks, options.signal)
  -> awaited, bounded deltas/tool calls
  -> cache-aware normalized usage (uncached input + cache read/write + output)
  -> shared tool loop and message persistence
  -> cost only when provider or published catalogue pricing is authoritative
```

### Catalogue refresh

1. `ModelCatalog` starts with versioned published entries.
2. Configured providers perform bounded discovery where supported.
3. `ProviderRegistry` contributes custom providers and models.
4. Enabled qualified IDs (`provider:model`) are resolved by global/project scope.
5. Web receives metadata only; discovery failure retains safe catalogue entries.

### Add a provider

1. Add the Core implementation and factory mapping.
2. Add Server configuration, credentials, discovery/OAuth, and proxy handling as applicable.
3. Update CLI command/RPC initialization and Web settings/catalogue behavior.
4. Export public Core contracts from `packages/core/src/index.ts`.
5. Test streaming completion, cancellation, malformed remote data, secrets, and usage.

## Associated Tests

- `packages/core/src/providers/{index,model-metadata}.test.ts` and `packages/cli/src/agent/provider-turn.test.ts` — built-ins, awaited/bounded streaming, tools, images, reasoning, discovery, metadata, usage/cost and cancellation
- `packages/server/src/runtime/model-catalog.test.ts` — catalogue merge, capabilities, pricing and refresh bounds
- `packages/server/src/runtime/provider-registry.test.ts` — custom lifecycle and secret separation
- `packages/server/src/runtime/provider-oauth.test.ts` — OAuth flow lifecycle
- `packages/server/src/web-server.test.ts` — HTTP configuration, credentials and provider integration
- `packages/web/src/services/api.test.ts` and `e2e/settings.spec.ts` — browser contracts and settings flow

Never use real credentials or external network calls in tests.

## Common Changes

### Change model metadata

Update `packages/core/src/providers/model-metadata.ts`, then verify the Server merge, CLI RPC descriptors/thinking levels, activation, capability filtering, prices, usage, API serialization, and Web selectors.

### Change streaming

Update the Core provider and shared tool loop expectations. Preserve incremental chunks, one final assembly, AbortSignal propagation, reasoning/tool events, and no double completion. Await every chunk callback; consumer delivery errors are terminal and must not be retried, while a non-cooperative extension producer must fail through the bounded queue guard.

### Change provider administration

Update registry/service/routes, `packages/web/src/services/api.ts`, Settings UI, security capability tests, and secret-redaction coverage together.

## Related Domains

- [`sessions.md`](./sessions.md) — message persistence and usage round trips
- [`extensions.md`](./extensions.md) — provider registration and `before:provider`
- [`server-api.md`](./server-api.md) — model and registry routes
- [`security.md`](./security.md) — credentials and non-secret diagnostics
