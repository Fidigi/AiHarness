import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { openStableDirectoryHandle } from './stable-directory.js';

const MAX_STABLE_FILE_BYTES = 64 * 1024 * 1024;

export type StableFileErrorCode =
  | 'invalid-content'
  | 'unsafe-parent'
  | 'unsafe-target'
  | 'target-exists'
  | 'target-changed'
  | 'staging-changed';

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
}

/**
 * Publish one bounded regular file while holding and revalidating its parent.
 * Callers must first confine `destination` with WorkspaceManager.
 */
export async function atomicWriteStableFile(
  destination: string,
  content: string | Uint8Array,
  options: AtomicStableFileOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_STABLE_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_STABLE_FILE_BYTES) {
    throw new StableFileError('invalid-content', 'The file size limit is invalid.');
  }
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  if (bytes.length > maxBytes) {
    throw new StableFileError('invalid-content', 'The file exceeds its size limit.');
  }
  const absolute = path.resolve(destination);
  const parentPath = path.dirname(absolute);
  const parentHandle = await openStableDirectoryHandle(parentPath).catch(() => {
    throw new StableFileError('unsafe-parent', 'The destination directory is unsafe.');
  });
  let stagingHandle: Awaited<ReturnType<typeof open>> | undefined;
  let stagingPath = '';
  try {
    const parentOpened = await parentHandle.stat();
    const parentBefore = await lstat(parentPath);
    if (!parentOpened.isDirectory() || !parentBefore.isDirectory() || parentBefore.isSymbolicLink()
      || parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
      throw new StableFileError('unsafe-parent', 'The destination directory changed while it was opened.');
    }
    const anchoredParent = process.platform === 'linux' ? `/proc/self/fd/${parentHandle.fd}` : parentPath;
    const target = path.join(anchoredParent, path.basename(absolute));
    const existing = await lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
      throw new StableFileError('unsafe-target', 'The destination is not a stable regular file.');
    }
    if (existing && !options.overwrite) {
      throw new StableFileError('target-exists', 'The destination already exists.');
    }

    stagingPath = path.join(
      anchoredParent,
      `.${path.basename(absolute)}.${process.pid}.${randomBytes(12).toString('hex')}.staging`,
    );
    stagingHandle = await open(
      stagingPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      options.mode ?? 0o600,
    );
    await stagingHandle.writeFile(bytes);
    await stagingHandle.sync();
    const staged = await stagingHandle.stat();
    if (!staged.isFile() || staged.nlink !== 1 || staged.size !== bytes.length) {
      throw new StableFileError('staging-changed', 'The staging file changed unexpectedly.');
    }
    await stagingHandle.close();
    stagingHandle = undefined;
    await options.beforeCommit?.();

    const [current, stagingCurrent] = await Promise.all([
      lstat(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }),
      lstat(stagingPath),
    ]);
    if (!stagingCurrent.isFile() || stagingCurrent.isSymbolicLink() || stagingCurrent.nlink !== 1
      || stagingCurrent.dev !== staged.dev || stagingCurrent.ino !== staged.ino
      || stagingCurrent.size !== staged.size || stagingCurrent.mtimeMs !== staged.mtimeMs
      || stagingCurrent.ctimeMs !== staged.ctimeMs
      || (existing && (!current || current.dev !== existing.dev || current.ino !== existing.ino
        || current.nlink !== 1 || current.size !== existing.size || current.mtimeMs !== existing.mtimeMs
        || current.ctimeMs !== existing.ctimeMs))
      || (!existing && current)) {
      throw new StableFileError('target-changed', 'The destination changed before commit.');
    }

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

    const [committed, parentAfter, parentPathAfter] = await Promise.all([
      lstat(target),
      parentHandle.stat(),
      lstat(parentPath),
    ]);
    if (!committed.isFile() || committed.isSymbolicLink() || committed.nlink !== 1
      || committed.dev !== staged.dev || committed.ino !== staged.ino || committed.size !== staged.size
      || parentAfter.dev !== parentOpened.dev || parentAfter.ino !== parentOpened.ino
      || !parentPathAfter.isDirectory() || parentPathAfter.isSymbolicLink()
      || parentPathAfter.dev !== parentOpened.dev || parentPathAfter.ino !== parentOpened.ino) {
      throw new StableFileError('target-changed', 'The committed file changed during validation.');
    }
    await parentHandle.sync().catch(() => undefined);
  } finally {
    await stagingHandle?.close().catch(() => undefined);
    if (stagingPath) await rm(stagingPath, { force: true }).catch(() => undefined);
    await parentHandle.close().catch(() => undefined);
  }
}
