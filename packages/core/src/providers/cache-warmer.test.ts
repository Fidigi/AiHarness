import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheWarmer, evaluateCacheWarming, getCacheWarmingDelayMs } from './cache-warmer.js';
import { ProviderFactory } from './index.js';
import { SessionManager } from '../sessions/session-manager.js';
import { getSessionAccounting } from '../sessions/session-accounting.js';
import { getCacheTranscriptNotices } from './cache-notices.js';
import type { TokenUsage } from '../types/index.js';

const pricing = { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 };
const warmers: CacheWarmer[] = [];
afterEach(async () => { await Promise.all(warmers.splice(0).map(warmer => warmer.dispose())); vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(decide?: ConstructorParameters<typeof CacheWarmer>[2], onUsage?: ConstructorParameters<typeof CacheWarmer>[3]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Date, 'now').mockImplementation(() => vi.getMockedSystemTime()!.getTime());
  const manager = new SessionManager();
  const session = await manager.create();
  await manager.addMessage(session.id, { role: 'user', content: 'x'.repeat(400_000) });
  await manager.addMessage(session.id, { role: 'assistant', content: 'answer', provider: 'anthropic', model: 'claude-sonnet-4-6',
    usage: { inputTokens: 100_000, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100_001, costUsd: 0.3 } });
  const provider = ProviderFactory.create({ type: 'mock', model: 'physical' });
  const stream = vi.spyOn(provider, 'streamChat').mockImplementation(async (_messages, _chunk, complete) => {
    complete?.({ content: 'ignored', usage: { promptTokens: 0, completionTokens: 1, cacheReadTokens: 100_000, cacheWriteTokens: 0, totalTokens: 100_001 } });
  });
  const warmer = new CacheWarmer(manager, session.id, decide, onUsage); warmers.push(warmer);
  let current = true;
  const request = { provider, providerName: 'anthropic', model: 'claude-sonnet-4-6', messages: session.messages,
    options: { model: 'claude-sonnet-4-6', systemPrompt: 'system', tools: [{ name: 'never_execute', description: '', parameters: {} }] },
    ttlSeconds: 30, pricing, isCurrent: () => current };
  return { manager, session, stream, warmer, request, retire: () => { current = false; } };
}

describe('Pi-policy native prompt-cache warming', () => {
  it('uses the 90% delay, minimum margin and $0.05 expected-savings rule', () => {
    expect(getCacheWarmingDelayMs(300_000)).toBe(270_000);
    expect(getCacheWarmingDelayMs(30_000)).toBe(20_000);
    expect(getCacheWarmingDelayMs(10_000)).toBeUndefined();
    expect(evaluateCacheWarming(100_000, pricing, 'streaming')).toMatchObject({ action: 'warm', continuationProbability: 1 });
    expect(evaluateCacheWarming(100_000, pricing, 'idle')).toMatchObject({ action: 'stop', continuationProbability: 0.15 });
    expect(evaluateCacheWarming(0, pricing, 'streaming')).toMatchObject({ action: 'stop', economicsAvailable: false });
    expect(evaluateCacheWarming(100_000, {}, 'streaming').action).toBe('stop');
  });

  it('replays one token with no retries and records real attributed usage outside model context', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.manager.getEffectiveContext(f.session.id));
    f.warmer.start(f.request);
    expect(f.warmer.mode).toBe('streaming');
    expect(f.stream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream).toHaveBeenCalledTimes(1);
    expect(f.stream.mock.calls[0][4]).toMatchObject({ maxTokens: 1, maxRetries: 0, model: 'claude-sonnet-4-6' });
    expect(JSON.stringify(f.manager.getEffectiveContext(f.session.id))).toBe(before);
    const entries = await f.manager.getRawEntries(f.session.id);
    expect(entries.at(-1)).toMatchObject({ type: 'custom', customType: 'provider.cache_warm', data: { provider: 'anthropic', model: 'claude-sonnet-4-6' } });
    expect(getSessionAccounting(entries, f.session.activeLeafId).active).toMatchObject({ requests: 2, assistantMessages: 1,
      usage: { totalTokens: 200_002 }, knownCostUsd: 0.330015 });
    expect(getCacheTranscriptNotices(entries)).toEqual([expect.objectContaining({ kind: 'cache_warm', afterEntryId: f.session.messages.at(-1)!.id })]);
    await f.warmer.settle(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(f.stream).toHaveBeenCalledTimes(1);
  });

  it('does not reuse large historical usage to justify warming a small/compacted prefix', async () => {
    const f = await fixture();
    f.warmer.start({ ...f.request, messages: [{ ...f.request.messages[0], content: 'tiny prompt' }] });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.warmer.status).toMatchObject({ state: 'inactive', decision: { action: 'stop' } });
  });

  it('keeps owned request inputs and retires off/stopped/changed prefixes without calls', async () => {
    const f = await fixture();
    f.warmer.start(f.request);
    f.request.options.tools[0].name = 'mutated';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream.mock.calls[0][4]?.tools?.[0].name).toBe('never_execute');
    f.warmer.setMode('off');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream).toHaveBeenCalledTimes(1);
    f.warmer.setMode('streaming'); f.warmer.start(f.request); f.retire();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream).toHaveBeenCalledTimes(1);
  });

  it('refuses a refresh whose asynchronous decision outlives its cache deadline', async () => {
    const f = await fixture(async decision => { vi.setSystemTime(Date.now() + 6_000); return decision.action; });
    f.warmer.start(f.request); await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.warmer.status.reason).toBe('cache refresh deadline missed');
  });

  it('rechecks physical authorization and cancellation immediately before background dispatch', async () => {
    const f = await fixture();
    const authorize = vi.fn(async () => false);
    f.warmer.start({ ...f.request, isAuthorized: authorize });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(authorize).toHaveBeenCalledTimes(1); expect(f.stream).not.toHaveBeenCalled();
    expect(f.warmer.status.reason).toBe('provider unavailable');
    f.warmer.start({ ...f.request, isAuthorized: async () => { f.retire(); return true; } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.stream).not.toHaveBeenCalled();
  });

  it.each(['decision', 'authorization'] as const)('withdraws an uncooperative %s callback without blocking foreground settlement', async phase => {
    const never = () => new Promise<never>(() => undefined);
    const f = await fixture(phase === 'decision' ? never : undefined);
    f.warmer.start({ ...f.request, ...(phase === 'authorization' ? { isAuthorized: never } : {}) });
    await vi.advanceTimersByTimeAsync(20_000);
    await f.warmer.settle(false);
    expect(f.stream).not.toHaveBeenCalled(); expect(f.warmer.status.state).toBe('inactive');
  });

  it('persists billing without waiting for an uncooperative usage observer', async () => {
    const f = await fixture(undefined, () => new Promise<void>(() => undefined));
    f.warmer.start(f.request); await vi.advanceTimersByTimeAsync(20_000); await f.warmer.settle(false);
    expect((await f.manager.getRawEntries(f.session.id)).at(-1)).toMatchObject({ customType: 'provider.cache_warm' });
  });

  it('preserves real billing when the host usage observer fails', async () => {
    const observer = vi.fn((usage: TokenUsage) => { usage.costUsd = 0.04; throw new Error('observer failed'); });
    const f = await fixture(undefined, observer); f.warmer.start(f.request);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(observer).toHaveBeenCalledTimes(1);
    expect((await f.manager.getRawEntries(f.session.id)).at(-1)).toMatchObject({ data: { usage: { costUsd: 0.04 } } });
  });

  it('permits idle mode only when profitable and stops after the fixed horizon', async () => {
    const f = await fixture();
    f.warmer.setMode('idle');
    f.warmer.start({ ...f.request, pricing: { ...pricing, cacheReadPerMillion: 0.01 }, ttlSeconds: 300 });
    await f.warmer.settle(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.stream).toHaveBeenCalledTimes(6);
    expect(f.warmer.status.state).toBe('inactive');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.stream).toHaveBeenCalledTimes(6);
  });

  it('stops at the fixed streaming horizon even when its next timer lies exactly on the boundary', async () => {
    const f = await fixture(); f.warmer.start(f.request);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.stream).toHaveBeenCalledTimes(179);
    expect(f.warmer.status.state).toBe('inactive');
  });

  it('does not invent a free receipt when a declaration has no prices', async () => {
    const f = await fixture(async () => 'warm'); f.warmer.start({ ...f.request, pricing: {} });
    await vi.advanceTimersByTimeAsync(20_000);
    const entries = await f.manager.getRawEntries(f.session.id);
    expect(entries.at(-1)).toMatchObject({ customType: 'provider.cache_warm', data: { usage: { cacheReadTokens: 100_000 } } });
    expect((entries.at(-1) as { data: { usage: TokenUsage } }).data.usage.costUsd).toBeUndefined();
  });

  it('allows an explicit extension decision override and falls back after hook failure', async () => {
    const override = await fixture(async () => 'warm');
    override.warmer.setMode('idle'); override.warmer.start(override.request); await override.warmer.settle(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await override.manager.getRawEntries(override.session.id)).at(-1)).toMatchObject({ data: { extensionOverride: true } });
    await override.warmer.dispose();
    const fallback = await fixture(async () => { throw new Error('extension failure'); });
    fallback.warmer.start(fallback.request);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fallback.stream).toHaveBeenCalledTimes(1);
  });

  it('joins in-flight work and accounts a completed call on its original, now abandoned branch', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.stream.mockImplementation(async (_messages, _chunk, complete) => {
      await gate;
      complete?.({ content: 'ignored', usage: { promptTokens: 0, completionTokens: 1, cacheReadTokens: 100_000, totalTokens: 100_001 } });
    });
    f.warmer.start(f.request);
    await vi.advanceTimersByTimeAsync(20_000);
    const originalLeaf = f.session.activeLeafId!;
    await f.manager.navigateTree(f.session.id, f.session.messages[0].id);
    await f.manager.addMessage(f.session.id, { role: 'user', content: 'new branch' });
    const newLeaf = f.session.activeLeafId;
    let settled = false;
    const stop = f.warmer.settle(false).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release(); await stop;
    expect(f.session.activeLeafId).toBe(newLeaf);
    const entries = await f.manager.getRawEntries(f.session.id);
    expect(entries.at(-1)).toMatchObject({ parentEntryId: originalLeaf, customType: 'provider.cache_warm' });
    expect(getSessionAccounting(entries, f.session.activeLeafId)).toMatchObject({
      active: { requests: 0 }, history: { requests: 2, usage: { totalTokens: 200_002 } },
    });
  });

  it('does not invent usage on failure or accept retained callbacks after return', async () => {
    const f = await fixture();
    let late: (() => void) | undefined;
    f.stream.mockImplementation(async (_messages, _chunk, complete, error) => {
      late = () => complete?.({ content: 'late', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      error?.(new Error('failed'));
    });
    f.warmer.start(f.request);
    await vi.advanceTimersByTimeAsync(20_000);
    late?.();
    expect((await f.manager.getRawEntries(f.session.id)).filter(entry => entry.type === 'custom')).toEqual([]);
    await vi.advanceTimersByTimeAsync(100_000); expect(f.stream).toHaveBeenCalledTimes(1);
    await f.warmer.settle(false);
  });
});
