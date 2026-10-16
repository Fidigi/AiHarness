# Sessions, Persistence, and Compaction

> **Navigation:** See [`project-map.md`](../project-map.md) for repository boundaries and Docker validation.

## Overview

Effective provider context orders known message/command/summary/custom ancestry before wall-clock time. This prevents queued turns from moving ahead of their parents after a clock regression; unlinked legacy roots retain chronological fallback. Command projections retain their parent and original-ID alias, including after durable reload.

Sessions are the shared conversation record for CLI and Server. Core owns the runtime `Session` contract, the custom JSONL v2 journal, active/abandoned branches, forks/clones, effective model context, compaction, and JSON wire serialization. The persisted v2 marker is independent from `AI_HARNESS_CORE_API_VERSION`; advancing one does not silently advance the other.

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
| `packages/core/src/sessions/{session-context,branch-summarization,provider-branch-summarizer,session-custom-data}.ts` | Parent-based context, explicit bounded navigation summaries, tool-free provider adapter and bounded own custom JSON |
| `packages/core/src/sessions/serialization.ts` | Date hydration and provider-secret redaction at JSON boundaries |
| `packages/core/src/sessions/compaction.ts` | Token estimation, targets, prompts and automatic policy |
| `packages/server/src/api/session-pagination.ts` | Stable bounded `tail`, `before`, and `around` windows |
| `packages/web/src/store/session-store.ts` | API hydration, indexed windows, drafts and bounded browser cache |

## JSONL v2 Contract

Each line is one entry with a Unix-millisecond `timestamp`; v2 entries also carry `version: 2`. The manager advances newly appended message timestamps monotonically so context order survives coarse or backward-moving wall clocks.

| Entry | Purpose |
|---|---|
| `metadata` | Session identity, dates, workspace, branch, settings and cumulative usage |
| `message` | User/assistant/system/tool content, rich blocks, tool calls/results, parent and normalized usage |
| `command` | Shell command, parent, output, exit state and context policy |
| `compaction` | Parent, summary, first retained entry, token estimate, provider/model and summary-generation usage |
| `branch_summary` | Named summary with a durable parent, optional source provenance `fromEntryId` and summary-call provider/model/normalized usage |
| `custom` | Parented `customType` and optional bounded own JSON `data`, excluded from model context |
| `custom_message` | Parented `customType`/`content`/`display`, optional private `details`; content enters model context even when display is false |

Legacy unversioned message-only JSONL remains readable. Runtime dates are `Date`; API/import-export dates are ISO strings; persisted entry dates are numbers. `serializeSession()` does not write JSONL—it converts a whole session for JSON transport. Its public `redactProviderConfig` helper also backs JSON hydration and JSONL persistence: nested credential-like fields are omitted, safe data descriptors are copied with depth/node/collection/key limits, and getters, executable `toJSON`, cycles and unsupported values cannot become persisted provider metadata. This is field-based filtering; registered credential-value redaction and caller ownership remain separate. This remains an AiHarness v2 format; RPC tree responses are transport projections rather than the persisted representation.

## Critical Flows

### Create and append

```text
SessionManager.create -> JsonlSessionStore.saveSession(metadata + initial entries)
SessionManager.addMessage -> append with active parent -> advance leaf -> update memory/events
SessionManager.addCommand -> append command -> advance leaf -> update memory/events
SessionManager.getRawEntries -> complete journal, including pre-compaction and abandoned entries
```

The manager maintains the same journal semantics in process memory under `--no-session`. Saving metadata merges known entries without deleting durable descendants, although v2 metadata updates still rewrite the file rather than using an append-only metadata revision. Rewrites use owner-only exclusive staging, `fsync`, atomic rename and directory synchronization. Appends, rewrites and deletes share a bounded per-session heartbeat lock across cooperating processes, so a metadata save cannot discard a concurrent append. Await every write before reporting success.

`JsonlSessionStore` limits IDs to 256 bytes, each file to 64 MiB and inventory to 10,000 files. It creates a private `0700` directory without traversing symbolic-link components, opens only stable UTF-8 regular files with one link, checks inode/device/size/timestamps around reads, and forces files to `0600`. Inventory uses the shared bounded stable-directory handle/listing and deterministic O(n log n) ordering.

