import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunSnapshot } from '@ai-harness/core';
import { useSessionStore } from './session-store.js';

const run = (id: string, lastSequence: number, phase: AgentRunSnapshot['phase'] = 'tool'): AgentRunSnapshot => ({
  id, sessionId: 'session', cwd: '/workspace', provider: 'mock', phase, lastSequence,
  steerQueue: [], followUpQueue: [], extensionRequests: [{ id: `${id}-request`, kind: 'input', title: id, createdAt: '2026-01-01' }],
});
const store = () => useSessionStore.getState();

describe('actual session store run authority', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [] }));
  it('rejects older different-run snapshots and retired callbacks even with a larger sequence', () => {
    store().setRun('session', run('new', 20));
    store().setRun('session', run('old', 10));
    expect(store().runs.session.id).toBe('new');
    store().setRun('session', run('next', 30));
    store().setRun('session', run('new', 40));
    expect(store().runs.session.id).toBe('next');
  });
  it('keeps authority after clear and blocks both stale discovery and resurrection', () => {
    store().setRun('session', run('new', 20));
    store().setRun('session');
    store().setRun('session', run('old', 10));
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('equal-sequence-unknown', 20));
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('new', 30));
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('next', 31));
    expect(store().runs.session.id).toBe('next');
  });
  it('guards delayed list/get/empty replies against intervening updates, clears and reset epochs', () => {
    store().setRun('session', run('old', 10));
    const guard = { epoch: store().runEpoch, authority: store().runAuthorities.session };
    store().setRun('session', run('new', 20));
    store().setRun('session', undefined, guard);
    store().setRun('session', run('old', 30, 'completed'), guard);
    expect(store().runs.session.id).toBe('new');
    store().setRun('session');
    store().setRun('session', run('old', 40), guard);
    expect(store().runs.session).toBeUndefined();
    const resetGuard = { epoch: store().runEpoch, authority: store().runAuthorities.session };
    useSessionStore.setState({ runs: {}, runEpoch: store().runEpoch + 1 });
    store().setRun('session', run('next', 50), resetGuard);
    expect(store().runs.session).toBeUndefined();
  });
  it('terminal/empty snapshots have no queue authority and a terminal run cannot reopen', () => {
    store().setRun('session', run('one', 10));
    store().setRun('session', run('one', 11, 'completed'));
    expect(store().runs.session.extensionRequests).toEqual([]);
    expect(store().runs.session.extensionRequest).toBeUndefined();
    store().setRun('session', run('one', 12));
    expect(store().runs.session.phase).toBe('completed');
    store().setRun('session', { ...run('two', 13), extensionRequests: [] });
    expect(store().runs.session.extensionRequests).toEqual([]);
  });
  it('delete tombstones reject pending callbacks, and authority retention is bounded', () => {
    store().setRun('session', run('one', 10));
    store().removeSession('session');
    store().setRun('session', run('two', 20));
    expect(store().runs.session).toBeUndefined();
    for (let i = 0; i < 300; i++) store().setRun(`session-${i}`, { ...run(`run-${i}`, i + 1), sessionId: `session-${i}` });
    expect(Object.keys(store().runAuthorities)).toHaveLength(256);
  });
});


describe('exact authoritative absence watermark', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [] }));
  it('persists fresh absence sequence and rejects post-absence discovery from before that boundary', () => {
    store().setRun('session', run('observed', 10));
    store().setRun('session', undefined, { epoch: 0, authority: store().runAuthorities.session, absenceSequence: 21 });
    expect(store().runAuthorities.session.sequence).toBe(21);
    store().setRun('session', run('unseen', 15));
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('equal', 21));
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('fresh', 22));
    expect(store().runs.session.id).toBe('fresh');
    const staleGuard = { epoch: 0, authority: store().runAuthorities.session, absenceSequence: 21 };
    store().setRun('session', undefined, staleGuard);
    expect(store().runs.session.id).toBe('fresh');
  });
});

// Append-only: imported legal session IDs must never read Object.prototype as authority.
describe('own run authority keys', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [] }));
  it.each(['__proto__', 'constructor', 'toString'])('admits and retires the own session key %s', sessionId => {
    expect(() => store().setRun(sessionId, { ...run('first', 10), sessionId })).not.toThrow();
    expect(Object.hasOwn(store().runAuthorities, sessionId)).toBe(true);
    expect(store().runAuthorities[sessionId].runId).toBe('first');
    store().removeSession(sessionId);
    expect(store().runAuthorities[sessionId].deleted).toBe(true);
    store().setRun(sessionId, { ...run('late', 20), sessionId });
    expect(Object.hasOwn(store().runs, sessionId)).toBe(false);
  });
});

