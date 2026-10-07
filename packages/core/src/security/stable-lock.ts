import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, rename, unlink } from 'node:fs/promises';

export type StableLockIdentity = Pick<Stats, 'dev' | 'ino'>;

/**
 * Release only the lock identity acquired by the caller.
 *
 * The pathname is first moved to an unpredictable sibling and then revalidated,
 * so a replacement installed between inspection and release is restored rather
 * than unlinked. Callers remain responsible for creating and validating the lock.
 */
export async function releaseStableLockPath(
  lockPath: string,
  expected: StableLockIdentity,
): Promise<boolean> {
  const claimedPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.released`;
  try {
    await rename(lockPath, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  try {
    const claimed = await lstat(claimedPath);
    if (claimed.isFile() && !claimed.isSymbolicLink() && claimed.nlink === 1
      && claimed.dev === expected.dev && claimed.ino === expected.ino) {
      await unlink(claimedPath);
      return true;
    }

    // The pathname was replaced before the atomic claim. Do not delete the
    // replacement; put it back when its original pathname is still vacant.
    const replacement = await lstat(lockPath).catch(() => undefined);
    if (!replacement) await rename(claimedPath, lockPath).catch(() => undefined);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
