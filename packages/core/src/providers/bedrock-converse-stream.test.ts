import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BedrockProvider, bedrockCredentialConfig, type ChatOptions, type ChatResponse, type ThinkingLevel } from './index.js';
import { applyBedrockProfileOutputPolicy } from './bedrock-profiles.js';
import { getSupportedThinkingLevels, clampPublishedThinkingLevel } from './model-metadata.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { bedrockFrame as frame, bedrockText } from '../../../../tests/fixtures/bedrock-event-stream.js';
import type { Message } from '../types/index.js';

const messages: Message[] = [{ id: 'u', role: 'user', content: 'hello', timestamp: new Date(0) }];
const create = (extra = {}) => new BedrockProvider({ type: 'bedrock', accessKeyId: 'DISPOSABLE', secretAccessKey: 'disposable-secret', region: 'us-east-1', model: 'model:0', ...extra });
const response = (bytes: Uint8Array) => new Response(bytes, { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); await closeProviderNetworkDispatchers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function stream(bytes: Uint8Array) {
  vi.stubGlobal('fetch', vi.fn(async () => response(bytes)));
  const chunks: string[] = [], tools: unknown[] = [], complete = vi.fn(), error = vi.fn();
  await create().streamChat(messages, (text, event) => { chunks.push(text); if (event?.type === 'tool_call') tools.push(event.data); }, complete, error);
  return { chunks, tools, complete, error };
}

describe('native Bedrock ConverseStream', () => {
  it('uses an explicit opaque Bearer for JSON Converse and binary streaming without SigV4 or ambient key headers', async () => {
    const captured: Array<{ path: string; headers: Record<string, string | string[] | undefined> }> = [];
    const server = createServer(async (request, reply) => {
      for await (const _chunk of request) { /* Consume the genuine request before replying. */ }
      captured.push({ path: request.url!, headers: request.headers });
      if (request.url!.endsWith('/converse-stream')) {
        reply.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        reply.end(bedrockText('bearer-stream', 'end_turn', { inputTokens: 7, outputTokens: 2 }));
      } else {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ output: { message: { content: [{ text: 'bearer-json' }] } }, usage: { inputTokens: 7, outputTokens: 2 } }));
      }
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = create({ apiKey: 'disposable:opaque-bearer', accessKeyId: 'private\u0000access', sessionToken: 'private\u0000session',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy/model/model%3A0/converse` });
    expect(provider.validateConfig()).toBe(true);
    expect(await provider.chat(messages)).toMatchObject({ content: 'bearer-json', usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 } });
    let completed: ChatResponse | undefined;
    await provider.streamChat(messages, () => {}, value => { completed = value; }, undefined, { model: 'override:1' });
    expect(completed).toMatchObject({ content: 'bearer-stream', api: 'bedrock-converse-stream', model: 'override:1', usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 } });
    expect(captured.map(request => request.path)).toEqual(['/proxy/model/model%3A0/converse', '/proxy/model/override%3A1/converse-stream']);
    for (const request of captured) {
      expect(request.headers.authorization).toBe('Bearer disposable:opaque-bearer');
      expect(request.headers['content-type']).toBe('application/json');
      expect(Object.keys(request.headers).filter(name => name.startsWith('x-amz-'))).toEqual([]);
    }
  });

  it('refuses malformed explicit Bearers without a SigV4 fallback, HTTP dispatch or private header diagnostics', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const apiKey of ['', '   ', 'private\u0000bearer', 'private\nbearer', 'private🐈bearer']) {
      const provider = create({ apiKey });
      expect(provider.validateConfig()).toBe(false);
      await expect(provider.chat(messages)).rejects.toThrow('AWS Bedrock credentials are required');
      const failed = vi.fn(); await provider.streamChat(messages, () => {}, undefined, failed);
      expect(failed.mock.calls[0][0].message).toBe('AWS Bedrock credentials are required');
    }
    for (const baseUrl of ['not-a-url', 'file:///private', 'https://private:password@example.test', 'https://example.test?private=token', 'https://example.test#private']) {
      const provider = create({ apiKey: 'disposable-bearer', baseUrl });
      await expect(provider.chat(messages)).rejects.toThrow('Invalid Bedrock endpoint.');
      const failed = vi.fn(); await provider.streamChat(messages, () => {}, undefined, failed);
      expect(failed.mock.calls[0][0].message).toBe('Invalid Bedrock endpoint.');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('owns serialized Bearer credentials while preserving strict legacy SigV4 syntax and explicit ambiguity handling', () => {
    expect(bedrockCredentialConfig('ACCESS:secret/+=:session/+=')).toEqual({ accessKeyId: 'ACCESS', secretAccessKey: 'secret/+=', sessionToken: 'session/+=' });
    expect(bedrockCredentialConfig('ACCESS:secret')).toEqual({ accessKeyId: 'ACCESS', secretAccessKey: 'secret' });
    expect(bedrockCredentialConfig('disposable-opaque-token')).toEqual({ apiKey: 'disposable-opaque-token' });
    for (const bearerToken of ['ACCESS:secret', '{opaque-token}', 'disposable-é-token']) {
      expect(bedrockCredentialConfig(JSON.stringify({ bearerToken }))).toEqual({ apiKey: bearerToken });
    }
    for (const value of [undefined, {}, '', ' ', 'ACCESS:', 'ACCESS:secret:session:extra', ':secret', '{bad', '{}',
      '{"bearerToken":"private\\u0000token"}', '{"bearerToken":"private🐈token"}', '{"bearerToken":"token","extra":true}', '{"__proto__":{"bearerToken":"token"}}']) {
      expect(bedrockCredentialConfig(value)).toBeUndefined();
    }
  });

  it('streams authenticated binary HTTP text/reasoning/tools before EOF and retains real cache counters', async () => {
    let captured: { path?: string; headers?: unknown; body?: unknown } = {};
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createServer(async (request, reply) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      captured = { path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
      reply.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      reply.write(frame('messageStart', { role: 'assistant' }));
      reply.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'first' } }));
      await gate;
      reply.end(Buffer.concat([
        frame('contentBlockStop', { contentBlockIndex: 0 }),
        frame('contentBlockDelta', { contentBlockIndex: 1, delta: { reasoningContent: { text: 'consider' } } }),
        frame('contentBlockStop', { contentBlockIndex: 1 }),
        frame('contentBlockStart', { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tool', name: 'echo' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '{"x":' } } }),
        frame('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '1}' } } }),
        frame('contentBlockStop', { contentBlockIndex: 2 }),
        frame('messageStop', { stopReason: 'tool_use' }),
        frame('metadata', { usage: { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3, cacheWriteInputTokens: 1, totalTokens: 13 } }),
      ]));
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = create({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy`, sessionToken: 'disposable-session' });
    let completion: ChatResponse | undefined, reasoning = '';
    await provider.streamChat(messages, (text, event) => {
      if (text === 'first') { expect(completion).toBeUndefined(); release(); }
      if (event?.type === 'reasoning_delta') reasoning += (event.data as { content: string }).content;
    }, value => { completion = value; }, undefined, { model: 'override:1', maxTokens: 20, tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }] });
    expect(captured.path).toBe('/proxy/model/override%3A1/converse-stream');
    expect(captured.headers).toMatchObject({ authorization: expect.stringContaining('AWS4-HMAC-SHA256 Credential=DISPOSABLE/'), 'x-amz-security-token': 'disposable-session' });
    expect(captured.body).toMatchObject({ messages: [{ role: 'user', content: [{ text: 'hello' }] }], inferenceConfig: { maxTokens: 20 }, toolConfig: { tools: [{ toolSpec: { name: 'echo' } }] } });
    expect(reasoning).toBe('consider');
    expect(completion).toMatchObject({ api: 'bedrock-converse-stream', content: 'first', reasoning: 'consider', model: 'override:1', toolCalls: [{ id: 'tool', name: 'echo', input: { x: 1 } }], usage: { promptTokens: 7, completionTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 13 } });
    expect(provider.getModelApi()).toBe('bedrock-converse-stream');
  });

  it('matches an independent SigV4 double-escaped colon-path vector and validates credentials before dispatch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    const fetch = vi.fn(async () => response(bedrockText())); vi.stubGlobal('fetch', fetch);
    const error = vi.fn(); await create().streamChat(messages, () => {}, undefined, error);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/model%3A0/converse-stream');
    expect(new Headers(init.headers).get('authorization')).toBe('AWS4-HMAC-SHA256 Credential=DISPOSABLE/20261021/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=cd805b46dc399194ee9c1abe6f3f78a4d71b066c4bd5e58c027fe2ed3507020e');
    expect(String(init.body)).toBe('{"messages":[{"role":"user","content":[{"text":"hello"}]}],"inferenceConfig":{}}');
    expect(error).not.toHaveBeenCalled();
    for (const config of [{ accessKeyId: 'private\u0000key' }, { sessionToken: 'private\u0000session' }, { accessKeyId: 'private🐈key' }, { secretAccessKey: '' }]) {
      const provider = create(config); expect(provider.validateConfig()).toBe(false);
      const failed = vi.fn(); await provider.streamChat(messages, () => {}, undefined, failed);
      expect(failed.mock.calls[0][0].message).toBe('AWS Bedrock credentials are required');
    }
    for (const baseUrl of ['https://private:password@example.test', 'https://example.test?secret=private', 'file:///private']) {
      const failed = vi.fn(); await create({ baseUrl }).streamChat(messages, () => {}, undefined, failed);
      expect(failed.mock.calls[0][0].message).toBe('Invalid Bedrock endpoint.');
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('accepts one-byte fragments, coalesced frames and UTF-8 without fabricating absent usage', async () => {
    const bytes = bedrockText('été 🐈', 'max_tokens');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }))));
    let complete: ChatResponse | undefined;
    await create().streamChat(messages, () => {}, value => { complete = value; });
    expect(complete).toMatchObject({ content: 'été 🐈', stopReason: 'length' });
    expect(complete?.usage).toBeUndefined();
    const grouped = await stream(bedrockText('coalesced', 'model_context_window_exceeded', { inputTokens: -1, outputTokens: 2.5 }));
    expect(grouped.complete.mock.calls[0][0]).toMatchObject({ stopReason: 'length' });
    expect(grouped.complete.mock.calls[0][0].usage).toBeUndefined();
  });

  it('rejects damaged prelude/message checksums, truncated frames and invalid native JSON', async () => {
    const valid = bedrockText();
    const badPrelude = Buffer.from(valid); badPrelude[8] ^= 1;
    const badCrc = Buffer.from(valid); badCrc[badCrc.length - 1] ^= 1;
    const invalidJson = frame('messageStart', {}); invalidJson[invalidJson.length - 5] = 0xff;
    // Recompute the message CRC: JSON/UTF-8 validation, not checksum rejection, must own this case.
    const { crc32 } = await import('node:zlib'); invalidJson.writeUInt32BE(crc32(invalidJson.subarray(0, -4)), invalidJson.length - 4);
    for (const bytes of [badPrelude, badCrc, valid.subarray(0, -1), invalidJson]) {
      const result = await stream(bytes);
      expect(result.complete).not.toHaveBeenCalled(); expect(result.error).toHaveBeenCalledOnce(); expect(result.tools).toEqual([]);
      expect(result.error.mock.calls[0][0].message).toBe('Invalid Bedrock event stream.');
    }
  });

  it('withholds tools/completion after native exceptions, invalid arguments, refusal or missing stops', async () => {
    const start = frame('messageStart', { role: 'assistant' });
    const tool = [frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tool', name: 'echo' } } }),
      frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{bad' } } }), frame('contentBlockStop', { contentBlockIndex: 0 })];
    for (const bytes of [
      Buffer.concat([start, ...tool, frame('messageStop', { stopReason: 'tool_use' })]),
      Buffer.concat([start, frame('modelStreamErrorException', { message: 'disposable-secret' }, 'exception')]),
      Buffer.concat([start, frame('messageStop', { stopReason: 'guardrail_intervened' })]), start,
      Buffer.concat([start, frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'partial' } }), frame('messageStop', { stopReason: 'end_turn' })]),
      Buffer.concat([bedrockText(), frame('modelStreamErrorException', { message: 'disposable-secret' }, 'exception')]),
    ]) {
      const result = await stream(bytes); expect(result.complete).not.toHaveBeenCalled(); expect(result.error).toHaveBeenCalledOnce(); expect(result.tools).toEqual([]);
      expect(result.error.mock.calls[0][0].message).not.toContain('disposable-secret');
    }
  });

  it('enforces aggregate payload, tool-input and event-count limits while accepting large coalesced reads', async () => {
    const text = 'x'.repeat(600_000);
    const start = frame('messageStart', { role: 'assistant' });
    const delta = frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text } });
    const stops = [frame('contentBlockStop', { contentBlockIndex: 0 }), frame('messageStop', { stopReason: 'end_turn' })];
    const accepted = await stream(Buffer.concat([start, delta, delta, ...stops]));
    expect(accepted.error).not.toHaveBeenCalled(); expect(accepted.complete.mock.calls[0][0].content.length).toBe(1_200_000);
    for (const bytes of [
      Buffer.concat([start, ...Array<Buffer>(29).fill(delta)]),
      Buffer.concat([start, ...Array<Buffer>(100_001).fill(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: '' } }))]),
      Buffer.concat([start, frame('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tool', name: 'echo' } } }),
        ...Array<Buffer>(2).fill(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: text } } }))]),
    ]) {
      const failed = await stream(bytes); expect(failed.error.mock.calls[0][0].message).toMatch(/limit/);
      expect(failed.complete).not.toHaveBeenCalled(); expect(failed.tools).toEqual([]);
    }
  });

  it('cancels between awaited callbacks before any later buffered output or completion', async () => {
    const controller = new AbortController(), chunks: string[] = [], complete = vi.fn(), error = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => response(Buffer.concat([bedrockText('first'), bedrockText('second')]))));
    await create().streamChat(messages, async text => { chunks.push(text); await Promise.resolve(); if (text) controller.abort(); }, complete, error, { signal: controller.signal });
    expect(chunks.filter(Boolean)).toEqual(['first']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
  });

  it('interrupts a held body and rejects oversize declared frames before allocation', async () => {
    const controller = new AbortController(); let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 5); }, cancel() { cancelled = true; } }))));
    const error = vi.fn(); await create().streamChat(messages, () => {}, undefined, error, { signal: controller.signal });
    expect(error).toHaveBeenCalledOnce(); expect(cancelled).toBe(true);
    const { crc32 } = await import('node:zlib'); const huge = Buffer.alloc(12); huge.writeUInt32BE(1024 * 1024 + 1); huge.writeUInt32BE(crc32(huge.subarray(0, 8)), 8);
    const result = await stream(huge); expect(result.complete).not.toHaveBeenCalled(); expect(result.error.mock.calls[0][0].message).toMatch(/limit/);
  });
});