// A pristine empty poll is not evidence of a completed or retired run.
describe('pristine sequence-zero discovery', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [] }));
  it('admits the first canonical zero-sequence run after empty discovery', () => {
    store().setRun('session', undefined, { epoch: 0, absenceSequence: 0 });
    expect(store().runAuthorities.session).toMatchObject({ sequence: 0, pristine: true, terminal: false, retired: [] });
    store().setRun('session', run('first', 0));
    expect(store().runs.session.id).toBe('first');
    expect(store().runAuthorities.session.terminal).toBe(false);
  });
  it.each(['completed', 'failed', 'stopped'] as const)('never reopens actual %s history at zero or a future sequence', phase => {
    store().setRun('session', run('actual', 0, phase));
    store().setRun('session');
    store().setRun('session', run('actual', 100));
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('foreign', 0));
    expect(store().runs.session).toBeUndefined();
    expect(store().runAuthorities.session.retired).toContain('actual');
  });
  it('retains actual active-run retirement even at zero and guards delayed discovery', () => {
    store().setRun('session', run('actual', 0));
    const guard = { epoch: 0, authority: store().runAuthorities.session };
    store().setRun('session');
    store().setRun('session', run('actual', 1));
    store().setRun('session', run('foreign', 0));
    store().setRun('session', run('delayed', 1), guard);
    expect(store().runs.session).toBeUndefined();
    store().setRun('session', run('fresh', 1));
    expect(store().runs.session.id).toBe('fresh');
  });
  it('keeps positive absence watermarks, workspace, deletion and reset guards', () => {
    store().setRun('session', undefined, { epoch: 0, absenceSequence: 2 });
    store().setRun('session', run('first', 0));
    expect(store().runs.session).toBeUndefined();
    store().removeSession('deleted');
    store().setRun('deleted', { ...run('deleted', 0), sessionId: 'deleted' });
    expect(store().runs.deleted).toBeUndefined();
    store().setRun('reset', { ...run('reset', 0), sessionId: 'reset' }, { epoch: -1 });
    expect(store().runs.reset).toBeUndefined();
    useSessionStore.setState({ workspace: { id: 'workspace', cwd: '/workspace' } as never });
    store().setRun('wrong-workspace', { ...run('wrong', 0), sessionId: 'wrong-workspace', cwd: '/foreign' });
    expect(store().runs['wrong-workspace']).toBeUndefined();
  });
});

// Legal imported IDs must not manufacture terminal history from Object.prototype.
describe('pristine own-key startup', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [] }));
  it.each(['__proto__', 'constructor', 'toString'])('admits the first canonical zero-sequence run for %s', sessionId => {
    store().setRun(sessionId, undefined, { epoch: 0, absenceSequence: 0 });
    store().setRun(sessionId, { ...run('first', 0), sessionId });
    expect(Object.hasOwn(store().runs, sessionId)).toBe(true);
    expect(store().runs[sessionId].id).toBe('first');
    store().setRun(sessionId);
    store().setRun(sessionId, { ...run('first', 1), sessionId });
    expect(Object.hasOwn(store().runs, sessionId)).toBe(false);
  });
});

// New causal eviction controls: preserve all eighteen original test bodies above.
describe('bounded authority eviction must not erase retirement', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: 'unrelated-active-session' }));
  it('rejects an undefined-authority discovery after delete and 256-record eviction', () => {
    const guard = { epoch: store().runEpoch, authority: store().runAuthorities.deleted, activeSessionId: store().activeSessionId };
    store().removeSession('deleted');
    for (let i = 0; i < 256; i++) store().setRun('other-' + i, { ...run('other-run-' + i, i + 1), sessionId: 'other-' + i });
    expect(Object.keys(store().runAuthorities)).toHaveLength(256);
    store().setRun('deleted', { ...run('retired-discovery', 1000), sessionId: 'deleted' }, guard);
    expect(Object.hasOwn(store().runs, 'deleted')).toBe(false);
  });
  it('rejects a larger-sequence retired run after sixteen-ID eviction', () => {
    store().setRun('session', run('original-retired', 1));
    for (let i = 0; i < 20; i++) store().setRun('session', run('next-' + i, i + 2));
    expect(store().runAuthorities.session.retired).toHaveLength(16);
    store().setRun('session', run('original-retired', 1000));
    expect(store().runs.session.id).toBe('next-19');
  });
});

