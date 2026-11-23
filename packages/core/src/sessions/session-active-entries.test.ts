import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionRegistry, JsonlSessionStore, SessionManager, type SessionEntry } from '@ai-harness/core';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const revisions = (entries: SessionEntry[]) => entries.flatMap(entry => entry.type === 'custom'
  && entry.customType === 'fixture:state' ? [(entry.data as { revision: number }).revision] : []);
function borrowed(root: string): JsonlSessionStore {
  const actual = new JsonlSessionStore(root);
  return new class extends JsonlSessionStore {
    constructor() { super(undefined, false); }
    override saveSession(...args: Parameters<JsonlSessionStore['saveSession']>) { return actual.saveSession(...args); }
    override loadSession(...args: Parameters<JsonlSessionStore['loadSession']>) { return actual.loadSession(...args); }
    override getRawEntries(...args: Parameters<JsonlSessionStore['getRawEntries']>) { return actual.getRawEntries(...args); }
  }();
}
async function fixture(mode: 'memory' | 'disabled' | 'durable' | 'borrowed') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-active-entries-')); roots.push(root);
  const persistent = mode === 'durable' || mode === 'borrowed';
  const open = () => mode === 'borrowed' ? borrowed(root) : new JsonlSessionStore(root, mode !== 'disabled');
  const manager = new SessionManager(mode === 'memory' ? {} : { store: open() });
  const session = await manager.create({ model: 'mock-model' });
  await manager.addMessage(session.id, { role: 'user', content: 'Shared root' });
  const state = await manager.appendCustomEntry(session.id, 'fixture:state', { revision: 1, private: 'PRIVATE_STATE' });
  const message = await manager.appendCustomMessage(session.id, 'fixture:note', 'CUSTOM_NOTE', { display: false, details: 'PRIVATE_DETAILS' });
  await manager.addMessage(session.id, { role: 'user', content: 'Selected user' });
  const target = session.activeLeafId!;
  await manager.appendCustomEntry(session.id, 'fixture:state', { revision: 2 });
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned answer' });
  const source = session.activeLeafId!;
  const result = await manager.navigateTree(session.id, target, {
    summarize: true, summarizer: async () => ({ summary: 'Discarded branch summary' }),
  });
  expect(result.status).toBe('navigated');
  return { manager, session, state: state!, message: message!, target, source, open, persistent };
}

