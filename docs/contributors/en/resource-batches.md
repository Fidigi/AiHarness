# Exact model and skill enablement batches

## Ownership

Core exports `ResourceEnableChange`, `ResourceEnableOutcome` and `ModelEnableBatchResult`/`SkillEnableBatchResult` from `packages/core/src/types/resource-batches.ts`. Server owns the HTTP/persistence adapter in `api/model-routes.ts` and fresh-list merging in `runtime/resource-batches.ts`. Web's lazy Settings tree uses `ResourceBatchControls.tsx` and `services/resource-batches.ts`; it does not loop over individual HTTP writes.

## Public request

Administrator `configuration` capability and normal Origin checks protect `PATCH /api/models/enabled/batch`:

```json
{
  "projectId": "selected-workspace-id",
  "changes": [{ "key": "openai:qualified-model-id", "enabled": false }]
}
```

Omit `projectId` for global scope. Accept exactly `changes` and optional `projectId`; at most 500 unique `{key, enabled}` entries, bounded nonempty selectors and booleans. Reject unknown fields, duplicates and malformed input before mutation. An empty batch is a no-op.

Success returns ordered `outcomes` (`changed`, `unchanged`, `failed`, optional fixed code) and canonical `catalog`. Unknown selectors fail independently. Settings sends only changed displayed rows; individual checkboxes use the same route with one selector. Groups above 500 changed rows must be filtered, not silently truncated.

## Persistence and failure

`ConfigurationStore.update()` serializes a transform against fresh target/global copies. Preserve unknown or hidden enabled keys, unrelated fields and inherited no-ops. Expand a legacy unqualified model-ID alias before changing one qualified provider selector so another provider's same-ID model is unaffected. Known qualified keys take precedence over overlapping legacy IDs in both reads and merges; never delete another model's qualified key as if it were an alias. No-op writes do not materialize inheritance or replace an inode.

A writer rejection can follow publication. Mark unconfirmed changes failed, reload canonical configuration and return actual state rather than inventing rollback. If reconciliation fails, return `409 MODEL_BATCH_UNCERTAIN` with outcomes and **without a catalogue**. `GET /api/models` rereads configuration and refuses unreadable state, so a subsequent refresh cannot bless stale memory. No cross-file crash atomicity or hostile-writer exclusion is claimed; see [stable publication](./stable-file-publication.md).

The client treats transport/uncertain errors as requiring refresh, not undo. Its captured workspace ID/cwd and Settings-lifetime generation exclude stale response publication, including unmount/reopen on the same workspace. A synchronous local lock prevents duplicate sends. No session/default/provider mutation is part of this contract.

## Skill group mutation

Administrator `PATCH /api/skills/enabled/batch` accepts exactly `{changes, cwd?, projectId?}` with the same 500 unique-selector bound. Resolve selectors through owned discovery, never a client path. Project IDs must match canonical cwd; project documents require fresh saved trust before read and publication. Settings groups Project/Global skills and each configured/package source separately, sending only changed displayed entries; individual checkboxes send one selector.

`runtime/skill-catalog.ts` serializes each file independently. `runtime/skill-markdown.ts` validates current strict metadata and changes only `disable-model-invocation`, retaining BOM, LF/CRLF, comments, body and existing mode. Malformed, linked, hardlinked, nonregular, changed or trust-refused documents fail independently; later siblings continue. Effective no-ops do not rewrite metadata or materialize inheritance. Fresh scoped allowlist transforms preserve hidden/unknown entries and other same-name siblings. Global/package/path document edits can affect discovery in other workspaces; invalidate all discovery caches, while scoped allowlists still determine effective invocation.

After settings failure, restore Markdown only with Core's one-use writer-owned receipt. Observable same-byte/new-inode or in-place ABA and revoked trust refuse rollback as `SKILL_ROLLBACK_FAILED`; never overwrite an intervening writer. Await disposal of publication/rollback receipts. Error codes use bounded own value descriptors, not getters. Always reload canonical settings before returning a catalogue. Unreadable reconciliation returns `409 SKILL_BATCH_UNCERTAIN` with ordered outcomes and no catalogue; `GET /api/skills` also refuses `CONFIGURATION_UNREADABLE`. Post-publication error is not an unchanged file or a successful multi-file rollback. There is no cross-file crash transaction, OS atomic CAS or privileged-producer sandbox.

## Tests and maintenance

- `packages/server/src/api/model-batches.test.ts`: real authenticated loopback HTTP, exact scope/alias preservation, concurrent fresh transforms, byte-stable no-ops, invalid/admin/Origin guards and post-publication/unreadable reconciliation.
- `packages/server/src/runtime/resource-batches.test.ts`: strict selector and inherited merge contracts.
- `packages/server/src/api/resource-batches.test.ts`, `packages/server/src/runtime/skill-markdown.test.ts`: actual HTTP, strict document/body/mode/trust guards, scoped concurrency, real second-publication failure, receipt ABA/refusal/disposal and canonical uncertainty.
- `e2e/resource-batches.spec.ts`: retained combined group assertions, partial/error reconciliation, axe/overflow and eight skill/outcome desktop/mobile Light/Dark captures.
- `e2e/skill-batches-live.spec.ts`: actual Vite/Express/Core discovery and disk publication, filtered hidden-file preservation, invalid sibling continuation and durable reload without API interception.
- `packages/web/src/services/resource-batches.test.ts`: minimal route/body and error behavior.
- `e2e/model-batches.spec.ts`: exact filtered/group/individual requests, outcomes, axe/overflow, retired same-workspace saves and four Light/Dark desktop/mobile captures.

Run Docker workspace typechecks, focused single-worker tests, no-update/no-retry browsers and the unchanged production budget checker. Inspect only justified screenshot deltas. Keep the [Server API](../../ai/topics/server-api.md), [user instructions](../../users/en/resource-batches.md) and French counterpart synchronized. Model and skill deliveries have separate evidence; common scaffolding does not close providers or broader Settings criteria.
