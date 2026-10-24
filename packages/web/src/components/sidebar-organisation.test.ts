import { describe, expect, it } from 'vitest';
import type { AgentRunSnapshot, SidebarState } from '@ai-harness/core';
import type { StoredSession } from '../store/session-store.js';
import { organisedSessions, sidebarFamilyId } from './sidebar-organisation.js';

const session = (id: string, branchId?: string): StoredSession => ({ id, branchId, messages: [], createdAt: new Date(), updatedAt: new Date() });
const state: SidebarState = { version: 1, revision: 'r', families: [{ id: 'root', pinned: true, archived: true }], projects: [] };
const sessions = [session('other'), session('root'), session('fork', 'root'), session('clone')];
const ids = (values: StoredSession[]) => values.map(item => item.id);

describe('sidebar family and archive presentation', () => {
  it('shares fork pins/archive, not independent copies, without mutating original session order', () => {
    expect(sidebarFamilyId(sessions[2]!)).toBe('root'); expect(sidebarFamilyId(sessions[3]!)).toBe('clone');
    expect(ids(organisedSessions(sessions, {}, state, false))).toEqual(['other', 'clone']);
    expect(ids(organisedSessions(sessions, {}, state, true))).toEqual(['root', 'fork', 'other', 'clone']);
    expect(ids(sessions)).toEqual(['other', 'root', 'fork', 'clone']);
  });
  it.each(['starting', 'running', 'waiting', 'retrying', 'compacting', 'stopping'])('never hides a family with a %s run', phase => {
    const runs = { fork: { phase } as AgentRunSnapshot };
    expect(ids(organisedSessions(sessions, runs, state, false))).toContain('root');
    expect(ids(organisedSessions(sessions, runs, state, false))).toContain('fork');
  });
  it.each(['completed', 'failed', 'stopped'])('allows an inactive %s run to remain archived', phase => {
    expect(ids(organisedSessions(sessions, { fork: { phase } as AgentRunSnapshot }, state, false))).not.toContain('fork');
  });
  it('keeps selected, attention and draft families reachable, including missing roots', () => {
    expect(ids(organisedSessions(sessions, {}, state, false, 'fork'))).toContain('root');
    expect(ids(organisedSessions([{ ...session('fork', 'root'), attention: true }], {}, state, false))).toEqual(['fork']);
    const draft = { ...session('draft:x'), draft: true };
    expect(organisedSessions([draft], {}, state, false)).toEqual([draft]);
  });
  it('keeps native order when state is unavailable and never lets archive remove history', () => {
    expect(organisedSessions(sessions, {}, undefined, false)).toEqual(sessions);
    expect(sessions).toHaveLength(4);
  });
});
