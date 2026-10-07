import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteStableFile, StableFileError } from './stable-file.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-stable-file-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('atomicWriteStableFile', () => {
  it('publishes a bounded file and requires explicit overwrite', async () => {
    const root = await fixture();
    const target = path.join(root, 'export.json');
    await atomicWriteStableFile(target, '{"safe":true}');
    expect(await readFile(target, 'utf8')).toBe('{"safe":true}');
    await expect(atomicWriteStableFile(target, 'replacement'))
      .rejects.toMatchObject<Partial<StableFileError>>({ code: 'target-exists' });
    await atomicWriteStableFile(target, 'replacement', { overwrite: true });
    expect(await readFile(target, 'utf8')).toBe('replacement');
  });

  it.runIf(process.platform !== 'win32')('refuses symbolic and hard-linked targets or parents', async () => {
    const root = await fixture();
    const real = path.join(root, 'real');
    await mkdir(real);
    const linkedParent = path.join(root, 'linked');
    await symlink(real, linkedParent, 'dir');
    await expect(atomicWriteStableFile(path.join(linkedParent, 'blocked'), 'value'))
      .rejects.toMatchObject<Partial<StableFileError>>({ code: 'unsafe-parent' });

    const target = path.join(root, 'target');
    const sibling = path.join(root, 'sibling');
    await writeFile(target, 'old');
    await link(target, sibling);
    await expect(atomicWriteStableFile(target, 'new', { overwrite: true }))
      .rejects.toMatchObject<Partial<StableFileError>>({ code: 'unsafe-target' });
  });

  it('rejects content beyond the caller limit before touching the target', async () => {
    const root = await fixture();
    const target = path.join(root, 'too-large');
    await expect(atomicWriteStableFile(target, '12345', { maxBytes: 4 }))
      .rejects.toMatchObject<Partial<StableFileError>>({ code: 'invalid-content' });
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
