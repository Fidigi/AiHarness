# Model Dispatch Policies

> **Navigation:** See [`project-map.md`](../project-map.md) for package boundaries and Docker validation.

## Overview

Core separates selectable virtual chat models from their physical provider requests and owns a session-local prompt-cache warmer. These are native APIs following the approved Pi 1.2.0 policy, not a Pi extension ABI or full provider-parity certificate. MOD-04 native routing delivery is tracked separately from open MOD-05 and whole-platform qualification in `docs/audit/pi/AUDIT-5.md`.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/providers/virtual-models.ts` | Validated definitions, catalogue overlays, physical resolution, branch state and witnessed missing-router fallback |
| `packages/core/src/providers/provider-model-metadata.ts` | Sanitized optional adapter-owned physical declarations; undeclared sources retain legacy published lookup |
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

Router state uses bounded `provider.router_state` custom entries keyed to the virtual provider/model; it is not model input. Read active ancestry, not arbitrary full history. Returning the copied state persists it even when the router edited that copy in place. Registration replacement/disposal retires an exact generation. Revalidate generation, active ancestry/context, physical provider instance and nonrecursive selection after awaited before-hooks/authorization and before dispatch; stale routing admission is terminal, not a reason to replay old input. Custom-type names are conventions, not isolation from privileged extensions.

Resolve physical metadata from the actual adapter's optional `getPublishedModels()` declaration, not an operator alias. An absent declaration retains legacy lookup; an empty/invalid authoritative declaration cannot borrow another catalogue. Known physical context limits constrain the virtual declaration and explicit host ceiling. Session-specific limits never replace another session's default; useful compaction precedes dispatch. Clamp explicit/virtual output caps to the physical maximum while preserving omitted native defaults. Physical thinking, text-only image omission and tool-definition exclusion apply again after hooks, without rewriting history. A post-hook physical model redirection refuses. Unknown metadata is not vendor/media admission.

On a physical provider/model change, keep public assistant text/images/tool calls but remove foreign reasoning and private metadata/replay. Same-physical input remains intact for the owning adapter's native replay policy. Routing never manufactures signed/encrypted reasoning or credentials. Native transport/default/media/replay support remains owned by the physical adapter and its MOD-01/MOD-03 qualification, not by the router's declaration.

`resolveVirtualModelFallback` uses only the latest successful assistant on owned active ancestry whose saved `metadata.selection` matches the requested virtual selection. If that router is missing, resolve the witnessed physical provider/model through current host instances; recheck branch, registration, credential availability and cancellation after awaits. Failed output, other selections/branches, recursion and unavailable credentials never grant fallback. CLI/RPC implicit startup and terminal session switches warn; startup and both terminal/RPC switches save the physical selection. Recovery overrides an unavailable saved default but never an explicit startup model/provider. Detached/SDK prompts retain logical provenance while dispatching physically; absent request models use the session model, or the witnessed logical default when no model was saved. Web restores the latest successful assistant's logical provider when its saved selection matches the current model, including after router unload; an environment-locked provider or changed model remains authoritative.

Child agents reuse the same loop with fresh child-local state, never the parent's private router state. Server legacy SSE aliases, direct JSON adapter calls and tool-free summaries route through the same registry without session-state/warming authority. Their usage and optional terminal provider/model identify physical work; ordinary non-routed legacy framing is unchanged. Completed transports and visible output cannot trigger another routed paid attempt. Failed visible Core/RPC output is stored under its physical identity.

[IMPORTANT] Fallback never loads missing extension code, discovers models or selects another account. Installed and real HTTP/browser controls below establish native routing boundaries only; exact execution receipts and independent provider/platform gaps remain in AUDIT-5.

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
- `packages/core/src/providers/virtual-model-admission.test.ts`: post-hook physical metadata/output/media/tools/replay, in-place private state, stale/credential/branch/cancel fallback refusals, real OpenAI/Anthropic wire and failed/completed transport authority.
- `packages/cli/src/cli/virtual-model-process.test.ts`, `virtual-model-resume-process.test.ts`, `packages/cli/src/commands/handler.test.ts`: emitted print/JSON/RPC routing, missing-router resume over an unavailable saved default, terminal session switching, saved physical selection and a subsequent restart.
- `packages/server/src/api/virtual-model-http.test.ts`: authenticated legacy SSE/summary and JSON adapter routing, delegated child-state separation, detached missing-router resume, privacy and physical usage attribution.
- `tests/functional-parity/installed-executable.test.ts`: genuinely packed/installed virtual declarations, physical runtime identity, direct-state exclusion and non-context warming/accounting.
- `packages/server/src/api/cache-notices-http.test.ts`, `packages/web/src/store/session-store.integration.test.ts`: real authenticated branch/page/clone/snapshot/privacy/global-only controls and deduplicated page/hide/replacement projection.
- `packages/cli/src/tui/cache-notices.test.ts`, `packages/cli/src/cli/cache-notices-process.test.ts`, `e2e/model-cache-live.spec.ts`: both emitted terminal renderers, real static Web/API routing/history, reload/network reconnect/branches/global hiding, real routed browser continuation after unload and unchanged passive request counts in EN/light desktop and FR/dark mobile.
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
