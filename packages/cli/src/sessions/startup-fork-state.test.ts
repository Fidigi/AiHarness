import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore, SessionManager, type SessionEntry } from '@ai-harness/core';
import { resolveStartupSession, type StartupSessionArguments } from './startup-session.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-startup-state-')); roots.push(root); return root; }
const args = (value: Partial<StartupSessionArguments>): StartupSessionArguments => ({ continueSession: false, resume: false, noSession: false, ...value });
const revisions = (entries: SessionEntry[]) => entries.flatMap(entry => entry.type === 'custom'
  && entry.customType === 'fixture:startup' ? [(entry.data as { revision: number }).revision] : []);
async function seed(manager: SessionManager) {
  const source = await manager.create({ id: 'startup-source', title: 'Source', cwd: '/old', workspaceId: 'old-workspace', model: 'model-a', thinking: 'high', toolPreset: 'read-only' });
  await manager.addMessage(source.id, { role: 'user', content: 'Keep user' });
  await manager.appendCustomEntry(source.id, 'fixture:startup', { revision: 1, private: 'PRIVATE_STARTUP' });
  await manager.appendCustomMessage(source.id, 'fixture:startup-note', 'VISIBLE_STARTUP', { display: false, details: 'PRIVATE_DETAILS' });
  await manager.addMessage(source.id, { role: 'assistant', content: 'Keep answer' });
  return source;
}

describe.each(['id', 'prefix', 'file'] as const)('startup rich fork selection (%s)', selector => {
  it.each(['memory', 'disabled', 'durable'] as const)('preserves owning private ancestry/settings with a %s destination', async mode => {
    const root = await temporary(), targetStore = new JsonlSessionStore(path.join(root, 'target'), mode !== 'disabled');
    const manager = new SessionManager(mode === 'memory' ? {} : { store: targetStore });
    const sourceStore = selector === 'file' ? new JsonlSessionStore(path.join(root, 'source')) : targetStore;
    const sourceManager = selector === 'file' ? new SessionManager({ store: sourceStore }) : manager;
    const source = await seed(sourceManager);
    const file = selector === 'file' ? path.join(root, 'source', `${source.id}.jsonl`) : undefined;
    const before = file ? await readFile(file) : undefined, info = file ? await stat(file, { bigint: true }) : undefined;
    const fork = await resolveStartupSession({ sessionManager: manager,
      args: args({ fork: file ?? (selector === 'prefix' ? 'startup-sou' : source.id), sessionId: 'startup-destination', name: 'Named fork' }),
      cwd: '/new', workspaceId: 'new-workspace', interactive: false });
    expect(fork).toMatchObject({ id: 'startup-destination', title: 'Named fork', parentId: source.id, branchId: source.id,
      cwd: '/new', workspaceId: 'new-workspace', model: 'model-a', thinking: 'high', toolPreset: 'read-only' });
    expect(fork.messages.map(message => message.content)).toEqual(['Keep user', 'Keep answer']);
    // Assert the substantive state copy before consulting the newly added active reader.
    expect(revisions(await manager.getRawEntries(fork.id))).toEqual([1]);
    expect(revisions(await manager.getActiveBranchEntries(fork.id))).toEqual([1]);
    const model = JSON.stringify(manager.getEffectiveContext(fork.id));
    expect(model).toContain('VISIBLE_STARTUP'); expect(model).not.toContain('PRIVATE_STARTUP'); expect(model).not.toContain('PRIVATE_DETAILS');
    expect(sourceManager.get(source.id)?.title).toBe('Source');
    if (file) {
      expect(manager.get(source.id)).toBeUndefined(); expect(await sourceStore.listSessionIds()).toEqual([source.id]);
      expect(await readFile(file)).toEqual(before); expect((await stat(file, { bigint: true })).mtimeNs).toBe(info!.mtimeNs);
    }
    if (mode === 'durable') {
      const reopened = new SessionManager({ store: targetStore }); await reopened.loadFromStore(fork.id);
      expect(revisions(await reopened.getActiveBranchEntries(fork.id))).toEqual([1]);
    }
  });
});

describe('startup fork refusals and precedence', () => {
  it('captures destination identity, title and workspace before awaiting an explicit source file', async () => {
    const root = await temporary(), source = new SessionManager({ store: new JsonlSessionStore(root) }); await seed(source);
    const manager = new SessionManager(), startupArgs = args({ fork: path.join(root, 'startup-source.jsonl'), sessionId: 'captured-id', name: 'Captured title' });
    const options = { sessionManager: manager, args: startupArgs, cwd: '/captured', workspaceId: 'captured-workspace', interactive: false };
    const pending = resolveStartupSession(options);
    startupArgs.fork = path.join(root, 'missing.jsonl'); startupArgs.sessionId = 'changed-id'; startupArgs.name = 'Changed title';
    options.cwd = '/changed'; options.workspaceId = 'changed-workspace';
    expect(await pending).toMatchObject({ id: 'captured-id', title: 'Captured title', cwd: '/captured', workspaceId: 'captured-workspace' });
    expect(manager.get('changed-id')).toBeUndefined(); expect(revisions(await manager.getActiveBranchEntries('captured-id'))).toEqual([1]);
  });

  it('refuses an existing explicit destination without mutating either session', async () => {
    const manager = new SessionManager(), source = await seed(manager);
    await manager.create({ id: 'occupied', title: 'Keep destination' });
    await expect(resolveStartupSession({ sessionManager: manager, args: args({ fork: source.id, sessionId: 'occupied' }), cwd: '/new', interactive: false }))
      .rejects.toThrow('Session already exists with ID: occupied');
    expect(manager.get('occupied')?.title).toBe('Keep destination'); expect(revisions(await manager.getActiveBranchEntries(source.id))).toEqual([1]);
    expect(manager.list()).toHaveLength(2);
  });

  it.each(['missing', 'directory', 'symlink'] as const)('refuses an explicit %s file source without creating a destination', async kind => {
    const root = await temporary(), source = new SessionManager({ store: new JsonlSessionStore(root) }); await seed(source);
    const real = path.join(root, 'startup-source.jsonl'), link = path.join(root, 'linked.jsonl');
    if (kind === 'symlink') await symlink(real, link);
    const file = kind === 'missing' ? path.join(root, 'missing.jsonl') : kind === 'directory' ? root : link;
    const manager = new SessionManager();
    await expect(resolveStartupSession({ sessionManager: manager, args: args({ fork: file }), cwd: '/new', interactive: false }))
      .rejects.toThrow(kind === 'missing' ? 'Session file not found' : 'Session path must be a regular file');
    expect(manager.list()).toEqual([]);
  });

  it('preserves no-session startup precedence instead of implicitly importing an existing fork source', async () => {
    const manager = new SessionManager(), source = await seed(manager);
    const selected = await resolveStartupSession({ sessionManager: manager,
      args: args({ noSession: true, fork: source.id, sessionId: 'blank-memory' }), cwd: '/new', interactive: false });
    expect(selected.id).toBe('blank-memory'); expect(selected.messages).toEqual([]); expect(selected.parentId).toBeUndefined();
    expect(revisions(await manager.getActiveBranchEntries(selected.id))).toEqual([]);
    expect(revisions(await manager.getActiveBranchEntries(source.id))).toEqual([1]);
  });
});
