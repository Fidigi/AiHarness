import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { captureNativeOutputBudget } from './provider-output-budget.js';
import type { Message } from '../types/index.js';

const first = 'MiniMax-M2.7', latest = 'MiniMax-M3';
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const events = (model: unknown, initial: unknown = { ...usage, output_tokens: 0 }, delta: unknown = { output_tokens: 2 }) => [
  { type: 'message_start', message: { type: 'message', id: 'message-1', model, usage: initial } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Re' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ady' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }, { type: 'message_stop' },
];
function stream(response: ServerResponse, values: unknown[]): void {
  response.setHeader('content-type', 'text/event-stream'); response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
}
async function fixture(reply?: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    if (reply) { reply(body, response); return; }
    if (body.stream) stream(response, events(body.model));
    else response.end(JSON.stringify({ type: 'message', model: body.model, stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Re' }, { type: 'text', text: 'ady' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fminimax/anthropic` };
}

describe('explicit native MiniMax A SDK', () => {
  it('keeps generic Anthropic defaults distinct from a MiniMax-looking alias and URL', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.AnthropicProvider({ type: 'minimax', apiKey: 'disposable', model: first, baseUrl }).chat([input]);
    expect(calls[0].body.max_tokens).toBe(1024); expect(calls[0].body.thinking).toBeUndefined();
  });

  it('owns three immutable profiles, metadata, caps and configured-only classifiers without discovery or ambient keys', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('MINIMAX_API_KEY', 'not-authorized');
    const provider = new providers.MiniMaxProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(providers.MINIMAX_MODELS).toHaveLength(3); expect(Object.isFrozen(providers.MINIMAX_MODELS)).toBe(true);
    expect(providers.ProviderFactory.has('minimax')).toBe(false); expect(provider.canDiscoverModels()).toBe(false);
    expect(await provider.getAvailableModels()).toEqual([first, 'MiniMax-M2.7-highspeed', latest]);
    for (const profile of providers.MINIMAX_MODELS) {
      expect(Object.isFrozen(profile) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.pricing)).toBe(true);
      for (const tier of profile.declaredPricing.tiers ?? []) expect(Object.isFrozen(tier)).toBe(true);
      const row = getProviderPublishedModel('azure', profile.id, provider)!;
      expect(row).toMatchObject({ id: profile.id, api: 'anthropic-messages', contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
        capabilities: { reasoning: true, imageInput: profile.id === latest, toolCalls: true } });
      row.contextWindow = 1; row.pricing!.inputPerMillion = 99;
      expect(getProviderPublishedModel('azure', profile.id, provider)?.pricing?.inputPerMillion).toBe(profile.pricing.inputPerMillion);
      expect(getSupportedThinkingLevels('azure', profile.id, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    }
    expect(getProviderPublishedModel('azure', 'claude-sonnet-4-6', provider)).toBeUndefined();
    const captured = captureNativeOutputBudget(provider)!; provider.setConfiguredModel(latest);
    expect(captured({}).maxTokens).toBe(131072); expect(captureNativeOutputBudget(provider)!({}).maxTokens).toBe(512000);
    expect(provider.getSpecializedModels()).toMatchObject([{ model: latest, type: 'classifier', virtual: true, api: 'anthropic-messages', imageInput: true }]);
    await expect(new providers.MiniMaxProvider({ type: 'minimax', baseUrl }).chat([input])).rejects.toThrow('MiniMax API key is required.');
    expect(calls).toHaveLength(0);
  });

  it('dispatches every native profile over JSON/SSE with physical A auth, budgets and disjoint priced usage', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.MiniMaxProvider({ type: 'nvidia', apiKey: 'disposable', baseUrl });
    for (const profile of providers.MINIMAX_MODELS) for (const thinking of ['off', 'high'] as const) {
      const options = { model: profile.id, thinking, temperature: 0.25, systemPrompt: 'System', sessionId: 'not-openrouter',
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] };
      const costUsd = (5 * profile.pricing.inputPerMillion + 2 * profile.pricing.outputPerMillion + 4 * profile.pricing.cacheReadPerMillion + profile.pricing.cacheWritePerMillion) / 1000000;
      expect(await provider.chat([input], options)).toMatchObject({ content: 'Ready', reasoning: 'Plan', provider: 'nvidia', api: 'anthropic-messages',
        usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd } });
      const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; }, options);
      expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject({ content: 'Ready', reasoning: 'Plan', api: 'anthropic-messages', usage: { totalTokens: 12, costUsd } });
      for (const call of calls.slice(-2)) {
        expect(call.url).toBe('/owned%2Fminimax/anthropic/v1/messages');
        expect(call.headers['x-api-key']).toBe('disposable'); expect(call.headers['anthropic-version']).toBe('2023-06-01');
        for (const name of ['authorization', 'api-key', 'nvcf-poll-seconds', 'x-session-id']) expect(call.headers[name]).toBeUndefined();
        expect(call.headers['anthropic-beta']).toBe(thinking === 'off' ? undefined : 'interleaved-thinking-2025-05-14');
        expect(call.body).toMatchObject({ model: profile.id, max_tokens: profile.maxOutputTokens,
          thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 16384, display: 'summarized' },
          system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
          tools: [{ name: 'read', eager_input_streaming: true, input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] });
        for (const key of ['output_config', 'reasoning_effort', 'store', 'tool_stream']) expect(call.body).not.toHaveProperty(key);
        if (thinking === 'high') expect(call.body).not.toHaveProperty('temperature'); else expect(call.body.temperature).toBe(0.25);
      }
    }
    expect(calls).toHaveLength(12);
  });

  it('keeps canonical plain reasoning, tools, image admission and three cache modes physically owned', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: latest });
    const history: Message[] = [{ ...input, role: 'assistant', content: 'Earlier', blocks: [{ type: 'reasoning', text: 'Earlier plan' }], toolCalls: [{ id: 'read-1', name: 'read', input: {} }] }, input];
    for (const cacheRetention of ['none', 'short', 'long'] as const) {
      await provider.chat(history, { cacheRetention, systemPrompt: 'System', tools: [{ name: 'first', description: 'First', parameters: {} }, { name: 'last', description: 'Last', parameters: {} }] });
      const body = calls.at(-1)!.body, control = cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(cacheRetention === 'long' ? { ttl: '1h' } : {}) };
      expect((body.messages as Array<{ content: unknown }>)[0].content).toEqual([{ type: 'text', text: 'Earlier plan' }, { type: 'text', text: 'Earlier' }, { type: 'tool_use', id: 'read-1', name: 'read', input: {} }]);
      expect((body.system as Array<Record<string, unknown>>)[0].cache_control).toEqual(control);
      const tools = body.tools as Array<Record<string, unknown>>; expect(tools[0].cache_control).toBeUndefined(); expect(tools[1].cache_control).toEqual(control);
      expect(tools.every(tool => tool.eager_input_streaming === true && !('strict' in tool))).toBe(true);
    }
    expect(history[0].content).toBe('Earlier');
    const image: Message = { ...input, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] };
    await provider.chat([image]); expect((calls.at(-1)!.body.messages as unknown[])[0]).toMatchObject({ content: [{ type: 'text' }, { type: 'image', source: { media_type: 'image/png', data: 'aGVsbG8=' } }] });
    await expect(provider.chat([image], { model: first })).rejects.toThrow('MiniMax chat model does not support images.');
  });

  it('uses pinned numeric level defaults, inert configured overrides and exact AiHarness output caps', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const [thinking, budget] of [['minimal', 1024], ['low', 2048], ['medium', 8192], ['high', 16384], ['xhigh', 16384], ['max', 16384]] as const) {
      await provider.chat([input], { thinking }); expect(calls.at(-1)!.body.thinking).toMatchObject({ budget_tokens: budget });
    }
    await provider.chat([input], { thinking: 'high', thinkingBudgets: { high: 4096 }, maxTokens: 10000 });
    expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 10000, thinking: { budget_tokens: 4096 } });
    await provider.chat([input], { thinking: 'high', maxTokens: 4096 }); expect(calls.at(-1)!.body.thinking).toMatchObject({ budget_tokens: 3072 });
    const getter = vi.fn(() => 9999), opaque = Object.defineProperty({}, 'high', { get: getter });
    await provider.chat([input], { thinking: 'off', thinkingBudgets: opaque }); expect(getter).not.toHaveBeenCalled();
    await expect(provider.chat([input], { thinking: 'high', thinkingBudgets: opaque })).rejects.toThrow('MiniMax chat request failed.'); expect(getter).not.toHaveBeenCalled();
  });

  it('accounts gross-input M3 thresholds, observed 1h writes and nullable partial SSE without forged usage', async () => {
    let current: unknown = usage, delta: unknown = { output_tokens: 2 };
    const { baseUrl } = await fixture((body, response) => body.stream ? stream(response, events(body.model, current, delta))
      : response.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage: current })));
    const provider = new providers.MiniMaxProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl, model: latest });
    const profile = providers.MINIMAX_MODELS.find(p => p.id === latest)!;
    for (const above of [false, true]) {
      const inputTokens = 512000 - 5 + Number(above), rates = above ? profile.pricing.tiers![0] : profile.pricing;
      current = { ...usage, input_tokens: inputTokens }; expect((await provider.chat([input])).usage?.costUsd).toBe((inputTokens * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1000000);
    }
    current = { ...usage, cache_creation: { ephemeral_1h_input_tokens: 1 } }; delta = { input_tokens: null, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: null } };
    const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; });
    expect(complete.mock.calls[0][0].usage).toEqual({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.3 + 2 * 1.2 + 4 * 0.06 + 0.6) / 1000000 });
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 }, { ...usage, cache_read_input_tokens: null }, { ...usage, cache_creation: { ephemeral_1h_input_tokens: 2 } }]) {
      current = invalid; expect((await provider.chat([input])).usage).toBeUndefined();
    }
  });

  it('gates missing finishes, trailing output and opaque signatures before tools or success and keeps remote failures private', async () => {
    let values: unknown[] = [], json: unknown;
    const { baseUrl } = await fixture((body, response) => body.stream ? stream(response, values) : response.end(JSON.stringify(json)));
    const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const tool = [{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'read', input: {} } }, { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }];
    for (const malformed of [[...events(first).slice(0, -2), ...tool], [...events(first), { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'LATE' } }],
      [events(first)[0], { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'secret-remote-value' } }]]) {
      values = malformed; const complete = vi.fn(), chunks: unknown[] = [];
      await expect(provider.streamChat([input], (text, event) => { chunks.push({ text, type: event?.type }); }, complete)).rejects.toThrow(/MiniMax/);
      expect(complete).not.toHaveBeenCalled(); expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'tool_call' })); expect(JSON.stringify(chunks)).not.toContain('LATE');
    }
    json = { error: { message: 'secret-remote-value' } }; await expect(provider.chat([input])).rejects.toThrow('Invalid MiniMax chat response.');
    json = { model: first, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Plan', signature: 'secret-remote-value' }] };
    await expect(provider.chat([input])).rejects.toThrow('Unsupported MiniMax reasoning replay.');
  });

  it('awaits withdrawal and suppresses buffered text, tools and completion', async () => {
    const { baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const controller = new AbortController(), chunks: string[] = [], complete = vi.fn();
    await expect(provider.streamChat([input], async text => { if (!text) return; chunks.push(text); await Promise.resolve(); controller.abort(); }, complete, undefined,
      { signal: controller.signal })).rejects.toThrow('MiniMax request aborted.');
    expect(chunks).toEqual(['Re']); expect(complete).not.toHaveBeenCalled();
  });

  it('captures physical A pricing and provenance before callback configuration mutation', async () => {
    const { baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'azure', apiKey: 'disposable', baseUrl, model: first });
    const complete = vi.fn(); await provider.streamChat([input], text => { if (text) provider.setConfiguredModel('MiniMax-M2.7-highspeed'); }, complete, error => { throw error; });
    expect(complete.mock.calls[0][0]).toMatchObject({ model: first, provider: 'azure', api: 'anthropic-messages', usage: { costUsd: (5 * 0.3 + 2 * 1.2 + 4 * 0.06 + 0.375) / 1000000 } });
  });

  it('refuses unknown models, output/image/header/endpoint inputs before I/O without borrowing foreign profiles', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future/private', 'claude-sonnet-4-6']) await expect(provider.chat([input], { model })).rejects.toThrow('MiniMax chat model is not supported.');
    expect(() => provider.setConfiguredModel('future/private')).toThrow('MiniMax chat model is not supported.'); expect(provider.getConfiguredModel()).toBe(first);
    for (const maxTokens of [0, -1, 0.5, 131073]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid MiniMax output limit.');
    await expect(provider.chat([input], { thinking: 'high', maxTokens: 1024 })).rejects.toThrow('Invalid MiniMax output limit.');
    await expect(new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'X-Test': 'secret\nvalue' } }).chat([input])).rejects.toThrow('Invalid MiniMax request headers.');
    for (const endpoint of ['ftp://example.test', 'https://key:secret@example.test', 'https://example.test?secret=1', 'https://example.test#secret']) expect(() => new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl: endpoint })).toThrow('Invalid MiniMax endpoint.');
    expect(calls).toHaveLength(0);
  });
});

