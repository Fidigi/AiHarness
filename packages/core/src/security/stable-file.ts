import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { link, lstat, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { openStableDirectoryHandle } from './stable-directory.js';

const MAX_STABLE_FILE_BYTES = 64 * 1024 * 1024;
// Includes in-flight opt-in writes; each retains at most one file and one parent fd.
const MAX_PUBLICATION_RECEIPTS = 64;
let heldPublications = 0;
const receiptBrand: unique symbol = Symbol('StableFilePublicationReceipt');

/** Opaque host-only capability. Not serializable, cloneable or constructible by callers. */
export interface StableFilePublicationReceipt { readonly [receiptBrand]: true }
interface PublicationState {
  destination: string;
  file: FileHandle;
  parent: FileHandle;
  parentIdentity: BigIntStats;
  identity: BigIntStats;
  used: boolean;
  disposed: boolean;
  closing?: Promise<void>;
}
const publications = new WeakMap<StableFilePublicationReceipt, PublicationState>();

export type StableFileErrorCode =
  | 'invalid-content'
  | 'unsafe-parent'
  | 'unsafe-target'
  | 'target-exists'
  | 'target-changed'
  | 'staging-changed'
  | 'invalid-receipt'
  | 'receipt-limit';

export class StableFileError extends Error {
  constructor(public readonly code: StableFileErrorCode, message: string) {
    super(message);
    this.name = 'StableFileError';
  }
}

export interface AtomicStableFileOptions {
  overwrite?: boolean;
  maxBytes?: number;
  mode?: number;
  /** Revalidate caller-owned state after staging, before target inspection/publication. */
  beforeCommit?(): Promise<void>;
  /** One-use guard for replacing exactly an owned publication. Requires overwrite. */
  expectedPublication?: StableFilePublicationReceipt;
}

export interface StableFilePublicationResult {
  /** An attempted publication may have changed disk even when error is present. */
  readonly publication: 'not-published' | 'published' | 'uncertain';
  readonly receipt?: StableFilePublicationReceipt;
  readonly error?: unknown;
}

/** Idempotent; opt-in callers MUST await this in finally, including error results. */
export async function disposeStableFilePublicationReceipt(receipt: StableFilePublicationReceipt): Promise<void> {
  const state = publications.get(receipt);
  if (!state) throw new StableFileError('invalid-receipt', 'The publication receipt is invalid.');
  if (state.closing) return state.closing;
  state.disposed = true;
  state.closing = (async () => {
    await Promise.all([state.file.close().catch(() => undefined), state.parent.close().catch(() => undefined)]);
    heldPublications--;
  })();
  return state.closing;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

async function inspect(file: string): Promise<BigIntStats | undefined> {
  return lstat(file, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
}

async function validateParent(parent: FileHandle, parentPath: string, identity: BigIntStats): Promise<void> {
  const [owned, current] = await Promise.all([parent.stat({ bigint: true }), lstat(parentPath, { bigint: true })]);
  if (!owned.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
    || owned.dev !== identity.dev || owned.ino !== identity.ino
    || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new StableFileError('unsafe-parent', 'The destination directory changed.');
  }
}

async function validatePublication(state: PublicationState, target: string, parentIdentity: BigIntStats): Promise<void> {
  if (state.disposed || parentIdentity.dev !== state.parentIdentity.dev || parentIdentity.ino !== state.parentIdentity.ino) {
    throw new StableFileError('invalid-receipt', 'The publication receipt is no longer valid.');
  }
  await validateParent(state.parent, path.dirname(state.destination), state.parentIdentity);
  const [owned, current] = await Promise.all([state.file.stat({ bigint: true }), inspect(target)]);
  if (!current || !sameIdentity(state.identity, owned) || !sameIdentity(state.identity, current)) {
    throw new StableFileError('target-changed', 'The owned publication changed.');
  }
}

/**
 * Publish one bounded regular file while holding and revalidating its parent.
 * Callers must first confine destination with WorkspaceManager. Promise<void> ABI
 * is preserved; a rejection after publication does NOT imply unchanged disk.
 */
export async function atomicWriteStableFile(
  destination: string, content: string | Uint8Array, options: AtomicStableFileOptions = {},
): Promise<void> {
  const result = await writeStableFile(destination, content, options, false);
  if ('error' in result) throw result.error;
}

/**
 * Opt-in publication lifecycle, including post-publication failures. Always inspect
 * error/publication and dispose receipt in finally. Identity is frozen from the
 * writer's staged fd, NEVER from a newly opened/stat'ed destination. Guards detect
 * inode replacement and timestamp-changing in-place ABA, not an OS atomic CAS:
 * a hostile writer can act in the last-check/rename gap. No multi-file crash atomicity.
 */
export async function atomicWriteStableFileWithReceipt(
  destination: string, content: string | Uint8Array, options: AtomicStableFileOptions = {},
): Promise<StableFilePublicationResult> {
  return writeStableFile(destination, content, options, true);
}

async function writeStableFile(
  destination: string, content: string | Uint8Array, options: AtomicStableFileOptions, retain: boolean,
): Promise<StableFilePublicationResult> {
  let publication: StableFilePublicationResult['publication'] = 'not-published';
  let receipt: StableFilePublicationReceipt | undefined;
  let parentHandle: FileHandle | undefined;
  let stagingHandle: FileHandle | undefined;
  let stagingPath = '';
  let reserved = false;
  try {
    // Capture authority/value options before the first await. Preserve the original
    // callback receiver, but its mutations cannot change this write's admission.
    const originalOptions = options;
    const beforeCommit = originalOptions.beforeCommit;
    options = Object.freeze({
      overwrite: originalOptions.overwrite,
      maxBytes: originalOptions.maxBytes,
      mode: originalOptions.mode,
      expectedPublication: originalOptions.expectedPublication,
      beforeCommit: beforeCommit ? () => beforeCommit.call(originalOptions) : undefined,
    });
    const maxBytes = options.maxBytes ?? MAX_STABLE_FILE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_STABLE_FILE_BYTES) {
      throw new StableFileError('invalid-content', 'The file size limit is invalid.');
    }
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    if (bytes.length > maxBytes) throw new StableFileError('invalid-content', 'The file exceeds its size limit.');
    const absolute = path.resolve(destination);
    const expected = options.expectedPublication === undefined ? undefined : publications.get(options.expectedPublication);
    if (options.expectedPublication !== undefined) {
      if (!expected || expected.used || expected.disposed || expected.destination !== absolute || !options.overwrite) {
        throw new StableFileError('invalid-receipt', 'The publication receipt is invalid for this write.');
      }
      // Consume before any await: concurrent/repeated rollback cannot reuse it.
      expected.used = true;
    }
    if (retain) {
      if (heldPublications >= MAX_PUBLICATION_RECEIPTS) throw new StableFileError('receipt-limit', 'Too many held publications.');
      heldPublications++;
      reserved = true;
    }
    const parentPath = path.dirname(absolute);
    parentHandle = await openStableDirectoryHandle(parentPath).catch(() => {
      throw new StableFileError('unsafe-parent', 'The destination directory is unsafe.');
    });
    const parentOpened = await parentHandle.stat({ bigint: true });
    await validateParent(parentHandle, parentPath, parentOpened);
    const anchoredParent = process.platform === 'linux' ? `/proc/self/fd/${parentHandle.fd}` : parentPath;
    const target = path.join(anchoredParent, path.basename(absolute));
    if (expected) await validatePublication(expected, target, parentOpened);
    const existing = await inspect(target);
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n)) {
      throw new StableFileError('unsafe-target', 'The destination is not a stable regular file.');
    }
    if (existing && !options.overwrite) throw new StableFileError('target-exists', 'The destination already exists.');
    stagingPath = path.join(anchoredParent, `.${path.basename(absolute)}.${process.pid}.${randomBytes(12).toString('hex')}.staging`);
    stagingHandle = await open(stagingPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await stagingHandle.writeFile(bytes);
    await stagingHandle.chmod(options.mode ?? 0o600);
    await stagingHandle.sync();
    const staged = await stagingHandle.stat({ bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n || staged.size !== BigInt(bytes.length)) {
      throw new StableFileError('staging-changed', 'The staging file changed unexpectedly.');
    }
    await options.beforeCommit?.();
    await validateParent(parentHandle, parentPath, parentOpened);
    if (expected) await validatePublication(expected, target, parentOpened);
    const [current, stagingCurrent, stagingOwned] = await Promise.all([
      inspect(target), lstat(stagingPath, { bigint: true }), stagingHandle.stat({ bigint: true }),
    ]);
    if (!sameIdentity(staged, stagingCurrent) || !sameIdentity(staged, stagingOwned)
      || (existing && (!current || !sameIdentity(existing, current))) || (!existing && current)) {
      throw new StableFileError('target-changed', 'The destination changed before commit.');
    }
    publication = 'uncertain';
    if (options.overwrite) {
      await rename(stagingPath, target);
      stagingPath = '';
    } else {
      try { await link(stagingPath, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new StableFileError('target-exists', 'The destination already exists.');
        }
        throw error;
      }
      await rm(stagingPath);
      stagingPath = '';
    }
    publication = 'published';
    // Rename/link changes ctime. Freeze the OWN descriptor's post-publication
    // identity, then compare both fresh descriptor and path against that snapshot.
    const owned = Object.freeze(await stagingHandle.stat({ bigint: true }));
    if (retain) {
      receipt = Object.freeze({}) as StableFilePublicationReceipt;
      publications.set(receipt, { destination: absolute, file: stagingHandle, parent: parentHandle,
        parentIdentity: parentOpened, identity: owned, used: false, disposed: false });
    }
    const [committed, freshOwned] = await Promise.all([lstat(target, { bigint: true }), stagingHandle.stat({ bigint: true })]);
    if (!sameIdentity(owned, committed) || !sameIdentity(owned, freshOwned)
      || owned.dev !== staged.dev || owned.ino !== staged.ino || owned.size !== staged.size
      || owned.mtimeNs !== staged.mtimeNs || owned.mode !== staged.mode) {
      throw new StableFileError('target-changed', 'The committed file changed during validation.');
    }
    await validateParent(parentHandle, parentPath, parentOpened);
    await parentHandle.sync().catch(() => undefined);
    return Object.freeze({ publication, receipt });
  } catch (error) {
    return Object.freeze({ publication, receipt, error });
  } finally {
    if (stagingPath) await rm(stagingPath, { force: true }).catch(() => undefined);
    if (!receipt) {
      await stagingHandle?.close().catch(() => undefined);
      await parentHandle?.close().catch(() => undefined);
      if (reserved) heldPublications--;
    }
  }
}
