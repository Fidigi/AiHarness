import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore, SessionBranchCancelledError, SessionManager, type SessionBranchEvent, type SessionEntry } from '@ai-harness/core';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-branch-hooks-')); roots.push(root); return root; }
const revisions = (entries: SessionEntry[]) => entries.flatMap(entry => entry.type === 'custom' ? [(entry.data as { revision: number }).revision] : []);
async function seed(manager: SessionManager) {
  const source = await manager.create({ id: 'branch-source', title: 'Source', messages: [{ id: 'root-user', role: 'user', content: 'Root user', timestamp: new Date() }], activeLeafId: 'root-user' });
  await manager.appendCustomEntry(source.id, 'fixture:branch', { revision: 1 });
  await manager.addMessage(source.id, { role: 'user', content: 'Selected user' });
  const target = source.activeLeafId!;
  await manager.addMessage(source.id, { role: 'assistant', content: 'After selected user' });
  return { source, target };
}
async function fixture(durable: boolean) {
  const root = await temporary(), store = durable ? new JsonlSessionStore(root) : undefined;
  const manager = new SessionManager({ store });
  return { root, store, manager, ...await seed(manager) };
}

for (const durable of [false, true]) describe(`Core branch admission (${durable ? 'durable' : 'memory'})`, () => {
  it.each(['fork', 'before-user-fork', 'clone', 'branch-before'] as const)('vetoes %s before any publication', async operation => {
    const f = await fixture(durable), originalLeaf = f.source.activeLeafId;
    const raw = await f.manager.getRawEntries(f.source.id), created: string[] = [], events: Readonly<SessionBranchEvent>[] = [];
    const file = path.join(f.root, `${f.source.id}.jsonl`), bytes = durable ? await readFile(file) : undefined;
    const mtime = durable ? (await stat(file, { bigint: true })).mtimeNs : undefined;
    f.manager.on('session:create', event => { created.push(event.sessionId); });
    f.manager.onBeforeBranch(event => { events.push(event); return false; });
    const pending = operation === 'fork' ? f.manager.forkSession(f.source.id)
      : operation === 'before-user-fork' ? f.manager.forkSessionAtEntry(f.source.id, f.target, 'Before', { before: true })
        : operation === 'clone' ? f.manager.cloneSession(f.source.id) : f.manager.branchBeforeEntry(f.source.id, f.target);
    await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
    expect(f.manager.list().map(session => session.id)).toEqual([f.source.id]); expect(created).toEqual([]);
    expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw); expect(f.source.activeLeafId).toBe(originalLeaf);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sourceSessionId: f.source.id, externalSource: false,
      operation: operation === 'before-user-fork' ? 'fork' : operation,
      entryId: operation === 'before-user-fork' || operation === 'branch-before' ? f.target : originalLeaf,
      position: operation === 'before-user-fork' || operation === 'branch-before' ? 'before' : 'at' });
    expect(Object.isFrozen(events[0])).toBe(true); expect(events[0].signal.aborted).toBe(true);
    if (durable) {
      expect(await readFile(file)).toEqual(bytes); expect((await stat(file, { bigint: true })).mtimeNs).toBe(mtime);
      expect(await f.store!.listSessionIds()).toEqual([f.source.id]);
    }
  });

  it('allows reentrant active/raw reads because hooks run outside mutation queues', async () => {
    const f = await fixture(durable), raw = await f.manager.getRawEntries(f.source.id);
    let calls = 0;
    f.manager.onBeforeBranch(async event => {
      calls++;
      expect(await f.manager.getRawEntries(event.sourceSessionId)).toEqual(raw);
      expect(revisions(await f.manager.getActiveBranchEntries(event.sourceSessionId))).toEqual([1]);
    });
    const copy = await f.manager.cloneSession(f.source.id);
    expect(copy).not.toBeNull(); expect(calls).toBe(1);
    expect(revisions(await f.manager.getActiveBranchEntries(copy!.id))).toEqual([1]);
  });

  it('copies the captured point rather than chasing a leaf advanced by a hook', async () => {
    const f = await fixture(durable), capturedLeaf = f.source.activeLeafId;
    f.manager.onBeforeBranch(async event => {
      expect(event.entryId).toBe(capturedLeaf);
      await f.manager.appendCustomEntry(f.source.id, 'fixture:branch', { revision: 2 });
    });
    const copy = await f.manager.cloneSession(f.source.id);
    expect(copy).not.toBeNull();
    expect(revisions(await f.manager.getActiveBranchEntries(copy!.id))).toEqual([1]);
    expect(revisions(await f.manager.getActiveBranchEntries(f.source.id))).toEqual([1, 2]);
    expect(f.source.activeLeafId).not.toBe(capturedLeaf);
  });

  it('refuses an in-place move if a hook changed its source snapshot', async () => {
    const f = await fixture(durable);
    f.manager.onBeforeBranch(async () => { await f.manager.appendCustomEntry(f.source.id, 'fixture:branch', { revision: 2 }); });
    await expect(f.manager.branchBeforeEntry(f.source.id, f.target)).rejects.toThrow('Session changed while branching its history.');
    expect(f.manager.list()).toHaveLength(1);
    expect(revisions(await f.manager.getActiveBranchEntries(f.source.id))).toEqual([1, 2]);
    expect(f.source.messages.at(-1)?.content).toBe('After selected user');
  });

  it('withdraws a non-cooperative pending hook before a late result can create a copy', async () => {
    const f = await fixture(durable), gate = latch(), entered = latch(), caller = new AbortController();
    const raw = await f.manager.getRawEntries(f.source.id);
    f.manager.onBeforeBranch(async () => { entered.release(); await gate.promise; });
    const pending = f.manager.cloneSession(f.source.id, undefined, undefined, { signal: caller.signal });
    await entered.promise; caller.abort();
    await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
    gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.manager.list().map(session => session.id)).toEqual([f.source.id]);
    expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    if (durable) expect(await f.store!.listSessionIds()).toEqual([f.source.id]);
  });

  it('fails closed on a privileged hook error without exposing its content', async () => {
    const f = await fixture(durable), raw = await f.manager.getRawEntries(f.source.id);
    f.manager.onBeforeBranch(() => { throw new Error('PRIVATE_BRANCH_HOOK_ERROR'); });
    await expect(f.manager.forkSession(f.source.id)).rejects.toThrow(/^Session branch hook failed\.$/);
    expect(f.manager.list()).toHaveLength(1); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
  });
});

