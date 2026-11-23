import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionRegistry, JsonlSessionStore, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController } from './rpc-controller.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(durable: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-rpc-summary-hook-')); roots.push(root);
  const manager = new SessionManager(durable ? { store: new JsonlSessionStore(path.join(root, 'sessions')) } : {}), source = await manager.create();
  await manager.addMessage(source.id, { role: 'user', content: 'Shared user' }); const target = source.activeLeafId!;
  await manager.appendCustomEntry(source.id, 'fixture:summary-state', { secret: 'NEVER_MODEL_STATE' });
  await manager.appendCustomMessage(source.id, 'fixture:summary-note', 'MODEL_CUSTOM_NOTE', { display: false, details: { secret: 'NEVER_MODEL_DETAILS' } });
  await manager.addMessage(source.id, { role: 'user', content: 'Abandoned user' });
  await manager.addMessage(source.id, { role: 'assistant', content: 'Abandoned answer' });
  const registry = new ExtensionRegistry(); registry.attachSessionManager(manager);
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' }), chat = vi.spyOn(provider, 'chat').mockResolvedValue({ content: 'Fallback summary' });
  const events: Array<Record<string, unknown>> = [];
  const controller = new RpcController({ sessionManager: manager, sessionId: source.id,
    provider, providerName: 'mock', model: 'mock-model', extensionRegistry: registry, tools: [],
    toolContext: { sessionManager: manager, currentSessionId: source.id, provider, providerName: 'mock', cwd: root, projectTrusted: false, notify: () => undefined },
  }, event => { events.push(event); }); await controller.initialize();
  return { manager, source, target, registry, provider, chat, controller, events };
}

for (const durable of [false, true]) describe(`RPC global summary hooks (durable=${durable})`, () => {
  it('uses global override without provider fallback and projects only permitted provenance', async () => {
    const f = await fixture(durable), from = f.source.activeLeafId, raw = await f.manager.getRawEntries(f.source.id);
    try {
      await f.registry.load('summary', api => { api.before('before:session:summary', event => {
        expect(Object.isFrozen(event)).toBe(true); expect(event.transcript).toContain('MODEL_CUSTOM_NOTE');
        expect(event.transcript).not.toContain('NEVER_MODEL_STATE'); expect(event.transcript).not.toContain('NEVER_MODEL_DETAILS');
        return { summary: 'Global override', provider: 'fixture', model: 'summary', usage: { totalTokens: 3 } };
      }); });
      expect(await f.controller.handle({ type: 'navigate_tree', entryId: f.target, summarize: true }))
        .toMatchObject({ success: true, data: { cancelled: false, stale: false, summaryEntryId: expect.any(String) } });
      expect(f.chat).not.toHaveBeenCalled();
      const wire = await f.controller.handle({ type: 'get_entries' });
      expect(wire).toMatchObject({ success: true, data: { entries: expect.arrayContaining([expect.objectContaining({
        type: 'branch_summary', summary: 'Global override', parentId: f.target, fromId: from, provider: 'fixture', model: 'summary', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
      })]) } });
      expect(JSON.stringify(wire)).not.toContain('NEVER_MODEL_STATE'); expect(JSON.stringify(wire)).not.toContain('NEVER_MODEL_DETAILS');
      expect((await f.manager.getRawEntries(f.source.id)).slice(0, raw.length)).toEqual(raw);
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });

  it('preserves queue/selection/raw journal and emits no session-change success on veto', async () => {
    const f = await fixture(durable);
    try {
      await f.registry.load('veto', api => { api.before('before:session:summary', () => ({ cancel: true, reason: 'PRIVATE_REASON' })); });
      await f.controller.handle({ type: 'steer', message: 'Keep steering' }); await f.controller.handle({ type: 'follow_up', message: 'Keep follow-up' });
      const state = await f.controller.handle({ type: 'get_state' }), raw = await f.manager.getRawEntries(f.source.id), count = f.events.length;
      expect(await f.controller.handle({ type: 'navigate_tree', entryId: f.target, summarize: true }))
        .toMatchObject({ success: true, data: { cancelled: true } });
      expect(await f.controller.handle({ type: 'get_state' })).toEqual(state); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
      expect(f.events.slice(count).some(event => event.type === 'session_info_changed')).toBe(false); expect(f.chat).not.toHaveBeenCalled();
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });

  it('does not invoke global hooks or provider without explicit summary authority', async () => {
    const f = await fixture(durable), hook = vi.fn(() => ({ summary: 'Not authorized' }));
    try {
      await f.registry.load('observe', api => { api.before('before:session:summary', hook); });
      expect(await f.controller.handle({ type: 'navigate_tree', entryId: f.target })).toMatchObject({ success: true, data: { cancelled: false } });
      expect(hook).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled();
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });

  it.each(['abort', 'eof', 'close', 'unload'] as const)('withdraws %s from an ignored signal and excludes competing foreground work', async action => {
    const f = await fixture(durable), entered = latch(), gate = latch(), leaf = f.source.activeLeafId;
    try {
      await f.registry.load('pending', api => { api.before('before:session:summary', async () => { entered.release(); await gate.promise; return { summary: 'Late override' }; }); });
      const raw = await f.manager.getRawEntries(f.source.id), pending = f.controller.handle({ type: 'navigate_tree', entryId: f.target, summarize: true });
      await entered.promise;
      expect(await f.controller.handle({ type: 'get_entries' })).toMatchObject({ success: true, data: { leafId: leaf } });
      for (const request of [{ type: 'prompt', message: 'No race' }, { type: 'new_session' }, { type: 'clone' }, { type: 'fork', entryId: f.target },
        { type: 'navigate_tree', entryId: f.target }, { type: 'reload_context_settings' }]) {
        expect(await f.controller.handle(request)).toMatchObject({ success: false, error: expect.stringContaining('while navigating') });
      }
      if (action === 'abort') await f.controller.handle({ type: 'abort' });
      else if (action === 'eof') f.controller.abortNavigation();
      else if (action === 'close') await f.controller.close();
      else await f.registry.unload('pending');
      expect(await pending).toMatchObject({ success: true, data: { cancelled: true } }); gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.source.activeLeafId).toBe(leaf); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw); expect(f.chat).not.toHaveBeenCalled();
    } finally { gate.release(); await f.controller.close(); await f.registry.shutdown(); }
  });

  it('scrubs extension failures instead of publishing or falling back', async () => {
    const f = await fixture(durable), raw = await f.manager.getRawEntries(f.source.id);
    try {
      await f.registry.load('error', api => { api.before('before:session:summary', () => { throw new Error('PRIVATE_ERROR'); }); });
      expect(await f.controller.handle({ type: 'navigate_tree', entryId: f.target, summarize: true })).toMatchObject({ success: false, error: 'Branch summary hook failed.' });
      expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw); expect(f.chat).not.toHaveBeenCalled();
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });
});
