import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';
import type { Message } from '../types/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(durable: boolean) {
  const root = durable ? await mkdtemp(path.join(os.tmpdir(), 'aih-row-copy-')) : undefined;
  if (root) roots.push(root);
  const store = root ? new JsonlSessionStore(root) : undefined, manager = new SessionManager({ store });
  const source = await manager.create({ title: 'Displayed source', cwd: '/workspace', workspaceId: 'workspace',
    metadata: { independent: { value: 'source' } }, messages: [{ id: 'root', role: 'user', content: 'Root', timestamp: new Date(1) }] });
  const targets = [source.activeLeafId!];
  targets.push((await manager.addCommand(source.id, { command: 'inert', cwd: '/workspace', status: 'completed', output: 'Saved output' }))!.id);
  targets.push((await manager.appendCustomEntry(source.id, 'state', { value: 1 }))!.id);
  targets.push((await manager.appendCustomMessage(source.id, 'notice', 'Visible custom', { details: { private: true } }))!.id);
  targets.push((await manager.addBranchSummary(source.id, 'Saved summary', 'Visible branch'))!.id);
  await manager.addMessage(source.id, { role: 'assistant', content: 'Later reply' });
  return { manager, store, source, targets, bytes: () => root ? readFile(path.join(root, source.id + '.jsonl')) : undefined };
}

describe.each([false, true])('exact displayed ancestry clone (durable=%s)', durable => {
  it.each([0, 1, 2, 3, 4])('copies captured entry kind%d, never the later current leaf/window', async index => {
    const f = await fixture(durable), target = f.targets[index], before = structuredClone(f.source), bytes = await f.bytes();
    const original = (await f.manager.getActiveBranchEntries(f.source.id)).filter(entry => entry.type !== 'metadata');
    const through = original.findIndex(entry => entry.id === target), expected = original.slice(0, through + 1);
    const copy = await f.manager.cloneSessionAtEntry(f.source.id, target);
    expect(copy).not.toBeNull();
    expect(copy).toMatchObject({ title: 'Displayed source (clone)', cwd: '/workspace', workspaceId: 'workspace',
      parentId: undefined, branchId: undefined, metadata: { clonedFromSessionId: f.source.id, independent: { value: 'source' } } });
    const copied = (await f.manager.getActiveBranchEntries(copy!.id)).filter(entry => entry.type !== 'metadata');
    expect(copied.map(entry => entry.type)).toEqual(expected.map(entry => entry.type));
    expect(copied.every(entry => !original.some(source => source.id === entry.id))).toBe(true);
    expect(copy!.activeLeafId).toBe(copied.at(-1)?.id);
    expect(copy!.messages.some(message => message.content === 'Later reply')).toBe(false);
    expect(f.source).toEqual(before); expect(await f.bytes()).toEqual(bytes);
    if (f.store) {
      const reload = new SessionManager({ store: f.store });
      expect(await reload.loadFromStore(copy!.id)).toMatchObject({ id: copy!.id, activeLeafId: copy!.activeLeafId });
      expect(await reload.getActiveBranchEntries(copy!.id)).toEqual(await f.manager.getActiveBranchEntries(copy!.id));
    }
    await f.manager.addMessage(copy!.id, { role: 'user', content: 'Copy only' });
    (copy!.metadata!.independent as { value: string }).value = 'copy';
    expect(f.source).toEqual(before); expect(await f.bytes()).toEqual(bytes);
  });

  it.each(['missing', 'foreign', 'child', 'running-command', 'queued-command'] as const)('refuses%s without publishing a copy or changing source', async kind => {
    const f = await fixture(durable);
    let target = 'missing';
    if (kind === 'foreign') {
      const other = await f.manager.create({ messages: [{ id: 'foreign', role: 'user', content: 'Other source', timestamp: new Date(1) }] });
      target = other.activeLeafId!;
    } else if (kind === 'child') {
      await f.manager.update(f.source.id, { metadata: { ...f.source.metadata, subagent: true } }); target = f.targets[0];
    } else if (kind === 'running-command' || kind === 'queued-command') {
      target = (await f.manager.addCommand(f.source.id, { command: 'unfinished', cwd: '/workspace', status: kind === 'running-command' ? 'running' : 'queued' }))!.id;
    }
    const before = structuredClone(f.source), bytes = await f.bytes(), inventory = f.manager.list().map(item => item.id);
    expect(await f.manager.cloneSessionAtEntry(f.source.id, target)).toBeNull();
    expect(f.manager.list().map(item => item.id)).toEqual(inventory); expect(f.source).toEqual(before); expect(await f.bytes()).toEqual(bytes);
  });
});