import { captureInteractionReplyGuard, getSessionRecord, captureCanonicalRunGuard, getStoredRun } from './session-store.js';

// Append-only causal coverage of bounded negative membership and fresh canonical recovery.
describe('retirement fence recovery capability', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: null }));
  it('cannot forge canonical recovery with a literal flag', () => {
    store().setRun('session', run('old', 1));
    for (let i = 0; i < 20; i++) store().setRun('session', run('new-' + i, i + 2));
    const guard = { epoch: store().runEpoch, authority: store().runAuthorities.session, canonical: true };
    store().setRun('session', run('old', 1000), guard);
    expect(store().runs.session.id).toBe('new-19');
  });
  it('invalidates captured undefined canonical authority when a deletion is evicted', () => {
    const guard = captureCanonicalRunGuard(store(), 'deleted');
    store().removeSession('deleted');
    for (let i = 0; i < 256; i++) store().setRun('other-' + i, { ...run('other-' + i, i + 1), sessionId: 'other-' + i });
    store().setRun('deleted', { ...run('old-discovery', 1000), sessionId: 'deleted' }, guard);
    expect(Object.hasOwn(store().runs, 'deleted')).toBe(false);
  });
  it('allows only fresh canonical recovery from a conservative false positive', () => {
    store().setRun('session', run('current', 1));
    const authority = store().runAuthorities.session;
    useSessionStore.setState({ runAuthorities: { session: { ...authority, retiredFilter: Object.freeze(Array<number>(32).fill(0xffffffff)) } } });
    store().setRun('session', run('genuinely-new', 2));
    expect(store().runs.session.id).toBe('current');
    const guard = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', run('genuinely-new', 2), { ...guard });
    expect(store().runs.session.id).toBe('genuinely-new');
    expect(Object.keys(store().runAuthorities)).toHaveLength(1);
    expect(store().runAuthorities.session.retiredFilter).toHaveLength(32);
  });
  it('fresh canonical recovery never bypasses a retained exact deletion', () => {
    store().removeSession('session');
    const guard = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', run('should-not-exist', 1000), guard);
    expect(Object.hasOwn(store().runs, 'session')).toBe(false);
  });
  it('fresh canonical recovery never bypasses retained exact retired run IDs', () => {
    store().setRun('session', run('old', 1));
    store().setRun('session', run('new', 2));
    const guard = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', run('old', 1000), guard);
    expect(store().runs.session.id).toBe('new');
  });
  it('canonical witnesses still retire on workspace epoch and intervening authority changes', () => {
    store().setRun('session', run('first', 1));
    const guard = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', run('second', 2));
    store().setRun('session', run('stale', 3), guard);
    expect(store().runs.session.id).toBe('second');
    const next = captureCanonicalRunGuard(store(), 'session');
    useSessionStore.setState({ runEpoch: store().runEpoch + 1 });
    store().setRun('session', run('retired-epoch', 4), next);
    expect(store().runs.session.id).toBe('second');
  });
  it.each(['__proto__', 'constructor', 'toString'])('consumer lookup never invents a run for %s', sessionId => {
    expect(getStoredRun(store().runs, sessionId)).toBeUndefined();
    const value = { ...run('first', 0), sessionId };
    store().setRun(sessionId, value);
    expect(getStoredRun(store().runs, sessionId)).toEqual(value);
    store().removeSession(sessionId);
    expect(getStoredRun(store().runs, sessionId)).toBeUndefined();
  });
});

