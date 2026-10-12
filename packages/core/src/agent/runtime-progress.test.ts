import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { MockProvider } from '../providers/index.js';
import { SessionManager } from '../sessions/session-manager.js';
import { AgentEventJournal } from './events.js';
import { AgentRuntime } from './runtime.js';
import type { ToolProgressSnapshot } from './tool-progress.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function setup(execute: (_input: unknown, context: ExtensionRuntimeContext) => Promise<{ content: string }>, journal?: AgentEventJournal) {
  const sessionManager = new SessionManager();
  const session = await sessionManager.create({ title: 'Runtime progress' });
  const extensionRegistry = new ExtensionRegistry();
  await extensionRegistry.load('work', api => api.registerTool({ name: 'work', description: 'Work', execute }));
  const provider = new MockProvider({ type: 'mock' });
  vi.spyOn(provider, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
    complete?.(messages.some(message => message.role === 'tool') ? { content: 'done' } : {
      content: '', toolCalls: [{ id: 'outer', name: 'work', input: {} }],
    });
  });
  const usage = vi.fn();
  const runtime = new AgentRuntime({ sessionManager, extensionRegistry, resolveProvider: () => provider,
    isProjectTrusted: () => true, onUsage: usage, journal });
  return { runtime, session, sessionManager, usage };
}

describe('detached arbitrary progress snapshots/replay', () => {
  it('restores the exact current state after journal eviction, without top-level nested promotion or duplicates', async () => {
    const started = gate(); const hold = gate();
    let late!: NonNullable<ExtensionRuntimeContext['onProgress']>;
    const { runtime, session, usage } = await setup(async (_input, context) => {
      late = context.onProgress!;
      for (let i = 0; i < 12; i++) await late({ version: 1, content: `step:${i}`, details: { count: i, usage: { costUsd: 99 } } });
      started.release(); await hold.promise;
      return { content: 'result' };
    }, new AgentEventJournal(10));
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'work' });
    await started.promise;
    const snapshot = runtime.snapshot(session.id);
    expect(snapshot.run!.activeTool).toMatchObject({ id: 'outer', name: 'work', progress: {
      version: 1, toolCallId: 'outer', sequence: 12, status: 'running', content: 'step:11', details: { count: 11 } } });
    expect(snapshot.run!.activeTool!.nestedCalls).toBeUndefined();
    const replay = runtime.journal.replay(session.id, 1);
    expect(replay.reset).toBe(true);
    expect(replay.events).toHaveLength(10);
    expect(replay.events.at(-1)!.data).toEqual({ kind: 'tool', ...snapshot.run!.activeTool!.progress });
    expect(runtime.journal.replay(session.id, snapshot.lastSequence).events).toEqual([]);
    snapshot.run!.activeTool!.progress!.content = 'client mutation';
    expect(runtime.snapshot(session.id).run!.activeTool!.progress!.content).toBe('step:11');
    hold.release(); await runtime.wait(run.id);
    expect(runtime.snapshot(session.id).run!.activeTool).toBeUndefined();
    const events = runtime.journal.replay(session.id).events;
    expect(events.filter(event => event.type === 'tool.completed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'run.completed')).toHaveLength(1);
    const terminal = events.find(event => event.type === 'tool.completed')!.data as { progress: ToolProgressSnapshot };
    expect(terminal.progress).toEqual(session.messages.find(message => message.role === 'tool')!.metadata!.toolProgress);
    expect(terminal.progress).toMatchObject({ sequence: 13, status: 'completed', content: 'step:11' });
    expect(usage).not.toHaveBeenCalled();
    await late({ version: 1, content: 'after settlement' });
    expect(runtime.journal.replay(session.id).events).toEqual(events);
  });

  it('orders durable cancellation before terminal replay and suppresses late progress/results', async () => {
    const started = gate(); const hold = gate();
    let late!: NonNullable<ExtensionRuntimeContext['onProgress']>;
    const { runtime, session } = await setup(async (_input, context) => {
      late = context.onProgress!;
      await late({ version: 1, content: 'before stop' });
      started.release(); await hold.promise;
      await late({ version: 1, content: 'after stop' });
      return { content: 'late result' };
    });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'work' });
    await started.promise;
    runtime.stop(run.id);
    expect(runtime.journal.replay(session.id).events.some(event => event.type === 'run.stopped')).toBe(false);
    expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(0);
    hold.release(); await runtime.wait(run.id);
    const events = runtime.journal.replay(session.id).events;
    expect(events.filter(event => event.type === 'tool.progress')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool.failed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'run.stopped')).toHaveLength(1);
    expect(events.findIndex(event => event.type === 'tool.failed')).toBeLessThan(events.findIndex(event => event.type === 'run.stopped'));
    expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(session.messages.find(message => message.role === 'tool')).toMatchObject({ isError: true,
      metadata: { interrupted: true, toolProgress: { status: 'cancelled', content: 'before stop' } } });
    await late({ version: 1, content: 'after settlement' });
    expect(runtime.journal.replay(session.id).events).toEqual(events);
  });
});
