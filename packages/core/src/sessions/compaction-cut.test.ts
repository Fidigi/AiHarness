import { describe, expect, it } from 'vitest';
import type { MessageEntry } from './session-manager.js';
import { selectCompactionCut } from './compaction-cut.js';

const message = (id: string, role: MessageEntry['role'] = 'user', extra: Partial<MessageEntry> = {}): MessageEntry =>
  ({ id, type: 'message', role, content: id, timestamp: 0, ...extra });
const ordinary = () => Array.from({ length: 6 }, (_, index) => message(`m-${index}`, index % 2 ? 'assistant' : 'user'));
const tools = () => [message('u0'), message('a0', 'assistant'), message('u1'),
  message('declaration', 'assistant', { toolCalls: [{ id: 'a', name: 'alpha', input: {} }, { id: 'b', name: 'beta', input: {} }] }),
  message('result-a', 'tool', { toolCallId: 'a' }), message('result-b', 'tool', { toolCallId: 'b' })];

describe('atomic compaction cut', () => {
  it('keeps a weighted ordinary suffix, compacting only its prefix', () => {
    const cut = selectCompactionCut(ordinary(), [1, 1, 1, 1, 1, 1], 2, 'threshold')!;
    expect(cut.toCompact.map(entry => entry.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
    expect(cut.keptEntries.map(entry => entry.id)).toEqual(['m-4', 'm-5']);
    expect(cut).toMatchObject({ firstKeptEntryId: 'm-4', compactedTokens: 4, keptTokens: 2 });
  });
  it('retains an entire multi-tool unit even when its weight exceeds the soft keep target', () => {
    const cut = selectCompactionCut(tools(), [1, 1, 1, 2, 2, 2], 4, 'threshold')!;
    expect(cut.firstKeptEntryId).toBe('declaration');
    expect(cut.keptEntries.map(entry => entry.id)).toEqual(['declaration', 'result-a', 'result-b']);
    expect(cut).toMatchObject({ compactedTokens: 3, keptTokens: 6 });
  });
  it('can summarize a completed whole tool unit instead of retaining an orphan result', () => {
    const entries = [...tools(), message('next-user')];
    const cut = selectCompactionCut(entries, [1, 1, 1, 2, 2, 2, 1], 2, 'threshold')!;
    expect(cut.firstKeptEntryId).toBe('next-user');
    expect(cut.toCompact.slice(-3).map(entry => entry.id)).toEqual(['declaration', 'result-a', 'result-b']);
    expect(cut.keptEntries.map(entry => entry.id)).toEqual(['next-user']);
  });
  it('returns no threshold target when all units fit', () => {
    expect(selectCompactionCut(ordinary(), [1, 1, 1, 1, 1, 1], 20_000, 'threshold')).toBeNull();
  });
  it.each(['manual', 'overflow'] as const)('has a safe explicit %s fallback on small conversations', reason => {
    const cut = selectCompactionCut(ordinary(), [1, 1, 1, 1, 1, 1], 20_000, reason)!;
    expect(cut.firstKeptEntryId).toBe('m-4'); expect(cut.keptEntries).toHaveLength(2);
  });
  it('never splits the single available atomic tool unit merely to manufacture a target', () => {
    const entries = tools().slice(3);
    expect(selectCompactionCut(entries, [2, 2, 2], 1, 'manual')).toBeNull();
  });
  it('represents a model-visible custom boundary without falsely claiming native publication support', () => {
    const entries = [message('old-summary', 'system'), message('older'), message('custom-message'), message('recent')];
    expect(selectCompactionCut(entries, [10, 10, 1, 1], 2, 'threshold')!.firstKeptEntryId).toBe('custom-message');
  });
  it('does not mutate its owned input snapshot or weights', () => {
    const entries = tools(), weights = [1, 1, 1, 2, 2, 2], before = JSON.stringify({ entries, weights });
    selectCompactionCut(entries, weights, 4, 'manual');
    expect(JSON.stringify({ entries, weights })).toBe(before);
  });
  it('refuses unaligned orphan results rather than borrowing a declaration from another path', () => {
    expect(() => selectCompactionCut([message('orphan', 'tool', { toolCallId: 'missing' })], [1], 1, 'manual'))
      .toThrow('Compaction context is not a complete unambiguous model projection.');
  });
  it('refuses duplicate model IDs that cannot identify one retained boundary', () => {
    expect(() => selectCompactionCut([message('same'), message('same')], [1, 1], 1, 'manual')).toThrow(/unambiguous/);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid keep target %s', keep => {
    expect(() => selectCompactionCut(ordinary(), [1, 1, 1, 1, 1, 1], keep, 'threshold')).toThrow(/policy is invalid/);
  });
  it.each([{ weights: [1] }, { weights: [1, 1, 1, 1, 1, -1] }, { weights: [1, 1, 1, 1, 1, NaN] },
    { weights: [1, 1, 1, 1, 1, 0.5] }, { weights: [Number.MAX_SAFE_INTEGER, 1, 1, 1, 1, 1] }])(
    'rejects malformed or overflowing aligned weights $weights', ({ weights }) => {
    expect(() => selectCompactionCut(ordinary(), weights, 1, 'manual')).toThrow(/policy is invalid/);
  });
  it('never evaluates a replaced weight accessor during policy validation', () => {
    const weights = [1, 1, 1, 1, 1, 1]; let reads = 0;
    Object.defineProperty(weights, '1', { get() { reads++; return 1; } });
    expect(() => selectCompactionCut(ordinary(), weights, 1, 'manual')).toThrow(/policy is invalid/);
    expect(reads).toBe(0);
  });
  it('rejects unknown reasons without coercing them', () => {
    let coercions = 0; const reason = { toString() { coercions++; return 'manual'; } };
    expect(() => selectCompactionCut(ordinary(), [1, 1, 1, 1, 1, 1], 1, reason as unknown as 'manual')).toThrow(/policy is invalid/);
    expect(coercions).toBe(0);
  });
  it('has no target for an empty model context', () => {
    expect(selectCompactionCut([], [], 1, 'manual')).toBeNull();
  });
});
