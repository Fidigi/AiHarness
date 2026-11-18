import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type AnthropicChatOptions, type ChatOptions, type ChatResponse } from './index.js';
import type { Message } from '../types/index.js';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { deserializeSession, serializeSession, serializeSessionForExport } from '../sessions/serialization.js';
import { getCompactionModelMessages } from '../sessions/compaction-model-messages.js';
import { getSummaryModelMessages } from '../sessions/summary-model-messages.js';
import { CredentialRedactor } from './credentials.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { captureNativeOutputBudget, ProviderOutputBudgetError } from './provider-output-budget.js';
import { getProviderPublishedModels, getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels, PUBLISHED_THINKING_LEVELS, type PublishedThinkingLevel } from './model-metadata.js';

const bytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-reference.json', import.meta.url));
const pin = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-reference.json', import.meta.url), 'utf8'));
const toolBytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-tool-schema-reference.json', import.meta.url));
const toolFixture = JSON.parse(toolBytes.toString()) as {
  catalogueSha256: string; requests: number; callerDeclarations: number; capturedDeferredDeclarations: number;
  rows: Array<{ model: string; case: string; tools: NonNullable<ChatOptions['tools']>;
    callerDeclarations: Array<Record<string, unknown>> | null; capturedRequestTools: Array<Record<string, unknown>> | null;
    capturedDeferredDeclarations: Array<Record<string, unknown>> }>;
};
interface ToolPolicyVector { model: string; case: string; tools: NonNullable<AnthropicChatOptions['tools']>; toolChoice?: AnthropicChatOptions['toolChoice'];
  refused: boolean; callerDeclarations?: Array<Record<string, unknown>> | null; toolChoiceWire?: Record<string, unknown> | null;
  capturedRequestTools?: Array<Record<string, unknown>> | null; capturedDeferredDeclarations?: Array<Record<string, unknown>>; }
const policyFixtures = ['anthropic-tool-policy-reference.json', 'anthropic-tool-schema-boundaries-reference.json'].map(name => {
  const raw = readFileSync(new URL(`../../../../tests/fixtures/${name}`, import.meta.url));
  return { bytes: raw, data: JSON.parse(raw.toString()) as { catalogueSha256: string; modelProjections: number; vectors: number;
    requests: number; refusals: number; capturedDeferredDeclarations: number; rows: ToolPolicyVector[] } };
});
const policyVectors = policyFixtures.flatMap(fixture => fixture.data.rows);
const continuationBytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-continuation-reference.json', import.meta.url));
const continuationFixture = JSON.parse(continuationBytes.toString()) as {
  pinnedCommit: string; catalogueSha256: string; modelProjections: number; replayCases: number; requests: number;
  tools: NonNullable<ChatOptions['tools']>; provided: Array<Record<string, unknown>>; suppliedEvents: Array<Record<string, unknown>>;
  rows: Array<{ model: string; api: string; firstObserved: { content: Array<
    { type: 'text'; text: string } | { type: 'thinking'; thinking: string; thinkingSignature: string; redacted?: boolean }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }> };
    projections: Array<{ case: 'same' | 'provider' | 'api' | 'model' | 'missing-api' | 'failed'; expectedReplayMessages: Array<Record<string, unknown>> }> }>;
};
const resultBytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-tool-results-reference.json', import.meta.url));
interface ToolResultVector { model: string; api: string; case: string; tools: NonNullable<ChatOptions['tools']>;
  provided: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
  historyAssistant: { provider?: string; api?: string; model?: string; providerThinkingLevel?: string };
  results: Array<{ toolCallId: string; toolName: string; isError: boolean; content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> }>;
  expectedReplayMessages: Array<Record<string, unknown>>; capturedDeferredDeclarations: Array<Array<Record<string, unknown>>>; }
const resultFixture = JSON.parse(resultBytes.toString()) as { catalogueSha256: string; modelProjections: number; vectors: number; requests: number;
  textCases: number; imageCases: number; capturedDeferredDeclarations: number; rows: ToolResultVector[] };
function resultHistory(vector: ToolResultVector, calls: NonNullable<ChatResponse['toolCalls']>): Message[] {
  const source = vector.historyAssistant;
  return [...input, { id: 'history', role: 'assistant', content: '', timestamp: new Date(0), toolCalls: calls,
    provider: source.provider === 'anthropic' ? 'operator-alias' : source.provider, model: source.model, api: source.api,
    metadata: { providerThinkingLevel: source.providerThinkingLevel } } as Message,
  ...vector.results.map((result, index): Message => ({ id: `result-${index}`, role: 'tool', timestamp: new Date(0),
    toolCallId: result.toolCallId, name: result.toolName, isError: result.isError,
    content: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    blocks: result.content.map(block => block.type === 'text' ? block : { type: 'image', url: `data:${block.mimeType};base64,${block.data}` }),
  }))];
}
function providedToolEvents(vector: ToolResultVector): Array<Record<string, unknown>> {
  return [{ type: 'message_start', message: { model: 'untrusted-response-alias', usage: observed } },
    ...vector.provided.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: { ...block, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      { type: 'content_block_stop', index },
    ]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: observed }, { type: 'message_stop' }];
}
const imageBytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-user-images-reference.json', import.meta.url));
const imageFixture = JSON.parse(imageBytes.toString()) as { catalogueSha256: string; modelProjections: number; vectors: number; freshSdkRequests: number;
  rows: Array<{ model: string; api: string; case: string; provided: { text: string; images: Array<{ mimeType: string; data: string }> };
    expectedMessages: Array<Record<string, unknown>> }> };
const profiles = Object.values(JSON.parse(bytes.toString())['anthropic-messages']) as Array<{
  id: string; name: string; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Partial<Record<PublishedThinkingLevel, string | null>>;
  compat?: { forceAdaptiveThinking?: boolean; supportsMidConvoEffort?: boolean; supportsTemperature?: boolean };
}>;
const adaptiveProfiles = profiles.filter(profile => profile.compat?.forceAdaptiveThinking && !profile.compat.supportsMidConvoEffort);
const managedProfiles = profiles.filter(profile => profile.compat?.supportsMidConvoEffort);
const numericProfiles = profiles.filter(profile => !profile.compat?.forceAdaptiveThinking && !profile.compat?.supportsMidConvoEffort);
const allocationBytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-simple-allocation-reference.json', import.meta.url));
const allocationFixture = JSON.parse(allocationBytes.toString()) as { pinnedCommit: string; requests: number; rows: Array<{
  model: string; case: string; options: ChatOptions; maxTokens: number; thinkingBudget?: number; refusedByCore: boolean;
  context: { usage?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    stale?: boolean; failed?: boolean; trailing?: string; textChars?: number; system?: string; tools?: ChatOptions['tools']; images?: number };
}> };
function allocationMessages(spec: typeof allocationFixture.rows[number]['context']): Message[] {
  const messages: Message[] = [];
  if (spec.usage !== undefined) {
    messages.push({ id: 'prior', role: 'user', content: 'prior', timestamp: new Date(spec.stale ? 2 : 0) },
      { id: 'answer', role: 'assistant', content: 'ok', timestamp: new Date(1), metadata: { outputError: spec.failed },
        usage: { totalTokens: spec.usage, inputTokens: spec.input ?? 0, outputTokens: spec.output ?? 0,
          cacheReadTokens: spec.cacheRead ?? 0, cacheWriteTokens: spec.cacheWrite ?? 0 } });
  }
  if (spec.usage === undefined || spec.trailing) messages.push({ id: 'user', role: 'user', timestamp: new Date(3),
    content: spec.trailing ?? 'x'.repeat(spec.textChars ?? 5),
    ...(spec.images ? { blocks: [{ type: 'image' as const, mediaType: 'image/png', url: 'data:image/png;base64,opaque' }] } : {}) });
  return messages;
}
const supported = (profile: typeof profiles[number]) => PUBLISHED_THINKING_LEVELS.filter(level =>
  profile.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
// Independent expected native efforts, in published level order; sparse xhigh clamps upward.
const efforts: Record<string, readonly (string | undefined)[]> = {
  'claude-fable-5': ['low', 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': [undefined, 'low', 'low', 'medium', 'high', 'max', 'max'],
  'claude-opus-4-7': [undefined, 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': [undefined, 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': [undefined, 'low', 'low', 'medium', 'high', 'max', 'max'],
  'claude-sonnet-5': [undefined, 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const input = [{ id: 'user', role: 'user' as const, content: 'probe', timestamp: new Date() }];
const observed = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4,
  cache_creation_input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 1 } };
afterEach(() => vi.restoreAllMocks());
function fixture(model: string, responseModel = 'untrusted-response-alias', Provider = AnthropicProvider) {
  const provider = new Provider({ type: 'operator-alias', model, apiKey: 'disposable-profile-key' });
  let usage: Record<string, unknown> = structuredClone(observed), delta: Record<string, unknown> | undefined, tool = false;
  let reply: { json: unknown; events: unknown[] } | undefined;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.stream) return new Response(JSON.stringify(reply ? reply.json : { model: responseModel,
      content: [{ type: 'text', text: 'ok' }, ...(tool ? [{ type: 'tool_use', id: 'echo-call', name: 'echo', input: {} }] : [])], stop_reason: tool ? 'tool_use' : 'end_turn', usage }));
    return new Response((reply?.events ?? [
      { type: 'message_start', message: { usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      ...(tool ? [{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'echo-call', name: 'echo', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 1 }] : []),
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: delta ?? usage },
      { type: 'message_stop' },
    ]).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const call = async (stream: boolean, retention: 'none' | 'short' | 'long' = 'short', options?: ChatOptions, messages: Message[] = input) => {
    if (!stream) return provider.chat(messages, { maxTokens: 64, cacheRetention: retention, ...options });
    let result: ChatResponse | undefined, failure: Error | undefined;
    await provider.streamChat(messages, () => {}, value => { result = value; }, error => { failure = error; },
      { maxTokens: 64, cacheRetention: retention, ...options });
    if (failure) throw failure; return result!;
  };
  return { provider, fetch, call, reply: (json: unknown, events: unknown[] = []) => { reply = { json, events }; },
    tool: (enabled: boolean) => { tool = enabled; }, usage: (value: Record<string, unknown>, next?: Record<string, unknown>) => { usage = value; delta = next; } };
}

function responseEvents(stop_reason = 'end_turn'): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { usage: observed } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'left' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'first', signature: 'opaque-signature' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'second' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'right?' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason }, usage: observed },
    { type: 'message_stop' },
  ];
}

