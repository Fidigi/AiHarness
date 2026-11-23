import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readStableDirectoryEntries } from './stable-directory.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('readStableDirectoryEntries', () => {
  it('returns a bounded listing and reports truncation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-stable-directory-'));
    directories.push(root);
    await Promise.all(['a', 'b', 'c'].map(name => writeFile(path.join(root, name), name)));

    const listing = await readStableDirectoryEntries(root, 2);

    expect(listing.entries).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it('rejects a symbolic directory instead of traversing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-stable-directory-'));
    const target = await mkdtemp(path.join(os.tmpdir(), 'aih-stable-directory-target-'));
    directories.push(root, target);
    await mkdir(path.join(target, 'nested'));
    const link = path.join(root, 'linked');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readStableDirectoryEntries(link)).rejects.toThrow('stable regular directory');
  });

  it('rejects symbolic parent components on descriptor-anchored platforms', async () => {
    if (process.platform !== 'linux') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-stable-directory-'));
    directories.push(root);
    await mkdir(path.join(root, 'real', 'nested'), { recursive: true });
    await symlink(path.join(root, 'real'), path.join(root, 'linked-parent'), 'dir');

    await expect(readStableDirectoryEntries(path.join(root, 'linked-parent', 'nested')))
      .rejects.toThrow('stable regular directory');
  });

  it('honors cancellation before touching the directory', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(readStableDirectoryEntries(path.resolve('/not-read'), 10, controller.signal))
      .rejects.toThrow('cancelled');
  });
});
