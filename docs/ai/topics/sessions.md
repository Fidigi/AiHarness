# Sessions, Persistence, and Compaction

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Sessions are the shared conversation record for CLI and Server. Core owns the runtime `Session` contract, the custom JSONL v2 journal, active/abandoned branches, forks/clones, effective model context, compaction, and JSON wire serialization.

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
| `message` | User/assistant/system/tool content, rich blocks, tool calls/results, parent and normalized usage |
| `command` | Shell command, parent, output, exit state and context policy |
| `compaction` | Parent, summary, first retained entry, token estimate, provider/model and summary-generation usage |
| `branch_summary` | Named summary with a durable parent in the entry tree |

Legacy unversioned message-only JSONL remains readable. Runtime dates are `Date`; API/import-export dates are ISO strings; persisted entry dates are numbers. `serializeSession()` does not write JSONL—it converts a whole session for JSON transport. This remains an AiHarness v2 format, not Pi v3, even though RPC can project its entries into a Pi-shaped tree.

## Critical Flows

### Create and append

```text
SessionManager.create -> JsonlSessionStore.saveSession(metadata + initial entries)
SessionManager.addMessage -> append with active parent -> advance leaf -> update memory/events
SessionManager.addCommand -> append command -> advance leaf -> update memory/events
SessionManager.getRawEntries -> complete journal, including pre-compaction and abandoned entries
```

The manager maintains the same journal semantics in process memory under `--no-session`. Saving metadata merges known entries without deleting durable descendants, although v2 metadata updates still rewrite the custom file rather than providing Pi's canonical append-only v3 format. Await every write before reporting success. `JsonlSessionStore` validates IDs, opens only regular non-symlink files, and forces owner-only permissions.

CLI and RPC choose storage in this order: an explicit `--session <path>` parent, `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, legacy `AI_HARNESS_SESSIONS_DIR`, merged Pi `sessionDir`, then `~/.ai-harness/sessions`. Project `sessionDir` is the only `.pi/settings.json` field read before trust. `--no-session` bypasses the store regardless of the resolved directory.

### Effective context and compaction

1. Resolve manual or inherited automatic policy.
2. Estimate the effective entries and select a safe compaction target.
3. Ask the configured provider for a summary under the run AbortSignal.
4. Append a `compaction` entry only after successful completion, including its parent and summary-call provider/model/usage when available.
5. Recompute effective context and emit metrics/sequenced events.

Cancellation must not apply a partial summary. Compaction entries remain in the journal while replaced messages disappear only from effective model context. CLI and RPC initialize Core policy from Pi `compaction.enabled`, `reserveTokens`, `keepRecentTokens`, and exact `modelOverrides["provider/model"]`; the policy is resolved for the startup model and currently requires restart after settings or model changes. `branchSummary` settings are validated but branch-summary generation is not yet wired to them.

### Fork versus clone

| Operation | Result |
|---|---|
| RPC in-place fork | Moves `activeLeafId` to immediately before a selected active-path user entry; the next append creates a sibling while abandoned descendants remain in the same durable journal. |
| Startup/copy fork | Creates a related session from a selected durable path for flows that require a separate file. |
| Clone | Creates an independent root, remaps active message/command IDs and internal parents, clears branch lineage, and records `metadata.clonedFromSessionId`. |

Raw RPC entries/tree include all retained branches; normal messages, fork candidates, and effective context follow only the active parent chain. Branch summaries and compactions also advance that chain. The format is still v2, so labels, clone handling for every custom entry, and unmodified Pi SDK interoperability remain incomplete.

### Web windows

Lists return metadata rather than full histories. Session state starts with a bounded tail; older or target messages use stable `before`/`around` cursors. Export is generated server-side from the full session. See [`server-api.md`](./server-api.md) for the HTTP surfaces.

## Invariants

- Redact provider secrets before disk or API serialization.
- Round-trip rich blocks, tool metadata, normalized usage/cost, compaction usage, workspace/agent metadata, settings, and parent links.
- Keep message IDs stable across JSONL, API windows, SSE replay, and Web reconciliation.
- Use `SessionManager` for domain mutations; do not mutate its internal maps.
- Treat IDs, imported JSON, cursors, and persisted legacy entries as untrusted input; validate finite non-negative usage fields and never follow a session-file symlink.

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
