import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, SessionBranchCancelledError, SessionManager, type ExtensionAPI } from '@ai-harness/core';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function fixture() {
  const manager = new SessionManager(), source = await manager.create({ id: 'branch-source' });
  await manager.addMessage(source.id, { role: 'user', content: 'Selected user' });
  const registry = new ExtensionRegistry(); registry.attachSessionManager(manager);
  return { manager, source, registry };
}

describe('extension branch cancellation bridge', () => {
  it.each([false, { cancel: true }, { cancel: true, reason: 'Keep this selection' }])('honours an explicit veto %j', async result => {
    const f = await fixture(), seen: string[] = [];
    await f.registry.load('veto', api => { api.before('before:session:branch', event => {
      expect(event).toMatchObject({ operation: 'clone', sourceSessionId: f.source.id,
        entryId: f.source.activeLeafId, position: 'at', externalSource: false });
      expect(Object.isFrozen(event)).toBe(true); seen.push(event.sourceSessionId); return result as never;
    }); });
    const raw = await f.manager.getRawEntries(f.source.id);
    await expect(f.manager.cloneSession(f.source.id)).rejects.toBeInstanceOf(SessionBranchCancelledError);
    expect(seen).toEqual([f.source.id]); expect(f.manager.list()).toHaveLength(1);
    expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw); await f.registry.shutdown();
  });

  it('awaits factory registration order and stops before later handlers', async () => {
    const f = await fixture(), entered = latch(), gate = latch(), calls: string[] = [];
    await f.registry.load('first', api => { api.before('before:session:branch', async () => {
      calls.push('first'); entered.release(); await gate.promise;
    }); });
    await f.registry.load('second', api => { api.before('before:session:branch', () => { calls.push('second'); return false; }); });
    await f.registry.load('third', api => { api.before('before:session:branch', () => { calls.push('third'); }); });
    const pending = f.manager.forkSession(f.source.id); await entered.promise;
    expect(calls).toEqual(['first']); gate.release();
    await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
    expect(calls).toEqual(['first', 'second']); expect(f.manager.list()).toHaveLength(1); await f.registry.shutdown();
  });

  it.each([{ sourceSessionId: 'rewritten' }, { cancel: false }, true, [], { cancel: true, extra: 'forbidden' }])(
    'refuses malformed or transforming results %j without publishing a copy', async result => {
      const f = await fixture();
      await f.registry.load('invalid', api => { api.before('before:session:branch', () => result as never); });
      await expect(f.manager.cloneSession(f.source.id)).rejects.toThrow('Session branch hook failed.');
      expect(f.manager.list()).toHaveLength(1); await f.registry.shutdown();
    });

  it.each(['cancel', 'reason'] as const)('rejects a %s result accessor without evaluating it', async key => {
    const f = await fixture(), getter = vi.fn(() => key === 'cancel' ? true : 'PRIVATE_REASON');
    const result = Object.defineProperty(key === 'cancel' ? {} : { cancel: true }, key, { get: getter });
    await f.registry.load('accessor', api => { api.before('before:session:branch', () => result as never); });
    await expect(f.manager.cloneSession(f.source.id)).rejects.toThrow('Session branch hook failed.');
    expect(getter).not.toHaveBeenCalled(); expect(f.manager.list()).toHaveLength(1); await f.registry.shutdown();
  });

  it('withdraws pending admission before awaiting an uncooperative unload cleanup', async () => {
    const f = await fixture(), entered = latch(), hookGate = latch(), cleanupGate = latch();
    await f.registry.load('old', api => {
      api.before('before:session:branch', async () => { entered.release(); await hookGate.promise; });
      return async () => { await cleanupGate.promise; };
    });
    const pending = f.manager.cloneSession(f.source.id); await entered.promise;
    const unloading = f.registry.unload('old');
    await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
    expect(f.manager.list()).toHaveLength(1); hookGate.release(); cleanupGate.release();
    expect(await unloading).toBe(true); await f.registry.shutdown();
  });

  it('does not let an old unsubscribe cancel a newer generation', async () => {
    const f = await fixture(), gate = latch(), entered = latch(); let remove!: () => void;
    await f.registry.load('old', api => { remove = api.before('before:session:branch', () => undefined); });
    await f.registry.load('keeper', api => { api.before('before:session:branch', async () => { entered.release(); await gate.promise; }); });
    remove(); const pending = f.manager.cloneSession(f.source.id); await entered.promise;
    remove(); gate.release(); expect(await pending).not.toBeNull(); await f.registry.shutdown();
  });

  it('keeps multiple owned leases without executing the same registry twice', async () => {
    const registry = new ExtensionRegistry(), manager = new SessionManager(), source = await manager.create();
    let calls = 0;
    await registry.load('observe', api => { api.before('before:session:branch', () => { calls++; }); });
    const first = registry.attachSessionBranchHooks(manager), second = registry.attachSessionBranchHooks(manager);
    expect(await manager.cloneSession(source.id)).not.toBeNull(); expect(calls).toBe(1);
    first(); first(); expect(await manager.cloneSession(source.id)).not.toBeNull(); expect(calls).toBe(2);
    second(); expect(await manager.cloneSession(source.id)).not.toBeNull(); expect(calls).toBe(2); await registry.shutdown();
  });

  it('does not steal a borrowed registry host lifecycle binding when attaching another manager', async () => {
    const f = await fixture(), borrower = new SessionManager(), second = await borrower.create();
    const detach = f.registry.attachSessionBranchHooks(borrower);
    await f.registry.load('veto', api => { api.before('before:session:branch', () => false); });
    await expect(f.manager.cloneSession(f.source.id)).rejects.toBeInstanceOf(SessionBranchCancelledError);
    await expect(borrower.cloneSession(second.id)).rejects.toBeInstanceOf(SessionBranchCancelledError);
    detach(); expect(await borrower.cloneSession(second.id)).not.toBeNull();
    await expect(f.manager.cloneSession(f.source.id)).rejects.toBeInstanceOf(SessionBranchCancelledError); await f.registry.shutdown();
  });

  it('retires failed replacement work and restores the previous veto for future operations', async () => {
    const f = await fixture(), entered = latch(), gate = latch(); let calls = 0;
    await f.registry.load('old', api => { api.before('before:session:branch', async () => {
      if (++calls === 1) { entered.release(); await gate.promise; }
      return false as const;
    }); });
    const pending = f.manager.cloneSession(f.source.id); await entered.promise;
    await expect(f.registry.replaceManaged(['old'], [{ id: 'candidate', factory: api => {
      api.before('before:session:branch', () => undefined); throw new Error('Candidate failed');
    } }])).rejects.toThrow('Candidate failed');
    await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError); gate.release();
    await expect(f.manager.cloneSession(f.source.id)).rejects.toBeInstanceOf(SessionBranchCancelledError);
    expect(f.manager.list()).toHaveLength(1); expect(f.registry.list().map(extension => extension.id)).toEqual(['old']);
    await f.registry.shutdown();
  });

  it('refuses late registrations from an unloaded factory', async () => {
    const f = await fixture(); let captured!: ExtensionAPI;
    await f.registry.load('old', api => { captured = api; }); await f.registry.unload('old');
    expect(() => captured.before('before:session:branch', () => false)).toThrow('Cannot register branch hooks for an unloaded extension.');
    expect(await f.manager.cloneSession(f.source.id)).not.toBeNull(); await f.registry.shutdown();
  });

  it('bounds branch hook registrations without replacing the accepted handlers', async () => {
    const f = await fixture(); let captured!: ExtensionAPI, calls = 0;
    await f.registry.load('bounded', api => { captured = api;
      for (let index = 0; index < 256; index++) api.before('before:session:branch', () => { calls++; });
    });
    expect(() => captured.before('before:session:branch', () => false)).toThrow('Session branch extension hook limit reached.');
    expect(await f.manager.cloneSession(f.source.id)).not.toBeNull(); expect(calls).toBe(256); await f.registry.shutdown();
  });

  it('bounds independently owned manager bindings and releases their capacity', async () => {
    const registry = new ExtensionRegistry(), detachers: Array<() => void> = [];
    for (let index = 0; index < 128; index++) detachers.push(registry.attachSessionBranchHooks(new SessionManager()));
    expect(() => registry.attachSessionBranchHooks(new SessionManager())).toThrow('Session branch manager limit reached.');
    for (const detach of detachers) detach();
    const detach = registry.attachSessionBranchHooks(new SessionManager()); detach(); await registry.shutdown();
  });

  it('bounds duplicate binding leases without cancelling an accepted pending operation', async () => {
    const f = await fixture(), detachers: Array<() => void> = [], gate = latch(), entered = latch();
    try {
      for (let index = 0; index < 255; index++) detachers.push(f.registry.attachSessionBranchHooks(f.manager));
      await f.registry.load('pending', api => { api.before('before:session:branch', async () => { entered.release(); await gate.promise; }); });
      const pending = f.manager.cloneSession(f.source.id); await entered.promise;
      expect(() => f.registry.attachSessionBranchHooks(f.manager)).toThrow('Session branch binding lease limit reached.');
      gate.release(); expect(await pending).not.toBeNull();
    } finally { gate.release(); for (const detach of detachers) detach(); await f.registry.shutdown(); }
  });

  it('preserves the old lifecycle binding if preparing a replacement exceeds capacity', async () => {
    const f = await fixture(), detachers: Array<() => void> = [], created: string[] = [];
    await f.registry.load('observe', api => { api.on('session:create', event => { created.push(event.sessionId); }); });
    try {
      for (let index = 0; index < 127; index++) detachers.push(f.registry.attachSessionBranchHooks(new SessionManager()));
      expect(() => f.registry.attachSessionManager(new SessionManager())).toThrow('Session branch manager limit reached.');
      const next = await f.manager.create(); expect(created).toEqual([next.id]);
    } finally { for (const detach of detachers) detach(); await f.registry.shutdown(); }
  });

  it('does not let a superseded reentrant host bind steal the newest lifecycle binding', async () => {
    const f = await fixture(), intermediate = new SessionManager(), newest = new SessionManager();
    const entered = latch(), gate = latch(), created: string[] = [];
    await f.registry.load('observe', api => { api.on('session:create', event => { created.push(event.sessionId); }); });
    const remove = f.manager.onBeforeBranch(async event => {
      event.signal.addEventListener('abort', () => { f.registry.attachSessionManager(newest); }, { once: true });
      entered.release(); await gate.promise;
    });
    try {
      const pending = f.manager.cloneSession(f.source.id); await entered.promise;
      expect(() => f.registry.attachSessionManager(intermediate)).toThrow('Session branch binding was retired.');
      await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError); gate.release();
      await f.manager.create(); await intermediate.create(); const next = await newest.create();
      expect(created).toEqual([next.id]);
    } finally { gate.release(); remove(); await f.registry.shutdown(); }
  });

  it('withdraws admission before shutdown callbacks and refuses binding revival during shutdown', async () => {
    const f = await fixture(), entered = latch(), gate = latch(); let refusal: unknown;
    await f.registry.load('pending', api => { api.before('before:session:branch', async event => {
      event.signal.addEventListener('abort', () => {
        try { f.registry.attachSessionBranchHooks(new SessionManager()); } catch (error) { refusal = error; }
      }, { once: true }); entered.release(); await gate.promise;
    }); });
    try {
      const pending = f.manager.cloneSession(f.source.id); await entered.promise; await f.registry.shutdown();
      await expect(pending).rejects.toBeInstanceOf(SessionBranchCancelledError);
      expect(refusal).toBeInstanceOf(Error); expect((refusal as Error).message).toBe('Extension registry is shutting down.');
      gate.release(); expect(f.manager.list()).toHaveLength(1);
    } finally { gate.release(); await f.registry.shutdown(); }
  });
});
