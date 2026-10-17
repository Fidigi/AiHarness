import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';

const roots: string[] = [];
afterEach(async context => {
  const completed = roots.splice(0);
  if (context.task.result?.state === 'fail') console.error('Retained Core compaction boundary roots:', completed);
  else await Promise.all(completed.map(root => rm(root, { recursive: true, force: true })));
});

function createStore(root: string, mode: 'memory' | 'native' | 'structural') {
  const disk = new JsonlSessionStore(root);
  class BorrowedStore extends JsonlSessionStore {
    constructor() { super(undefined, false); }
    override setRedaction(...args: Parameters<JsonlSessionStore['setRedaction']>): void { disk.setRedaction(...args); }
    override listSessionIds(): ReturnType<JsonlSessionStore['listSessionIds']> { return disk.listSessionIds(); }
    override loadSession(...args: Parameters<JsonlSessionStore['loadSession']>): ReturnType<JsonlSessionStore['loadSession']> { return disk.loadSession(...args); }
    override saveSession(...args: Parameters<JsonlSessionStore['saveSession']>): ReturnType<JsonlSessionStore['saveSession']> { return disk.saveSession(...args); }
    override getRawEntries(...args: Parameters<JsonlSessionStore['getRawEntries']>): ReturnType<JsonlSessionStore['getRawEntries']> { return disk.getRawEntries(...args); }
    override deleteSession(...args: Parameters<JsonlSessionStore['deleteSession']>): ReturnType<JsonlSessionStore['deleteSession']> { return disk.deleteSession(...args); }
  }
  return { disk, store: mode === 'memory' ? undefined : mode === 'native' ? disk : new BorrowedStore() };
}

describe.each(['memory', 'native', 'structural'] as const)('nonordinary compaction boundaries (%s)', mode => {
  it.each(['custom-message', 'command', 'branch-summary'] as const)('conserves raw/private history, copies, navigation and restart at %s', async family => {
    const root = await mkdtemp(path.join(tmpdir(), 'compaction-generalized-boundary-')); roots.push(root);
    const { store } = createStore(root, mode);
    const manager = new SessionManager({ store }); const session = await manager.create();
    const id = session.id;
    await manager.addMessage(id, { role: 'user', content: 'COMPACTED_ORDINARY_PREFIX' }, { skipAutoCompaction: true });
    // Parent order, not timestamps, owns the cut. Commands before the boundary must not reappear.
    await manager.addCommand(id, { command: 'old', cwd: root, output: 'COMPACTED_COMMAND_PREFIX', status: 'completed', timestamp: new Date(5000) });
    const target = family === 'custom-message'
      ? await manager.appendCustomMessage(id, 'public', 'KEPT_PUBLIC_BOUNDARY', { display: false, details: { secret: 'PRIVATE_DETAILS' } })
      : family === 'branch-summary'
        ? await manager.addBranchSummary(id, 'KEPT_PUBLIC_BOUNDARY', 'kept-branch', { provider: 'private-provider', model: 'private-model', usage: { inputTokens: 2, outputTokens: 3 } })
        : await manager.addCommand(id, { command: 'kept', cwd: root, output: 'KEPT_PUBLIC_BOUNDARY', status: 'completed', timestamp: new Date(1) });
    expect(target).not.toBeNull(); if (!target) throw new Error('Fixture boundary missing.');
    const boundary = family === 'command' ? `context-${target.id}` : target.id;
    await manager.appendCustomEntry(id, 'private', { secret: 'PRIVATE_STATE', anchor: boundary });
    await manager.addMessage(id, { role: 'user', content: 'KEPT_USER' }, { skipAutoCompaction: true });
    await manager.addMessage(id, { role: 'assistant', content: 'KEPT_ASSISTANT' }, { skipAutoCompaction: true });
    const before = (await manager.getRawEntries(id)).filter(entry => entry.type !== 'metadata');
    const source = manager.captureCompactionSource(id); expect(source).not.toBeNull();
    if (!source) throw new Error('Fixture source missing.');
    await manager.applyCompaction(id, 'NEW_CONTEXT_SUMMARY', boundary, {}, { source });
    const expectedMessages = ['KEPT_USER', 'KEPT_ASSISTANT'];
    expect(manager.get(id)?.messages.map(message => message.content)).toEqual(expectedMessages);
    const contents = (value: SessionManager, selectedId: string): string[] => value.getEffectiveContext(selectedId)
      .flatMap(entry => entry.type === 'message' ? [entry.content] : []);
    const expectedContext = contents(manager, id);
    expect(expectedContext).toHaveLength(4);
    expect(expectedContext[0]).toBe('[Context Summary] NEW_CONTEXT_SUMMARY');
    expect(expectedContext[1]).toContain('KEPT_PUBLIC_BOUNDARY');
    expect(expectedContext.slice(2)).toEqual(expectedMessages);
    expect(JSON.stringify(expectedContext)).not.toMatch(/COMPACTED_|PRIVATE_|private-provider|private-model/);
    const raw = await manager.getRawEntries(id);
    expect(raw.filter(entry => entry.type === 'compaction')).toHaveLength(1);
    for (const entry of before) expect(raw.find(next => next.id === entry.id)).toEqual(entry);
    expect((await manager.getActiveBranchEntries(id)).some(entry => entry.type === 'custom' && entry.customType === 'private')).toBe(true);
    const compaction = raw.find(entry => entry.type === 'compaction');
    expect(compaction?.type === 'compaction' && compaction.firstKeptEntryId).toBe(boundary);

    for (const copy of [await manager.forkSession(id), await manager.cloneSession(id)]) {
      expect(copy).not.toBeNull(); if (!copy) throw new Error('Fixture copy missing.');
      expect(contents(manager, copy.id)).toEqual(expectedContext);
      expect(copy.messages.map(message => message.content)).toEqual(expectedMessages);
      const copiedRaw = await manager.getRawEntries(copy.id);
      const privateEntry = copiedRaw.find(entry => entry.type === 'custom' && entry.customType === 'private');
      expect(privateEntry?.type === 'custom' && privateEntry.data).toEqual({ secret: 'PRIVATE_STATE', anchor: boundary });
      if (store) {
        const restarted = new SessionManager({ store }); await restarted.loadFromStore(copy.id);
        expect(contents(restarted, copy.id)).toEqual(expectedContext);
        expect(restarted.get(copy.id)?.messages.map(message => message.content)).toEqual(expectedMessages);
      }
    }
    if (store) {
      const restarted = new SessionManager({ store }); await restarted.loadFromStore(id);
      expect(contents(restarted, id)).toEqual(expectedContext);
      expect(restarted.get(id)?.messages.map(message => message.content)).toEqual(expectedMessages);
    }
    if (!compaction) throw new Error('Fixture compaction missing.');
    const navigated = await manager.navigateTree(id, compaction.id);
    expect(navigated.status).toBe('navigated');
    expect(contents(manager, id)).toEqual(expectedContext);
    expect(manager.get(id)?.messages.map(message => message.content)).toEqual(expectedMessages);
  });
});

