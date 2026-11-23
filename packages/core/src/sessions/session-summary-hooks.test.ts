import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from './session-manager.js';
import type { BranchSummaryEvent } from './branch-summarization.js';
import { copyBranchSummaryEvent, copyBranchSummaryOutput } from './session-branch-summary.js';
import { SessionStoreAdapter } from '../sdk/session-store.js';

function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(durable: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-summary-hook-')); roots.push(root);
  const store = new JsonlSessionStore(path.join(root, 'sessions'), durable), manager = new SessionManager(durable ? { store } : {});
  const source = await manager.create();
  await manager.addMessage(source.id, { role: 'user', content: 'Shared user' }); const target = source.activeLeafId!;
  await manager.appendCustomEntry(source.id, 'fixture:summary-state', { secret: 'NEVER_SUMMARY_STATE' });
  await manager.appendCustomMessage(source.id, 'fixture:summary-note', 'MODEL_CUSTOM_NOTE', { display: false, details: { secret: 'NEVER_SUMMARY_DETAILS' } });
  await manager.addMessage(source.id, { role: 'user', content: 'Abandoned user' });
  await manager.addMessage(source.id, { role: 'assistant', content: 'Abandoned answer' });
  return { root, store, manager, source, target };
}
const metadata = (): BranchSummaryEvent => ({ sourceSessionId: 'source', fromEntryId: 'from', targetEntryId: 'target',
  transcript: 'Model-visible transcript', signal: new AbortController().signal, tokenBudget: 100, maxOutputTokens: 8, maxOutputBytes: 32 });

describe('owned summary event/output capture', () => {
  it('captures frozen primitive metadata and the exact live signal', () => {
    const input = metadata(), captured = copyBranchSummaryEvent(input);
    expect(captured).toEqual(input); expect(captured).not.toBe(input); expect(Object.isFrozen(captured)).toBe(true); expect(captured.signal).toBe(input.signal);
  });
  it.each([{ sourceSessionId: '' }, { fromEntryId: 'x'.repeat(257) }, { targetEntryId: 'bad\0target' }, { transcript: '界'.repeat(666_667) },
    { signal: {} }, { tokenBudget: 0 }, { maxOutputTokens: 4_097 }, { maxOutputBytes: 33 }, { unknown: true }])('rejects malformed metadata %#', fields => {
    expect(() => copyBranchSummaryEvent({ ...metadata(), ...fields } as never)).toThrow('Branch summary event is invalid.');
  });
  it('never evaluates a metadata accessor or fills required fields from a prototype', () => {
    const getter = vi.fn(), input = Object.defineProperty(metadata(), 'transcript', { get: getter });
    expect(() => copyBranchSummaryEvent(input)).toThrow('Branch summary event is invalid.'); expect(getter).not.toHaveBeenCalled();
    expect(() => copyBranchSummaryEvent(Object.create(metadata()))).toThrow('Branch summary event is invalid.');
  });
  it('owns nested provenance and retains whitespace until credential redaction', () => {
    const value = { summary: ' raw ', usage: { totalTokens: 3 } }, captured = copyBranchSummaryOutput(value, 32);
    value.usage.totalTokens = 9; value.summary = 'changed'; expect(captured).toEqual({ summary: ' raw ', usage: { totalTokens: 3 } });
  });
  it.each([null, [], false, { summary: '' }, { summary: ' ' }, { summary: 'x'.repeat(33) }, { summary: 'ok', unknown: true },
    { summary: 'ok', usage: { totalTokens: -1 } }, { summary: 'ok', usage: { unknown: 1 } }])('rejects invalid bounded output %#', value => {
    expect(() => copyBranchSummaryOutput(value, 32)).toThrow();
  });
  it('does not evaluate output or nested accounting accessors', () => {
    const getter = vi.fn(() => 'PRIVATE_GETTER');
    expect(() => copyBranchSummaryOutput(Object.defineProperty({}, 'summary', { get: getter }), 32)).toThrow('Branch summary result is invalid.');
    expect(() => copyBranchSummaryOutput({ summary: 'ok', usage: Object.defineProperty({}, 'totalTokens', { get: getter }) }, 32))
      .toThrow('Branch summary accounting is invalid.'); expect(getter).not.toHaveBeenCalled();
  });
});

