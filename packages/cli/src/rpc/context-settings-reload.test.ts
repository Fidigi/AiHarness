import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, MockProvider, SessionManager, type AgentSettings } from '@ai-harness/core';
import { RpcController, type RpcControllerContext } from './rpc-controller.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const sessionManager = new SessionManager();
  const extensionRegistry = new ExtensionRegistry(); extensionRegistry.attachSessionManager(sessionManager);
  const provider = new MockProvider({ type: 'mock' as never, model: 'mock-model' });
  const initial: AgentSettings = { compaction: { reserveTokens: 100, keepRecentTokens: 1_000 },
    branchSummary: { reserveTokens: 500 }, thinkingBudgets: { low: 1_024 } };
  const box = { settings: initial };
  const next: AgentSettings = { ...initial, compaction: { enabled: false, reserveTokens: 200, keepRecentTokens: 20 },
    branchSummary: { reserveTokens: 900, skipPrompt: true } };
  const apply = vi.fn(() => { box.settings = next; });
  const prepare = vi.fn(async (_signal: AbortSignal) => apply);
  const context: RpcControllerContext = {
    sessionManager, extensionRegistry, provider, sessionId: 'context-settings-reload', providerName: 'mock',
    model: 'mock-model', tools: [], agentSettings: () => box.settings,
    toolContext: { sessionManager, provider, providerName: 'mock', currentSessionId: 'context-settings-reload',
      cwd: process.cwd(), projectTrusted: false, notify: () => {} },
  };
  Object.assign(context, { prepareContextSettingsReload: prepare });
  const controller = new RpcController(context, () => {});
  await controller.initialize();
  return { controller, context, box, initial, next, prepare, apply, sessionManager };
}

const accepted = { success: true, data: { cancelled: false, reloaded: ['compaction', 'branchSummary'] } };
const cancelled = { success: true, data: { cancelled: true, reloaded: [] } };

