import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceManager } from './workspace-manager.js';
import { LinkedDirectoryConsent } from './linked-directory-consent.js';
import type { LinkedDirectoryInventory } from './linked-directory-types.js';
import * as stableDirectory from './stable-directory.js';
import { execFile } from 'node:child_process';
import { ExtensionRegistry, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { registerWorkspaceTools } from '../tools/workspace-tools.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aih-linked-')); temporary.push(base);
  const cwd = path.join(base, 'workspace'); const target = path.join(base, 'target'); const storeDirectory = path.join(base, 'private');
  await mkdir(cwd); await mkdir(target); await mkdir(storeDirectory, { mode: 0o700 });
  await writeFile(path.join(target, 'secret-name.txt'), 'TARGET_BODY_NEVER_BEFORE_CONSENT');
  await symlink('../target', path.join(cwd, 'external'));
  const manager = new WorkspaceManager({ allowedRoots: [cwd], defaultCwd: cwd }); await manager.initialize();
  const consent = new LinkedDirectoryConsent(manager, { storeDirectory });
  return { base, cwd, target, storeDirectory, manager, consent };
}
function selector(inventory: LinkedDirectoryInventory, name = 'external') {
  return { cwd: inventory.cwd, directory: inventory.directory, id: inventory.entries.find(entry => entry.name === name)!.id, revision: inventory.revision };
}
async function allow(f: Awaited<ReturnType<typeof fixture>>) {
  return f.consent.setConsent(selector(await f.consent.list(f.cwd)), true, true);
}

