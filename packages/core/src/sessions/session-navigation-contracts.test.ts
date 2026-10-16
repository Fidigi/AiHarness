import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const content = (manager: SessionManager, id: string) => manager.getEffectiveContext(id)
  .flatMap(entry => entry.type === 'message' ? [entry.content] : []);

for (const durable of [false, true]) describe(`context boundaries durable=${durable}`, () => {
  it('navigates a large legacy prefix without raising the additional-entry limit or reviving later new roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-navigation-legacy-'));
    roots.push(root);
    const store = durable ? new JsonlSessionStore(root) : undefined;
    const manager = new SessionManager({ store });
    const session = await manager.create({ messages: Array.from({ length: 2_048 }, (_, index) => ({
      id: `legacy-${index}`, role: 'user' as const, content: `Legacy ${index}`, timestamp: new Date(index + 1),
    })) });
    await manager.navigateTree(session.id, 'legacy-1024');
    expect(content(manager, session.id)).toEqual(Array.from({ length: 1_025 }, (_, index) => `Legacy ${index}`));
    await manager.navigateTree(session.id, 'legacy-2047');
    expect(content(manager, session.id)).toHaveLength(2_048);
    await manager.branchBeforeEntry(session.id, 'legacy-0');
    await manager.addMessage(session.id, { role: 'user', content: 'New independent root' });
    expect(content(manager, session.id)).toEqual(['New independent root']);
    expect((await manager.getRawEntries(session.id)).filter(entry => entry.type === 'message')).toHaveLength(2_049);
    if (store) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(root) });
      await reloaded.loadFromStore(session.id);
      expect(content(reloaded, session.id)).toEqual(['New independent root']);
    }
  });

  it('uses the latest active compaction, later summaries and custom messages without abandoned text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-navigation-compact-'));
    roots.push(root);
    const store = durable ? new JsonlSessionStore(root) : undefined;
    const manager = new SessionManager({ store });
    const session = await manager.create();
    await manager.addMessage(session.id, { role: 'user', content: 'Old content' });
    await manager.addBranchSummary(session.id, 'Old alternative', 'Before compaction');
    await manager.addMessage(session.id, { role: 'user', content: 'Retained input' });
    await manager.applyCompaction(session.id, 'Compacted prefix', session.activeLeafId!);
    await manager.appendCustomEntry(session.id, 'state', { secretDetail: 'not model text' });
    await manager.appendCustomMessage(session.id, 'notice', 'Custom visible', { display: false });
    const selected = session.activeLeafId!;
    await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned answer' });
    await manager.navigateTree(session.id, selected, { summarize: true,
      summarizer: async () => ({ summary: 'Useful later summary' }) });
    expect(content(manager, session.id)).toEqual([
      '[Context Summary] Compacted prefix', 'Retained input', '[Custom Message: notice]\nCustom visible',
      `[Branch Summary: ${session.title || session.id}]\nUseful later summary`,
    ]);
    if (store) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(root) });
      await reloaded.loadFromStore(session.id);
      expect(content(reloaded, session.id)).toEqual(content(manager, session.id));
    }
  });

  it('reconstructs only the complete tool pairs actually present on a selected path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-navigation-tools-'));
    roots.push(root);
    const manager = new SessionManager({ store: durable ? new JsonlSessionStore(root) : undefined });
    const session = await manager.create();
    await manager.addMessage(session.id, { role: 'user', content: 'Read files' });
    await manager.addMessage(session.id, { role: 'assistant', content: 'Reading', toolCalls: [
      { id: 'one', name: 'read', input: { path: 'one' } }, { id: 'two', name: 'read', input: { path: 'two' } },
    ] });
    const declaration = session.activeLeafId!;
    await manager.addMessage(session.id, { role: 'tool', content: 'First result', toolCallId: 'one' });
    const first = session.activeLeafId!;
    await manager.addMessage(session.id, { role: 'tool', content: 'Second result', toolCallId: 'two' });
    const second = session.activeLeafId!;
    await manager.navigateTree(session.id, first);
    const partial = manager.getEffectiveContext(session.id);
    expect(partial).toMatchObject([{ content: 'Read files' },
      { content: 'Reading', toolCalls: [{ id: 'one' }] }, { content: 'First result', toolCallId: 'one' }]);
    expect(partial[1].type === 'message' && partial[1].toolCalls).toHaveLength(1);
    await manager.navigateTree(session.id, declaration);
    expect(content(manager, session.id)).toEqual(['Read files', 'Reading']);
    expect(manager.getEffectiveContext(session.id)[1]).toMatchObject({ toolCalls: [] });
    await manager.navigateTree(session.id, second);
    expect(content(manager, session.id)).toEqual(['Read files', 'Reading', 'First result', 'Second result']);
  });

  it('clones custom state and compacted summary ancestry with fresh entry identities', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-navigation-clone-'));
    roots.push(root);
    const store = durable ? new JsonlSessionStore(root) : undefined;
    const manager = new SessionManager({ store });
    const session = await manager.create({ title: 'Clone source' });
    await manager.addMessage(session.id, { role: 'user', content: 'Old input' });
    await manager.addBranchSummary(session.id, 'Compacted alternative', 'Old summary');
    await manager.addMessage(session.id, { role: 'user', content: 'Retained input' });
    await manager.applyCompaction(session.id, 'Compacted prefix', session.activeLeafId!);
    await manager.appendCustomEntry(session.id, 'state', { retainedState: 'Copied, not sent to model' });
    await manager.appendCustomMessage(session.id, 'notice', 'Useful custom context', { display: false });
    await manager.addBranchSummary(session.id, 'Active alternative', 'Later summary');
    const sourceContext = content(manager, session.id);
    const sourceIds = new Set((await manager.getRawEntries(session.id)).map(entry => entry.id));
    const clone = await manager.cloneSession(session.id);
    expect(clone).not.toBeNull();
    expect(content(manager, clone!.id)).toEqual(sourceContext);
    const copied = (await manager.getRawEntries(clone!.id)).filter(entry => entry.type !== 'metadata');
    expect(copied.every(entry => !sourceIds.has(entry.id))).toBe(true);
    expect(copied.filter(entry => entry.type === 'custom')).toMatchObject([
      { customType: 'state', data: { retainedState: 'Copied, not sent to model' } },
    ]);
    expect(copied.filter(entry => entry.type === 'custom_message')).toMatchObject([
      { customType: 'notice', content: 'Useful custom context', display: false },
    ]);
    const copiedIds = new Set(copied.map(entry => entry.id));
    for (const entry of copied) {
      const parent = entry.type === 'message' ? entry.parentMessageId : entry.parentEntryId;
      if (parent) expect(copiedIds.has(parent)).toBe(true);
    }
    if (store) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(root) });
      await reloaded.loadFromStore(clone!.id);
      expect(content(reloaded, clone!.id)).toEqual(sourceContext);
    }
  });
});

