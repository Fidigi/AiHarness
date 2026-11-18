import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, SessionManager, type ExtensionAPI } from '@ai-harness/core';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function source(manager: SessionManager) {
  const session = await manager.create(); await manager.addMessage(session.id, { role: 'user', content: 'Shared user' }); const target = session.activeLeafId!;
  await manager.appendCustomEntry(session.id, 'fixture:summary-state', { private: 'NEVER_MODEL_STATE' });
  await manager.appendCustomMessage(session.id, 'fixture:note', 'MODEL_CUSTOM_NOTE', { display: false, details: { private: 'NEVER_MODEL_DETAILS' } });
  await manager.addMessage(session.id, { role: 'user', content: 'Abandoned user' });
  await manager.addMessage(session.id, { role: 'assistant', content: 'Abandoned answer' }); return { session, target };
}
async function fixture() {
  const manager = new SessionManager(), s = await source(manager), registry = new ExtensionRegistry(); registry.attachSessionManager(manager);
  return { manager, registry, ...s };
}

describe('global extension branch summary overrides', () => {
  it('replaces fallback through an owned immutable model-visible transcript', async () => {
    const f = await fixture(), raw = await f.manager.getRawEntries(f.session.id), fallback = vi.fn(async () => ({ summary: 'Fallback' }));
    await f.registry.load('summary', api => { api.before('before:session:summary', event => {
      expect(Object.isFrozen(event)).toBe(true); expect(event).toMatchObject({ sourceSessionId: f.session.id, targetEntryId: f.target, fromEntryId: f.session.activeLeafId });
      expect(event.transcript).toContain('MODEL_CUSTOM_NOTE'); expect(event.transcript).not.toContain('NEVER_MODEL_STATE'); expect(event.transcript).not.toContain('NEVER_MODEL_DETAILS');
      return { summary: 'Override', provider: 'fixture', model: 'summary', usage: { totalTokens: 3 } };
    }); });
    expect(await f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer: fallback }))
      .toMatchObject({ status: 'navigated', summary: { summary: 'Override', parentEntryId: f.target, usage: { totalTokens: 3 } } });
    expect(fallback).not.toHaveBeenCalled(); expect((await f.manager.getRawEntries(f.session.id)).slice(0, raw.length)).toEqual(raw); await f.registry.shutdown();
  });

  it('awaits hooks in registration order, captures each output and uses the last override', async () => {
    const f = await fixture(), entered = latch(), gate = latch(), calls: string[] = [], value = { summary: 'First', usage: { totalTokens: 3 } };
    await f.registry.load('first', api => { api.before('before:session:summary', async () => { calls.push('first'); entered.release(); await gate.promise; return value; }); });
    await f.registry.load('second', api => { api.before('before:session:summary', () => { calls.push('second'); value.summary = 'Mutated'; value.usage.totalTokens = 9; }); });
    const pending = f.manager.navigateTree(f.session.id, f.target, { summarize: true }); await entered.promise;
    expect(calls).toEqual(['first']); gate.release();
    expect(await pending).toMatchObject({ status: 'navigated', summary: { summary: 'First', usage: { totalTokens: 3 } } }); expect(calls).toEqual(['first', 'second']);
    await f.registry.load('third', api => { api.before('before:session:summary', () => ({ summary: 'Last' })); });
    expect(await f.manager.navigateTree(f.session.id, f.target, { summarize: true })).toMatchObject({ status: 'navigated', summary: { summary: 'Last' } }); await f.registry.shutdown();
  });

  it.each([false, { cancel: true }, { cancel: true, reason: 'PRIVATE_REASON' }])('cancels without forwarding reason or invoking fallback %#', async veto => {
    const f = await fixture(), before = structuredClone(f.session), raw = await f.manager.getRawEntries(f.session.id), fallback = vi.fn();
    await f.registry.load('veto', api => { api.before('before:session:summary', () => veto as never); });
    expect(await f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer: fallback })).toEqual({ status: 'cancelled' });
    expect(f.session).toEqual(before); expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw); expect(fallback).not.toHaveBeenCalled(); await f.registry.shutdown();
  });

  it.each([true, [], null, { cancel: false }, { cancel: true, summary: 'rewrite' }, { summary: 'ok', parentEntryId: 'rewrite' },
    { sourceSessionId: 'rewrite' }, { summary: 'x'.repeat(16_385) }, { summary: 'ok', usage: { totalTokens: -1 } }])('refuses invalid or transforming results %#', async value => {
    const f = await fixture(), before = structuredClone(f.session), fallback = vi.fn();
    await f.registry.load('invalid', api => { api.before('before:session:summary', () => value as never); });
    await expect(f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer: fallback })).rejects.toThrow('Branch summary hook failed.');
    expect(f.session).toEqual(before); expect(fallback).not.toHaveBeenCalled(); await f.registry.shutdown();
  });

  it.each(['summary', 'cancel', 'reason', 'usage'] as const)('does not evaluate a %s result accessor', async key => {
    const f = await fixture(), getter = vi.fn(() => 'PRIVATE_GETTER');
    const base = key === 'reason' ? { cancel: true } : key === 'usage' ? { summary: 'ok' } : {};
    const value = Object.defineProperty(base, key, { get: getter });
    await f.registry.load('accessor', api => { api.before('before:session:summary', () => value as never); });
    await expect(f.manager.navigateTree(f.session.id, f.target, { summarize: true })).rejects.toThrow('Branch summary hook failed.');
    expect(getter).not.toHaveBeenCalled(); await f.registry.shutdown();
  });

  it('stops before later hooks on veto and cannot force implicit summary work', async () => {
    const f = await fixture(), later = vi.fn(), fallback = vi.fn();
    await f.registry.load('veto', api => { api.before('before:session:summary', () => false); });
    await f.registry.load('later', api => { api.before('before:session:summary', later); });
    expect(await f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer: fallback })).toEqual({ status: 'cancelled' });
    expect(later).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    expect(await f.manager.navigateTree(f.session.id, f.target, { summarizer: fallback })).toMatchObject({ status: 'navigated' });
    expect(later).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled(); await f.registry.shutdown();
  });

  it.each(['unload', 'shutdown', 'replace', 'add'] as const)('retires a non-cooperative override on %s', async action => {
    const f = await fixture(), entered = latch(), gate = latch(), cleanup = latch(), fallback = vi.fn();
    await f.registry.load('old', api => {
      api.before('before:session:summary', async () => { entered.release(); await gate.promise; return { summary: 'Late' }; });
      return async () => { await cleanup.promise; };
    });
    const raw = await f.manager.getRawEntries(f.session.id); let retiring: Promise<unknown> | undefined;
    try {
      const pending = f.manager.navigateTree(f.session.id, f.target, { summarize: true, summarizer: fallback }); await entered.promise;
      if (action === 'unload') retiring = f.registry.unload('old');
      else if (action === 'shutdown') retiring = f.registry.shutdown();
      else if (action === 'replace') f.registry.attachSessionManager(new SessionManager());
      else await f.registry.load('new', api => { api.before('before:session:summary', () => undefined); });
      expect(await pending).toEqual({ status: 'cancelled' }); expect(fallback).not.toHaveBeenCalled();
      gate.release(); cleanup.release(); await retiring; await new Promise<void>(resolve => setImmediate(resolve));
      expect(await f.manager.getRawEntries(f.session.id)).toEqual(raw);
    } finally { gate.release(); cleanup.release(); await retiring; await f.registry.shutdown(); }
  });

  it('leaves future work intact on stale unsubscribe and rejects an unloaded registration', async () => {
    const f = await fixture(), entered = latch(), gate = latch(); let old!: ExtensionAPI, remove!: () => void;
    await f.registry.load('old', api => { old = api; remove = api.before('before:session:summary', () => undefined); }); remove();
    await f.registry.load('current', api => { api.before('before:session:summary', async () => { entered.release(); await gate.promise; return { summary: 'Current' }; }); });
    const pending = f.manager.navigateTree(f.session.id, f.target, { summarize: true }); await entered.promise;
    remove(); gate.release(); expect(await pending).toMatchObject({ status: 'navigated', summary: { summary: 'Current' } });
    await f.registry.unload('old'); expect(() => old.before('before:session:summary', () => undefined)).toThrow('Cannot register branch hooks for an unloaded extension.'); await f.registry.shutdown();
  });

  it('shares independent leases without duplicate overrides or stealing lifecycle ownership', async () => {
    const f = await fixture(), borrower = new SessionManager(), second = await source(borrower); let calls = 0;
    await f.registry.load('summary', api => { api.before('before:session:summary', () => { calls++; return { summary: 'Owned override' }; }); });
    const first = f.registry.attachSessionBranchHooks(borrower), other = f.registry.attachSessionBranchHooks(borrower);
    expect(await borrower.navigateTree(second.session.id, second.target, { summarize: true })).toMatchObject({ status: 'navigated' }); expect(calls).toBe(1);
    first(); expect(await borrower.navigateTree(second.session.id, second.target, { summarize: true })).toMatchObject({ status: 'navigated' }); expect(calls).toBe(2);
    other(); const fallback = vi.fn(async () => ({ summary: 'Fallback' }));
    expect(await borrower.navigateTree(second.session.id, second.target, { summarize: true, summarizer: fallback })).toMatchObject({ status: 'navigated' }); expect(calls).toBe(2);
    expect(await f.manager.navigateTree(f.session.id, f.target, { summarize: true })).toMatchObject({ status: 'navigated', summary: { summary: 'Owned override' } }); expect(calls).toBe(3); await f.registry.shutdown();
  });

  it('bounds extension callbacks without revoking work on a refused overflow', async () => {
    const f = await fixture(), entered = latch(), gate = latch(); let owner!: ExtensionAPI;
    await f.registry.load('bounded', api => {
      owner = api; api.before('before:session:summary', async () => { entered.release(); await gate.promise; return { summary: 'Bounded' }; });
      for (let index = 1; index < 256; index++) api.before('before:session:summary', () => undefined);
    });
    const pending = f.manager.navigateTree(f.session.id, f.target, { summarize: true }); await entered.promise;
    expect(() => owner.before('before:session:summary', () => false)).toThrow('Session branch extension hook limit reached.');
    gate.release(); expect(await pending).toMatchObject({ status: 'navigated', summary: { summary: 'Bounded' } }); await f.registry.shutdown();
  });
});
