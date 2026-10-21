# Model Dispatch Policies

> **Navigation:** See [`project-map.md`](../project-map.md) for package boundaries and Docker validation.

## Overview

Core separates selectable virtual chat models from their physical provider requests and owns a session-local prompt-cache warmer. These are native APIs following the approved Pi 1.2.0 policy, not a Pi extension ABI or full provider-parity certificate. MOD-04/MOD-05 acceptance remains open in `docs/audit/pi/AUDIT-5.md`.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/providers/virtual-models.ts` | Validated model definitions, selectable catalogue overlays, physical resolution and branch router state |
| `packages/core/src/agent/provider-turn.ts` | Virtual versus physical dispatch, retry reasons, physical limits and cache eligibility |
| `packages/core/src/providers/cache-warmer.ts` | Timing, economics, replay, cancellation and durable usage |
| `packages/core/src/providers/cache-notices.ts` | Stable derived warming/miss notices, independent of visibility or billable work |
| `packages/cli/src/tui/cache-notices.ts`, `packages/web/src/components/{CacheNotices,CacheNoticeSettings}.tsx` | Historical terminal/browser presentation and server-global Web visibility |
| `packages/server/src/api/session-pagination.ts`, `packages/server/src/api/agent-routes.ts` | Active-ancestry, page/snapshot-filtered notice DTOs without private receipts |
| `packages/core/src/extensions/extension-registry.ts` | `registerVirtualModel`, direct routed `chat`, decision hooks and warmer cleanup |
| `packages/core/src/sessions/session-manager.ts` | Parent-linked custom receipts/state and optional session-specific compaction windows |
| `packages/core/src/sessions/session-accounting.ts` | Actual warming requests counted separately from assistant messages |
| `packages/cli/src/{index,commands/handler,rpc/rpc-controller,rpc/rpc-server}.ts` | Startup selection, routing and direct summary adapters; `/session` warming status |
| `packages/server/src/runtime/{services,model-catalog}.ts` | Physical credential instances and virtual catalogue composition |

## Public Contracts and Invariants

### Virtual selections

`ExtensionAPI.registerVirtualModel(definition)` registers a bounded provider/id, optional display name, input capabilities, thinking levels and declared context/output limits plus `route(request)`. The route receives copied model context, selection thinking, reason (`user`, `continuation`, `retry`, `direct`), prior failed physical selection and private branch state. Return a physical `{ provider, id, thinkingLevel?, state? }`; current host provider availability is authoritative. Credentials are never supplied to the router.

`VirtualModelRegistry` overlays catalogue entries with source `virtual`. Selection-only provider instances cannot physically chat. `ExtensionRegistry.chat` explicitly routes direct summary work without reading or writing branch state. Shared ordinary turns preserve the virtual selection in `ChatResponse.selection`, but `provider`, `model`, `thinkingLevel` and persisted assistant accounting identify physical work.

Router state uses bounded `provider.router_state` custom entries keyed to the virtual provider/model; it is not model input. Read active ancestry, not arbitrary full history. Registration replacement/disposal retires an exact generation. Revalidate generation, active ancestry/context, physical provider instance and nonrecursive selection after awaited before-hooks/authorization and before dispatch; stale routing admission is terminal, not a reason to replay old input. Custom-type names are conventions, not isolation from privileged extensions.

Known physical context limits constrain the declared selection and cannot expand an explicit host context ceiling. Session-specific compaction limits do not replace another session's manager default. Compact before dispatch when a useful admitted cut is available. Reasoning clamps against physical capabilities. Known text-only physical models receive image-omission placeholders without rewriting stored messages. A post-hook model redirection from a routed physical ID refuses rather than silently borrowing its limits. Unknown physical metadata is not vendor/media admission.

[IMPORTANT] Resume fallback when a router is missing, complete child-agent/legacy-chat composition and signed reasoning replay are not established. Installed public routing and real HTTP/browser physical-provenance controls are named below; execution receipts remain separate in AUDIT-5.

### Prompt cache policy

`cacheWarming` is `off | streaming | idle`, default `streaming`. CLI/RPC and detached Server runs compose already trusted agent settings. `streaming` stops at agent settlement; successful `idle` may continue afterward. Abort/failure, disabled mode, changed context/model, unavailable/replaced physical provider, extension unload and shutdown retire work. A selected mode is not a credential grant.

Only explicitly eligible published physical models with known prompt-cache lifetime and pricing are considered. Current short-lifetime metadata is limited to GPT-4o and Claude Sonnet 4.6; absent/none retention, virtual routing and extension model redirection do not warm. Other model names or an API-compatible endpoint do not establish cache support. Long-retention automatic warming is not currently qualified. Anthropic chat/stream use one last-message ephemeral breakpoint by default; `ChatOptions.cacheRetention: 'none'` omits it and `long` requests the one-hour wire TTL explicitly.

- Schedule at `min(90% TTL, TTL − 10 seconds)`; TTL at most ten seconds is ineligible.
- Require at least $0.05 expected net saving; continuation probability is 1 while streaming and 0.15 while idle.
- Bound the economic prompt estimate by the captured canonical prefix and observed usage; a compacted small prefix cannot inherit old large-request economics. Unknown media provides no automatic economic estimate.
- Stop at 60 minutes streaming or 30 minutes idle from the last real request. Warming never extends that horizon; late refreshes refuse.
- Replay the owned request with `maxTokens: 1`, `maxRetries: 0`, no output publication and no tool execution. Recheck authorization, context, cancellation and deadline after asynchronous decision work.

`before:cache:warm` receives the economic decision and signal; only `action: 'warm' | 'stop'` controls the result. Hook failure falls back to economics. A different action is an explicit extension override, recorded with usage. Economics and time horizons are not a global monetary cap.

[WARNING] Warming is potentially billable. `showCacheMissNotices: false` hides presentation only; it never disables the scheduler, changes usage or grants/revokes credentials.

CLI composes its trusted agent/project setting (default true) when seeding history and at idle prompt boundaries. Both terminal hosts omit notices if owned ancestry is unavailable and otherwise retain bounded inert historical notices; regular output cannot erase earlier printed lines after a visibility change. Print/JSON/RPC framing remains unchanged. No warming request is started by viewing history.

Web's independent administrator-owned `config.json` global boolean defaults to true. Provider Settings → Prompt cache controls it for all browser clients; project/session writes refuse, and `null` resets the default. Authenticated session GET/message pages and canonical agent snapshots return only derived notices anchored to their visible message IDs plus the visibility flag, never router state or raw receipts. If complete owned ancestry is unavailable (for example inherited child references), omit auxiliary notices rather than fail history reads or guess from a raw journal; Core routing/state reads remain strict. The store merges page notices by anchor and discards hidden/replaced anchors. A view reload/reconnect fetches current preference/history. Current clients do not receive an immediate cross-tab settings broadcast. Optional accounting/notice presentation loads only with messages, preserving the eager bundle budget and existing time/token/cost labels.

## Critical Flows

1. Resolve selection through the current registry and host credential instances; persist allowed router state, then admit physical context and dispatch. Re-route retryable pre-output failures with `failed`; never replay after visible output or a final observer failure.
2. Capture eligible physical request input before transport; schedule without delaying the foreground turn. The scheduler retains its authentic cancellation signal and owned copies, not mutable extension payloads.
3. Account completed warm calls as `provider.cache_warm` custom receipts, even when their owner is cancelled after completion. Keep an abandoned receipt on its original branch without moving a newer leaf; compatible current ancestry may advance to its own receipt. Usage enters session totals, never model context. Host usage-observer failure does not erase durable billing; asynchronous observer promises are observed but not joined. Uncooperative decision/authorization callbacks lose publication authority on abort without blocking foreground settlement.
4. `getCacheTranscriptNotices` derives stable IDs from already selected journal ancestry, resets comparison at summaries/compaction and deduplicates replayed entry IDs. The caller must select the correct ancestry and apply UI preference; this function performs no rendering or background request.

## Associated Tests

- `packages/core/src/providers/virtual-models.test.ts`: provenance, branch state, navigation/compaction/copies, generation retirement, credential/recursion refusal, retry, direct summaries, physical compaction and catalogues.
- `packages/cli/src/cli/virtual-model-process.test.ts`: actual emitted print/JSON/RPC startup, physical transport and durable selection/state.
- `tests/functional-parity/installed-executable.test.ts`: genuinely packed/installed virtual declarations, physical runtime identity, direct-state exclusion and non-context warming/accounting.
- `packages/server/src/api/cache-notices-http.test.ts`, `packages/web/src/store/session-store.integration.test.ts`: real authenticated branch/page/clone/snapshot/privacy/global-only controls and deduplicated page/hide/replacement projection.
- `packages/cli/src/tui/cache-notices.test.ts`, `packages/cli/src/cli/cache-notices-process.test.ts`, `e2e/model-cache-live.spec.ts`: both emitted terminal renderers, real static Web/API routing/history, reload/network reconnect/branches/global hiding and unchanged request counts in EN/light desktop and FR/dark mobile.
- `packages/core/src/providers/cache-warmer.test.ts`: economics, owned replay, deadlines/horizons, modes, authorization, cancellation, usage observers and abandoned branches.
- `packages/core/src/providers/cache-notices.test.ts`: significant miss derivation, stable replay and passive usage validation.
- `packages/core/src/sessions/session-accounting.test.ts`: non-message usage totals, memory/durable reload and independent clone without model-context pollution.
- `packages/core/src/providers/anthropic-thinking.test.ts`: actual loopback chat/stream cache-retention payloads alongside reasoning dialects.
- Existing Core provider-output/request guards and CLI/RPC/HTTP compaction lifecycle tests remain separate regression controls. Test presence is not a successful execution receipt; consult AUDIT-5.

## Common Changes

- Add a cache-eligible model only in `providers/model-metadata.ts` after checking actual native cache markers, minimum output/replay constraints, TTL and short/long pricing. Extend real-wire tests, not merely catalogue entries.
- Change routing in `providers/virtual-models.ts` and `agent/provider-turn.ts` together. Preserve current credential/generation checks, direct-call state exclusion, branch persistence and physical accounting; exercise emitted host paths.
- Change notice presentation through `api/session-pagination.ts`, Web `store/session-store.ts`/`components/CacheNotices.tsx` and CLI `tui/cache-notices.ts` together. Preserve global-only Web authority, branch/page/reconnect ownership and actual browser/terminal controls. Do not append notices as assistant or custom model-visible messages.

## Related Domains

- [`providers.md`](./providers.md) — native transports, credentials and request admission
- [`provider-matrix.md`](./provider-matrix.md) — pinned catalogue/auth gaps and configuration boundaries
- [`sessions.md`](./sessions.md) — journal ancestry, accounting and compaction
- [`extensions.md`](./extensions.md) — registration lifecycle and privileged code ownership
