import { describe, expect, it } from 'vitest';
import type { ActiveToolSnapshot, CodemodeCall } from '@ai-harness/core';
import { applyCodemodeProgress, codemodeDetails } from './codemode-state';

const call: CodemodeCall = { id: 'outer:1', parentId: 'outer', name: 'read', kind: 'tool', state: 'running', isError: false };
const tool: ActiveToolSnapshot = { id: 'outer', name: 'codemode', input: { code: 'await tools.read({});' }, startedAt: '2026-10-09T00:00:00Z' };
describe('nested progress normalization', () => {
  it('cannot create top-level tools, cross parents, resurrect completion or duplicate replay', () => {
    const event = { kind: 'codemode', parentId: 'outer', call };
    expect(applyCodemodeProgress(undefined, event)).toBeUndefined();
    expect(applyCodemodeProgress({ ...tool, name: 'read' }, event)?.name).toBe('read');
    expect(applyCodemodeProgress(tool, { ...event, parentId: 'foreign' })).toBe(tool);
    const running = applyCodemodeProgress(tool, event)!;
    expect(running.id).toBe('outer'); expect(running.name).toBe('codemode');
    const completed = applyCodemodeProgress(running, { ...event, call: { ...call, state: 'completed' } })!;
    expect(applyCodemodeProgress(completed, event)).toBe(completed);
    expect(completed.nestedCalls).toHaveLength(1);
    for (const id of ['other:1', 'outer:0', 'outer:65', 'outer:-1', 'outer:1:2', 'outer:forged']) {
      expect(applyCodemodeProgress(tool, { ...event, call: { ...call, id } })).toBe(tool);
    }
  });
  it('bounds lists and falls back for legacy/foreign/duplicate/malformed metadata', () => {
    const metadata = { engine: 'QuickJS', parentId: 'outer', durationMs: 1, costComplete: false, nestedCalls: [call] };
    expect(codemodeDetails(metadata, 'outer')).toEqual(metadata);
    for (const value of [{ engine: 'QuickJS', nestedCalls: [{ name: 'read' }] }, { ...metadata, parentId: 'other' },
      { ...metadata, durationMs: NaN }, { ...metadata, nestedCalls: [call, call] }, { ...metadata, nestedCalls: Array(65).fill(call) }]) {
      expect(codemodeDetails(value, 'outer')).toBeUndefined();
    }
    const full = { ...tool, nestedCalls: Array.from({ length: 64 }, (_, i) => ({ ...call, id: `outer:${i + 1}` })) };
    expect(applyCodemodeProgress(full, { kind: 'codemode', parentId: 'outer', call: { ...call, id: 'outer:65' } })).toBe(full);
  });
});
