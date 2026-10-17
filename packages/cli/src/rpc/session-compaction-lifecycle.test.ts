import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { ExtensionRegistry, JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController } from './rpc-controller.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [];
afterEach(async context => {
  vi.restoreAllMocks(); const completed = roots.splice(0);
  if (context.task.result?.state === 'fail') console.error('Retained RPC compaction roots:', completed);
  else await Promise.all(completed.map(root => rm(root, { recursive: true, force: true })));
});
type Mode = 'memory' | 'native' | 'structural';
async function fixture(mode: Mode, stage: 'provider' | 'prepare' | 'save' = 'provider', late: 'resolve' | 'reject' = 'resolve', afterEvent?: (event: Record<string, unknown>, controller: RpcController) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-compaction-lifetime-')); roots.push(root);
  const disk = new JsonlSessionStore(path.join(root, 'source')), replacement = new JsonlSessionStore(path.join(root, 'replacement'));
  const entered = latch(), finish = latch(); let armed = false;
  const save = disk.saveSession.bind(disk), writes = vi.fn(async (...args: Parameters<typeof save>) => {
    if (armed && stage === 'save') { armed = false; entered.release(); await finish.promise; }
    await save(...args);
  }); disk.saveSession = writes;
  class BorrowedStore extends JsonlSessionStore {
    constructor() { super(undefined, false); }
    override setRedaction(...args: Parameters<JsonlSessionStore['setRedaction']>): void { disk.setRedaction(...args); }
    override listSessionIds() { return disk.listSessionIds(); }
    override loadSession(id: string) { return disk.loadSession(id); }
    override saveSession(...args: Parameters<JsonlSessionStore['saveSession']>) { return disk.saveSession(...args); }
    override async getRawEntries(id: string) {
      if (armed && stage === 'prepare') { armed = false; entered.release(); await finish.promise; }
      return disk.getRawEntries(id);
    }
    override deleteSession(id: string) { return disk.deleteSession(id); }
  }
  const store = mode === 'native' ? disk : new BorrowedStore(), manager = new SessionManager(mode === 'memory' ? {} : { store }), session = await manager.create({ autoCompaction: false });
  for (let index = 0; index < 6; index++) await manager.addMessage(session.id, { role: index % 2 ? 'assistant' : 'user', content: `Seed ${index}` });
  const target = session.messages[0]!.id, provider = new MockProvider({ type: 'mock', model: 'mock-model' });
  const chat = vi.spyOn(provider, 'chat').mockImplementation(async () => {
    if (stage === 'provider') { entered.release(); await finish.promise; if (late === 'reject') throw new Error('PRIVATE_LATE_ERROR'); }
    return { content: 'Owned RPC compaction', model: 'summary-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
  });
  const registry = new ExtensionRegistry(), events: Array<Record<string, unknown>> = [];
  registry.attachSessionManager(manager);
  const controller = new RpcController({ sessionManager: manager, sessionId: session.id, provider, providerName: 'mock', model: 'mock-model', extensionRegistry: registry, tools: [],
    toolContext: { sessionManager: manager, currentSessionId: session.id, provider, providerName: 'mock', cwd: root, projectTrusted: false, notify: () => undefined },
  }, event => { events.push(event); afterEvent?.(event, controller); }); await controller.initialize(); writes.mockClear();
  return { root, disk, store, replacement, manager, session, target, provider, chat, registry, events, controller, entered, finish,
    arm: () => { armed = true; }, bytes: () => readFile(disk.getSessionFilePath(session.id)!), writes };
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>) { f.finish.release(); await f.controller.close(); await f.registry.shutdown(); }
function withdraw(f: Awaited<ReturnType<typeof fixture>>, action: 'abort' | 'eof' | 'close') {
  if (action === 'abort') return f.controller.handle({ type: 'abort' });
  if (action === 'close') return f.controller.close();
  f.controller.abortNavigation(); return Promise.resolve();
}
const busy = (target: string) => [{ type: 'prompt', message: 'Not admitted' }, { type: 'compact' }, { type: 'new_session' }, { type: 'clone' }, { type: 'fork', entryId: target },
  { type: 'navigate_tree', entryId: target }, { type: 'reload_context_settings' }, { type: 'set_model', provider: 'mock', modelId: 'other' }, { type: 'cycle_model' },
  { type: 'bash', command: 'must-not-run' }, { type: 'set_session_name', name: 'No rename' }, { type: 'set_thinking_level', level: 'off' }, { type: 'set_auto_compaction', enabled: true },
  { type: 'steer', message: 'No steering' }, { type: 'follow_up', message: 'No follow-up' }];

for (const mode of ['memory', 'native', 'structural'] as const) describe(`RPC owned manual compaction (${mode})`, () => {
  for (const late of ['resolve', 'reject'] as const) it.each(['abort', 'eof', 'close'] as const)(`withdraws %s before a non-cooperative provider may ${late}`, async action => {
    const f = await fixture(mode, 'provider', late), raw = await f.manager.getRawEntries(f.session.id), snapshot = structuredClone(f.session), before = mode === 'memory' ? undefined : await f.bytes();
    const state = await f.controller.handle({ type: 'get_state' });
    try {
      const pending = f.controller.handle({ type: 'compact', id: 'owned' }); await f.entered.promise;
      expect(await f.controller.handle({ type: 'get_state' })).toMatchObject({ success: true, data: { isCompacting: true } });
      expect(await f.controller.handle({ type: 'get_entries' })).toMatchObject({ success: true, data: { leafId: snapshot.activeLeafId } });
      for (const request of busy(f.target)) expect(await f.controller.handle(request)).toMatchObject({ success: false, error: expect.stringContaining('while compacting') });
      await withdraw(f, action);
      expect(await pending).toMatchObject({ id: 'owned', success: false, error: 'Compaction cancelled' });
      expect(await f.controller.handle({ type: 'get_state' })).toEqual(state);
      expect(f.events.filter(event => event.type === 'compaction_end')).toEqual([expect.objectContaining({ aborted: true, errorMessage: 'Compaction cancelled' })]);
      f.finish.release(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(f.writes).not.toHaveBeenCalled();
      expect(f.events.some(event => event.type === 'compaction_end' && event.result)).toBe(false); expect(JSON.stringify(f.events)).not.toContain('PRIVATE_LATE_ERROR');
      expect(f.chat).toHaveBeenCalledTimes(1); if (before) expect(await f.bytes()).toEqual(before);
    } finally { await cleanup(f); }
  });
});

describe('RPC compaction captured structural preparation', () => {
  it.each(['abort', 'eof', 'close', 'replace', 'replace-restore', 'same-store'] as const)('revalidates %s after preparation but before save', async action => {
    const f = await fixture('structural', 'prepare'), before = await f.bytes(), raw = await f.manager.getRawEntries(f.session.id), snapshot = structuredClone(f.session);
    try {
      f.arm(); const pending = f.controller.handle({ type: 'compact' }); await f.entered.promise;
      let withdrawn: Promise<unknown> = Promise.resolve();
      if (action === 'abort' || action === 'eof' || action === 'close') withdrawn = withdraw(f, action);
      if (action === 'replace' || action === 'replace-restore') f.manager.setStore(f.replacement);
      if (action === 'replace-restore' || action === 'same-store') f.manager.setStore(f.store);
      f.finish.release(); const response = await pending; await withdrawn;
      if (action === 'same-store') { expect(response).toMatchObject({ success: true, data: { summary: 'Owned RPC compaction' } }); expect(f.writes).toHaveBeenCalledTimes(1); }
      else {
        expect(response).toMatchObject({ success: false }); expect(f.writes).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
        expect(await f.disk.getRawEntries(f.session.id)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(f.events.some(event => event.type === 'compaction_end' && event.result)).toBe(false);
      }
      expect(await f.replacement.listSessionIds()).toEqual([]);
    } finally { await cleanup(f); }
  });
});

for (const mode of ['native', 'structural'] as const) describe(`RPC compaction admitted ${mode} save`, () => {
  it.each(['abort', 'eof', 'close', 'replace', 'replace-restore'] as const)('finishes the captured write after %s without false cancellation', async action => {
    const f = await fixture(mode, 'save');
    try {
      f.arm(); const pending = f.controller.handle({ type: 'compact' }); await f.entered.promise;
      let withdrawn: Promise<unknown> = Promise.resolve();
      if (action === 'abort' || action === 'eof' || action === 'close') withdrawn = withdraw(f, action);
      if (action === 'replace' || action === 'replace-restore') f.manager.setStore(f.replacement);
      if (action === 'replace-restore') f.manager.setStore(f.store);
      f.finish.release(); expect(await pending).toMatchObject({ success: true, data: { summary: 'Owned RPC compaction' } }); await withdrawn;
      expect(f.writes).toHaveBeenCalledTimes(1); expect(f.events.filter(event => event.type === 'compaction_end')).toEqual([expect.objectContaining({ aborted: false, result: expect.any(Object) })]);
      const reloaded = await f.disk.loadSession(f.session.id); expect(reloaded?.metadata?.compactionSummary).toBe('Owned RPC compaction'); expect(reloaded?.activeLeafId).toBe(f.session.activeLeafId);
      expect((await f.disk.getRawEntries(f.session.id)).filter(entry => entry.type === 'message')).toHaveLength(6); expect(await f.replacement.listSessionIds()).toEqual([]);
    } finally { await cleanup(f); }
  });
});

for (const mode of ['memory', 'native', 'structural'] as const) describe(`RPC summary retry admission (${mode})`, () => {
  it.each(['cancel-start', 'cancel-delay', 'provider-immediate', 'provider-microtask', 'retry-finished', 'shadowed-signal', 'success'] as const)('revalidates %s without changing retry defaults or exposing withdrawn results', async phase => {
    let acknowledgement: ReturnType<RpcController['handle']> | undefined;
    const f = await fixture(mode, 'prepare', 'resolve', (event, controller) => {
      if ((phase === 'cancel-start' && event.type === 'summarization_retry_attempt_start')
        || (phase === 'cancel-delay' && event.type === 'summarization_retry_scheduled')
        || (phase === 'retry-finished' && event.type === 'summarization_retry_finished')) acknowledgement = controller.handle({ type: 'abort_retry' });
    });
    const raw = await f.manager.getRawEntries(f.session.id), snapshot = structuredClone(f.session), before = mode === 'memory' ? undefined : await f.bytes();
    const abortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
    const invocations: boolean[] = []; let reads = 0;
    f.chat.mockImplementation(async (_messages, options) => {
      const signal = options?.signal; expect(signal).toBeInstanceOf(AbortSignal);
      invocations.push(abortState.call(signal) === true);
      if (invocations.length === 1) throw new Error('Controlled first summary failure');
      if (phase === 'provider-immediate' || phase === 'provider-microtask' || phase === 'shadowed-signal') {
        if (phase === 'shadowed-signal') Object.defineProperty(signal!, 'aborted', { get() { reads++; return false; } });
        const cancel = (): void => { acknowledgement = f.controller.handle({ type: 'abort_retry' }); };
        if (phase === 'provider-microtask') queueMicrotask(cancel); else cancel();
      }
      return { content: 'RETRY_RESULT_MUST_STAY_WITHDRAWN', model: 'summary-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
    });
    try {
      const response = await f.controller.handle({ type: 'compact', id: 'retry' });
      expect(f.events.filter(event => event.type === 'summarization_retry_scheduled')).toEqual([
        expect.objectContaining({ attempt: 1, maxAttempts: 3, delayMs: 2_000 }),
      ]);
      expect(f.events.filter(event => event.type === 'summarization_retry_finished')).toHaveLength(1);
      expect(reads).toBe(0); expect(invocations).toEqual(phase === 'cancel-start' || phase === 'cancel-delay' ? [false] : [false, false]);
      expect(await f.controller.handle({ type: 'get_state' })).toMatchObject({ success: true, data: { isCompacting: false } });
      if (phase === 'success') {
        expect(response).toMatchObject({ success: true, data: { summary: 'RETRY_RESULT_MUST_STAY_WITHDRAWN', usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } } });
        expect(f.events.filter(event => event.type === 'compaction_end')).toEqual([expect.objectContaining({ aborted: false, result: expect.any(Object) })]);
        expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'message')).toEqual(raw.filter(entry => entry.type === 'message'));
        expect(f.writes).toHaveBeenCalledTimes(mode === 'memory' ? 0 : 1);
      } else {
        expect(await acknowledgement).toMatchObject({ success: true });
        const message = phase === 'cancel-delay' ? 'Retry aborted.' : 'Compaction cancelled';
        expect(response).toMatchObject({ id: 'retry', success: false, error: message });
        expect(f.events.filter(event => event.type === 'compaction_end')).toEqual([expect.objectContaining({ aborted: true, errorMessage: message })]);
        expect(JSON.stringify(f.events)).not.toContain('RETRY_RESULT_MUST_STAY_WITHDRAWN');
        expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(f.writes).not.toHaveBeenCalled();
        if (before) expect(await f.bytes()).toEqual(before);
      }
    } finally { await cleanup(f); }
  });
});

for (const mode of ['memory', 'native', 'structural'] as const) describe(`RPC summary listener lifetime (${mode})`, () => {
  it('captures one cancellation subscription before callbacks and removes it after an otherwise normal retry', async () => {
    const f = await fixture(mode, 'prepare'); let signal: AbortSignal | undefined, reads = 0, calls = 0;
    f.chat.mockImplementation(async (_messages, options) => {
      calls++;
      if (calls === 1) { expect(options?.signal).toBeInstanceOf(AbortSignal); signal = options?.signal; }
      expect(options?.signal).toBe(signal); expect(getEventListeners(signal!, 'abort')).toHaveLength(1);
      if (calls === 1) {
        const add = signal!.addEventListener.bind(signal), remove = signal!.removeEventListener.bind(signal);
        Object.defineProperties(signal!, {
          aborted: { get() { reads++; return false; } },
          addEventListener: { get() { reads++; return add; } },
          removeEventListener: { get() { reads++; return remove; } },
        });
        throw new Error('Controlled first summary failure');
      }
      return { content: 'Normal retry after callback exposure', model: 'summary-model' };
    });
    try {
      expect(await f.controller.handle({ type: 'compact' })).toMatchObject({ success: true, data: { summary: 'Normal retry after callback exposure' } });
      expect(calls).toBe(2); expect(reads).toBe(0); expect(getEventListeners(signal!, 'abort')).toHaveLength(0);
      expect(f.events.filter(event => event.type === 'summarization_retry_scheduled')).toEqual([expect.objectContaining({ maxAttempts: 3, delayMs: 2_000 })]);
      expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'message')).toHaveLength(6);
    } finally { await cleanup(f); }
  });
});

