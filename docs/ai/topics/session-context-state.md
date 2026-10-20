# Session Context Edits and Historical Loadouts

> **Navigation:** See [`project-map.md`](../project-map.md) and [session persistence](./sessions.md) first.

## Overview

Core separates the immutable conversation/billing record from future model input and private historical request provenance. These are native AiHarness contracts, not Pi session import or a Pi extension ABI. Current configuration/trust remains execution authority; recorded prompts and schemas never load code, credentials or tools on resume.

## Main Entry Points

| File | Responsibility |
|---|---|
| `packages/core/src/sessions/session-context-state.ts` | Owned admission, loadout replay, context edits and bounded file-path accumulation |
| `packages/core/src/sessions/{session-manager,session-context}.ts` | Serialized publication, v2 persistence, active-path projection, copies and checkpoints |
| `packages/core/src/agent/provider-turn.ts` | Record the final post-hook/start/redactor request loadout before physical dispatch |
| `packages/core/src/extensions/extension-registry.ts` | Output-only `before:session:compaction` override/veto and borrowed bindings |
| `packages/core/src/sdk/{types,agent-session}.ts` | Idle, lifetime-owned `AgentSession.editContext` |
| `packages/cli/src/rpc/rpc-controller.ts` | Strict `context_edit` and metadata-only historical loadout nodes |

## Public Contracts

### Branch-relative context edits

`SessionManager.appendContextEdit(sessionId, {targetEntryId, replacement?}, {signal?}?)` appends a parent-linked `context_edit` entry. Omit `replacement` to omit the entry from future model input; a string, including the empty string, replaces its public content. The last active-path edit wins. Inputs/results are owned; accessors, executable values, unknown fields, foreign/compacted targets and replacement text over 512 KiB refuse before publication.

Targets include ordinary messages and model-visible commands/custom messages/summaries. Model-only command IDs are normalized to the raw command ID. Replacement cannot create tool calls, change correlation, rewrite transcript/usage or expose retained full-output metadata. Complete-tool-group repair removes orphan results/unanswered declarations after edits. Repeated edits can replace an omitted active entry; navigating before an edit recovers the unedited projection. There is no rich-block patch language or automatic recovery policy.

Compaction consumes the edited context. Edits of retained entries survive compaction and restart; edits absorbed into a summary do not resurrect its discarded prefix. Related forks keep IDs; independent clones remap retained edit targets and parent links. Raw source entries and accounting remain unchanged. Optional branch summaries also use the edited public text rather than reintroducing the original body.

The SDK exposes `await session.editContext(edit)` while idle and captures its handle lifetime. RPC accepts only:

```json
{"id":"edit-1","type":"context_edit","targetEntryId":"entry-id","replacement":"Short public context"}
```

RPC success data contains `cancelled:false`, `entryId` and `leafId`; withdrawn unpublished work reports `cancelled:true`. Foreground work refuses nondestructively. Abort/EOF/close withdraw unpublished edits; already-admitted saves finish. No browser edit endpoint or new browser execution authority is added.

### Private historical request loadout

`SessionLoadout` contains `provider`, nullable `model`, `systemPrompt`, complete `tools` definitions and nullable `thinking`. `recordSessionLoadout` validates/copies it, emits a `loadout` entry only for changed fields and uses explicit null/empty values to clear fields. The first entry is a complete base. Tool schemas are historical data, not registrations. `getSessionLoadout` returns an owned reconstruction of the active ancestry, including the latest compaction checkpoint.

CLI regular/fullscreen/print/JSON, RPC and Core's SDK/HTTP runtime pass their manager into the shared provider-turn adapter. It records final prepared options after before-provider hooks, awaited start observers and redaction, immediately before dispatch. Retries deduplicate identical loadouts. Cancelled pre-dispatch work cannot dispatch late; an admitted provenance save is not rolled back. Entries describe prepared request attempts, not proof of provider acceptance or vendor-expanded defaults. Thinking budgets/vendor-native defaults, file-source authorship and routing provenance are not invented.

Private loadout/checkpoint bodies remain in the owner-only local journal and trusted Core/SDK history. They are absent from model transcript projection, `serializeSession` browser/session exports and ordinary RPC entry/tree nodes. RPC exposes only loadout identity/parent/time and `changedFields`. Stored prompts may contain private instructions even after credential-value redaction: journals are not public share artifacts.

### Complete compaction checkpoint

Each new compaction stores a private `checkpoint` with the reconstructed loadout when known, cumulative file operations and an optional `splitUserEntryId` when retention starts inside an existing user span. Legacy unknown loadouts remain unknown. Checkpoints survive repeated compaction, related/independent copies and restart; they do not restore historical execution authority.

File provenance accumulates successful declared `read`/`write`/`edit` tool-call paths from raw active ancestry, including edited/omitted context and prior checkpoints. Each category retains at most 256 distinct paths, each at most 4096 bytes, with a 64 KiB aggregate path budget and explicit truncation. Failed tools are excluded. This is declared file-tool provenance, not a filesystem audit: arbitrary shell/custom/nested effects and hook-rewritten execution paths are not inferred. Nonempty file lists appear as inert JSON path lists alongside the context summary, so repeated summaries need not rely solely on generated prose. The complete private checkpoint is bounded to 2 MiB; loadout/custom JSON retains its own 1 MiB/node/depth bounds.

### Output-only compaction admission