describe('linked directory consent boundary', () => {
  it('lists only source link metadata, exact targets and risk before consent; preserves default rejection', async () => {
    const f = await fixture();
    const inventory = await f.consent.list(f.cwd);
    expect(inventory.entries).toEqual([expect.objectContaining({ name: 'external', rawTarget: '../target', canonicalTarget: f.target, allowed: false, reason: 'directory' })]);
    expect(JSON.stringify(inventory)).not.toContain('TARGET_BODY');
    expect(JSON.stringify(inventory)).not.toContain('secret-name');
    await expect(f.consent.browse({ ...selector(inventory), path: '.' })).rejects.toMatchObject({ code: 'consent-required' });
    await expect(f.consent.read({ ...selector(inventory), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'consent-required' });
    await expect(f.manager.resolve('external')).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(f.manager.resolve(f.target)).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    expect(await lstat(path.join(f.storeDirectory, 'linked-directories.json')).catch(() => undefined)).toBeUndefined();
  });

  it('never opens a target directory during inventory or consent', async () => {
    const f = await fixture();
    const opens = vi.spyOn(stableDirectory, 'openStableDirectoryHandle');
    try {
      await f.consent.list(f.cwd);
      await allow(f);
      expect(opens.mock.calls.some(([directory]) => directory === f.target)).toBe(false);
      const allowed = await f.consent.list(f.cwd);
      await f.consent.read({ ...selector(allowed), path: 'secret-name.txt' });
      expect(opens.mock.calls.some(([directory]) => directory === f.target)).toBe(true);
    } finally { opens.mockRestore(); }
  });

  it('protects independent session/trust roots and their ancestors or descendants', async () => {
    const f = await fixture();
    const sessions = path.join(f.base, 'sessions'); const trustRoot = path.join(f.base, 'trust-root');
    await mkdir(sessions); await mkdir(trustRoot); await mkdir(path.join(sessions, 'nested'));
    for (const [name, target] of [['sessions', sessions], ['trust', trustRoot], ['nested', path.join(sessions, 'nested')]]) {
      await symlink(target, path.join(f.cwd, name));
    }
    const consent = new LinkedDirectoryConsent(f.manager, { storeDirectory: f.storeDirectory, protectedPaths: [sessions, trustRoot] });
    const inventory = await consent.list(f.cwd);
    for (const name of ['sessions', 'trust', 'nested']) {
      expect(inventory.entries.find(entry => entry.name === name)).toMatchObject({ reason: 'unsafe-target', allowed: false });
      await expect(consent.setConsent(selector(inventory, name), true, true)).rejects.toMatchObject({ code: 'unsafe-target' });
    }
  });

  it('runs fresh host authorization after selection but before any target open', async () => {
    const f = await fixture(); const allowed = await allow(f);
    const opens = vi.spyOn(stableDirectory, 'openStableDirectoryHandle');
    const refused = Object.assign(new Error('host policy refused'), { code: 'source-trust-required' });
    try {
      await expect(f.consent.read({ ...selector(allowed), path: 'secret-name.txt' }, async () => { throw refused; })).rejects.toBe(refused);
      expect(opens.mock.calls.some(([directory]) => directory === f.target)).toBe(false);
      let calls = 0;
      await expect(f.consent.read({ ...selector(allowed), path: 'secret-name.txt' }, async () => {
        if (++calls === 2) throw refused;
      })).rejects.toBe(refused);
      expect(calls).toBe(2);
    } finally { opens.mockRestore(); }
  });

  it('rejects FIFO and invalid UTF-8 bodies without blocking; flags oversized entries', async () => {
    const f = await fixture();
    await new Promise<void>((resolve, reject) => execFile('mkfifo', [path.join(f.target, 'fifo')], error => error ? reject(error) : resolve()));
    await writeFile(path.join(f.target, 'oversized'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await writeFile(path.join(f.target, 'invalid-utf8'), Buffer.from([0xff]));
    const selected = selector(await allow(f));
    const listing = await f.consent.browse({ ...selected, path: '.' });
    for (const name of ['fifo', 'oversized']) expect(listing.entries.find(entry => entry.name === name)?.blocked).toBe(true);
    for (const file of ['fifo', 'invalid-utf8']) await expect(f.consent.read({ ...selected, path: file })).rejects.toMatchObject({ code: 'unsafe-target' });
  });

  it('allows only selected directory descendants, never roots, parent/sibling, global files or trust', async () => {
    const f = await fixture(); const inventory = await allow(f); const selected = selector(inventory);
    expect((await f.consent.browse({ ...selected, path: '.' })).entries).toEqual([expect.objectContaining({ name: 'secret-name.txt', blocked: false })]);
    expect(await f.consent.read({ ...selected, path: 'secret-name.txt' })).toMatchObject({ content: 'TARGET_BODY_NEVER_BEFORE_CONSENT' });
    for (const value of ['../target/secret-name.txt', '/etc/passwd', 'external/../secret-name.txt', 'a//b', 'a/./b', 'a\\b', '', 'x'.repeat(4097), Array(65).fill('x').join('/')]) {
      await expect(f.consent.read({ ...selected, path: value })).rejects.toMatchObject({ code: 'invalid-request' });
    }
    await expect(f.manager.resolve('external')).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    await expect(f.manager.resolve(f.target)).rejects.toMatchObject({ code: 'OUTSIDE_ALLOWED_ROOTS' });
    expect(f.manager.getAllowedRoots()).toEqual([f.cwd]);
    const stored = await readFile(path.join(f.storeDirectory, 'linked-directories.json'), 'utf8');
    expect(stored).not.toContain(f.cwd); expect(stored).not.toContain(f.target); expect(stored).not.toContain('secret-name');
    expect((await lstat(path.join(f.storeDirectory, 'linked-directories.json'))).mode & 0o777).toBe(0o600);
    expect(await lstat(path.join(f.storeDirectory, 'trust.json')).catch(() => undefined)).toBeUndefined();
  });

  it('does not authorize the actual general read/write/list/bash tools even with trusted source context', async () => {
    const f = await fixture(); const granted = await allow(f);
    expect((await f.consent.read({ ...selector(granted), path: 'secret-name.txt' })).content).toContain('TARGET_BODY');
    const sessions = new SessionManager(); const registry = new ExtensionRegistry(); registry.attachSessionManager(sessions);
    await registerWorkspaceTools(registry, f.manager);
    const context: ExtensionRuntimeContext = { sessionManager: sessions, cwd: f.cwd, projectTrusted: true, notify: vi.fn() };
    for (const [tool, input] of [
      ['read', { path: 'external/secret-name.txt' }],
      ['write', { path: 'external/forbidden.txt', content: 'MUST_NOT_WRITE' }],
      ['ls', { path: 'external' }],
    ] as const) {
      await expect(registry.executeTool(tool, input, context)).rejects.toThrow(/outside|hors/i);
    }
    await expect(registry.executeTool('read', { path: 'secret-name.txt' }, { ...context, cwd: f.target })).rejects.toThrow(/outside|hors/i);
    await expect(registry.executeTool('bash', { command: 'printf MUST_NOT_EXECUTE' }, { ...context, cwd: f.target })).rejects.toThrow(/outside|hors/i);
    expect(await lstat(path.join(f.target, 'forbidden.txt')).catch(() => undefined)).toBeUndefined();
    expect(f.manager.getAllowedRoots()).toEqual([f.cwd]);
  });

  it('reloads persisted grants and revocations across independent instances without lost updates', async () => {
    const f = await fixture(); await symlink('../target', path.join(f.cwd, 'second'));
    const other = new LinkedDirectoryConsent(f.manager, { storeDirectory: f.storeDirectory });
    await allow(f);
    const inventory = await other.list(f.cwd);
    expect(inventory.entries.find(entry => entry.name === 'external')?.allowed).toBe(true);
    await other.setConsent(selector(inventory, 'second'), true, true);
    const latest = await f.consent.list(f.cwd);
    expect(latest.entries.every(entry => entry.allowed)).toBe(true);
    await f.consent.setConsent(selector(latest), false, true);
    const revoked = await other.list(f.cwd);
    expect(revoked.entries.find(entry => entry.name === 'external')?.allowed).toBe(false);
    expect(revoked.entries.find(entry => entry.name === 'second')?.allowed).toBe(true);
    await expect(other.read({ ...selector(revoked), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'consent-required' });
  });

  it('serializes concurrent exact revision writes and refuses the stale loser', async () => {
    const f = await fixture(); const initial = await f.consent.list(f.cwd);
    const other = new LinkedDirectoryConsent(f.manager, { storeDirectory: f.storeDirectory });
    const results = await Promise.allSettled([f.consent.setConsent(selector(initial), true, true), other.setConsent(selector(initial), true, true)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'stale-entry' } });
  });

  it('binds consent to source workspace/link rather than another path or workspace', async () => {
    const f = await fixture(); await allow(f);
    await symlink('../target', path.join(f.cwd, 'alias'));
    const inventory = await f.consent.list(f.cwd);
    expect(inventory.entries.find(entry => entry.name === 'alias')?.allowed).toBe(false);
    const otherCwd = path.join(f.cwd, 'other'); await mkdir(otherCwd); await symlink(f.target, path.join(otherCwd, 'external'));
    const other = await f.consent.list(otherCwd);
    expect(other.entries[0].allowed).toBe(false);
    await expect(f.consent.browse({ ...selector(inventory), cwd: otherCwd, path: '.' })).rejects.toMatchObject({ code: 'stale-entry' });
  });

  it('requires literal confirmation and exact opaque entry/revision, never path-shaped authority', async () => {
    const f = await fixture(); const inventory = await f.consent.list(f.cwd);
    await expect(f.consent.setConsent(selector(inventory), true, false as true)).rejects.toMatchObject({ code: 'invalid-request' });
    for (const wrong of [{ id: f.target }, { revision: f.target }, { id: '0'.repeat(64) }]) {
      await expect(f.consent.setConsent({ ...selector(inventory), ...wrong }, true, true)).rejects.toMatchObject({ code: 'stale-entry' });
    }
  });

  it('rejects changed link identity even for the same target and requires fresh consent', async () => {
    const f = await fixture(); const allowed = await allow(f);
    await rename(path.join(f.cwd, 'external'), path.join(f.cwd, 'old-link'));
    await symlink('../target', path.join(f.cwd, 'external'));
    await expect(f.consent.read({ ...selector(allowed), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'stale-entry' });
    const fresh = await f.consent.list(f.cwd);
    expect(fresh.entries.find(entry => entry.name === 'external')?.allowed).toBe(false);
    await expect(f.consent.read({ ...selector(fresh), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'consent-required' });
  });

  it('rejects target directory replacement at every operation, even when raw target is unchanged', async () => {
    const f = await fixture(); const allowed = await allow(f);
    await rename(f.target, `${f.target}-old`); await mkdir(f.target); await writeFile(path.join(f.target, 'secret-name.txt'), 'UNAUTHORIZED_REPLACEMENT');
    await expect(f.consent.browse({ ...selector(allowed), path: '.' })).rejects.toMatchObject({ code: 'stale-entry' });
    const fresh = await f.consent.list(f.cwd); expect(fresh.entries[0].allowed).toBe(false);
    await expect(f.consent.read({ ...selector(fresh), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'consent-required' });
  });

  it('rechecks a target swap between selection and the first target operation', async () => {
    const f = await fixture(); const allowed = await allow(f);
    const boundary = f.consent as unknown as { snapshot(cwd: string, directory: string): Promise<unknown> };
    const original = boundary.snapshot.bind(boundary);
    let calls = 0;
    const probe = vi.spyOn(boundary, 'snapshot').mockImplementation(async (cwd, directory) => {
      const value = await original(cwd, directory);
      if (++calls === 1) {
        await rename(f.target, `${f.target}-original`); await mkdir(f.target);
        await writeFile(path.join(f.target, 'secret-name.txt'), 'MUST_NEVER_READ_SWAPPED_BODY');
      }
      return value;
    });
    try {
      await expect(f.consent.read({ ...selector(allowed), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'stale-entry' });
      expect(calls).toBeGreaterThan(1);
    } finally { probe.mockRestore(); }
  });

  it('revocation acknowledgements serialize after in-flight reads and block every later read', async () => {
    const f = await fixture(); const allowed = await allow(f); const selected = selector(allowed);
    const boundary = f.consent as unknown as { snapshot(cwd: string, directory: string): Promise<unknown> };
    const original = boundary.snapshot.bind(boundary);
    let signalStarted!: () => void; let releaseRead!: () => void; let first = true;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const probe = vi.spyOn(boundary, 'snapshot').mockImplementation(async (cwd, directory) => {
      const value = await original(cwd, directory);
      if (first) { first = false; signalStarted(); await gate; }
      return value;
    });
    try {
      const reading = f.consent.read({ ...selected, path: 'secret-name.txt' });
      await started;
      const revoking = new LinkedDirectoryConsent(f.manager, { storeDirectory: f.storeDirectory }).setConsent(selected, false, true);
      releaseRead();
      const [read, revoked] = await Promise.all([reading, revoking]);
      expect(read.content).toBe('TARGET_BODY_NEVER_BEFORE_CONSENT');
      probe.mockRestore();
      await expect(f.consent.read({ ...selector(revoked), path: 'secret-name.txt' })).rejects.toMatchObject({ code: 'consent-required' });
    } finally { releaseRead(); probe.mockRestore(); }
  });

  it('refuses all nested symbolic/hard links and nonregular files including a nested escaping link', async () => {
    const f = await fixture(); await mkdir(path.join(f.target, 'nested'));
    await writeFile(path.join(f.target, 'nested', 'safe'), 'SAFE');
    await symlink('/etc', path.join(f.target, 'escape'));
    await symlink('nested', path.join(f.target, 'internal-link'));
    await symlink('nested/safe', path.join(f.target, 'file-link'));
    await link(path.join(f.target, 'nested', 'safe'), path.join(f.target, 'hardlink'));
    const allowed = await allow(f); const selected = selector(allowed);
    const listing = await f.consent.browse({ ...selected, path: '.' });
    expect(listing.entries.find(entry => entry.name === 'escape')?.blocked).toBe(true);
    for (const file of ['escape/passwd', 'internal-link/safe', 'file-link', 'hardlink', 'nested/safe']) {
      await expect(f.consent.read({ ...selected, path: file })).rejects.toMatchObject({ code: 'unsafe-target' });
    }
  });

  it('rejects files, unavailable, linked canonical targets and broad/protected target directories', async () => {
    const f = await fixture();
    await symlink('../target/secret-name.txt', path.join(f.cwd, 'file'));
    await symlink('../missing', path.join(f.cwd, 'missing'));
    await symlink('/', path.join(f.cwd, 'root'));
    await symlink(f.base, path.join(f.cwd, 'parent'));
    await symlink(f.storeDirectory, path.join(f.cwd, 'store'));
    await symlink(f.target, path.join(f.base, 'indirect')); await symlink('../indirect', path.join(f.cwd, 'chain'));
    const inventory = await f.consent.list(f.cwd);
    for (const name of ['file', 'missing', 'root', 'parent', 'store', 'chain']) {
      const entry = inventory.entries.find(entry => entry.name === name)!; expect(entry.reason).not.toBe('directory');
      await expect(f.consent.setConsent(selector(inventory, name), true, true)).rejects.toMatchObject({ code: 'unsafe-target' });
    }
  });

  it('warns about exact hidden characters without replacing the raw target', async () => {
    const f = await fixture(); const target = path.join(f.base, 'target\u202e'); await mkdir(target);
    await symlink('../target\u202e', path.join(f.cwd, 'hidden\u200b'));
    const inventory = await f.consent.list(f.cwd);
    expect(inventory.entries.find(entry => entry.name === 'hidden\u200b')).toMatchObject({ rawTarget: '../target\u202e', canonicalTarget: target, hiddenCharacters: true });
  });

  it('bounds inventories, descendant enumeration and bodies', async () => {
    const f = await fixture(); await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(f.target, `file-${index}`), 'x')));
    const allowed = await allow(f); expect(await f.consent.browse({ ...selector(allowed), path: '.' })).toMatchObject({ truncated: true, entries: expect.any(Array) });
    await writeFile(path.join(f.target, 'big'), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(f.consent.read({ ...selector(allowed), path: 'big' })).rejects.toMatchObject({ code: 'too-large' });
    await writeFile(path.join(f.target, 'binary'), Buffer.from([0, 255]));
    await expect(f.consent.read({ ...selector(allowed), path: 'binary' })).rejects.toMatchObject({ code: 'unsafe-target' });
  });

  it.each(['symlink', 'hardlink', 'malformed', 'public', 'oversized'])('fails closed on a %s consent store', async kind => {
    const f = await fixture(); await allow(f); const file = path.join(f.storeDirectory, 'linked-directories.json');
    if (kind === 'symlink') { await rm(file); await symlink(path.join(f.target, 'secret-name.txt'), file); }
    if (kind === 'hardlink') { await link(file, `${file}-copy`); }
    if (kind === 'malformed') await writeFile(file, '{}', { mode: 0o600 });
    if (kind === 'public') await chmod(file, 0o644);
    if (kind === 'oversized') await writeFile(file, 'x'.repeat(128 * 1024 + 1));
    await expect(f.consent.list(f.cwd)).rejects.toMatchObject({ code: 'store-unavailable' });
  });

  it('rejects linked store directories and store placement under the source', async () => {
    const f = await fixture(); const alias = path.join(f.base, 'alias'); await symlink(f.storeDirectory, alias);
    await expect(new LinkedDirectoryConsent(f.manager, { storeDirectory: alias }).list(f.cwd)).rejects.toMatchObject({ code: 'store-unavailable' });
    const localStore = path.join(f.cwd, 'private'); await mkdir(localStore, { mode: 0o700 });
    await expect(new LinkedDirectoryConsent(f.manager, { storeDirectory: localStore }).list(f.cwd)).rejects.toMatchObject({ code: 'store-unavailable' });
  });
});

vi.mock('node:fs/promises', { spy: true });
// Supplemental exact reviewer negative. Existing 25 assertions/tests above are unchanged.
it('review: freshly authorizes before opening each descendant handle', async () => {
  const f = await fixture(); const granted = await allow(f);
  const fsPromises = await import('node:fs/promises');
  const actualOpen = (await vi.importActual<typeof fsPromises>('node:fs/promises')).open; let fileOpened = false;
  const probe = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: Parameters<typeof actualOpen>) => {
    if (String(args[0]).endsWith('/secret-name.txt')) fileOpened = true;
    return actualOpen(...args);
  });
  let checks = 0;
  const refused = Object.assign(new Error('source trust revoked after root authorization'), { code: 'source-trust-required' });
  try {
    await expect(f.consent.read({ ...selector(granted), path: 'secret-name.txt' }, async () => {
      if (++checks === 2) throw refused;
    })).rejects.toBe(refused);
    expect(fileOpened, 'descendant file handle must not be opened before fresh authorization').toBe(false);
  } finally { probe.mockRestore(); }
});
