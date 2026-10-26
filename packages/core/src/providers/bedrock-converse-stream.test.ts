import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { BedrockProvider, bedrockCredentialConfig, type ChatResponse } from './index.js';
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