describe('session observation versus run snapshot version', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: null }));
  it('session notices advance the watermark without inventing a run version', () => {
    const first = run('first', 10);
    store().setRun('session', first);
    const guard = { epoch: store().runEpoch, authority: store().runAuthorities.session, snapshotSequence: 20 };
    store().setRun('session', first, guard);
    expect(store().runAuthorities.session.sequence).toBe(20);
    expect(store().runs.session.lastSequence).toBe(10);
    store().setRun('session', run('old-discovery', 19));
    expect(store().runs.session.id).toBe('first');
    const canonical = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', first, { ...canonical, snapshotSequence: 20 });
    expect(store().runs.session.lastSequence).toBe(10);
  });
  it('fresh canonical state can discover a current run behind later session-only events', () => {
    store().setRun('session', run('previous', 10));
    store().setRun('session', run('previous', 10), { epoch: 0, authority: store().runAuthorities.session, snapshotSequence: 20 });
    const canonical = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', run('current', 11), { ...canonical, snapshotSequence: 20 });
    expect(store().runs.session.id).toBe('current');
    expect(store().runAuthorities.session.sequence).toBe(20);
    store().setRun('session', run('previous', 1000));
    expect(store().runs.session.id).toBe('current');
  });
  it('same-version snapshots cannot invent, remove or reorder queue IDs', () => {
    const initial = { ...run('current', 10), extensionRequests: [
      { id: 'one', kind: 'input' as const, title: 'One', createdAt: 'date' },
      { id: 'two', kind: 'input' as const, title: 'Two', createdAt: 'date' },
    ] };
    store().setRun('session', initial);
    for (const entries of [[], initial.extensionRequests.slice().reverse(), [...initial.extensionRequests, { id: 'old', kind: 'input' as const, title: 'Old', createdAt: 'date' }]]) {
      store().setRun('session', { ...initial, extensionRequests: entries });
      expect(store().runs.session.extensionRequests).toEqual(initial.extensionRequests);
    }
  });
});

// Validation-only append; do not alter the executed v5 candidate or original bodies.
it('duplicate canonical observations do not retire an unchanged pending response authority', () => {
  useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: null });
  const first = run('current', 10);
  store().setRun('session', first);
  const guard = { epoch: store().runEpoch, authority: store().runAuthorities.session };
  store().setRun('session', structuredClone(first));
  expect(store().runAuthorities.session).toBe(guard.authority);
  store().setRun('session', run('current', 11), guard);
  expect(store().runs.session.lastSequence).toBe(11);
});

describe('explicit local admission receipts', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: null }));
  it('acknowledges no-ops without replacing state, run or authority', () => {
    expect(store().setRun('session', run('current', 10))).toBe(true);
    const before = store();
    expect(store().setRun('session', structuredClone(before.runs.session))).toBe(true);
    expect(store()).toBe(before);
    expect(store().runs.session).toBe(before.runs.session);
    expect(store().runAuthorities.session).toBe(before.runAuthorities.session);
    expect(store().setRun('session', run('stale', 9))).toBe(false);
    expect(store()).toBe(before);
  });
  it('accepts duplicate absence while preserving its captured authority', () => {
    expect(store().setRun('session', undefined, { epoch: 0, absenceSequence: 5 })).toBe(true);
    const before = store();
    const guard = captureCanonicalRunGuard(before, 'session');
    expect(store().setRun('session', undefined, { ...guard, absenceSequence: 5 })).toBe(true);
    expect(store()).toBe(before);
    expect(store().setRun('session', undefined, { ...guard, absenceSequence: 4 })).toBe(false);
    expect(store()).toBe(before);
  });
  it('publishes changed compatible display data without revoking the same authority', () => {
    const initial = run('current', 10);
    store().setRun('session', initial);
    const guard = { epoch: 0, authority: store().runAuthorities.session };
    const next = { ...initial, extensionRequests: initial.extensionRequests!.map(request => ({ ...request, message: 'Changed display' })) };
    expect(store().setRun('session', next)).toBe(true);
    expect(store().runs.session.extensionRequests?.[0].message).toBe('Changed display');
    expect(store().runAuthorities.session).toBe(guard.authority);
    expect(store().setRun('session', run('current', 11), guard)).toBe(true);
    expect(store().runAuthorities.session).not.toBe(guard.authority);
    expect(store().setRun('session', run('current', 12), guard)).toBe(false);
  });
});

