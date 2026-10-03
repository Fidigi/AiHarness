# Child Agents

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Child agents delegate a bounded task to the shared `AgentRuntime` under a reusable global/project profile. Each run creates a persisted child session linked to its parent; the in-memory run registry provides progress, stop, result, and attention state.

Child execution reuses session, provider, tool, trust, extension, and cancellation contracts. See [`sessions.md`](./sessions.md) for lineage and [`extensions.md`](./extensions.md) for the built-in `spawn_subagent` tool.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/types/index.ts` | `SubagentProfile`, configuration and public run snapshot contracts |
| `packages/server/src/runtime/subagent-service.ts` | Built-ins, validation, scoped CRUD and atomic `subagents.json` persistence |
| `packages/server/src/runtime/subagent-runtime.ts` | Child sessions, limits, AgentRuntime bridge and parent events |
| `packages/server/src/api/subagent-routes.ts` | Settings, profile and run HTTP routes |
| `packages/server/src/runtime/services.ts` | `spawn_subagent` tool registration and sync/background result behavior |
| `packages/web/src/components/SubagentSettings.tsx` | Scoped settings and profile administration |
| `packages/web/src/components/{SubagentPanel,SubagentMonitor}.tsx` | Per-session runs and global attention UI |

## Profile Contract

A profile contains identity/instructions plus optional model and thinking overrides, `maxTurns`, context/background flags, and tool/skill/extension allowlists. Empty allowlists inherit the parent runtime policy; non-empty lists can only reduce it.

| Bound | Value |
|---|---:|
| Profiles per stored scope | 50 |
| Process-wide concurrent active runs | Configurable 1–16; default 4 |
| Tool rounds per profile | 1–32 |
| Task length | 100,000 characters |
| Inherited context | Latest 40 messages and at most 120,000 content characters |
| Retained run snapshots | 200, evicting oldest terminal runs |

Built-ins are `explore`, `general`, and `plan`. They can be edited/duplicated but not deleted. Stored configuration has global defaults and full project overrides keyed by canonical workspace ID; project access resolves cwd and rejects mismatched IDs.

## Delegation Depth

A root session has depth 0. It may create children at depths 1, 2, and 3. A session already at depth 3 cannot delegate again, and `spawn_subagent` is removed from the depth-3 child tool set. This is three child levels, not a `0–2` limit.

## Critical Run Flow

```text
spawn_subagent(profile, task, background?)
  -> resolve parent/project context and scoped configuration
  -> validate engine, profile, global concurrency and parent depth
  -> create persisted child session with parentId/branchId/parentAgentId
  -> optionally copy bounded inherited messages with metadata marker
  -> AgentRuntime.start enforces trust, prompt, max rounds and reduced allowlists
  -> map child journal phases/turns to parent subagent.* events
```

The child inherits cwd/workspace/Git branch and parent model/thinking/tool preset unless the profile overrides them. Auto-compaction is disabled for the child. Inherited messages receive new `inherited:*` IDs and `metadata.inheritedFromSession`; they are context, not new parent messages.

For synchronous execution, the tool waits under the parent AbortSignal and returns the last non-inherited assistant message. For background execution, it returns run and child-session IDs immediately. Aborting synchronous work stops the child.

## Parent Events and Attention

| Event | Meaning |
|---|---|
| `subagent.started` | AgentRuntime accepted the child run |
| `subagent.updated` | Phase/turn changed, or an active run was stopped |
| `subagent.completed` | Child reached the completed phase |
| `subagent.failed` | Startup or terminal execution failed; terminal stopped completion also maps here |

Snapshots carry status, phase, turn/maxTurns, timestamps, output/error, and attention. Completion/failure/stopping sets attention until acknowledged. Persisted child sessions survive restart; the run snapshot registry does not.

## HTTP Contract

All routes are mounted at `/api/subagents`.

| Method | Path | Purpose |
|---|---|---|
| `GET`, `PATCH` | `/settings` | Resolve or mutate engine/concurrency settings |
| `GET`, `POST` | `/profiles` | Resolve catalogue or create a profile |
| `PATCH`, `DELETE` | `/profiles/:profileId` | Update or delete a profile |
| `POST` | `/profiles/:profileId/duplicate` | Duplicate as a custom profile |
| `GET`, `POST` | `/runs` | List (optionally by parent) or start a run |
| `GET` | `/runs/:runId` | Read one in-memory snapshot |
| `POST` | `/runs/:runId/stop` | Stop active execution |
| `POST` | `/runs/:runId/acknowledge` | Clear attention |

Profile/settings mutations require `configuration`; the router itself is behind normal API authentication. Starting a run resolves the parent’s effective tool preset and returns HTTP 202.

## Associated Tests

- `packages/server/src/runtime/subagent-service.test.ts` — defaults, scopes, persistence and validation
- `packages/server/src/runtime/subagent-runtime.test.ts` — inheritance, lineage, events, depth, concurrency and stop
- `packages/server/src/web-server.test.ts` — HTTP capabilities, profiles and real child execution
- `packages/web/src/services/api.test.ts` — browser route contracts
- `e2e/settings.spec.ts` — profile/settings administration
- `e2e/chat.spec.ts` and `e2e/visual.spec.ts` — child monitoring and responsive surfaces

## Common Changes

### Change a profile field or limit

Update Core types, service validation/storage compatibility, routes/API client, Settings form, runtime consumption, fixtures and service/runtime tests.

### Change child execution

Keep `AgentRuntime` as the engine. Test parent cancellation, allowlist reduction, depth-3 tool removal, inherited context bounds, persistence, events, attention and synchronous/background results.

### Change run transport or UI

Update Core event/snapshot types, parent journal publication, state/SSE parsing, panels/notices, reconnect behavior, accessibility and visual cases together.

## Related Domains

- [`sessions.md`](./sessions.md) — persisted parent/child lineage and inherited messages
- [`server-api.md`](./server-api.md) — auth, detached runtime and SSE
- [`extensions.md`](./extensions.md) — built-in tool registration and reduced extension policy
- [`security.md`](./security.md) — canonical trusted workspace execution
