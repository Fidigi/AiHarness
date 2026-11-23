import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunSnapshot } from '@ai-harness/core';
import { canSyncCanonicalSession, captureCanonicalRunGuard, useSessionStore } from './session-store.js';

const run = (sequence: number, id = 'run', phase: AgentRunSnapshot['phase'] = 'streaming'): AgentRunSnapshot => ({
  id, sessionId: 'session', cwd: '/workspace', workspaceId: 'workspace', provider: 'mock', phase,
  lastSequence: sequence, steerQueue: [], followUpQueue: [], extensionRequests: [],
});
const store = () => useSessionStore.getState();
const snapshot = (sequence: number, id = 'run', phase: AgentRunSnapshot['phase'] = 'streaming') => ({
  sessionId: 'session', session: { id: 'session', cwd: '/workspace' }, lastSequence: sequence, run: run(sequence, id, phase),
});
describe('canonical transcript ownership is separate from run setter admission', () => {
  beforeEach(() => useSessionStore.setState({ runs: {}, runAuthorities: {}, runEpoch: 0, activeSessionId: 'session',
    workspace: { id: 'workspace', cwd: '/workspace', name: 'Workspace', trusted: true } }));
  it('publishes a current same-run transcript after SSE advances the captured authority, without admitting its queue', () => {
    store().setRun('session', run(10));
    const guard = captureCanonicalRunGuard(store(), 'session');
    store().setRun('session', run(17));
    const before = store();
    expect(store().setRun('session', run(17), guard)).toBe(false);
    expect(canSyncCanonicalSession(store(), 'session', snapshot(17), guard, 17)).toBe(true);
    expect(store()).toBe(before);
    expect(canSyncCanonicalSession(store(), 'session', snapshot(16), guard, 17)).toBe(false);
  });
  it('permits only a known terminal transcript after polling clears its run, never resurrection', () => {
    store().setRun('session', run(10));
    const guard = captureCanonicalRunGuard(store(), 'session');
    expect(store().setRun('session', undefined, { epoch: 0, authority: store().runAuthorities.session, absenceSequence: 20 })).toBe(true);
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20, 'run', 'completed'), guard, 20)).toBe(true);
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20), guard, 20)).toBe(false);
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20, 'foreign', 'completed'), guard, 20)).toBe(false);
    expect(store().runs.session).toBeUndefined();
  });
  it('rejects stale, foreign, replaced-run and literal capabilities even with a high sequence', () => {
    store().setRun('session', run(10));
    const guard = captureCanonicalRunGuard(store(), 'session');
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20), { epoch: 0, canonical: true }, 10)).toBe(false);
    expect(canSyncCanonicalSession(store(), 'session', { ...snapshot(20), sessionId: 'other' }, guard, 10)).toBe(false);
    expect(canSyncCanonicalSession(store(), 'session', { ...snapshot(20), session: { id: 'other', cwd: '/workspace' } }, guard, 10)).toBe(false);
    expect(canSyncCanonicalSession(store(), 'session', { ...snapshot(20), session: { id: 'session', cwd: '/other' } }, guard, 10)).toBe(false);
    store().setRun('session', run(11, 'replacement'));
    expect(canSyncCanonicalSession(store(), 'session', snapshot(1000), guard, 0)).toBe(false);
  });
  it('binds the private transcript witness to its session and collection generation', () => {
    store().setRun('session', run(10));
    const guard = captureCanonicalRunGuard(store(), 'session');
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20), captureCanonicalRunGuard(store(), 'other'), 0)).toBe(false);
    for (let i = 0; i < 256; i++) store().setRun('other-' + i, { ...run(i + 20, 'other-' + i), sessionId: 'other-' + i });
    expect(canSyncCanonicalSession(store(), 'session', snapshot(1000), guard, 0)).toBe(false);
  });
  it('retires reads on deletion, active-session change and workspace epoch even across address ABA', () => {
    store().setRun('session', run(10));
    const guard = captureCanonicalRunGuard(store(), 'session');
    store().setActiveSession('other');
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20), guard, 0)).toBe(false);
    store().setActiveSession('session');
    useSessionStore.setState({ runEpoch: 1 });
    expect(canSyncCanonicalSession(store(), 'session', snapshot(20), guard, 0)).toBe(false);
    useSessionStore.setState({ runEpoch: 0 });
    store().removeSession('session');
    expect(canSyncCanonicalSession(store(), 'session', snapshot(1000), guard, 0)).toBe(false);
  });
});