CLI and RPC choose storage in this order: an explicit `--session <path>` parent, `--session-dir`, `AI_HARNESS_SESSIONS_DIR`, merged agent setting `sessionDir`, then `~/.ai-harness/sessions`. Project `sessionDir` participates only after project trust resolves; no project settings body is read before trust. `--no-session` bypasses the store regardless of the resolved directory.

### Effective context and compaction

1. Resolve manual or inherited automatic policy.
2. Estimate the effective entries and select a safe compaction target.
3. Ask the configured provider for a summary under the run AbortSignal.
4. Append a `compaction` entry only after successful completion, including its parent and summary-call provider/model/usage when available.
5. Recompute effective context and emit metrics/sequenced events.

Cancellation must not apply a partial summary. Compaction entries remain in the journal while replaced messages disappear only from effective model context. CLI and RPC initialize Core policy from agent settings `compaction.enabled`, `reserveTokens`, `keepRecentTokens`, and exact `modelOverrides["provider/model"]`; the policy is resolved at startup and refreshed after interactive `/model` (including cycling), `/provider` and `/reload`, RPC `set_model`/`cycle_model`, and RPC `switch_session`. Each resolution starts from the current trusted settings snapshot, so leaving a model override restores inherited/default thresholds rather than retaining the prior model's values. Session `autoCompaction: false` remains authoritative. CLI/RPC use the selected published context window, or a 128,000-token fallback for non-mock providers, and require `estimateContextTokens(id) > window - reserveTokens` before applying the existing minimum-entry/safe-cut checks. `keepRecentTokens` controls retention, not the model-window trigger. Mock/unspecified lower-level hosts retain legacy policy. Estimates remain message/context heuristics, not full system/tool payload tokenization; fallback limits are not authoritative vendor metadata. Overflow recovery and new compaction hooks remain separate. Navigation uses `branchSummary.reserveTokens`; `skipPrompt: true` chooses no summary by default, never automatic provider authority.

RPC `reload_context_settings` accepts only `type` and optional `id`. At idle it passively reloads bounded global/trusted-project files with fresh trust and startup-pinned source directories, then publishes only `compaction`/`branchSummary`. The correlated data is `{cancelled:false,reloaded:["compaction","branchSummary"]}`; cancellation returns `{cancelled:true,reloaded:[]}`. Any loader diagnostic refuses publication and retains prior policy. Session opt-out, selected provider/model, thinking budgets, executable generations and the selected session directory remain unchanged; restart for other RPC file settings. `get_state.autoCompactionEnabled` reports the effective global-and-session decision. Pending preparation permits safe reads/abort but excludes competing foreground requests. Abort/EOF/close withdraw unpublished preparation, including non-cooperative late callbacks; an already published synchronous host decision is not rollback. Prepared callbacks are privileged host integrations, not a sandbox.

Automatic compaction captures its process-local session identity, active leaf, enable/reserve/keep settings, optional host-supplied model window and callback/policy identities before awaiting inherited policy. It rechecks admission after that wait, after start observers, after summarization and inside the session mutation queue before starting persistence. An abort-ignoring late summary, replaced session/callback, changed branch or revoked local policy cannot publish a compaction entry or success event at those boundaries. Checks rejected before `compaction:start` emit no lifecycle; checks rejected afterward settle through the existing `compaction:error` event (`cancelled: true` only for abort). Admission is registered before policy/start callbacks can reenter without awaiting their own check, and is released after settlement. Do not await the admitted check from its own policy/start callback: that creates a self-wait. Metadata-only title updates and equivalent settings refreshes do not invalidate it.

This is not a cross-process compare-and-swap, an inherited-policy watcher or a transaction over arbitrary custom history mutations. Once persistence has been admitted, cancellation does not roll back that write; its successful durable result still receives the completion event. Non-cooperative callbacks/stores can delay settlement. Manual `applyCompaction` retains its existing caller-owned boundary contract.

### Fork versus clone

| Operation | Result |
|---|---|
| RPC in-place fork | Moves `activeLeafId` to immediately before a selected active-path user entry; the next append creates a sibling while abandoned descendants remain in the same durable journal. |
| Startup/copy fork | Creates a related session from a selected path, preserving stable message/command/custom/summary IDs and required private state. Durable-user forks can target pre-compaction history; indexed forks retain the current-message projection. |
| Clone | Creates an independent root, remaps required active message/command/custom/summary/compaction IDs and ancestry, clears branch lineage, and records `metadata.clonedFromSessionId`. |

