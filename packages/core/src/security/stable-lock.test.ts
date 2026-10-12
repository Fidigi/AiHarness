import { lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseStableLockPath } from './stable-lock.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-stable-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('releaseStableLockPath', () => {
  it('removes the exact lock identity claimed by its owner', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'state.lock');
    await writeFile(lockPath, 'owner', { mode: 0o600 });
    const identity = await lstat(lockPath);

    await expect(releaseStableLockPath(lockPath, identity)).resolves.toBe(true);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores rather than deleting a lock that replaced the owned identity', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'state.lock');
    const originalPath = path.join(directory, 'original.lock');
    await writeFile(lockPath, 'owner', { mode: 0o600 });
    const identity = await lstat(lockPath);
    await rename(lockPath, originalPath);
    await writeFile(lockPath, 'replacement', { mode: 0o600 });

    await expect(releaseStableLockPath(lockPath, identity)).resolves.toBe(false);
    await expect(lstat(lockPath)).resolves.toMatchObject({ size: 11 });
    await expect(lstat(originalPath)).resolves.toMatchObject({ dev: identity.dev, ino: identity.ino });
  });
});
