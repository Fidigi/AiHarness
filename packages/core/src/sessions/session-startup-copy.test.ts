import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore, SessionManager, type SessionEntry, type SessionForkOptions } from '@ai-harness/core';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-startup-copy-')); roots.push(root); return root; }
const revisions = (entries: SessionEntry[]) => entries.flatMap(entry => entry.type === 'custom'
  && entry.customType === 'fixture:copy' ? [(entry.data as { revision: number }).revision] : []);
function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function seed(manager: SessionManager, id = 'copy-source') {
  await manager.create({ id, title: 'Source', cwd: '/old', workspaceId: 'old-workspace', model: 'model-a', thinking: 'high' });
  await manager.addMessage(id, { role: 'user', content: 'Shared root' });
  await manager.appendCustomEntry(id, 'fixture:copy', { revision: 1, private: 'COPY_PRIVATE' });
  await manager.appendCustomMessage(id, 'fixture:copy-note', 'COPY_VISIBLE', { display: false, details: 'COPY_DETAILS' });
  await manager.addMessage(id, { role: 'user', content: 'Selected user' });
  const target = manager.get(id)!.activeLeafId!;
  await manager.appendCustomEntry(id, 'fixture:copy', { revision: 2 });
  await manager.addMessage(id, { role: 'assistant', content: 'Abandoned source' });
  await manager.navigateTree(id, target, { summarize: true, summarizer: async () => ({ summary: 'COPY_SUMMARY' }) });
  return id;
}

