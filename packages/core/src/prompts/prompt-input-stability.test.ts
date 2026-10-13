import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type * as Filesystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceManager } from '../security/workspace-manager.js';
import { loadPromptFiles } from './prompt-input.js';

const io = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined,
  opened: [] as Array<Filesystem.FileHandle> }));
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof Filesystem>();
  return { ...filesystem, open: async (...args: Parameters<typeof filesystem.open>) => {
    const handle = await filesystem.open(...args);
    io.opened.push(handle);
    if (String(args[0]).endsWith('/notes.txt')) {
      handle.read = new Proxy(handle.read, { apply: async (read, receiver, args) => {
        const result = await Reflect.apply(read, receiver, args);
        const callback = io.afterRead;
        io.afterRead = undefined;
        await callback?.();
        return result;
      } });
    }
    return handle;
  } };
});

const directories: string[] = [];
afterEach(async () => {
  io.afterRead = undefined;
  io.opened = [];
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-prompt-stability-'));
  directories.push(root);
  const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(path.join(outside, 'notes.txt'), 'private-fixture-content');
  const workspace = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd });
  await workspace.initialize();
  return { cwd, outside, workspace };
}

function afterFileResolution(workspace: WorkspaceManager, mutate: (file: string) => Promise<void>) {
  const resolve = workspace.resolve.bind(workspace);
  vi.spyOn(workspace, 'resolve').mockImplementation(async (...args) => {
    const resolved = await resolve(...args);
    if (args[1]?.kind === 'file') await mutate(resolved);
    return resolved;
  });
}

describe('prompt input stable filesystem boundary', () => {
  it('refuses a file replaced by an outside symbolic link after canonical validation', async () => {
    const { cwd, outside, workspace } = await setup();
    await writeFile(path.join(cwd, 'notes.txt'), 'safe');
    afterFileResolution(workspace, async file => {
      await rm(file);
      await symlink(path.join(outside, 'notes.txt'), file);
    });
    await expect(loadPromptFiles(workspace, cwd, ['notes.txt'])).rejects.toThrow();
  });

  it('refuses a canonical parent replaced by an outside directory link after validation', async () => {
    const { cwd, outside, workspace } = await setup();
    const folder = path.join(cwd, 'folder');
    await mkdir(folder);
    await writeFile(path.join(folder, 'notes.txt'), 'safe');
    afterFileResolution(workspace, async () => {
      await rename(folder, `${folder}-original`);
      await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    });
    await expect(loadPromptFiles(workspace, cwd, ['folder/notes.txt'])).rejects.toThrow();
  });

  it('refuses a file replaced by a hard link after validation', async () => {
    const { cwd, outside, workspace } = await setup();
    await writeFile(path.join(cwd, 'notes.txt'), 'safe');
    afterFileResolution(workspace, async file => {
      await rm(file);
      await link(path.join(outside, 'notes.txt'), file);
    });
    await expect(loadPromptFiles(workspace, cwd, ['notes.txt'])).rejects.toThrow();
  });

  it('refuses a hard-linked prompt even without a resolution race', async () => {
    const { cwd, outside, workspace } = await setup();
    await link(path.join(outside, 'notes.txt'), path.join(cwd, 'notes.txt'));
    await expect(loadPromptFiles(workspace, cwd, ['notes.txt'])).rejects.toThrow();
  });

  it('preserves safe workspace aliases after canonicalization and does not change text bytes', async () => {
    const { cwd, workspace } = await setup();
    await mkdir(path.join(cwd, 'real'));
    await writeFile(path.join(cwd, 'real', 'notes.txt'), 'safe\r\ntext');
    await symlink(path.join(cwd, 'real'), path.join(cwd, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(path.join(cwd, 'real', 'notes.txt'), path.join(cwd, 'alias.txt'));
    for (const request of ['alias/notes.txt', 'alias.txt']) {
      const loaded = await loadPromptFiles(workspace, cwd, [request]);
      expect(loaded).toEqual({ text: '<file name="real/notes.txt">\nsafe\r\ntext\n</file>\n', images: [],
        files: [{ path: 'real/notes.txt', size: 10, mediaType: 'text/plain' }] });
    }
  });

  it('preserves empty files and every existing supported image signature at exact byte limits', async () => {
    const { cwd, workspace } = await setup();
    const images = [
      { name: 'png', mediaType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
      { name: 'jpeg', mediaType: 'image/jpeg', bytes: Buffer.from([255, 216, 255]) },
      { name: 'gif', mediaType: 'image/gif', bytes: Buffer.from('GIF89a') },
      { name: 'webp', mediaType: 'image/webp', bytes: Buffer.from('RIFF0000WEBP') },
    ];
    await writeFile(path.join(cwd, 'empty'), '');
    expect(await loadPromptFiles(workspace, cwd, ['empty'])).toEqual({ text: '', images: [], files: [] });
    for (const image of images) {
      await writeFile(path.join(cwd, image.name), image.bytes);
      const loaded = await loadPromptFiles(workspace, cwd, [image.name], {
        maxImageBytes: image.bytes.length, maxTotalBytes: image.bytes.length,
      });
      expect(loaded.images).toEqual([{ type: 'image', name: image.name, size: image.bytes.length,
        mediaType: image.mediaType, url: `data:${image.mediaType};base64,${image.bytes.toString('base64')}` }]);
      expect(loaded.files).toEqual([{ path: image.name, size: image.bytes.length, mediaType: image.mediaType }]);
    }
  });

  it('refuses an in-place same-size content change during a real descriptor read and closes every handle', async () => {
    const { cwd, workspace } = await setup();
    const file = path.join(cwd, 'notes.txt');
    await writeFile(file, 'safe');
    io.afterRead = async () => { await writeFile(file, 'evil'); };
    await expect(loadPromptFiles(workspace, cwd, ['notes.txt'])).rejects.toThrow(/changed/i);
    expect(io.opened.length).toBeGreaterThan(0);
    expect(io.opened.every(handle => handle.fd === -1)).toBe(true);
  });

  it('refuses a parent replaced during descriptor reading without returning the held original bytes', async () => {
    const { cwd, outside, workspace } = await setup();
    const folder = path.join(cwd, 'folder');
    await mkdir(folder);
    await writeFile(path.join(folder, 'notes.txt'), 'safe');
    io.afterRead = async () => {
      await rename(folder, `${folder}-original`);
      await symlink(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
    };
    await expect(loadPromptFiles(workspace, cwd, ['folder/notes.txt'])).rejects.toThrow(/changed/i);
    expect(io.opened.every(handle => handle.fd === -1)).toBe(true);
  });

  it('honours cancellation at an empty-file EOF and closes every handle without exposing its reason', async () => {
    const { cwd, workspace } = await setup();
    await writeFile(path.join(cwd, 'notes.txt'), '');
    const controller = new AbortController();
    io.afterRead = async () => { controller.abort('private-fixture-reason'); };
    await expect(loadPromptFiles(workspace, cwd, ['notes.txt'], {}, controller.signal))
      .rejects.toThrow('Operation aborted.');
    expect(io.opened.every(handle => handle.fd === -1)).toBe(true);
  });

  it('honours cancellation raised during path validation without reflecting its reason', async () => {
    const { cwd, workspace } = await setup();
    await writeFile(path.join(cwd, 'notes.txt'), 'safe');
    const controller = new AbortController();
    afterFileResolution(workspace, async () => { controller.abort('private-fixture-reason'); });
    await expect(loadPromptFiles(workspace, cwd, ['notes.txt'], {}, controller.signal))
      .rejects.toThrow('Operation aborted.');
  });
});
