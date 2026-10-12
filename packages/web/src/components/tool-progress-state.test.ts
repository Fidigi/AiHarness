import { describe, expect, it, vi } from 'vitest';
import type { ActiveToolSnapshot, ToolProgressSnapshot } from '@ai-harness/core';
import { applyCodemodeProgress, codemodeDetails } from './codemode-state';
import { applyToolProgress, normalizeToolProgress, toolProgressDetailsText } from './tool-progress-state';

const tool: ActiveToolSnapshot = { id: 'outer', name: 'custom_work', input: {}, startedAt: '2026-10-01T00:00:00Z' };
const progress: ToolProgressSnapshot = { version: 1, toolCallId: 'outer', toolName: 'custom_work', sequence: 4,
  status: 'running', durationMs: 240, truncated: false, omittedUpdates: 2, content: 'Scanning', details: { phase: 'scan', count: 4 } };
const event = { kind: 'tool', ...progress };

describe('browser-safe arbitrary tool progress', () => {
  it('normalizes the same public snapshot shape for start/latest/reconnect and durable terminal metadata', () => {
    expect(normalizeToolProgress(progress, tool.id, tool.name)).toEqual(progress);
    expect(applyToolProgress(tool, event)?.progress).toEqual(progress);
    const terminal = { ...progress, status: 'completed', sequence: 5, durationMs: 300 };
    expect(normalizeToolProgress(terminal, tool.id, tool.name)).toEqual(terminal);
    expect(normalizeToolProgress({ ...progress, content: '', details: null }, tool.id, tool.name))
      .toMatchObject({ content: '', details: null });
    expect(normalizeToolProgress({ ...progress, content: undefined, details: undefined }, tool.id, tool.name))
      .not.toHaveProperty('details');
    expect(normalizeToolProgress(undefined, tool.id, tool.name)).toBeUndefined();
    expect(toolProgressDetailsText({ ...progress, details: null })).toBe('');
  });
  it('never starts tools, promotes nested IDs, crosses siblings or resurrects removed/terminal state', () => {
    expect(applyToolProgress(undefined, event)).toBeUndefined(); // authoritative empty snapshot
    for (const value of [{ ...event, parentId: tool.id }, { ...event, toolCallId: 'outer:1' },
      { ...event, toolName: 'sibling' }, { ...event, kind: 'codemode' }, { ...event, status: 'completed' }]) {
      expect(applyToolProgress(tool, value)).toBe(tool);
    }
    const first = applyToolProgress(tool, event)!;
    expect(applyToolProgress(first, event)).toBe(first);
    expect(applyToolProgress(first, { ...event, sequence: 3 })).toBe(first);
    expect(applyToolProgress(first, { ...event, sequence: 5, durationMs: 239 })).toBe(first);
    const next = applyToolProgress(first, { ...event, sequence: 9, durationMs: 400, content: '', details: null })!;
    expect(next.progress).toMatchObject({ content: '', details: null, sequence: 9, durationMs: 400 });
    const stopped = { ...next, progress: { ...next.progress!, status: 'cancelled' as const } };
    expect(applyToolProgress(stopped, { ...event, sequence: 10, durationMs: 500 })).toBe(stopped);
    // A replaced invocation/epoch has no parallel cache, and cannot restore an old call.
    expect(applyToolProgress({ ...tool, id: 'new-invocation' }, event)?.progress).toBeUndefined();
  });
  it('fails safely for unknown versions, identity mismatch and malformed finite required fields', () => {
    for (const patch of [{ version: 2 }, { version: '1' }, { sequence: NaN }, { sequence: 0 }, { sequence: 1.5 },
      { sequence: Infinity }, { durationMs: -1 }, { durationMs: Infinity }, { durationMs: NaN },
      { durationMs: Number.MAX_VALUE }, { omittedUpdates: -1 }, { omittedUpdates: 1.5 }, { truncated: 'false' },
      { content: {} }, { status: 'activating' }, { toolCallId: 'other' }, { toolName: 'other' }]) {
      expect(normalizeToolProgress({ ...progress, ...patch }, tool.id, tool.name)).toBeUndefined();
    }
    expect(normalizeToolProgress({ ...progress, toolCallId: 'x'.repeat(513) }, 'x'.repeat(513), tool.name)).toBeUndefined();
    expect(normalizeToolProgress({ ...progress, toolName: 'bad\u202ename' }, tool.id, 'bad\u202ename')).toBeUndefined();
  });
  it('does not invoke getters/toJSON, inherited fields or retain references', () => {
    const getter = vi.fn(() => { throw new Error('must not run'); });
    const hostile = { safe: 'ok', get secret() { return getter(); }, toJSON: getter, nested: { n: 1 } };
    const normalized = normalizeToolProgress({ ...progress, details: hostile }, tool.id, tool.name)!;
    hostile.nested.n = 99;
    expect(normalized.details).toEqual({ safe: 'ok', nested: { n: 1 } });
    expect(normalized.truncated).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(normalizeToolProgress({ ...progress, get version() { return getter(); } }, tool.id, tool.name)).toBeUndefined();
    expect(toolProgressDetailsText({ ...progress, get toolCallId() { return getter(); } })).toBe('');
    expect(getter).not.toHaveBeenCalled();
    expect(normalizeToolProgress(Object.create(progress), tool.id, tool.name)).toBeUndefined();
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(normalizeToolProgress(revoked.proxy, tool.id, tool.name)).toBeUndefined();
  });
  it('bounds malicious strings, details depth/nodes/bytes, cycles, sparse arrays and accessor floods', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [deep, cycle, '😀'.repeat(1_000_000), Array(1000).fill('"'.repeat(1000)), Array(0xffff_ffff)]) {
      const normalized = normalizeToolProgress({ ...progress, details: value }, tool.id, tool.name)!;
      expect(normalized.truncated).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(normalized.details)).length).toBeLessThanOrEqual(8192);
      expect(toolProgressDetailsText(normalized)).not.toContain('too deep');
    }
    const normalized = normalizeToolProgress({ ...progress, content: '😀'.repeat(1_000_000) }, tool.id, tool.name)!;
    expect(new TextEncoder().encode(normalized.content).length).toBeLessThanOrEqual(16_384);
    expect(normalized.content).not.toContain('\uFFFD');
    const getter = vi.fn();
    const flood: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) Object.defineProperty(flood, String(i), { enumerable: true, get: getter });
    flood.after = 'not scanned';
    expect(normalizeToolProgress({ ...progress, details: flood }, tool.id, tool.name)?.details).toEqual({});
    expect(getter).not.toHaveBeenCalled();
    const sparse: unknown[] = Array(3); sparse[1] = 'second';
    expect(normalizeToolProgress({ ...progress, details: sparse }, tool.id, tool.name)?.details).toEqual([null, 'second', null]);
  });
  it('keeps fake usage/cost/activation/store fields inert in details only', () => {
    const fake = { usage: { costUsd: 999, totalTokens: 999 }, activatedTools: ['hidden'], store: { hacked: true },
      toolCallId: 'nested', codemode: { nestedCalls: [{ id: 'nested' }] } };
    const normalized = applyToolProgress(tool, { ...event, details: fake })!;
    expect(normalized.progress?.details).toEqual(fake);
    expect(normalized).not.toHaveProperty('usage');
    expect(normalized).not.toHaveProperty('nestedCalls');
    expect(Object.keys(normalized.progress!).sort()).toEqual(Object.keys(progress).sort());
  });
  it('leaves legacy tools and specialized code-mode cards/accounting unchanged', () => {
    expect(applyToolProgress(tool, {})).toBe(tool);
    const codeTool = { ...tool, name: 'codemode' };
    const call = { id: 'outer:1', parentId: 'outer', name: 'read', kind: 'tool', state: 'running', isError: false };
    const codeEvent = { kind: 'codemode', parentId: 'outer', call };
    expect(applyToolProgress(codeTool, { ...event, toolName: 'codemode' })).toBe(codeTool);
    expect(applyToolProgress(codeTool, codeEvent)).toBe(codeTool);
    expect(applyCodemodeProgress(codeTool, codeEvent)?.nestedCalls).toEqual([call]);
    const metadata = { engine: 'QuickJS', parentId: 'outer', durationMs: 400, costComplete: true,
      nestedCalls: [call], usage: { costUsd: .002 } };
    expect(codemodeDetails(metadata, tool.id)).toBe(metadata);
    expect(codemodeDetails({ details: metadata }, tool.id)).toBeUndefined();
  });
});
