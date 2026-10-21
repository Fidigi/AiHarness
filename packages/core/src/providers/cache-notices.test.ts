import { describe, expect, it } from 'vitest';
import { getCacheTranscriptNotices, getCacheWarmUsage } from './cache-notices.js';
import type { SessionEntry } from '../sessions/session-manager.js';

const reply = (id: string, cacheReadTokens: number, model = 'claude-sonnet-4-6', timestamp = 1): SessionEntry => ({
  id, type: 'message', role: 'assistant', content: 'answer', timestamp, provider: 'anthropic', model,
  usage: { inputTokens: 100_000 - cacheReadTokens, outputTokens: 1, cacheReadTokens, cacheWriteTokens: 0, totalTokens: 100_001 },
});
describe('derived non-context cache notices', () => {
  it('does not treat a first turn, unsupported provider, compaction or tiny miss as waste', () => {
    expect(getCacheTranscriptNotices([reply('first', 0), reply('second', 0)])).toEqual([]);
    expect(getCacheTranscriptNotices([reply('first', 100_000), reply('noise', 99_999)])).toEqual([]);
    expect(getCacheTranscriptNotices([reply('first', 100_000), { type: 'compaction', id: 'c', timestamp: 2,
      firstKeptEntryId: 'first', summary: 'new prefix' }, reply('second', 0)])).toEqual([]);
  });
  it('derives stable significant miss notices with model-switch and idle attribution', () => {
    const entries = [reply('first', 100_000), reply('second', 0, 'claude-3-7-sonnet-latest', 600_002)];
    const notices = getCacheTranscriptNotices(entries);
    expect(notices).toEqual([{ id: 'cache-miss:second', afterEntryId: 'second', kind: 'cache_miss',
      missedTokens: 100_000, costUsd: 0.27, modelChanged: true, idleMinutes: 10 }]);
    expect(getCacheTranscriptNotices(entries)).toEqual(notices);
    expect(getCacheTranscriptNotices([...entries, ...entries])).toEqual(notices);
  });
  it('accepts only bounded plain-data usage and never executes accessors', () => {
    let reads = 0;
    const entry: SessionEntry = { id: 'warm', type: 'custom', timestamp: 1, customType: 'provider.cache_warm',
      data: { provider: 'anthropic', model: 'model', get usage() { reads++; return {}; } } };
    expect(getCacheWarmUsage(entry)).toBeUndefined(); expect(reads).toBe(0);
    expect(getCacheWarmUsage({ ...entry, data: { provider: 'anthropic', model: 'model', usage: { costUsd: Infinity } } })).toBeUndefined();
  });
});