describe('explicit RPC context settings reload', () => {
  it('keeps startup policy until an explicit reload', async () => {
    const f = await fixture();
    try {
      await expect(f.controller.handle({ type: 'get_state' })).resolves.toMatchObject({ success: true });
      expect(f.prepare).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
      expect(f.box.settings).toBe(f.initial);
      expect(f.sessionManager.getCompactionSettings()).toStrictEqual({ enabled: true, reserveTokens: 100, keepRecentTokens: 1_000 });
    } finally { await f.controller.close(); }
  });

  it('publishes only context settings on explicit reload, preserving session opt-out and other settings', async () => {
    const f = await fixture();
    try {
      await f.sessionManager.update(f.context.sessionId, { autoCompaction: false });
      await expect(f.controller.handle({ type: 'reload_context_settings', id: 'reload-1' })).resolves.toMatchObject({
        ...accepted, id: 'reload-1', type: 'response', command: 'reload_context_settings',
      });
      expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.prepare.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
      expect(f.apply).toHaveBeenCalledTimes(1);
      expect(f.sessionManager.getCompactionSettings()).toStrictEqual({ enabled: false, reserveTokens: 200, keepRecentTokens: 20 });
      expect(f.sessionManager.get(f.context.sessionId)?.autoCompaction).toBe(false);
      expect(f.box.settings.branchSummary).toEqual({ reserveTokens: 900, skipPrompt: true });
      expect(f.box.settings.thinkingBudgets).toBe(f.initial.thinkingBudgets);
    } finally { await f.controller.close(); }
  });

  it('reports an unavailable host reader without pretending to reload', async () => {
    const f = await fixture();
    try {
      Reflect.deleteProperty(f.context, 'prepareContextSettingsReload');
      await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject({
        success: false, error: 'Context settings reload is unavailable.',
      });
      expect(f.apply).not.toHaveBeenCalled(); expect(f.box.settings).toBe(f.initial);
    } finally { await f.controller.close(); }
  });

  it('rejects extra request fields without evaluating them or preparing a reload', async () => {
    const f = await fixture(); let calls = 0;
    try {
      const request = { type: 'reload_context_settings' };
      Object.defineProperty(request, 'settings', { get() { calls++; return {}; } });
      await expect(f.controller.handle(request)).resolves.toMatchObject({ success: false });
      expect(calls).toBe(0); expect(f.prepare).not.toHaveBeenCalled();
    } finally { await f.controller.close(); }
  });

  it('rejects an accessor host capability without invoking it', async () => {
    const f = await fixture(); let calls = 0;
    try {
      Object.defineProperty(f.context, 'prepareContextSettingsReload', { configurable: true,
        get() { calls++; return f.prepare; } });
      await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject({
        success: false, error: 'Context settings reload is invalid.',
      });
      expect(calls).toBe(0); expect(f.prepare).not.toHaveBeenCalled();
    } finally { await f.controller.close(); }
  });

  it('keeps the old policy when preparation fails and releases foreground admission', async () => {
    const f = await fixture();
    try {
      Object.assign(f.context, { prepareContextSettingsReload: async () => { throw new Error('Load refused'); } });
      await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject({ success: false, error: 'Load refused' });
      expect(f.box.settings).toBe(f.initial); expect(f.apply).not.toHaveBeenCalled();
      Object.assign(f.context, { prepareContextSettingsReload: f.prepare });
      await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject(accepted);
    } finally { await f.controller.close(); }
  });

  it('permits safe reads but refuses competing foreground commands while preparation is pending', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<() => void>();
    Object.assign(f.context, { prepareContextSettingsReload: () => { entered.resolve(); return finish.promise; } });
    const pending = f.controller.handle({ type: 'reload_context_settings' });
    try {
      await entered.promise;
      for (const type of ['get_state', 'get_session_stats', 'get_entries', 'get_tree', 'get_messages']) {
        await expect(f.controller.handle({ type })).resolves.toMatchObject({ success: true });
      }
      for (const request of [{ type: 'reload_context_settings' }, { type: 'new_session' },
        { type: 'set_auto_compaction', enabled: true }, { type: 'set_model', provider: 'mock', modelId: 'mock-model' },
        { type: 'navigate_tree', entryId: 'none' }, { type: 'prompt', message: 'must not run' }]) {
        await expect(f.controller.handle(request)).resolves.toMatchObject({ success: false,
          error: expect.stringContaining('while reloading context settings') });
      }
      expect(f.apply).not.toHaveBeenCalled();
      finish.resolve(f.apply); await expect(pending).resolves.toMatchObject(accepted);
    } finally { finish.resolve(f.apply); await pending; await f.controller.close(); }
  });

  for (const retirement of ['abort', 'eof', 'close'] as const) {
    it(`withdraws unpublished settings on ${retirement}, even if preparation ignores its signal`, async () => {
      const f = await fixture(), entered = deferred<void>(), finish = deferred<() => void>();
      let signal: AbortSignal | undefined;
      Object.assign(f.context, { prepareContextSettingsReload: (value: AbortSignal) => {
        signal = value; entered.resolve(); return finish.promise;
      } });
      const pending = f.controller.handle({ type: 'reload_context_settings' });
      let stop: Promise<unknown> | undefined;
      try {
        await entered.promise;
        if (retirement === 'abort') stop = f.controller.handle({ type: 'abort' });
        else if (retirement === 'close') stop = f.controller.close();
        else f.controller.abortNavigation();
        expect(signal?.aborted).toBe(true);
        finish.resolve(f.apply); await expect(pending).resolves.toMatchObject(cancelled); await stop;
        expect(f.apply).not.toHaveBeenCalled(); expect(f.box.settings).toBe(f.initial);
        if (retirement === 'abort') {
          Object.assign(f.context, { prepareContextSettingsReload: f.prepare });
          await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject(accepted);
        } else {
          Object.assign(f.context, { prepareContextSettingsReload: f.prepare });
          await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject(cancelled);
          expect(f.prepare).not.toHaveBeenCalled();
        }
      } finally { finish.resolve(f.apply); await pending; await stop; await f.controller.close(); }
    });
  }

  it('withdraws a prepared capability if the host reader was replaced while awaiting it', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<() => void>();
    Object.assign(f.context, { prepareContextSettingsReload: () => { entered.resolve(); return finish.promise; } });
    const pending = f.controller.handle({ type: 'reload_context_settings' });
    try {
      await entered.promise;
      Object.assign(f.context, { prepareContextSettingsReload: f.prepare });
      finish.resolve(f.apply); await expect(pending).resolves.toMatchObject(cancelled);
      expect(f.apply).not.toHaveBeenCalled(); expect(f.box.settings).toBe(f.initial);
    } finally { finish.resolve(f.apply); await pending; await f.controller.close(); }
  });

  it('rejects a non-callable prepared capability without evaluating its properties', async () => {
    const f = await fixture(); let calls = 0;
    try {
      const value = Object.defineProperty({}, 'apply', { get() { calls++; return f.apply; } });
      Object.assign(f.context, { prepareContextSettingsReload: async () => value });
      await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject({
        success: false, error: 'Prepared context settings reload is invalid.',
      });
      expect(calls).toBe(0); expect(f.apply).not.toHaveBeenCalled();
    } finally { await f.controller.close(); }
  });
});