describe.each(['native', 'structural'] as const)('nonordinary raw-boundary read admission (%s)', mode => {
  it.each(['abort', 'replace-restore', 'same-store'] as const)('rechecks %s after the boundary read and before save admission', async action => {
    const root = await mkdtemp(path.join(tmpdir(), 'compaction-boundary-read-')); roots.push(root);
    const { disk, store } = createStore(root, mode);
    if (!store) throw new Error('Fixture store missing.');
    const manager = new SessionManager({ store }), session = await manager.create(), id = session.id;
    await manager.addMessage(id, { role: 'user', content: 'OLD_PREFIX' }, { skipAutoCompaction: true });
    const boundary = await manager.appendCustomMessage(id, 'public', 'KEPT_CUSTOM', { display: false });
    if (!boundary) throw new Error('Fixture boundary missing.');
    await manager.addMessage(id, { role: 'assistant', content: 'KEPT_ASSISTANT' }, { skipAutoCompaction: true });
    const source = manager.captureCompactionSource(id); if (!source) throw new Error('Fixture source missing.');
    const controller = new AbortController(), before = await manager.getRawEntries(id);
    const read = disk.getRawEntries.bind(disk);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let armed = true;
    disk.getRawEntries = async selectedId => {
      if (selectedId === id && armed) { armed = false; enter(); await released; }
      return read(selectedId);
    };
    const run = manager.applyCompaction(id, 'NEW_SUMMARY', boundary.id, {}, { source, signal: controller.signal });
    void run.catch(() => undefined);
    await entered;
    if (action === 'abort') controller.abort();
    else if (action === 'replace-restore') {
      manager.setStore(new JsonlSessionStore(path.join(root, 'replacement'))); manager.setStore(store);
    } else manager.setStore(store);
    release();
    if (action === 'same-store') await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toThrow(action === 'abort' ? 'Compaction cancelled' : 'Compaction context or policy changed.');
    disk.getRawEntries = read;
    const after = await read(id);
    if (action === 'same-store') {
      expect(after.filter(entry => entry.type === 'compaction')).toHaveLength(1);
      expect(manager.get(id)?.messages.map(message => message.content)).toEqual(['KEPT_ASSISTANT']);
    } else {
      expect(after).toEqual(before);
      expect(manager.get(id)?.messages.map(message => message.content)).toEqual(['OLD_PREFIX', 'KEPT_ASSISTANT']);
      expect(manager.getEffectiveContext(id).map(entry => entry.type === 'message' ? entry.content : '')).not.toContain('[Context Summary] NEW_SUMMARY');
    }
  });
});
