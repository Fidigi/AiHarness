import { serializeSession, type AgentRunSnapshot, type Session } from '@ai-harness/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from './session-store';

const date = new Date('2026-10-13T12:00:00Z');
function fixture(): Session {
  return {
    id: 'normalized', schemaVersion: 2, cwd: '/workspace', workspaceId: 'workspace',
    createdAt: date, updatedAt: date, activeLeafId: 'command', model: 'model', thinking: 'high',
    autoCompaction: true, toolPreset: 'read-only', usage: { totalTokens: 7, costUsd: 0.001 },
    providerConfig: { type: 'openai', model: 'model', apiKey: 'disposable-normalization-secret' },
    metadata: { contextEdit: { summary: 'Earlier context', firstKeptEntryId: 'call' }, custom: ['opaque', { visible: true }] },
    messages: [
      { id: 'prompt', role: 'user', timestamp: date, content: 'Inspect', blocks: [
        { type: 'text', text: 'Inspect' }, { type: 'image', mediaType: 'image/png', url: '/attachment', name: 'image.png' },
      ] },
      { id: 'call', role: 'assistant', timestamp: date, content: '', parentMessageId: 'prompt',
        toolCalls: [{ id: 'outer', name: 'codemode', input: { code: 'text(await tools.read({path:"x"}));' } }],
        blocks: [{ type: 'reasoning', text: 'Inspect carefully' },
          { type: 'tool_call', id: 'outer', name: 'codemode', input: { code: 'text(await tools.read({path:"x"}));' } }] },
      { id: 'result', role: 'tool', timestamp: date, content: 'bounded', name: 'codemode', toolCallId: 'outer',
        parentMessageId: 'call', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, costUsd: 0.001 },
        blocks: [{ type: 'tool_result', toolCallId: 'outer', content: 'bounded', fullContent: 'Full native output', truncated: true }],
        metadata: { codemode: { engine: 'QuickJS', parentId: 'outer', costComplete: false, durationMs: 12,
          nestedCalls: [{ id: 'outer:1', parentId: 'outer', name: 'read', kind: 'tool', state: 'completed', isError: false,
            usage: { totalTokens: 7, costUsd: 0.001 } }] } } },
    ],
    commands: [{ id: 'command', timestamp: date, parentEntryId: 'result', command: 'printf evidence', cwd: '/workspace',
      status: 'completed', output: 'evidence', excludedFromContext: true, durationMs: 4, exitCode: 0 }],
  };
}

beforeEach(() => useSessionStore.setState({ sessions: [], activeSessionId: null, runs: {}, runAuthorities: {}, runEpoch: 0 }));
describe('owned server/client normalization', () => {
  it('round-trips native rich prompt/context/command/nested accounting without promoting children or leaking provider secrets', () => {
    const wire = JSON.parse(JSON.stringify(serializeSession(fixture()))) as ReturnType<typeof serializeSession>;
    useSessionStore.getState().syncSession(wire);
    const stored = useSessionStore.getState().sessions[0]!;
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.messages.every(message => message.timestamp instanceof Date)).toBe(true);
    expect(stored.commands![0]!.timestamp).toBeInstanceOf(Date);
    expect(serializeSession(stored)).toEqual(wire);
    expect(stored.messages).toHaveLength(3);
    expect(stored.usage).toEqual({ totalTokens: 7, costUsd: 0.001 });
    expect(JSON.stringify(stored)).not.toContain('disposable-normalization-secret');
    const accepted = structuredClone(serializeSession(stored));
    wire.messages[1]!.toolCalls![0]!.name = 'forged';
    wire.messages[2]!.usage!.costUsd = 999;
    (wire.metadata!.custom as unknown[]).push('late mutation');
    wire.commands![0]!.output = 'forged';
    expect(serializeSession(stored)).toEqual(accepted);
  });

  it('detaches paged rich records while retaining loaded ordering and stable entry identities', () => {
    const wire = serializeSession(fixture());
    const page = { start: 2, end: 3, total: 3, revision: 3, hasMoreBefore: true, hasMoreAfter: false };
    useSessionStore.getState().syncSession({ ...wire, messages: wire.messages.slice(2), messagePage: page });
    const head = wire.messages.slice(0, 2);
    useSessionStore.getState().mergeMessagePage(wire.id, { ...page, start: 0, end: 2, hasMoreBefore: false,
      hasMoreAfter: true, messages: head });
    head[1]!.toolCalls![0]!.name = 'changed after admission';
    const stored = useSessionStore.getState().sessions[0]!;
    expect(stored.messages.map(message => message.id)).toEqual(['prompt', 'call', 'result']);
    expect(stored.messages[1]!.toolCalls![0]!.name).toBe('codemode');
    expect(stored.messagePage!.loadedRanges).toEqual([{ start: 0, end: 3 }]);
    expect(stored.usage!.costUsd).toBe(0.001);
  });

  it('detaches queued prompts, nested progress and ordered UI schemas without bypassing run/sequence fences', () => {
    const run: AgentRunSnapshot = {
      id: 'run', sessionId: 'normalized', cwd: '/workspace', provider: 'mock', phase: 'tool', lastSequence: 12,
      activeTool: { id: 'outer', name: 'codemode', input: { code: 'text(1)' }, startedAt: date.toISOString(),
        nestedCalls: [{ id: 'outer:1', parentId: 'outer', name: 'read', kind: 'tool', state: 'running', isError: false }] },
      extensionRequests: [{ id: 'dialog', kind: 'select', title: 'Actual schema', createdAt: date.toISOString(),
        options: [{ value: 'yes', label: 'Yes' }] }],
      steerQueue: [{ id: 'queued', kind: 'steer', content: 'next prompt', createdAt: date.toISOString(),
        blocks: [{ type: 'text', text: 'next prompt' }] }], followUpQueue: [],
    };
    expect(useSessionStore.getState().setRun(run.sessionId, run)).toBe(true);
    const accepted = JSON.stringify(useSessionStore.getState().runs.normalized);
    run.activeTool!.nestedCalls![0]!.state = 'completed';
    run.extensionRequests![0]!.options![0]!.label = 'forged';
    run.steerQueue[0]!.blocks!.push({ type: 'text', text: 'forged' });
    expect(JSON.stringify(useSessionStore.getState().runs.normalized)).toBe(accepted);
    expect(useSessionStore.getState().setRun(run.sessionId, { ...run, lastSequence: 11, phase: 'completed' })).toBe(false);
    expect(JSON.stringify(useSessionStore.getState().runs.normalized)).toBe(accepted);
  });
});
