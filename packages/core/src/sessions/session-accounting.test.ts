import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSessionAccounting } from './session-accounting.js';
import { JsonlSessionStore, SessionManager } from './session-manager.js';
import type { BranchSummaryAccounting, MessageEntry, SessionEntry } from './session-manager.js';
import type { TokenUsage } from '../types/index.js';

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7,
  cacheWriteTokens: 2, totalTokens: 24, costUsd: 0.01 };
function reply(id: string, parentMessageId?: string, measured?: TokenUsage): MessageEntry {
  return { type: 'message', id, parentMessageId, role: 'assistant', content: 'reply', timestamp: 1, usage: measured };
}

describe('journal accounting', () => {
  it('distinguishes an empty journal, measured zero, and no measurement', () => {
    expect(getSessionAccounting([])).toMatchObject({ activePathComplete: true,
      active: { requests: 0, cost: 'none' }, history: { cost: 'none', usage: {} } });
    expect(getSessionAccounting([reply('missing')], 'missing').history).toMatchObject({
      requests: 1, partial: true, cost: 'unknown', usage: {},
    });
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
    expect(getSessionAccounting([reply('zero', undefined, zero)], 'zero').active).toMatchObject({
      requests: 1, partial: false, cost: 'known', knownCostUsd: 0, usage: { totalTokens: 0 },
    });
  });

  it('includes pre-compaction ancestors but not abandoned siblings in active accounting', () => {
    const entries: SessionEntry[] = [reply('root', undefined, usage), reply('abandoned', 'root', { ...usage, costUsd: 1 }),
      { type: 'compaction', id: 'compact', parentEntryId: 'root', timestamp: 2,
        firstKeptEntryId: 'root', summary: 'Summary', usage },
      { type: 'branch_summary', id: 'summary', parentEntryId: 'compact', timestamp: 3,
        branchName: 'Branch', summary: 'Selected', usage }, reply('leaf', 'summary', usage)];
    const result = getSessionAccounting(entries, 'leaf');
    expect(result.activePathComplete).toBe(true);
    expect(result.active).toMatchObject({ requests: 4, assistantMessages: 2, totalMessages: 2,
      usage: { totalTokens: 96 }, cost: 'known', knownCostUsd: 0.04 });
    expect(result.history).toMatchObject({ requests: 5, assistantMessages: 3, totalMessages: 3,
      usage: { totalTokens: 120 }, cost: 'known', knownCostUsd: 1.04 });
  });

  it.each(['missing', 'cycle', 'no-leaf', 'duplicate'] as const)('marks %s paths incomplete rather than inventing totals', kind => {
    const entries = kind === 'cycle' ? [reply('a', 'b', usage), reply('b', 'a', usage)]
      : kind === 'duplicate' ? [reply('a', undefined, usage), reply('a', undefined, usage)]
        : [reply('a', kind === 'missing' ? 'lost' : undefined, usage)];
    const result = getSessionAccounting(entries, kind === 'no-leaf' ? undefined : 'a');
    expect(result.activePathComplete).toBe(false);
    expect(result.active.partial).toBe(true);
    expect(result.active.cost).toBe(kind === 'no-leaf' ? 'unknown' : 'partial');
    if (kind === 'duplicate') {
      expect(result.active.requests).toBe(1);
      expect(result.active.knownCostUsd).toBe(0.01);
      expect(result.history.requests).toBe(1);
      expect(result.history.knownCostUsd).toBe(0.01);
      expect(result.history.partial).toBe(true);
      expect(result.history.cost).toBe('partial');
    }
  });

  it('counts authoritative outer tool usage once, ignoring user/system/progress/nested metadata', () => {
    const entries: SessionEntry[] = [reply('root', undefined, usage), {
      type: 'message', id: 'tool', parentMessageId: 'root', role: 'tool', name: 'codemode',
      content: 'nested', timestamp: 2, usage, metadata: { codemode: { costComplete: false,
        usage: { costUsd: 999 }, nestedCalls: [{ usage: { costUsd: 999 } }] }, toolProgress: { details: { usage } } },
    }, { type: 'message', id: 'user', parentMessageId: 'tool', role: 'user', content: 'User', timestamp: 3, usage },
    { type: 'message', id: 'system', parentMessageId: 'user', role: 'system', content: 'System', timestamp: 4, usage }];
    expect(getSessionAccounting(entries, 'system').active).toMatchObject({ requests: 2,
      cost: 'partial', knownCostUsd: 0.02, usage: { totalTokens: 48 }, totalMessages: 4,
      userMessages: 1, assistantMessages: 1, toolResults: 1 });
  });

  it('does not invent measured tokens or prices from empty usage or unknown provenance', () => {
    const entry: MessageEntry = { ...reply('a', undefined, {}), provider: 'openai', model: 'o3' };
    expect(getSessionAccounting([entry], 'a').active.cost).toBe('unknown');
    expect(getSessionAccounting([reply('a', undefined, { inputTokens: 10 })], 'a').active).toMatchObject({
      partial: true, cost: 'unknown', usage: { inputTokens: 10 },
    });
    expect(getSessionAccounting([{ ...entry, usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 200_000 } }], 'a')
      .active.knownCostUsd).toBeCloseTo(6.1);
  });

  it('ignores invalid counters/costs and retains only a known subtotal for partial records', () => {
    const entries = [reply('known', undefined, usage), reply('bad', 'known', { inputTokens: NaN, outputTokens: -1, costUsd: Infinity })];
    expect(getSessionAccounting(entries, 'bad').active).toMatchObject({ cost: 'partial', partial: true,
      knownCostUsd: 0.01, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 24 } });
  });

  it.each(['__proto__', 'constructor', 'toString', 'custom-provider'])('keeps unrecognized historical provider %s unpriced', provider => {
    const entry: MessageEntry = { ...reply('a', undefined, { inputTokens: 1, outputTokens: 1 }), provider, model: 'o3' };
    expect(getSessionAccounting([entry], 'a').active.cost).toBe('unknown');
  });

  it('bounds overflowing counters and exposes an unpriced record rather than a false bounded total', () => {
    const entries = [reply('a', undefined, usage), reply('b', 'a', { inputTokens: Number.MAX_VALUE, costUsd: Number.MAX_VALUE })];
    const result = getSessionAccounting(entries, 'b').active;
    expect(result.partial).toBe(true);
    expect(result.usage.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.cost).toBe('partial');
    expect(result.knownCostUsd).toBe(0.01);
  });

  it('returns owned independent projections without mutating the journal', () => {
    const entries = [reply('a', undefined, usage)];
    const before = structuredClone(entries);
    const result = getSessionAccounting(Object.freeze(entries), 'a');
    result.active.usage.inputTokens = 999;
    expect(result.history.usage.inputTokens).toBe(10);
    expect(entries).toEqual(before);
  });
});

