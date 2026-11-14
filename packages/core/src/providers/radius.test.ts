import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadiusProvider, RADIUS_MODELS, normalizeProviderUsage, ProviderFactory, type ChatResponse } from './index.js';
import { RadiusProtocolError } from './radius.js';
import { SpecializedModels } from './specialized-models.js';
import { createProviderNetworkScope, closeProviderNetworkDispatchers, PROVIDER_NETWORK_SCOPE } from './provider-network.js';
import { SessionManager, JsonlSessionStore } from '../sessions/session-manager.js';
import type { Message } from '../types/index.js';

const key = 'synthetic-radius-key';
const user = (): Message => ({ id: 'user', role: 'user', content: 'question', timestamp: new Date(0) });
const usage = { input: 8, output: 2, cacheRead: 1, cacheWrite: 1, totalTokens: 12, cost: { input: 0.1, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.127 } };
const frames = (): Array<Record<string, any>> => [
  { type: 'start' }, { type: 'thinking_start', contentIndex: 0 }, { type: 'thinking_delta', contentIndex: 0, delta: 'thought' },
  { type: 'thinking_end', contentIndex: 0, content: 'thought', contentSignature: 'private-thinking-signature' },
  { type: 'thinking_start', contentIndex: 1 }, { type: 'thinking_delta', contentIndex: 1, delta: 'redacted-private-payload' },
  { type: 'thinking_end', contentIndex: 1, content: 'redacted-private-payload', contentSignature: 'private-redacted-signature', redacted: true },
  { type: 'text_start', contentIndex: 2 }, { type: 'text_delta', contentIndex: 2, delta: 'answer' },
  { type: 'text_end', contentIndex: 2, content: 'answer', contentSignature: 'private-text-signature' },
  { type: 'toolcall_start', contentIndex: 3, id: 'call-1', toolName: 'echo' }, { type: 'toolcall_delta', contentIndex: 3, delta: '{"x":1}' },
  { type: 'toolcall_end', contentIndex: 3, toolCall: { id: 'call-1', name: 'echo', arguments: { x: 1 }, thoughtSignature: 'private-tool-signature' } },
  { type: 'done', reason: 'toolUse', usage, providerThinkingLevel: 'high' },
];
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(reply = () => frames()) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(reply().map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Ftenant/v1`;
  const config = { type: 'owned-radius', apiKey: key, baseUrl };
  return { calls, baseUrl, config, provider: new RadiusProvider(config) };
}
function assistant(result: ChatResponse): Message {
  return { id: 'assistant', role: 'assistant', content: result.content, blocks: result.blocks, toolCalls: result.toolCalls,
    provider: result.provider, model: result.model, api: result.api, usage: normalizeProviderUsage(result.usage), timestamp: new Date(1) };
}

describe('explicit native Radius P SDK', () => {
  it('owns all29 pinned P declarations without a factory, discovery, vendor-policy alias or effective image preparation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const source = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/radius.json', import.meta.url), 'utf8'))['pi-messages'] as Record<string, any>;
    expect(RADIUS_MODELS).toHaveLength(29);
    for (const model of RADIUS_MODELS) {
      const raw = source[`chat:${model.id}`];
      expect(model).toMatchObject({ name: raw.name, api: 'pi-messages', contextWindow: raw.contextWindow, maxOutputTokens: raw.maxTokens, declaredInput: raw.input,
        pricing: { inputPerMillion: raw.cost.input, outputPerMillion: raw.cost.output, cacheReadPerMillion: raw.cost.cacheRead, cacheWritePerMillion: raw.cost.cacheWrite } });
      expect(model.thinkingLevelMap).toEqual(raw.thinkingLevelMap);
      expect(model.pricingTiers).toEqual((raw.cost.tiers ?? []).map((tier: Record<string, number>) => ({ inputTokensAbove: tier.inputTokensAbove,
        inputPerMillion: tier.input, outputPerMillion: tier.output, cacheReadPerMillion: tier.cacheRead, cacheWritePerMillion: tier.cacheWrite })));
      expect(model.imageResizeLimits).toEqual(raw.inputLimits?.images.resize);
    }
    const provider = new RadiusProvider({ type: 'operator-label', apiKey: key });
    expect(provider.getPublishedModels()).toHaveLength(29); expect(await provider.getAvailableModels()).toHaveLength(29);
    expect(provider.getModelApi('gpt-6-luna')).toBe('pi-messages'); expect(provider.canDiscoverModels()).toBe(false);
    expect(ProviderFactory.has('radius')).toBe(false); expect(fetch).not.toHaveBeenCalled();
    expect(() => new RadiusProvider({ type: 'radius', model: 'unknown', apiKey: key })).toThrow('not supported');
  });

  it('posts the P context/options envelope, not C/A/R, and publishes ordered complete blocks with disjoint observed usage', async () => {
    const { provider, calls } = await fixture(), chunks: unknown[] = [];
    let result: ChatResponse | undefined;
    await provider.streamChat([user()], (chunk, event) => { chunks.push({ chunk, event }); }, response => { result = response; }, error => { throw error; }, {
      systemPrompt: 'system', maxTokens: 64, temperature: 0.2, thinking: 'high', cacheRetention: 'long', sessionId: 'branch',
      tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }], toolChoice: { type: 'function', function: { name: 'echo' } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/proxy%2Ftenant/v1/messages', headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' }, body: {
      model: 'balanced', context: { systemPrompt: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }], timestamp: 0 }], tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }] },
      options: { maxTokens: 64, temperature: 0.2, reasoning: 'high', cacheRetention: 'long', sessionId: 'branch', toolChoice: { type: 'function', function: { name: 'echo' } } },
    } });
    expect(calls[0].body).not.toHaveProperty('messages'); expect(calls[0].body).not.toHaveProperty('stream');
    expect(result).toMatchObject({ provider: 'owned-radius', model: 'balanced', api: 'pi-messages', content: 'answer', reasoning: 'thought', providerThinkingLevel: 'high',
      usage: { promptTokens: 8, completionTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, totalTokens: 12, costUsd: 0.127 }, toolCalls: [{ id: 'call-1', name: 'echo', input: { x: 1 } }] });
    expect(result?.blocks?.map(block => block.type)).toEqual(['reasoning', 'reasoning', 'text', 'tool_call']);
    expect(result?.blocks?.[1]).toMatchObject({ type: 'reasoning', redacted: true, text: '' });
    expect(JSON.stringify(chunks)).not.toContain('redacted-private-payload'); expect(JSON.stringify(chunks)).not.toContain('signature');
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('replays owned opaque fields after private v2 reload and keeps native tool pairs without exposing them to another key/endpoint/model/owner', async () => {
    const opaque = 'redacted-private-payload'.repeat(4000);
    const { provider, calls, config, baseUrl } = await fixture(() => { const values = frames(); values[6]!.content = opaque; return values; });
    const result = await provider.chat([user()]);
    const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-replay-')); roots.push(root); await mkdir(path.join(root, 'sessions'));
    const directory = path.join(root, 'sessions'), manager = new SessionManager({ store: new JsonlSessionStore(directory) }), session = await manager.create();
    const { id: _id, timestamp: _timestamp, ...recorded } = assistant(result);
    await manager.addMessage(session.id, recorded);
    const restored = new SessionManager({ store: new JsonlSessionStore(directory) }); await restored.loadFromStore(session.id);
    const kept = restored.get(session.id)!.messages[0]!; expect(kept).toBeDefined();
    const history = [user(), kept, { id: 'tool', role: 'tool' as const, content: 'echoed', toolCallId: 'call-1', timestamp: new Date(2) }];
    await new RadiusProvider(config).chat(history);
    const native = calls.at(-1)!.body.context.messages;
    expect(native[1].content).toEqual([
      { type: 'thinking', thinking: 'thought', thinkingSignature: 'private-thinking-signature' },
      { type: 'thinking', thinking: opaque, thinkingSignature: 'private-redacted-signature', redacted: true },
      { type: 'text', text: 'answer', textSignature: 'private-text-signature' },
      { type: 'toolCall', id: 'call-1', name: 'echo', arguments: { x: 1 }, thoughtSignature: 'private-tool-signature' },
    ]);
    expect(native[2]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', toolName: 'echo', isError: false, content: [{ type: 'text', text: 'echoed' }] });
    class Derived extends RadiusProvider {}
    for (const peer of [new RadiusProvider({ ...config, apiKey: 'synthetic-other-key' }), new RadiusProvider({ ...config, baseUrl: baseUrl.replace('/proxy', '/other') }),
      new RadiusProvider({ ...config, type: 'other-owner' }), new RadiusProvider({ ...config, model: 'cheap' }), new Derived(config)]) {
      const result = await peer.chat(history);
      if (peer instanceof Derived) expect(JSON.stringify(result)).not.toMatch(/private-payload|private-.*signature/);
      const body = JSON.stringify(calls.at(-1)!.body);
      expect(body).toContain('thought'); expect(body).toContain('echoed'); expect(body).not.toMatch(/private-payload|private-.*signature|thinkingSignature|thoughtSignature|textSignature/);
    }
    expect((await stat(path.join(directory, `${session.id}.jsonl`))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(directory, `${session.id}.jsonl`), 'utf8')).not.toContain(key);
  });

  it.each(['EOF', 'unfinished', 'wrong-kind', 'changed-tool', 'index', 'no-call'] as const)('refuses %s before successful tools/completion', async kind => {
    const malformed = frames();
    if (kind === 'EOF') malformed.pop();
    if (kind === 'unfinished') malformed.splice(malformed.length - 2, 1);
    if (kind === 'wrong-kind') malformed[2]!.type = 'text_delta';
    if (kind === 'changed-tool') malformed[malformed.length - 2]!.toolCall.name = 'other';
    if (kind === 'index') malformed[1]!.contentIndex = 1000;
    if (kind === 'no-call') malformed.splice(10, 3);
    const { provider } = await fixture(() => malformed), completed = vi.fn(), failed = vi.fn();
    await provider.streamChat([user()], () => undefined, completed, failed);
    expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); expect(failed.mock.calls[0]![0]).toBeInstanceOf(RadiusProtocolError);
  });

  it('retains only observed failed terminal usage and fixed diagnostics through the finite SDK bridge', async () => {
    const { provider, calls } = await fixture(() => [{ type: 'error', reason: 'error', errorMessage: `Bearer ${key}`, usage }]);
    const error = await provider.chat([user()]).catch(error => error);
    expect(error).toMatchObject({ message: 'Radius request failed.', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 12, costUsd: 0.127 } });
    expect(Object.isFrozen(error.usage)).toBe(true); expect(JSON.stringify(error)).not.toContain(key);
    const failed = await new SpecializedModels(provider).classify({ model: 'balanced:classifier', input: 'question', labels: ['yes', 'no'] }).catch(error => error);
    expect(failed.usage).toMatchObject({ totalTokens: 12, costUsd: 0.127 }); expect(calls).toHaveLength(2);
  });

  it('refuses local unsupported inputs and preserves raw omission rather than fabricating backend defaults', async () => {
    const { provider, calls, config } = await fixture();
    for (const options of [{ maxTokens: 0 }, { maxTokens: 131073 }, { temperature: -1 }, { model: 'unknown' }]) await expect(provider.chat([user()], options)).rejects.toThrow('Radius request failed.');
    await expect(new RadiusProvider({ ...config, apiKey: undefined }).chat([user()])).rejects.toThrow('Radius request failed.');
    await expect(provider.chat([{ ...user(), blocks: [{ type: 'image', mediaType: 'image/png', url: 'https://never-fetch.test/image' }] }])).rejects.toThrow('Radius request failed.');
    expect(calls).toHaveLength(0);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
    const image: Message = { ...user(), blocks: [{ type: 'image', mediaType: 'image/png', url: `data:image/png;base64,${png}` }] };
    await provider.chat([image], { thinking: 'off' }); expect(calls[0]!.body.options).toEqual({});
    expect(calls[0]!.body.context.messages[0].content).toEqual([{ type: 'text', text: 'question' }, { type: 'image', mimeType: 'image/png', data: png }]);
    await expect(new RadiusProvider({ ...config, model: 'glm-5.3' }).chat([image])).rejects.toThrow('Radius request failed.');
    expect(calls).toHaveLength(1);
  });

  it('normalizes explicit length without tools and keeps missing counters/prices unknown', async () => {
    const values = frames(); values.splice(10, 3); values.at(-1)!.reason = 'length'; values.at(-1)!.usage = { input: 8, output: 2, totalTokens: 12 };
    const { provider } = await fixture(() => values);
    const result = await provider.chat([user()]);
    expect(result).toMatchObject({ content: 'answer', stopReason: 'length', usage: { promptTokens: 8, completionTokens: 2, totalTokens: 12 } });
    expect(result.toolCalls).toBeUndefined(); expect(result.usage?.costUsd).toBeUndefined(); expect(result.usage?.cacheReadTokens).toBeUndefined();
  });

  it('cancels a pending body read without waiting for a hostile source cancellation', async () => {
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    const cancel = vi.fn(() => new Promise<never>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"start"}\n\ndata: {"type":"text_start","contentIndex":0}\n\n')); },
      pull() { entered(); return new Promise<never>(() => undefined); }, cancel });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const controller = new AbortController(), provider = new RadiusProvider({ type: 'radius', apiKey: key });
    const pending = provider.chat([user()], { signal: controller.signal }).catch(error => error);
    await reached; controller.abort();
    expect(await pending).toMatchObject({ message: 'Radius request aborted.' }); expect(cancel).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['caller', 'scope'] as const)('cancels a hostile chunk callback through the %s lifetime without late successful publication', async lifetime => {
    const { config, calls } = await fixture(), controller = new AbortController(), scope = createProviderNetworkScope();
    const scoped = { ...config, [PROVIDER_NETWORK_SCOPE]: scope }, provider = new RadiusProvider(scoped);
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    const completed = vi.fn(), failed = vi.fn();
    const pending = provider.streamChat([user()], async () => { entered(); await new Promise<never>(() => undefined); }, completed, failed, { signal: controller.signal });
    await reached;
    if (lifetime === 'caller') controller.abort(); else await closeProviderNetworkDispatchers(scope);
    await pending; expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); expect(failed.mock.calls[0]![0].message).toBe('Radius request aborted.');
    await provider.chat([user()]); expect(calls).toHaveLength(2); await closeProviderNetworkDispatchers(scope, { permanent: true });
  });
});
