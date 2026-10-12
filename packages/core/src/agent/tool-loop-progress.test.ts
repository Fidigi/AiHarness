import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { runToolLoop, type ToolExecutionResult } from './tool-loop.js';
import type { ToolProgressInput, ToolProgressSnapshot } from './tool-progress.js';

async function setup() {
  const sessionManager = new SessionManager();
  const session = await sessionManager.create({ title: 'Progress' });
  const extensionRegistry = new ExtensionRegistry();
  const streamTurn = vi.fn().mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'outer-1', name: 'work', input: {} }] })
    .mockResolvedValueOnce({ content: 'final' });
  return { sessionManager, session, extensionRegistry, streamTurn };
}

describe('arbitrary registered/hosted progress in the shared loop', () => {
  it.each(['registered', 'hosted'])('correlates, drains, redacts and persists %s display progress without trusting metadata', async mode => {
    const state = await setup();
    const { sessionManager, session, extensionRegistry, streamTurn } = state;
    const snapshots: ToolProgressSnapshot[] = [];
    const results: ToolExecutionResult[] = [];
    let late!: (input: ToolProgressInput) => Promise<void>;
    const hostile = { usage: { totalTokens: 900, costUsd: 99 }, codemode: { store: { injected: true } },
      activatedTools: ['hidden'], toolCallId: 'spoof' };
    const execute = async (_input: unknown, context: ExtensionRuntimeContext) => {
      late = context.onProgress!;
      await context.onProgress!({ version: 1, content: 'secret:first', details: hostile });
      await context.onProgress!({ version: 1, content: 'secret:second' });
      return { content: 'result', details: hostile };
    };
    // A before hook cannot replace the bounded sink or host-issued ID.
    await extensionRegistry.load('hooks', api => api.before('before:tool', data => ({ ...data,
      context: { ...data.context, toolCallId: 'spoof', onProgress: async () => { throw new Error('spoof sink'); } } })));
    if (mode === 'registered') await extensionRegistry.load('work', api => api.registerTool({ name: 'work', description: 'Work', execute }));
    const usage = vi.fn();
    await runToolLoop({ sessionManager, sessionId: session.id, extensionRegistry, streamTurn,
      tools: [{ name: 'work', description: 'Work', parameters: {} }],
      ...(mode === 'hosted' ? { executeTool: (name: string, input: unknown, context: ExtensionRuntimeContext, signal?: AbortSignal) =>
        extensionRegistry.executeHostedTool(name, input, context, execute, signal) } : {}),
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() },
      redactText: text => text.replaceAll('secret', '[redacted]'),
      onToolProgress: async snapshot => { snapshots.push(snapshot); await Promise.resolve(); },
      onToolResult: result => { results.push(result); }, onToolUsage: usage });
    expect(snapshots.map(snapshot => [snapshot.toolCallId, snapshot.toolName, snapshot.content, snapshot.sequence])).toEqual([
      ['outer-1', 'work', '[redacted]:first', 1], ['outer-1', 'work', '[redacted]:second', 2],
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false, progress: { status: 'completed', sequence: 3,
      content: '[redacted]:second', details: hostile } });
    expect(usage).not.toHaveBeenCalled();
    const tool = session.messages.find(message => message.role === 'tool')!;
    expect(tool.metadata).toEqual({ toolProgress: results[0]!.progress });
    expect(tool.usage).toBeUndefined(); expect(results[0]!.activatedTools).toBeUndefined();
    expect(tool.metadata!.codemode).toBeUndefined();
    await late({ version: 1, content: 'late' });
    expect(snapshots).toHaveLength(2); expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it.each(['registered', 'hosted'])('preserves the host sink against in-place %s hook mutation', async mode => {
    const { sessionManager, session, extensionRegistry, streamTurn } = await setup();
    const spoof = vi.fn(async () => { throw new Error('spoof sink'); });
    await extensionRegistry.load('mutator', api => api.before('before:tool', data => {
      data.context.toolCallId = 'spoof';
      data.context.onProgress = spoof;
      data.context.cwd = '/transformed';
      return data;
    }));
    const execute = async (_input: unknown, context: ExtensionRuntimeContext) => {
      expect(context.toolCallId).toBe('outer-1');
      expect(context.cwd).toBe('/transformed');
      await context.onProgress!({ version: 1, content: 'real update' });
      return { content: 'result' };
    };
    if (mode === 'registered') await extensionRegistry.load('work', api => api.registerTool({ name: 'work', description: 'Work', execute }));
    const updates = vi.fn();
    await runToolLoop({ sessionManager, sessionId: session.id, extensionRegistry, streamTurn,
      tools: [{ name: 'work', description: 'Work', parameters: {} }],
      ...(mode === 'hosted' ? { executeTool: (name: string, input: unknown, context: ExtensionRuntimeContext, signal?: AbortSignal) =>
        extensionRegistry.executeHostedTool(name, input, context, execute, signal) } : {}),
      toolContext: { sessionManager, currentSessionId: session.id, notify: vi.fn() }, onToolProgress: updates });
    expect(spoof).not.toHaveBeenCalled();
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]![0]).toMatchObject({ toolCallId: 'outer-1', content: 'real update' });
    expect(session.messages.find(message => message.role === 'tool')?.metadata?.toolProgress)
      .toMatchObject({ toolCallId: 'outer-1', status: 'completed', content: 'real update' });
  });

  it.each(['throw', 'isError', 'sink'])('durably settles %s failure once after accepted updates', async failure => {
    const { sessionManager, session, extensionRegistry, streamTurn } = await setup();
    await extensionRegistry.load('work', api => api.registerTool({ name: 'work', description: 'Work', execute: async (_input, context) => {
      await context.onProgress!({ version: 1, content: 'partial' });
      if (failure === 'throw') throw new Error('failed');
      return { content: 'failed', isError: failure === 'isError' };
    } }));
    const result = vi.fn();
    await runToolLoop({ sessionManager, sessionId: session.id, extensionRegistry, streamTurn,
      toolContext: { sessionManager, notify: vi.fn() }, onToolResult: result,
      onToolProgress: () => { if (failure === 'sink') throw new Error('broken consumer'); } });
    expect(result).toHaveBeenCalledTimes(1);
    expect(result.mock.calls[0]![0]).toMatchObject({ isError: true, progress: { status: 'failed', content: 'partial' } });
    expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it('persists interrupted progress without late output, usage or declarations and prevents another turn', async () => {
    const { sessionManager, session, extensionRegistry, streamTurn } = await setup();
    const controller = new AbortController();
    let late!: (input: ToolProgressInput) => Promise<void>;
    await extensionRegistry.load('work', api => api.registerTool({ name: 'work', description: 'Work', execute: async (_input, context) => {
      late = context.onProgress!;
      await late({ version: 1, content: 'before stop', details: { usage: { costUsd: 100 } } });
      controller.abort();
      await late({ version: 1, content: 'after stop' });
      return { content: 'late result' };
    } }));
    const updates = vi.fn(); const terminal = vi.fn(); const usage = vi.fn();
    await expect(runToolLoop({ sessionManager, sessionId: session.id, extensionRegistry, streamTurn,
      signal: controller.signal, toolContext: { sessionManager, notify: vi.fn() },
      onToolProgress: updates, onToolResult: terminal, onToolUsage: usage })).rejects.toMatchObject({ name: 'AbortError' });
    expect(updates).toHaveBeenCalledTimes(1); expect(terminal).toHaveBeenCalledTimes(1);
    expect(streamTurn).toHaveBeenCalledTimes(1); expect(usage).not.toHaveBeenCalled();
    const tool = session.messages.find(message => message.role === 'tool')!;
    expect(tool).toMatchObject({ content: 'Tool execution interrupted.', isError: true,
      metadata: { interrupted: true, toolProgress: { toolCallId: 'outer-1', status: 'cancelled', content: 'before stop' } } });
    await late({ version: 1, content: 'later' });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(tool.metadata!.toolProgress).toEqual(terminal.mock.calls[0]![0].progress);
  });
});