describe.each([false, true])('summary accounting persistence (durable=%s)', durable => {
  it('snapshots call provenance before awaits and preserves it through reload and clone', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-summary-accounting-'));
    try {
      const store = new JsonlSessionStore(directory, durable);
      const manager = new SessionManager();
      if (durable) manager.setStore(store);
      const session = await manager.create({ title: 'Summary', cwd: directory });
      await manager.addMessage(session.id, { role: 'user', content: 'Root' });
      const details = { provider: 'mock', model: 'mock-model', usage: { ...usage } };
      const pending = manager.addBranchSummary(session.id, 'Measured summary', 'Named', details);
      details.usage.costUsd = 99;
      details.model = 'changed-after-admission';
      expect(await pending).toMatchObject({ provider: 'mock', model: 'mock-model', usage });
      const copied = await manager.cloneSession(session.id);
      expect(copied).not.toBeNull();
      expect((await manager.getBranchSummaries(copied!.id))[0]).toMatchObject({ model: 'mock-model', usage });
      const raw = await manager.getRawEntries(session.id);
      expect(getSessionAccounting(raw, session.activeLeafId).active).toMatchObject({ cost: 'known', knownCostUsd: 0.01 });
      expect(store.getSessionFilePath(session.id)).toBe(durable ? path.join(directory, `${session.id}.jsonl`) : undefined);
      if (durable) {
        const reloaded = new SessionManager({ store });
        await reloaded.loadAllSessions();
        expect(await reloaded.getBranchSummaries(session.id)).toMatchObject([{ model: 'mock-model', usage }]);
        expect(await readFile(path.join(directory, `${session.id}.jsonl`), 'utf8')).not.toContain('changed-after-admission');
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps old summaries readable but unpriced instead of manufacturing zero costs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-summary-legacy-'));
    try {
      const manager = new SessionManager();
      if (durable) manager.setStore(new JsonlSessionStore(directory));
      const session = await manager.create({ title: 'Legacy' });
      await manager.addBranchSummary(session.id, 'Unmeasured manual summary');
      expect(getSessionAccounting(await manager.getRawEntries(session.id), session.activeLeafId).active).toMatchObject({
        requests: 1, cost: 'unknown', partial: true,
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('summary provenance admission', () => {
  it.each([NaN, Infinity, -1, '1', null])('rejects invalid counter %s before any mutation', async counter => {
    const manager = new SessionManager();
    const session = await manager.create();
    await expect(manager.addBranchSummary(session.id, 'Summary', 'Branch', {
      usage: { costUsd: counter } as TokenUsage,
    })).rejects.toThrow('Branch summary accounting is invalid.');
    expect(await manager.getRawEntries(session.id)).toEqual([]);
  });

  it('refuses own accessors without invoking them', async () => {
    const manager = new SessionManager();
    const session = await manager.create();
    let reads = 0;
    const accounting: BranchSummaryAccounting = { get provider() { reads++; return 'mock'; } };
    await expect(manager.addBranchSummary(session.id, 'Summary', 'Branch', accounting))
      .rejects.toThrow('Branch summary accounting is invalid.');
    expect(reads).toBe(0);
    expect(await manager.getRawEntries(session.id)).toEqual([]);
  });
});
