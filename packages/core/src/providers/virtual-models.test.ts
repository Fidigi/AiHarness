import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { CerebrasProvider, ProviderFactory, type AiProvider, type ChatOptions } from './index.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { VirtualModelRegistry, VirtualModelRoutingError, type VirtualModelRequest } from './virtual-models.js';

async function fixture() {
  const manager = new SessionManager();
  const session = await manager.create({ model: 'auto' });
  await manager.addMessage(session.id, { role: 'user', content: 'question' });
  const registry = new ExtensionRegistry();
  const physical = ProviderFactory.create({ type: 'mock', model: 'physical' });
  const sent: ChatOptions[] = [];
  vi.spyOn(physical, 'streamChat').mockImplementation(async (_messages, _chunk, complete, _error, options) => {
    sent.push(options!); complete?.({ content: 'answer', model: options?.model,
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } });
  });
  const providers = new Map<string, AiProvider>([['mock', physical]]);
  const dispatch = (reason?: VirtualModelRequest['reason'], extra: Partial<Parameters<typeof streamProviderTurn>[0]> = {}) => streamProviderTurn({ provider: registry.getVirtualProvider('router')!,
    providerName: 'router', model: 'auto', thinking: 'high', sessionId: session.id, sessionManager: manager,
    messages: session.messages, tools: [], extensionRegistry: registry,
    resolveProvider: name => providers.get(name), maxRetries: 0, routeReason: reason, ...extra });
  return { manager, session, registry, physical, providers, sent, dispatch };
}

