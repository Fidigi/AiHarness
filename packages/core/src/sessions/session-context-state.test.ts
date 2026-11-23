import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, JsonlSessionStore } from './session-manager.js';
import { getSessionAccounting } from './session-accounting.js';
import { serializeSession } from './serialization.js';
import type { SessionLoadout } from './session-context-state.js';
import { prepareCompactionContext } from './compaction-preparation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const loadout = (model = 'one'): SessionLoadout => ({ provider: 'mock', model, systemPrompt: 'PRIVATE_PROMPT',
  tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }], thinking: 'low' });
async function fixture(durable: boolean) {
  const root = durable ? await mkdtemp(path.join(os.tmpdir(), 'aih-context-state-')) : undefined;
  if (root) roots.push(root);
  const store = root ? new JsonlSessionStore(root) : undefined;
  const manager = new SessionManager({ store });
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'Original question' });
  const user = session.messages.at(-1)!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Original answer', provider: 'mock', model: 'one',
    usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, costUsd: 0.02 } });
  const assistant = session.messages.at(-1)!;
  const contents = (id = session.id) => manager.getEffectiveContext(id).flatMap(entry => entry.type === 'message' ? [entry.content] : []);
  return { manager, session, user, assistant, store, root, contents };
}

describe.each([false, true])('branch-relative context state (durable=%s)', durable => {
  it('owns repeated edits, preserves transcript/accounting, and replays only active ancestry through copies/restart', async () => {
    const f = await fixture(durable), id = f.session.id;
    const transcript = structuredClone(f.session.messages), raw = await f.manager.getRawEntries(id);
    const accounting = getSessionAccounting(raw, f.session.activeLeafId);
    const edit = { targetEntryId: f.assistant.id, replacement: 'First replacement' };
    await f.manager.appendContextEdit(id, edit); edit.replacement = 'Caller mutation';
    await f.manager.appendContextEdit(id, { targetEntryId: f.assistant.id });
    expect(f.contents()).toEqual(['Original question']);
    await f.manager.appendContextEdit(id, { targetEntryId: f.assistant.id, replacement: '' });
    expect(f.contents()).toEqual(['Original question', '']);
    expect(f.session.messages).toEqual(transcript);
    const after = await f.manager.getRawEntries(id);
    for (const entry of raw.filter(entry => entry.type !== 'metadata')) expect(after.find(next => next.id === entry.id)).toEqual(entry);
    const stats = getSessionAccounting(after, f.session.activeLeafId);
    expect(stats.active).toEqual(accounting.active); expect(stats.history).toEqual(accounting.history);
    const fork = await f.manager.forkSession(id), clone = await f.manager.cloneSession(id);
    expect(fork?.parentId).toBe(id); expect(clone?.parentId).toBeUndefined();
    expect(f.contents(fork!.id)).toEqual(f.contents()); expect(f.contents(clone!.id)).toEqual(f.contents());
    const clonedEdit = (await f.manager.getActiveBranchEntries(clone!.id)).filter(entry => entry.type === 'context_edit').at(-1)!;
    expect(clonedEdit.targetEntryId).toBe(clone!.messages[1].id);
    await f.manager.navigateTree(id, f.assistant.id);
    expect(f.contents()).toEqual(['Original question', 'Original answer']);
    if (f.store) {
      const reloaded = new SessionManager({ store: f.store });
      await reloaded.loadFromStore(clone!.id);
      expect(reloaded.getEffectiveContext(clone!.id)).toEqual(f.manager.getEffectiveContext(clone!.id));
      expect(reloaded.get(clone!.id)?.messages).toEqual(clone!.messages);
    }
  });

  it('uses edited public content for optional navigation summaries without reintroducing raw transcript bodies', async () => {
    const f = await fixture(durable);
    await f.manager.appendContextEdit(f.session.id, { targetEntryId: f.assistant.id, replacement: 'Edited summary input' });
    await f.manager.navigateTree(f.session.id, f.user.id, { summarize: true, summarizer: async request => {
      expect(JSON.stringify(request.messages)).toContain('Edited summary input');
      expect(JSON.stringify(request.messages)).not.toContain('Original answer');
      return { summary: 'Branch summary' };
    } });
    expect((await f.manager.getRawEntries(f.session.id)).some(entry => entry.type === 'message' && entry.content === 'Original answer')).toBe(true);
  });

  it('keeps tool correlation atomic and cannot create execution or expose retained full output via a replacement', async () => {
    const f = await fixture(durable), id = f.session.id;
    await f.manager.addMessage(id, { role: 'assistant', content: '',
      toolCalls: [{ id: 'read-call', name: 'read', input: { path: 'file.ts' } }] });
    const assistant = f.session.messages.at(-1)!;
    await f.manager.addMessage(id, { role: 'tool', toolCallId: 'read-call', name: 'read', content: 'TOOL_BODY',
      metadata: { fullContent: 'PRIVATE_OUTPUT' } });
    const tool = f.session.messages.at(-1)!;
    await f.manager.appendContextEdit(id, { targetEntryId: tool.id, replacement: 'Short result' });
    expect(JSON.stringify(f.manager.getEffectiveContext(id))).not.toContain('PRIVATE_OUTPUT');
    expect(f.manager.getEffectiveContext(id).find(entry => entry.id === tool.id)).toMatchObject({ toolCallId: 'read-call', content: 'Short result' });
    await f.manager.appendContextEdit(id, { targetEntryId: tool.id });
    expect(f.manager.getEffectiveContext(id).find(entry => entry.id === assistant.id)).toMatchObject({ toolCalls: [] });
    expect(f.manager.getEffectiveContext(id).some(entry => entry.id === tool.id)).toBe(false);
    const command = (await f.manager.addCommand(id, { command: 'inert', cwd: '/workspace', status: 'completed', output: 'COMMAND_BODY' }))!;
    await f.manager.appendContextEdit(id, { targetEntryId: `context-${command.id}`, replacement: 'Command replacement' });
    expect(f.contents()).toContain('Command replacement'); expect(f.contents().join()).not.toContain('COMMAND_BODY');
    await expect(f.manager.appendContextEdit(id, { targetEntryId: 'foreign' })).rejects.toThrow('active model entry');
  });

  it('records owned field deltas, complete private checkpoints, cumulative files and split spans across repeated compaction', async () => {
    const f = await fixture(durable), id = f.session.id;
    const first = loadout(); await f.manager.recordSessionLoadout(id, first);
    first.tools[0].description = 'caller mutation';
    expect(await f.manager.recordSessionLoadout(id, loadout())).toBeNull();
    const changed = await f.manager.recordSessionLoadout(id, loadout('two'));
    expect(changed?.changes).toEqual({ model: 'two' });
    await f.manager.addMessage(id, { role: 'assistant', content: '', toolCalls: [
      { id: 'read', name: 'read', input: { path: 'read.ts' } }, { id: 'edit', name: 'edit', input: { path: 'edited.ts' } },
      { id: 'failed', name: 'write', input: { path: 'failed.ts' } },
    ] });
    for (const [toolCallId, name, isError] of [['read', 'read', false], ['edit', 'edit', false], ['failed', 'write', true]] as const) {
      await f.manager.addMessage(id, { role: 'tool', content: 'Result', name, toolCallId, isError });
    }
    await f.manager.addMessage(id, { role: 'assistant', content: 'Retained span tail' });
    const kept = f.session.messages.at(-1)!;
    await f.manager.applyCompaction(id, 'Summary one', kept.id, { provider: 'mock', model: 'two', usage: { inputTokens: 7, outputTokens: 2, costUsd: 0.01 } });
    let entry = (await f.manager.getActiveBranchEntries(id)).findLast(entry => entry.type === 'compaction')!;
    expect(entry.checkpoint).toEqual({ loadout: loadout('two'), splitUserEntryId: f.user.id,
      fileOperations: { read: ['read.ts'], edited: ['edited.ts'], written: [], truncated: false } });
    expect(JSON.stringify(serializeSession(f.session))).not.toContain('PRIVATE_PROMPT');
    expect(JSON.stringify(f.manager.getEffectiveContext(id))).not.toContain('PRIVATE_PROMPT');
    expect(f.contents()[0]).toContain('[Context Summary] Summary one\n[File operations]');
    expect(f.contents()[1]).toBe('Retained span tail');
    await expect(f.manager.appendContextEdit(id, { targetEntryId: f.user.id })).rejects.toThrow('active model entry');
    await f.manager.appendContextEdit(id, { targetEntryId: kept.id, replacement: 'Edited retained tail' });
    await f.manager.addMessage(id, { role: 'user', content: 'Next prompt' });
    await f.manager.addMessage(id, { role: 'assistant', content: 'Final' });
    const last = f.session.messages.at(-1)!;
    const prepared = prepareCompactionContext(f.manager, id)!;
    expect(prepared.toCompact[0].content).toContain('Summary one');
    await f.manager.applyCompaction(id, 'Summary two', last.id);
    entry = (await f.manager.getActiveBranchEntries(id)).findLast(entry => entry.type === 'compaction')!;
    expect(entry.checkpoint?.fileOperations.read).toEqual(['read.ts']);
    const clone = await f.manager.cloneSession(id);
    expect(f.manager.getSessionLoadout(clone!.id)).toEqual(loadout('two'));
    if (f.store) {
      const reload = new SessionManager({ store: f.store }); await reload.loadFromStore(id);
      expect(reload.getSessionLoadout(id)).toEqual(loadout('two'));
      expect(reload.getEffectiveContext(id)).toEqual(f.manager.getEffectiveContext(id));
      const disk = await readFile(path.join(f.root!, id + '.jsonl'), 'utf8');
      expect(disk).toContain('PRIVATE_PROMPT'); // private local journal, not a browser DTO
      expect(disk).toContain('"version":2');
    }
  });
});