Core `onBeforeCompaction` and extension `before:session:compaction` run ordered hooks after a supplied/generated summary exists, outside the mutation queue. Their frozen event contains only session/cut IDs, proposed summary, output byte limit and signal. Return undefined to continue, false to veto, or `{summary}` to replace output; extensions also accept the existing `{cancel:true,reason?}` cancellation form. Last defined validated output wins; a later veto cancels. No source/cut transformation, accounting replacement, implicit provider request or private checkpoint access is granted.

Original summary-call usage stays attributed even when text is replaced. CLI manual and HTTP manual adapters now retain normalized provider/model/summary usage like RPC/automatic compaction. Their displayed/published summary uses the admitted override. Overrides retain native output limits/redaction, source/signal/store revalidation, hook-generation retirement and admitted-save conservation. Non-cooperative privileged callbacks may delay settlement; this is not physical termination or rollback. Native hooks transform final output, not a Pi-compatible pre-generation override API.

## Format and Migration

The format stays native JSONL v2, Core/extension API major 1. Old unversioned/v2 histories remain readable without fabricated loadouts/checkpoints; new fields/entry variants are additive. Do not downgrade a journal containing these entries to an older reader that skips unknown parent nodes. JSON/HTML conversation exports remain display projections, not backups of the private journal. No Pi import/converter/writer is introduced.

## SES Scenario Map

| Case | Native contract / existing owning evidence |
|---|---|
| At/before/leaf, in-file versus related/independent copies | `sessions/session-row-copy.test.ts`, `session-clone-prefix.test.ts`, `session-navigation-contracts.test.ts`; exact at-entry clone, before-user fork, stable related IDs/fresh independent IDs |
| Running sources | Server `api/session-live-mutations.test.ts`, `api/session-row-copy-http.test.ts`; explicit saved targets copy without stopping source; unsaved/running-command ancestors and targetless running copies refuse |
| Shell-only/private-only/empty/subagent cases | Core `session-row-copy.test.ts`, CLI `cli/session-clone-position-process.test.ts`; native memory copies remain supported, server exact saved-entry/subagent restrictions remain distinct |
| Labels and hooks | Durable session titles and named branch summaries are the native alternative to per-entry labels; Core `session-branch-hooks.test.ts`, `session-summary-hooks.test.ts`, CLI `session-branch-terminal-process.test.ts` retain ordered veto/summary/publication behavior |
| Raw ancestry and usage after restart | Core `session-active-entries.test.ts`, `session-accounting.test.ts`, `session-clone-summaries.test.ts`; active/full scopes are independent from edited/compacted model context; clones retain their native active-projection policy, not abandoned source histories |
| Manual/threshold/repeated/split/overflow cuts | Core `compaction-{cut,preparation,context}.test.ts`, `session-context-state.test.ts`; complete assistant/tool units and whole-prefix preparation; overflow preparation is explicit, useful automatic compact-and-retry remains RUN-03 |
| Settings/model/source/cancel/store races | CLI `context-settings-process.test.ts`, Core `session-compaction-{admission,manual-admission,store-admission}.test.ts`, CLI/SDK compaction lifetime leaves, HTTP `http-compaction-lifecycle.test.ts` |
| Browser boundaries | `e2e/sessions.spec.ts` and `session-row-copy-owner.spec.ts` own intercepted intent; `e2e/session-row-copy-live.spec.ts` separately owns real saved-leaf copies/reload/source conservation, EN/FR desktop/mobile menus, axe and reviewed captures; actual edited-run/compaction privacy is tested through real HTTP |

## Associated Tests

- `packages/core/src/sessions/session-context-state.test.ts`: durable/memory repeated edits, raw/accounting conservation, tool groups, branch summaries, private loadout deltas, split/repeated checkpoints, file paths, copies/restart and invalid/failed admission.
- `packages/core/src/agent/provider-loadout.test.ts`: final hook/start values, clear/switch deltas, retry deduplication and pre-dispatch cancellation.
- `packages/core/src/extensions/session-compaction-hooks.test.ts`: ordered owned overrides, veto/invalid/accessor refusal and source/abort/generation withdrawal.
- `packages/core/src/sdk/agent-session.test.ts`: native facade editing, redaction and busy refusal within existing SDK scenarios.
- `packages/cli/src/cli/session-context-state-process.test.ts`: actual print/JSON/RPC/SDK through a loopback provider, canonical private prompts, edits and durable copy/checkpoint readback.
- `packages/cli/src/commands/compaction-public-transcript.test.ts`: manual summary privacy, normalized journal usage and admitted override display.
- `packages/server/src/api/session-row-copy-http.test.ts`: real HTTP edited payloads, private DTOs, copies, detached runs, compaction usage/checkpoints and reload.
- `tests/functional-parity/installed-executable.test.ts`: genuine outside-checkout installed PATH-bin/SDK scenarios and positive/negative public declarations.

## Common Changes

- For another edit mode, update `session-context-state.ts`, manager admission and copy remapping, then prove model/transcript/accounting separation and RPC/SDK ownership independently.
- For another provenance field, update owned validation, field-delta replay/checkpoints and real post-hook dispatch tests; never put private bodies in `Session.metadata` or RPC/browser DTOs.
- For compaction changes, reuse the source/cancellation/store controls in [sessions](./sessions.md); do not make historical schemas or file paths execution authority.

## Related Domains

- [Sessions](./sessions.md) — native journal, ancestry, copies, compaction and statistics.
- [Providers](./providers.md) — final request preparation, bounds and usage.
- [Session SDK](./session-sdk.md) — lifetime ownership and borrowed resources.
