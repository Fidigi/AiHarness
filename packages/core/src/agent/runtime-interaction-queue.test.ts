import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionRegistry, type ExtensionInteractionHandle, type ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import { MockProvider } from '../providers/index.js';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { AgentEventJournal } from './events.js';
import { AgentRuntime } from './runtime.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function setup(execute?: (context: ExtensionRuntimeContext) => Promise<string>, store?: JsonlSessionStore, failProvider = false) {
  const hold = gate(); const entered = gate();
  let context!: ExtensionRuntimeContext;
  const sessionManager = new SessionManager({ store });
  const session = await sessionManager.create({ title: 'Interaction queue' });
  const extensionRegistry = new ExtensionRegistry();
  await extensionRegistry.load('ask', api => api.registerTool({ name: 'ask', description: 'Ask', execute: async (_input, ctx) => {
    context = ctx; entered.release();
    return { content: execute ? await execute(ctx) : (await hold.promise, 'result') };
  } }));
  const provider = new MockProvider({ type: 'mock' });
  vi.spyOn(provider, 'streamChat').mockImplementation(async (messages, _chunk, complete) => {
    if (failProvider && messages.some(message => message.role === 'tool')) throw new Error('terminal provider failure');
    complete?.(messages.some(message => message.role === 'tool') ? { content: 'done' } : {
      content: '', toolCalls: [{ id: 'ask-outer', name: 'ask', input: {} }],
    });
  });
  const runtime = new AgentRuntime({ sessionManager, extensionRegistry, resolveProvider: () => provider,
    journal: new AgentEventJournal(10), isProjectTrusted: () => true });
  const run = await runtime.start({ sessionId: session.id, cwd: process.cwd(), provider: 'mock', input: 'ask', maxRetries: 0 });
  await entered.promise;
  return { runtime, session, run, hold, context, sessionManager };
}
const request = (title = 'Confirm') => ({ kind: 'confirm' as const, title });
const ui = (runtime: AgentRuntime, sessionId: string) => runtime.journal.replay(sessionId).events.filter(event => event.type === 'extension.ui');

