import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceManager, WorkspacePathError } from './workspace-manager.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-workspace-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('WorkspaceManager', () => {
  it('canonicalizes paths, expands home, and blocks traversal and escaping symlinks', async () => {
    const base = await temporaryDirectory();
    const root = path.join(base, 'allowed');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, 'nested', 'file.txt'), 'safe');
    await symlink(outside, path.join(root, 'escape'));
    const manager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root, homeDir: root });
    await manager.initialize();

    await expect(manager.resolve('~/nested/file.txt', { kind: 'file' })).resolves.toBe(path.join(root, 'nested', 'file.txt'));
    await expect(manager.resolve('../outside')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(manager.resolve(path.join(root, 'escape'))).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'OUTSIDE_ALLOWED_ROOTS' });

    const listing = await manager.browse(root);
    expect(listing.entries.find(entry => entry.name === 'escape')).toMatchObject({ isSymbolicLink: true, isDirectory: false });
    expect(listing.parent).toBeUndefined();
  });

  it('detects Git state and safely creates, lists, and removes worktrees', async () => {
    const base = await temporaryDirectory();
    const repository = path.join(base, 'repository');
    const worktree = path.join(base, 'feature-worktree');
    await mkdir(repository);
    await execFileAsync('git', ['init', '-b', 'main', repository]);
    await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
    await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await writeFile(path.join(repository, 'README.md'), '# test\n');
    await execFileAsync('git', ['-C', repository, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repository, 'commit', '-m', 'initial']);

    const manager = new WorkspaceManager({ allowedRoots: [base], defaultCwd: repository });
    await manager.initialize();
    await expect(manager.describe(repository, true)).resolves.toMatchObject({
      trusted: true,
      git: { root: repository, branch: 'main', detached: false },
    });

    await manager.createWorktree({ cwd: repository, path: worktree, branch: 'feature/test', createBranch: true });
    expect(await manager.listWorktrees(repository)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: worktree, branch: 'feature/test' }),
    ]));
    await manager.removeWorktree(repository, worktree);
    expect((await manager.listWorktrees(repository)).some(item => item.path === worktree)).toBe(false);

    await expect(manager.createWorktree({ cwd: repository, path: worktree, branch: '--unsafe', createBranch: true }))
      .rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
  });
});