for (const representation of ['calls', 'blocks'] as const) for (const kind of ['missing', 'partial', 'complete', 'orphan', 'duplicate'] as const) {
  it(`strict new-leaf group admission: ${representation}/${kind}; legacy clone unchanged`, async () => {
    const manager = new SessionManager();
    const calls = [{ id: 'one', name: 'read', input: {} }, { id: 'two', name: 'read', input: {} }];
    const messages: Message[] = [{ id: 'user', role: 'user', content: 'Question', timestamp: new Date(1) },
      { id: 'assistant', role: 'assistant', content: '', timestamp: new Date(2), parentMessageId: 'user',
        ...(representation === 'calls' ? { toolCalls: calls } : { blocks: calls.map(call => ({ type: 'tool_call' as const, ...call })) }) }];
    const result = (id: string, toolCallId: string, parentMessageId: string): Message => ({ id, role: 'tool', content: 'Result', name: 'read', toolCallId, parentMessageId, timestamp: new Date(3) });
    if (kind !== 'missing') messages.push(result('result-one', kind === 'orphan' ? 'foreign' : 'one', 'assistant'));
    if (kind === 'complete' || kind === 'duplicate') messages.push(result('result-two', kind === 'duplicate' ? 'one' : 'two', 'result-one'));
    const source = await manager.create({ messages }), before = structuredClone(source);
    const copy = await manager.cloneSessionAtEntry(source.id, source.activeLeafId!);
    if (kind === 'complete') expect(copy?.messages).toHaveLength(messages.length);
    else expect(copy).toBeNull();
    expect(source).toEqual(before);
    // Old generic raw-history clone is a distinct compatibility operation, not a complete-group validator.
    expect(await manager.cloneSession(source.id)).not.toBeNull();
  });
}

it('conserves policy veto and abort before publication, without replacing native branch admission', async () => {
  const f = await fixture(false), ids = f.manager.list().map(item => item.id);
  const remove = f.manager.onBeforeBranch(event => { expect(event.operation).toBe('clone'); expect(event.entryId).toBe(f.targets[0]); return false; });
  await expect(f.manager.cloneSessionAtEntry(f.source.id, f.targets[0])).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
  remove();
  const controller = new AbortController(); controller.abort();
  await expect(f.manager.cloneSessionAtEntry(f.source.id, f.targets[0], undefined, { signal: controller.signal })).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
  expect(f.manager.list().map(item => item.id)).toEqual(ids);
});

it('keeps a bounded valid Unicode source-title suffix instead of exceeding native4096-byte creation', async () => {
  const manager = new SessionManager(), title = '🙂'.repeat(1024);
  const source = await manager.create({ title, messages: [{ id: 'root', role: 'user', content: 'Root', timestamp: new Date(1) }] });
  const copy = await manager.cloneSessionAtEntry(source.id, 'root');
  expect(copy?.title).toBe('🙂'.repeat(1022) + ' (clone)');
  expect(Buffer.byteLength(copy!.title!)).toBe(4096); expect(source.title).toBe(title);
});

it('reads a persisted source snapshot without importing/loading/mutating that source', async () => {
  const f = await fixture(true), manager = new SessionManager({ store: f.store }), before = await f.bytes();
  const load = vi.spyOn(f.store!, 'loadSession');
  const events: unknown[] = []; manager.onBeforeBranch(event => { events.push(event); });
  expect(manager.get(f.source.id)).toBeUndefined();
  const copy = await manager.cloneSessionAtEntry(f.source.id, f.targets[2], undefined, { sourceStore: f.store });
  expect(copy?.metadata?.clonedFromSessionId).toBe(f.source.id);
  expect(manager.get(f.source.id)).toBeUndefined(); expect(manager.list().map(item => item.id)).toEqual([copy!.id]);
  expect(load.mock.calls.filter(([id]) => id === f.source.id)).toEqual([]);
  expect(await f.bytes()).toEqual(before);
  expect(events).toMatchObject([{ operation: 'clone', entryId: f.targets[2], externalSource: true }]);
});

it('retains existing veto admission for quiet external sources without publication', async () => {
  const f = await fixture(true), manager = new SessionManager({ store: f.store }), bytes = await f.bytes();
  manager.onBeforeBranch(event => { expect(event.externalSource).toBe(true); return false; });
  await expect(manager.cloneSessionAtEntry(f.source.id, f.targets[0], undefined, { sourceStore: f.store })).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' });
  expect(manager.list()).toEqual([]); expect(manager.get(f.source.id)).toBeUndefined(); expect(await f.bytes()).toEqual(bytes);
});

