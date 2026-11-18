import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';
import type { BranchSummaryRequest } from './branch-summarization.js';
import { SessionStoreAdapter } from '../sdk/session-store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function setup(durable: boolean | 'borrowed') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-navigation-'));
  roots.push(root);
  const store = durable === 'borrowed' ? new SessionStoreAdapter(new JsonlSessionStore(root))
    : durable ? new JsonlSessionStore(root) : undefined;
  const manager = new SessionManager({ store });
  const session = await manager.create({ title: 'Navigation' });
  await manager.addMessage(session.id, { role: 'user', content: 'Common root' });
  const rootId = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Common answer' });
  const branchPoint = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'user', content: 'Abandoned request' });
  const abandonedRequest = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned result' });
  const abandonedLeaf = session.activeLeafId!;
  return { root, store, manager, session, rootId, branchPoint, abandonedRequest, abandonedLeaf };
}

const text = (manager: SessionManager, id: string) => manager.getEffectiveContext(id)
  .map(entry => 'content' in entry ? entry.content : 'summary' in entry ? entry.summary : '');

for (const durable of [false, true, 'borrowed'] as const) describe(`${durable === 'borrowed' ? 'caller-store' : durable ? 'durable' : 'memory'} navigation`, () => {
  it('includes a parented manual summary immediately, once, and after reload', async () => {
    const { manager, session, store, root } = await setup(durable);
    const summary = await manager.addBranchSummary(session.id, 'The experiment failed.', 'Experiment');
    expect(text(manager, session.id)).toEqual([
      'Common root', 'Common answer', 'Abandoned request', 'Abandoned result',
      '[Branch Summary: Experiment]\nThe experiment failed.',
    ]);
    expect(manager.getEffectiveContext(session.id).filter(entry => entry.id === summary!.id)).toHaveLength(1);
    if (store) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(root) });
      await reloaded.loadFromStore(session.id);
      expect(text(reloaded, session.id)).toEqual(text(manager, session.id));
    }
  });

  it('navigates without generating, retains abandoned history and attaches the next sibling correctly', async () => {
    const { manager, session, branchPoint, abandonedLeaf } = await setup(durable);
    const result = await manager.navigateTree(session.id, branchPoint);
    expect(result).toMatchObject({ status: 'navigated', entryId: branchPoint });
    expect(session.activeLeafId).toBe(branchPoint);
    expect(text(manager, session.id)).toEqual(['Common root', 'Common answer']);
    await manager.addMessage(session.id, { role: 'user', content: 'New request' });
    expect(session.messages.at(-1)?.parentMessageId).toBe(branchPoint);
    expect((await manager.getRawEntries(session.id)).some(entry => entry.id === abandonedLeaf)).toBe(true);
    expect(text(manager, session.id)).toEqual(['Common root', 'Common answer', 'New request']);
  });

  it('summarizes only the abandoned suffix and puts its accounted summary on the destination', async () => {
    const { manager, session, branchPoint, abandonedLeaf, root } = await setup(durable);
    const summarizer = vi.fn(async (request: BranchSummaryRequest) => {
      expect(request.fromEntryId).toBe(abandonedLeaf);
      expect(request.targetEntryId).toBe(branchPoint);
      expect(request.entries.map(entry => 'content' in entry ? entry.content : '')).toEqual([
        'Abandoned request', 'Abandoned result',
      ]);
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0].role).toBe('user');
      expect(request.messages[0].content).toContain('Abandoned result');
      expect(request.messages[0].content).not.toContain('Common root');
      return { summary: 'Useful alternative outcome.', provider: 'openai', model: 'gpt-4o',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.125 } };
    });
    const result = await manager.navigateTree(session.id, branchPoint, { summarize: true, summarizer });
    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('navigated');
    expect(result.summary).toMatchObject({ parentEntryId: branchPoint, fromEntryId: abandonedLeaf,
      summary: 'Useful alternative outcome.', provider: 'openai', model: 'gpt-4o', usage: { costUsd: 0.125 } });
    expect(session.activeLeafId).toBe(result.summary!.id);
    expect(text(manager, session.id)).toEqual([
      'Common root', 'Common answer', '[Branch Summary: Navigation]\nUseful alternative outcome.',
    ]);
    const raw = await manager.getRawEntries(session.id);
    expect(raw.filter(entry => entry.type === 'branch_summary')).toHaveLength(1);
    expect(raw.some(entry => entry.id === abandonedLeaf)).toBe(true);
    await manager.addMessage(session.id, { role: 'user', content: 'Continue' });
    expect(session.messages.at(-1)?.parentMessageId).toBe(result.summary!.id);
    if (durable) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(root) });
      await reloaded.loadFromStore(session.id);
      expect(text(reloaded, session.id)).toEqual(text(manager, session.id));
    }
  });

  it('does not call an available summarizer unless explicitly requested', async () => {
    const { manager, session, branchPoint } = await setup(durable);
    const summarizer = vi.fn(async () => ({ summary: 'Must not be called' }));
    expect(await manager.navigateTree(session.id, branchPoint, { summarizer, summarize: false }))
      .toMatchObject({ status: 'navigated' });
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('does not call a provider for a current leaf or an ancestor-to-descendant move', async () => {
    const { manager, session, branchPoint, abandonedLeaf } = await setup(durable);
    const summarizer = vi.fn(async () => ({ summary: 'Must not be called' }));
    await manager.navigateTree(session.id, abandonedLeaf, { summarize: true, summarizer });
    await manager.navigateTree(session.id, branchPoint);
    await manager.navigateTree(session.id, abandonedLeaf, { summarize: true, summarizer });
    expect(summarizer).not.toHaveBeenCalled();
    expect(text(manager, session.id)).toEqual(['Common root', 'Common answer', 'Abandoned request', 'Abandoned result']);
  });

  it('fails closed for missing entries without consuming model authority or publishing', async () => {
    const { manager, session } = await setup(durable);
    const before = structuredClone(session);
    const raw = await manager.getRawEntries(session.id);
    const summarizer = vi.fn(async () => ({ summary: 'Never' }));
    expect(await manager.navigateTree(session.id, 'absent', { summarize: true, summarizer }))
      .toMatchObject({ status: 'not-found' });
    expect(summarizer).not.toHaveBeenCalled();
    expect(session).toEqual(before);
    expect(await manager.getRawEntries(session.id)).toEqual(raw);
  });

  it('does not publish when aborted during generation', async () => {
    const { manager, session, branchPoint } = await setup(durable);
    const before = structuredClone(session);
    const controller = new AbortController();
    const summarizer = vi.fn(async () => {
      controller.abort();
      return { summary: 'Obsolete after cancellation' };
    });
    expect(await manager.navigateTree(session.id, branchPoint,
      { summarize: true, summarizer, signal: controller.signal })).toMatchObject({ status: 'cancelled' });
    expect(session).toEqual(before);
    expect((await manager.getRawEntries(session.id)).some(entry => entry.type === 'branch_summary')).toBe(false);
  });

  it('does not overwrite a newer branch or block ordinary mutations while generating', async () => {
    const { manager, session, branchPoint } = await setup(durable);
    const summarizer = vi.fn(async () => {
      await manager.addMessage(session.id, { role: 'user', content: 'Concurrent continuation' });
      return { summary: 'Stale result' };
    });
    expect(await manager.navigateTree(session.id, branchPoint, { summarize: true, summarizer }))
      .toMatchObject({ status: 'stale' });
    expect(session.messages.at(-1)?.content).toBe('Concurrent continuation');
    expect((await manager.getRawEntries(session.id)).some(entry => entry.type === 'branch_summary')).toBe(false);
  });

  it('does not navigate or append a summary when generation fails', async () => {
    const { manager, session, branchPoint } = await setup(durable);
    const before = structuredClone(session);
    await expect(manager.navigateTree(session.id, branchPoint, { summarize: true,
      summarizer: async () => { throw new Error('Summarizer unavailable'); } }))
      .rejects.toThrow('Summarizer unavailable');
    expect(session).toEqual(before);
    expect((await manager.getRawEntries(session.id)).some(entry => entry.type === 'branch_summary')).toBe(false);
  });

  it('walks custom state without exposing it and includes display-hidden custom messages', async () => {
    const { manager, session, branchPoint, root } = await setup(durable);
    await manager.navigateTree(session.id, branchPoint);
    const state = await manager.appendCustomEntry(session.id, 'test.state', { privateState: 'not model context' });
    const custom = await manager.appendCustomMessage(session.id, 'test.notice', 'Relevant custom input',
      { display: false, details: { privateDetail: 'not model context either' } });
    await manager.addMessage(session.id, { role: 'user', content: 'Continue from custom' });
    expect(custom).toMatchObject({ parentEntryId: state!.id, display: false });
    expect(session.messages.at(-1)?.parentMessageId).toBe(custom!.id);
    expect(text(manager, session.id)).toEqual([
      'Common root', 'Common answer', '[Custom Message: test.notice]\nRelevant custom input', 'Continue from custom',
    ]);
    expect(JSON.stringify(manager.getEffectiveContext(session.id))).not.toContain('privateState');
    expect(JSON.stringify(manager.getEffectiveContext(session.id))).not.toContain('privateDetail');
    const raw = await manager.getRawEntries(session.id);
    expect(raw.find(entry => entry.id === state!.id)).toMatchObject({ type: 'custom', data: { privateState: 'not model context' } });
    if (durable) {
      const reloaded = new SessionManager({ store: new JsonlSessionStore(root) });
      await reloaded.loadFromStore(session.id);
      expect(text(reloaded, session.id)).toEqual(text(manager, session.id));
    }
  });
});