const signedContent: Array<Record<string, unknown>> = [
  { type: 'text', text: 'left!' }, { type: 'thinking', thinking: 'firstsecond', signature: 'opaque-signature' },
  { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: 'right?' },
  { type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } },
];
function signedEvents(content: Array<Record<string, unknown>>, finish = 'end_turn'): Array<Record<string, unknown>> {
  return [{ type: 'message_start', message: { usage: observed } }, ...content.flatMap((block, index) => [
    { type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index },
  ]), { type: 'message_delta', delta: { stop_reason: finish }, usage: observed }, { type: 'message_stop' }];
}

describe('owned Anthropic response authority', () => {
  for (const profile of profiles) it(`${profile.id}: normalizes all text/thinking and accepts only successful terminal reasons`, async () => {
    const f = fixture(profile.id);
    for (const finish of ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn']) {
      f.reply({ model: 'response-alias', stop_reason: finish, usage: observed, content: [
        { type: 'text', text: 'left!' }, { type: 'thinking', thinking: 'firstsecond', signature: 'opaque-signature' },
        { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: 'right?' },
        { type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } },
      ] }, responseEvents(finish));
      for (const stream of [false, true]) {
        const result = await f.call(stream);
        expect(result).toMatchObject({ model: profile.id, api: 'anthropic-messages', content: 'left!right?',
          reasoning: 'firstsecond', toolCalls: [{ id: 'call', name: 'echo', input: { x: 1 } }] });
        expect(result.stopReason).toBe(finish === 'max_tokens' ? 'length' : undefined);
        expect(result.provider).toBe('operator-alias');
        expect(result.blocks).toEqual([
          { type: 'text', text: 'left!' }, { type: 'reasoning', text: 'firstsecond',
            thinkingSignature: stream ? 'opaque-signatureopaque-signature' : 'opaque-signature' },
          ...(!stream ? [{ type: 'reasoning', text: '[Reasoning redacted]', redacted: true, thinkingSignature: 'opaque-redacted' }] : []),
          { type: 'text', text: 'right?' }, { type: 'tool_call', id: 'call', name: 'echo', input: { x: 1 } },
        ]);
        expect(JSON.stringify({ content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls })).not.toContain('opaque-');
      }
    }
    for (const content of [[], [{ type: 'thinking', thinking: 'only-reasoning', signature: 'opaque' }]]) {
      f.reply({ content, stop_reason: 'end_turn' });
      expect(await f.call(false)).toMatchObject({ content: '', model: profile.id });
    }
    const start = f.fetch.mock.calls.length;
    for (const vector of resultFixture.rows.filter(row => row.model === profile.id)) for (const stream of [false, true]) {
      const options = { tools: vector.tools }, expected = vector.provided.map(({ id, name, input }) => ({ id, name, input }));
      f.reply({ model: 'untrusted-response-alias', content: vector.provided, stop_reason: 'tool_use' }, providedToolEvents(vector));
      const first = await f.call(stream, 'none', options);
      expect(first.toolCalls, vector.case).toEqual(expected); expect(first).toMatchObject({ model: vector.model, api: vector.api });
      const history = resultHistory(vector, first.toolCalls!), before = structuredClone({ history, options });
      f.reply({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, [
        { type: 'message_start', message: { usage: observed } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
      ]);
      const second = await f.call(stream, 'none', options, history), body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.messages, vector.case).toEqual(vector.expectedReplayMessages); // Whole array, including managed controls and any extra attributed image turn.
      expect(body.tools).toEqual([...vector.tools.map(tool => ({ name: tool.name, description: tool.description, eager_input_streaming: true,
        input_schema: { type: 'object', properties: tool.parameters.properties, required: tool.parameters.required } })), ...vector.capturedDeferredDeclarations[1]]);
      expect(body.model).toBe(vector.model); expect(second).toMatchObject({ content: 'ok', model: vector.model, api: vector.api });
      expect(second.toolCalls ?? []).toEqual([]); expect({ history, options }).toEqual(before);
    }
    expect(f.fetch.mock.calls.length - start).toBe(48);
    const imageStart = f.fetch.mock.calls.length;
    for (const vector of imageFixture.rows.filter(row => row.model === profile.id)) {
      const messages: Message[] = [{ ...input[0], content: vector.provided.text, blocks: vector.provided.images.map(image => ({
        type: 'image', url: `data:${image.mimeType};base64,${image.data}`,
      })) }], options = { maxTokens: 64, cacheRetention: 'none' as const }, before = structuredClone({ messages, options });
      for (const stream of [false, true]) {
        const result = await f.call(stream, 'none', options, messages), body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.messages, vector.case).toEqual(vector.expectedMessages); // Whole array, including existing managed controls.
        expect(body.tools).toBeUndefined(); expect(body.model).toBe(vector.model); expect(body.stream).toBe(stream);
        expect(result).toMatchObject({ content: 'ok', model: vector.model, api: vector.api });
      }
      expect({ messages, options }).toEqual(before);
    }
    expect(f.fetch.mock.calls.length - imageStart).toBe(8);
  });
  for (const profile of profiles) it(`${profile.id}: replays ordered opaque blocks only for the exact provider/API/model`, async () => {
    const f = fixture(profile.id), vector = continuationFixture.rows.find(row => row.model === profile.id)!;
    const expectedBlocks = vector.firstObserved.content.map(block => block.type === 'text' ? block
      : block.type === 'thinking' ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature,
        ...(block.redacted ? { redacted: true } : {}) }
        : { type: 'tool_call', id: block.id, name: block.name, input: block.arguments });
    const start = f.fetch.mock.calls.length;
    for (const stream of [false, true]) {
      const options = { tools: continuationFixture.tools };
      f.reply({ model: 'untrusted-response-alias', content: continuationFixture.provided, stop_reason: 'tool_use', usage: observed },
        continuationFixture.suppliedEvents);
      const received = await f.call(stream, 'none', options);
      expect(received).toMatchObject({ provider: 'operator-alias', api: vector.api, model: vector.model });
      expect(received.blocks).toEqual(expectedBlocks);
      f.reply({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, signedEvents([{ type: 'text', text: 'ok' }]));
      for (const projection of vector.projections) {
        const source: Message = { id: 'reference', role: 'assistant', content: received.content, timestamp: new Date(0),
          provider: received.provider, api: received.api, model: received.model, blocks: structuredClone(received.blocks),
          toolCalls: structuredClone(received.toolCalls), metadata: { providerThinkingLevel: received.providerThinkingLevel } };
        if (projection.case === 'provider') source.provider = 'other';
        if (projection.case === 'api') source.api = 'other-api';
        if (projection.case === 'model') source.model = 'other-model';
        if (projection.case === 'missing-api') delete source.api;
        if (projection.case === 'failed') source.metadata!.outputError = 'failed publication';
        const history: Message[] = [...input, source,
          ...(projection.case === 'failed' ? [] : [{ id: 'result', role: 'tool' as const, toolCallId: 'call', name: 'echo',
            content: 'result', isError: false, timestamp: new Date(0) }]),
          { id: 'continue', role: 'user', content: 'continue', timestamp: new Date(1) }];
        const before = structuredClone({ history, options });
        expect(await f.call(stream, 'none', options, history)).toMatchObject({ content: 'ok', model: vector.model, api: vector.api });
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.messages, `${stream}/${projection.case}`).toEqual(projection.expectedReplayMessages);
        expect(body.model).toBe(vector.model); expect(body.stream).toBe(stream);
        expect({ history, options }).toEqual(before);
        if (projection.case !== 'same') expect(JSON.stringify(body.messages)).not.toContain('opaque-');
      }
    }
    expect(f.fetch.mock.calls.length - start).toBe(14);
    for (const stream of [false, true]) {
      f.reply({ content: signedContent, stop_reason: 'tool_use', usage: observed }, signedEvents(signedContent, 'tool_use'));
      const received = await f.call(stream, 'none');
      expect(received.blocks).toHaveLength(5);
      f.reply({ content: [{ type: 'text', text: 'next' }], stop_reason: 'end_turn' }, signedEvents([{ type: 'text', text: 'next' }]));
      for (const change of ['same', 'provider', 'model', 'api', 'legacy', 'expurgated', 'failed'] as const) {
        const source: Message = { id: 'signed', role: 'assistant', content: received.content, timestamp: new Date(0),
          provider: received.provider, api: received.api, model: received.model,
          blocks: structuredClone(received.blocks), toolCalls: received.toolCalls,
          metadata: { providerThinkingLevel: received.providerThinkingLevel } };
        if (change === 'provider') source.provider = 'other';
        if (change === 'model') source.model = 'other-model';
        if (change === 'api') source.api = 'other-api';
        if (change === 'legacy') delete source.api;
        if (change === 'failed') source.metadata!.outputError = 'failed publication';
        if (change === 'expurgated') source.blocks = source.blocks!.map(block => {
          if (block.type !== 'reasoning') return block;
          const { thinkingSignature: _signature, ...visible } = block; return visible;
        });
        const history: Message[] = [...input, source,
          ...(change === 'failed' ? [] : [{ id: 'tool', role: 'tool' as const, content: 'result', timestamp: new Date(0), toolCallId: 'call' }]),
          { id: 'continue', role: 'user', content: 'continue', timestamp: new Date(1) }];
        const before = structuredClone(history);
        await f.call(stream, 'none', undefined, history);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        const assistant = body.messages.filter((message: { role: string }) => message.role === 'assistant');
        const unsigned = [{ type: 'text', text: 'left!' }, { type: 'text', text: 'firstsecond' },
          { type: 'text', text: 'right?' }, { type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }];
        expect(assistant, `${stream}/${change}`).toEqual(change === 'failed' ? [] : [{ role: 'assistant',
          content: change === 'same' ? signedContent : unsigned }]);
        expect(history).toEqual(before);
        if (change !== 'same') expect(JSON.stringify(body)).not.toContain('opaque-');
      }
      const images: Message[] = [...input, { id: 'assistant-image', role: 'assistant', content: 'caption', timestamp: new Date(0),
        provider: received.provider, model: received.model, api: received.api,
        blocks: [{ type: 'text', text: 'caption' }, { type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] },
        { ...input[0], id: 'next' }];
      const before = structuredClone(images);
      await f.call(stream, 'none', undefined, images);
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.messages.filter((message: { role: string }) => message.role === 'assistant')).toEqual([{ role: 'assistant', content: [
        { type: 'text', text: 'caption' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ] }]);
      expect(images).toEqual(before);
    }
    const headerEvents = structuredClone(continuationFixture.suppliedEvents), headerStart = f.fetch.mock.calls.length;
    (headerEvents[0].message as Record<string, unknown>).content = structuredClone(continuationFixture.provided);
    f.reply(undefined, headerEvents);
    const chunks: unknown[] = [], complete = vi.fn();
    await f.provider.streamChat(input, (text, event) => { chunks.push({ text, event }); }, complete,
      error => { throw error; }, { maxTokens: 64, cacheRetention: 'none', tools: continuationFixture.tools });
    expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0].blocks).toEqual(expectedBlocks);
    expect(JSON.stringify(chunks)).not.toContain('opaque-'); expect(f.fetch.mock.calls.length - headerStart).toBe(1);
  });
  for (const profile of profiles) it(`${profile.id}: rejects malformed/error/incomplete native responses before tools or completion`, async () => {
    const f = fixture(profile.id), content = [{ type: 'text', text: 'untrusted' }];
    for (const json of [null, [], { content }, { content, stop_reason: null },
      { content: 'SECRET', stop_reason: 'end_turn' }, { content: {}, stop_reason: 'end_turn' },
      { content, stop_reason: 'end_turn', type: 'other' }, { content, stop_reason: 'end_turn', role: 'user' },
      ...['refusal', 'sensitive', 'unknown'].map(stop_reason => ({ content, stop_reason })),
      { content, stop_reason: 'end_turn', error: { message: 'SECRET' } },
      ...[null, { type: 'text', text: 1 }, { type: 'thinking', thinking: [] },
        { type: 'thinking', thinking: '', signature: 1 }, { type: 'redacted_thinking', data: 1 },
        { type: 'tool_use', id: '', name: 'echo', input: {} }, { type: 'tool_use', id: 'x', name: '', input: {} },
        { type: 'tool_use', id: 'x', name: 'echo', input: [] }, { type: 'unknown' }]
        .map(block => ({ content: [block], stop_reason: 'end_turn' })),
    ]) {
      f.reply(json); await expect(f.call(false)).rejects.toThrow('Invalid Anthropic response.');
    }
    const events = responseEvents(), start = events[0]!;
    const malformed = [[], events.slice(0, -1), events.filter(event => event.type !== 'message_delta'),
      events.slice(1), [start, ...events], [...events, events[1]], [null], [{ type: 'message_start', message: null }],
      [start, { type: 'message_stop' }], [...events.slice(0, -1), events.at(-2), events.at(-1)],
      [{ type: 'message_start', message: { type: 'error' } }, ...events.slice(1)],
      [...events.slice(0, -3), { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '[]' } }, ...events.slice(-3)],
      [...events.slice(0, -1), events[2], events.at(-1)],
      ...['refusal', 'sensitive', 'unknown'].map(finish => responseEvents(finish)),
      [start, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 1 } }],
      [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: '', name: 'echo' } }],
      [start, { type: 'content_block_start', index: 1024, content_block: { type: 'text', text: '' } }],
      [start, { type: 'content_block_stop', index: 0 }],
      [start, events[1], events[1]],
      [start, events[1], { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SECRET' } }],
      events.filter(event => event.type !== 'content_block_stop'),
      [...events.slice(0, 4), events[2], ...events.slice(4)],
      [start, { type: 'error', error: { message: 'SECRET' } }],
    ];
    for (const records of malformed) {
      f.reply(null, records); const complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await f.provider.streamChat(input, chunk, complete, error, { maxTokens: 64 });
      expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0]?.[0].message).toBe('Invalid Anthropic response.');
      expect(complete).not.toHaveBeenCalled();
      expect(chunk.mock.calls.some(([, event]) => event?.type === 'tool_call')).toBe(false);
    }
    // Even a valid first tool is not published when a later final argument is malformed.
    f.reply(null, [...events.slice(0, -2),
      { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'bad', name: 'echo', input: {} } },
      { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{' } }, ...events.slice(-2)]);
    const complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
    await f.provider.streamChat(input, chunk, complete, error, { maxTokens: 64 });
    expect(error).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
    expect(chunk.mock.calls.some(([, event]) => event?.type === 'tool_call')).toBe(false);
  });
  for (const boundary of ['text_delta', 'tool_call']) it(`awaits ${boundary} withdrawal before later output/completion`, async () => {
    const f = fixture(profiles[0]!.id), controller = new AbortController(), complete = vi.fn(), error = vi.fn();
    f.reply(null, responseEvents()); const seen: string[] = [];
    await f.provider.streamChat(input, async (text, event) => {
      if (event?.type === 'text_delta') seen.push(text);
      if (event?.type === boundary) { await Promise.resolve(); controller.abort(); }
    }, complete, error, { signal: controller.signal, maxTokens: 64 });
    expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0].message).toBe('Anthropic request aborted.');
    expect(seen).toEqual(boundary === 'text_delta' ? ['left'] : ['left', '!', 'right?']);
  });
  it('does not grant native response/tool-declaration authority to compatible, unknown or per-call unknown models', async () => {
    class Compatible extends AnthropicProvider {}
    for (const [model, Provider, override] of [
      [profiles[0]!.id, Compatible, undefined], ['unknown-model', AnthropicProvider, undefined],
      [profiles[0]!.id, AnthropicProvider, 'unknown-model'],
    ] as const) {
      const f = fixture(model, 'legacy-response', Provider);
      f.reply({ model: 'legacy-response', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
        [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'legacy' } }]);
      const tools = toolFixture.rows.find(row => row.case === 'required-object')!.tools;
      expect((await f.call(false, 'none', { model: override, tools })).content).toBe('first');
      expect((await f.call(true, 'none', { model: override, tools })).content).toBe('legacy');
      for (const [, init] of f.fetch.mock.calls.slice(-2)) expect(JSON.parse(String(init?.body)).tools).toEqual(tools.map(tool => ({
        name: tool.name, description: tool.description, input_schema: tool.parameters,
      })));
    }
    // Scoped controls may not grant native strict/choice authority to legacy paths.
    for (const [model, Provider, override] of [[profiles[0]!.id, Compatible, undefined], ['unknown-model', AnthropicProvider, undefined],
      [profiles[0]!.id, AnthropicProvider, 'unknown-model']] as const) {
      const legacy = fixture(model, 'legacy-response', Provider), vector = policyVectors.find(row => row.case === 'prefer')!;
      for (const stream of [false, true]) {
        await legacy.call(stream, 'none', { model: override, tools: vector.tools });
        expect(JSON.parse(String(legacy.fetch.mock.calls.at(-1)?.[1]?.body)).tools).toEqual(vector.tools.map(tool => ({
          name: tool.name, description: tool.description, input_schema: tool.parameters,
        })));
        const count = legacy.fetch.mock.calls.length, required = policyVectors.find(row => row.case === 'require')!;
        await expect(legacy.call(stream, 'none', { model: override, tools: required.tools })).rejects.toThrow('Anthropic tool requires unsupported constrained sampling.');
        await expect(legacy.call(stream, 'none', { model: override, tools: vector.tools, toolChoice: 'any' } as AnthropicChatOptions)).rejects.toThrow('Invalid Anthropic tool policy.');
        expect(legacy.fetch).toHaveBeenCalledTimes(count);
      }
    }
    const f = fixture('unknown-model'), vector = toolFixture.rows.find(row => row.model === profiles[0]!.id && row.case === 'required-object')!;
    f.reply({ content: [{ type: 'text', text: 'reviewed' }], stop_reason: 'end_turn' }, responseEvents());
    for (const stream of [false, true]) {
      const options = { model: vector.model, tools: vector.tools }, before = structuredClone(options);
      expect((await f.call(stream, 'none', options)).model).toBe(vector.model);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).tools).toEqual(vector.capturedRequestTools);
      expect(options).toEqual(before);
      const strict = policyVectors.find(row => row.model === vector.model && row.case === 'require-named')!;
      await f.call(stream, 'none', { model: strict.model, tools: strict.tools, toolChoice: strict.toolChoice } as AnthropicChatOptions);
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.tools).toEqual(strict.capturedRequestTools); expect(body.tool_choice ?? null).toEqual(strict.toolChoiceWire);
    }
    // Native result projection cannot be borrowed by derived/unknown/forged public metadata.
    for (const [model, Provider, override] of [[profiles[0]!.id, Compatible, undefined], ['unknown-model', AnthropicProvider, undefined],
      [profiles[0]!.id, AnthropicProvider, 'unknown-model']] as const) {
      const legacy = fixture(model, 'legacy-response', Provider);
      legacy.provider.getPublishedModels = () => [{ id: model, name: 'Forged metadata', api: 'anthropic-messages', capabilities: { imageInput: true, toolCalls: true, reasoning: true } }];
      const vector = resultFixture.rows.find(row => row.case === 'image-success')!, history = resultHistory(vector, vector.provided);
      for (const stream of [false, true]) {
        await legacy.call(stream, 'none', { model: override }, history);
        const wire = JSON.parse(String(legacy.fetch.mock.calls.at(-1)?.[1]?.body)).messages;
        expect(wire).toHaveLength(4); expect(wire[1].content[0].id).toBe(vector.provided[0]!.id);
        expect(wire[2].content).toEqual([{ type: 'tool_result', tool_use_id: vector.provided[0]!.id, content: 'first' }]);
        expect(wire[3].content[0].text).toBe(`Tool images for ${vector.provided[0]!.id}`);
      }
    }
    const replay = resultFixture.rows.find(row => row.case === 'cross-provider')!, admitted = fixture('unknown-model');
    for (const stream of [false, true]) {
      await admitted.call(stream, 'none', { model: replay.model }, resultHistory(replay, replay.provided));
      expect(JSON.parse(String(admitted.fetch.mock.calls.at(-1)?.[1]?.body)).messages).toEqual(replay.expectedReplayMessages);
    }
    const image = imageFixture.rows.find(row => row.case === 'whitespace-image')!;
    const imageMessages: Message[] = [{ ...input[0], content: image.provided.text, blocks: image.provided.images.map(value => ({
      type: 'image', url: `data:${value.mimeType};base64,${value.data}`,
    })) }], imageBefore = structuredClone(imageMessages);
    for (const [model, Provider, override] of [[image.model, Compatible, undefined], ['unknown-model', AnthropicProvider, undefined],
      [image.model, AnthropicProvider, 'unknown-model']] as const) {
      const legacy = fixture(model, 'legacy-response', Provider);
      legacy.provider.getPublishedModels = () => [{ id: model, name: 'Forged image metadata', api: 'anthropic-messages', capabilities: { imageInput: true } }];
      for (const stream of [false, true]) {
        await legacy.call(stream, 'none', { model: override }, imageMessages);
        expect(JSON.parse(String(legacy.fetch.mock.calls.at(-1)?.[1]?.body)).messages).toEqual([{ role: 'user', content: [
          { type: 'text', text: image.provided.text }, ...image.provided.images.map(value => ({ type: 'image', source: {
            type: 'base64', media_type: value.mimeType, data: value.data,
          } })),
        ] }]);
      }
    }
    const imageOwner = fixture('unknown-model');
    for (const stream of [false, true]) {
      await imageOwner.call(stream, 'none', { model: image.model }, imageMessages);
      expect(JSON.parse(String(imageOwner.fetch.mock.calls.at(-1)?.[1]?.body)).messages).toEqual(image.expectedMessages);
    }
    expect(imageMessages).toEqual(imageBefore);
    // Core-only malformed scoped controls, not additional executed SDK vectors.
    const native = fixture(profiles[0]!.id), tools = policyVectors[0]!.tools, invalidCount = native.fetch.mock.calls.length;
    for (const options of [...[null, 'required', {}, { type: 'function', name: 'echo' }, { type: 'tool', name: '' }].map(toolChoice => ({ tools, toolChoice })),
      ...[null, true, {}, { type: 'json_schema', strict: 'sometimes' }, { type: 'grammar', variants: {} }].map(constrainedSampling => ({ tools: [{ ...tools[0], constrainedSampling }] }))]) {
      for (const stream of [false, true]) await expect(native.call(stream, 'none', options as AnthropicChatOptions)).rejects.toThrow('Invalid Anthropic tool policy.');
    }
    expect(native.fetch).toHaveBeenCalledTimes(invalidCount);
  });
});

