# Writer-owned file publication

Core exports `atomicWriteStableFile`, `atomicWriteStableFileWithReceipt`, `disposeStableFilePublicationReceipt`, `AtomicStableFileOptions`, `StableFilePublicationReceipt` and `StableFilePublicationResult` from the built package root. The existing writer still resolves to `undefined` or rejects. Rejection does not prove disk stayed unchanged.

## Admission and outcome

The destination must already be confined by the caller's workspace/security policy. The writer is not a trust decision, allowed-root expansion or execution capability. It accepts bounded string/byte content (64 MiB hard ceiling), private same-directory staging, explicit modes and optional `beforeCommit` revalidation. Value/authority options are captured before the first await; the callback retains its original receiver, but changing its options does not change admission.

The opt-in result is frozen:

- `publication`: `not-published`, `published` or `uncertain`;
- optional `receipt`: opaque writer-owned authority, possibly present on an error result;
- optional `error`: inspect **property presence**, including an undefined thrown value.

An attempted publication may change disk before failure. A published/uncertain result without a receipt cannot authorize safe guarded rollback. Do not blindly restore old bytes after any rejected write or dependent settings operation; reconcile the canonical state and report uncertainty/refused rollback instead.

## Receipt lifecycle

The receipt retains the staged file descriptor and parent descriptor. Identity is frozen from the owned descriptor after rename/link, not from reopening/statting a possibly replaced destination. It compares device/inode, size, nanosecond modification/change times, mode and single-link identity against the fresh owned descriptor and path; parent identity is checked too.

Pass `expectedPublication` with `overwrite: true` to replace exactly that publication. The guard is destination-bound and one-use, even when its attempt fails. Foreign, JSON/structured-cloned, disposed or reused objects have no authority. An identical byte string on another inode is an intervening writer, not permission to overwrite it.

Every returned receipt must be disposed in an awaited `finally`, including original and replacement receipts on error. Do not dispose a receipt while its guarded write is pending. Disposal is idempotent for genuine receipts. There are 64 retained **plus in-flight** slots per module instance/process, at most two held descriptors each. An overlapping guarded replacement needs another slot. There is no expiry/finalizer cleanup promise; missing disposal can exhaust this bounded pool. Ordinary writes retain no receipt.

```ts
const result = await atomicWriteStableFileWithReceipt(path, newBytes, { overwrite: true });
try {
  if ('error' in result) throw result.error;
  if (!result.receipt) throw new Error('Missing owned publication');
  // Only if the dependent operation failed and rollback is still authorized:
  const rollback = await atomicWriteStableFileWithReceipt(path, oldBytes, {
    overwrite: true, expectedPublication: result.receipt,
  });
  try {
    if ('error' in rollback) throw rollback.error;
  } finally {
    if (rollback.receipt) await disposeStableFilePublicationReceipt(rollback.receipt);
  }
} finally {
  if (result.receipt) await disposeStableFilePublicationReceipt(result.receipt);
}
```

## Limits and evidence

This is not an OS-atomic compare-and-swap, hostile-writer exclusion, complete privileged-metadata tamper detection or multi-file crash-atomic transaction. A hostile writer may act between the last check and rename; filesystem timestamp precision varies. Directory fsync is best effort, as before. Final requested mode is applied before publication; staging starts at `0600`.

`packages/core/src/security/stable-file.test.ts` and `stable-file-receipt.test.ts` exercise real files, before/after-publication failures, caller-option mutation, owned/foreign inode and observable in-place ABA, parent changes, opaque one-use guards, descriptor disposal and capacity. Validate in Docker and through the genuine built root, not only source aliases.

Related: [security boundaries](../../ai/topics/security.md), [public contract policy](./public-contract-policy.md), [French reference](../fr/stable-file-publication.md).
