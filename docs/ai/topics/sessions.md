# Sessions, Persistence, and Compaction

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Sessions are the shared conversation record for CLI and Server. Core owns the runtime `Session` contract, JSONL v2 storage, branches/clones, effective model context, compaction, and JSON wire serialization.

Provider and tool turns described in [`providers.md`](./providers.md) are persisted incrementally. Web hydration and pagination must preserve the same IDs, dates, revisions, and branch relationships.

## Architecture

```text
SessionManager -> in-memory domain state
       |-> JsonlSessionStore -> ~/.ai-harness/sessions/<id>.jsonl
       |-> compaction policy -> effective model context
       `-> serializeSession -> JSON API/import-export boundary
```

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/types/index.ts` | `Session`, `Message`, blocks, usage, settings and schema version |
| `packages/core/src/sessions/session-manager.ts` | `SessionManager`, `JsonlSessionStore`, entries, forks, clones and summaries |
| `packages/core/src/sessions/serialization.ts` | Date hydration and provider-secret redaction at JSON boundaries |
| `packages/core/src/sessions/compaction.ts` | Token estimation, targets, prompts and automatic policy |
| `packages/server/src/api/session-pagination.ts` | Stable bounded `tail`, `before`, and `around` windows |
| `packages/web/src/store/session-store.ts` | API hydration, indexed windows, drafts and bounded browser cache |

## JSONL v2 Contract

Each line is one entry with a Unix-millisecond `timestamp`; v2 entries also carry `version: 2`.

| Entry | Purpose |
|---|---|
| `metadata` | Session identity, dates, workspace, branch, settings and cumulative usage |
| `message` | User/assistant/system/tool content, rich blocks, tool calls/results and usage |
| `command` | Shell command, output, exit state and context policy |
| `compaction` | Summary, first retained entry, token estimate and metrics |
| `branch_summary` | Named summary attached to branch navigation |

Legacy unversioned message-only JSONL remains readable. Runtime dates are `Date`; API/import-export dates are ISO strings; persisted entry dates are numbers. `serializeSession()` does not write JSONL—it converts a whole session for JSON transport.

## Critical Flows

### Create and append

```text
SessionManager.create -> JsonlSessionStore.saveSession(metadata + initial entries)
SessionManager.addMessage -> JsonlSessionStore.appendMessage -> update memory/events
SessionManager.addCommand -> JsonlSessionStore.appendCommand -> update memory/events
```

Await every write before reporting success. `JsonlSessionStore` validates session IDs and writes files with restrictive permissions.

### Effective context and compaction

1. Resolve manual or inherited automatic policy.
2. Estimate the effective entries and select a safe compaction target.
3. Ask the configured provider for a summary under the run AbortSignal.
4. Append a `compaction` entry only after successful completion.
5. Recompute effective context and emit metrics/sequenced events.

Cancellation must not apply a partial summary. Compaction entries remain in the journal while replaced messages disappear only from effective model context.

### Fork versus clone

| Operation | Result |
|---|---|
| Fork | Copies through a selected message and keeps `parentId` plus branch lineage. |
| Clone | Creates an independent root, clears branch lineage, and records `metadata.clonedFromSessionId`. |

### Web windows

Lists return metadata rather than full histories. Session state starts with a bounded tail; older or target messages use stable `before`/`around` cursors. Export is generated server-side from the full session. See [`server-api.md`](./server-api.md) for the HTTP surfaces.

## Invariants

- Redact provider secrets before disk or API serialization.
- Round-trip rich blocks, tool metadata, usage/cost, workspace/agent metadata, settings, and branches.
- Keep message IDs stable across JSONL, API windows, SSE replay, and Web reconciliation.
- Use `SessionManager` for domain mutations; do not mutate its internal maps.
- Treat IDs, imported JSON, cursors, and persisted legacy entries as untrusted input.

## Associated Tests

- `packages/core/src/sessions/session-manager.test.ts` — JSONL, IDs, writes, branches, clones and context
- `packages/core/src/sessions/serialization.test.ts` — dates, rich data, redaction and legacy files
- `packages/core/src/sessions/compaction.test.ts` — estimates, policy and compaction targets
- `packages/server/src/api/session-pagination.test.ts` — bounded stable windows
- `packages/server/src/web-server.test.ts` — session HTTP, persistence, import/export and cascade behavior
- `packages/web/src/store/session-store.test.ts` and `e2e/sessions.spec.ts` — hydration and browser lifecycle

## Common Changes

### Change the persisted schema

Update shared types, entry validation/read/write paths, manager mutations, serializers, API hydration, Web store/fixtures, imports/exports, and a legacy compatibility test together.

### Change compaction

Update Core policy and AgentRuntime integration, then test manual/automatic cancellation, metrics, persistence, event replay, and canonical Web resynchronization.

### Change branches or pagination

Update manager lineage, fixed-route ordering, server pagination, browser cursors/windows, full export, and deep-link/scroll tests.

## Related Domains

- [`providers.md`](./providers.md) — summary and conversation model calls
- [`server-api.md`](./server-api.md) — session, agent state and event endpoints
- [`web-app-architecture.md`](./web-app-architecture.md) — hydration, caching and virtual history
- [`security.md`](./security.md) — redaction and path validation