Web can fork or clone an explicitly targeted persisted message while its source agent continues; the copy uses a serialized snapshot and does not move or stop the source. Core `forkSession`/`cloneSession` accept stable message IDs alongside legacy numeric positions and resolve IDs against that same serialized snapshot, so a concurrent compaction cannot silently change the selected message. A removed target fails without creating a copy; HTTP returns `409 MESSAGE_TARGET_CHANGED`. Full-source copies during a run require an explicit target; unwritten stream IDs and prefixes containing running commands are refused. `PATCH activeLeafId` remains locked until the source run is idle. Web history edits are staged locally: only Send creates a related session via `POST /api/sessions/:id/fork` with `{messageId, before: true}`. Core's `forkSessionAtEntry(..., {before: true})` copies ancestors but omits that user message, including the empty-prefix case. Cancel, navigation and reload cannot create or move a branch. No persisted schema changes are needed.

A message-targeted clone retains the command ancestors needed by every copied message and remaps their internal parents before persistence. Command inclusion follows parent IDs, not wall-clock order: a future-dated ancestor stays included, while a backdated descendant or unlinked command is not copied into the prefix. Excluded-from-context flags survive. Required running ancestors are refused before creation, including those dated after the target; the existing conservative timestamp-based running-command refusal also remains. Full clones retain their existing command-copy policy. Core captures the session and raw journal under the same process-local mutation admission, follows parent IDs through branch-summary nodes, and copies only summaries required by retained messages/commands or the full clone's active leaf. Fresh summary IDs replace message/command parents, summary parents, summary-only active leaves and the cloned `metadata.branchSummaries` projection; later/unlinked summaries stay out of a targeted prefix, including metadata. Summary timestamps, names and bodies are retained regardless of clock skew. A future-dated running command behind a summary is refused before creation. The summaries join the existing create-only atomic write before memory/listener/create-event publication, and volatile journals retain the same entries; failure publishes no clone. More than 1,024 required additional summary/custom/compaction entries is refused before creation, preserving the store's additional-entry bound and existing metadata/file limits. Clone now also retains active custom state/messages and compaction boundaries with fresh ancestry, without reviving a compacted prefix. Arbitrary IDs inside custom data and external source provenance are not rewritten. No public creation argument or new schema major is introduced. Related forks now reuse this rich copy path with stable IDs and lineage, including required private/custom ancestry and selected compaction context. Labels, exhaustive fork lifecycle hooks, arbitrary payload references, extension summary hooks and cross-process snapshot isolation remain separate.

Raw RPC entries/tree include all retained branches; normal messages, fork candidates, and effective context follow only the active parent chain. Branch summaries, custom entries/messages and compactions advance that chain. The format remains v2; labels and arbitrary custom-data reference rewriting are not added.

### Active extension state

CLI startup ID/prefix/file forks delegate to the shared Core copy engine rather than reconstructing projected messages. `SessionForkOptions` captures own destination ID/cwd/workspace overrides and optional native `sourceStore` before awaiting; explicit undefined workspace clears inheritance. `JsonlSessionStore.getSessionSnapshot(id)` returns one stable bounded owned `{session,entries}` without rewriting its source. Entries are raw history, not an active path. Foreign sources are not imported into the destination manager; writes use only its store. Source lineage/settings and required private/custom/compaction/summary ancestry survive; incomplete sources/duplicate destinations fail before publication. A changed target store withdraws unpublished work, not already-admitted writes. Existing no-session startup precedence, API1/schema2 and retained-file/1,024-extra-entry limits remain.

`await SessionManager.getActiveBranchEntries(id)` serializes a manager/journal/leaf read and returns an owned parent-first active path. It includes private state outside the compacted model window, not abandoned branches or summary-source provenance. Last append projection wins per ID, independent of regressing timestamps. Missing/cyclic ancestry and a host store/leaf replacement while awaiting refuse publication; missing/invalid session identities return an empty path without coercion. The view is bounded by the existing64MiB session-file contract, not a cross-process CAS or atomic read-modify-write transaction.

