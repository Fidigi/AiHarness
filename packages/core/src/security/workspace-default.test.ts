import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './workspace-manager.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aih-default-workspace-'));
  roots.push(base);
  const home = path.join(base, 'home');
  const project = path.join(home, 'project');
  await mkdir(project, { recursive: true });
  return { base, home, project };
}

describe('canonical default workspace and display paths', () => {
  it.each(['absolute', 'relative', 'home'] as const)('resolves a %s default with the same directory validator', async kind => {
    const { home, project } = await fixture();
    const defaultCwd = kind === 'home' ? '~/project' : kind === 'relative' ? path.relative(process.cwd(), project) : project;
    const manager = new WorkspaceManager({ allowedRoots: [home], defaultCwd, homeDir: home });
    await manager.initialize();
    expect(await manager.getDefaultCwd()).toBe(project);
    expect(await manager.resolve('~/project', { kind: 'directory' })).toBe(project);
    expect(await manager.resolve('project', { base: home, kind: 'directory' })).toBe(project);
    expect(await manager.describe(await manager.getDefaultCwd(), false)).toMatchObject({ cwd: project, displayPath: '~/project' });
    expect(manager.getAllowedRoots()).toEqual([home]);
  });

  it.each(['root', 'child'] as const)('preserves a default through an explicitly declared symlink %s without widening ordinary path authority', async kind => {
    const { base, home, project } = await fixture();
    const alias = path.join(base, 'declared-home'); await symlink(home, alias);
    const manager = new WorkspaceManager({ allowedRoots: [alias], defaultCwd: kind === 'root' ? alias : path.join(alias, 'project'), homeDir: home });
    await manager.initialize();
    expect(await manager.getDefaultCwd()).toBe(kind === 'root' ? home : project);
    expect(await manager.resolve('.')).toBe(kind === 'root' ? home : project);
    expect(manager.getAllowedRoots()).toEqual([home]);
    await expect(manager.resolve(alias)).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
  });

  it.each(['removed', 'retargeted'] as const)('rejects a %s declared default alias rather than falling back to its old canonical target', async kind => {
    const { base, home } = await fixture();
    const alias = path.join(base, 'declared-home'); await symlink(home, alias);
    const manager = new WorkspaceManager({ allowedRoots: [alias], defaultCwd: alias, homeDir: home });
    await manager.initialize();
    await rm(alias);
    if (kind === 'retargeted') { const outside = path.join(base, 'outside'); await mkdir(outside); await symlink(outside, alias); }
    const code = kind === 'removed' ? 'NOT_FOUND' : 'OUTSIDE_ALLOWED_ROOTS';
    await expect(manager.getDefaultCwd()).rejects.toMatchObject({ code });
    await expect(manager.resolve('.')).rejects.toMatchObject({ code });
    expect(await manager.resolve(home)).toBe(home);
    expect(manager.getAllowedRoots()).toEqual([home]);
  });

  it('shortens only canonical home descendants, never home-prefix siblings, and canonicalizes aliases', async () => {
    const { base, home, project } = await fixture();
    const sibling = path.join(base, 'home-other');
    const alias = path.join(base, 'home-alias');
    await mkdir(sibling);
    await symlink(home, alias);
    const manager = new WorkspaceManager({ allowedRoots: [base], defaultCwd: path.join(alias, 'project'), homeDir: alias });
    await manager.initialize();
    expect(await manager.getDefaultCwd()).toBe(project);
    expect(await manager.describe(home, false)).toMatchObject({ cwd: home, displayPath: '~' });
    expect(await manager.describe(path.join(alias, 'project'), false)).toEqual(await manager.describe(project, false));
    expect(await manager.describe(sibling, false)).toMatchObject({ cwd: sibling, displayPath: sibling });
  });

  it.each(['missing', 'file', 'outside', 'escape', 'empty', 'nul'] as const)('refuses a %s default without substituting another root', async kind => {
    const { base, home } = await fixture();
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(home, 'file'), 'not a directory');
    await symlink(outside, path.join(home, 'escape'));
    const defaultCwd = kind === 'empty' ? '' : kind === 'nul' ? 'bad\0path' : kind === 'outside' ? outside : path.join(home, kind);
    const code = kind === 'outside' || kind === 'escape' ? 'OUTSIDE_ALLOWED_ROOTS'
      : kind === 'file' ? 'WRONG_KIND' : kind === 'missing' ? 'NOT_FOUND' : 'INVALID_PATH';
    const manager = new WorkspaceManager({ allowedRoots: [home], defaultCwd, homeDir: home });
    await manager.initialize();
    await expect(manager.getDefaultCwd()).rejects.toMatchObject({ code });
    await expect(manager.resolve(defaultCwd, { kind: 'directory' })).rejects.toMatchObject({ code });
    expect(await manager.resolve(home, { kind: 'directory' })).toBe(home);
    expect(manager.getAllowedRoots()).toEqual([home]);
  });

  it('does not silently rebase relative reads/writes when the default disappears; explicit valid paths still recover', async () => {
    const { home, project } = await fixture();
    const manager = new WorkspaceManager({ allowedRoots: [home], defaultCwd: project, homeDir: home });
    await manager.initialize();
    await rm(project, { recursive: true });
    await expect(manager.getDefaultCwd()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(manager.resolve('.')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(manager.resolveDestination('new.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(manager.ensureDirectory('new-directory')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await manager.resolve(home, { kind: 'directory' })).toBe(home);
    expect(await manager.resolveDestination(path.join(home, 'new.txt'))).toBe(path.join(home, 'new.txt'));
    await expect(manager.resolve(home, { base: project })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(manager.getAllowedRoots()).toEqual([home]);
  });

  it('rechecks a replaced default symlink against current allowed roots', async () => {
    const { base, home, project } = await fixture();
    const alias = path.join(home, 'selected');
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await symlink(project, alias);
    const manager = new WorkspaceManager({ allowedRoots: [home], defaultCwd: alias, homeDir: home });
    await manager.initialize();
    expect(await manager.getDefaultCwd()).toBe(project);
    await rm(alias); await symlink(outside, alias);
    await expect(manager.getDefaultCwd()).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(manager.resolve('.', { kind: 'directory' })).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
  });
});