it.each(['command', 'custom', 'summary'] as const)('copies a nonmessage-only%s leaf without requiring a made-up last message', async kind => {
  const manager = new SessionManager(), source = await manager.create({ title: 'Empty source' });
  const entry = kind === 'command' ? await manager.addCommand(source.id, { command: 'inert', cwd: '/workspace', status: 'completed', output: 'Saved' })
    : kind === 'custom' ? await manager.appendCustomEntry(source.id, 'state', { value: 1 })
      : await manager.addBranchSummary(source.id, 'Saved summary', 'Summary');
  const before = structuredClone(source), copy = await manager.cloneSessionAtEntry(source.id, entry!.id);
  expect(copy?.messages).toEqual([]); expect(copy?.activeLeafId).toBeTruthy(); expect(copy?.activeLeafId).not.toBe(entry!.id);
  expect((await manager.getActiveBranchEntries(copy!.id)).at(-1)?.type).toBe(kind === 'summary' ? 'branch_summary' : kind);
  expect(source).toEqual(before);
});

it('copies a canonical compaction leaf with remapped retained references, not discarded model history', async () => {
  const manager = new SessionManager(), source = await manager.create({ messages: [
    { id: 'old-user', role: 'user', content: 'Discarded question', timestamp: new Date(1) },
    { id: 'old-answer', role: 'assistant', content: 'Discarded answer', parentMessageId: 'old-user', timestamp: new Date(2) },
    { id: 'kept-user', role: 'user', content: 'Kept question', parentMessageId: 'old-answer', timestamp: new Date(3) },
  ] });
  await manager.applyCompaction(source.id, 'Saved compacted context', 'kept-user');
  const leaf = source.activeLeafId!, before = structuredClone(source);
  const copy = await manager.cloneSessionAtEntry(source.id, leaf);
  expect(copy?.activeLeafId).not.toBe(leaf);
  const context = manager.getEffectiveContext(copy!.id);
  expect(context.some(entry => entry.content.includes('Saved compacted context'))).toBe(true);
  expect(context.some(entry => entry.content === 'Kept question')).toBe(true);
  expect(context.some(entry => entry.content.startsWith('Discarded'))).toBe(false);
  expect(source).toEqual(before);
});

it('aborts an uncooperative pending bound policy without late publication', async () => {
  const f = await fixture(false), controller = new AbortController(), ids = f.manager.list().map(item => item.id);
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  f.manager.onBeforeBranch(async () => { enter(); await blocked; });
  const pending = f.manager.cloneSessionAtEntry(f.source.id, f.targets[0], undefined, { signal: controller.signal });
  await entered; controller.abort();
  try { await expect(pending).rejects.toMatchObject({ code: 'SESSION_BRANCH_CANCELLED' }); }
  finally { release(); }
  expect(f.manager.list().map(item => item.id)).toEqual(ids);
});

it('never substitutes a later source reply after awaited admission', async () => {
  const f = await fixture(false), target = f.targets[0];
  f.manager.onBeforeBranch(async () => { await f.manager.addMessage(f.source.id, { role: 'assistant', content: 'Arrived during policy' }); });
  const copy = await f.manager.cloneSessionAtEntry(f.source.id, target);
  expect(copy?.messages.map(message => message.content)).toEqual(['Root']);
  expect(f.source.messages.at(-1)?.content).toBe('Arrived during policy');
});

it('owns clone options without evaluating accessors or accepting a source path/configuration object', async () => {
  const f = await fixture(false); let reads = 0;
  const accessor = Object.defineProperty({}, 'sourceStore', { get() { reads++; return f.store; } });
  await expect(f.manager.cloneSessionAtEntry(f.source.id, f.targets[0], undefined, accessor)).rejects.toThrow('Session clone options are invalid.');
  await expect(f.manager.cloneSessionAtEntry(f.source.id, f.targets[0], undefined, { sourceStore: {} as JsonlSessionStore })).rejects.toThrow('Session clone options are invalid.');
  expect(reads).toBe(0); expect(f.manager.list()).toHaveLength(1);
});

it.each([false, true])('compares captured scope, never uses it as destination authority (external=%s)', async external => {
  const f = await fixture(true), manager = external ? new SessionManager({ store: f.store }) : f.manager;
  const bytes = await f.bytes(), ids = manager.list().map(item => item.id);
  const options = { expectedCwd: '/different-workspace', ...(external ? { sourceStore: f.store } : {}) };
  expect(await manager.cloneSessionAtEntry(f.source.id, f.targets[2], undefined, options)).toBeNull();
  expect(manager.list().map(item => item.id)).toEqual(ids); expect(await f.bytes()).toEqual(bytes);
  options.expectedCwd = '/workspace';
  const copy = await manager.cloneSessionAtEntry(f.source.id, f.targets[2], undefined, options);
  expect(copy?.cwd).toBe('/workspace'); expect(await f.bytes()).toEqual(bytes);
});