describe('pinned original Anthropic metadata and observed accounting', () => {
  it('binds the independent seventeen-profile fixture to the approved catalogue hash', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.files.anthropic.catalogue);
    expect(profiles).toHaveLength(17);
    expect(createHash('sha256').update(continuationBytes).digest('hex')).toBe('4315d892fe5a1bbd3e40425b6e8f37ea9530220664dfe6a4dd108a8406d8cc18');
    expect(continuationFixture.pinnedCommit).toBe(pin.sourceCommit);
    expect(continuationFixture.catalogueSha256).toBe(pin.files.anthropic.catalogue);
    expect([continuationFixture.modelProjections, continuationFixture.replayCases, continuationFixture.requests]).toEqual([17, 102, 119]);
    expect(continuationFixture.rows.map(row => row.model)).toEqual(profiles.map(profile => profile.id));
    for (const row of continuationFixture.rows) expect(row.projections.map(projection => projection.case))
      .toEqual(['same', 'provider', 'api', 'model', 'missing-api', 'failed']);
    expect(createHash('sha256').update(imageBytes).digest('hex')).toBe('a0cad515444246be9718558fe308ae13f082dd0d041e914d60d76f005305ec86');
    expect(imageFixture.catalogueSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect([imageFixture.modelProjections, imageFixture.vectors, imageFixture.freshSdkRequests]).toEqual([17, 68, 68]);
    expect(imageFixture.rows.map(row => [row.model, row.case])).toEqual(profiles.flatMap(profile =>
      ['text-image', 'image-only', 'whitespace-image', 'text-two-images'].map(name => [profile.id, name])));
    expect(imageFixture.rows.flatMap(row => row.expectedMessages).filter(message => message.role === 'system')).toHaveLength(20);
    expect(createHash('sha256').update(resultBytes).digest('hex')).toBe('98be33a0685fef266d88d254a9b88d5f421a71f62ce685a32afa4d2d341e9e5c');
    expect(resultFixture.catalogueSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect([resultFixture.modelProjections, resultFixture.vectors, resultFixture.requests, resultFixture.textCases, resultFixture.imageCases,
      resultFixture.capturedDeferredDeclarations]).toEqual([17, 204, 408, 136, 68, 168]);
    expect(resultFixture.rows.map(row => [row.model, row.case])).toEqual(profiles.flatMap(profile =>
      ['success', 'error', 'empty', 'adjacent-two-results', 'cross-provider', 'cross-api', 'cross-model', 'legacy-missing-identity',
        'image-success', 'image-error', 'image-only-success', 'image-only-error'].map(name => [profile.id, name])));
    expect(resultFixture.rows.flatMap(row => row.capturedDeferredDeclarations.flat())).toHaveLength(168);
    expect(adaptiveProfiles.map(profile => profile.id).sort()).toEqual(Object.keys(efforts).sort());
    expect(createHash('sha256').update(toolBytes).digest('hex')).toBe('cb386a112bf4bfc09a3215fbb89c4f5cd66e889f6c348f55cda0c6b1c6eeb0e9');
    expect(toolFixture.catalogueSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(toolFixture.requests).toBe(68); expect(toolFixture.callerDeclarations).toBe(51); expect(toolFixture.capturedDeferredDeclarations).toBe(21);
    expect(toolFixture.rows.map(row => [row.model, row.case])).toEqual(profiles.flatMap(profile =>
      ['no-tools', 'required-object', 'optional-union', 'optional-only'].map(name => [profile.id, name])));
    for (const vector of toolFixture.rows) expect(vector.capturedRequestTools ?? []).toEqual([
      ...(vector.callerDeclarations ?? []), ...vector.capturedDeferredDeclarations,
    ]); // Whole pinned request arrays bind caller and deferred declarations together.
    expect(policyFixtures.map(fixture => createHash('sha256').update(fixture.bytes).digest('hex'))).toEqual([
      '937d8b5e70fedb26a9b1dc41e723ea7b6a7f116588d9f9c311b7f06c163a4345', '38944db3c7361faa9ff17b2d9c220eae3a5cdd7c0d6c9f1fb3e2150d43295bca',
    ]);
    expect(policyFixtures.map(fixture => [fixture.data.modelProjections, fixture.data.vectors, fixture.data.requests, fixture.data.refusals, fixture.data.capturedDeferredDeclarations]))
      .toEqual([[17, 306, 272, 34, 105], [2, 272, 172, 100, 86]]);
    expect(policyFixtures[0]!.data.rows.map(row => row.model)).toEqual(profiles.flatMap(profile => Array(18).fill(profile.id)));
    expect(policyFixtures[1]!.data.rows.map(row => row.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-4-6'].flatMap(model => Array(136).fill(model)));
    for (const fixture of policyFixtures) {
      expect(fixture.data.catalogueSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(fixture.data.rows.filter(row => row.refused)).toHaveLength(fixture.data.refusals);
      for (const vector of fixture.data.rows.filter(row => !row.refused)) expect(vector.capturedRequestTools ?? []).toEqual([
        ...(vector.callerDeclarations ?? []), ...vector.capturedDeferredDeclarations!,
      ]); // Whole pinned arrays, including all191 captured deferred placeholders, remain authoritative.
    }
  });
  for (const profile of profiles) it(profile.id, async () => {
    const f = fixture(profile.id);
    const row = getProviderPublishedModel('unrelated-alias', profile.id, f.provider);
    expect(row).toMatchObject({ id: profile.id, name: profile.name, api: 'anthropic-messages',
      contextWindow: profile.contextWindow, maxOutputTokens: profile.maxTokens,
      pricing: { inputPerMillion: profile.cost.input, outputPerMillion: profile.cost.output,
        cacheReadPerMillion: profile.cost.cacheRead, cacheWritePerMillion: profile.cost.cacheWrite } });
    for (const stream of [false, true]) for (const retention of ['short', 'long'] as const) {
      const result = await f.call(stream, retention);
      expect(result.api).toBe('anthropic-messages'); expect(result.model).toBe(profile.id); expect(result.content).toBe('ok');
      expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3, totalTokens: 14 });
      expect(result.usage?.costUsd).toBeCloseTo((5 * profile.cost.input + 2 * profile.cost.output
        + 4 * profile.cost.cacheRead + 2 * profile.cost.cacheWrite + 2 * profile.cost.input) / 1e6, 12);
    }
    expect(f.fetch).toHaveBeenCalledTimes(4);
    for (const vector of toolFixture.rows.filter(row => row.model === profile.id)) {
      const options: ChatOptions = { systemPrompt: 'owned guard', tools: vector.tools }, before = structuredClone({ options, input });
      for (const stream of [false, true]) {
        const result = await f.call(stream, 'none', options), body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        // Compare the whole Core tools array; never filter unexpected Core tools away.
        expect(body.tools ?? null).toEqual(vector.capturedRequestTools); expect(body.tool_choice).toBeUndefined();
        expect(body.model).toBe(profile.id); expect(result).toMatchObject({ content: 'ok', model: profile.id, api: 'anthropic-messages' });
      }
      expect({ options, input }).toEqual(before);
    }
    expect(f.fetch).toHaveBeenCalledTimes(12);
    for (const vector of policyVectors.filter(row => row.model === profile.id)) {
      const options: AnthropicChatOptions = { tools: vector.tools, toolChoice: vector.toolChoice }, before = structuredClone({ options, input });
      for (const stream of [false, true]) {
        const count = f.fetch.mock.calls.length;
        if (vector.refused) {
          await expect(f.call(stream, 'none', options)).rejects.toThrow('Anthropic tool requires unsupported constrained sampling.');
          expect(f.fetch).toHaveBeenCalledTimes(count);
        } else {
          const result = await f.call(stream, 'none', options), body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
          expect(body.tools ?? null, vector.case).toEqual(vector.capturedRequestTools); expect(body.tool_choice ?? null, vector.case).toEqual(vector.toolChoiceWire);
          expect(body.model).toBe(vector.model); expect(result).toMatchObject({ content: 'ok', model: profile.id, api: 'anthropic-messages' });
        }
      }
      expect({ options, input }).toEqual(before);
    }
  });
  for (const profile of profiles) it(`${profile.id}: enforces the owned output ceiling on SDK and preflight`, async () => {
    const f = fixture(profile.id), policy = captureNativeOutputBudget(f.provider)!;
    for (const maxTokens of [undefined, 1, profile.maxTokens]) {
      const options = { maxTokens }, expected = maxTokens ?? profile.maxTokens;
      const prepared = policy(options);
      expect(prepared.maxTokens).toBe(expected); expect(options).toEqual({ maxTokens });
      for (const stream of [false, true]) {
        await f.call(stream, 'short', options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.model).toBe(profile.id); expect(body.max_tokens).toBe(expected);
      }
    }
    const count = f.fetch.mock.calls.length;
    for (const value of [profile.maxTokens + 1, 0, -1, 0.5, Number.NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 1]) {
      const options = { maxTokens: value as number };
      expect(() => policy(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'short', options)).rejects.toThrow('Invalid Anthropic output limit.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  for (const profile of adaptiveProfiles) for (const [index, thinking] of PUBLISHED_THINKING_LEVELS.entries()) {
    it(`${profile.id}/${thinking}: owns adaptive wire policy without consuming numeric maps`, async () => {
      const f = fixture(profile.id), get = vi.fn(() => { throw new Error('UNUSED'); });
      const thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
      const options: ChatOptions = { thinking, thinkingBudgets, maxTokens: 64, temperature: 0.25 };
      const prepared = captureNativeOutputBudget(f.provider)!(options), effort = efforts[profile.id]![index];
      expect(prepared.maxTokens).toBe(64); expect(prepared.options.thinkingBudgets).toBe(thinkingBudgets);
      expect(getSupportedThinkingLevels('operator-alias', profile.id, undefined, f.provider)).toEqual(supported(profile));
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.model).toBe(profile.id); expect(body.max_tokens).toBe(prepared.maxTokens);
        expect(body.thinking).toEqual(effort ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' });
        expect(body.output_config).toEqual(effort ? { effort } : undefined);
        expect(body.temperature).toBe(effort || profile.compat?.supportsTemperature === false ? undefined : 0.25);
      }
      expect(get).not.toHaveBeenCalled(); expect(options).toEqual({ thinking, thinkingBudgets, maxTokens: 64, temperature: 0.25 });
      expect(Object.isFrozen(thinkingBudgets)).toBe(false);
    });
  }
  for (const profile of adaptiveProfiles) it(`${profile.id}: retains omitted thinking and uses published output defaults, rejects invalid levels before HTTP`, async () => {
    const f = fixture(profile.id), policy = captureNativeOutputBudget(f.provider)!;
    for (const thinking of [undefined, 'high', 'xhigh', 'max'] as const) {
      const options = { thinking, maxTokens: undefined, temperature: 0.25 };
      const maximum = profile.maxTokens;
      expect(policy(options).maxTokens).toBe(maximum);
      for (const stream of [false, true]) {
        await f.call(stream, 'short', options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.max_tokens).toBe(maximum);
        if (thinking === undefined) {
          expect(body.thinking).toBeUndefined(); expect(body.output_config).toBeUndefined();
          expect(body.temperature).toBe(profile.compat?.supportsTemperature === false ? undefined : 0.25);
        }
      }
    }
    const count = f.fetch.mock.calls.length;
    for (const thinking of [null, 'HIGH', 'fake', 1, {}]) {
      const options = { thinking: thinking as PublishedThinkingLevel };
      expect(() => policy(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'short', options)).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  for (const profile of numericProfiles) for (const thinking of [undefined, ...PUBLISHED_THINKING_LEVELS]) {
    it(`${profile.id}/${thinking}: owns numeric budgets and published output defaults`, async () => {
      const f = fixture(profile.id), options: ChatOptions = { thinking, maxTokens: undefined, temperature: 0.25 };
      const expectedBudget = thinking === undefined || thinking === 'off' ? undefined
        : ({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 } as const)[thinking];
      const prepared = captureNativeOutputBudget(f.provider)!(options);
      expect(prepared.maxTokens).toBe(profile.maxTokens);
      expect(getSupportedThinkingLevels('operator-alias', profile.id, undefined, f.provider)).toEqual(supported(profile));
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const [, init] = f.fetch.mock.calls.at(-1)!, body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBe(profile.maxTokens);
        expect(body.thinking).toEqual(expectedBudget === undefined ? thinking === 'off' ? { type: 'disabled' } : undefined
          : { type: 'enabled', budget_tokens: expectedBudget, display: 'summarized' });
        expect(body.temperature).toBe(expectedBudget === undefined ? 0.25 : undefined);
        expect(body.output_config).toBeUndefined();
        expect(new Headers(init?.headers).get('anthropic-beta')).toBe(expectedBudget === undefined ? null : 'interleaved-thinking-2025-05-14');
      }
      expect(options).toEqual({ thinking, maxTokens: undefined, temperature: 0.25 });
    });
  }
  for (const profile of numericProfiles) it(`${profile.id}: follows pinned full streamSimple allocation with safe pretransport refusals`, async () => {
    const f = fixture(profile.id), prepare = captureNativeOutputBudget(f.provider)!;
    expect(createHash('sha256').update(allocationBytes).digest('hex')).toBe('c2f4a2ac6e29109cf368bfda5872b07b7a0d09a8dcb046874001e29976f3c313');
    expect(allocationFixture.pinnedCommit).toBe(pin.sourceCommit);
    expect(allocationFixture.rows).toHaveLength(168); expect(allocationFixture.requests).toBe(168);
    for (const vector of allocationFixture.rows.filter(row => row.model === profile.id)) {
      const messages = allocationMessages(vector.context), options: ChatOptions = { ...vector.options, maxTokens: vector.options.maxTokens,
        systemPrompt: vector.context.system, tools: vector.context.tools }, before = structuredClone({ messages, options });
      const count = f.fetch.mock.calls.length;
      if (vector.refusedByCore) {
        expect(() => prepare(options, messages), vector.case).toThrow(ProviderOutputBudgetError);
        for (const stream of [false, true]) await expect(f.call(stream, 'none', options, messages), vector.case).rejects.toThrow('Invalid Anthropic thinking allocation.');
        expect(f.fetch).toHaveBeenCalledTimes(count);
      } else {
        const prepared = prepare(options, messages);
        expect(prepared.maxTokens, vector.case).toBe(vector.maxTokens);
        expect(prepare(prepared.options, messages).maxTokens).toBe(vector.maxTokens);
        for (const stream of [false, true]) {
          const response = await f.call(stream, 'none', prepared.options, messages);
          const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
          expect(body.model).toBe(profile.id); expect(response.model).toBe(profile.id); expect(response.api).toBe('anthropic-messages');
          expect(body.max_tokens, vector.case).toBe(vector.maxTokens);
          expect(body.thinking).toEqual(vector.thinkingBudget === undefined ? options.thinking === 'off' ? { type: 'disabled' } : undefined
            : { type: 'enabled', budget_tokens: vector.thinkingBudget, display: 'summarized' });
        }
      }
      expect({ messages, options }).toEqual(before);
    }
  });
  for (const source of ['explicit cap', 'context clamp'] as const) it(`preserves the numeric answer reserve after zero-budget fallback: ${source}`, async () => {
    // All six native numeric IDs share this allocation policy; one owner binds its boundary.
    const profile = numericProfiles[0], f = fixture(profile.id), prepare = captureNativeOutputBudget(f.provider)!;
    for (const maximum of [1024, 1025, 2047, 2048]) {
      const options: ChatOptions = { thinking: 'high', thinkingBudgets: { high: 0 },
        maxTokens: source === 'explicit cap' ? maximum : profile.maxTokens };
      const messages = source === 'explicit cap' ? input : allocationMessages({ usage: profile.contextWindow - 4096 - maximum });
      const before = structuredClone({ options, messages }), count = f.fetch.mock.calls.length;
      if (maximum < 2048) {
        expect(() => prepare(options, messages)).toThrow(ProviderOutputBudgetError);
        for (const stream of [false, true]) await expect(f.call(stream, 'none', options, messages)).rejects.toThrow('Invalid Anthropic thinking allocation.');
        expect(f.fetch).toHaveBeenCalledTimes(count);
      } else {
        const prepared = prepare(options, messages);
        expect(prepared.maxTokens).toBe(2048);
        for (const stream of [false, true]) {
          await f.call(stream, 'none', prepared.options, messages);
          const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
          expect(body.max_tokens).toBe(2048);
          expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024, display: 'summarized' });
        }
      }
      expect({ options, messages }).toEqual(before);
    }
  });
  for (const profile of numericProfiles) it(`${profile.id}: fits numeric answer room without double allocation or borrowing mutable metadata`, async () => {
    const f = fixture(profile.id), prepare = captureNativeOutputBudget(f.provider)!;
    const published = f.provider.getPublishedModels().find(row => row.id === profile.id)!;
    published.thinkingLevelMap!.high = 'off'; published.maxOutputTokens = Number.MAX_SAFE_INTEGER;
    for (const [maxTokens, high, maximum, budget] of [[64, undefined, 16448, 15424], [1, undefined, 16385, 15361],
      [64000, undefined, 64000, 16384], [64, 32000, 32064, 31040], [64, Number.MAX_SAFE_INTEGER, 64000, 62976], [64000, 0, 64000, 1024]] as const) {
      const options: ChatOptions = { maxTokens, thinking: 'high', ...(high === undefined ? {} : { thinkingBudgets: { high } }) };
      const prepared = prepare(options), again = prepare(prepared.options);
      expect(prepared.maxTokens).toBe(maximum); expect(again.maxTokens).toBe(maximum);
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.max_tokens).toBe(maximum); expect(body.thinking).toMatchObject({ budget_tokens: budget });
      }
      expect(options.maxTokens).toBe(maxTokens); expect(options.thinkingBudgets?.high).toBe(high);
    }
    const count = f.fetch.mock.calls.length;
    for (const options of [{ maxTokens: 64, thinking: 'minimal', thinkingBudgets: { minimal: 1 } }, { maxTokens: 64, thinking: 'high', thinkingBudgets: { high: 0 } }]) {
      expect(() => prepare(options as ChatOptions)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'none', options as ChatOptions)).rejects.toThrow('Invalid Anthropic thinking allocation.');
    }
    for (const thinking of [null, 'PRIVATE-invalid', 1]) {
      const options = { thinking: thinking as PublishedThinkingLevel };
      expect(() => prepare(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'none', options)).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
    const get = vi.fn(() => { throw new Error('PRIVATE-unused'); }), thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
    for (const thinking of [undefined, 'off'] as const) {
      const options = prepare({ thinking, thinkingBudgets });
      await f.call(false, 'none', options.options);
    }
    expect(get).not.toHaveBeenCalled();
    expect(() => prepare({ thinking: 'high', thinkingBudgets })).toThrow(ProviderOutputBudgetError);
    expect(get).not.toHaveBeenCalled();
    class Compatible extends AnthropicProvider {}
    const compatible = fixture(profile.id, 'alias', Compatible);
    await compatible.call(false, 'none', { thinking: 'high' });
    const body = JSON.parse(String(compatible.fetch.mock.calls.at(-1)?.[1]?.body));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 }); expect(body.max_tokens).toBe(9216);
  });
  for (const profile of managedProfiles) for (const thinking of [undefined, ...PUBLISHED_THINKING_LEVELS]) {
    it(`${profile.id}/${thinking}: emits managed active effort, binding controls and native betas`, async () => {
      const f = fixture(profile.id), get = vi.fn(() => { throw new Error('UNUSED'); });
      const thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
      const levels = supported(profile), requested = thinking ?? 'high';
      const selected = levels.includes(requested) ? requested : levels.find(level => PUBLISHED_THINKING_LEVELS.indexOf(level) > PUBLISHED_THINKING_LEVELS.indexOf(requested))!;
      const effort = selected === 'minimal' ? 'low' : selected;
      const options = { thinking, thinkingBudgets, temperature: 0.25, maxTokens: 64 };
      const prepared = captureNativeOutputBudget(f.provider)!(options);
      expect(prepared.maxTokens).toBe(64); expect(prepared.options.thinkingBudgets).toBe(thinkingBudgets);
      expect(getSupportedThinkingLevels('operator-alias', profile.id, undefined, f.provider)).toEqual(levels);
      for (const stream of [false, true]) {
        const result = await f.call(stream, 'none', prepared.options);
        const [, init] = f.fetch.mock.calls.at(-1)!, body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
        expect(body.output_config).toEqual({ effort: 'high' }); expect(body.temperature).toBeUndefined();
        expect(body.messages).toEqual([{ role: 'user', content: 'probe' }, { role: 'system', content: [], output_config: { effort } }]);
        expect(new Headers(init?.headers).get('anthropic-beta')?.split(',')).toEqual(expect.arrayContaining([
          'mid-conversation-output-config-2026-07-01', 'thinking-binding-controls-2026-08-01',
        ]));
        expect(result.providerThinkingLevel).toBe(effort); expect(result.thinkingLevel).toBeUndefined(); expect(result.model).toBe(profile.id);
      }
      expect(get).not.toHaveBeenCalled(); expect(options.thinkingBudgets).toBe(thinkingBudgets);
    });
  }
  for (const profile of managedProfiles) it(`${profile.id}: replays only owned historical efforts and keeps tool pairs adjacent`, async () => {
    const f = fixture(profile.id), timestamp = new Date(0);
    const history: Message[] = [input[0],
      { id: 'assistant', role: 'assistant', content: 'prior', timestamp, provider: 'operator-alias', model: profile.id,
        api: 'anthropic-messages', metadata: { providerThinkingLevel: 'xhigh' }, toolCalls: [{ id: 'call', name: 'echo', input: {} }] },
      { id: 'tool', role: 'tool', content: 'result', timestamp, toolCallId: 'call' },
      { id: 'foreign-api', role: 'assistant', content: 'foreign-api', timestamp, provider: 'operator-alias', api: 'openai-responses', metadata: { providerThinkingLevel: 'max' } },
      { id: 'foreign-provider', role: 'assistant', content: 'foreign-provider', timestamp, provider: 'other', api: 'anthropic-messages', metadata: { providerThinkingLevel: 'max' } },
      { id: 'legacy', role: 'assistant', content: 'legacy', timestamp, provider: 'operator-alias', api: 'anthropic-messages', metadata: { providerThinkingLevel: 'PRIVATE-invalid' } },
      { id: 'logical', role: 'assistant', content: 'logical', timestamp, provider: 'operator-alias', model: profile.id,
        api: 'anthropic-messages', metadata: { thinkingLevel: 'high' } },
      { ...input[0], id: 'next' }];
    for (const stream of [false, true]) {
      await f.call(stream, 'none', { thinking: 'max' }, history);
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.messages.filter((message: { role: string }) => message.role === 'system')).toEqual([
        { role: 'system', content: [], output_config: { effort: 'xhigh' } },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ]);
      const assistant = body.messages.findIndex((message: { role: string }) => message.role === 'assistant');
      expect(body.messages[assistant + 1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] });
      expect(JSON.stringify(body)).not.toContain('PRIVATE-invalid');
    }
    expect(history[1].metadata).toEqual({ providerThinkingLevel: 'xhigh' });
    const count = f.fetch.mock.calls.length;
    for (const thinking of [null, 'PRIVATE-invalid', 1, {}]) {
      const options = { thinking: thinking as PublishedThinkingLevel };
      expect(() => captureNativeOutputBudget(f.provider)!(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'none', options)).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
    class Compatible extends AnthropicProvider {}
    const compatible = fixture(profile.id, 'alias', Compatible);
    for (const stream of [false, true]) {
      await compatible.call(stream, 'none', { thinking: 'high' });
      const [, init] = compatible.fetch.mock.calls.at(-1)!, body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
      expect(body.output_config).toBeUndefined(); expect(new Headers(init?.headers).get('anthropic-beta')).toBeNull();
    }
  });
  it.each([false, true])('persists ordered native blocks/managed effort through both append paths and reload (stream=%s)', async stream => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-anthropic-replay-'));
    const redactor = new CredentialRedactor(['disposable-profile-key']);
    const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
    const f = fixture('claude-haiku-5-5'), manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
    const session = await manager.create({ title: 'Managed effort' });
    const registry = new ExtensionRegistry(), tools = [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }];
    await manager.addMessage(session.id, { role: 'user', content: input[0].content });
    await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: async () => ({ content: 'result' }) }));
    const native = signedContent.map(block => block.type === 'thinking' ? { ...block, signature: 'opaque-disposable-profile-key' } : block);
    let turn = 0;
    try {
      const clockBase = Date.now() + 86_400_000, clock = vi.spyOn(Date, 'now');
      await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'operator-alias', tools,
        redactText, toolContext: { sessionManager: manager, notify: () => {} }, streamTurn: async messages => {
          const first = turn++ === 0, thinking = first ? 'max' : 'low';
          clock.mockReturnValue(clockBase + (first ? 1_000 : 0));
          const content = first ? native : native.filter(block => block.type !== 'tool_use');
          f.reply({ content, stop_reason: first ? 'tool_use' : 'end_turn', usage: observed }, signedEvents(content, first ? 'tool_use' : 'end_turn'));
          return stream ? streamProviderTurn({ provider: f.provider, providerName: 'operator-alias', model: 'claude-haiku-5-5',
            messages, tools, thinking, maxTokens: 64, cacheRetention: 'none', cacheWarming: 'off', maxRetries: 0,
            extensionRegistry: registry, sessionManager: manager, sessionId: session.id,
            redactText, redactJson, createTextRedactor: () => redactor.createStream() })
            : f.call(false, 'none', { thinking, tools }, messages);
        } });
      const history = session.messages.filter(message => message.role === 'assistant');
      expect(history[0].timestamp.getTime()).toBeGreaterThan(history[1].timestamp.getTime());
      expect(history.map(message => message.metadata?.providerThinkingLevel)).toEqual(['max', 'low']);
      expect(history.map(message => message.metadata?.thinkingLevel)).toEqual([undefined, undefined]);
      expect(history.map(message => message.api)).toEqual(['anthropic-messages', 'anthropic-messages']);
      expect(history[0].toolCalls).toHaveLength(1); expect(history[1].toolCalls).toBeUndefined();
      const expected = [{ type: 'text', text: 'left!' }, { type: 'reasoning', text: 'firstsecond', thinkingSignature: 'opaque-[REDACTED]' },
        { type: 'reasoning', text: '[Reasoning redacted]', redacted: true, thinkingSignature: 'opaque-redacted' },
        { type: 'text', text: 'right?' }, { type: 'tool_call', id: 'call', name: 'echo', input: { x: 1 } }];
      expect(history[0].blocks).toEqual(expected); expect(history[1].blocks).toEqual(expected.slice(0, -1));
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.messages.filter((message: { role: string }) => message.role === 'system')).toEqual([
        { role: 'system', content: [], output_config: { effort: 'max' } }, { role: 'system', content: [], output_config: { effort: 'low' } },
      ]);
      const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8');
      expect(bytes).not.toContain('disposable-profile-key'); expect(bytes).toContain('opaque-[REDACTED]');
      const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
      const loaded = (await restarted.loadFromStore(session.id))!;
      const imported = deserializeSession(JSON.parse(JSON.stringify(serializeSession(loaded))));
      expect(imported.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
      const expurgated = serializeSessionForExport(loaded);
      expect(expurgated.warning).toContain('Native continuation'); expect(JSON.stringify(expurgated.session)).not.toContain('opaque-');
      imported.messages.push({ id: 'next', role: 'user', content: 'continue', timestamp: new Date() });
      await f.call(stream, 'none', { thinking: 'low' }, imported.messages);
      const replay = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(replay.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { content: unknown }) => message.content))
        .toEqual([native.map(block => block.type === 'thinking' ? { ...block, signature: 'opaque-[REDACTED]' } : block),
          native.filter(block => block.type !== 'tool_use').map(block => block.type === 'thinking' ? { ...block, signature: 'opaque-[REDACTED]' } : block)]);
      expect(await readFile(file, 'utf8')).toBe(bytes);
      await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
      const clone = await restarted.cloneSession(session.id);
      const context = restarted.getEffectiveContext(clone.id).flatMap((entry): Message[] => entry.type === 'message'
        ? [{ ...entry, timestamp: new Date(entry.timestamp) }] : []);
      context.push({ id: 'next', role: 'user', content: 'continue', timestamp: new Date() });
      await f.call(stream, 'none', { thinking: 'low' }, context);
      const edited = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).messages.filter((message: { role: string }) => message.role === 'assistant');
      expect(JSON.stringify(edited[0])).not.toContain('opaque-'); expect(JSON.stringify(edited[1])).toContain('opaque-redacted');
      expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message' && entry.role === 'assistant').map(entry => entry.blocks))
        .toEqual(history.map(message => message.blocks));
      expect(clone.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
      registry.virtualModels.register({ provider: 'router', id: 'auto', maxOutputTokens: 64,
        route: () => ({ provider: 'operator-alias', id: 'claude-fable-5-1', thinkingLevel: 'minimal' }) });
      const routed = await streamProviderTurn({ provider: registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
        messages: loaded.messages, tools: [], extensionRegistry: registry, resolveProvider: name => name === 'operator-alias' ? f.provider : undefined, maxRetries: 0 });
      expect(routed.providerThinkingLevel).toBe('low'); expect(routed.thinkingLevel).toBe('minimal');
      expect(routed.selection).toMatchObject({ provider: 'router', id: 'auto' });
      const switched = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(JSON.stringify(switched.messages)).not.toContain('opaque-');
      expect(JSON.stringify(switched.messages)).toContain('firstsecond');
      expect(native[1].signature).toBe('opaque-disposable-profile-key');
      const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
      expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-/);
      expect(canonical).toEqual(beforeSummary);
      const kept = clone.messages.filter(message => message.role === 'assistant').at(-1)!;
      const sourceBytes = await readFile(file, 'utf8');
      const cloneRaw = await restarted.getRawEntries(clone.id), cloneAssistantIds = clone.messages.filter(message => message.role === 'assistant').map(message => message.id);
      await restarted.applyCompaction(clone.id, 'PUBLIC_COMPACTED_PREFIX', kept.id);
      const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
      const compactedSession = (await compactedManager.loadFromStore(clone.id))!;
      const compacted = getCompactionModelMessages(compactedManager, clone.id);
      expect(compactedSession.metadata?.compactionSummary).toBe('PUBLIC_COMPACTED_PREFIX');
      expect(compacted.some(message => message.content.includes('PUBLIC_COMPACTED_PREFIX'))).toBe(true);
      expect(compacted.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([expected.slice(0, -1)]);
      expect(compacted.filter(message => message.role === 'tool')).toEqual([]);
      const raw = await compactedManager.getRawEntries(clone.id);
      expect(raw).toContainEqual(expect.objectContaining({ type: 'compaction', firstKeptEntryId: kept.id, summary: 'PUBLIC_COMPACTED_PREFIX' }));
      // Copies may timestamp-sort raw entries; parent order owns replay, while compaction preserves every copied entry.
      const durable = raw.filter(entry => entry.type !== 'metadata');
      expect(durable.slice(0, -1)).toEqual(cloneRaw.filter(entry => entry.type !== 'metadata'));
      expect(durable.at(-1)).toMatchObject({ type: 'compaction', firstKeptEntryId: kept.id });
      const rawMessages = raw.filter(entry => entry.type === 'message');
      expect(cloneAssistantIds.map(id => rawMessages.find(entry => entry.id === id)?.blocks)).toEqual(history.map(message => message.blocks));
      const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8');
      expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
      await f.call(stream, 'none', { thinking: 'low', systemPrompt: 'TRUSTED_SYSTEM_PREFIX' }, compacted);
      const compactedReplay = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(compactedReplay.system).toBe('TRUSTED_SYSTEM_PREFIX\n\n[Context Summary] PUBLIC_COMPACTED_PREFIX');
      expect(compactedReplay.messages.filter((message: { role: string }) => message.role === 'assistant').map((message: { content: unknown }) => message.content))
        .toEqual([native.filter(block => block.type !== 'tool_use').map(block => block.type === 'thinking' ? { ...block, signature: 'opaque-[REDACTED]' } : block)]);
      expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes);
      expect(await readFile(file, 'utf8')).toBe(sourceBytes);
    } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it('captures the adaptive dialect independently of public metadata, later model changes and derived transports', async () => {
    const f = fixture('claude-opus-4-7'), policy = captureNativeOutputBudget(f.provider)!;
    const row = getProviderPublishedModel('operator-alias', 'claude-opus-4-7', f.provider)!;
    row.thinkingLevelMap!.xhigh = 'not-an-effort'; row.thinkingLevelMap!.off = null;
    f.provider.setConfiguredModel('claude-haiku-4-5');
    for (const stream of [false, true]) {
      await f.call(stream, 'short', policy({ thinking: 'xhigh', maxTokens: 64 }).options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).output_config).toEqual({ effort: 'xhigh' });
      await f.call(stream, 'short', policy({ model: 'claude-haiku-4-5', thinking: 'high', maxTokens: 64 }).options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).thinking).toEqual({ type: 'enabled', budget_tokens: 15424, display: 'summarized' });
    }
    class Compatible extends AnthropicProvider {}
    for (const model of ['claude-opus-4-7', 'claude-opus-4-7-unverified']) {
      const derived = fixture(model, 'alias', model.endsWith('unverified') ? AnthropicProvider : Compatible);
      for (const stream of [false, true]) {
        await derived.call(stream, 'short', { thinking: 'xhigh', maxTokens: 64 });
        const body = JSON.parse(String(derived.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 }); expect(body.output_config).toBeUndefined();
      }
    }
  });
  it('captures configured ceiling before model changes but honors explicit per-call models', async () => {
    const small = 'claude-haiku-4-5', large = 'claude-opus-5', f = fixture(small);
    const pinned = captureNativeOutputBudget(f.provider)!;
    f.provider.setConfiguredModel(large);
    expect(() => pinned({ maxTokens: 64001 })).toThrow(ProviderOutputBudgetError);
    expect(captureNativeOutputBudget(f.provider)!({ maxTokens: 64001 }).maxTokens).toBe(64001);
    expect(pinned({ model: large, maxTokens: 64001 }).maxTokens).toBe(64001);
    for (const stream of [false, true]) {
      await f.call(stream, 'short', { maxTokens: 64001 });
      await expect(f.call(stream, 'short', { model: small, maxTokens: 64001 })).rejects.toThrow('Invalid Anthropic output limit.');
      await expect(f.call(stream, 'short', { model: small, maxTokens: 64001, thinking: 'high' })).rejects.toThrow('Invalid Anthropic output limit.');
    }
    const row = getProviderPublishedModel('operator-alias', small, f.provider)!; row.maxOutputTokens = 999999;
    expect(() => pinned({ maxTokens: 64001 })).toThrow(ProviderOutputBudgetError);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid explicit caps before native numeric allocation can raise them', async () => {
    const f = fixture('claude-haiku-4-5'), policy = captureNativeOutputBudget(f.provider)!;
    const options = { maxTokens: 64, thinking: 'high' as const };
    expect(policy(options).maxTokens).toBe(16448);
    for (const stream of [false, true]) {
      await f.call(stream, 'short', options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).max_tokens).toBe(16448);
      await expect(f.call(stream, 'short', { maxTokens: 0, thinking: 'high' })).rejects.toThrow('Invalid Anthropic output limit.');
    }
    expect(() => policy({ maxTokens: 0, thinking: 'high' })).toThrow(ProviderOutputBudgetError);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not borrow ceilings by name for derived transports or unknown models', async () => {
    class Compatible extends AnthropicProvider {}
    const compatible = fixture('claude-haiku-4-5', 'alias', Compatible);
    expect(captureNativeOutputBudget(compatible.provider)).toBeUndefined();
    for (const stream of [false, true]) await compatible.call(stream, 'short', { maxTokens: 64001 });
    const unknown = fixture('claude-opus-5-unverified');
    expect(captureNativeOutputBudget(unknown.provider)!({ maxTokens: 128001 }).maxTokens).toBe(128001);
    for (const stream of [false, true]) await unknown.call(stream, 'short', { maxTokens: 128001 });
  });
  it('uses gross input at the Haiku 5.5 boundary, not output tokens or response aliases', async () => {
    const f = fixture('claude-haiku-5-5');
    for (const stream of [false, true]) for (const [inputTokens, read, write, price] of [
      [99993, 4, 3, 0.1], [99994, 4, 3, 0.5], [5, 4, 3, 0.1],
    ]) {
      f.usage({ input_tokens: inputTokens, output_tokens: 100001, cache_read_input_tokens: read, cache_creation_input_tokens: write });
      const result = await f.call(stream);
      expect(result.usage?.costUsd).toBeCloseTo((inputTokens * price + 100001 * price * 5 + read * price / 10 + write * price * 1.25) / 1e6, 12);
    }
  });
  it('retains nullable SSE snapshots and an explicit zero one-hour write count', async () => {
    const f = fixture('claude-opus-5');
    f.usage(structuredClone(observed), { input_tokens: null, output_tokens: 3, cache_read_input_tokens: null,
      cache_creation_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: 0 } });
    const result = await f.call(true, 'long');
    expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 3, totalTokens: 15 });
    expect(result.usage?.costUsd).toBeCloseTo((5 * 5 + 3 * 25 + 4 * 0.5 + 3 * 6.25) / 1e6, 12);
    f.usage({ ...observed, cache_creation: undefined });
    for (const stream of [false, true]) expect((await f.call(stream, 'long')).usage?.costUsd)
      .toBeCloseTo((5 * 5 + 2 * 25 + 4 * 0.5 + 3 * 6.25) / 1e6, 12);
  });
  it('does not manufacture complete usage from missing or malformed counters', async () => {
    const f = fixture('claude-fable-5');
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { ...observed, input_tokens: -1 },
      { ...observed, output_tokens: 0.5 }, { ...observed, cache_read_input_tokens: null },
      { ...observed, cache_creation: { ephemeral_1h_input_tokens: 4 } }]) {
      f.usage(invalid);
      for (const stream of [false, true]) expect((await f.call(stream)).usage).toBeUndefined();
    }
  });
  it('returns defensive owned rows without enabling additional paid warming or borrowing unknown-model limits', async () => {
    const f = fixture('claude-fable-5');
    const first = getProviderPublishedModels(f.provider)!;
    const native = first.filter(row => profiles.some(profile => profile.id === row.id)); expect(native).toHaveLength(17);
    expect(native.filter(row => row.promptCache).map(row => row.id)).toEqual(['claude-sonnet-4-6']);
    first.find(row => row.id === 'claude-fable-5')!.pricing!.inputPerMillion = 999;
    expect(getProviderPublishedModel('operator-alias', 'claude-fable-5', f.provider)?.pricing?.inputPerMillion).toBe(10);
    expect(getProviderPublishedModel('anthropic', 'claude-fable-5-unverified', f.provider)).toBeUndefined();
    expect(first.some(row => row.id === 'claude-3-haiku-20240307')).toBe(true);
    class CompatibilityProvider extends AnthropicProvider {}
    expect(new CompatibilityProvider({ type: 'custom', apiKey: 'disposable' }).getPublishedModels?.()).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
    const unknown = fixture('claude-fable-5-unverified', 'claude-opus-5');
    for (const stream of [false, true]) expect((await unknown.call(stream, 'long')).usage?.costUsd).toBeUndefined();
  });
});
