import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { SessionManager } from '../sessions/session-manager.js';
import { AnthropicProvider, OpenAiProvider, MockProvider, type ChatOptions } from './index.js';
import type { Message } from '../types/index.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { AgentRuntime } from '../agent/runtime.js';
import { resolveVirtualModelFallback, VirtualModelRoutingError } from './virtual-models.js';

async function fixture() {
  const manager = new SessionManager(), registry = new ExtensionRegistry();
  const session = await manager.create({ model: 'auto' });
  await manager.addMessage(session.id, { role: 'user', content: 'question' });
  const physical = new MockProvider({ type: 'physical', model: 'native' });
  physical.getPublishedModels = () => [{ id: 'native', name: 'Native', contextWindow: 100_000, maxOutputTokens: 100,
    capabilities: { reasoning: true, imageInput: false, toolCalls: false }, thinkingLevelMap: { off: null, high: 'high' } }];
  const sent: Array<{ messages: Message[]; options: ChatOptions }> = [];
  physical.streamChat = async (messages, _chunk, complete, _error, options) => {
    sent.push({ messages, options: options! });
    complete?.({ content: 'answer', model: options?.model });
  };
  const resolve = (name: string) => name === 'physical' ? physical : undefined;
  const register = () => registry.virtualModels.register({ provider: 'router', id: 'auto', contextWindow: 80_000,
    maxOutputTokens: 200, thinkingLevels: ['high'], route: () => ({ provider: 'physical', id: 'native', thinkingLevel: 'max' }) });
  const dispatch = () => streamProviderTurn({ provider: registry.getVirtualProvider('router') ?? physical,
    providerName: 'router', model: 'auto', messages: session.messages, tools: [], extensionRegistry: registry,
    sessionManager: manager, sessionId: session.id, resolveProvider: resolve, maxRetries: 0 });
  return { manager, registry, session, physical, sent, resolve, register, dispatch };
}