it('does not publish context state after a failed durable save', async () => {
  const f = await fixture(true), before = structuredClone(f.session), raw = await f.manager.getRawEntries(f.session.id);
  const save = vi.spyOn(f.store!, 'saveSession').mockRejectedValue(new Error('Disposable write failure'));
  try {
    await expect(f.manager.appendContextEdit(f.session.id, { targetEntryId: f.user.id })).rejects.toThrow('persistence failed');
    await expect(f.manager.recordSessionLoadout(f.session.id, loadout())).rejects.toThrow('persistence failed');
    expect(f.session).toEqual(before); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
  } finally { save.mockRestore(); }
});

it('rejects executable/oversized/foreign input without evaluating getters or publishing entries', async () => {
  const f = await fixture(false), before = await f.manager.getRawEntries(f.session.id), getter = vi.fn(() => 'body');
  await expect(f.manager.appendContextEdit(f.session.id, { targetEntryId: f.user.id, get replacement() { return getter(); } })).rejects.toThrow();
  await expect(f.manager.appendContextEdit(f.session.id, { targetEntryId: f.user.id, replacement: 'x'.repeat(512 * 1024 + 1) })).rejects.toThrow();
  await expect(f.manager.recordSessionLoadout(f.session.id, { ...loadout(), tools: [{ ...loadout().tools[0], parameters: { callback: getter } }] })).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled(); expect(await f.manager.getRawEntries(f.session.id)).toEqual(before);
  const controller = new AbortController(); controller.abort();
  await expect(f.manager.appendContextEdit(f.session.id, { targetEntryId: f.user.id }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
