import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile,
  type FileHandle } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteStableFile, atomicWriteStableFileWithReceipt, disposeStableFilePublicationReceipt,
  type AtomicStableFileOptions, type StableFilePublicationReceipt } from './stable-file.js';

const hooks = vi.hoisted(() => ({
  afterRename: undefined as (() => Promise<void>) | undefined,
  beforeLstat: undefined as ((file: string) => Promise<void>) | undefined,
  stagingHandle: undefined as FileHandle | undefined,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith('.staging')) hooks.stagingHandle = handle;
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const hook = hooks.afterRename; hooks.afterRename = undefined;
      await hook?.();
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      await hooks.beforeLstat?.(String(args[0]));
      return actual.lstat(...args);
    },
  };
});
const roots: string[] = [];
const receipts: StableFilePublicationReceipt[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-receipt-')); roots.push(root); return root;
}
async function publish(target: string, content = 'owned'): Promise<StableFilePublicationReceipt> {
  const result = await atomicWriteStableFileWithReceipt(target, content, { overwrite: true, mode: 0o640 });
  if (result.receipt) receipts.push(result.receipt);
  expect(result.error).toBeUndefined(); expect(result.publication).toBe('published');
  expect(result.receipt).toBeDefined(); return result.receipt!;
}
async function fdCount(): Promise<number> { return (await readdir('/proc/self/fd')).length; }
afterEach(async () => {
  hooks.afterRename = undefined; hooks.beforeLstat = undefined; hooks.stagingHandle = undefined;
  vi.restoreAllMocks();
  await Promise.all(receipts.splice(0).map(disposeStableFilePublicationReceipt));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('writer-owned publication receipts', () => {
  for (const retained of [false, true]) {
    it(`captures admitted options before caller mutation (receipt=${retained})`, async () => {
      const target = path.join(await fixture(), 'file');
      await writeFile(target, 'old');
      const options: AtomicStableFileOptions = {
        overwrite: true, mode: 0o640,
        async beforeCommit() {
          expect(this).toBe(options);
          options.overwrite = false;
          options.mode = 0o600;
        },
      };
      if (retained) {
        const result = await atomicWriteStableFileWithReceipt(target, 'new', options);
        if (result.receipt) receipts.push(result.receipt);
        expect(result.error).toBeUndefined();
        expect(result.publication).toBe('published');
      } else {
        expect(await atomicWriteStableFile(target, 'new', options)).toBeUndefined();
      }
      expect(await readFile(target, 'utf8')).toBe('new');
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
    });
  }

  it('retains immutable opaque ownership until explicit idempotent finally disposal', async () => {
    const target = path.join(await fixture(), 'file'); const baseline = await fdCount();
    const receipt = await publish(target);
    try {
      expect(Object.isFrozen(receipt)).toBe(true); expect(Object.keys(receipt)).toEqual([]);
      expect(JSON.stringify(receipt)).toBe('{}'); expect(await fdCount()).toBe(baseline + 2);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
      expect(await atomicWriteStableFile(target, 'restored', { overwrite: true, expectedPublication: receipt })).toBeUndefined();
      expect(await readFile(target, 'utf8')).toBe('restored');
      await expect(atomicWriteStableFile(target, 'reused', { overwrite: true, expectedPublication: receipt }))
        .rejects.toMatchObject({ code: 'invalid-receipt' });
    } finally { await disposeStableFilePublicationReceipt(receipt); }
    await disposeStableFilePublicationReceipt(receipt);
    expect(await fdCount()).toBe(baseline);
  });

  it('retains the staged fd across exclusive link publication and leaves only one link', async () => {
    const root = await fixture(); const target = path.join(root, 'file');
    const result = await atomicWriteStableFileWithReceipt(target, 'exclusive');
    if (result.receipt) receipts.push(result.receipt);
    expect(result.error).toBeUndefined(); expect(result.publication).toBe('published');
    expect((await lstat(target)).nlink).toBe(1); expect(await readdir(root)).toEqual(['file']);
    await atomicWriteStableFile(target, 'rollback', { overwrite: true, expectedPublication: result.receipt });
    expect(await readFile(target, 'utf8')).toBe('rollback');
  });

  it('refuses foreign, cloned, destination-mismatched and disposed capabilities', async () => {
    const root = await fixture(); const target = path.join(root, 'file'); const receipt = await publish(target);
    for (const fake of [{}, { ...receipt }, structuredClone(receipt)]) {
      await expect(atomicWriteStableFile(target, 'foreign', { overwrite: true,
        expectedPublication: fake as StableFilePublicationReceipt })).rejects.toMatchObject({ code: 'invalid-receipt' });
    }
    await expect(atomicWriteStableFile(path.join(root, 'other'), 'wrong', { overwrite: true, expectedPublication: receipt }))
      .rejects.toMatchObject({ code: 'invalid-receipt' });
    await disposeStableFilePublicationReceipt(receipt);
    await expect(atomicWriteStableFile(target, 'disposed', { overwrite: true, expectedPublication: receipt }))
      .rejects.toMatchObject({ code: 'invalid-receipt' });
    expect(await readFile(target, 'utf8')).toBe('owned');
  });

  for (const mutation of ['replacement', 'in-place', 'mode', 'hardlink'] as const) {
    it(`refuses ${mutation} ABA even when bytes and restored mtime match`, async () => {
      const root = await fixture(); const target = path.join(root, 'file'); const receipt = await publish(target);
      const before = await lstat(target);
      if (mutation === 'replacement') {
        const external = path.join(root, 'external'); await writeFile(external, 'owned'); await chmod(external, 0o640);
        await utimes(external, before.atime, before.mtime); await rename(external, target);
      } else if (mutation === 'hardlink') await link(target, path.join(root, 'alias'));
      else {
        // Ensure a measurable ctime change even on coarse filesystems.
        await new Promise(resolve => setTimeout(resolve, 20));
        if (mutation === 'mode') { await chmod(target, 0o600); await chmod(target, 0o640); }
        else { await writeFile(target, 'other'); await writeFile(target, 'owned'); }
        await utimes(target, before.atime, before.mtime);
      }
      const externalIdentity = await lstat(target, { bigint: true });
      await expect(atomicWriteStableFile(target, 'rollback', { overwrite: true, expectedPublication: receipt }))
        .rejects.toMatchObject({ code: 'target-changed' });
      expect(await lstat(target, { bigint: true })).toMatchObject({ ino: externalIdentity.ino, ctimeNs: externalIdentity.ctimeNs });
      expect(await readFile(target, 'utf8')).toBe('owned');
    });
  }

  it('checks expected ownership again after staging and consumes a refused guard', async () => {
    const target = path.join(await fixture(), 'file'); const receipt = await publish(target);
    await expect(atomicWriteStableFile(target, 'rollback', { overwrite: true, expectedPublication: receipt,
      beforeCommit: async () => { await writeFile(target, 'alien'); await writeFile(target, 'owned'); },
    })).rejects.toMatchObject({ code: 'target-changed' });
    await expect(atomicWriteStableFile(target, 'again', { overwrite: true, expectedPublication: receipt }))
      .rejects.toMatchObject({ code: 'invalid-receipt' });
    expect(await readFile(target, 'utf8')).toBe('owned');
  });

  it('allows an owned identical-byte write but never makes its old receipt reusable', async () => {
    const target = path.join(await fixture(), 'file'); const receipt = await publish(target);
    const result = await atomicWriteStableFileWithReceipt(target, 'owned', { overwrite: true, expectedPublication: receipt });
    if (result.receipt) receipts.push(result.receipt);
    expect(result.error).toBeUndefined(); expect(result.receipt).not.toBe(receipt);
    await expect(atomicWriteStableFile(target, 'wrong', { overwrite: true, expectedPublication: receipt }))
      .rejects.toMatchObject({ code: 'invalid-receipt' });
  });

  it('reports pre-publication guard failure without a receipt, and closes both fds', async () => {
    const root = await fixture(); const target = path.join(root, 'file'); await writeFile(target, 'original');
    const baseline = await fdCount();
    const result = await atomicWriteStableFileWithReceipt(target, 'new', { overwrite: true, beforeCommit: async () => { throw new Error('guard'); } });
    expect(result).toMatchObject({ publication: 'not-published', error: new Error('guard') });
    expect(result.receipt).toBeUndefined(); expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['file']); expect(await fdCount()).toBe(baseline);
  });

  it('never blesses a post-rename identical-byte replacement from a path stat', async () => {
    const root = await fixture(); const target = path.join(root, 'file'); let externalInode: bigint | undefined;
    hooks.afterRename = async () => {
      const external = path.join(root, 'external'); await writeFile(external, 'owned'); await chmod(external, 0o640);
      await rename(external, target); externalInode = (await lstat(target, { bigint: true })).ino;
    };
    const result = await atomicWriteStableFileWithReceipt(target, 'owned', { overwrite: true, mode: 0o640 });
    if (result.receipt) receipts.push(result.receipt);
    expect(result).toMatchObject({ publication: 'published', error: { code: 'target-changed' } });
    expect(result.receipt).toBeDefined();
    await expect(atomicWriteStableFile(target, 'rollback', { overwrite: true, expectedPublication: result.receipt }))
      .rejects.toMatchObject({ code: 'target-changed' });
    expect((await lstat(target, { bigint: true })).ino).toBe(externalInode);
    expect(await readFile(target, 'utf8')).toBe('owned');
  });

  it('returns a disposable receipt on a post-capture validation error; default rejects but never leaks', async () => {
    const target = path.join(await fixture(), 'file'); const baseline = await fdCount();
    const failAfterRename = () => {
      hooks.afterRename = async () => { hooks.beforeLstat = async () => { throw new Error('post-publication'); }; };
    };
    failAfterRename();
    const result = await atomicWriteStableFileWithReceipt(target, 'new', { overwrite: true });
    if (result.receipt) receipts.push(result.receipt);
    try {
      expect(result.publication).toBe('published'); expect(result.error).toEqual(new Error('post-publication'));
      expect(result.receipt).toBeDefined(); expect(await readFile(target, 'utf8')).toBe('new');
      expect(await fdCount()).toBe(baseline + 2);
    } finally { hooks.beforeLstat = undefined; await disposeStableFilePublicationReceipt(result.receipt!); }
    failAfterRename();
    await expect(atomicWriteStableFile(target, 'next', { overwrite: true })).rejects.toThrow('post-publication');
    hooks.beforeLstat = undefined;
    expect(await readFile(target, 'utf8')).toBe('next'); expect(await fdCount()).toBe(baseline);
  });

  it('reports published-but-no-receipt when the owned fd capture itself fails, closing everything', async () => {
    const target = path.join(await fixture(), 'file'); const baseline = await fdCount();
    hooks.afterRename = async () => { vi.spyOn(hooks.stagingHandle!, 'stat').mockRejectedValueOnce(new Error('capture')); };
    const result = await atomicWriteStableFileWithReceipt(target, 'published', { overwrite: true });
    expect(result.publication).toBe('published'); expect(result.receipt).toBeUndefined();
    expect(result.error).toEqual(new Error('capture'));
    expect(await readFile(target, 'utf8')).toBe('published'); expect(await fdCount()).toBe(baseline);
  });

  it('rejects an in-place ABA after owned capture, never replacing the frozen identity', async () => {
    const target = path.join(await fixture(), 'file');
    hooks.afterRename = async () => {
      hooks.beforeLstat = async () => {
        hooks.beforeLstat = undefined;
        const info = await lstat(target);
        await new Promise(resolve => setTimeout(resolve, 20));
        await writeFile(target, 'other'); await writeFile(target, 'owned');
        await utimes(target, info.atime, info.mtime);
      };
    };
    const result = await atomicWriteStableFileWithReceipt(target, 'owned', { overwrite: true });
    if (result.receipt) receipts.push(result.receipt);
    expect(result).toMatchObject({ publication: 'published', error: { code: 'target-changed' } });
    await expect(atomicWriteStableFile(target, 'rollback', { overwrite: true, expectedPublication: result.receipt }))
      .rejects.toMatchObject({ code: 'target-changed' });
    expect(await readFile(target, 'utf8')).toBe('owned');
  });

  it('reports an uncertain attempted publication without leaking when capture is impossible', async () => {
    const target = path.join(await fixture(), 'file'); const baseline = await fdCount();
    hooks.afterRename = async () => { throw new Error('lost syscall result'); };
    const result = await atomicWriteStableFileWithReceipt(target, 'published', { overwrite: true });
    expect(result.publication).toBe('uncertain'); expect(result.receipt).toBeUndefined();
    expect(result.error).toEqual(new Error('lost syscall result'));
    expect(await readFile(target, 'utf8')).toBe('published'); expect(await fdCount()).toBe(baseline);
  });

  it('refuses a changed parent and retains no resources on failure', async () => {
    const root = await fixture(); const parent = path.join(root, 'parent'); await mkdir(parent);
    const target = path.join(parent, 'file'); const receipt = await publish(target);
    await rename(parent, path.join(root, 'previous')); await mkdir(parent); await writeFile(target, 'alien');
    await expect(atomicWriteStableFile(target, 'rollback', { overwrite: true, expectedPublication: receipt }))
      .rejects.toMatchObject({ code: 'invalid-receipt' });
    expect(await readFile(target, 'utf8')).toBe('alien');
  });

  it('reserves capacity for in-flight writes before opening any descriptors', async () => {
    const root = await fixture(); let entered = 0;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void; const allStaged = new Promise<void>(resolve => { ready = resolve; });
    const pending = Array.from({ length: 64 }, (_, index) => atomicWriteStableFileWithReceipt(path.join(root, String(index)), 'held', {
      beforeCommit: async () => { if (++entered === 64) ready(); await gate; },
    }));
    try {
      await allStaged;
      const overflow = await atomicWriteStableFileWithReceipt(path.join(root, 'overflow'), 'no');
      expect(overflow.error).toMatchObject({ code: 'receipt-limit' });
      expect(await readdir(root)).toHaveLength(64);
    } finally {
      release();
      const results = await Promise.all(pending);
      for (const result of results) {
        if (result.receipt) receipts.push(result.receipt);
        expect(result.error).toBeUndefined();
      }
    }
  });

  it('bounds retained resources and reclaims capacity after disposal/failures', async () => {
    const root = await fixture(); const baseline = await fdCount();
    for (let index = 0; index < 64; index++) await publish(path.join(root, String(index)));
    expect(await fdCount()).toBe(baseline + 128);
    const overflow = await atomicWriteStableFileWithReceipt(path.join(root, 'overflow'), 'no');
    expect(overflow).toMatchObject({ publication: 'not-published', error: { code: 'receipt-limit' } });
    expect(overflow.receipt).toBeUndefined();
    await disposeStableFilePublicationReceipt(receipts[0]);
    await publish(path.join(root, 'available'));
    await Promise.all(receipts.map(disposeStableFilePublicationReceipt));
    expect(await fdCount()).toBe(baseline);
    for (let index = 0; index < 70; index++) {
      const failed = await atomicWriteStableFileWithReceipt(path.join(root, 'missing', 'file'), 'no');
      expect(failed.error).toMatchObject({ code: 'unsafe-parent' });
    }
    expect(await fdCount()).toBe(baseline);
    expect(await atomicWriteStableFile(path.join(root, 'void-abi'), 'ok')).toBeUndefined();
    expect(await fdCount()).toBe(baseline);
  });
});
