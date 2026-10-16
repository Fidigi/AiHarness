import { describe, expect, it } from 'vitest';
import { ExtensionRegistry, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController } from './rpc-controller.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function fixture() {
  const manager = new SessionManager(), source = await manager.create({ id: 'rpc-branch-source' });
  await manager.addMessage(source.id, { role: 'user', content: 'Root user' });
  await manager.appendCustomEntry(source.id, 'fixture:rpc-branch', { revision: 1 });
  await manager.addMessage(source.id, { role: 'user', content: 'Selected user' });
  const target = source.activeLeafId!;
  await manager.addMessage(source.id, { role: 'assistant', content: 'After selected user' });
  const registry = new ExtensionRegistry(); registry.attachSessionManager(manager);
  const provider = new MockProvider({ type: 'mock', model: 'mock-model' }), events: Array<Record<string, unknown>> = [];
  const controller = new RpcController({ sessionManager: manager, sessionId: source.id,
    provider, providerName: 'mock', model: 'mock-model', extensionRegistry: registry, tools: [],
    toolContext: { sessionManager: manager, currentSessionId: source.id, provider, providerName: 'mock',
      cwd: '/workspace', projectTrusted: false, notify: () => undefined },
  }, event => { events.push(event); });
  await controller.initialize();
  return { manager, source, target, registry, controller, events };
}
const request = (operation: 'fork' | 'clone', target: string) => ({ type: operation, ...(operation === 'fork' ? { entryId: target } : {}) });

for (const operation of ['fork', 'clone'] as const) describe(`RPC ${operation} branch lifetime`, () => {
  it('preserves selection, queued messages and journal on an extension veto', async () => {
    const f = await fixture();
    try {
      await f.registry.load('veto', api => { api.before('before:session:branch', () => ({ cancel: true })); });
      expect(await f.controller.handle({ type: 'steer', message: 'Keep steering' })).toMatchObject({ success: true });
      expect(await f.controller.handle({ type: 'follow_up', message: 'Keep follow-up' })).toMatchObject({ success: true });
      const state = await f.controller.handle({ type: 'get_state' }), raw = await f.manager.getRawEntries(f.source.id), leaf = f.source.activeLeafId;
      const count = f.events.length;
      expect(await f.controller.handle({ ...request(operation, f.target), id: 'vetoed' }))
        .toEqual({ id: 'vetoed', type: 'response', command: operation, success: true, data: { cancelled: true } });
      expect(await f.controller.handle({ type: 'get_state' })).toEqual(state);
      expect(f.events.slice(count).some(event => event.type === 'session_info_changed')).toBe(false);
      expect(f.manager.list()).toHaveLength(1); expect(f.source.activeLeafId).toBe(leaf);
      expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });

  it('allows safe reads and abort but excludes competing foreground work during an ignored hook signal', async () => {
    const f = await fixture(), gate = latch(), entered = latch();
    try {
      await f.registry.load('pending', api => { api.before('before:session:branch', async () => { entered.release(); await gate.promise; }); });
      const raw = await f.manager.getRawEntries(f.source.id), leaf = f.source.activeLeafId;
      const pending = f.controller.handle({ ...request(operation, f.target), id: 'pending' }); await entered.promise;
      expect(await f.controller.handle({ type: 'get_entries' })).toMatchObject({ success: true, data: { leafId: leaf } });
      for (const competing of [{ type: 'prompt', message: 'No race' }, { type: 'new_session' }, { type: 'clone' },
        { type: 'fork', entryId: f.target }, { type: 'set_session_name', name: 'No race' },
        { type: 'navigate_tree', entryId: f.target }, { type: 'reload_context_settings' }]) {
        expect(await f.controller.handle(competing)).toMatchObject({ success: false, error: expect.stringContaining('while navigating') });
      }
      expect(await f.controller.handle({ type: 'abort' })).toMatchObject({ success: true });
      expect(await pending).toMatchObject({ id: 'pending', success: true, data: { cancelled: true } });
      gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.manager.list()).toHaveLength(1); expect(f.source.activeLeafId).toBe(leaf);
      expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    } finally { gate.release(); await f.controller.close(); await f.registry.shutdown(); }
  });

  it.each(['eof', 'close'] as const)('retires %s before awaited foreground admission resumes', async action => {
    const f = await fixture(); let calls = 0;
    try {
      await f.registry.load('observe', api => { api.before('before:session:branch', () => { calls++; }); });
      const pending = f.controller.handle(request(operation, f.target));
      if (action === 'eof') f.controller.abortNavigation(); else await f.controller.close();
      expect(await pending).toMatchObject({ success: true, data: { cancelled: true } });
      expect(await f.controller.handle(request(operation, f.target))).toMatchObject({ success: true, data: { cancelled: true } });
      expect(calls).toBe(0); expect(f.manager.list()).toHaveLength(1);
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });

  it.each(['eof', 'close', 'unload'] as const)('withdraws %s during a non-cooperative hook', async action => {
    const f = await fixture(), gate = latch(), entered = latch();
    try {
      await f.registry.load('pending', api => { api.before('before:session:branch', async () => { entered.release(); await gate.promise; }); });
      const raw = await f.manager.getRawEntries(f.source.id), pending = f.controller.handle(request(operation, f.target));
      await entered.promise;
      if (action === 'eof') f.controller.abortNavigation();
      else if (action === 'close') await f.controller.close();
      else await f.registry.unload('pending');
      expect(await pending).toMatchObject({ success: true, data: { cancelled: true } });
      gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.manager.list()).toHaveLength(1); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    } finally { gate.release(); await f.controller.close(); await f.registry.shutdown(); }
  });

  it('fails closed on hook errors rather than selecting a partially copied session', async () => {
    const f = await fixture();
    try {
      await f.registry.load('failed', api => { api.before('before:session:branch', () => { throw new Error('PRIVATE_HOOK_FAILURE'); }); });
      const raw = await f.manager.getRawEntries(f.source.id);
      expect(await f.controller.handle(request(operation, f.target)))
        .toMatchObject({ success: false, error: 'Session branch hook failed.' });
      expect(f.manager.list()).toHaveLength(1); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    } finally { await f.controller.close(); await f.registry.shutdown(); }
  });
});