describe('captured exact HTTP closure and own session records', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, drafts: {}, attachments: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: null }));
  it('allows only the captured current head closure at the same version, without inventing a new version', () => {
    const initial = run('current', 10);
    store().setRun('session', initial);
    const guard = captureInteractionReplyGuard(store(), 'session', 'current-request');
    const authority = store().runAuthorities.session;
    expect(store().setRun('session', { ...initial, extensionRequests: [] }, { epoch: 0, authority })).toBe(false);
    expect(store().setRun('session', { ...initial, extensionRequests: [] }, { ...guard, snapshotSequence: 10 })).toBe(true);
    expect(store().runs.session.lastSequence).toBe(10);
    expect(store().runAuthorities.session).toBe(authority);
  });
  it('cannot use a non-head, stale or literal invented closure witness', () => {
    const initial = run('current', 10);
    store().setRun('session', initial);
    const wrong = captureInteractionReplyGuard(store(), 'session', 'wrong');
    expect(store().setRun('session', { ...initial, extensionRequests: [] }, wrong)).toBe(false);
    const proper = captureInteractionReplyGuard(store(), 'session', 'current-request');
    const forged = { epoch: 0, authority: proper.authority, closedRequestId: 'current-request' };
    expect(store().setRun('session', { ...initial, extensionRequests: [] }, forged)).toBe(false);
    expect(store().setRun('session', { ...initial, extensionRequests: [{ ...initial.extensionRequests![0], id: 'invented' }] }, proper)).toBe(false);
    store().setRun('session', run('current', 11));
    expect(store().setRun('session', { ...run('current', 11), extensionRequests: [] }, proper)).toBe(false);
  });
  it('draft/attachment record consumers ignore inherited prototype IDs and preserve their own data', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(getSessionRecord(store().drafts, id)).toBeUndefined();
      expect(getSessionRecord(store().attachments, id)).toBeUndefined();
      store().setDraft(id, 'Own draft');
      expect(getSessionRecord(store().drafts, id)).toBe('Own draft');
      store().addAttachments(id, []);
      expect(getSessionRecord(store().attachments, id)).toEqual([]);
      store().removeAttachment(id, 'missing');
      expect(getSessionRecord(store().attachments, id)).toEqual([]);
    }
  });
});

import { interactionReplyComparison } from './session-store.js';
import { isFreshInteractionSnapshot } from '../services/api.js';
describe('reply comparison before generic API freshness', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, workspace: null, sessions: [], activeSessionId: null }));
  it('passes the exact current acknowledged closure without changing generic membership or version', () => {
    const initial = run('current', 10);
    store().setRun('session', initial);
    const guard = captureInteractionReplyGuard(store(), 'session', 'current-request');
    const reply = { ...initial, extensionRequests: [] };
    const snapshot = { sessionId: 'session', lastSequence: 10, run: reply };
    expect(isFreshInteractionSnapshot(snapshot, store().runs.session, 10)).toBe(false);
    const comparison = interactionReplyComparison(store(), 'session', guard);
    expect(comparison?.lastSequence).toBe(10);
    expect(isFreshInteractionSnapshot(snapshot, comparison, 10)).toBe(true);
    expect(store().setRun('session', reply, { ...guard, snapshotSequence: 10 })).toBe(true);
    expect(store().runs.session.lastSequence).toBe(10);
  });
  it('does not project a forged, wrong-head, stale or different-session completion', () => {
    store().setRun('session', run('current', 10));
    const before = store().runs.session;
    const guard = captureInteractionReplyGuard(store(), 'session', 'current-request');
    expect(interactionReplyComparison(store(), 'session', { epoch: 0, authority: guard.authority })).toBe(before);
    expect(interactionReplyComparison(store(), 'session', captureInteractionReplyGuard(store(), 'session', 'wrong'))).toBe(before);
    expect(interactionReplyComparison(store(), 'other', guard)).toBeUndefined();
    store().setActiveSession('other');
    expect(interactionReplyComparison(store(), 'session', guard)).toBe(store().runs.session);
    store().setActiveSession(null);
    store().setRun('session', run('current', 11));
    expect(interactionReplyComparison(store(), 'session', guard)).toBe(store().runs.session);
  });
  it('does not make reordered, invented, stale-version or stale-watermark snapshots fresh', () => {
    const initial = { ...run('current', 10), extensionRequests: [run('current',10).extensionRequests![0], { ...run('current',10).extensionRequests![0], id:'next' }, { ...run('current',10).extensionRequests![0], id:'last' }] };
    store().setRun('session', initial);
    const guard = captureInteractionReplyGuard(store(), 'session', 'current-request');
    const comparison = interactionReplyComparison(store(), 'session', guard);
    for (const rows of [[initial.extensionRequests[2], initial.extensionRequests[1]], [{ ...initial.extensionRequests[1], id:'invented' }]])
      expect(isFreshInteractionSnapshot({ sessionId:'session', lastSequence:10, run:{ ...initial, extensionRequests:rows } }, comparison,10)).toBe(false);
    expect(isFreshInteractionSnapshot({ sessionId:'session', lastSequence:9, run:{ ...initial, lastSequence:9, extensionRequests:initial.extensionRequests.slice(1) } }, comparison,10)).toBe(false);
    expect(isFreshInteractionSnapshot({ sessionId:'session', lastSequence:10, run:{ ...initial, extensionRequests:initial.extensionRequests.slice(1) } }, comparison,11)).toBe(false);
  });
});