it('does not publish memory state if durable navigation fails', async () => {
  const { manager, session, store, branchPoint } = await setup(true);
  const before = structuredClone(session);
  const raw = await manager.getRawEntries(session.id);
  vi.spyOn(store!, 'saveSession').mockRejectedValueOnce(new Error('write refused'));
  await expect(manager.navigateTree(session.id, branchPoint, { summarize: true,
    summarizer: async () => ({ summary: 'Must not become visible' }) })).rejects.toThrow('Session persistence failed.');
  expect(session).toEqual(before);
  expect(await manager.getRawEntries(session.id)).toEqual(raw);
});

it('does not send an orphan tool result or unanswered tool declaration in model context', async () => {
  const manager = new SessionManager();
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'Start' });
  await manager.addMessage(session.id, { role: 'tool', content: 'Orphan result', toolCallId: 'missing-call' });
  await manager.addMessage(session.id, { role: 'assistant', content: 'Partial answer',
    toolCalls: [{ id: 'unanswered', name: 'read', input: { path: 'not-executed' } }],
    blocks: [{ type: 'text', text: 'Partial answer' }, { type: 'tool_call', id: 'unanswered', name: 'read', input: {} }] });
  expect(text(manager, session.id)).toEqual(['Start', 'Partial answer']);
  const last = manager.getEffectiveContext(session.id).at(-1)!;
  expect('toolCalls' in last && last.toolCalls?.length).toBeFalsy();
  expect('blocks' in last && last.blocks?.some(block => block.type === 'tool_call')).toBe(false);
});