for (const mode of ['memory', 'native', 'structural'] as const) describe(`RPC compaction passive canonical identity (${mode})`, () => {
  it.each(['initial-getter', 'source-getter', 'sibling-getter', 'value', 'title'] as const)('validates %s without evaluating or redirecting source identity', async action => {
    const f = await fixture(mode), sourceId = f.session.id;
    await f.manager.appendCustomEntry(sourceId, 'fixture:private', { revision: 1 });
    const sibling = await f.manager.create({ title: 'Sibling' }), siblingId = sibling.id;
    const raw = await f.manager.getRawEntries(sourceId), siblingRaw = await f.manager.getRawEntries(siblingId), snapshot = structuredClone(f.session);
    const before = mode === 'memory' ? undefined : await f.bytes(), siblingBytes = mode === 'memory' ? undefined : await readFile(f.disk.getSessionFilePath(siblingId)!);
    f.writes.mockClear(); let reads = 0;
    const install = (id: string): void => { Object.defineProperty(f.session, 'id', { configurable: true, enumerable: true, get() { reads++; return id; } }); };
    const restore = (): void => { Object.defineProperty(f.session, 'id', { configurable: true, enumerable: true, writable: true, value: sourceId }); };
    f.chat.mockImplementation(async () => {
      if (action === 'source-getter') install(sourceId);
      if (action === 'sibling-getter') install(siblingId);
      if (action === 'value') f.session.id = siblingId;
      if (action === 'title') await f.manager.update(sourceId, { title: 'Canonical RPC title' });
      return { content: 'Owned RPC identity summary', model: 'summary-model', usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
    });
    try {
      if (action === 'initial-getter') install(sourceId);
      const response = await f.controller.handle({ type: 'compact', id: 'identity' });
      expect(reads).toBe(0); restore();
      expect(f.chat).toHaveBeenCalledTimes(action === 'initial-getter' ? 0 : 1);
      expect(await f.manager.getRawEntries(siblingId)).toEqual(siblingRaw); expect(f.manager.get(siblingId)).toBe(sibling);
      if (siblingBytes) expect(await readFile(f.disk.getSessionFilePath(siblingId)!)).toEqual(siblingBytes);
      if (action === 'title') {
        expect(response).toMatchObject({ id: 'identity', success: true, data: { summary: 'Owned RPC identity summary' } });
        expect(f.manager.get(sourceId)?.title).toBe('Canonical RPC title');
        expect(f.events.filter(event => event.type === 'compaction_end')).toEqual([expect.objectContaining({ aborted: false, result: expect.any(Object) })]);
        expect(f.writes).toHaveBeenCalledTimes(mode === 'memory' ? 0 : 2);
        expect((await f.manager.getRawEntries(sourceId)).filter(entry => entry.type === 'custom')).toEqual(raw.filter(entry => entry.type === 'custom'));
      } else {
        expect(response).toMatchObject({ id: 'identity', success: false, error: 'Compaction context or policy changed.' });
        expect(f.events.some(event => event.type === 'compaction_end' && event.result)).toBe(false);
        expect(await f.manager.getRawEntries(sourceId)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(f.writes).not.toHaveBeenCalled();
        if (before) expect(await f.bytes()).toEqual(before);
      }
    } finally { restore(); await cleanup(f); }
  });
});

for (const mode of ['native', 'structural'] as const) describe(`RPC compaction pre-provider ${mode} source`, () => {
  it.each(['replace', 'replace-restore', 'same-store'] as const)('retains authority across %s only when the store generation stays live', async action => {
    const f = await fixture(mode), before = await f.bytes(), snapshot = structuredClone(f.session), raw = await f.manager.getRawEntries(f.session.id);
    try {
      const pending = f.controller.handle({ type: 'compact' }); await f.entered.promise;
      if (action !== 'same-store') f.manager.setStore(f.replacement);
      if (action !== 'replace') f.manager.setStore(f.store);
      f.finish.release(); const response = await pending;
      if (action === 'same-store') expect(response).toMatchObject({ success: true, data: { summary: 'Owned RPC compaction' } });
      else { expect(response).toMatchObject({ success: false, error: 'Compaction context or policy changed.' }); expect(await f.bytes()).toEqual(before); expect(await f.disk.getRawEntries(f.session.id)).toEqual(raw); expect(f.session).toEqual(snapshot); expect(f.writes).not.toHaveBeenCalled(); }
      expect(await f.replacement.listSessionIds()).toEqual([]);
    } finally { await cleanup(f); }
  });
});