it('captures a fork entry identity before awaiting foreground admission', async () => {
  const f = await fixture();
  try {
    const input = { type: 'fork', entryId: f.target }, pending = f.controller.handle(input);
    input.entryId = 'changed-after-admission-start';
    expect(await pending).toMatchObject({ success: true, data: { cancelled: false, text: 'Selected user' } });
    expect(f.source.messages.map(message => message.content)).toEqual(['Root user']);
    expect((await f.manager.getActiveBranchEntries(f.source.id)).at(-1)).toMatchObject({ type: 'custom', data: { revision: 1 } });
  } finally { await f.controller.close(); await f.registry.shutdown(); }
});

it('admits only one of two concurrently arriving branch requests', async () => {
  const f = await fixture(), gate = latch(), entered = latch(); let calls = 0;
  try {
    await f.registry.load('pending', api => { api.before('before:session:branch', async () => { calls++; entered.release(); await gate.promise; }); });
    const first = f.controller.handle({ type: 'clone', id: 'first' }), second = f.controller.handle({ type: 'clone', id: 'second' });
    await entered.promise;
    expect(await second).toMatchObject({ id: 'second', success: false, error: expect.stringContaining('foreground operation') });
    await f.controller.handle({ type: 'abort' });
    expect(await first).toMatchObject({ id: 'first', success: true, data: { cancelled: true } });
    expect(calls).toBe(1); gate.release(); expect(f.manager.list()).toHaveLength(1);
  } finally { gate.release(); await f.controller.close(); await f.registry.shutdown(); }
});
