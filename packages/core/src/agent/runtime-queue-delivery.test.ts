import { expect, it, vi } from 'vitest';
import { SessionManager } from '../sessions/session-manager.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { MockProvider } from '../providers/index.js';
import { ProviderContextOverflowError } from '../providers/context-overflow.js';
import { AgentRuntime } from './runtime.js';
import type { AgentQueueMode } from '../config/agent-settings.js';

it.each(['overflow', 'transient'])('does not dequeue during a held %s recovery after a tool boundary', async reason => {
  const gate = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), release: () => resolve() }; };
  const first = gate(), second = gate(), releaseFirst = gate(), releaseSecond = gate();
  const manager = new SessionManager(); const registry = new ExtensionRegistry(); const session = await manager.create({ title: 'Recovery queues' });
  await manager.addMessage(session.id, { role: 'user', content: 'prior '.repeat(1_000) });
  await manager.addMessage(session.id, { role: 'assistant', content: 'prior answer' });
  manager.setCompactionContextWindow(128_000); manager.setCompactionSettings({ enabled: true, reserveTokens: 0, keepRecentTokens: 20 });
  const summarize = vi.fn(async () => 'Prior history summarized.'); manager.setAutoCompactionCallback(summarize);
  await registry.load('probe', api => api.registerTool({ name: 'probe', description: '', execute: () => ({ content: 'tool result' }) }));
  const provider = new MockProvider({ type: 'mock' }); const calls: string[][] = [];
  vi.spyOn(provider, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
    calls.push(messages.filter(message => message.role === 'user' && /^(steer-|follow-up-)/u.test(message.content)).map(message => message.content));
    if (calls.length === 1) { first.release(); await releaseFirst.promise; complete?.({ content: '', toolCalls: [{ id: 'probe', name: 'probe', input: {} }] }); return; }
    if (calls.length === 2) { second.release(); await releaseSecond.promise; throw reason === 'overflow' ? new ProviderContextOverflowError() : new Error('Transient network failure'); }
    complete?.({ content: 'answer' });
  });
  const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, resolveProvider: () => provider, isProjectTrusted: () => true });
  const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'initial', maxRetries: 1, retryDelayMs: 0 });
  try {
    await first.promise; runtime.enqueue(run.id, 'steer', 'steer-1'); releaseFirst.release();
    await second.promise; for (const value of ['steer-2', 'steer-3']) runtime.enqueue(run.id, 'steer', value);
    runtime.enqueue(run.id, 'follow-up', 'follow-up-1'); releaseSecond.release();
    expect((await runtime.wait(run.id))!.phase).toBe('completed');
    expect(calls).toEqual([[], ['steer-1'], ['steer-1'], ['steer-1', 'steer-2'], ['steer-1', 'steer-2', 'steer-3'], ['steer-1', 'steer-2', 'steer-3', 'follow-up-1']]);
    expect(summarize).toHaveBeenCalledTimes(reason === 'overflow' ? 1 : 0);
    expect(manager.get(session.id)!.messages.filter(message => /^(steer-|follow-up-)/u.test(message.content)).map(message => message.content))
      .toEqual(['steer-1', 'steer-2', 'steer-3', 'follow-up-1']);
  } finally { releaseFirst.release(); releaseSecond.release(); await runtime.wait(run.id); }
});

for (const steeringMode of ['all', 'one-at-a-time'] as const) for (const followUpMode of ['all', 'one-at-a-time'] as const) {
  it(`delivers steering=${steeringMode}, follow-up=${followUpMode} once per boundary, without a double dequeue`, async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const manager = new SessionManager(); const registry = new ExtensionRegistry(); const session = await manager.create({ title: 'Queues' });
    const provider = new MockProvider({ type: 'mock' }); const calls: string[][] = [];
    vi.spyOn(provider, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
      calls.push(messages.filter(message => message.role === 'user').map(message => message.content));
      if (calls.length === 1) { entered(); await hold; }
      complete?.({ content: 'answer' });
    });
    const runtime = new AgentRuntime({ sessionManager: manager, extensionRegistry: registry, resolveProvider: () => provider, isProjectTrusted: () => true });
    const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'initial', steeringMode, followUpMode });
    try {
      await started;
      for (const kind of ['steer', 'follow-up'] as const) for (let i = 1; i <= 3; i++) runtime.enqueue(run.id, kind, `${kind}-${i}`);
      runtime.enqueue(run.id, 'follow-up', 'cleared'); runtime.clearQueue(run.id, 'follow-up');
      for (let i = 1; i <= 3; i++) runtime.enqueue(run.id, 'follow-up', `follow-up-${i}`);
      const before = runtime.snapshot(session.id).run!; expect(before.steerQueue).toHaveLength(3); expect(before.followUpQueue).toHaveLength(3);
      release(); expect((await runtime.wait(run.id))!.phase).toBe('completed');
      const expected: string[][] = [['initial']];
      const append = (kind: string, mode: AgentQueueMode) => {
        if (mode === 'all') expected.push([...expected.at(-1)!, ...[1, 2, 3].map(i => `${kind}-${i}`)]);
        else for (let i = 1; i <= 3; i++) expected.push([...expected.at(-1)!, `${kind}-${i}`]);
      };
      append('steer', steeringMode); append('follow-up', followUpMode);
      expect(calls).toEqual(expected);
      expect(manager.get(session.id)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(expected.at(-1));
      expect(runtime.snapshot(session.id).run).toMatchObject({ steerQueue: [], followUpQueue: [] });
      expect(() => runtime.enqueue(run.id, 'steer', 'late')).toThrow();
    } finally { release(); await runtime.wait(run.id); }
  });
}
