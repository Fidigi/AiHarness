import { describe, expect, it } from 'vitest';
import type { AgentRunSnapshot, ExtensionInteractionSnapshot } from '@ai-harness/core';
import { extensionInteractionChanges, interactionDraft, isFreshInteractionSnapshot, orderedExtensionRequests, reconcileInteractionSnapshot } from './api';

const request = (id: string, extra: Partial<ExtensionInteractionSnapshot> = {}): ExtensionInteractionSnapshot => ({
  id, kind: 'input', title: id, createdAt: '2026-01-01T00:00:00Z', ...extra,
});
const run = (extra: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot => ({
  id: 'run', sessionId: 'session', cwd: '/workspace', provider: 'mock', phase: 'tool',
  lastSequence: 10, steerQueue: [], followUpQueue: [], extensionRequests: [request('a'), request('b'), request('c')], ...extra,
});

describe('interaction queue transport helpers', () => {
  it('preserves admission order on update, inserts at tail and closes only the targeted ID', () => {
    const initial = run();
    const updated = { ...initial, ...extensionInteractionChanges(initial, { action: 'request', request: request('b', { title: 'replacement' }) }) };
    expect(orderedExtensionRequests(updated).map(entry => entry.id)).toEqual(['a', 'b', 'c']);
    expect(updated.extensionRequests?.[1]?.title).toBe('replacement');
    const inserted = { ...updated, ...extensionInteractionChanges(updated, { action: 'request', request: request('d') }) };
    expect(extensionInteractionChanges(inserted, { action: 'resolved', requestId: 'b' }).extensionRequests?.map(entry => entry.id)).toEqual(['a', 'c', 'd']);
  });
  it('uses legacy primary only when plural is absent and clears terminal/missing/empty snapshots', () => {
    expect(orderedExtensionRequests(run({ extensionRequests: undefined, extensionRequest: request('legacy') }))[0]?.id).toBe('legacy');
    expect(orderedExtensionRequests(run({ extensionRequests: [], extensionRequest: request('legacy') }))).toEqual([]);
    for (const phase of ['completed', 'failed', 'stopped'] as const) expect(reconcileInteractionSnapshot(run({ phase }))?.extensionRequests).toEqual([]);
    expect(reconcileInteractionSnapshot()).toBeUndefined();
  });
  it.each([null, undefined, [], 1, 'request', { action: 'request', request: null },
    { action: 'request', request: { id: 'x' } }, { action: 'request', request: request('x', { options: [null] as never }) },
    { action: 'request', request: request('x', { fields: [null] as never }) }, { action: 'resolved', requestId: {} }])('ignores malformed partial payload %j', data => {
    expect(extensionInteractionChanges(run(), data).extensionRequests?.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });
  it('does not reopen known closed IDs or terminal runs', () => {
    const closed = new Set(['a']);
    expect(extensionInteractionChanges(run({ extensionRequests: [] }), { action: 'request', request: request('a') }, closed).extensionRequests).toEqual([]);
    expect(reconcileInteractionSnapshot(run(), closed)?.extensionRequests?.map(entry => entry.id)).toEqual(['b', 'c']);
    expect(extensionInteractionChanges(run({ phase: 'stopped' }), { action: 'request', request: request('a') }).extensionRequests).toEqual([]);
  });
  it('gates absent/different/same run snapshots by session watermark, including after a clear', () => {
    for (const candidate of [undefined, run({ id: 'old', lastSequence: 9 }), run({ lastSequence: 9 })]) {
      expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 9, run: candidate }, run(), 10)).toBe(false);
    }
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 9 }, undefined, 10)).toBe(false);
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 11 }, run(), 10)).toBe(true);
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 12, run: run({ lastSequence: 12 }) }, run({ phase: 'stopped' }), 10)).toBe(false);
  });
  it('bounds queue and rejects malformed authoritative entries', () => {
    expect(orderedExtensionRequests(run({ extensionRequests: Array.from({ length: 20 }, (_, index) => request(String(index))) }))).toHaveLength(16);
    expect(orderedExtensionRequests(run({ extensionRequests: [null, request('a'), request('a')] as never }))).toHaveLength(1);
  });
  it('preserves only compatible same-ID drafts and resets changed kinds/field types/options', () => {
    const old = request('a', { kind: 'custom', fields: [
      { name: 'keep', label: 'Keep', type: 'text' }, { name: 'changed', label: 'Changed', type: 'text' },
      { name: 'pick', label: 'Pick', type: 'select', required: true, options: [{ label: 'Old', value: 'old' }] },
      { name: 'removed', label: 'Removed', type: 'text' },
    ] });
    const next = { ...old, fields: [old.fields![0]!, { name: 'changed', label: 'Changed', type: 'textarea' as const },
      { name: 'pick', label: 'Pick', type: 'select' as const, required: true, options: [{ label: 'New', value: 'new' }] },
      { name: 'added', label: 'Added', type: 'checkbox' as const }] };
    expect(interactionDraft(next, old, { keep: 'draft', changed: 'incompatible', pick: 'old', removed: 'gone' }))
      .toEqual({ keep: 'draft', changed: '', pick: 'new', added: false });
    expect(interactionDraft(request('b'), request('a'), 'draft')).toBe('');
    expect(interactionDraft(request('a', { kind: 'editor' }), request('a'), 'draft')).toBe('');
  });
});

