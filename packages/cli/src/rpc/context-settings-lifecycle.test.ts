import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry, MockProvider, SessionManager } from '@ai-harness/core';
import { RpcController, type RpcControllerContext } from './rpc-controller.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const sessionManager = new SessionManager(), extensionRegistry = new ExtensionRegistry();
  extensionRegistry.attachSessionManager(sessionManager);
  const provider = new MockProvider({ type: 'mock' as never, model: 'mock-model' });
  const prepare = vi.fn(async (_signal: AbortSignal) => () => {});
  const context: RpcControllerContext = {
    sessionManager, extensionRegistry, provider, sessionId: 'context-settings-lifecycle', providerName: 'mock',
    model: 'mock-model', tools: [], agentSettings: () => ({ compaction: { enabled: false } }),
    prepareContextSettingsReload: prepare,
    toolContext: { sessionManager, provider, providerName: 'mock', currentSessionId: 'context-settings-lifecycle',
      cwd: process.cwd(), projectTrusted: false, notify: () => {} },
  };
  const controller = new RpcController(context, () => {}); await controller.initialize();
  return { controller, context, provider, prepare, sessionManager };
}

describe('context-settings lifecycle boundaries', () => {
  it('reports the effective global disable, not merely the session opt-out', async () => {
    const f = await fixture();
    try {
      await expect(f.controller.handle({ type: 'get_state' })).resolves.toMatchObject({
        success: true, data: { autoCompactionEnabled: false },
      });
      await f.controller.handle({ type: 'set_auto_compaction', enabled: true });
      await expect(f.controller.handle({ type: 'get_state' })).resolves.toMatchObject({
        success: true, data: { autoCompactionEnabled: false },
      });
    } finally { await f.controller.close(); }
  });

  it('refuses preparation while an actual foreground provider turn is running', async () => {
    const f = await fixture(), entered = deferred(), finish = deferred();
    vi.spyOn(f.provider, 'streamChat').mockImplementation(async (_messages, _onChunk, onComplete) => {
      entered.resolve(); await finish.promise; onComplete?.({ content: 'Done' });
    });
    try {
      await expect(f.controller.handle({ type: 'prompt', message: 'Run' })).resolves.toMatchObject({ success: true });
      await entered.promise;
      await expect(f.controller.handle({ type: 'reload_context_settings' })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('foreground operation'),
      });
      expect(f.prepare).not.toHaveBeenCalled();
    } finally { finish.resolve(); await f.controller.drain(); await f.controller.close(); }
  });

  it('does not admit a navigation paused before a competing reload registered its controller', async () => {
    const f = await fixture(), navigationEntered = deferred(), navigationFinish = deferred();
    const reloadEntered = deferred(), reloadFinish = deferred();
    await f.sessionManager.addMessage(f.context.sessionId, { role: 'user', content: 'Root' });
    const target = f.sessionManager.get(f.context.sessionId)!.activeLeafId!;
    await f.sessionManager.addMessage(f.context.sessionId, { role: 'assistant', content: 'Tail' });
    const source = f.sessionManager.get(f.context.sessionId)!.activeLeafId;
    const internal = f.controller as unknown as { ensureIdle(command: string): Promise<void> };
    const delegated = internal.ensureIdle.bind(f.controller);
    internal.ensureIdle = async command => {
      await delegated(command);
      if (command === 'navigate_tree') { navigationEntered.resolve(); await navigationFinish.promise; }
    };
    f.context.prepareContextSettingsReload = async () => {
      reloadEntered.resolve(); await reloadFinish.promise; return () => {};
    };
    const navigation = f.controller.handle({ type: 'navigate_tree', entryId: target });
    let reload: ReturnType<RpcController['handle']> | undefined;
    try {
      await navigationEntered.promise;
      reload = f.controller.handle({ type: 'reload_context_settings' }); await reloadEntered.promise;
      navigationFinish.resolve();
      await expect(navigation).resolves.toMatchObject({ success: false,
        error: expect.stringContaining('foreground operation') });
      expect(f.sessionManager.get(f.context.sessionId)?.activeLeafId).toBe(source);
      reloadFinish.resolve(); await expect(reload).resolves.toMatchObject({ success: true });
    } finally {
      navigationFinish.resolve(); reloadFinish.resolve(); await navigation; await reload; await f.controller.close();
    }
  });
});