describe('read-only session snapshots and startup destination copies', () => {
  it('reads a single owned native snapshot without rewriting source bytes or metadata', async () => {
    const root = await temporary(), store = new JsonlSessionStore(root), manager = new SessionManager({ store });
    const id = await seed(manager), file = path.join(root, `${id}.jsonl`);
    const before = await readFile(file), info = await stat(file, { bigint: true });
    const snapshot = await store.getSessionSnapshot(id);
    expect(snapshot?.session.messages.map(message => message.content)).toEqual(['Shared root', 'Selected user']);
    expect(revisions(snapshot!.entries)).toEqual([1, 2]);
    expect(snapshot?.session).toEqual(await store.loadSession(id));
    snapshot!.session.title = 'Caller-owned'; snapshot!.entries.length = 0;
    expect((await store.getSessionSnapshot(id))?.session.title).toBe('Source');
    expect(revisions((await store.getSessionSnapshot(id))!.entries)).toEqual([1, 2]);
    expect(await readFile(file)).toEqual(before); expect((await stat(file, { bigint: true })).mtimeNs).toBe(info.mtimeNs);
  });

  it('preserves empty, missing and disabled native snapshot behavior', async () => {
    const root = await temporary(), store = new JsonlSessionStore(root);
    await writeFile(path.join(root, 'empty.jsonl'), ' \n');
    expect(await store.getSessionSnapshot('missing')).toBeNull();
    expect(await new JsonlSessionStore(root, false).getSessionSnapshot('empty')).toBeNull();
    expect(await store.getSessionSnapshot('empty')).toMatchObject({ session: { id: 'empty', messages: [] }, entries: [] });
    expect(await store.loadSession('empty')).toMatchObject({ id: 'empty', messages: [] });
  });

  it.each(['memory', 'durable', 'external'] as const)('uses the same selected rich ancestry with captured destination fields (%s)', async mode => {
    const root = await temporary(), sourceStore = new JsonlSessionStore(path.join(root, 'source'));
    const source = new SessionManager(mode === 'memory' ? {} : { store: sourceStore });
    const id = await seed(source);
    const destination = mode === 'external' ? new SessionManager({ store: new JsonlSessionStore(path.join(root, 'target')) }) : source;
    const fork = await destination.forkSession(id, undefined, 'Destination', {
      ...(mode === 'external' ? { sourceStore } : {}), id: 'copy-destination', cwd: '/new', workspaceId: undefined,
    });
    expect(fork).toMatchObject({ id: 'copy-destination', parentId: id, title: 'Destination', cwd: '/new', model: 'model-a', thinking: 'high' });
    expect(fork?.workspaceId).toBeUndefined();
    const entries = await destination.getActiveBranchEntries(fork!.id);
    expect(revisions(entries)).toEqual([1]); expect(entries.at(-1)).toMatchObject({ type: 'branch_summary', summary: 'COPY_SUMMARY' });
    expect(entries.some(entry => entry.type === 'custom_message' && entry.content === 'COPY_VISIBLE')).toBe(true);
    const model = JSON.stringify(destination.getEffectiveContext(fork!.id));
    expect(model).toContain('COPY_VISIBLE'); expect(model).not.toContain('COPY_PRIVATE'); expect(model).not.toContain('COPY_DETAILS');
    expect(revisions(await source.getRawEntries(id))).toEqual([1, 2]);
    if (mode === 'external') expect(destination.get(id)).toBeUndefined();
  });

  it('does not import a colliding foreign source identity or write a fork into the source store', async () => {
    const root = await temporary(), sourceStore = new JsonlSessionStore(path.join(root, 'source'));
    const source = new SessionManager({ store: sourceStore }), id = await seed(source);
    const targetStore = new JsonlSessionStore(path.join(root, 'target')), target = new SessionManager({ store: targetStore });
    await target.create({ id, title: 'Unrelated local session' });
    const file = path.join(root, 'source', `${id}.jsonl`), before = await readFile(file), info = await stat(file, { bigint: true });
    const fork = await target.forkSession(id, undefined, undefined, { sourceStore, id: 'foreign-fork' });
    expect(fork?.title).toBe('Source (fork)'); expect(target.get(id)?.title).toBe('Unrelated local session');
    expect(revisions(await target.getActiveBranchEntries('foreign-fork'))).toEqual([1]);
    expect(await sourceStore.listSessionIds()).toEqual([id]); expect(await targetStore.listSessionIds()).toEqual(expect.arrayContaining([id, 'foreign-fork']));
    expect(await readFile(file)).toEqual(before); expect((await stat(file, { bigint: true })).mtimeNs).toBe(info.mtimeNs);
    const reopened = new SessionManager({ store: targetStore }); await reopened.loadFromStore('foreign-fork');
    expect(revisions(await reopened.getActiveBranchEntries('foreign-fork'))).toEqual([1]);
  });

  it('retains private pre-compaction state in an external snapshot and copy', async () => {
    const root = await temporary(), sourceStore = new JsonlSessionStore(root), source = new SessionManager({ store: sourceStore });
    const id = await seed(source), firstKept = source.get(id)!.messages.at(-1)!.id;
    await source.applyCompaction(id, 'COMPACTED_SOURCE', firstKept);
    await source.addMessage(id, { role: 'assistant', content: 'After compaction' });
    const target = new SessionManager(), fork = await target.forkSession(id, undefined, undefined, { sourceStore });
    expect(revisions(await target.getActiveBranchEntries(fork!.id))).toEqual([1]);
    const model = JSON.stringify(target.getEffectiveContext(fork!.id));
    expect(model).toContain('COMPACTED_SOURCE'); expect(model).not.toContain('COPY_VISIBLE'); expect(model).not.toContain('COPY_PRIVATE');
  });

  it('refuses duplicate destination identity without changing either source or target', async () => {
    const root = await temporary(), store = new JsonlSessionStore(root), source = new SessionManager({ store });
    const id = await seed(source), target = new SessionManager(); await target.create({ id: 'occupied', title: 'Keep target' });
    const before = await readFile(path.join(root, `${id}.jsonl`));
    await expect(target.forkSession(id, undefined, undefined, { sourceStore: store, id: 'occupied' })).rejects.toThrow('Session already exists.');
    expect(target.list().map(session => session.id)).toEqual(['occupied']); expect(target.get('occupied')?.title).toBe('Keep target');
    expect(await readFile(path.join(root, `${id}.jsonl`))).toEqual(before);
  });

  it('rejects own accessors, unknown keys and invalid scalar/source options without evaluating them', async () => {
    const manager = new SessionManager(); const id = await seed(manager); let calls = 0;
    const getter = Object.defineProperty({}, 'sourceStore', { get: () => { calls++; return new JsonlSessionStore(); } });
    const cases: unknown[] = [getter, null, [], { unknown: true }, { id: {} }, { id: '../bad' }, { cwd: 1 }, { workspaceId: 'x'.repeat(257) }, { sourceStore: {} }];
    for (const options of cases) await expect(manager.forkSession(id, undefined, undefined, options as SessionForkOptions)).rejects.toThrow('Session fork options are invalid.');
    expect(calls).toBe(0); expect(manager.list()).toHaveLength(1);
  });

  it('captures source identity and destination primitives before awaiting the external read', async () => {
    const root = await temporary(), sourceStore = new JsonlSessionStore(root), source = new SessionManager({ store: sourceStore });
    const id = await seed(source), entered = latch(), release = latch();
    const delayed = new class extends JsonlSessionStore {
      override async getSessionSnapshot(key: string) { const snapshot = await sourceStore.getSessionSnapshot(key); entered.release(); await release.promise; return snapshot; }
    }();
    const target = new SessionManager(), options: SessionForkOptions = { sourceStore: delayed, id: 'captured', cwd: '/captured', workspaceId: 'captured-workspace' };
    const pending = target.forkSession(id, undefined, undefined, options); await entered.promise;
    options.sourceStore = new JsonlSessionStore(root, false); options.id = 'changed'; options.cwd = '/changed'; options.workspaceId = 'changed-workspace'; release.release();
    expect(await pending).toMatchObject({ id: 'captured', cwd: '/captured', workspaceId: 'captured-workspace' }); expect(target.get('changed')).toBeUndefined();
    expect(revisions(await target.getActiveBranchEntries('captured'))).toEqual([1]);
  });

  it('withdraws publication when the target store changes during an external read', async () => {
    const root = await temporary(), sourceStore = new JsonlSessionStore(path.join(root, 'source')), source = new SessionManager({ store: sourceStore });
    const id = await seed(source), entered = latch(), release = latch();
    const delayed = new class extends JsonlSessionStore {
      override async getSessionSnapshot(key: string) { const snapshot = await sourceStore.getSessionSnapshot(key); entered.release(); await release.promise; return snapshot; }
    }();
    const original = new JsonlSessionStore(path.join(root, 'old')), replacement = new JsonlSessionStore(path.join(root, 'new'));
    const target = new SessionManager({ store: original }), pending = target.forkSession(id, undefined, undefined, { sourceStore: delayed, id: 'withdrawn' });
    await entered.promise; target.setStore(replacement); release.release();
    await expect(pending).rejects.toThrow('Session changed while copying its branch.');
    expect(target.list()).toEqual([]); expect(await original.listSessionIds()).toEqual([]); expect(await replacement.listSessionIds()).toEqual([]);
  });

  it('refuses a missing or incomplete foreign source without a partial destination', async () => {
    const root = await temporary(), store = new JsonlSessionStore(root), source = new SessionManager({ store });
    const session = await source.create({ id: 'broken', activeLeafId: 'missing-parent' });
    const target = new SessionManager();
    expect(await target.forkSession('absent', undefined, undefined, { sourceStore: store, id: 'missing' })).toBeNull();
    expect(await target.forkSession(session.id, undefined, undefined, { sourceStore: store, id: 'incomplete' })).toBeNull();
    expect(target.list()).toEqual([]);
  });
});