const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/bedrock-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; catalogueSha256: string; captureSha256: string;
  models: Array<{ id: string; name: string; api: string; reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
  cases: Array<{ model: string; case: string; observed: Record<string, unknown>; expected: NonNullable<ChatResponse['usage']> }>;
};
const rawOutputReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/bedrock-raw-output-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; constructionCaptureSha256: string; successfulUsageCaptureSha256: string;
  rows: Array<{ id: string; maxTokens: number | null }>;
};
const outputBoundaryBytes = readFileSync(new URL('../../../../tests/fixtures/bedrock-output-boundaries-reference.json', import.meta.url));
const outputBoundaryReference = JSON.parse(outputBoundaryBytes.toString()) as {
  pinnedCommit: string; catalogueSha256: string; captureSha256: string; modelProjections: number; vectors: number; freshSdkRequests: number;
  rows: Array<{ model: string; api: string; case: string; options: { maxTokens?: number; temperature?: number }; expectedInferenceConfig: { maxTokens?: number; temperature?: number } }>;
};
const toolSchemaBytes = readFileSync(new URL('../../../../tests/fixtures/bedrock-tool-schema-reference.json', import.meta.url));
const toolSchemaReference = JSON.parse(toolSchemaBytes.toString()) as {
  pinnedCommit: string; catalogueSha256: string; captureSha256: string; reuseCaptureSha256: string;
  modelProjections: number; vectors: number; freshSdkRequests: number; reusedSdkRequests: number;
  rows: Array<{ model: string; api: string; case: string; options: ChatOptions; expectedToolConfig: Record<string, unknown> | null }>;
};
const reasoningBytes = readFileSync(new URL('../../../../tests/fixtures/bedrock-reasoning-reference.json', import.meta.url));
const reasoningReference = JSON.parse(reasoningBytes.toString()) as {
  pinnedCommit: string; catalogueSha256: string; priorCaptureSha256: string; captureSha256: string;
  models: Array<{ id: string; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }>; modelProjections: number; vectors: number; sdkBodyObservations: number; freshSdkRequests: number; reusedSdkRequests: number;
  rows: Array<{ model: string; api: string; thinking: NonNullable<ChatOptions['thinking']>; options: ChatOptions; expectedBody: Record<string, unknown> }>;
};
// The exact Opus model already has its independent seven-level owning/installed controls.
const remainingReasoning = reasoningReference.rows.filter(row => row.model !== 'anthropic.claude-opus-4-6-v1');
type SimpleCaller = { reasoning?: ThinkingLevel; maxTokens?: number; thinkingBudgets?: ChatOptions['thinkingBudgets'] };
type SimpleResult = { stopReason: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } };
type SimpleBody = Record<string, unknown> & { inferenceConfig: { maxTokens: number; temperature?: number } };
type SimpleStoredRow = { model: string; case: string; entrypoint: string; callerOptions: SimpleCaller; requests: Array<{ body: SimpleBody }>; result: SimpleResult };
type CapturedMessage = { role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  timestamp: number; provider?: string; model?: string; api?: string; usage?: SimpleResult['usage']; stopReason?: string };
const simpleDefaultBytes = readFileSync(new URL('../../../../tests/fixtures/bedrock-simple-defaults-reference.json', import.meta.url));
const simpleDefaults = JSON.parse(simpleDefaultBytes.toString()) as { rows: Array<{ sourceIndex: number; observed: SimpleStoredRow }> };
const simpleNumericBytes = readFileSync(new URL('../../../../tests/fixtures/bedrock-simple-numeric-reference.json', import.meta.url));
const simpleNumeric = JSON.parse(simpleNumericBytes.toString()) as { models: Array<{ id: string }>; rows: Array<{ expectedCoreRefusal: boolean; observed: SimpleStoredRow }> };
const simpleContextBytes = readFileSync(new URL('../../../../tests/fixtures/bedrock-simple-context-reference.json', import.meta.url));
const simpleContext = JSON.parse(simpleContextBytes.toString()) as { replyFramesBase64: string; rows: Array<{ model: string; case: string; callerOptions: SimpleCaller;
  context: { messages: CapturedMessage[] }; request: { body: SimpleBody }; sdkResult: SimpleResult; expectedCoreRefusal: boolean }> };