Extensions restore a conventionally named custom type from the last matching active entry. Custom type names confer no ownership, and private state/details are not secret storage. Interactive executable generations and process restart preserve durable journal state; closure variables restart. Memory-only sessions do not survive process exit. RPC disk edits do not reload executable factories; the separate context-settings command reloads no code. Core `session-active-entries.test.ts`, CLI `extension-session-state-process.test.ts` and installed declarations/PATH-bin controls own this contract; see [extensions](./extensions.md#session-state-and-active-ancestry).

### Optional navigation summaries

`SessionManager.navigateTree(sessionId, entryId, options?)` selects an exact existing entry. Only `summarize: true` authorizes the supplied `BranchSummarizer`; a callback alone grants nothing. `createProviderBranchSummarizer` adapts the current configured provider with no tools/discovery and preserves measured provider/model/usage. Only the abandoned suffix after the common ancestor contributes; no-op and ancestor-to-descendant moves generate nothing. Input admission uses conservative UTF-8 byte-derived estimates plus framing space, whole recent entries and a context/reserve budget (defaults 128,000/16,384). Provider output is capped at 4,096 tokens or half the reserve, and retained generated bytes are separately bounded by that reserve. Missing targets, invalid budgets, incomplete/empty/tool-call responses and persistence failure cannot publish a summary.

Generation runs outside the mutation queue. Before one durable publication, Core checks the signal, session identity and exact session/journal snapshot again; concurrent changes return `stale`. `cancelled` withdraws unpublished navigation, not an already admitted write. Results also include `navigated`/`not-found`. This is process-local admission, not cross-process compare-and-swap. Host callbacks/providers/stores are privileged, and non-cooperation can delay settlement.

The summary becomes the destination's child and the new active leaf; `fromEntryId` records provenance only. Context follows actual parents, the latest active compaction and later summaries, never abandoned source links. Custom state/details remain outside model input; `display: false` affects UI, not custom content. Orphan tool results and unanswered declarations are removed; partial groups retain only answered calls on the selected path. A bounded legacy prefix identity prevents later intentional roots from borrowing old history. An own bounded `aiHarnessLegacyCompactionPrefix` metadata record anchors metadata-only legacy compaction background to its original ancestor, survives reload and later compaction, and remaps when that ancestor is cloned; it cannot lend the old summary to an independent root. Prefix capture before compaction remains before write admission and rechecks cancellation after its legacy journal read. Built-in stores cache exact admitted redacted journal bytes; structural SDK stores retain their full journal without needing a filesystem path.

CLI `/navigate` lists the latest 128 safe entry identities. With a target it requires `--summarize` or `--no-summary` unless `skipPrompt` chooses no summary; optional `--instructions "focus"` requires explicit summary authority. RPC `navigate_tree` uses strict `entryId`, `summarize`, `customInstructions` and `replaceInstructions` fields. Foreground mutation exclusion, Esc/Ctrl-C/abort and terminal EOF/close cancellation cover admission as well as registered generation. The high-level SDK facade does not expose navigation or custom append methods.

### Journal statistics

Core `sessions/session-accounting.ts` owns `getSessionAccounting(rawEntries, activeLeafId?)`, reused by CLI `/session`, regular/fullscreen status and RPC statistics. Active means durable ancestors including pre-compaction work; history means every retained branch. Counts distinguish messages/commands from summaries. `requests` counts accountable entries, not each nested network call. Missing/cyclic/duplicate active ancestry is explicitly incomplete. Repeated logical IDs retain the last append-order projection once, not a second billable entry, and mark history partial as well. Actual model-visible context remains `estimateContextTokens`, never an accounting-token sum.

Only assistant/summary entries and outer tool usage participate in accounting; user/system/metadata/progress/nested detail usage cannot manufacture billing. Persisted cost wins; a published calculation needs the historical entry's explicit provider/model and input/output counters. Unattributed/custom models remain unpriced. Incomplete codemode costs remain unknown/partial despite a known outer subtotal. Missing counters are not authoritative zero; legacy RPC numeric fields remain compatible while opt-in accounting exposes missing/partial measurements. Token sums saturate at the safe-integer bound and mark partial; unrepresentable cost records are excluded from the known subtotal.

`BranchSummaryAccounting` adds optional copied provider/model/usage arguments to `SessionManager.addBranchSummary` and `JsonlSessionStore.appendBranchSummary`; own accessors/invalid counters are refused before mutation. Existing v2 summaries load without migration and remain unpriced when measurements are absent. Reload, memory projections and clones retain the additive fields. Those accounting parameters grant no provider authority; optional generation uses the separate explicit navigation operation above.

### Web windows

Lists return metadata rather than full histories. Session state starts with a bounded tail; older or target messages use stable `before`/`around` cursors. Export is generated server-side from the full session. See [`server-api.md`](./server-api.md) for the HTTP surfaces.

## Invariants

- Redact provider, tool, extension and shell content before disk or API serialization; stateful redactors join credentials split across chunks.
- After credentials are discovered late, reload and atomically rewrite legacy JSONL so raw and encoded historical values do not survive on disk.
- Round-trip rich blocks, tool metadata, normalized usage/cost, compaction usage, workspace/agent metadata, settings, and parent links.
- Keep message IDs stable across JSONL, API windows, SSE replay, and Web reconciliation.
- Use `SessionManager` for domain mutations; do not mutate its internal maps.
- Treat IDs, imported JSON, cursors, and persisted legacy entries as untrusted input; validate finite non-negative usage fields and never follow a session-file symlink.

## Associated Tests

- `packages/core/src/sessions/session-manager.test.ts` — JSONL, IDs, 64 MiB/inventory/path bounds, stable reads, atomic rewrites, concurrent independent-store append/save locking, redaction, branches, clones and context
- `packages/core/src/sessions/session-accounting.test.ts` — journal/active scopes, unknown/zero/partial costs, nested authority, historic pricing, path failures, summary admission/snapshot/reload/clone and bounded totals
- `packages/core/src/sessions/session-navigation{,-contracts,-budgets,-legacy,-ordering}.test.ts` — optional generation, owned/private custom context, tools/compaction/legacy ancestry, stale/cancelled/failed publication, Unicode/input/output bounds, borrowed stores, rich clones and parent-before-clock ordering
- `packages/cli/src/{commands,rpc}/session-navigation.test.ts` — explicit choice/protocol authority, foreground admission and pre-registration EOF/close retirement
- `packages/cli/src/cli/session-navigation-{process,pty}.test.ts` — actual CLI/local HTTP provider requests, abort/EOF, six regular/fullscreen terminal scenarios; installed consumer also compiles declarations and uses the PATH bin
- `packages/cli/src/{commands/session-management,rpc/session-statistics,cli/session-statistics-process}.test.ts` — actual management/statistics adapters, correlated opt-in versus legacy RPC, and both actual terminal renderers
- `packages/core/src/sessions/session-clone-prefix.test.ts` — durable/volatile prefix command ancestry, stable/numeric targets, clock skew, ID remapping, source-byte conservation and unchanged full-clone/running-command refusals
- `packages/core/src/sessions/session-clone-summaries.test.ts` — 14 durable/volatile full/prefix summary-parent remapping, fresh summary leaves, direct message parents, reload/source conservation, ancestor-running refusal, create-only publication/failure and unchanged 1,024-entry cap controls
- `packages/core/src/sessions/provider-config-redaction.test.ts` — shared JSON/JSONL credential field policy, nested descriptor isolation, getter/callback refusal, cycles, opaque inputs and unchanged bounds
- `packages/core/src/sessions/serialization.test.ts` — dates, rich data, redaction and legacy files
- `packages/core/src/sessions/compaction.test.ts` — estimates, policy and compaction targets
- `packages/core/src/sessions/compaction-context.test.ts` — optional scalar host limits, strict model-minus-reserve boundary, stale-window checks and legacy/API-shape conservation
- `packages/cli/src/rpc/{compaction-context-boundary,context-settings-reload,context-settings-lifecycle}.test.ts` — published window/reserve controls, scoped reload, effective disable, admission, accessors, abort/EOF/close and pending-navigation exclusion
- `packages/cli/src/cli/context-settings-process.test.ts` — eleven actual CLI/local-provider scenarios across print/JSON/RPC, passive trusted reload, exact overrides, live branch reserve, persistence and cancellation; installed consumers also exercise the PATH bin and genuine NodeNext declarations
- `packages/core/src/sessions/session-compaction-admission.test.ts` — real JSONL cancellation, policy/branch/identity replacement, queued admission, reentrant deduplication and the started-persistence boundary
- `packages/server/src/api/session-pagination.test.ts` — bounded stable windows
- `packages/server/src/web-server.test.ts` — session HTTP, persistence, import/export and cascade behavior
- `packages/server/src/api/session-live-mutations.test.ts` — active-run prefix copies, source independence, busy branch-switch protection and invalid/running-command refusals
- `packages/web/src/store/session-store.test.ts` and `e2e/sessions.spec.ts` — hydration and browser lifecycle
- `tests/functional-parity/functional-parity.test.ts` — current tree projection, unversioned read/rewrite migration and malformed/future-line rejection through the public Core entry point

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