describe('explicit native MiniMax CN A SDK', () => {
  it('owns the reviewed immutable CN declarations without factory, foreign metadata or ambient authentication', async () => {
    const { calls, baseUrl } = await fixture();
    vi.stubEnv('MINIMAX_CN_API_KEY', 'not-authorized-cn'); vi.stubEnv('MINIMAX_API_KEY', 'not-authorized-global');
    const provider = new providers.MiniMaxCnProvider({ type: 'google', apiKey: 'disposable', baseUrl });
    expect(providers.MINIMAX_CN_MODELS).toBe(providers.MINIMAX_MODELS);
    expect(providers.MINIMAX_CN_MODELS).toHaveLength(3); expect(Object.isFrozen(providers.MINIMAX_CN_MODELS)).toBe(true);
    expect(providers.ProviderFactory.has('minimax-cn')).toBe(false); expect(provider.canDiscoverModels()).toBe(false);
    expect(await provider.getAvailableModels()).toEqual([first, 'MiniMax-M2.7-highspeed', latest]);
    for (const profile of providers.MINIMAX_CN_MODELS) {
      expect(getProviderPublishedModel('google', profile.id, provider)).toMatchObject({ id: profile.id, api: 'anthropic-messages',
        contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
        pricing: { inputPerMillion: profile.pricing.inputPerMillion, outputPerMillion: profile.pricing.outputPerMillion,
          cacheReadPerMillion: profile.pricing.cacheReadPerMillion, cacheWritePerMillion: profile.pricing.cacheWritePerMillion },
        capabilities: { reasoning: true, imageInput: profile.id === latest, toolCalls: true } });
      expect(getSupportedThinkingLevels('google', profile.id, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    }
    expect(getProviderPublishedModel('google', 'gemini-2.5-pro', provider)).toBeUndefined();
    expect(provider.getSpecializedModels()).toMatchObject([{ model: first, type: 'classifier', virtual: true, api: 'anthropic-messages' }]);
    await expect(new providers.MiniMaxCnProvider({ type: 'minimax-cn', baseUrl }).chat([input])).rejects.toThrow('MiniMax API key is required.');
    expect(() => provider.setConfiguredModel('foreign')).toThrow('MiniMax chat model is not supported.'); expect(calls).toHaveLength(0);
  });

  it('dispatches all CN profiles over JSON and SSE with the inherited native policies and captured physical accounting', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.MiniMaxCnProvider({ type: 'minimax', apiKey: 'disposable-cn', baseUrl });
    for (const profile of providers.MINIMAX_CN_MODELS) for (const thinking of ['off', 'high'] as const) {
      const options = { model: profile.id, thinking, maxTokens: 32768, cacheRetention: 'long' as const, systemPrompt: 'CN system',
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] };
      const expected = { content: 'Ready', reasoning: 'Plan', model: profile.id, provider: 'minimax', api: 'anthropic-messages',
        usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
          costUsd: (5 * profile.pricing.inputPerMillion + 2 * profile.pricing.outputPerMillion + 4 * profile.pricing.cacheReadPerMillion + profile.pricing.cacheWritePerMillion) / 1000000 } };
      expect(await provider.chat([input], options)).toMatchObject(expected);
      const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; }, options);
      expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject(expected);
      for (const call of calls.slice(-2)) {
        expect(call.url).toBe('/owned%2Fminimax/anthropic/v1/messages'); expect(call.headers['x-api-key']).toBe('disposable-cn');
        expect(call.headers.authorization).toBeUndefined(); expect(call.headers['anthropic-version']).toBe('2023-06-01');
        expect(call.body).toMatchObject({ model: profile.id, max_tokens: 32768,
          thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 16384, display: 'summarized' },
          system: [{ type: 'text', text: 'CN system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
          tools: [{ eager_input_streaming: true, input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }] });
        expect((call.body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty('strict');
      }
    }
    expect(calls).toHaveLength(12);
  });

  it('uses only the explicit constructor to select the CN default endpoint, retaining the global endpoint and safe configured prefixes', async () => {
    const hits: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      hits.push(url instanceof Request ? url.url : String(url));
      return new Response(JSON.stringify({ type: 'message', model: first, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage }));
    }));
    try {
      await new providers.MiniMaxCnProvider({ type: 'minimax', apiKey: 'disposable' }).chat([input]);
      await new providers.MiniMaxProvider({ type: 'minimax-cn', apiKey: 'disposable' }).chat([input]);
      await new providers.MiniMaxCnProvider({ type: 'operator', apiKey: 'disposable', baseUrl: 'https://proxy.invalid/owned%2Fcn/v1/messages/' }).chat([input]);
      expect(hits).toEqual(['https://api.minimaxi.com/anthropic/v1/messages', 'https://api.minimax.io/anthropic/v1/messages', 'https://proxy.invalid/owned%2Fcn/v1/messages']);
      for (const baseUrl of ['https://key:secret@proxy.invalid', 'https://proxy.invalid?key=secret', 'https://proxy.invalid#secret'])
        expect(() => new providers.MiniMaxCnProvider({ type: 'operator', apiKey: 'disposable', baseUrl })).toThrow('Invalid MiniMax endpoint.');
      expect(hits).toHaveLength(3);
    } finally { vi.unstubAllGlobals(); }
  });
});
