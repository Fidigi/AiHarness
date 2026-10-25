import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, MockProvider, type ChatResponse } from './index.js';
import { getPublishedModelMetadata } from './model-metadata.js';
import { getProviderPublishedModels } from './provider-model-metadata.js';
import { SessionManager } from '../sessions/session-manager.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { disposeSessionCacheWarmers, getSessionCacheWarmer } from './cache-warmer.js';

const servers: Server[] = [], managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(disposeSessionCacheWarmers));
  vi.restoreAllMocks(); vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function fixture(failWarm = false) {
  const bodies: Array<Record<string, unknown>> = [];
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: 75 } };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; bodies.push(body);
    if (failWarm && body.max_tokens === 1) { response.writeHead(503); response.end('unavailable'); return; }
    if (!body.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({
      model: body.model, content: [{ type: 'text', text: 'ok' }], usage,
    })); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { usage: { ...usage, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0 } } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', usage: { ...usage, output_tokens: body.max_tokens === 1 ? 1 : 2 } },
    ];
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new AnthropicProvider({ type: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'disposable',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, providerMaxRetries: 2, providerMaxRetryDelayMs: 0 });
  const manager = new SessionManager(); managers.push(manager);
  const session = await manager.create({ model: 'claude-sonnet-4-6' });
  await manager.addMessage(session.id, { role: 'assistant', content: 'prior', provider: 'anthropic', model: session.model,
    usage: { cacheReadTokens: 100_000, outputTokens: 1 } });
  await manager.addMessage(session.id, { role: 'user', content: 'x'.repeat(400_000) });
  const registry = new ExtensionRegistry();
  const dispatch = (providerName = 'anthropic', cacheRetention: 'short' | 'long' | 'none' = 'short', thinking: 'off' | 'high' = 'off') => streamProviderTurn({
    provider, providerName, model: session.model, messages: session.messages, tools: [], thinking, maxTokens: 64,
    cacheRetention, maxRetries: 0, sessionManager: manager, sessionId: session.id, extensionRegistry: registry,
    resolveProvider: () => provider,
  });
  return { bodies, usage, provider, manager, session, registry, dispatch };
}
function clock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Date, 'now').mockImplementation(() => vi.getMockedSystemTime()!.getTime());
}
it('copies bounded declared cache lifetimes without evaluating accessors or borrowing missing declarations', () => {
  const provider = new MockProvider({ type: 'mock' });
  const getter = vi.fn(() => 3600), row = getPublishedModelMetadata('anthropic', 'claude-sonnet-4-6')!;
  provider.getPublishedModels = () => [{ ...row, promptCache: { short: 300, long: 3600 } }];
  const first = getProviderPublishedModels(provider)!;
  expect(first[0].promptCache).toEqual({ short: 300, long: 3600 });
  first[0].promptCache!.short = 1;
  expect(getProviderPublishedModels(provider)![0].promptCache!.short).toBe(300);
  provider.getPublishedModels = () => [{ ...row, promptCache: Object.defineProperty({ short: -1 }, 'long', { get: getter }) }];
  expect(getProviderPublishedModels(provider)![0].promptCache).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
});
it('accounts mixed five-minute/one-hour writes from actual JSON and final SSE usage snapshots once', async () => {
  const f = await fixture();
  const direct = await f.provider.chat(f.session.messages, { maxTokens: 64, cacheRetention: 'long', thinking: 'off' });
  let streamed: ChatResponse | undefined;
  await f.provider.streamChat(f.session.messages, () => undefined, result => { streamed = result; }, undefined,
    { maxTokens: 64, cacheRetention: 'long', thinking: 'off' });
  for (const result of [direct, streamed]) {
    expect(result?.usage).toMatchObject({ promptTokens: 10, completionTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 100, totalTokens: 132 });
    expect(result?.usage?.costUsd).toBeCloseTo(0.00060975, 12);
  }
});
it('honors an explicit zero one-hour breakdown over requested long retention in JSON, SSE and warming', async () => {
  const f = await fixture();
  f.usage.cache_creation = { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 };
  const direct = await f.provider.chat(f.session.messages, { maxTokens: 64, cacheRetention: 'long', thinking: 'off' });
  let streamed: ChatResponse | undefined;
  await f.provider.streamChat(f.session.messages, () => undefined, result => { streamed = result; }, undefined,
    { maxTokens: 64, cacheRetention: 'long', thinking: 'off' });
  for (const result of [direct, streamed]) {
    expect(result?.usage?.totalTokens).toBe(132);
    expect(result?.usage?.costUsd).toBeCloseTo(0.000441, 12);
  }
  clock(); await f.dispatch('anthropic', 'long');
  await vi.advanceTimersByTimeAsync(54 * 60_000);
  await vi.waitFor(async () => expect((await f.manager.getRawEntries(f.session.id)).at(-1)).toMatchObject({
    customType: 'provider.cache_warm', data: { usage: { costUsd: 0.000426 } },
  }));
  expect(f.bodies.at(-1)?.max_tokens).toBe(1);
});
it('uses declared physical account profiles and persists an authentic one-token refresh, not model context', async () => {
  const f = await fixture();
  f.provider.getPublishedModels = () => [{ ...getPublishedModelMetadata('anthropic', 'claude-sonnet-4-6')!, api: 'anthropic-messages' }];
  clock(); await f.dispatch('account-alias');
  const before = JSON.stringify(f.manager.getEffectiveContext(f.session.id));
  await vi.advanceTimersByTimeAsync(270_000);
  await vi.waitFor(() => expect(f.bodies).toHaveLength(2));
  await vi.waitFor(async () => expect((await f.manager.getRawEntries(f.session.id)).at(-1)).toMatchObject({
    customType: 'provider.cache_warm', data: { provider: 'account-alias', model: 'claude-sonnet-4-6',
      usage: { cacheWriteTokens: 100, costUsd: 0.00059475 } },
  }));
  expect(f.bodies[1].max_tokens).toBe(1); expect(JSON.stringify(f.manager.getEffectiveContext(f.session.id))).toBe(before);
});
it('supports one-hour streaming replay but immediately retires a timer outside the idle horizon', async () => {
  const f = await fixture(); clock(); await f.dispatch('anthropic', 'long');
  const warmer = getSessionCacheWarmer(f.manager, f.session.id);
  expect(warmer.status.state).toBe('scheduled');
  warmer.setMode('idle'); await warmer.settle(true);
  expect(warmer.status.state).toBe('inactive');
  await vi.advanceTimersByTimeAsync(60 * 60_000); expect(f.bodies).toHaveLength(1);
});
it('replays the native one-hour cache tier during streaming and retains actual mixed-tier billing', async () => {
  const f = await fixture(); clock(); await f.dispatch('anthropic', 'long');
  await vi.advanceTimersByTimeAsync(54 * 60_000);
  await vi.waitFor(async () => expect((await f.manager.getRawEntries(f.session.id)).at(-1)).toMatchObject({
    customType: 'provider.cache_warm', data: { usage: { costUsd: 0.00059475 } },
  }));
  expect(f.bodies).toHaveLength(2); expect(f.bodies[1].max_tokens).toBe(1);
  expect(JSON.stringify(f.bodies[1].messages)).toContain('"ttl":"1h"');
});
it('never retries a paid warm transport even when the physical provider config allows retries', async () => {
  const f = await fixture(true); clock(); await f.dispatch();
  await vi.advanceTimersByTimeAsync(270_000);
  await vi.waitFor(() => expect(getSessionCacheWarmer(f.manager, f.session.id).status.state).toBe('inactive'));
  expect(f.bodies).toHaveLength(2);
  expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'custom' && entry.customType === 'provider.cache_warm')).toEqual([]);
});
it.each(['none', 'undeclared-alias', 'numeric-thinking', 'empty-declaration', 'unpriced'] as const)('refuses unsafe or ineligible %s warming', async scenario => {
  const f = await fixture();
  if (scenario === 'empty-declaration') f.provider.getPublishedModels = () => [];
  if (scenario === 'unpriced') f.provider.getPublishedModels = () => [{
    ...getPublishedModelMetadata('anthropic', 'claude-sonnet-4-6')!, api: 'anthropic-messages', pricing: {},
  }];
  if (scenario === 'numeric-thinking') {
    f.provider.getPublishedModels = () => [{ ...getPublishedModelMetadata('anthropic', 'claude-sonnet-4-6')!,
      id: 'numeric-source', api: 'anthropic-messages' }];
    f.session.model = 'numeric-source';
  }
  clock(); await f.dispatch(scenario === 'undeclared-alias' || scenario === 'numeric-thinking' ? 'account-alias' : 'anthropic', scenario === 'none' ? 'none' : 'short', scenario === 'numeric-thinking' ? 'high' : 'off');
  await vi.advanceTimersByTimeAsync(600_000); expect(f.bodies).toHaveLength(1);
});
