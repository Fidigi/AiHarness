import { execFile } from 'node:child_process';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspacePathError } from './workspace-manager.js';
import { WORKSPACE_BROWSE_ENTRY_LIMIT, WorkspaceManager } from './workspace-manager.js';

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
    await symlink(path.join(root, 'nested', 'file.txt'), path.join(root, 'linked-file'));
    await link(path.join(root, 'nested', 'file.txt'), path.join(root, 'hardlinked-file'));
    const manager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root, homeDir: root });
    await manager.initialize();

    await expect(manager.resolve('~/nested/file.txt', { kind: 'file' })).resolves.toBe(path.join(root, 'nested', 'file.txt'));
    await expect(manager.resolve('../outside')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(manager.resolve(path.join(root, 'escape'))).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(manager.resolveDestination('linked-file', { kind: 'file' }))
      .rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
    await expect(manager.resolveStableFile('hardlinked-file'))
      .rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
    await expect(manager.resolveDestination('../outside/new.txt', { kind: 'file' }))
      .rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(manager.resolveDestination('new.txt', { kind: 'file' }))
      .resolves.toBe(path.join(root, 'new.txt'));
    await expect(manager.ensureDirectory('deep/tree', { base: root }))
      .resolves.toBe(path.join(root, 'deep', 'tree'));

    const created = await manager.createDirectory(root, 'created');
    expect(created).toBe(path.join(root, 'created'));
    await expect(manager.createDirectory(root, 'created')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'ALREADY_EXISTS' });
    await expect(manager.createDirectory(root, '../outside')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
    await expect(manager.createDirectory(root, 'CON.txt')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
    await expect(manager.createDirectory(root, 'trailing.')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
    await expect(manager.createDirectory(path.join(root, 'escape'), 'unsafe')).rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'OUTSIDE_ALLOWED_ROOTS' });

    const listing = await manager.browse(root);
    expect(listing.entries.find(entry => entry.name === 'created')).toMatchObject({ isDirectory: true, isSymbolicLink: false });
    expect(listing.entries.find(entry => entry.name === 'escape')).toMatchObject({ isSymbolicLink: true, isDirectory: false });
    expect(listing.parent).toBeUndefined();
    expect(listing.truncated).toBe(false);
  });

  it('rejects overlong and overly deep paths before any filesystem probe', async () => {
    const root = await temporaryDirectory();
    const manager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
    await manager.initialize();
    for (const value of ['x'.repeat(4_097), Array(65).fill('x').join('/')]) {
      await expect(manager.resolve(value)).rejects.toMatchObject({ code: 'INVALID_PATH' });
      await expect(manager.resolveDestination(value)).rejects.toMatchObject({ code: 'INVALID_PATH' });
      await expect(manager.ensureDirectory(value)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    }
    expect(manager.getAllowedRoots()).toEqual([root]);
  });

  it('bounds directory browsing and reports truncation', async () => {
    const root = await temporaryDirectory();
    await Promise.all(Array.from({ length: WORKSPACE_BROWSE_ENTRY_LIMIT + 1 }, (_, index) =>
      mkdir(path.join(root, `directory-${String(index).padStart(4, '0')}`))));
    const manager = new WorkspaceManager({ allowedRoots: [root], defaultCwd: root });
    await manager.initialize();

    const listing = await manager.browse(root);
    expect(listing.entries).toHaveLength(WORKSPACE_BROWSE_ENTRY_LIMIT);
    expect(listing.truncated).toBe(true);
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
    await expect(manager.describe(repository, false)).resolves.toEqual(expect.not.objectContaining({ git: expect.anything() }));
    await expect(manager.describe(repository, true)).resolves.toMatchObject({
      trusted: true,
      git: { root: repository, branch: 'main', detached: false },
    });

    await manager.createWorktree({ cwd: repository, path: worktree, branch: 'feature/test', createBranch: true });
    expect(await manager.listWorktrees(repository)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: worktree, branch: 'feature/test' }),
    ]));
    const worktreeLink = path.join(base, 'feature-worktree-link');
    await symlink(worktree, worktreeLink);
    await writeFile(path.join(worktree, 'local-change.txt'), 'not committed');
    await expect(manager.removeWorktree(repository, worktreeLink)).rejects
      .toMatchObject<Partial<WorkspacePathError>>({ code: 'FORCE_REQUIRED' });
    await manager.removeWorktree(repository, worktreeLink, true);
    expect((await manager.listWorktrees(repository)).some(item => item.path === worktree)).toBe(false);

    await expect(manager.createWorktree({ cwd: repository, path: worktree, branch: '--unsafe', createBranch: true }))
      .rejects.toMatchObject<Partial<WorkspacePathError>>({ code: 'INVALID_PATH' });
  });
});
