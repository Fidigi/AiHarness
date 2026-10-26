import { describe, expect, it, vi } from 'vitest';
import { resolveAgentCompactionContextWindow } from '../config/agent-settings.js';
import { SessionManager } from './session-manager.js';
import { CloudflareWorkersAiMixedProvider, OpenAiMixedProvider, OpenRouterProvider } from '../providers/index.js';

async function fixture() {
  const manager = new SessionManager();
  const session = await manager.create();
  manager.setCompactionSettings({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 });
  for (let index = 0; index < 4; index++) await manager.addMessage(session.id,
    { role: 'user', content: 'x'.repeat(80) }, { skipAutoCompaction: true });
  const summary = vi.fn(async () => 'Summary');
  manager.setAutoCompactionCallback(summary);
  return { manager, session, summary };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('optional host model context for compaction', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128000', null, {}])(
    'rejects invalid window %j without changing the admitted scalar', value => {
      const manager = new SessionManager(); manager.setCompactionContextWindow(128_000);
      expect(() => manager.setCompactionContextWindow(value as number)).toThrow('Compaction context window is invalid.');
      expect(manager.getCompactionContextWindow()).toBe(128_000);
    });

  it('never coerces an object into a model window', () => {
    let calls = 0;
    const value = { valueOf() { calls++; return 128_000; } };
    expect(() => new SessionManager().setCompactionContextWindow(value as unknown as number)).toThrow();
    expect(calls).toBe(0);
  });

  it('preserves the legacy settings shape and host trigger until a window is supplied', async () => {
    const { manager, session, summary } = await fixture();
    expect(manager.getCompactionContextWindow()).toBeUndefined();
    expect(manager.getCompactionSettings()).toStrictEqual({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 });
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(true);
    expect(summary).toHaveBeenCalledTimes(1);
  });

  it('uses a strict greater-than boundary at model window minus reserve', async () => {
    const { manager, session, summary } = await fixture();
    const tokens = manager.estimateContextTokens(session.id);
    manager.setCompactionContextWindow(1_000);
    manager.setCompactionSettings({ reserveTokens: 1_000 - tokens });
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(false);
    expect(summary).not.toHaveBeenCalled();
    manager.setCompactionSettings({ reserveTokens: 1_001 - tokens });
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(true);
    expect(summary).toHaveBeenCalledTimes(1);
  });

  it('does not publish lifecycle or call the summarizer below the model boundary', async () => {
    const { manager, session, summary } = await fixture();
    manager.setCompactionContextWindow(128_000);
    const start = vi.fn(); manager.on('compaction:start', start);
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(false);
    expect(start).not.toHaveBeenCalled(); expect(summary).not.toHaveBeenCalled();
    expect((await manager.getRawEntries(session.id)).filter(entry => entry.type === 'compaction')).toEqual([]);
  });

  it('clears the model window without changing reserved/keep settings or legacy authority', async () => {
    const { manager, session } = await fixture();
    manager.setCompactionContextWindow(128_000);
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(false);
    manager.setCompactionContextWindow(undefined);
    expect(manager.getCompactionSettings()).toStrictEqual({ enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 });
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(true);
  });

  for (const phase of ['policy', 'start', 'summary'] as const) {
    it(`rejects a changed model window after awaiting ${phase}`, async () => {
      const { manager, session } = await fixture();
      manager.setCompactionContextWindow(1_000);
      const entered = deferred(), finish = deferred();
      const pause = async () => { entered.resolve(); await finish.promise; };
      if (phase === 'policy') manager.setAutoCompactionPolicy(async () => { await pause(); return true; });
      if (phase === 'start') manager.on('compaction:start', pause);
      if (phase === 'summary') manager.setAutoCompactionCallback(async () => { await pause(); return 'Late'; });
      const run = manager.checkAndTriggerCompaction(session.id);
      await entered.promise;
      manager.setCompactionContextWindow(2_000); finish.resolve();
      expect(await run).toBe(false);
      expect((await manager.getRawEntries(session.id)).filter(entry => entry.type === 'compaction')).toEqual([]);
    });
  }

  it('permits an equivalent model-window refresh while generation is pending', async () => {
    const { manager, session } = await fixture();
    manager.setCompactionContextWindow(1_000);
    manager.setAutoCompactionCallback(async () => { manager.setCompactionContextWindow(1_000); return 'Summary'; });
    expect(await manager.checkAndTriggerCompaction(session.id)).toBe(true);
  });
});

describe('passive configured-model window resolution', () => {
  it.each([
    ['openai', 'gpt-4o', 128_000], ['anthropic', 'claude-sonnet-4-6', 1_000_000],
    ['openai', 'unpublished', 128_000], ['custom-provider', 'private-model', 128_000],
    ['mock', 'mock-model', undefined], [undefined, undefined, undefined],
  ])('resolves %s/%s without discovery', (provider, model, expected) => {
    expect(resolveAgentCompactionContextWindow(provider, model)).toBe(expected);
  });

  it.each([
    [() => new OpenAiMixedProvider({ type: 'mistral', apiKey: 'disposable' }), 'gpt-6-luna', 272_000],
    [() => new OpenRouterProvider({ type: 'mistral', apiKey: 'disposable' }), 'anthropic/claude-sonnet-4.6', 1_000_000],
    [() => new CloudflareWorkersAiMixedProvider({ type: 'mistral', apiKey: 'disposable', accountId: 'explicit' }), '@cf/google/gemma-4-26b-a4b-it', 256_000],
  ] as const)('uses adapter-owned limits instead of a logical alias table', (create, model, expected) => {
    const provider = create();
    expect(resolveAgentCompactionContextWindow('mistral', model, provider)).toBe(expected);
  });

  it('does not borrow legacy limits after an authoritative missing, invalid or throwing declaration', () => {
    const provider = new OpenAiMixedProvider({ type: 'anthropic', apiKey: 'disposable' });
    expect(resolveAgentCompactionContextWindow('anthropic', 'claude-sonnet-4-6', provider)).toBe(128_000);
    vi.spyOn(provider, 'getPublishedModels').mockReturnValue([]);
    expect(resolveAgentCompactionContextWindow('anthropic', 'claude-sonnet-4-6', provider)).toBe(128_000);
    vi.mocked(provider.getPublishedModels).mockImplementation(() => { throw new Error('Private metadata'); });
    expect(resolveAgentCompactionContextWindow('anthropic', 'claude-sonnet-4-6', provider)).toBe(128_000);
    expect(resolveAgentCompactionContextWindow('anthropic', 'claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('rejects non-string identities without coercion', () => {
    let calls = 0;
    const value = { toString() { calls++; return 'openai'; } };
    expect(() => resolveAgentCompactionContextWindow(value as unknown as string, 'gpt-4o')).toThrow();
    expect(() => resolveAgentCompactionContextWindow('openai', value as unknown as string)).toThrow();
    expect(calls).toBe(0);
  });
});
