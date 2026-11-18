import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, CacheWarmer, ExtensionRegistry, SessionManager, streamProviderTurn, type ChatResponse, type Message, type TokenUsage } from '../../dist/index.js';
const model = 'claude-fable-5', targets = ['claude-opus-4-8', 'claude-opus-5'];
const config = { type: 'native-fable-alias', apiKey: 'synthetic-fable-key', baseUrl: 'https://anthropic.synthetic', model };
const messages: Message[] = [{ id: 'u', role: 'user', timestamp: new Date(0), content: 'synthetic fallback' }];
const marker = (from = model, to = targets[0]) => ({ type: 'fallback', from: { model: from }, to: { model: to } });
const content = [{ type: 'thinking', thinking: 'visible', signature: 'synthetic-fable-fallback-signature' }, { type: 'text', text: 'fallback-ready' }, { type: 'tool_use', id: 'lookup-1', name: 'lookup', input: {} }];
const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 };
function answer(stream: boolean, blocks: unknown[], observed: unknown = usage, responseModel = targets[0], terminal = true) {
  if (!stream) return Response.json({ type: 'message', role: 'assistant', model: responseModel, content: blocks, stop_reason: 'tool_use', usage: observed });
  const events: unknown[] = [{ type: 'message_start', message: { type: 'message', role: 'assistant', model: responseModel, usage: observed } }];
  blocks.forEach((block, index) => events.push({ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }));
  if (terminal) events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: observed }, { type: 'message_stop' });
  return new Response(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}