it('serializes tool identities and custom content, never custom state/details, into an owned summary request', async () => {
  const manager = new SessionManager();
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'Common' });
  const target = session.activeLeafId!;
  await manager.appendCustomEntry(session.id, 'state', { privateState: 'PRIVATE_STATE_VALUE' });
  await manager.appendCustomMessage(session.id, 'notice', 'Useful custom content',
    { display: false, details: { privateDetail: 'PRIVATE_DETAILS_VALUE' } });
  await manager.addMessage(session.id, { role: 'assistant', content: 'Read request',
    toolCalls: [{ id: 'recorded-read', name: 'read', input: { path: 'literal.txt' } }] });
  await manager.addMessage(session.id, { role: 'tool', content: 'Observed result', toolCallId: 'recorded-read' });
  const before = await manager.getRawEntries(session.id);
  const result = await manager.navigateTree(session.id, target, { summarize: true, summarizer: async request => {
    const transcript = request.messages[0].content;
    expect(transcript).toContain('Useful custom content');
    expect(transcript).toContain('[Tool call recorded-read: read]');
    expect(transcript).toContain('[Tool result recorded-read] Observed result');
    expect(transcript).not.toContain('PRIVATE_STATE_VALUE');
    expect(transcript).not.toContain('PRIVATE_DETAILS_VALUE');
    request.messages[0].content = 'Mutated owned request';
    const first = request.entries[0];
    if (first.type === 'custom_message') first.content = 'Mutated owned entry';
    return { summary: 'Useful branch outcome' };
  } });
  expect(result.status).toBe('navigated');
  const after = await manager.getRawEntries(session.id);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(content(manager, session.id)).toEqual(['Common', `[Branch Summary: ${session.title || session.id}]\nUseful branch outcome`]);
});

it('keeps a concrete disabled store truly in memory while retaining its complete branch journal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-navigation-disabled-'));
  roots.push(root);
  const manager = new SessionManager({ store: new JsonlSessionStore(path.join(root, 'absent'), false) });
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'Root' });
  const selected = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned' });
  await manager.navigateTree(session.id, selected, { summarize: true, summarizer: async () => ({ summary: 'Remember' }) });
  expect(content(manager, session.id)).toEqual(['Root', `[Branch Summary: ${session.title || session.id}]\nRemember`]);
  expect((await manager.getRawEntries(session.id)).filter(entry => entry.type !== 'metadata')).toHaveLength(3);
  expect(await fs.readdir(root)).toEqual([]);
});

it('rejects custom-data accessors without invoking them or publishing a new leaf', async () => {
  const manager = new SessionManager();
  const session = await manager.create();
  const getter = vi.fn(() => 'must not be read');
  const value = Object.defineProperty({}, 'payload', { get: getter, enumerable: true });
  await expect(manager.appendCustomEntry(session.id, 'state', value)).rejects.toThrow('Custom session data is invalid.');
  await expect(manager.appendCustomMessage(session.id, 'notice', 'Text', value)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(session.activeLeafId).toBeUndefined();
  expect(await manager.getRawEntries(session.id)).toEqual([]);
});

it.each([NaN, Infinity, -1, '10', null])('rejects invalid summary accounting %s before navigation publication', async counter => {
  const manager = new SessionManager();
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'Root' });
  const target = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Alternative' });
  const before = structuredClone(session);
  await expect(manager.navigateTree(session.id, target, { summarize: true,
    summarizer: async () => ({ summary: 'Useful', usage: { costUsd: counter as number } }) }))
    .rejects.toThrow('Branch summary accounting is invalid.');
  expect(session).toEqual(before);
});
