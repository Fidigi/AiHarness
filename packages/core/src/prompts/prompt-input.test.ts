import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../security/workspace-manager.js';
import { loadPromptFiles } from './prompt-input.js';

const temporaryDirectories: string[] = [];

async function setup(): Promise<{ root: string; workspace: WorkspaceManager }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-prompt-input-'));
  temporaryDirectories.push(root);
  const workspace = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
  await workspace.initialize();
  return { root, workspace };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('loadPromptFiles', () => {
  it('loads UTF-8 text and supported images through one bounded contract', async () => {
    const { root, workspace } = await setup();
    await writeFile(path.join(root, 'notes & plan.txt'), '\ufeffhello\nworld');
    await writeFile(path.join(root, 'pixel.png'), Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
    ]));

    const loaded = await loadPromptFiles(workspace, root, ['notes & plan.txt', 'pixel.png']);

    expect(loaded.text).toContain('<file name="notes &amp; plan.txt">\nhello\nworld\n</file>');
    expect(loaded.text).toContain('<file name="pixel.png"></file>');
    expect(loaded.images).toEqual([
      expect.objectContaining({
        type: 'image', mediaType: 'image/png', name: 'pixel.png',
        url: expect.stringMatching(/^data:image\/png;base64,/),
      }),
    ]);
    expect(loaded.files.map(file => file.mediaType)).toEqual(['text/plain', 'image/png']);
  });

  it('rejects binary text, oversized input, traversal, and escaping links', async () => {
    const { root, workspace } = await setup();
    await writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, 'large.txt'), 'too large');
    await expect(loadPromptFiles(workspace, root, ['binary.bin'])).rejects.toThrow(/binary/i);
    await expect(loadPromptFiles(workspace, root, ['large.txt'], { maxTextBytes: 2 })).rejects.toThrow(/limit/i);
    await expect(loadPromptFiles(workspace, root, ['../outside.txt'])).rejects.toThrow();

    const outside = await mkdtemp(path.join(os.tmpdir(), 'aih-prompt-outside-'));
    temporaryDirectories.push(outside);
    await mkdir(path.join(outside, 'folder'));
    await writeFile(path.join(outside, 'folder', 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'folder'), path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(loadPromptFiles(workspace, root, ['escape/secret.txt'])).rejects.toThrow(/hors|outside/i);
  });

  it('honours cancellation and aggregate limits', async () => {
    const { root, workspace } = await setup();
    await writeFile(path.join(root, 'one.txt'), '1234');
    await writeFile(path.join(root, 'two.txt'), '5678');
    await expect(loadPromptFiles(workspace, root, ['one.txt', 'two.txt'], { maxTotalBytes: 7 }))
      .rejects.toThrow(/total limit/i);

    const controller = new AbortController();
    controller.abort();
    await expect(loadPromptFiles(workspace, root, ['one.txt'], {}, controller.signal)).rejects.toThrow(/aborted/i);
  });
});