describe.each(['memory', 'disabled', 'durable', 'borrowed'] as const)('active branch entries (%s)', mode => {
  it('owns parent-first private state without borrowing abandoned summary provenance', async () => {
    const f = await fixture(mode);
    const selected = await f.manager.getActiveBranchEntries(f.session.id);
    expect(revisions(selected)).toEqual([1]);
    expect(revisions(await f.manager.getRawEntries(f.session.id))).toEqual([1, 2]);
    expect(selected.map(entry => entry.id)).toContain(f.state.id);
    expect(selected.at(-1)).toMatchObject({ type: 'branch_summary', parentEntryId: f.target, fromEntryId: f.source });
    expect(selected.some(entry => entry.id === f.source)).toBe(false);
    const privateState = selected.find(entry => entry.type === 'custom');
    if (privateState?.type !== 'custom') throw new Error('Missing private state.');
    (privateState.data as { revision: number }).revision = 999;
    selected.length = 0;
    expect(revisions(await f.manager.getActiveBranchEntries(f.session.id))).toEqual([1]);
    const context = JSON.stringify(f.manager.getEffectiveContext(f.session.id));
    expect(context).toContain('CUSTOM_NOTE');
    expect(context).not.toContain('PRIVATE_STATE');
    expect(context).not.toContain('PRIVATE_DETAILS');
  });

  it('retains selected private ancestors outside compaction context and in independent clones', async () => {
    const f = await fixture(mode);
    await f.manager.applyCompaction(f.session.id, 'New context boundary', f.target);
    expect(JSON.stringify(f.manager.getEffectiveContext(f.session.id))).not.toContain('CUSTOM_NOTE');
    expect(revisions(await f.manager.getActiveBranchEntries(f.session.id))).toEqual([1]);
    await f.manager.addMessage(f.session.id, { role: 'user', content: 'After compaction' });
    const afterCompaction = f.session.activeLeafId!;
    for (const kind of ['entry', 'current', 'index']) {
      const forked = kind === 'entry' ? await f.manager.forkSessionAtEntry(f.session.id, afterCompaction)
        : await f.manager.forkSession(f.session.id, kind === 'index' ? afterCompaction : undefined);
      expect(forked).not.toBeNull();
      expect(revisions(await f.manager.getActiveBranchEntries(forked!.id))).toEqual([1]);
      expect(forked!.messages.map(message => message.content)).toEqual(f.session.messages.map(message => message.content));
      const model = JSON.stringify(f.manager.getEffectiveContext(forked!.id));
      expect(model).toContain('New context boundary');
      expect(model).not.toContain('CUSTOM_NOTE');
      if (f.persistent) {
        const restarted = new SessionManager({ store: f.open() });
        await restarted.loadFromStore(forked!.id);
        expect(revisions(await restarted.getActiveBranchEntries(forked!.id))).toEqual([1]);
        expect(restarted.get(forked!.id)!.messages.map(message => message.content)).toEqual(forked!.messages.map(message => message.content));
        expect(JSON.stringify(restarted.getEffectiveContext(forked!.id))).toBe(model);
      }
    }
    const cloned = await f.manager.cloneSession(f.session.id);
    expect(cloned).not.toBeNull();
    const entries = await f.manager.getActiveBranchEntries(cloned!.id);
    expect(revisions(entries)).toEqual([1]);
    expect(entries.some(entry => entry.id === f.state.id)).toBe(false);
    if (f.persistent) {
      const restarted = new SessionManager({ store: f.open() });
      await restarted.loadFromStore(cloned!.id);
      expect(revisions(await restarted.getActiveBranchEntries(cloned!.id))).toEqual([1]);
    }
  });

  it('exposes the view to actual extension generations and store-backed restarts', async () => {
    const f = await fixture(mode);
    const registry = new ExtensionRegistry();
    let generation = 0;
    const factory = (api: Parameters<Parameters<ExtensionRegistry['load']>[1]>[0]) => {
      const ownGeneration = ++generation;
      api.registerCommand('private-read', { description: 'Read selected private state', handler: async (_args, context) =>
        JSON.stringify({ generation: ownGeneration, revisions: revisions(await context.sessionManager.getActiveBranchEntries(context.currentSessionId!)) }) });
    };
    const context = { sessionManager: f.manager, currentSessionId: f.session.id, notify() {} };
    await registry.load('fixture:state', factory);
    expect(await registry.getCommand('private-read')!.handler('', context)).toBe('{"generation":1,"revisions":[1]}');
    await registry.replaceManaged(['fixture:state'], [{ id: 'fixture:state', factory }]);
    expect(await registry.getCommand('private-read')!.handler('', context)).toBe('{"generation":2,"revisions":[1]}');
    if (f.persistent) {
      const restarted = new SessionManager({ store: f.open() });
      await restarted.loadFromStore(f.session.id);
      expect(await registry.getCommand('private-read')!.handler('', { ...context, sessionManager: restarted })).toBe('{"generation":2,"revisions":[1]}');
    }
    await registry.unloadAll();
    expect(registry.getCommand('private-read')).toBeUndefined();
  });

  it.each(['entry', 'current', 'index'] as const)('preserves selected private/custom ancestry in related %s forks', async kind => {
    const f = await fixture(mode);
    const forked = kind === 'entry' ? await f.manager.forkSessionAtEntry(f.session.id, f.target)
      : await f.manager.forkSession(f.session.id, kind === 'index' ? f.target : undefined);
    expect(forked).not.toBeNull();
    expect(forked!.parentId).toBe(f.session.id);
    const entries = await f.manager.getActiveBranchEntries(forked!.id);
    expect(revisions(entries)).toEqual([1]);
    expect(entries.map(entry => entry.id)).toContain(f.state.id);
    expect(entries.map(entry => entry.id)).toContain(f.message.id);
    expect(entries.map(entry => entry.id)).toContain(f.target);
    expect(entries.some(entry => entry.id === f.source)).toBe(false);
    expect(JSON.stringify(f.manager.getEffectiveContext(forked!.id))).toContain('CUSTOM_NOTE');
    await f.manager.appendCustomEntry(forked!.id, 'fixture:state', { revision: 3 });
    expect(revisions(await f.manager.getActiveBranchEntries(forked!.id))).toEqual([1, 3]);
    expect(revisions(await f.manager.getActiveBranchEntries(f.session.id))).toEqual([1]);
    if (f.persistent) {
      const restarted = new SessionManager({ store: f.open() });
      await restarted.loadFromStore(forked!.id);
      expect(revisions(await restarted.getActiveBranchEntries(forked!.id))).toEqual([1, 3]);
    }
  });

  it('copies private state and a custom-message head before an edited user boundary', async () => {
    const f = await fixture(mode);
    const forked = await f.manager.forkSessionAtEntry(f.session.id, f.target, undefined, { before: true });
    expect(forked?.activeLeafId).toBe(f.message.id);
    expect(revisions(await f.manager.getActiveBranchEntries(forked!.id))).toEqual([1]);
    expect(forked?.messages.some(message => message.id === f.target)).toBe(false);
    await f.manager.addMessage(forked!.id, { role: 'user', content: 'Edited selected user' });
    expect(forked!.messages.at(-1)?.parentMessageId).toBe(f.message.id);
  });
});

