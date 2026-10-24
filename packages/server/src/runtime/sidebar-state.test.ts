import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSidebarChange, SidebarStateStore } from './sidebar-state.js';

let root: string, file: string, store: SidebarStateStore;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'aih-sidebar-')); file = path.join(root, 'sidebar-state.json'); store = new SidebarStateStore(file); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const change = { kind: 'families', ids: ['root', 'other'], pinned: true, archived: true } as const;
const pin = () => ({ ...change, ids: [...change.ids] });

describe('independent private sidebar state', () => {
  it('persists a bounded bulk operation, refreshes another store and restores exact prior state', async () => {
    const initial = await store.read();
    const result = await store.mutate(initial.revision, pin());
    expect(result.state.families).toEqual(change.ids.map(id => ({ id, pinned: true, archived: true })));
    const restarted = new SidebarStateStore(file);
    expect(await restarted.read()).toEqual(result.state);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    const restored = await store.mutate(result.state.revision, undefined, result.undoToken);
    expect(restored.state.families).toEqual([]); expect(restored.state.revision).not.toBe(initial.revision);
    await expect(store.mutate(restored.state.revision, undefined, result.undoToken)).rejects.toMatchObject({ status: 409 });
  });
  it('admits only one concurrent writer and never loses the winning revision', async () => {
    const revision = (await store.read()).revision;
    const results = await Promise.allSettled([store.mutate(revision, pin()), new SidebarStateStore(file).mutate(revision, { kind: 'project', cwd: root, name: 'Other client' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409 });
    const winning = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof store.mutate>>>;
    expect(await store.read()).toEqual(winning.value.state);
    await expect(store.mutate(revision, pin())).rejects.toMatchObject({ code: 'sidebar-state-conflict' });
  });
  it('refuses undo after another mutation or expiry without touching bytes', async () => {
    const first = await store.mutate('initial', pin());
    const second = await store.mutate(first.state.revision, { kind: 'project', cwd: root, name: 'Project' });
    const bytes = await readFile(file);
    await expect(store.mutate(second.state.revision, undefined, first.undoToken)).rejects.toMatchObject({ status: 409 });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    await expect(store.mutate(second.state.revision, undefined, second.undoToken)).rejects.toMatchObject({ code: 'sidebar-undo-expired' });
    expect(await readFile(file)).toEqual(bytes);
  });
  it('moves projects, renames and resets without changing siblings', async () => {
    let state = (await store.mutate('initial', { kind: 'project', cwd: root, name: 'Custom' })).state;
    state = (await store.mutate(state.revision, { kind: 'move-project', cwd: '/other', before: root })).state;
    expect(state.projects).toEqual([{ cwd: '/other' }, { cwd: root, name: 'Custom' }]);
    state = (await store.mutate(state.revision, { kind: 'project', cwd: root, name: null })).state;
    expect(state.projects).toEqual([{ cwd: '/other' }, { cwd: root }]);
    state = (await store.mutate(state.revision, { kind: 'move-project', cwd: '/other', before: null })).state;
    expect(state.projects).toEqual([{ cwd: root }, { cwd: '/other' }]);
  });
  it.each([['linked', 'symlink'], ['hard-linked', 'hardlink'], ['malformed', 'json'], ['oversized', 'size']] as const)('fails closed on %s state', async (_label, kind) => {
    const target = path.join(root, 'target'); await writeFile(target, JSON.stringify(await store.read()));
    if (kind === 'symlink') await symlink(target, file);
    if (kind === 'hardlink') await link(target, file);
    if (kind === 'json') await writeFile(file, '{malformed');
    if (kind === 'size') await writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1));
    await expect(store.read()).rejects.toMatchObject({ status: 503 });
    await expect(store.mutate('initial', pin())).rejects.toMatchObject({ status: 503 });
    expect(await readFile(target, 'utf8')).toContain('initial');
  });
  it('bounds stored records before publishing and preserves a crash lock', async () => {
    await writeFile(file, JSON.stringify({ version: 1, revision: 'full', families: [], projects: Array.from({ length: 256 }, (_, i) => ({ cwd: `/p${i}` })) }));
    const bytes = await readFile(file);
    await expect(store.mutate('full', { kind: 'project', cwd: root, name: 'Overflow' })).rejects.toMatchObject({ status: 400, code: 'sidebar-state-limit' });
    expect(await readFile(file)).toEqual(bytes);
    await writeFile(file + '.lock', 'operator recovery required');
    await expect(store.mutate('full', pin())).rejects.toMatchObject({ code: 'sidebar-state-busy' });
    expect(await readFile(file + '.lock', 'utf8')).toBe('operator recovery required');
  });
  it.each([
    { kind: 'families', ids: ['x', 'x'], pinned: true }, { kind: 'families', ids: [], pinned: true },
    { kind: 'families', ids: ['draft:x'], archived: true }, { kind: 'families', ids: ['x'], pinned: 'true' },
    { kind: 'families', ids: Array.from({ length: 101 }, (_, i) => `${i}`), pinned: true },
    { kind: 'project', cwd: '/p', name: '\u0000' }, { kind: 'project', cwd: '/p', name: 'x'.repeat(121) },
    { kind: 'families', ids: ['x'], pinned: true, secret: 'not-accepted' }, { kind: 'unknown' },
  ])('rejects malformed or excessive input %#', value => {
    expect(() => parseSidebarChange(value)).toThrow('invalid-sidebar-change');
  });
});