async function call(provider: AnthropicProvider, stream: boolean) {
  if (!stream) return provider.chat(messages);
  let result: ChatResponse | undefined;
  await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; });
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('binds exactly one nominated native profile and its ordered target costs to the existing pinned full catalogue', () => {
  const bytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-reference.json', import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('327ea610aca64889902458243e9b6a440eb678671f5993b88ad32ac6e827b587');
  const rows = Object.values(JSON.parse(bytes.toString())['anthropic-messages']) as Array<{ id: string; compat?: { allowedFallbackModels?: unknown[] } }>;
  expect(rows).toHaveLength(17);
  expect(rows.filter(row => row.compat?.allowedFallbackModels?.length).map(row => ({ id: row.id, targets: row.compat!.allowedFallbackModels }))).toEqual([
    { id: model, targets: targets.map(model => ({ provider: 'anthropic', model, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })) },
  ]);
});
it('requests only native Fable fallbacks/beta and accepts prefix transitions while retaining logical replay identity and target price', async () => {
  const bodies: Array<Record<string, unknown>> = [], headers: Headers[] = []; let target = targets[0], blocks: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); headers.push(new Headers(init.headers)); return answer(body.stream === true, blocks, usage, target); }));
  const provider = new AnthropicProvider(config);
  for (const [index, served] of targets.entries()) for (const stream of [false, true]) {
    target = served; blocks = [marker(), ...(index ? [marker(targets[0], targets[1])] : []), ...content];
    const result = (await call(provider, stream))!;
    expect(result).toMatchObject({ model, provider: config.type, api: 'anthropic-messages', content: 'fallback-ready', toolCalls: [{ id: 'lookup-1', name: 'lookup' }], usage: { totalTokens: 14 } });
    expect(result.blocks?.map(block => block.type)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(result.usage?.costUsd).toBeCloseTo((5 * 5 + 2 * 25 + 4 * 0.5 + 3 * 6.25) / 1e6, 12);
    await provider.chat([...messages, { id: 'a', role: 'assistant', timestamp: new Date(1), content: result.content, blocks: result.blocks, api: result.api, provider: result.provider, model, toolCalls: result.toolCalls }, { id: 't', role: 'tool', timestamp: new Date(2), content: 'result', toolCallId: 'lookup-1' }]);
    expect(JSON.stringify(bodies.at(-1)?.messages)).toContain('synthetic-fable-fallback-signature'); expect(JSON.stringify(bodies.at(-1)?.messages)).not.toContain('"type":"fallback"');
  }
  expect(bodies).toHaveLength(8);
  for (const body of bodies) expect(body.fallbacks).toEqual(targets.map(model => ({ model })));
  for (const header of headers) expect(header.get('anthropic-beta')?.split(',')).toContain('server-side-fallback-2026-07-01');
});
it('prices known model iterations only when they reconcile with aggregate counters and never infers costs from unknown evidence', async () => {
  const first = { type: 'message', model, input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null };
  const last = { ...first, type: 'fallback_message', model: targets[0], input_tokens: 7, output_tokens: 3 };
  let observed: unknown = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null, iterations: [first, last] }, transition = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => answer(JSON.parse(String(init.body)).stream === true, transition ? [marker(), ...content] : content, observed, model)));
  const provider = new AnthropicProvider(config);
  for (const stream of [false, true]) expect((await call(provider, stream))?.usage?.costUsd).toBeCloseTo((5 * 10 + 2 * 50 + 7 * 5 + 3 * 25) / 1e6, 12);
  for (const iterations of [[first, { ...last, model: 'unapproved-model' }], [first, { ...last, input_tokens: 8 }]]) {
    observed = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations };
    for (const stream of [false, true]) { const result = (await call(provider, stream))!; expect(result.usage?.totalTokens).toBe(17); expect(result.usage?.costUsd).toBeUndefined(); }
  }
  observed = usage; transition = true;
  for (const stream of [false, true]) { const result = (await call(provider, stream))!; expect(result.usage?.totalTokens).toBe(14); expect(result.usage?.costUsd).toBeUndefined(); }
});
it('refuses undeclared, reversed and mid-output transitions or incomplete terminal authority before pending tools/completion', async () => {
  let blocks: unknown[] = [], terminal = true;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => answer(JSON.parse(String(init.body)).stream === true, blocks, usage, targets[0], terminal)));
  const provider = new AnthropicProvider(config);
  for (const invalid of [[marker(model, 'unapproved-model'), ...content], [marker(), marker(targets[0], model), ...content], [content[0], marker(), ...content.slice(1)]]) {
    blocks = invalid; await expect(provider.chat(messages)).rejects.toThrow('Invalid Anthropic response.');
    const complete = vi.fn(), error = vi.fn(); await provider.streamChat(messages, () => {}, complete, error);
    expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(1); expect(error.mock.calls[0][0].message).toBe('Invalid Anthropic response.');
  }
  blocks = [marker(), ...content]; terminal = false; const complete = vi.fn(), error = vi.fn(); await provider.streamChat(messages, () => {}, complete, error); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(1);
});
it('does not restore an unpriceable fallback aggregate through agent or explicit cache-warming tariffs', async () => {
  const observed = { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [{ type: 'fallback_message', model: 'unapproved-model', input_tokens: 12, output_tokens: 1 }] };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => answer(JSON.parse(String(init.body)).stream === true, [{ type: 'text', text: 'fallback-ready' }], observed, model)));
  const provider = new AnthropicProvider({ ...config, type: 'anthropic' });
  const result = await streamProviderTurn({ provider, providerName: 'anthropic', model, messages, tools: [], extensionRegistry: new ExtensionRegistry(), cacheWarming: 'off', redactJson: value => structuredClone(value) });
  expect(result.usage?.totalTokens).toBe(13); expect(result.usage?.costUsd).toBeUndefined();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const manager = new SessionManager(), session = await manager.create(); await manager.addMessage(session.id, { role: 'user', content: 'x'.repeat(400000) });
  let warmed: TokenUsage | undefined;
  const warmer = new CacheWarmer(manager, session.id, undefined, usage => { warmed = usage; });
  try {
    warmer.start({ provider, providerName: 'anthropic', model, messages: manager.get(session.id)!.messages, options: { model }, ttlSeconds: 30,
      pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 }, isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(20000);
    expect(warmed?.totalTokens).toBe(13); expect(warmed?.costUsd).toBeUndefined();
  } finally { await warmer.dispose(); }
});
it('keeps arbitrary response aliases and derived or mutable-metadata-only profiles outside fallback authority', async () => {
  const bodies: Array<Record<string, unknown>> = [], headers: Headers[] = []; let responseModel = 'arbitrary-alias';
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); bodies.push(body); headers.push(new Headers(init.headers)); return answer(false, content, usage, responseModel); }));
  const original = await new AnthropicProvider(config).chat(messages); expect(original.usage?.costUsd).toBeCloseTo((5 * 10 + 2 * 50 + 4 + 3 * 12.5) / 1e6, 12);
  class Derived extends AnthropicProvider { override getPublishedModels() { return [{ id: model, name: 'Not authority', capabilities: { reasoning: true, imageInput: true, toolCalls: true }, compat: { allowedFallbackModels: targets.map(model => ({ model })) } }]; } }
  const forged = new Derived(config); Reflect.set(forged, 'ownsNativeProfiles', true); Reflect.set(forged, 'ownsReplay', true);
  responseModel = targets[0]; for (const provider of [new Derived(config), forged, new AnthropicProvider({ ...config, model: 'unknown-fable' })]) await provider.chat(messages);
  for (const body of bodies.slice(1)) expect(body).not.toHaveProperty('fallbacks');
  for (const header of headers.slice(1)) expect(header.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
});