for (const durable of [false, true]) describe(`Core summary hooks (durable=${durable})`, () => {
  it('uses the last defined override without invoking fallback and preserves private/model boundaries', async () => {
    const f = await fixture(durable), original = await f.manager.getRawEntries(f.source.id), from = f.source.activeLeafId;
    const fallback = vi.fn(async () => ({ summary: 'Fallback' }));
    f.manager.onBeforeBranchSummary(async event => {
      expect(Object.isFrozen(event)).toBe(true); expect(event).toMatchObject({ sourceSessionId: f.source.id, fromEntryId: from, targetEntryId: f.target });
      expect(event.transcript).toContain('MODEL_CUSTOM_NOTE'); expect(event.transcript).not.toContain('NEVER_SUMMARY_STATE');
      expect(event.transcript).not.toContain('NEVER_SUMMARY_DETAILS');
      expect(await f.manager.getRawEntries(f.source.id)).toEqual(original);
      expect((await f.manager.getActiveBranchEntries(f.source.id)).at(-1)?.id).toBe(from);
      return { summary: 'First override' };
    });
    f.manager.onBeforeBranchSummary(() => ({ summary: 'Final override', provider: 'fixture', model: 'summary', usage: { totalTokens: 3 } }));
    const result = await f.manager.navigateTree(f.source.id, f.target, { summarize: true, summarizer: fallback });
    expect(result).toMatchObject({ status: 'navigated', summary: { summary: 'Final override', parentEntryId: f.target, fromEntryId: from, usage: { totalTokens: 3 } } });
    expect(fallback).not.toHaveBeenCalled(); expect((await f.manager.getRawEntries(f.source.id)).slice(0, original.length)).toEqual(original);
    const model = JSON.stringify(f.manager.getEffectiveContext(f.source.id)); expect(model).toContain('Final override');
    expect(model).not.toContain('NEVER_SUMMARY_STATE'); expect(model).not.toContain('NEVER_SUMMARY_DETAILS');
    if (durable) expect((await new SessionManager({ store: f.store }).loadFromStore(f.source.id))?.activeLeafId).toBe(result.entryId);
  });

  it('allows an explicit override without a fallback but cannot invoke hooks without summary authority', async () => {
    const f = await fixture(durable), hook = vi.fn(() => ({ summary: 'Override' })); f.manager.onBeforeBranchSummary(hook);
    expect(await f.manager.navigateTree(f.source.id, f.target, { summarize: true })).toMatchObject({ status: 'navigated', summary: { summary: 'Override' } });
    expect(hook).toHaveBeenCalledTimes(1);
    const other = await fixture(durable), observe = vi.fn(() => ({ summary: 'Unauthorized' })), fallback = vi.fn(async () => ({ summary: 'Unauthorized' }));
    other.manager.onBeforeBranchSummary(observe);
    expect(await other.manager.navigateTree(other.source.id, other.target, { summarizer: fallback })).toMatchObject({ status: 'navigated' });
    expect(observe).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    expect((await other.manager.getRawEntries(other.source.id)).some(entry => entry.type === 'branch_summary')).toBe(false);
  });

  it('falls back only after observing hooks and captures an owned override before later awaits', async () => {
    const f = await fixture(durable), value = { summary: 'Captured', usage: { totalTokens: 3 } };
    f.manager.onBeforeBranchSummary(() => value);
    f.manager.onBeforeBranchSummary(() => { value.summary = 'Mutated'; value.usage.totalTokens = 9; });
    expect(await f.manager.navigateTree(f.source.id, f.target, { summarize: true }))
      .toMatchObject({ status: 'navigated', summary: { summary: 'Captured', usage: { totalTokens: 3 } } });
    const other = await fixture(durable), fallback = vi.fn(async () => ({ summary: 'Fallback' }));
    other.manager.onBeforeBranchSummary(() => undefined);
    expect(await other.manager.navigateTree(other.source.id, other.target, { summarize: true, summarizer: fallback })).toMatchObject({ status: 'navigated', summary: { summary: 'Fallback' } });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('honours a later veto before fallback or publication', async () => {
    const f = await fixture(durable), raw = await f.manager.getRawEntries(f.source.id), before = structuredClone(f.source), fallback = vi.fn();
    const sourcePath = path.join(f.root, 'sessions', `${f.source.id}.jsonl`), bytes = durable ? await readFile(sourcePath) : undefined;
    f.manager.onBeforeBranchSummary(() => ({ summary: 'Discarded override' })); f.manager.onBeforeBranchSummary(() => false);
    expect(await f.manager.navigateTree(f.source.id, f.target, { summarize: true, summarizer: fallback })).toEqual({ status: 'cancelled' });
    expect(fallback).not.toHaveBeenCalled(); expect(f.source).toEqual(before); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    if (durable) expect(await readFile(sourcePath)).toEqual(bytes);
  });

  it.each(['hook', 'fallback'] as const)('settles cancellation of a non-cooperative %s without late publication', async stage => {
    const f = await fixture(durable), gate = latch(), entered = latch(), controller = new AbortController();
    const raw = await f.manager.getRawEntries(f.source.id), before = structuredClone(f.source);
    const work = async () => { entered.release(); await gate.promise; return { summary: 'Late' }; };
    if (stage === 'hook') f.manager.onBeforeBranchSummary(work);
    try {
      const pending = f.manager.navigateTree(f.source.id, f.target, { summarize: true, summarizer: work, signal: controller.signal });
      await entered.promise; controller.abort(); expect(await pending).toEqual({ status: 'cancelled' });
      gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.source).toEqual(before); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
    } finally { gate.release(); }
  });

  it.each(['remove', 'store', 'delete', 'clear'] as const)('withdraws %s authority during summary hooks', async action => {
    const f = await fixture(durable), gate = latch(), entered = latch(), replacement = new JsonlSessionStore(path.join(f.root, 'replacement'));
    const remove = f.manager.onBeforeBranchSummary(async () => { entered.release(); await gate.promise; return { summary: 'Late' }; });
    try {
      const pending = f.manager.navigateTree(f.source.id, f.target, { summarize: true }); await entered.promise;
      if (action === 'remove') remove();
      else if (action === 'store') f.manager.setStore(replacement);
      else if (action === 'delete') await f.manager.delete(f.source.id);
      else await f.manager.clear();
      expect(await pending).toEqual({ status: action === 'remove' ? 'cancelled' : 'stale' });
      gate.release(); await new Promise<void>(resolve => setImmediate(resolve));
      if (action === 'remove') expect((await f.manager.getRawEntries(f.source.id)).some(entry => entry.type === 'branch_summary')).toBe(false);
      if (action === 'store') expect(await replacement.listSessionIds()).toEqual([]);
    } finally { gate.release(); remove(); }
  });

  it('scrubs hook errors and refuses accessor results without evaluating private getters', async () => {
    const f = await fixture(durable), raw = await f.manager.getRawEntries(f.source.id), getter = vi.fn();
    const remove = f.manager.onBeforeBranchSummary(() => { throw new Error('PRIVATE_DIAGNOSTIC'); });
    await expect(f.manager.navigateTree(f.source.id, f.target, { summarize: true })).rejects.toThrow('Branch summary hook failed.'); remove();
    f.manager.onBeforeBranchSummary(() => Object.defineProperty({}, 'summary', { get: getter }) as never);
    await expect(f.manager.navigateTree(f.source.id, f.target, { summarize: true })).rejects.toThrow('Branch summary result is invalid.');
    expect(getter).not.toHaveBeenCalled(); expect(await f.manager.getRawEntries(f.source.id)).toEqual(raw);
  });
});

it('finishes an already-admitted navigation write through abort and hook retirement', async () => {
  const f = await fixture(true), gate = latch(), entered = latch(), controller = new AbortController();
  const save = f.store.saveSession.bind(f.store), remove = f.manager.onBeforeBranchSummary(() => ({ summary: 'Admitted summary' }));
  vi.spyOn(f.store, 'saveSession').mockImplementation(async (...args) => { entered.release(); await gate.promise; await save(...args); });
  try {
    const pending = f.manager.navigateTree(f.source.id, f.target, { summarize: true, signal: controller.signal });
    await entered.promise; controller.abort(); remove(); gate.release();
    const result = await pending; expect(result).toMatchObject({ status: 'navigated', summary: { summary: 'Admitted summary' } });
    expect((await f.store.loadSession(f.source.id))?.activeLeafId).toBe(result.entryId);
  } finally { gate.release(); remove(); }
});

it('redacts the original whitespace-bearing summary before trimming it', async () => {
  const manager = new SessionManager({ redactText: value => value.replaceAll(' secret ', '[REDACTED]') });
  const source = await manager.create(); await manager.addMessage(source.id, { role: 'user', content: 'Root' }); const target = source.activeLeafId!;
  await manager.addMessage(source.id, { role: 'user', content: 'Abandoned' });
  manager.onBeforeBranchSummary(() => ({ summary: ' secret ' }));
  expect(await manager.navigateTree(source.id, target, { summarize: true })).toMatchObject({ status: 'navigated', summary: { summary: '[REDACTED]' } });
});

it('preserves a borrowed structural journal through an already-admitted summary write', async () => {
  const f = await fixture(true), store = new SessionStoreAdapter(f.store), manager = new SessionManager({ store });
  await manager.loadFromStore(f.source.id); const original = await manager.getRawEntries(f.source.id);
  const entered = latch(), gate = latch(), caller = new AbortController(), save = store.saveSession.bind(store);
  const remove = manager.onBeforeBranchSummary(() => ({ summary: 'Structural summary' }));
  vi.spyOn(store, 'saveSession').mockImplementation(async (...args) => { entered.release(); await gate.promise; await save(...args); });
  try {
    const pending = manager.navigateTree(f.source.id, f.target, { summarize: true, signal: caller.signal });
    await entered.promise; caller.abort(); remove(); gate.release();
    const result = await pending; expect(result).toMatchObject({ status: 'navigated', summary: { summary: 'Structural summary' } });
    expect((await f.store.loadSession(f.source.id))?.activeLeafId).toBe(result.entryId);
    expect((await f.store.getRawEntries(f.source.id)).filter(entry => entry.type !== 'metadata').slice(0, original.length)).toEqual(original);
  } finally { gate.release(); remove(); }
});

it('bounds summary callbacks and keeps refused registrations from revoking pending work', async () => {
  const f = await fixture(false), gate = latch(), entered = latch();
  f.manager.onBeforeBranchSummary(async () => { entered.release(); await gate.promise; return { summary: 'Accepted' }; });
  for (let index = 1; index < 128; index++) f.manager.onBeforeBranchSummary(() => undefined);
  try {
    const pending = f.manager.navigateTree(f.source.id, f.target, { summarize: true }); await entered.promise;
    expect(() => f.manager.onBeforeBranchSummary(() => false)).toThrow('Branch summary hook limit reached.');
    gate.release(); expect(await pending).toMatchObject({ status: 'navigated', summary: { summary: 'Accepted' } });
  } finally { gate.release(); }
});