it('refuses fork option accessors without evaluating them', async () => {
  const f = await fixture('memory');
  let evaluations = 0;
  await expect(f.manager.forkSessionAtEntry(f.session.id, f.target, undefined, {
    get before() { evaluations++; return true; },
  })).rejects.toThrow('Session fork options are invalid.');
  expect(evaluations).toBe(0);
});

it('captures the fork-before option before awaiting a journal read', async () => {
  const f = await fixture('durable');
  const store = f.open();
  f.manager.setStore(store);
  const admitted = deferred(); const reading = deferred();
  const raw = store.getRawEntries.bind(store);
  store.getRawEntries = async id => { admitted.release(); await reading.promise; return raw(id); };
  const options = { before: false };
  const copying = f.manager.forkSessionAtEntry(f.session.id, f.target, undefined, options);
  await admitted.promise;
  options.before = true;
  reading.release();
  const forked = await copying;
  expect(forked!.messages.some(message => message.id === f.target)).toBe(true);
  expect(revisions(await f.manager.getActiveBranchEntries(forked!.id))).toEqual([1]);
});

for (const duplicate of [false, true]) it(`uses parent order and the last append projection across regressing clocks (${duplicate})`, async () => {
  const f = await fixture('durable');
  const expectedIds = (await f.manager.getActiveBranchEntries(f.session.id)).map(entry => entry.id);
  const filePath = f.open().getSessionFilePath(f.session.id)!;
  // Raw ancestry excludes metadata; preserve the real journal's reopen authority.
  const entries = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
  entries.forEach((entry, index) => { if (entry.type !== 'metadata') entry.timestamp = 10_000 - index; });
  const original = entries.find(entry => entry.id === f.state.id)!;
  if (duplicate) entries.push({ ...original, type: 'custom', timestamp: 0, customType: 'fixture:state', data: { revision: 3 } });
  await writeFile(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const restarted = new SessionManager({ store: f.open() });
  await restarted.loadFromStore(f.session.id);
  expect((await restarted.getActiveBranchEntries(f.session.id)).map(entry => entry.id)).toEqual(expectedIds);
  const expected = [duplicate ? 3 : 1];
  expect(revisions(await restarted.getActiveBranchEntries(f.session.id))).toEqual(expected);
  for (const kind of ['entry', 'current', 'clone']) {
    const copied = kind === 'entry' ? await restarted.forkSessionAtEntry(f.session.id, f.target)
      : kind === 'clone' ? await restarted.cloneSession(f.session.id) : await restarted.forkSession(f.session.id);
    expect(copied).not.toBeNull();
    expect(revisions(await restarted.getActiveBranchEntries(copied!.id))).toEqual(expected);
  }
});

it.each(['entry', 'current', 'index', 'clone'] as const)('retains post-compaction messages across durable %s copies with regressing clocks', async kind => {
  const f = await fixture('durable');
  await f.manager.applyCompaction(f.session.id, 'New context boundary', f.target);
  await f.manager.addMessage(f.session.id, { role: 'user', content: 'After compaction' });
  const leaf = f.session.activeLeafId!, filePath = f.open().getSessionFilePath(f.session.id)!;
  const entries = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
  // Preserve append order and all parent links while making descendants older.
  entries.forEach((entry, index) => { if (entry.type !== 'metadata') entry.timestamp = 10_000 - index; });
  await writeFile(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const source = new SessionManager({ store: f.open() });
  await source.loadFromStore(f.session.id);
  const expected = ['Selected user', 'After compaction'];
  const expectedContext = source.getEffectiveContext(f.session.id).map(entry => entry.type === 'message' ? entry.content : entry);
  expect(source.get(f.session.id)!.messages.map(message => message.content)).toEqual(expected);
  const copied = kind === 'entry' ? await source.forkSessionAtEntry(f.session.id, leaf)
    : kind === 'clone' ? await source.cloneSession(f.session.id)
      : await source.forkSession(f.session.id, kind === 'index' ? leaf : undefined);
  expect(copied).not.toBeNull();
  expect(copied!.messages.map(message => message.content)).toEqual(expected);
  expect(revisions(await source.getActiveBranchEntries(copied!.id))).toEqual([1]);
  const context = source.getEffectiveContext(copied!.id);
  expect(context.map(entry => entry.type === 'message' ? entry.content : entry)).toEqual(expectedContext);
  const reopened = new SessionManager({ store: f.open() });
  await reopened.loadFromStore(copied!.id);
  expect(reopened.get(copied!.id)!.messages.map(message => message.content)).toEqual(expected);
  expect(reopened.getEffectiveContext(copied!.id)).toEqual(context);
  expect(revisions(await reopened.getActiveBranchEntries(copied!.id))).toEqual([1]);
  if (kind === 'clone') expect((await source.getActiveBranchEntries(copied!.id)).some(entry => entry.id === f.state.id)).toBe(false);
  else expect((await source.getActiveBranchEntries(copied!.id)).some(entry => entry.id === f.state.id)).toBe(true);
});

it('returns empty for missing/invalid identities without coercing them', async () => {
  const manager = new SessionManager();
  let coercions = 0;
  const id = { get toString() { coercions++; return () => 'session'; } };
  expect(await manager.getActiveBranchEntries(id as unknown as string)).toEqual([]);
  expect(await manager.getActiveBranchEntries('missing')).toEqual([]);
  expect(coercions).toBe(0);
});

for (const cycle of [false, true]) it(`refuses incomplete ancestry rather than returning partial private state (${cycle})`, async () => {
  const manager = new SessionManager();
  const session = await manager.create({ activeLeafId: 'last', metadata: { hasBranchedHistory: true }, messages: [
    { id: 'first', role: 'user', content: 'First', timestamp: new Date(2), parentMessageId: cycle ? 'last' : 'missing' },
    { id: 'last', role: 'assistant', content: 'Last', timestamp: new Date(1), parentMessageId: 'first' },
  ] });
  await expect(manager.getActiveBranchEntries(session.id)).rejects.toThrow('Session ancestry is incomplete.');
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
it('waits for a queued durable append before selecting its leaf and journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-active-entries-queue-')); roots.push(root);
  const store = new JsonlSessionStore(root);
  const manager = new SessionManager({ store });
  const session = await manager.create();
  await manager.appendCustomEntry(session.id, 'fixture:state', { revision: 1 });
  const admitted = deferred(); const write = deferred();
  const save = store.saveSession.bind(store);
  store.saveSession = async (...args) => { admitted.release(); await write.promise; return save(...args); };
  const appending = manager.appendCustomEntry(session.id, 'fixture:state', { revision: 2 });
  await admitted.promise;
  let settled = false;
  const reading = manager.getActiveBranchEntries(session.id).then(entries => { settled = true; return entries; });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
  } finally { write.release(); }
  await appending;
  expect(revisions(await reading)).toEqual([1, 2]);
});

it('refuses publication if a privileged host replaces the store during an awaited read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-active-entries-stale-')); roots.push(root);
  const store = new JsonlSessionStore(root);
  const manager = new SessionManager({ store });
  const session = await manager.create();
  await manager.appendCustomEntry(session.id, 'fixture:state', { revision: 1 });
  const admitted = deferred(); const read = deferred();
  const raw = store.getRawEntries.bind(store);
  store.getRawEntries = async id => { admitted.release(); await read.promise; return raw(id); };
  const reading = manager.getActiveBranchEntries(session.id);
  await admitted.promise;
  manager.setStore(new JsonlSessionStore(root));
  read.release();
  await expect(reading).rejects.toThrow('Session changed while reading its active branch.');
});