describe('virtual physical admission and missing-router resume', () => {
  it('uses authoritative adapter limits/capabilities after hooks without rewriting history or foreign replay', async () => {
    const f = await fixture(); f.register();
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'public', provider: 'other', model: 'native',
      blocks: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: 'public' }], metadata: { replay: 'PRIVATE' } });
    await f.registry.load('hook', api => api.before('before:provider', data => {
      data.messages.push({ id: 'hook-image', role: 'user', timestamp: new Date(), content: 'image',
        blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] });
      data.options.maxTokens = 1000;
      data.options.tools = [{ name: 'forbidden', description: '', parameters: {} }];
      data.options.thinking = 'max';
    }));
    const original = structuredClone(f.session.messages);
    await f.dispatch();
    expect(f.sent[0].options).toMatchObject({ model: 'native', maxTokens: 100, tools: [], thinking: 'high' });
    expect(JSON.stringify(f.sent[0].messages)).not.toContain('PRIVATE');
    expect(f.sent[0].messages.at(-1)).toMatchObject({ content: 'image\n[Image omitted: physical model does not support images.]', blocks: [] });
    expect(f.session.messages).toEqual(original);
    expect(f.manager.getCompactionContextWindow(f.session.id)).toBe(80_000);
  });

  it('persists in-place edits to the copied private router state', async () => {
    const f = await fixture(), observed: number[] = [];
    f.registry.virtualModels.register({ provider: 'router', id: 'auto', route(request) {
      const state = (request.state ?? { count: 0 }) as { count: number };
      observed.push(state.count); state.count++;
      return { provider: 'physical', id: 'native', state };
    } });
    await f.dispatch(); await f.dispatch(); await f.dispatch();
    expect(observed).toEqual([0, 1, 2]);
    expect((await f.manager.getActiveBranchEntries(f.session.id)).filter(entry => entry.type === 'custom').at(-1)).toMatchObject({
      type: 'custom', customType: 'provider.router_state', data: { state: { count: 3 } },
    });
  });

  it('preserves same-physical replay and an omitted native output default', async () => {
    const f = await fixture();
    f.registry.virtualModels.register({ provider: 'router', id: 'auto', route: () => ({ provider: 'physical', id: 'native' }) });
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'public', provider: 'physical', model: 'native',
      blocks: [{ type: 'reasoning', text: 'OWN_REPLAY' }], metadata: { replay: 'OWN_REPLAY' } });
    await f.dispatch();
    expect(JSON.stringify(f.sent[0].messages)).toContain('OWN_REPLAY');
    expect(f.sent[0].options.maxTokens).toBeUndefined();
  });

  it.each(['empty', 'invalid'])('does not borrow a known provider alias when its declaration is %s', async kind => {
    const f = await fixture();
    f.physical.getPublishedModels = () => kind === 'empty' ? [] : [{ id: 'o3-mini', name: '',
      capabilities: { reasoning: true, imageInput: false, toolCalls: true } }];
    f.registry.virtualModels.register({ provider: 'router', id: 'auto', route: () => ({ provider: 'openai', id: 'o3-mini', thinkingLevel: 'max' }) });
    await streamProviderTurn({ provider: f.registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
      messages: f.session.messages, tools: [], extensionRegistry: f.registry, sessionManager: f.manager, sessionId: f.session.id,
      resolveProvider: name => name === 'openai' ? f.physical : undefined, maxRetries: 0 });
    expect(f.sent[0].options.thinking).toBe('off');
    expect(f.manager.getCompactionContextWindow(f.session.id)).toBeUndefined();
  });

  it('resumes the witnessed physical model without router code/state and keeps logical provenance', async () => {
    const f = await fixture(), dispose = f.register();
    const response = await f.dispatch();
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: response.content,
      provider: response.provider, model: response.model, metadata: { selection: response.selection, thinkingLevel: response.thinkingLevel } });
    dispose();
    await f.manager.addMessage(f.session.id, { role: 'user', content: 'continue' });
    const entries = await f.manager.getRawEntries(f.session.id);
    expect(await f.dispatch()).toMatchObject({ provider: 'physical', model: 'native', selection: { provider: 'router', id: 'auto' } });
    expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'custom')).toEqual(entries.filter(entry => entry.type === 'custom'));
    expect(f.sent).toHaveLength(2);
  });

  it('resumes an omitted logical default using witnessed provenance when the session has no explicit model', async () => {
    const f = await fixture();
    await f.manager.update(f.session.id, { model: undefined });
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'old', provider: 'physical', model: 'native',
      metadata: { selection: { provider: 'router', id: 'auto' } } });
    const runtime = new AgentRuntime({ sessionManager: f.manager, extensionRegistry: f.registry,
      resolveProvider: f.resolve, isProjectTrusted: () => true });
    const run = await runtime.start({ sessionId: f.session.id, cwd: '/project', provider: 'router', input: 'continue' });
    expect((await runtime.wait(run.id))?.phase).toBe('completed');
    expect(f.sent).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({ provider: 'physical', model: 'native',
      metadata: { selection: { provider: 'router', id: 'auto' } } });
  });

  it.each(['different-selection', 'failed', 'branch', 'new-registration', 'changed-model'] as const)('does not guess fallback for %s', async kind => {
    const f = await fixture(), first = f.session.activeLeafId!;
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'old', provider: 'physical', model: 'native',
      metadata: { selection: { provider: 'router', id: 'auto' }, ...(kind === 'failed' ? { outputError: 'failed' } : {}) } });
    if (kind === 'branch') await f.manager.navigateTree(f.session.id, first);
    if (kind === 'new-registration') f.register();
    if (kind === 'changed-model') await f.manager.update(f.session.id, { model: 'different' });
    expect(await resolveVirtualModelFallback(f.manager, f.session.id, f.registry.virtualModels, f.resolve,
      kind === 'different-selection' ? { provider: 'other', id: 'auto' } : undefined)).toBeUndefined();
    expect(f.sent).toEqual([]);
  });

  it.each(['credential', 'branch', 'registration', 'abort'] as const)('revalidates %s after asynchronous fallback resolution', async kind => {
    const f = await fixture();
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'old', provider: 'physical', model: 'native',
      metadata: { selection: { provider: 'router', id: 'auto' } } });
    const controller = new AbortController();
    const resolver = vi.fn(async () => {
      if (kind === 'credential') f.physical.validateConfig = () => false;
      if (kind === 'branch') await f.manager.addMessage(f.session.id, { role: 'user', content: 'newer' });
      if (kind === 'registration') f.register();
      if (kind === 'abort') controller.abort();
      return f.physical;
    });
    await expect(resolveVirtualModelFallback(f.manager, f.session.id, f.registry.virtualModels, resolver, undefined, controller.signal)).rejects.toThrow();
    expect(f.sent).toEqual([]);
  });

  it.each(['openai', 'anthropic'] as const)('delegates %s native output/media/thinking on the actual physical wire', async dialect => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(dialect === 'openai' ? 'data: {"choices":[{"delta":{"content":"wire answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : [{ type: 'message_start', message: {} },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wire answer' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const model = dialect === 'openai' ? 'o3-mini' : 'claude-sonnet-4-6';
      const config = { type: 'operator', apiKey: 'disposable', model, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
      const provider = dialect === 'openai' ? new OpenAiProvider(config) : new AnthropicProvider(config);
      provider.getPublishedModels = () => [{ id: model, name: model, maxOutputTokens: 64, contextWindow: 100_000,
        capabilities: { reasoning: true, imageInput: dialect === 'anthropic', toolCalls: false } }];
      const registry = new ExtensionRegistry();
      registry.virtualModels.register({ provider: 'router', id: 'auto', maxOutputTokens: 128,
        route: () => ({ provider: 'operator', id: model, thinkingLevel: 'high' }) });
      const result = await streamProviderTurn({ provider: registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
        messages: [{ id: 'image', timestamp: new Date(), role: 'user', content: 'image', blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] }],
        tools: [], extensionRegistry: registry, resolveProvider: name => name === 'operator' ? provider : undefined, maxRetries: 0 });
      expect(result).toMatchObject({ content: 'wire answer', provider: 'operator', model, selection: { provider: 'router', id: 'auto' } });
      expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ model, max_tokens: 64 });
      expect(JSON.stringify(bodies[0]).includes('AA==')).toBe(dialect === 'anthropic');
      if (dialect === 'openai') expect(bodies[0].reasoning_effort).toBe('high');
      else expect(bodies[0]).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('keeps stale routing admission terminal through a real host redaction boundary', async () => {
    const f = await fixture(), route = vi.fn(() => ({ provider: 'physical', id: 'native' }));
    f.registry.virtualModels.register({ provider: 'router', id: 'auto', route });
    await f.registry.load('move-branch', api => api.before('before:provider', async () => {
      await f.manager.addMessage(f.session.id, { role: 'user', content: 'newer branch' });
    }));
    await expect(streamProviderTurn({ provider: f.registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
      messages: f.session.messages, tools: [], extensionRegistry: f.registry, resolveProvider: f.resolve,
      sessionManager: f.manager, sessionId: f.session.id, redactText: value => value,
      maxRetries: 1, retryDelayMs: 0 })).rejects.toBeInstanceOf(VirtualModelRoutingError);
    expect(route).toHaveBeenCalledTimes(1); expect(f.sent).toEqual([]);
  });

  it('persists failed visible routed output under its physical identity without retry or successful fallback evidence', async () => {
    const f = await fixture(); f.register();
    f.physical.streamChat = async (_messages, chunk) => { await chunk('partial'); throw new Error('transport failed'); };
    const runtime = new AgentRuntime({ sessionManager: f.manager, extensionRegistry: f.registry,
      resolveProvider: f.resolve, isProjectTrusted: () => true });
    const run = await runtime.start({ sessionId: f.session.id, cwd: '/project', provider: 'router', model: 'auto', input: 'question' });
    expect((await runtime.wait(run.id))?.phase).toBe('failed');
    expect(f.session.messages.at(-1)).toMatchObject({ content: 'partial', provider: 'physical', model: 'native', metadata: { outputError: 'transport failed' } });
  });

  it('never reroutes a completed transport that subsequently throws without visible deltas', async () => {
    const f = await fixture(), route = vi.fn(() => ({ provider: 'physical', id: 'native' }));
    f.registry.virtualModels.register({ provider: 'router', id: 'auto', route });
    f.physical.streamChat = async (_messages, _chunk, complete) => { complete?.({ content: 'paid' }); throw new Error('late failure'); };
    await expect(streamProviderTurn({ provider: f.registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
      messages: f.session.messages, tools: [], extensionRegistry: f.registry, resolveProvider: f.resolve,
      maxRetries: 1, retryDelayMs: 0 })).rejects.toThrow('late failure');
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('refuses an unavailable physical credential instead of selecting another account', async () => {
    const f = await fixture();
    await f.manager.addMessage(f.session.id, { role: 'assistant', content: 'old', provider: 'physical', model: 'native',
      metadata: { selection: { provider: 'router', id: 'auto' } } });
    await expect(resolveVirtualModelFallback(f.manager, f.session.id, f.registry.virtualModels, () => undefined)).rejects.toBeInstanceOf(VirtualModelRoutingError);
  });
});
