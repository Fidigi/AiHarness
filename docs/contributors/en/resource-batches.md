# Exact model enablement batches

## Ownership

Core exports `ResourceEnableChange`, `ResourceEnableOutcome` and `ModelEnableBatchResult` from `packages/core/src/types/resource-batches.ts`. Server owns the HTTP/persistence adapter in `api/model-routes.ts` and fresh-list merging in `runtime/resource-batches.ts`. Web's lazy Settings tree uses `ResourceBatchControls.tsx` and `services/resource-batches.ts`; it does not loop over individual HTTP writes.

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

## Tests and maintenance

- `packages/server/src/api/model-batches.test.ts`: real authenticated loopback HTTP, exact scope/alias preservation, concurrent fresh transforms, byte-stable no-ops, invalid/admin/Origin guards and post-publication/unreadable reconciliation.
- `packages/server/src/runtime/resource-batches.test.ts`: strict selector and inherited merge contracts.
- `packages/web/src/services/resource-batches.test.ts`: minimal route/body and error behavior.
- `e2e/model-batches.spec.ts`: exact filtered/group/individual requests, outcomes, axe/overflow, retired same-workspace saves and four Light/Dark desktop/mobile captures.

Run Docker workspace typechecks, focused single-worker tests, no-update/no-retry browsers and the unchanged production budget checker. Inspect only justified screenshot deltas. Keep the [Server API](../../ai/topics/server-api.md), [user instructions](../../users/en/resource-batches.md) and French counterpart synchronized. Skill group editing remains a separate delivery, not inferred from common DTO/helper scaffolding.
