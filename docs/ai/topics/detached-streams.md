# Detached Stream Reconstruction and Reply Evidence

> **Navigation:** See [`project-map.md`](../project-map.md) for package boundaries and Docker validation.

## Overview

Core owns provider/tool execution, journal identity and durable evidence. Server owns the detached SSE delivery buffer. Web owns projections and optional controls, never execution, accounting or persisted context. These are native AiHarness contracts, not a foreign wire compatibility layer.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/agent/runtime.ts` | Per-turn message identity, complete text/reasoning checkpoints, failed visible output and authoritative compaction phase |
| `packages/core/src/agent/tool-loop.ts` | Assistant/tool persistence and provider-declared length evidence |
| `packages/core/src/providers/index.ts` | Optional `ChatResponse.stopReason: 'length'` normalization in built-in chat/stream adapters |
| `packages/server/src/api/{sse-channel,agent-event-policy,agent-routes}.ts` | Bounded opt-in buffer, narrowly authorized replacement and detached route wiring |
| `packages/web/src/store/session-store.ts` | Detached JSON/Date DTO admission for sessions, message pages and runs, retaining existing sequence/identity guards |
| `packages/web/src/components/ChatView.tsx`, `packages/web/src/components/{process-turns,scroll-restoration,history-reading}.ts` | Chat consumption and presentation ownership |
| `packages/web/src/components/{ProcessBlockBoundary,ProcessBlock,AnsiOutput}.tsx` | Stable native disclosure, optional actions/ANSI/path rendering and local failed-import containment |
| `packages/web/src/components/reply-messages.ts` | Feature-owned EN/FR notices; conserved global/Settings dictionaries are unchanged |

## Public Contracts and Invariants

### SSE replacement

`SseChannel` keeps legacy fail-closed behavior unless its third argument enables buffering. Only detached agent event routes enable it and pass `agentEventPolicy(event)`.

- Keep the 1 MiB raw/redacted event and 4 MiB pending-byte limits; add at most 256 queued frames and a 30-second blocked-drain deadline.
- A `write(false)` frame is already accepted by Node. Replace only subsequent, not-yet-written queued frames; do not mutate already delivered history.
- Coalesce complete running v1 outer-tool snapshots by session/run/tool ID. Preserve nested code-mode records, starts, terminal records, UI and arbitrary producer events.
- Remove queued text/reasoning deltas only when a complete string-content checkpoint identifies the same session/run/message. Absent/foreign identities grant no replacement.
- Append replacements at their real sequence positions. Gaps are intentional; received sequence IDs remain increasing.
- Heartbeats cannot bypass or renew the blocked deadline. Drain, close, finish and failure release queue/timer/listener resources.
- Irrecoverable size/count/deadline failure closes the channel; reconnect uses the existing journal/reset/authoritative snapshot protocol, not invented terminal success.

### Provider and failure evidence

Built-in OpenAI-compatible, Responses, Anthropic, Gemini and Bedrock chat/stream adapters normalize only explicit provider exhaustion reasons. Never infer length exhaustion from prose. Persist `metadata.stopReason: 'length'`, including an empty exhausted assistant reply; unrelated finishes omit it.

Each provider attempt has one stream message ID. Complete text/reasoning checkpoints cover intermediate tool turns and final turns. This stream identity is not a promise that its temporary ID equals the eventual persisted entry ID; terminal canonical reconciliation remains necessary.

On a non-aborted provider failure after visible text/reasoning delivery, persist that scrubbed partial reply with `metadata.outputError` bounded to 4,000 characters. Do not publish successful completion or invent usage. No-visible-output and user-aborted failures do not manufacture error replies. Failure-evidence persistence skips automatic compaction: recording an upstream error must not initiate another model request or replace retained context. Provider retry/delivery bounds remain owned by `provider-turn.ts`.

Trusted SessionManager compaction lifecycle publication sets the active run's authoritative phase to `compacting`, restores `prompting` after completion/failure, and advances its journal watermark. Aborted/terminal runs cannot be revived by late lifecycle events; terminal session-scoped events still omit `runId`. Captured old tool callbacks retain their old run identity.

### Browser normalization and projections

Accepted JSON/Date sessions, paged rich messages and run snapshots become store-owned deep copies. Preserve rich blocks, inputs, commands, metadata, queued prompts, ordered schemas, parented nested calls and usage without child promotion or duplicate billing. Copy only data DTOs, not callback/guard authority. Existing private canonical witnesses, retirement history, session/run/version and full-address lifetimes still govern admission.

`processTurns()` uses loaded order, including a mid-turn page head. User/system boundaries, final assistant answers and known history gaps split groups. A final-answer ID keys disclosure remounting when the answer appears/disappears. Grouping never changes provider context or accounting. Only the first row presents a group header; continuation headers keep their geometry but are invisible and `aria-hidden`.

Keep native Process disclosures mounted while optional children load/fail, preserving opening and focus intent. Pending text remains bounded; failed imports retain native full output and a local bilingual status. Failed ESM imports stay failed until an explicit page reload; chat/composer/Stop are not suspended. File discovery/actions and ANSI parsing remain optional. Image preparation is separately imported only on attachment selection.

Adjacent durable reply notes show length/error evidence. Only the latest exhausted assistant reply offers the existing explicit Compact context action. Authoritative `compacting` phase also disables Send after cold reload while leaving policy and cancellation reachable; preserve draft text.

`restoreWhileOwned()` bounds settling to ten frames and 120/300/600 ms deadlines by default; pagination uses that same bounded window so late virtual measurements are not abandoned after the former 120 ms-only lease. Virtual measurements and viewport resizing can adjust offsets without user intent, so changed layout geometry retains the lease. Wheel/touch/pointer/keyboard intent, a different offset without changed geometry, a detached root or disposal permanently retires it and releases listeners/timers. Chat also retires it on session/cwd/hash replacement and explicit message/latest navigation. Never use late restoration to overwrite newer scrolling or a replacement view.

Unread presentation counts loaded entries after the last observed tail ID, not growth in the loaded window. Earlier/overlapping pages cannot invent new output; genuine appended entries still count across prepends. A missing/retired tail supplies no unread evidence. This is browser-local presentation, never persisted read status or session accounting.

## Critical Flows

1. Provider delta → identified complete checkpoint → queued-delta replacement → guarded Web consumption → canonical terminal session read.
2. Outer tool progress → complete active snapshot → selective queued coalescing → latest state replay → durable terminal result; nested records remain inside their parent.
3. Actual automatic summary → trusted lifecycle → authoritative compaction snapshot → cold Web reload → reachable policy/Stop → Core abort and durable terminal resync.
4. JSON API/page/run → guarded admission → deep-owned state → presentation-only process grouping → stable native disclosure with optional children.

## Associated Tests

- `packages/server/src/api/agent-event-backpressure.test.ts` and `sse-channel.test.ts` — blocked drain, event/count/byte/deadline cleanup, exact-identity replacement, lifecycle/nested preservation and legacy behavior.
- `packages/core/src/agent/reply-checkpoints.test.ts` — intermediate/final identity, real JSONL reload, empty length, scrubbed partial failure, compaction phase/watermark, reentrant publication and cancellation negatives.
- `packages/core/src/providers/length-stop.test.ts` — real local upstream chat/stream exhaustion and non-exhaustion normalization across built-in dialects.
- `packages/web/src/store/server-client-normalization.test.ts` — native serialization/hydration, detached rich/page/run ownership, nested usage and stale sequence rejection.
- `packages/web/src/components/process-turns.test.ts`, `scroll-restoration.test.ts`, `history-reading.test.ts` and `reply-messages.test.ts` — mid-turn/gap/final ownership, source conservation, bounded retired layout work, historical-versus-appended entries and EN/FR fallback.
- `e2e/tool-progress.spec.ts` under its production-preview config — genuine disk extensions/Core/Express with deterministic upstream only: live/snapshot/terminal/reload, concurrent approval replacement/close/Stop/rebuild/attention, durable length/error, optional control faults/focus/opening and actual automatic-compaction cancellation. Historical captures remain unchanged.
- `e2e/visual.spec.ts` and `sessions.spec.ts` — one native history-control reveal followed by a real pointer click, strict before/after anchor conservation, unchanged responsive captures and gap/navigation/reload regression coverage; older pages cannot become unread output. Avoid a second locator-triggered reveal between measuring the anchor and clicking: Chromium can move the root by its padding before pointerdown, outside the pagination operation.
- `e2e/interaction-queue.spec.ts`, `interaction-admission.spec.ts`, `queue-reconciliation.spec.ts` and `interaction-live-boundary.spec.ts` — adjacent ordered presentation, browser-local callback fences and real HTTP schema validation; see [Web architecture](./web-app-architecture.md).

## Common Changes

### Change replacement semantics

Update the Core checkpoint producer, `agent-event-policy.ts`, channel bounds and guarded browser consumer together. Add foreign/missing identity, nested/lifecycle preservation and original-source controls. Never broaden generic transport replacement from producer text alone.

### Change visible evidence or process controls

Update Core persistence/explicit provider reasons, `ChatView`, the loaded-order projection and optional boundary together. Exercise cold canonical pages, empty replies, failed chunks, user-open/focus conservation and unchanged bundle/capture budgets. Keep partial output distinct from successful usage.

User guidance: [English](../../users/en/web-replies.md) and [French](../../users/fr/web-replies.md).

## Related Domains

- [`server-api.md`](./server-api.md) — routes, permissions and transports
- [`web-app-architecture.md`](./web-app-architecture.md) — view lifetimes, history and optional assets
- [`sessions.md`](./sessions.md) — JSONL, compaction and pagination
- [`providers.md`](./providers.md) — upstream protocols, delivery and redaction
- [`extensions.md`](./extensions.md) — ordered host-owned interaction capabilities
