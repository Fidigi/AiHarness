import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController } from './rpc-controller.js';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const manager = new SessionManager();
  const session = await manager.create({ title: 'RPC navigation' });
  await manager.addMessage(session.id, { role: 'user', content: 'Common' });
  const target = session.activeLeafId!;
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned' });
  const source = session.activeLeafId!;
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const chat = vi.spyOn(provider, 'chat').mockResolvedValue({ content: 'Branch result', model: 'mock-model',
    usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14, costUsd: 0.02 } });
  const controller = new RpcController({ sessionManager: manager, sessionId: session.id,
    provider, providerName: 'mock', model: 'mock-model', extensionRegistry: new ExtensionRegistry(), tools: [],
    agentSettings: () => ({ branchSummary: { reserveTokens: 8_192 } }),
    toolContext: { sessionManager: manager, currentSessionId: session.id, provider, providerName: 'mock',
      cwd: '/workspace', projectTrusted: false, notify: () => undefined },
  }, () => undefined);
  await controller.initialize();
  return { manager, session, target, source, provider, chat, controller };
}

describe('RPC tree navigation', () => {
  it('defaults to no summary and preserves the abandoned journal', async () => {
    const f = await fixture();
    expect(await f.controller.handle({ type: 'navigate_tree', id: 'move', entryId: f.target }))
      .toMatchObject({ id: 'move', command: 'navigate_tree', success: true,
        data: { cancelled: false, stale: false, leafId: f.target } });
    expect(f.session.messages.map(message => message.content)).toEqual(['Common']);
    expect(f.chat).not.toHaveBeenCalled();
    expect((await f.manager.getRawEntries(f.session.id)).some(entry => entry.id === f.source)).toBe(true);
    await f.controller.close();
  });

  it('serializes an opt-in, tool-free, accounted summary on the destination branch', async () => {
    const f = await fixture();
    expect(await f.controller.handle({ type: 'navigate_tree', id: 'summary', entryId: f.target,
      summarize: true, customInstructions: 'Keep exact outcomes' })).toMatchObject({ success: true,
        data: { cancelled: false, stale: false, summaryEntryId: expect.any(String) } });
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect(f.chat.mock.calls[0][0][0].content).toContain('Keep exact outcomes');
    expect(f.chat.mock.calls[0][1]).toMatchObject({ tools: [], maxTokens: 4_096 });
    expect(await f.controller.handle({ type: 'get_entries' })).toMatchObject({ success: true,
      data: { leafId: f.session.activeLeafId, entries: expect.arrayContaining([{
        id: f.session.activeLeafId, type: 'branch_summary', parentId: f.target, fromId: f.source,
        timestamp: expect.any(String), summary: 'Branch result', branchName: 'RPC navigation',
        provider: 'mock', model: 'mock-model', usage: expect.any(Object),
      }]) } });
    expect((await f.manager.getBranchSummaries(f.session.id))[0]).toMatchObject({ usage: { inputTokens: 11, costUsd: 0.02 } });
    await f.controller.close();
  });

  it.each([{ summarize: 'yes' }, { summarize: 1 }, { summarize: true, customInstructions: 42 },
    { summarize: true, replaceInstructions: 'yes' }, { customInstructions: 'No explicit summary' }])(
    'rejects malformed summary request %j without changing the source', async fields => {
      const f = await fixture();
      expect(await f.controller.handle({ type: 'navigate_tree', entryId: f.target, ...fields })).toMatchObject({ success: false });
      expect(f.session.activeLeafId).toBe(f.source);
      expect(f.chat).not.toHaveBeenCalled();
      await f.controller.close();
    });

  it('allows reads and abort, but refuses competing foreground work during generation', async () => {
    const f = await fixture();
    f.chat.mockImplementationOnce(async (_messages, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const pending = f.controller.handle({ type: 'navigate_tree', id: 'pending', entryId: f.target, summarize: true });
    await vi.waitFor(() => expect(f.chat).toHaveBeenCalledTimes(1));
    expect(await f.controller.handle({ type: 'get_tree' })).toMatchObject({ success: true, data: { leafId: f.source } });
    for (const request of [{ type: 'prompt', message: 'No race' }, { type: 'new_session' },
      { type: 'navigate_tree', entryId: f.target }, { type: 'set_session_name', name: 'No race' }]) {
      expect(await f.controller.handle(request)).toMatchObject({ success: false,
        error: expect.stringContaining('while navigating') });
    }
    expect(await f.controller.handle({ type: 'abort', id: 'abort' })).toMatchObject({ success: true });
    expect(await pending).toMatchObject({ id: 'pending', success: true, data: { cancelled: true, leafId: f.source } });
    expect(await f.manager.getBranchSummaries(f.session.id)).toEqual([]);
    await f.controller.close();
  });

  it.each(['eof', 'close'] as const)('retires %s before awaited navigation admission resumes', async action => {
    const f = await fixture();
    const pending = f.controller.handle({ type: 'navigate_tree', id: 'pending', entryId: f.target, summarize: true });
    if (action === 'eof') f.controller.abortNavigation();
    else await f.controller.close();
    expect(await pending).toMatchObject({ success: true, data: { cancelled: true, leafId: f.source } });
    expect(await f.controller.handle({ type: 'navigate_tree', entryId: f.target, summarize: true }))
      .toMatchObject({ success: true, data: { cancelled: true, leafId: f.source } });
    expect(f.chat).not.toHaveBeenCalled();
    expect(f.session.activeLeafId).toBe(f.source);
    expect(await f.manager.getBranchSummaries(f.session.id)).toEqual([]);
    await f.controller.close();
  });

  it('closes an in-flight summary without publishing a new context', async () => {
    const f = await fixture();
    f.chat.mockImplementationOnce(async (_messages, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true });
    }));
    const pending = f.controller.handle({ type: 'navigate_tree', entryId: f.target, summarize: true });
    await vi.waitFor(() => expect(f.chat).toHaveBeenCalledTimes(1));
    await f.controller.close();
    expect(await pending).toMatchObject({ success: true, data: { cancelled: true } });
    expect(f.session.activeLeafId).toBe(f.source);
    expect(await f.manager.getBranchSummaries(f.session.id)).toEqual([]);
  });
});
