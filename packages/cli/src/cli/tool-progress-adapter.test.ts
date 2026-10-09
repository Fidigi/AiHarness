import { describe, expect, it } from 'vitest';
import type { ToolProgressSnapshot } from '@ai-harness/core';
import { JsonEventStream, toJsonProtocolMessage } from './json-output.js';

const progress: ToolProgressSnapshot = { version: 1, toolCallId: 'outer', toolName: 'hosted', sequence: 4,
  status: 'running', durationMs: 12, content: 'partial:😀', details: { step: 4, usage: { costUsd: 99 } },
  truncated: false, omittedUpdates: 2 };

describe('shared JSON/RPC arbitrary progress adapter', () => {
  it('returns the writer Promise so the loop cannot overtake blocked output', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const records: unknown[] = [];
    const events = new JsonEventStream(async record => { records.push(record); await gate; });
    let done = false;
    const write = events.toolProgress(progress).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(records).toEqual([{ type: 'tool_execution_update', toolCallId: 'outer', toolName: 'hosted',
      partialResult: { content: [{ type: 'text', text: 'partial:😀' }], details: { toolProgress: progress } } }]);
    release(); await write; expect(done).toBe(true);
  });

  it('projects persisted terminal details under their inert namespace without treating them as usage', () => {
    const terminal = { ...progress, status: 'cancelled' as const, sequence: 5 };
    const replay = toJsonProtocolMessage({ id: 'result', timestamp: new Date(0), role: 'tool', toolCallId: 'outer',
      name: 'hosted', content: 'Tool execution interrupted.', isError: true,
      metadata: { interrupted: true, toolProgress: terminal } });
    expect(replay).toEqual({ role: 'toolResult', toolCallId: 'outer', toolName: 'hosted',
      content: [{ type: 'text', text: 'Tool execution interrupted.' }],
      details: { interrupted: true, toolProgress: terminal }, isError: true, timestamp: 0 });
    expect(replay.usage).toBeUndefined();
  });
});