it('rechecks destination authority after an awaited inventory before admitting a copy write', async () => {
  const root = await temporary(), entered = latch(), gate = latch();
  class InventoryStore extends JsonlSessionStore {
    hold = false;
    override async listSessionIds(): Promise<string[]> {
      if (this.hold) { entered.release(); await gate.promise; }
      return super.listSessionIds();
    }
  }
  const store = new InventoryStore(path.join(root, 'old')), manager = new SessionManager({ store });
  const { source } = await seed(manager), replacement = new JsonlSessionStore(path.join(root, 'new'));
  store.hold = true;
  const pending = manager.cloneSession(source.id);
  await entered.promise; manager.setStore(replacement);
  await expect(pending).rejects.toThrow('Session changed while copying its branch.');
  gate.release(); await manager.clear();
  expect(await store.listSessionIds()).toEqual([source.id]); expect(await replacement.listSessionIds()).toEqual([]);
});

it('does not cancel an already-admitted durable copy when its caller or hook generation retires', async () => {
  const root = await temporary(), entered = latch(), gate = latch();
  class WriteStore extends JsonlSessionStore {
    hold = false;
    override async saveSession(session: Parameters<JsonlSessionStore['saveSession']>[0],
      entries: SessionEntry[] = [], options: { requireAbsent?: boolean } = {}): Promise<void> {
      if (this.hold && session.id !== 'branch-source') { entered.release(); await gate.promise; }
      await super.saveSession(session, entries, options);
    }
  }
  const store = new WriteStore(root), manager = new SessionManager({ store }), { source } = await seed(manager);
  const caller = new AbortController(); let observed: Readonly<SessionBranchEvent> | undefined;
  const remove = manager.onBeforeBranch(event => { observed = event; });
  store.hold = true;
  const pending = manager.cloneSession(source.id, undefined, undefined, { signal: caller.signal });
  await entered.promise; remove(); caller.abort();
  expect(observed?.signal.aborted).toBe(false);
  gate.release(); const copy = await pending;
  expect(copy).not.toBeNull(); expect(revisions(await manager.getActiveBranchEntries(copy!.id))).toEqual([1]);
  const restarted = new SessionManager({ store: new JsonlSessionStore(root) });
  expect(await restarted.loadFromStore(copy!.id)).not.toBeNull();
  expect(revisions(await restarted.getActiveBranchEntries(copy!.id))).toEqual([1]);
});

it('rechecks cancellation after structural-store preparation but before save admission', async () => {
  const root = await temporary(), entered = latch(), gate = latch();
  class ReadStore extends JsonlSessionStore {
    hold = false;
    readonly saves: string[] = [];
    override async getRawEntries(id: string): Promise<SessionEntry[]> {
      if (this.hold && id !== 'branch-source') { entered.release(); await gate.promise; }
      return super.getRawEntries(id);
    }
    override async saveSession(session: Parameters<JsonlSessionStore['saveSession']>[0],
      entries: SessionEntry[] = [], options: { requireAbsent?: boolean } = {}): Promise<void> {
      this.saves.push(session.id); await super.saveSession(session, entries, options);
    }
  }
  const store = new ReadStore(root), manager = new SessionManager({ store }), { source } = await seed(manager);
  const caller = new AbortController(); store.hold = true;
  const pending = manager.cloneSession(source.id, undefined, undefined, { signal: caller.signal });
  await entered.promise; caller.abort();
  await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
  gate.release(); await manager.clear();
  expect(store.saves.every(id => id === source.id)).toBe(true); expect(await store.listSessionIds()).toEqual([source.id]);
});