describe('native selectable virtual models', () => {
  it.each(['high', 'max'] as const)('clamps physical %s against the resolved adapter rather than the operator alias', async thinkingLevel => {
    const registry = new VirtualModelRegistry(), provider = new CerebrasProvider({ type: 'operator-native', model: 'qwen-3.8-27b', apiKey: 'disposable', baseUrl: 'http://127.0.0.1:1/v1' });
    registry.register({ provider: 'router', id: 'owned', thinkingLevels: ['high'], route: () => ({ provider: 'operator-native', id: 'qwen-3.8-27b', thinkingLevel }) });
    const result = await registry.resolve({ definition: registry.get('router', 'owned')!, messages: [], reason: 'direct', thinking: 'high', context: { resolveProvider: () => provider } });
    expect(result.provider).toBe(provider);
    expect(result.selection).toEqual({ provider: 'operator-native', id: 'qwen-3.8-27b', thinkingLevel: 'high' });
  });
  it('separates selection, physical options, provenance and private branch state', async () => {
    const f = await fixture();
    const requests: VirtualModelRequest[] = [];
    await f.registry.load('router-extension', api => api.registerVirtualModel({ provider: 'router', id: 'auto',
      thinkingLevels: ['low', 'high'], route(request) {
        requests.push(request);
        return { provider: 'mock', id: 'physical', thinkingLevel: 'high', state: { phase: 'build' } };
      } }));
    await runToolLoop({ sessionManager: f.manager, sessionId: f.session.id, extensionRegistry: f.registry,
      toolContext: { sessionManager: f.manager, notify() {} }, provider: 'router', streamTurn: () => f.dispatch() });
    expect(requests[0]).toMatchObject({ reason: 'user', thinkingLevel: 'high', model: { provider: 'router', id: 'auto' } });
    expect(f.sent[0]).toMatchObject({ model: 'physical', thinking: 'off' });
    expect(f.session.model).toBe('auto');
    expect(f.session.messages.at(-1)).toMatchObject({ provider: 'mock', model: 'physical',
      metadata: { selection: { provider: 'router', id: 'auto' }, thinkingLevel: 'off' } });
    await f.dispatch('continuation');
    expect(requests[1]).toMatchObject({ reason: 'continuation', state: { phase: 'build' }, previous: { provider: 'mock', id: 'physical' } });
    expect(JSON.stringify(f.manager.getEffectiveContext(f.session.id))).not.toContain('provider.router_state');
  });

  it('restores branch state through compaction, navigation and independent copies', async () => {
    const f = await fixture();
    const states: unknown[] = [];
    let phase = 1;
    await f.registry.load('router', api => { api.registerVirtualModel({ provider: 'router', id: 'auto', route(request) {
      states.push(request.state); return { provider: 'mock', id: 'physical', state: { phase: phase++ } };
    } }); });
    await f.dispatch();
    const first = f.session.activeLeafId!;
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'first' });
    await f.dispatch();
    await f.manager.navigateTree(f.session.id, first);
    await f.dispatch();
    expect(states).toEqual([undefined, { phase: 1 }, { phase: 1 }]);
    await f.manager.applyCompaction(f.session.id, 'summary', f.session.messages[0].id);
    await f.dispatch();
    expect(states.at(-1)).toEqual({ phase: 3 });
    const clone = await f.manager.cloneSession(f.session.id);
    expect((await f.manager.getActiveBranchEntries(clone!.id)).filter(entry => entry.type === 'custom'
      && entry.customType === 'provider.router_state').at(-1)).toMatchObject({ data: { state: { phase: 4 } } });
  });

  it.each(['recursive', 'unavailable', 'getter', 'invalid-state'] as const)('refuses %s without physical dispatch', async kind => {
    const f = await fixture();
    await f.registry.load('router', api => { api.registerVirtualModel({ provider: 'router', id: 'auto', route() {
      if (kind === 'recursive') return { provider: 'router', id: 'auto' };
      if (kind === 'unavailable') return { provider: 'missing', id: 'physical' };
      if (kind === 'getter') return { get provider() { throw new Error('must not execute'); }, id: 'physical' };
      return { provider: 'mock', id: 'physical', state: { invalid: () => undefined } };
    } }); });
    await expect(f.dispatch()).rejects.toThrow();
    expect(f.sent).toEqual([]);
  });

  it('retires pending routers on cancellation, replacement and branch movement', async () => {
    for (const retirement of ['abort', 'replace', 'branch']) {
      const f = await fixture();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const registration = { provider: 'router', id: 'auto', async route() {
        entered(); await gate; return { provider: 'mock', id: 'physical', state: { phase: 1 } };
      } };
      f.registry.virtualModels.register(registration);
      const definition = f.registry.virtualModels.get('router', 'auto')!;
      const controller = new AbortController();
      const work = f.registry.virtualModels.resolve({ definition, messages: f.session.messages, reason: 'user',
        sessionManager: f.manager, sessionId: f.session.id, signal: controller.signal,
        context: { resolveProvider: name => f.providers.get(name) } });
      const rejected = expect(work).rejects.toThrow();
      await ready;
      if (retirement === 'abort') controller.abort();
      if (retirement === 'replace') f.registry.virtualModels.register({ ...registration, route: () => ({ provider: 'mock', id: 'physical' }) });
      if (retirement === 'branch') await f.manager.addMessage(f.session.id, { role: 'user', content: 'newer' });
      release(); await rejected;
      expect(f.sent).toEqual([]);
      expect((await f.manager.getRawEntries(f.session.id)).some(entry => entry.type === 'custom')).toBe(false);
    }
  });

  it('reroutes automatic failures with failed physical identity, but never retries visible output', async () => {
    const f = await fixture();
    const requests: VirtualModelRequest[] = [];
    await f.registry.load('router', api => { api.registerVirtualModel({ provider: 'router', id: 'auto', route(request) {
      requests.push(request); return { provider: 'mock', id: 'physical' };
    } }); });
    vi.mocked(f.physical.streamChat).mockImplementationOnce(async () => { throw new Error('overloaded'); });
    const response = await streamProviderTurn({ provider: f.registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
      messages: f.session.messages, tools: [], extensionRegistry: f.registry, resolveProvider: name => f.providers.get(name),
      maxRetries: 1, retryDelayMs: 0 });
    expect(response.content).toBe('answer');
    expect(requests[1]).toMatchObject({ reason: 'retry', failed: { provider: 'mock', id: 'physical' } });
    expect(requests[0].reason).toBe('direct');
  });

  it('refuses a branch replaced inside a physical before-hook without retrying stale input', async () => {
    const f = await fixture(), retry = vi.fn();
    const route = vi.fn(() => ({ provider: 'mock', id: 'physical', state: { phase: 'ready' } }));
    await f.registry.load('router', api => {
      api.registerVirtualModel({ provider: 'router', id: 'auto', route });
      api.before('before:provider', async () => {
        await f.manager.navigateTree(f.session.id, f.session.messages[0].id);
        await f.manager.addMessage(f.session.id, { role: 'user', content: 'replacement branch' });
      });
    });
    await expect(f.dispatch(undefined, { maxRetries: 2, onRetryStart: retry })).rejects.toBeInstanceOf(VirtualModelRoutingError);
    expect(route).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled(); expect(f.sent).toEqual([]);
  });

  it('does not reroute a completed paid request when its final observer fails', async () => {
    const f = await fixture();
    const route = vi.fn(() => ({ provider: 'mock', id: 'physical' }));
    await f.registry.load('router', api => { api.registerVirtualModel({ provider: 'router', id: 'auto', route }); });
    await expect(f.dispatch(undefined, { maxRetries: 2, onComplete: () => { throw new Error('observer failed'); } })).rejects.toThrow('observer failed');
    expect(route).toHaveBeenCalledTimes(1); expect(f.sent).toHaveLength(1);
  });

  it('routes direct summary calls without reading or writing branch state', async () => {
    const f = await fixture();
    const requests: VirtualModelRequest[] = [];
    await f.registry.load('router', api => { api.registerVirtualModel({ provider: 'router', id: 'auto', route(request) {
      requests.push(request); return { provider: 'mock', id: 'physical', state: { ignored: true } };
    } }); });
    const response = await f.registry.chat(f.registry.getVirtualProvider('router')!, f.session.messages,
      { tools: [], maxTokens: 100 }, name => f.providers.get(name));
    expect(response).toMatchObject({ provider: 'mock', model: 'physical', content: 'answer' });
    expect(f.sent[0].maxTokens).toBe(100);
    expect(requests[0]).toMatchObject({ reason: 'direct' });
    expect((await f.manager.getRawEntries(f.session.id)).some(entry => entry.type === 'custom')).toBe(false);
  });

  it('compacts before dispatch against the routed physical window without rerouting the summary cut', async () => {
    const f = await fixture();
    f.manager.setCompactionSettings({ enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 });
    for (let index = 0; index < 9; index++) await f.manager.addMessage(f.session.id, {
      role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(110_000),
    });
    f.manager.setCompactionSettings({ enabled: true });
    const summarize = vi.fn(async () => 'small summary');
    f.manager.setAutoCompactionCallback(summarize);
    const route = vi.fn(() => ({ provider: 'openai', id: 'o3' }));
    await f.registry.load('router', api => { api.registerVirtualModel({ provider: 'router', id: 'auto', contextWindow: 1_000_000, route }); });
    f.providers.set('openai', f.physical);
    await f.dispatch();
    expect(route).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].model).toBe('o3');
    expect(f.manager.getCompactionContextWindow(f.session.id)).toBe(200_000);
    expect(f.manager.getCompactionContextWindow()).toBeUndefined();
  });

  it('overlays selectable metadata without exposing a physical collision and cleans up exact generations', async () => {
    const registry = new VirtualModelRegistry();
    const dispose = registry.register({ provider: 'mock', id: 'physical', route: () => ({ provider: 'mock', id: 'other' }) });
    const disposeNew = registry.register({ provider: 'mock', id: 'physical', name: 'Replacement', route: () => ({ provider: 'mock', id: 'other' }) });
    dispose();
    expect(registry.overlayCatalog([{ provider: 'mock', configured: false, models: [] }])[0].models[0]).toMatchObject({ name: 'Replacement', available: false, source: 'virtual' });
    disposeNew(); expect(registry.list()).toEqual([]);
    expect(() => registry.register({ provider: 'bad/id', id: 'auto', route: () => ({ provider: 'mock', id: 'other' }) })).toThrow(VirtualModelRoutingError);
  });
});
