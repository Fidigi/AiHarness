import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { getProviderPublishedModels, getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { resolveAgentCompactionContextWindow } from '../config/agent-settings.js';
import type { Message } from '../types/index.js';

const messages: Message[] = [{ id: 'u', role: 'user', content: 'hello', timestamp: new Date(0) }];
const event = (delta: unknown = {}, finish_reason: string | null = null, usage?: unknown) => ({
  model: 'magistral-medium-latest', choices: [{ delta, finish_reason }], ...(usage ? { usage } : {}),
});
const sse = (events: unknown[], done = true) => new Response(events.map(item => `data:${JSON.stringify(item)}\r\n\r\n`).join('')
  + (done ? 'data: [DONE]\r\n\r\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
const create = (extra = {}) => new providers.MistralProvider({ type: 'mistral', apiKey: 'disposable-mistral-key', ...extra });

afterEach(async () => { vi.unstubAllGlobals(); await closeProviderNetworkDispatchers(); });

describe('native Mistral Conversations dialect', () => {
  it('composes the native Mistral factory with a configured default and reserved identity', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const provider = providers.ProviderFactory.create({ type: 'mistral-conversations', apiKey: 'disposable-native-factory' });
    expect(provider).toBeInstanceOf(providers.MistralProvider);
    expect(provider.getConfiguredModel()).toBe('mistral-small-latest');
    expect(provider.getModelApi!()).toBe('mistral-conversations');
    expect(provider.validateConfig()).toBe(true);
    expect(providers.ProviderFactory.has('mistral-conversations')).toBe(true);
    expect(providers.ProviderFactory.has('MISTRAL-CONVERSATIONS')).toBe(true);
    expect(() => providers.ProviderFactory.register('MISTRAL-CONVERSATIONS', () => provider)).toThrow('reserved provider type');
    const rows = getProviderPublishedModels(provider)!;
    expect(rows).toHaveLength(40);
    expect(getProviderPublishedModel('mistral', provider.getConfiguredModel()!, provider)).toMatchObject({
      api: 'mistral-conversations', contextWindow: 262144, maxOutputTokens: 256000,
    });
    expect(providers.ProviderFactory.create({ type: 'mistral-conversations', apiKey: 'disposable', model: 'magistral-medium-latest' })
      .getConfiguredModel()).toBe('magistral-medium-latest');
    expect(providers.ProviderFactory.create({ type: 'mistral-conversations' }).validateConfig()).toBe(false);
    expect(providers.ProviderFactory.has('mistral')).toBe(false);
    const remove = providers.ProviderFactory.register('mistral', config => new providers.MistralProvider(config));
    try {
      expect(providers.ProviderFactory.create({ type: 'mistral', apiKey: 'disposable', model: 'magistral-medium-latest' })
        .getConfiguredModel()).toBe('magistral-medium-latest');
      expect(providers.ProviderFactory.has('mistral')).toBe(true);
    } finally { remove(); }
    expect(providers.ProviderFactory.has('mistral')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('declares forty owned profiles across aliases without discovery or borrowing foreign metadata', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const alias of ['operator-mistral', 'mistral', 'anthropic', 'openai', 'azure']) {
      const provider = create({ type: alias, model: 'magistral-medium-latest' });
      const rows = getProviderPublishedModels(provider)!;
      expect(rows).toHaveLength(40);
      expect(rows.every(row => row.api === 'mistral-conversations')).toBe(true);
      expect(rows.filter(row => row.capabilities.imageInput)).toHaveLength(21);
      expect(rows.filter(row => row.capabilities.reasoning)).toHaveLength(11);
      const model = rows.find(row => row.id === 'magistral-medium-latest')!;
      expect(model).toMatchObject({ name: 'Magistral Medium (latest)', contextWindow: 262144, maxOutputTokens: 16384,
        pricing: { inputPerMillion: 2, outputPerMillion: 5, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0 } });
      model.capabilities.reasoning = false; model.contextWindow = 1; model.pricing!.inputPerMillion = 99; model.thinkingLevelMap!.high = null;
      expect(resolveAgentCompactionContextWindow(alias, model.id, provider)).toBe(262144);
      expect(getSupportedThinkingLevels(alias, model.id, undefined, provider)).toEqual(['off', 'high']);
      const catalogue = await collectProviderModelCatalog(new Map([[alias, provider]]), { discover: false });
      expect(catalogue[0]!.models).toHaveLength(40);
      expect(catalogue[0]!.models.find(row => row.id === model.id)).toMatchObject({ name: 'Magistral Medium (latest)',
        contextWindow: 262144, pricing: { inputPerMillion: 2 }, capabilities: { reasoning: true, imageInput: true } });
      expect(provider.getPublishedModels()).toHaveLength(40);
      provider.setConfiguredModel('claude-sonnet-4-6');
      expect(provider.getConfiguredModel()).toBe('claude-sonnet-4-6');
      expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined();
      expect(resolveAgentCompactionContextWindow('anthropic', 'claude-sonnet-4-6', provider)).toBe(128000);
      expect(getSupportedThinkingLevels('anthropic', 'claude-sonnet-4-6', undefined, provider)).toEqual(['off']);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends native SSE for chat, preserving ordered text/thinking and authentic cache usage', async () => {
    const fetch = vi.fn(async () => sse([
      event({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'consider' }] }, { type: 'text', text: 'answer' }] }),
      event({}, 'stop', { prompt_tokens: 10, completion_tokens: 2, num_cached_tokens: 3, total_tokens: 12 }),
    ])); vi.stubGlobal('fetch', fetch);
    const provider = create({ model: 'magistral-medium-latest', customHeaders: { Authorization: 'wrong', 'x-extra': 'allowed' } });
    const answer = await provider.chat(messages, { thinking: 'low', sessionId: 'session', maxTokens: 100, temperature: 0.2, systemPrompt: 'system' });
    expect(answer).toMatchObject({ content: 'answer', reasoning: 'consider', provider: 'mistral', model: 'magistral-medium-latest',
      usage: { promptTokens: 7, cacheReadTokens: 3, completionTokens: 2, totalTokens: 12, costUsd: (7 * 2 + 3 * 0.2 + 2 * 5) / 1e6 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer disposable-mistral-key');
    expect(new Headers(init.headers).get('x-affinity')).toBe('session');
    expect(new Headers(init.headers).get('x-extra')).toBe('allowed');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'magistral-medium-latest', stream: true, max_tokens: 100, temperature: 0.2,
      reasoning_effort: 'high', prompt_cache_key: 'session', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }] });
    expect(body).not.toHaveProperty('stream_options'); expect(body).not.toHaveProperty('prompt_mode');
    expect(String(init.body)).not.toContain('disposable-mistral-key');
  });

  it.each([['magistral-medium-latest', (7 * 2 + 3 * 0.2 + 2 * 5) / 1e6], ['operator-private-model', undefined]] as const)(
    'prices only the captured physical Mistral model: %s', async (model, expectedCost) => {
      vi.stubGlobal('fetch', vi.fn(async () => sse([
        event({ content: 'answer' }), event({}, 'stop', { prompt_tokens: 10, completion_tokens: 2, num_cached_tokens: 3 }),
      ])));
      const provider = create({ type: 'azure', model });
      let answer: providers.ChatResponse | undefined;
      await provider.streamChat(messages, () => { provider.setConfiguredModel('mistral-small-2506'); }, value => { answer = value; },
        error => { throw error; });
      expect(provider.getConfiguredModel()).toBe('mistral-small-2506');
      expect(answer).toMatchObject({ provider: 'azure', model: 'magistral-medium-latest',
        usage: { promptTokens: 7, completionTokens: 2, cacheReadTokens: 3, totalTokens: 12 } });
      if (expectedCost === undefined) expect(answer!.usage).not.toHaveProperty('costUsd');
      else expect(answer!.usage!.costUsd).toBeCloseTo(expectedCost, 12);
    });

  it('projects unowned thinking as text with images and collision-safe nine-character tool IDs', async () => {
    const fetch = vi.fn(async () => sse([event({}, 'stop')])); vi.stubGlobal('fetch', fetch);
    const history: Message[] = [...messages,
      { id: 'a', role: 'assistant', content: 'text', blocks: [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'text' }], timestamp: new Date(0), toolCalls: [
        { id: 'punctuated-call-1', name: 'echo', input: { text: 'one' } }, { id: 'punctuated_call_1', name: 'echo', input: { text: 'two' } },
      ] },
      { id: 't', role: 'tool', content: 'result', name: 'echo', toolCallId: 'punctuated-call-1', timestamp: new Date(0),
        blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] },
    ];
    const before = structuredClone(history);
    await create({ model: 'magistral-medium-latest' }).chat(history, { tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }] });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const assistant = body.messages[1], tool = body.messages[2];
    expect(assistant.content).toEqual([{ type: 'text', text: 'thought' }, { type: 'text', text: 'text' }]);
    expect(assistant.tool_calls.map((call: { id: string }) => call.id)).toEqual([expect.stringMatching(/^[a-zA-Z0-9]{9}$/), expect.stringMatching(/^[a-zA-Z0-9]{9}$/)]);
    expect(new Set(assistant.tool_calls.map((call: { id: string }) => call.id)).size).toBe(2);
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: assistant.tool_calls[0].id,
      content: [{ type: 'text', text: 'result' }, { type: 'image_url', image_url: 'data:image/png;base64,aGVsbG8=' }] });
    expect(body.tools[0].function.strict).toBe(false); expect(history).toEqual(before);
  });

  it('preserves a valid nine-character ID and collects fragmented native tool arguments', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      event({ tool_calls: [{ index: 0, id: 'AbCd12345', function: { name: 'echo', arguments: '{"x":' } }] }),
      event({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, 'tool_calls'),
    ])));
    const response = await create().chat(messages);
    expect(response.toolCalls).toEqual([{ id: 'AbCd12345', name: 'echo', input: { x: 1 } }]);
  });

  it('correlates indexless native tool IDs and refuses an ambiguous continuation before publication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      event({ tool_calls: [{ id: 'AbCd12345', function: { name: 'echo', arguments: '{"x":' } }] }),
      event({ tool_calls: [{ id: 'Other1234', function: { name: 'other', arguments: { text: 'object' } } }] }),
      event({ tool_calls: [{ id: 'AbCd12345', function: { arguments: '1}' } }] }, 'tool_calls'),
    ])));
    expect((await create().chat(messages)).toolCalls).toEqual([
      { id: 'AbCd12345', name: 'echo', input: { x: 1 } }, { id: 'Other1234', name: 'other', input: { text: 'object' } },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      event({ tool_calls: [{ id: 'AbCd12345', function: { name: 'echo', arguments: '{}' } }, { id: 'Other1234', function: { name: 'other', arguments: '{}' } }] }),
      event({ tool_calls: [{ function: { arguments: '{}' } }] }, 'tool_calls'),
    ])));
    const published: unknown[] = [], complete = vi.fn(), error = vi.fn();
    await create().streamChat(messages, (_text, item) => { if (item?.type === 'tool_call') published.push(item.data); }, complete, error);
    expect(published).toEqual([]); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('The provider tool call was ambiguous.');
  });

  it.each(['model_length', 'length'])('recognizes %s exhaustion', async finish => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([event({ content: 'partial' }, finish)])));
    expect(await create().chat(messages)).toMatchObject({ content: 'partial', stopReason: 'length' });
  });

  it('re-evaluates model-specific effort/image policies and suppresses cache affinity explicitly', async () => {
    const calls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { calls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) }); return sse([event({}, 'stop')]); }));
    const provider = create({ model: 'glm-5-2' });
    const image: Message = { ...messages[0], blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] };
    await provider.chat([image], { thinking: 'max', sessionId: 's', cacheRetention: 'none' });
    await provider.chat([image], { model: 'magistral-medium-latest', thinking: 'off' });
    await provider.chat([image], { model: 'devstral-latest', thinking: 'high' });
    expect(calls[0].body).toMatchObject({ reasoning_effort: 'max', messages: [{ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: '(image omitted: model does not support images)' }] }] });
    expect(calls[0].body).not.toHaveProperty('prompt_cache_key'); expect(calls[0].headers.has('x-affinity')).toBe(false);
    expect(calls[1].body).toMatchObject({ reasoning_effort: 'none', messages: [{ content: [{ type: 'text', text: 'hello' }, { type: 'image_url' }] }] });
    expect(calls[2].body).not.toHaveProperty('reasoning_effort'); expect(calls[2].body).not.toHaveProperty('prompt_mode');
  });

  it.each([
    [event({ content: 'prefix' })],
    [event({ content: 'prefix' }, 'error')],
    [{ error: { message: 'disposable-mistral-key' }, ...event({ content: 'must-not-publish', tool_calls: [{ index: 0, function: { name: 'bad', arguments: '{}' } }] }, 'stop') }],
  ].map(events => [events]))('refuses incomplete/error streams before tool publication or completion', async events => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const chunks: string[] = [], complete = vi.fn(), error = vi.fn(), tools: unknown[] = [];
    await create().streamChat(messages, (text, item) => { chunks.push(text); if (item?.type === 'tool_call') tools.push(item.data); }, complete, error);
    expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(tools).toEqual([]);
    expect(error.mock.calls[0][0].message).not.toContain('disposable-mistral-key');
    expect(chunks.join('')).not.toContain('must-not-publish');
  });

  it('bounds native event/output/tool input and rejects malformed arguments', async () => {
    for (const events of [
      [event({ content: 'x'.repeat(1024 * 1024 + 1) }, 'stop')],
      [event({ tool_calls: [{ index: 1024, function: { name: 'bad', arguments: '{}' } }] }, 'tool_calls')],
      [event({ tool_calls: [{ index: 0, function: { name: 'bad', arguments: '{broken' } }] }, 'tool_calls')],
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
      await expect(create().chat(messages)).rejects.toThrow();
    }
  });

  it('awaits chunk backpressure and cancels without reflecting caller reasons', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => sse([event({ content: 'one' }), event({ content: 'two' }, 'stop')])));
    const chunks: string[] = [], complete = vi.fn();
    const pending = create().streamChat(messages, async text => { chunks.push(text); if (text === 'one') await held; }, complete);
    await vi.waitFor(() => expect(chunks).toEqual(['one'])); expect(complete).not.toHaveBeenCalled(); release(); await pending;
    expect(chunks).toEqual(['one', 'two']); expect(complete).toHaveBeenCalledOnce();
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(), request = create().chat(messages, { signal: controller.signal });
    const rejected = expect(request).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); controller.abort(new Error('private-reason')); await rejected;
  });

  it('does not publish buffered output, tools or completion after cancellation during an awaited callback', async () => {
    for (const phase of ['text', 'tool']) {
      const controller = new AbortController(); let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      vi.stubGlobal('fetch', vi.fn(async () => sse([event({ content: phase === 'text' ? [
        { type: 'text', text: 'before' }, { type: 'thinking', thinking: [{ type: 'text', text: 'late reasoning' }] }, { type: 'text', text: 'late text' },
      ] : [], tool_calls: [
        { index: 0, id: 'AbCd12345', function: { name: 'echo', arguments: '{}' } },
        { index: 1, id: 'EfGh67890', function: { name: 'echo', arguments: '{}' } },
      ] }, 'tool_calls'), ...(phase === 'text' ? [event({ content: 'late event' })] : [])])));
      const tools: unknown[] = [], chunks: string[] = [], complete = vi.fn(), error = vi.fn();
      const run = create().streamChat(messages, async (text, item) => {
        if (item?.type === 'tool_call') tools.push(item.data);
        else chunks.push(text || String(item?.type));
        if ((phase === 'text' && text === 'before') || (phase === 'tool' && tools.length === 1)) { entered(); await gate; }
      }, complete, error, { signal: controller.signal });
      await ready; controller.abort(); release(); await run;
      expect(chunks).toEqual(phase === 'text' ? ['before'] : []);
      expect(tools).toHaveLength(phase === 'text' ? 0 : 1);
      expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toContain('cancelled');
    }
  });

  it('requires a credential and refuses HTTP errors without reflecting bodies', async () => {
    const fetch = vi.fn(async () => new Response('disposable-mistral-key echoed in private response', { status: 401 })); vi.stubGlobal('fetch', fetch);
    await expect(create({ apiKey: undefined }).chat(messages)).rejects.toThrow('Mistral API key is required.');
    expect(fetch).not.toHaveBeenCalled();
    await expect(create({ providerMaxRetries: 0 }).chat(messages)).rejects.toThrow('Mistral API error (401).');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('discovers at the versioned API base and rejects unsafe endpoint state without a request', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'one' }, { id: 'one' }, { id: '\u0000unsafe' }] })); vi.stubGlobal('fetch', fetch);
    expect(await create({ baseUrl: 'https://example.test/proxy/v1/chat/completions' }).getAvailableModels()).toEqual(['one']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://example.test/proxy/v1/models');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    for (const baseUrl of ['https://name:private@example.test', 'https://example.test?secret=private', 'file:///private']) {
      await expect(async () => create({ baseUrl }).chat(messages)).rejects.toThrow('Invalid provider endpoint.');
    }
    for (const apiKey of ['private\0key', 'private\u{1f4a5}key']) {
      const provider = create({ apiKey });
      expect(provider.validateConfig()).toBe(false);
      await expect(provider.chat(messages)).rejects.toThrow('Mistral API key is required.');
      expect(await provider.getAvailableModels()).toEqual([]);
    }
    for (const value of ['private\0header', 'private\u{1f4a5}header']) {
      const provider = create({ customHeaders: { 'x-private': value } });
      await expect(provider.chat(messages)).rejects.toThrow('Invalid Mistral request headers.');
      await expect(provider.getAvailableModels()).rejects.toThrow('Invalid Mistral request headers.');
      await expect(create().chat(messages, { sessionId: value })).rejects.toThrow('Invalid Mistral request headers.');
    }
    expect(fetch).toHaveBeenCalledOnce();
  });
});
