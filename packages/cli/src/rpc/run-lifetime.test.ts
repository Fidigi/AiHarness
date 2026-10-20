import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController, type RpcDynamicTools } from './rpc-controller.js';

const latch = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(prepareDynamicTools?: (id: string, signal: AbortSignal) => Promise<RpcDynamicTools>) {
  const manager = new SessionManager(), registry = new ExtensionRegistry(), provider = new MockProvider({ type: 'mock', model: 'mock-model' }, ['reply']);
  const session = await manager.create({ cwd: process.cwd() }), records: Record<string, unknown>[] = [];
  registry.attachSessionManager(manager);
  const controller = new RpcController({ provider, sessionManager: manager, extensionRegistry: registry, sessionId: session.id,
    providerName: 'mock', tools: [], prepareDynamicTools, retryMaxRetries: 0,
    toolContext: { sessionManager: manager, currentSessionId: session.id, cwd: process.cwd(), notify: () => undefined } }, record => { records.push(record); });
  await controller.initialize(); records.length = 0;
  return { manager, registry, provider, session, records, controller };
}

describe('RPC run admission and settlement', () => {
  for (const type of ['prompt', 'steer', 'follow_up'] as const) for (const action of ['abort', 'eof', 'close'] as const) {
    it(`${action} withdraws pending ${type}, including ignored hooks and competing mutations`, async () => {
      const f = await fixture(), entered = latch(), finish = latch(); let later = 0;
      const stream = vi.spyOn(f.provider, 'streamChat');
      await f.registry.load('held', api => {
        api.before('before:agent', async () => { entered.release(); await finish.promise; });
        api.before('before:agent', () => { later++; });
      });
      try {
        const pending = f.controller.handle({ type, message: 'unpublished' }); await entered.promise;
        expect(await f.controller.handle({ type: 'new_session' })).toMatchObject({ success: false });
        expect(await f.controller.handle({ type: 'prompt', message: 'competitor' })).toMatchObject({ success: false });
        if (action === 'abort') expect(await f.controller.handle({ type: 'abort' })).toMatchObject({ success: true });
        else if (action === 'eof') f.controller.abortNavigation();
        else await f.controller.close();
        expect(await pending).toMatchObject({ success: false });
        expect(f.session.messages).toEqual([]); expect(stream).not.toHaveBeenCalled();
        finish.release(); await tick(); expect(later).toBe(0);
        expect(f.records.some(row => row.type === 'agent_start' || row.type === 'queue_update')).toBe(false);
      } finally { finish.release(); await f.controller.close(); await f.registry.unloadAll(); }
    });
  }

  it('acknowledges abort but joins held preparation/release before final settlement and close', async () => {
    const entered = latch(), prepare = latch(), cleaning = latch(), cleaned = latch(); let releases = 0;
    const f = await fixture(async () => { entered.release(); await prepare.promise;
      return { tools: [], execute: () => ({ content: 'unused' }), release: async () => { releases++; cleaning.release(); await cleaned.promise; } }; });
    try {
      expect(await f.controller.handle({ type: 'prompt', message: 'never published' })).toMatchObject({ success: true });
      await entered.promise;
      expect(await f.controller.handle({ type: 'abort' })).toMatchObject({ success: true });
      let closed = false; const closing = f.controller.close().then(() => { closed = true; });
      await tick(); expect(closed).toBe(false); prepare.release(); await cleaning.promise;
      expect(f.session.messages).toEqual([]); expect(f.records.some(row => row.type === 'agent_settled')).toBe(false);
      cleaned.release(); await closing; expect(releases).toBe(1);
      expect(f.records.some(row => row.type === 'agent_start')).toBe(false);
    } finally { prepare.release(); cleaned.release(); await f.controller.close(); }
  });

  for (const aborted of [false, true]) it(`propagates owned release failure without retry or successful settlement (aborted=${aborted})`, async () => {
    const preparing = latch(), prepared = latch(), cleaning = latch(), cleaned = latch(); let releases = 0;
    const f = await fixture(async () => { preparing.release(); await prepared.promise;
      return { tools: [], execute: () => ({ content: 'unused' }), release: async () => {
        releases++; cleaning.release(); await cleaned.promise; throw new Error('RPC owned release failed');
      } }; });
    try {
      await f.controller.handle({ type: 'prompt', message: 'accepted' }); await preparing.promise;
      if (aborted) await f.controller.handle({ type: 'abort' });
      prepared.release(); await cleaning.promise;
      expect(f.records.some(row => row.type === 'agent_settled')).toBe(false);
      cleaned.release(); await f.controller.drain();
      await expect(f.controller.close()).rejects.toThrow('RPC owned release failed');
      expect(releases).toBe(1); expect(f.records.some(row => row.type === 'agent_settled')).toBe(false);
    } finally { prepared.release(); cleaned.release(); await f.controller.close().catch(() => undefined); }
  });

  it('emits only one final settlement after accepted follow-up continuations and their cleanup', async () => {
    const entered = latch(), finish = latch(), lastCleanup = latch(), cleaned = latch(); let preparations = 0;
    const f = await fixture(async () => { const ordinal = ++preparations;
      if (ordinal === 1) { entered.release(); await finish.promise; }
      return { tools: [], execute: () => ({ content: 'unused' }), release: async () => {
        if (ordinal === 2) { lastCleanup.release(); await cleaned.promise; }
      } }; });
    try {
      await f.controller.handle({ type: 'prompt', message: 'first' }); await entered.promise;
      await f.controller.handle({ type: 'follow_up', message: 'second' }); finish.release(); await lastCleanup.promise;
      expect(f.records.filter(row => row.type === 'agent_settled')).toHaveLength(0);
      cleaned.release(); await f.controller.drain();
      expect(f.records.filter(row => row.type === 'agent_start')).toHaveLength(2);
      expect(f.records.filter(row => row.type === 'agent_settled')).toHaveLength(1);
      expect(f.session.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['first', 'second']);
    } finally { finish.release(); cleaned.release(); await f.controller.close(); }
  });
});