// Append-only causal observation and bounded sequential churn controls.
describe('accepted store interaction presentation', () => {
  it('distinguishes an observed empty run from cold restoration and bounds long churn', async () => {
    const { InteractionPresentationLedger } = await import('./interaction-presentation.js');
    const ledger = new InteractionPresentationLedger();
    const baseline = run({ extensionRequests: [] });
    ledger.observe(baseline);
    ledger.observe(run());
    const live = ledger.forRun('run');
    expect(live.known.has('a')).toBe(true);
    expect(live.sounded.has('a')).toBe(false);
    live.sounded.add('a');
    ledger.observe(run());
    expect(live.sounded.has('a')).toBe(true);
    for (let i = 0; i < 2048; i++) {
      ledger.observe(run({ lastSequence: 11 + i * 2, extensionRequests: [request('churn-' + i)] }));
      live.sounded.add('churn-' + i);
      ledger.observe(run({ lastSequence: 12 + i * 2, extensionRequests: [] }));
      expect(live.known.size).toBe(0);
      expect(live.sounded.size).toBe(0);
      expect(live.closed.size).toBeLessThanOrEqual(256);
    }
    expect(live.closed.size).toBe(256);
    expect(live.closed.has('churn-2047')).toBe(true);
    for (let i = 0; i < 64; i++) ledger.observe(run({ id: 'next-' + i }));
    expect(ledger.size).toBe(16);
    const cold = new InteractionPresentationLedger();
    cold.observe(run());
    expect(cold.forRun('run').sounded.has('a')).toBe(true);
    cold.clear(); expect(cold.size).toBe(0);
  });
});

describe('evicted request membership and session-only observation', () => {
  it('does not reopen an evicted closed ID through an equal-version snapshot', async () => {
    const { InteractionPresentationLedger } = await import('./interaction-presentation.js');
    const ledger = new InteractionPresentationLedger();
    for (let i = 0; i < 300; i++) {
      ledger.observe(run({ lastSequence: i * 2 + 1, extensionRequests: [request('old-' + i)] }));
      ledger.observe(run({ lastSequence: i * 2 + 2, extensionRequests: [] }));
    }
    expect(ledger.forRun('run').closed.has('old-0')).toBe(false);
    const current = run({ lastSequence: 601, extensionRequests: [request('current')] });
    const replay = { ...current, extensionRequests: [request('old-0'), request('current')] };
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 601, run: replay }, current, 601)).toBe(false);
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 601, run: { ...current } }, current, 601)).toBe(true);
  });
  it('admits unchanged run version under a later session-only journal watermark', () => {
    const current = run();
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 20, run: current }, current, 20)).toBe(true);
    expect(isFreshInteractionSnapshot({ sessionId: 'session', lastSequence: 9, run: current }, current, 20)).toBe(false);
  });
});
