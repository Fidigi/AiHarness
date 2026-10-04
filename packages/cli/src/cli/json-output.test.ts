import { describe, expect, it } from 'vitest';
import { JsonEventStream, toJsonProtocolMessage } from './json-output.js';

describe('JsonEventStream', () => {
  it('projects normalized persisted usage with shared model pricing', () => {
    expect(toJsonProtocolMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done',
      timestamp: new Date(0),
      provider: 'openai',
      model: 'o3',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000,
        totalTokens: 1_700_000,
      },
    })).toMatchObject({
      usage: {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 200_000,
        totalTokens: 1_700_000,
        cost: { input: 2, output: 4, cacheRead: 0.1, total: 6.1 },
      },
    });
  });

  it('does not invent zero prices for unknown models', () => {
    const message = toJsonProtocolMessage({
      id: 'assistant-unknown',
      role: 'assistant',
      content: 'Done',
      timestamp: new Date(0),
      provider: 'custom',
      model: 'unknown-model',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });

    expect(message.usage).toMatchObject({ input: 10, output: 2, totalTokens: 12 });
    expect((message.usage as Record<string, unknown>).cost).toBeUndefined();
  });

  it('encodes streaming assistant and tool lifecycle events without cumulative partials', () => {
    const records: Array<Record<string, unknown>> = [];
    const stream = new JsonEventStream(record => records.push(record));
    stream.sessionHeader({ id: 'session-1', createdAt: new Date('2026-01-02T03:04:05.000Z') }, '/workspace');
    stream.startAgent('inspect', [{ type: 'text', text: 'inspect' }]);
    stream.startTurn();
    stream.startAssistant('openai', 'gpt-test');
    stream.reasoningDelta('check');
    stream.textDelta('done');
    stream.finishAssistant({
      content: 'done',
      reasoning: 'check',
      model: 'gpt-test',
      toolCalls: [{ id: 'call-1', name: 'read', input: { path: 'README.md' } }],
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, costUsd: 0.01 },
    });
    const result = {
      call: { id: 'call-1', name: 'read', input: { path: 'README.md' } },
      content: 'contents',
      isError: false,
      durationMs: 5,
      truncated: false,
    };
    stream.toolExecutionStart(result.call);
    stream.toolExecutionUpdate(result.call, 'partial');
    stream.toolExecutionEnd(result);
    stream.endTurn();
    stream.endAgent();

    expect(records[0]).toEqual({
      type: 'session',
      version: 3,
      id: 'session-1',
      timestamp: '2026-01-02T03:04:05.000Z',
      cwd: '/workspace',
    });
    expect(records.slice(1, 5).map(record => record.type)).toEqual([
      'agent_start', 'turn_start', 'message_start', 'message_end',
    ]);
    expect(records).toContainEqual(expect.objectContaining({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 2,
        id: 'call-1',
        toolName: 'read',
      },
    }));
    expect(records).toContainEqual(expect.objectContaining({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: { content: [{ type: 'text', text: 'partial' }], details: {} },
    }));
    expect(records).toContainEqual(expect.objectContaining({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      isError: false,
    }));
    const updates = records.filter(record => record.type === 'message_update');
    expect(updates.every(record => !('message' in record))).toBe(true);
    expect(updates.every(record => !('partial' in (record.assistantMessageEvent as object)))).toBe(true);
    expect(records.at(-2)).toMatchObject({ type: 'agent_end', willRetry: false });
    expect(records.at(-1)).toEqual({ type: 'agent_settled' });
    expect(() => records.map(record => JSON.stringify(record))).not.toThrow();
  });

  it('encodes retry and compaction lifecycle records', () => {
    const records: Array<Record<string, unknown>> = [];
    const stream = new JsonEventStream(record => records.push(record));
    stream.retryStart(1, 3, 500, new Error('overloaded'));
    stream.retryEnd(true, 2);
    stream.summarizationRetryScheduled(1, 3, 2_000, new Error('terminated'));
    stream.summarizationRetryAttemptStart('compaction', 'threshold');
    stream.summarizationRetryFinished();
    stream.compactionStart('threshold');
    stream.compactionEnd('threshold', {
      result: { summary: 'Context', firstKeptEntryId: 'entry-2' },
    });

    expect(records).toEqual([
      {
        type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 500,
        errorMessage: 'overloaded',
      },
      { type: 'auto_retry_end', success: true, attempt: 2 },
      {
        type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 2_000,
        errorMessage: 'terminated',
      },
      { type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'threshold' },
      { type: 'summarization_retry_finished' },
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end', reason: 'threshold',
        result: { summary: 'Context', firstKeptEntryId: 'entry-2' },
        aborted: false, willRetry: false,
      },
    ]);
  });

  it('closes a failed assistant response and settles the run', () => {
    const records: Array<Record<string, unknown>> = [];
    const stream = new JsonEventStream(record => records.push(record));
    stream.startAgent('fail', undefined);
    stream.startTurn();
    stream.startAssistant('mock', 'mock-model');
    stream.textDelta('partial');
    stream.finishAssistantError(new Error('provider failed'));
    stream.failAgent(new Error('provider failed'));

    const assistantEnd = records.find(record => record.type === 'message_end'
      && (record.message as { role?: string } | undefined)?.role === 'assistant');
    expect(assistantEnd).toMatchObject({
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'provider failed',
      },
    });
    expect(records.at(-1)).toEqual({ type: 'agent_settled' });
  });
});