describe('AgentRuntime ordered concurrent interactions', () => {
  it('runs genuine Promise.all extension requests, replaces in place, and validates against the current schema', async () => {
    let first!: ExtensionInteractionHandle; let second!: ExtensionInteractionHandle;
    const ready = gate();
    const { runtime, session, run } = await setup(async ctx => {
      first = ctx.requestInteraction!(request('first')) as ExtensionInteractionHandle;
      second = ctx.requestInteraction!({ kind: 'input', title: 'second' }) as ExtensionInteractionHandle;
      ready.release();
      return JSON.stringify(await Promise.all([first, second]));
    });
    await ready.promise;
    expect(runtime.snapshot(session.id).run!.extensionRequests!.map(item => item.id)).toEqual([first.id, second.id]);
    expect(first.update({ kind: 'select', title: 'first updated', options: [{ value: 'safe', label: 'Safe' }] })).toBe(true);
    const snapshot = runtime.snapshot(session.id);
    expect(snapshot.run!.extensionRequest).toEqual(snapshot.run!.extensionRequests![0]);
    expect(snapshot.run!.extensionRequests!.map(item => item.id)).toEqual([first.id, second.id]);
    expect(() => runtime.respondToInteraction(session.id, first.id, { cancelled: false, value: true })).toThrow('not an available option');
    expect(() => runtime.respondToInteraction('different-session', second.id, { cancelled: true })).toThrow('not found');
    runtime.respondToInteraction(session.id, second.id, { cancelled: false, value: 'text' });
    expect(runtime.getRun(run.id)!.extensionRequest!.id).toBe(first.id);
    runtime.respondToInteraction(session.id, first.id, { cancelled: false, value: 'safe' });
    expect(await Promise.all([first, second])).toEqual([{ cancelled: false, value: 'safe' }, { cancelled: false, value: 'text' }]);
    expect((await runtime.wait(run.id))!.phase).toBe('completed');
    expect(session.messages.find(message => message.role === 'tool')!.content).toBe('[{"cancelled":false,"value":"safe"},{"cancelled":false,"value":"text"}]');
    expect(first.close()).toBe(false); expect(first.update(request())).toBe(false);
    expect(() => runtime.respondToInteraction(session.id, first.id, { cancelled: true })).toThrow('not found');
  });

  it('retains a bounded ordered reconnect snapshot across journal eviction; single events do not replicate the queue', async () => {
    const { runtime, session, run, hold } = await setup();
    const handles = Array.from({ length: 4 }, (_, index) => runtime.requestExtensionInteraction(session.id, request(`request ${index}`)));
    for (let i = 0; i < 12; i++) handles[2].update(request(`update ${i}`));
    expect(runtime.journal.replay(session.id, 1).reset).toBe(true);
    const snapshot = runtime.snapshot(session.id);
    expect(snapshot.run!.extensionRequests!.map(item => item.id)).toEqual(handles.map(handle => handle.id));
    expect(snapshot.run!.extensionRequests![2].title).toBe('update 11');
    snapshot.run!.extensionRequests!.reverse(); snapshot.run!.extensionRequest!.title = 'client mutation';
    expect(runtime.getRun(run.id)!.extensionRequest!.title).toBe('request 0');
    for (const event of ui(runtime, session.id)) expect(Object.keys(event.data as object).sort()).toEqual(['action', 'request']);
    expect(runtime.journal.replay(session.id, snapshot.lastSequence).events).toEqual([]);
    handles[1].close();
    expect(runtime.getRun(run.id)!.extensionRequests!.map(item => item.id)).toEqual([handles[0].id, handles[2].id, handles[3].id]);
    hold.release(); await runtime.wait(run.id);
    expect(await Promise.all(handles)).toEqual(handles.map(() => ({ cancelled: true })));
    expect(runtime.getRun(run.id)!.extensionRequests).toEqual([]);
  });

  it('bounds count, individual UTF-8 payload and aggregate bytes without evicting promises or publishing rejected updates', async () => {
    const { runtime, session, run, hold } = await setup();
    const handles = Array.from({ length: 16 }, () => runtime.requestExtensionInteraction(session.id, request()));
    const sequence = runtime.snapshot(session.id).lastSequence;
    expect(() => runtime.requestExtensionInteraction(session.id, request())).toThrow('queue is full');
    expect(() => handles[0].update({ kind: 'editor', title: 'oversize', output: '界'.repeat(100_000) })).toThrow('too large');
    expect(runtime.snapshot(session.id).lastSequence).toBe(sequence);
    handles.forEach(handle => handle.close()); await Promise.all(handles);
    const big = Array.from({ length: 5 }, () => runtime.requestExtensionInteraction(session.id, { kind: 'editor', title: 'large', output: 'x'.repeat(100_000) }));
    expect(() => runtime.requestExtensionInteraction(session.id, { kind: 'editor', title: 'aggregate', output: 'x'.repeat(100_000) })).toThrow('queue is full');
    expect(() => big[0].update({ kind: 'editor', title: 'large', output: 'x'.repeat(100_000), message: '界'.repeat(10_000) })).toThrow('too large');
    expect(runtime.getRun(run.id)!.extensionRequests).toHaveLength(5);
    big.forEach(handle => handle.close()); hold.release(); await runtime.wait(run.id);
  });

  it('isolates ordered queues and capacity across active runs in the same runtime', async () => {
    const { runtime, session, run, hold, sessionManager } = await setup();
    const other = await sessionManager.create({ title: 'Other queue' });
    const otherRun = await runtime.start({ sessionId: other.id, cwd: process.cwd(), provider: 'mock', input: 'ask' });
    await vi.waitFor(() => expect(runtime.getRun(otherRun.id)!.activeTool).toBeDefined());
    const first = Array.from({ length: 16 }, (_, i) => runtime.requestExtensionInteraction(session.id, request(`first ${i}`)));
    const second = Array.from({ length: 16 }, (_, i) => runtime.requestExtensionInteraction(other.id, request(`second ${i}`)));
    expect(runtime.getRun(run.id)!.extensionRequests!.map(item => item.id)).toEqual(first.map(handle => handle.id));
    expect(runtime.getRun(otherRun.id)!.extensionRequests!.map(item => item.id)).toEqual(second.map(handle => handle.id));
    expect(() => runtime.respondToInteraction(other.id, first[0].id, { cancelled: true })).toThrow('not found');
    first[0].close();
    expect(runtime.getRun(otherRun.id)!.extensionRequests).toHaveLength(16);
    hold.release(); await Promise.all([runtime.wait(run.id), runtime.wait(otherRun.id)]);
    expect(await Promise.all([...first, ...second])).toEqual(Array.from({ length: 32 }, () => ({ cancelled: true })));
  });

  it('honors independent request abort/deadline, keeps the original deadline on update, and never serializes signals', async () => {
    const { runtime, session, run, hold } = await setup();
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const first = runtime.requestExtensionInteraction(session.id, { ...request('abort'), signal: controller.signal });
      const second = runtime.requestExtensionInteraction(session.id, { ...request('timeout'), timeoutMs: 100 });
      const third = runtime.requestExtensionInteraction(session.id, request('unrelated'));
      expect(runtime.getRun(run.id)!.extensionRequests!.every(item => !('signal' in item) && !('timeoutMs' in item))).toBe(true);
      await vi.advanceTimersByTimeAsync(80); second.update(request('rerender'));
      controller.abort(); expect(await first).toEqual({ cancelled: true });
      expect(runtime.getRun(run.id)!.extensionRequest!.id).toBe(second.id);
      await vi.advanceTimersByTimeAsync(20); expect(await second).toEqual({ cancelled: true });
      expect(runtime.getRun(run.id)!.extensionRequest!.id).toBe(third.id);
      const sequence = runtime.snapshot(session.id).lastSequence;
      expect(first.close()).toBe(false); expect(second.close()).toBe(false); expect(runtime.snapshot(session.id).lastSequence).toBe(sequence);
      expect(() => runtime.requestExtensionInteraction(session.id, { ...request(), timeoutMs: NaN })).toThrow('timeout is invalid');
      const already = runtime.requestExtensionInteraction(session.id, { ...request(), signal: controller.signal });
      expect(await already).toEqual({ cancelled: true }); expect(already.close()).toBe(false);
      third.close();
    } finally { vi.useRealTimers(); }
    hold.release(); await runtime.wait(run.id);
  });

  it('installs settlement before request delivery and suppresses duplicate closes even with reentrant transport', async () => {
    const { runtime, session, run, hold } = await setup();
    const unsubscribe = runtime.journal.subscribe(session.id, event => {
      if (event.type === 'extension.ui' && (event.data as { action: string }).action === 'request') {
        const id = (event.data as { request: { id: string } }).request.id;
        runtime.respondToInteraction(session.id, id, { cancelled: false, value: true });
      }
    });
    const handle = runtime.requestExtensionInteraction(session.id, request());
    expect(await handle).toEqual({ cancelled: false, value: true });
    expect(handle.close()).toBe(false); expect(runtime.getRun(run.id)!.extensionRequests).toEqual([]);
    expect(ui(runtime, session.id).map(event => (event.data as { action: string }).action)).toEqual(['request', 'resolved']);
    unsubscribe(); hold.release(); await runtime.wait(run.id);
  });

  it('cleans successful rebuilds, suppresses old captured contexts/handles, and cannot cross-close by caller-supplied ID', async () => {
    const { runtime, session, run, hold, context } = await setup();
    const boundCommand = runtime.createExtensionInteractionRequester(session.id);
    const first = boundCommand(request('first'));
    const second = runtime.requestExtensionInteraction(session.id, request('second'));
    expect(() => Object.assign(first, { id: second.id })).toThrow();
    expect(first.close()).toBe(true); expect(runtime.getRun(run.id)!.extensionRequest!.id).toBe(second.id);
    runtime.clearExtensionInteractions(); expect(await second).toEqual({ cancelled: true });
    expect(second.update(request())).toBe(false);
    const sequence = runtime.snapshot(session.id).lastSequence;
    expect(await context.requestInteraction!(request('old code'))).toEqual({ cancelled: true });
    expect(await boundCommand(request('old command'))).toEqual({ cancelled: true });
    expect(runtime.snapshot(session.id).lastSequence).toBe(sequence);
    const fresh = runtime.requestExtensionInteraction(session.id, request('fresh generation'));
    expect(second.close()).toBe(false); expect(runtime.getRun(run.id)!.extensionRequest!.id).toBe(fresh.id);
    fresh.close(); hold.release(); await runtime.wait(run.id);
    expect(await context.requestInteraction!(request('after terminal'))).toEqual({ cancelled: true });
  });

  it.each(['completed', 'failed'] as const)('settles unawaited interactions before %s terminal publication', async phase => {
    let handle!: ExtensionInteractionHandle;
    const ready = gate(); const release = gate();
    const { runtime, session, run } = await setup(async context => {
      handle = context.requestInteraction!(request()) as ExtensionInteractionHandle;
      ready.release(); await release.promise;
      return 'success';
    }, undefined, phase === 'failed');
    await ready.promise; release.release(); await runtime.wait(run.id);
    expect(await handle).toEqual({ cancelled: true });
    const events = runtime.journal.replay(session.id).events;
    expect(runtime.getRun(run.id)!.phase).toBe(phase);
    expect(events.findIndex(event => event.type === 'extension.ui' && (event.data as { action: string }).action === 'resolved'))
      .toBeLessThan(events.findIndex(event => event.type === `run.${phase}`));
    expect(handle.close()).toBe(false);
  });

  it('preserves durable interrupted-tool/progress settlement before stopped replay and suppresses late requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-interaction-durable-'));
    const store = new JsonlSessionStore(root);
    const ready = gate(); const release = gate(); let handle!: ExtensionInteractionHandle;
    try {
      const { runtime, session, run, context } = await setup(async ctx => {
        await ctx.onProgress!({ version: 1, content: 'waiting' });
        handle = ctx.requestInteraction!(request()) as ExtensionInteractionHandle;
        ready.release(); await release.promise;
        return 'late result';
      }, store);
      await ready.promise;
      runtime.stop(run.id); expect(await handle).toEqual({ cancelled: true });
      expect(runtime.journal.replay(session.id).events.some(event => event.type === 'run.stopped')).toBe(false);
      const seen: boolean[] = [];
      const unsubscribe = runtime.journal.subscribe(session.id, event => { if (event.type === 'run.stopped') seen.push(session.messages.some(message => message.role === 'tool')); });
      release.release(); await runtime.wait(run.id); unsubscribe();
      expect(seen).toEqual([true]);
      const disk = await readFile(path.join(root, `${session.id}.jsonl`), 'utf8');
      expect(disk).toContain('interrupted'); expect(disk).toContain('waiting'); expect(disk).not.toContain('late result');
      expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
      const sequence = runtime.snapshot(session.id).lastSequence;
      expect(await context.requestInteraction!(request())).toEqual({ cancelled: true });
      expect(handle.close()).toBe(false); expect(runtime.snapshot(session.id).lastSequence).toBe(sequence);
    } finally { release.release(); await rm(root, { recursive: true, force: true }); }
  });
});

// Append-only retained-store measurement: do not claim inherited run registries are bounded.
it('queue churn releases request storage while exposing inherited completed-run retention', async () => {
  const {runtime,session,run,hold}=await setup();
  const pending = () => Object.getOwnPropertyDescriptor(runtime,'interactions')!.value as Map<string,unknown>;
  for (let i=0;i<2048;i++) {
    const handle=runtime.requestExtensionInteraction(session.id,request('churn '+i));
    expect(pending().size).toBe(1);
    handle.close(); expect(await handle).toEqual({cancelled:true});
    expect(pending().size).toBe(0);
    expect(runtime.getRun(run.id)!.extensionRequests).toEqual([]);
  }
  hold.release(); await runtime.wait(run.id);
  for (let i=0;i<64;i++) {
    const next=await runtime.start({sessionId:session.id,cwd:process.cwd(),provider:'mock',input:'retention '+i});
    await runtime.wait(next.id);
  }
  const retained=Object.getOwnPropertyDescriptor(runtime,'runs')!.value as Map<string,unknown>;
  expect(retained.size).toBe(65); // inherited runtime has no completed-run eviction policy
  expect(pending().size).toBe(0);
  expect(runtime.journal.replay(session.id).events.length).toBeLessThanOrEqual(10);
});