const numericIds = new Set(simpleNumeric.models.map(model => model.id));
const numericLevels = { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
const known = reference.models[0];
function observedResponse(value: unknown, binary: boolean): Response {
  return binary ? response(bedrockText('ok', 'end_turn', value)) : new Response(JSON.stringify({
    model: 'untrusted-response-alias', output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: value,
  }), { headers: { 'content-type': 'application/json' } });
}

function selectedSimpleOptions(model: string, caller: SimpleCaller): ChatOptions {
  const { reasoning, ...options } = structuredClone(caller);
  return { ...options, model, thinking: reasoning, temperature: 0.7, systemPrompt: 'owned tool system', cacheRetention: 'none' };
}
function capturedMessages(source: CapturedMessage[]): Message[] {
  expect(source[0]).toEqual({ role: 'system', content: 'owned tool system', timestamp: 0 });
  // Explicit SDK-to-Core fixture projection, not automatic host provenance.
  return source.slice(1).map((message, index) => ({ id: String(index), role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text' ? block.text : '').join(''),
    ...(Array.isArray(message.content) ? { blocks: message.content.flatMap(block => block.type === 'image'
      ? [{ type: 'image' as const, mediaType: block.mimeType, url: `data:${block.mimeType};base64,${block.data}` }] : []) } : {}),
    timestamp: new Date(message.timestamp), provider: message.provider === 'amazon-bedrock' ? 'bedrock' : message.provider,
    model: message.model, api: message.api, metadata: { stopReason: message.stopReason },
    ...(message.usage ? { usage: { inputTokens: message.usage.input, outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite, totalTokens: message.usage.totalTokens } } : {}),
  }));
}
async function bindSelectedSimple(input: Message[], options: ChatOptions, body: SimpleBody, sdk: SimpleResult, refused = false): Promise<void> {
  const provider = create({ apiKey: 'disposable-selected-simple', model: options.model });
  for (const binary of [false, true]) {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => binary
      ? response(Buffer.from(simpleContext.replyFramesBase64, 'base64'))
      : observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, false));
    vi.stubGlobal('fetch', fetch);
    const before = structuredClone({ input, options }), failed = vi.fn(), complete = vi.fn(), chunk = vi.fn();
    let result: ChatResponse | undefined;
    if (refused) {
      if (binary) await provider.streamChat(input, chunk, complete, failed, options);
      else await expect(provider.chat(input, options)).rejects.toMatchObject({ message: 'Invalid Bedrock thinking allocation.' });
      if (binary) expect(failed.mock.calls[0]?.[0].message).toBe('Invalid Bedrock thinking allocation.');
      expect(fetch).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    } else {
      if (binary) { await provider.streamChat(input, chunk, complete, failed, options); result = complete.mock.calls[0]?.[0]; }
      else result = await provider.chat(input, options);
      expect(failed).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0][0])).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(options.model!)}/converse${binary ? '-stream' : ''}`);
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(body);
      expect(result).toMatchObject({ content: 'ok', model: options.model, api: 'bedrock-converse-stream' });
      // Both existing Core facades omit ordinary stop labels; retain the SDK/Core divergence explicitly.
      expect(sdk.stopReason).toBe('stop'); expect(result?.stopReason).toBeUndefined();
      expect(result?.usage).toMatchObject({ promptTokens: sdk.usage.input, completionTokens: sdk.usage.output,
        cacheReadTokens: sdk.usage.cacheRead, cacheWriteTokens: sdk.usage.cacheWrite, totalTokens: sdk.usage.totalTokens });
      expect(result?.usage?.costUsd).toBeCloseTo(sdk.usage.cost.total, 12);
    }
    expect({ input, options }).toEqual(before);
  }
}

describe('owned original Bedrock declarations, observed accounting and explicit ceilings', () => {
  it('binds 193 approved declarations to the executed source, preserving the separate legacy default', () => {
    expect(reference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
    expect(reference.catalogueSha256).toBe('df227d426b678e44cd82deae1cf433855d6b27f36fedcff3ef4fb812fe882868');
    expect(reference.captureSha256).toBe('6b27c0226ae372bde56def095c5ee06873385ff3ab52909add2f3db3f026b2bd');
    expect(reference.models).toHaveLength(193); expect(reference.cases).toHaveLength(666);
    expect(createHash('sha256').update(simpleDefaultBytes).digest('hex')).toBe('296d476e8a249cc4763935b1380e7b330ba04550b456883167c5db9a106717a2');
    expect(createHash('sha256').update(simpleNumericBytes).digest('hex')).toBe('1c13c5dafcd2364c7fdde4ba54f42c34bb5b08c9612c5da36bcbdafc233c682a');
    expect(createHash('sha256').update(simpleContextBytes).digest('hex')).toBe('c000978f0aab15c2b9e85655f6360818b9b529cf67c454f84332e7bf1806cb9b');
    expect(simpleDefaults.rows.map(row => row.observed.model)).toEqual(reference.models.map(model => model.id));
    expect(simpleNumeric.rows).toHaveLength(690); expect(simpleNumeric.rows.filter(row => row.expectedCoreRefusal)).toHaveLength(46);
    expect(simpleContext.rows).toHaveLength(211); expect(simpleContext.rows.filter(row => row.expectedCoreRefusal)).toHaveLength(47);
    expect(createHash('sha256').update(outputBoundaryBytes).digest('hex')).toBe('716ec438933f21d1579054d122f95c089985553fbb17c02dcc9adabff6c8327c');
    expect(outputBoundaryReference.pinnedCommit).toBe(reference.pinnedCommit); expect(outputBoundaryReference.catalogueSha256).toBe(reference.catalogueSha256);
    expect(outputBoundaryReference.captureSha256).toBe('23e552940581dfd233e7c617f337481803f34f091a71a23dfd5ef79808dd4e2a');
    expect(outputBoundaryReference.modelProjections).toBe(193); expect(outputBoundaryReference.vectors).toBe(1351); expect(outputBoundaryReference.freshSdkRequests).toBe(1351);
    expect(outputBoundaryReference.rows).toHaveLength(1351); expect([...new Set(outputBoundaryReference.rows.map(row => row.model))]).toEqual(reference.models.map(model => model.id));
    expect(createHash('sha256').update(toolSchemaBytes).digest('hex')).toBe('6d7f9341b36b41049e85a12a6a814c40952b6d2395a5fd79c8807cec43ac6ae1');
    expect(toolSchemaReference.pinnedCommit).toBe(reference.pinnedCommit); expect(toolSchemaReference.catalogueSha256).toBe(reference.catalogueSha256);
    expect(toolSchemaReference.captureSha256).toBe('f00528ffdfe80c91aeb74378d014c378b74293b4e17fc540d77f617bb9d73bc7');
    expect(toolSchemaReference.reuseCaptureSha256).toBe(outputBoundaryReference.captureSha256);
    expect(toolSchemaReference.modelProjections).toBe(193); expect(toolSchemaReference.vectors).toBe(579);
    expect(toolSchemaReference.freshSdkRequests).toBe(386); expect(toolSchemaReference.reusedSdkRequests).toBe(193);
    expect(toolSchemaReference.rows).toHaveLength(579); expect([...new Set(toolSchemaReference.rows.map(row => row.model))]).toEqual(reference.models.map(model => model.id));
    expect(createHash('sha256').update(reasoningBytes).digest('hex')).toBe('ed379ba9463355e2f6d1eb1814185d33b3c08b6253499402391632673e3b63aa');
    expect(reasoningReference.pinnedCommit).toBe(reference.pinnedCommit); expect(reasoningReference.catalogueSha256).toBe(reference.catalogueSha256);
    expect(reasoningReference.priorCaptureSha256).toBe('e35627194953d0d793c6a4fc53ffed34b0a91e120c62f40141803f9203763256');
    expect(reasoningReference.captureSha256).toBe('9011dc64aee4c190e78aff09f50521669f3aaaf3b769a1d2731dc6b742dfebeb');
    expect(reasoningReference.modelProjections).toBe(92); expect(reasoningReference.vectors).toBe(644); expect(reasoningReference.sdkBodyObservations).toBe(1288);
    expect(reasoningReference.freshSdkRequests).toBe(920); expect(reasoningReference.reusedSdkRequests).toBe(368);
    expect(reasoningReference.rows).toHaveLength(644); expect(reasoningReference.models).toHaveLength(92);
    expect(remainingReasoning).toHaveLength(637); expect(new Set(remainingReasoning.map(row => row.model)).size).toBe(91);
    expect([...new Set(reasoningReference.rows.map(row => row.model))]).toEqual(reasoningReference.models.map(model => model.id));
    expect(reference.models.filter(model => reasoningReference.models.some(row => row.id === model.id)).map(model => model.id)).toEqual(reasoningReference.models.map(model => model.id));
    expect(rawOutputReference.pinnedCommit).toBe(reference.pinnedCommit);
    expect(rawOutputReference.constructionCaptureSha256).toBe('2d160e9fa168b2eb2165c84a75e65cc09f0dda89acae34198266d690142aaca5');
    expect(rawOutputReference.successfulUsageCaptureSha256).toBe(reference.captureSha256);
    expect(rawOutputReference.rows.map(row => row.id)).toEqual(reference.models.map(model => model.id));
    expect(rawOutputReference.rows.filter(row => row.maxTokens === null)).toHaveLength(111);
    expect(rawOutputReference.rows.filter(row => row.maxTokens !== null)).toHaveLength(82);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const provider = create({ model: known.id });
    const published = provider.getPublishedModels?.() ?? [];
    const nonnumericMaps = new Map(reasoningReference.models.map(model => [model.id, model.thinkingLevelMap ?? {}]));
    expect(published.filter(row => reference.models.some(model => model.id === row.id))).toEqual(reference.models.map(model => ({
      id: model.id, name: model.name, api: model.api, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
      capabilities: { reasoning: model.reasoning, imageInput: model.input.includes('image'), toolCalls: true },
      pricing: { inputPerMillion: model.cost.input, outputPerMillion: model.cost.output, cacheReadPerMillion: model.cost.cacheRead, cacheWritePerMillion: model.cost.cacheWrite },
      thinkingLevelMap: numericIds.has(model.id) ? numericLevels : nonnumericMaps.get(model.id) ?? null,
    })));
    expect(published.find(row => row.id === 'anthropic.claude-3-haiku-20240307-v1:0')).toMatchObject({ name: 'Claude 3 Haiku (Bedrock)' });
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    let clampedCases = 0;
    for (const model of reasoningReference.models) {
      const map = model.thinkingLevelMap ?? {};
      const expected = levels.filter(level => map[level] !== null && (!['xhigh', 'max'].includes(level) || map[level] !== undefined));
      const available = getSupportedThinkingLevels('operator-bedrock', model.id, undefined, provider);
      expect(available, model.id).toEqual(expected);
      for (const level of levels) {
        const index = levels.indexOf(level);
        const selected = expected.includes(level) ? level : levels.slice(index).find(candidate => expected.includes(candidate))
          ?? levels.slice(0, index).reverse().find(candidate => expected.includes(candidate)) ?? 'off';
        expect(clampPublishedThinkingLevel(level, available), model.id + ':' + level).toBe(selected);
        if (selected !== level) clampedCases++;
      }
      published.find(row => row.id === model.id)!.thinkingLevelMap!.high = 'foreign';
      expect(provider.getPublishedModels?.().find(row => row.id === model.id)?.thinkingLevelMap).toEqual(map);
      expect(getSupportedThinkingLevels('operator-bedrock', model.id, undefined, provider)).toEqual(expected);
    }
    expect(clampedCases).toBe(59);
    expect(getSupportedThinkingLevels('operator-bedrock', 'unreviewed', undefined, provider)).toEqual(['off']);
    expect(fetch).not.toHaveBeenCalled();
  });

  for (const model of reference.models) it(`${model.id}: owns JSON/binary identity, pinned accounting and raw-module/simple-facade boundaries`, async () => {
    const provider = create({ apiKey: 'disposable-bedrock-reference', model: model.id });
    for (const vector of reference.cases.filter(row => row.model === model.id)) for (const binary of [false, true]) {
      const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
        expect(String(url)).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(model.id)}/converse${binary ? '-stream' : ''}`);
        return observedResponse(vector.observed, binary);
      }); vi.stubGlobal('fetch', fetch);
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(messages, () => {}, value => { result = value; }, undefined, { cacheRetention: 'long' });
      else result = await provider.chat(messages, { cacheRetention: 'long' });
      expect.soft(result).toMatchObject({ content: 'ok', model: model.id, api: model.api });
      const { costUsd, ...counts } = vector.expected;
      expect.soft(result?.usage).toMatchObject(counts);
      expect.soft(result?.usage?.costUsd).toBeCloseTo(costUsd!, 12);
      expect(fetch).toHaveBeenCalledOnce();
      const config = JSON.parse(fetch.mock.calls[0][1]!.body as string).inferenceConfig;
      // Rule projection for this legacy test input: one five-character user message, no system/tools.
      expect(config).toEqual({ maxTokens: Math.min(model.maxTokens, model.contextWindow - 4098) });
    }
    const defaults = simpleDefaults.rows.find(row => row.observed.model === model.id)!.observed;
    await bindSelectedSimple([{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }],
      selectedSimpleOptions(model.id, defaults.callerOptions), defaults.requests[0].body, defaults.result);
    const toolVectors = toolSchemaReference.rows.filter(row => row.model === model.id);
    expect(toolVectors.map(row => row.case)).toEqual(['raw-omitted', 'object', 'union-optional']);
    const vectors = outputBoundaryReference.rows.filter(row => row.model === model.id);
    expect(vectors.map(row => row.case)).toEqual(['raw-omitted', 'raw-one', 'raw-fifteen', 'raw-sixteen', 'raw-maximum', 'raw-temperature-zero', 'raw-temperature-one']);
    for (const vector of vectors) for (const binary of [false, true]) {
      const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary));
      vi.stubGlobal('fetch', fetch);
      const input = structuredClone(messages), options = { ...vector.options, model: model.id }, before = structuredClone({ input, options });
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(input, () => {}, value => { result = value; }, undefined, options);
      else result = await provider.chat(input, options);
      expect(result).toMatchObject({ content: 'ok', model: model.id, api: vector.api }); expect(fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
      // Keep the captured raw module facet separate from the selected simple facade allocation.
      const rawBody = { inferenceConfig: { ...(vector.options.maxTokens !== undefined ? { maxTokens: vector.options.maxTokens } : {}),
        ...(vector.options.temperature !== undefined ? { temperature: vector.options.temperature } : {}) } };
      applyBedrockProfileOutputPolicy(model.id, rawBody, vector.options.maxTokens);
      expect(rawBody.inferenceConfig, vector.case).toEqual(vector.expectedInferenceConfig);
      expect(body.inferenceConfig, vector.case).toEqual({ ...vector.expectedInferenceConfig,
        maxTokens: Math.min(vector.options.maxTokens ?? model.maxTokens, model.contextWindow - 4098) });
      if (vector.case === 'raw-omitted') {
        expect(toolVectors[0].expectedToolConfig).toBeNull(); expect(Object.hasOwn(body, 'toolConfig')).toBe(false);
      }
      expect({ input, options }).toEqual(before);
    }
    for (const vector of toolVectors.slice(1)) for (const binary of [false, true]) {
      const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary));
      vi.stubGlobal('fetch', fetch);
      const input = structuredClone(messages), options = { ...structuredClone(vector.options), model: model.id }, before = structuredClone({ input, options });
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(input, () => {}, value => { result = value; }, undefined, options);
      else result = await provider.chat(input, options);
      expect(result).toMatchObject({ content: 'ok', model: model.id, api: vector.api }); expect(fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
      expect(Object.hasOwn(body, 'toolConfig')).toBe(true); expect(body.toolConfig, vector.case).toEqual(vector.expectedToolConfig);
      expect({ input, options }).toEqual(before);
    }
    const reasoningVectors = remainingReasoning.filter(row => row.model === model.id);
    expect(reasoningVectors.map(row => row.thinking)).toEqual(remainingReasoning.some(row => row.model === model.id)
      ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : []);
    for (const vector of reasoningVectors) for (const binary of [false, true]) {
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(model.id)}/converse${binary ? '-stream' : ''}`);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer disposable-bedrock-reference');
        return observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary);
      }); vi.stubGlobal('fetch', fetch);
      const input: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
      const options = { ...structuredClone(vector.options), model: model.id }, before = structuredClone({ input, options });
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(input, () => {}, value => { result = value; }, undefined, options);
      else result = await provider.chat(input, options);
      expect(result).toMatchObject({ content: 'ok', model: model.id, api: vector.api }); expect(fetch).toHaveBeenCalledOnce();
      expect({ input, options }).toEqual(before);
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string), vector.thinking).toEqual(vector.expectedBody);
    }
    const available = getSupportedThinkingLevels('operator-bedrock', model.id, undefined, provider);
    const hostVectors = reasoningReference.rows.filter(row => row.model === model.id && clampPublishedThinkingLevel(row.thinking, available) !== row.thinking);
    for (const vector of hostVectors) for (const binary of [false, true]) {
      const thinking = clampPublishedThinkingLevel(vector.thinking, available);
      const expected = reasoningReference.rows.find(row => row.model === model.id && row.thinking === thinking)!;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(model.id)}/converse${binary ? '-stream' : ''}`);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer disposable-bedrock-reference');
        return observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary);
      }); vi.stubGlobal('fetch', fetch);
      const input: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
      const options = { ...structuredClone(vector.options), model: model.id, thinking }, before = structuredClone({ input, options });
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(input, () => {}, value => { result = value; }, undefined, options);
      else result = await provider.chat(input, options);
      expect(result).toMatchObject({ content: 'ok', model: model.id, api: vector.api }); expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string), vector.thinking + '→' + thinking).toEqual(expected.expectedBody);
      expect({ input, options }).toEqual(before);
    }
  });

  for (const model of simpleNumeric.models) {
    it(`${model.id}: binds selected simple numeric allocations and pretransport safety refusals`, async () => {
      // The193-model default loop already binds the23 overlapping simple-omitted source rows.
      const rows = simpleNumeric.rows.filter(row => row.observed.model === model.id && row.observed.entrypoint === 'streamSimple' && row.observed.case !== 'simple-omitted');
      expect(rows).toHaveLength(14);
      for (const row of rows) await bindSelectedSimple([{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }],
        selectedSimpleOptions(model.id, row.observed.callerOptions), row.observed.requests[0].body, row.observed.result, row.expectedCoreRefusal);
    });
    it(`${model.id}: binds selected simple context chronology, image and custom boundaries`, async () => {
      for (const row of simpleContext.rows.filter(row => row.model === model.id)) await bindSelectedSimple(capturedMessages(row.context.messages),
        selectedSimpleOptions(model.id, row.callerOptions), row.request.body, row.sdkResult, row.expectedCoreRefusal);
    });
  }

  it('keeps native defaults private and per-turn without changing explicit caps, derived/unknown transports or the legacy default', async () => {
    const target = rawOutputReference.rows.find(row => row.maxTokens !== null)!;
    const native = create({ model: known.id });
    const published = native.getPublishedModels()?.find(row => row.id === target.id)!;
    published.maxOutputTokens = 1; native.getPublishedModels = () => [published]; native.getModelApi = () => 'forged';
    const options = Object.defineProperty({ model: target.id }, 'thinkingBudgets', { get() { throw new Error('Unused budget map was read.'); } });
    class Compatible extends BedrockProvider {}
    for (const binary of [false, true]) for (const [provider, selected, maximum] of [
      [native, options, target.maxTokens],
      [native, { model: target.id, maxTokens: 1 }, 1],
      [native, { model: target.id, maxTokens: target.maxTokens! }, target.maxTokens],
      [new Compatible({ type: 'bedrock', apiKey: 'disposable-bedrock-reference', model: target.id }), undefined, undefined],
      [create({ model: 'anthropic.claude-unreviewed' }), undefined, undefined],
      [create({ model: undefined }), undefined, undefined],
    ] as const) {
      const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary));
      vi.stubGlobal('fetch', fetch);
      if (binary) await provider.streamChat(messages, () => {}, undefined, undefined, selected);
      else await provider.chat(messages, selected);
      expect(fetch).toHaveBeenCalledOnce();
      const config = JSON.parse(fetch.mock.calls[0][1]!.body as string).inferenceConfig;
      expect(Object.hasOwn(config, 'maxTokens')).toBe(maximum !== undefined);
      expect(config.maxTokens).toBe(maximum);
    }
    const high = remainingReasoning.find(row => row.model === target.id && row.thinking === 'high')!;
    const off = remainingReasoning.find(row => row.model === target.id && row.thinking === 'off')!;
    for (const binary of [false, true]) for (const [provider, selected, thinking, expected] of [
      [native, target.id, 'high', high.expectedBody],
      [native, target.id, 'off', off.expectedBody],
      [native, target.id, undefined, off.expectedBody],
      [native, known.id, 'high', off.expectedBody],
      [new Compatible({ type: 'bedrock', apiKey: 'disposable-bedrock-reference', model: target.id }), target.id, 'high', off.expectedBody],
      [create({ model: 'anthropic.claude-unreviewed' }), 'anthropic.claude-unreviewed', 'high', off.expectedBody],
      [create({ model: undefined }), 'anthropic.claude-3-haiku-20240307-v1:0', 'high', off.expectedBody],
    ] as const) {
      const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary));
      vi.stubGlobal('fetch', fetch);
      const input: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
      const unused = vi.fn(() => { throw new Error('Unused numeric budget map was read.'); });
      const selectedBase: ChatOptions = { ...high.options, model: selected };
      if (thinking === undefined) delete selectedBase.thinking; else selectedBase.thinking = thinking;
      const selectedOptions = Object.defineProperty(selectedBase, 'thinkingBudgets', { get: unused });
      if (binary) await provider.streamChat(input, () => {}, undefined, undefined, selectedOptions);
      else await provider.chat(input, selectedOptions);
      expect(fetch).toHaveBeenCalledOnce(); expect(unused).not.toHaveBeenCalled();
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(expected);
      expect(Object.getOwnPropertyDescriptor(selectedOptions, 'thinkingBudgets')?.get).toBe(unused);
    }
    // Source-reviewed Pi GovCloud branch, not additional SDK wire observations.
    for (const model of [target.id, 'anthropic.claude-sonnet-4-6']) for (const binary of [false, true]) {
      const vector = remainingReasoning.find(row => row.model === model && row.thinking === 'high')!;
      const expected = structuredClone(vector.expectedBody) as { additionalModelRequestFields: { thinking: Record<string, unknown>; anthropic_beta?: unknown } };
      delete expected.additionalModelRequestFields.thinking.display; delete expected.additionalModelRequestFields.thinking.block_binding;
      delete expected.additionalModelRequestFields.anthropic_beta;
      const provider = create({ model, region: 'us-gov-west-1' });
      const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary)); vi.stubGlobal('fetch', fetch);
      const input: Message[] = [{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }];
      if (binary) await provider.streamChat(input, () => {}, undefined, undefined, vector.options);
      else await provider.chat(input, vector.options);
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(expected);
    }
  });

  it('refuses malformed numeric levels/maps unread while leaving off, unknown and derived maps opaque', async () => {
    const model = simpleNumeric.models[0].id, provider = create({ apiKey: 'disposable', model });
    const get = vi.fn(() => 16384), map = Object.defineProperty({}, 'high', { enumerable: true, get });
    const invalid: Array<[ChatOptions, string]> = [
      ...['private-level', '__proto__', null, 1].map(thinking => [{ thinking: thinking as ThinkingLevel }, 'Invalid Bedrock reasoning level.'] as [ChatOptions, string]),
      ...[-1, 1.5, Infinity, NaN].map(high => [{ thinking: 'high', thinkingBudgets: { high } },
        'Thinking budgets must contain only safe nonnegative integer minimal/low/medium/high values.'] as [ChatOptions, string]),
      [{ thinking: 'high', thinkingBudgets: map }, 'Thinking budgets must contain only safe nonnegative integer minimal/low/medium/high values.'],
    ];
    const fetch = vi.fn(async () => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, false)); vi.stubGlobal('fetch', fetch);
    for (const [options, diagnostic] of invalid) {
      const error = vi.fn(), complete = vi.fn(), chunk = vi.fn();
      await expect(provider.chat(messages, options)).rejects.toMatchObject({ message: diagnostic });
      await provider.streamChat(messages, chunk, complete, error, options);
      expect(error.mock.calls[0]?.[0].message).toBe(diagnostic); expect(complete).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    class Compatible extends BedrockProvider {}
    for (const [owner, thinking] of [[provider, 'off'], [create({ model: 'unknown' }), 'high'],
      [new Compatible({ type: 'bedrock', apiKey: 'disposable', model }), 'high']] as const) {
      for (const binary of [false, true]) {
        const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, binary)); vi.stubGlobal('fetch', fetch);
        const options = { thinking, thinkingBudgets: map, maxTokens: 64 };
        if (binary) await owner.streamChat(messages, () => {}, undefined, undefined, options); else await owner.chat(messages, options);
        expect(fetch).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled();
        expect(Object.hasOwn(JSON.parse(fetch.mock.calls[0][1]!.body as string), 'additionalModelRequestFields')).toBe(false);
      }
    }
  });

  it('refuses callable context carriers before JSON/binary dispatch without executing accessors', async () => {
    const provider = create({ apiKey: 'disposable', model: 'anthropic.claude-haiku-4-5-20251001-v1:0' });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const field of ['usage', 'metadata'] as const) {
      const get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); });
      const carrier = Object.defineProperty(() => {}, field === 'usage' ? 'totalTokens' : 'stopReason', { get });
      const input: Message = { ...messages[0], role: 'assistant', usage: { totalTokens: 1 } };
      Object.defineProperty(input, field, { value: carrier, enumerable: true });
      const options: ChatOptions = { maxTokens: 64, thinking: 'off' }, before = Object.getOwnPropertyDescriptors(input);
      await expect(provider.chat([input], options)).rejects.toThrow('Provider native output policy is invalid.');
      const chunk = vi.fn(), complete = vi.fn(), error = vi.fn();
      await provider.streamChat([input], chunk, complete, error, options);
      expect(error).toHaveBeenCalledTimes(1); expect(error.mock.calls[0][0].message).toBe('Provider native output policy is invalid.');
      expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptors(input)).toEqual(before); expect(options).toEqual({ maxTokens: 64, thinking: 'off' });
    }
  });

  it('refuses invalid explicit or effective native ceilings before dispatch, independently of public metadata', async () => {
    const fetch = vi.fn(async () => observedResponse({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, false)); vi.stubGlobal('fetch', fetch);
    for (const model of reference.models) {
      const provider = create({ apiKey: 'disposable-bedrock-reference', model: model.id });
      const published = provider.getPublishedModels?.()?.find(row => row.id === model.id);
      if (published) published.maxOutputTokens = Number.MAX_SAFE_INTEGER;
      for (const maxTokens of [0, -1, 1.5, NaN, Infinity, model.maxTokens + 1]) {
        await expect(provider.chat(messages, { maxTokens })).rejects.toThrow('Invalid Bedrock output limit.');
        const error = vi.fn(), complete = vi.fn();
        await provider.streamChat(messages, () => {}, complete, error, { maxTokens });
        expect(error.mock.calls[0]?.[0].message).toBe('Invalid Bedrock output limit.'); expect(complete).not.toHaveBeenCalled();
      }
    }
    const native = create({ apiKey: 'disposable-bedrock-reference', model: remainingReasoning[0].model });
    for (const thinking of ['private-level', '__proto__', null, 1]) {
      const options = { thinking, maxTokens: 64 } as unknown as ChatOptions;
      await expect(native.chat(messages, options)).rejects.toThrow('Invalid Bedrock reasoning level.');
      const failed = vi.fn(), complete = vi.fn(), chunk = vi.fn();
      await native.streamChat(messages, chunk, complete, failed, options);
      expect(failed.mock.calls[0]?.[0].message).toBe('Invalid Bedrock reasoning level.');
      expect(complete).not.toHaveBeenCalled(); expect(chunk).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures native per-call identity before callbacks and cannot price response aliases or forged public declarations', async () => {
    const target = reference.models.find(model => model.cost.input !== known.cost.input)!;
    const provider = create({ apiKey: 'disposable-bedrock-reference', model: known.id });
    provider.getProviderType = () => 'operator-alias'; provider.getModelApi = () => 'forged-api';
    provider.getPublishedModels = () => [{ id: target.id, name: 'forged', api: 'forged-api', capabilities: { reasoning: false, imageInput: false, toolCalls: false }, pricing: { inputPerMillion: 1e9 } }];
    const vector = reference.cases.find(row => row.model === target.id && row.case === 'base-short')!;
    for (const binary of [false, true]) {
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain(`/model/${encodeURIComponent(target.id)}/converse`);
        provider.setConfiguredModel('response-alias'); return observedResponse(vector.observed, binary);
      }));
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(messages, () => { provider.setConfiguredModel('callback-alias'); }, value => { result = value; }, undefined, { model: target.id });
      else result = await provider.chat(messages, { model: target.id });
      expect(result).toMatchObject({ model: target.id, api: 'bedrock-converse-stream' });
      expect(result?.usage?.costUsd).toBeCloseTo(vector.expected.costUsd!, 12);
    }
  });

  it('omits incomplete/malformed native usage instead of manufacturing counters or inferred TTL cost', async () => {
    const provider = create({ apiKey: 'disposable-bedrock-reference', model: known.id });
    for (const value of [undefined, null, {}, { inputTokens: 7 }, { inputTokens: 7, outputTokens: 2 },
      { inputTokens: -1, outputTokens: 2, totalTokens: 1 }, { inputTokens: 1.5, outputTokens: 2, totalTokens: 4 },
      { inputTokens: 7, outputTokens: 2, totalTokens: 8 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2, totalTokens: Number.MAX_SAFE_INTEGER },
      { inputTokens: 7, outputTokens: 2, totalTokens: 9, cacheReadInputTokens: null },
      { inputTokens: 7, outputTokens: 2, totalTokens: 10, cacheWriteInputTokens: 1, cacheDetails: [{ ttl: '1h', inputTokens: 2 }] },
      { inputTokens: 7, outputTokens: 2, totalTokens: 10, cacheWriteInputTokens: 1, cacheDetails: [{ ttl: 'private-ttl', inputTokens: 1 }] },
      { inputTokens: 7, outputTokens: 2, totalTokens: 10, cacheWriteInputTokens: 1, cacheDetails: [{ ttl: { toString: 'private-ttl' }, inputTokens: 1 }] }]) {
      for (const binary of [false, true]) {
        vi.stubGlobal('fetch', vi.fn(async () => observedResponse(value, binary)));
        let result: ChatResponse | undefined;
        if (binary) await provider.streamChat(messages, () => {}, completed => { result = completed; }); else result = await provider.chat(messages);
        expect.soft(result?.usage).toBeUndefined();
      }
    }
  });

  it('preserves unattributed totals without automatic base-rate cost and keeps derived/unknown transports legacy', async () => {
    const provider = create({ model: known.id });
    const value = { inputTokens: 7, outputTokens: 2, totalTokens: 11 };
    for (const binary of [false, true]) {
      vi.stubGlobal('fetch', vi.fn(async () => observedResponse(value, binary)));
      let result: ChatResponse | undefined;
      if (binary) await provider.streamChat(messages, () => {}, completed => { result = completed; }); else result = await provider.chat(messages);
      expect(result?.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
    class Compatible extends BedrockProvider {}
    const derived = new Compatible({ type: 'bedrock', apiKey: 'disposable-bedrock-reference', model: known.id });
    expect(derived.getPublishedModels?.()).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => observedResponse({ inputTokens: 7, outputTokens: 2, totalTokens: 9 }, false)));
    expect((await derived.chat(messages, { maxTokens: Number.MAX_SAFE_INTEGER })).usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
    expect((await create({ model: 'unknown', apiKey: 'disposable-bedrock-reference' }).chat(messages)).usage?.costUsd).toBeUndefined();
  });
});
