import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CerebrasProvider, CEREBRAS_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import { ProviderType, type Message } from '../types/index.js';

const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const gpt = 'gpt-oss-120b', qwen = 'qwen-3.8-27b';
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[], reply?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      response.end((events ?? [{ choices: [{ delta: { reasoning_content: 'Thought', reasoning: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage }])
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } else response.end(JSON.stringify(reply ?? { model: body.model, choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fcerebras/v1`;
  return { calls, baseUrl };
}

describe('explicit Cerebras C SDK', () => {
  it('keeps the legacy compatible envelope distinct from the missing native profile policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'compatible-cerebras', apiKey: 'disposable', baseUrl, model: gpt }).chat([message], { maxTokens: 64 });
    expect(calls[0].body).toHaveProperty('max_tokens', 64); expect(calls[0].body).not.toHaveProperty('max_completion_tokens');
  });

  it('composes Cerebras through the native Core factory without registration', async () => {
    const provider = ProviderFactory.create({ type: 'cerebras', apiKey: 'disposable-factory' });
    expect(provider).toBeInstanceOf(CerebrasProvider);
    expect(ProviderType.CEREBRAS).toBe('cerebras');
    expect(ProviderFactory.has('CEREBRAS')).toBe(true);
    expect(ProviderFactory.getDefaultModel(ProviderType.CEREBRAS)).toBe(gpt);
    expect(provider.getConfiguredModel()).toBe(gpt);
    expect(await provider.getAvailableModels()).toEqual([gpt, qwen]);
    expect(provider.validateConfig()).toBe(true);
    expect(ProviderFactory.create({ type: 'cerebras' }).validateConfig()).toBe(false);
    expect(() => ProviderFactory.create({ type: 'cerebras', model: 'unknown' })).toThrow('Cerebras chat model is not supported.');
    expect(() => ProviderFactory.register(' CEREBRAS ', () => provider)).toThrow('Cannot register reserved provider type:');
    expect(ProviderFactory.getRegisteredTypes()).not.toContain('cerebras');
  });

  it('publishes two frozen profiles and alias-independent metadata without inherited DALL-E', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new CerebrasProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(CEREBRAS_MODELS).toHaveLength(2); expect(Object.isFrozen(CEREBRAS_MODELS)).toBe(true);
    expect(CEREBRAS_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.thinkingLevelMap) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual([gpt, qwen]); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getConfiguredModel()).toBe(gpt); expect(provider.getModelApi(gpt)).toBe('openai-completions'); expect(ProviderFactory.has('cerebras')).toBe(true);
    const row = getProviderPublishedModel('anthropic', gpt, provider)!;
    expect(row).toMatchObject({ id: gpt, name: 'GPT OSS 120B', contextWindow: 131072, maxOutputTokens: 40960, capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.35, outputPerMillion: 0.75, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99;
    expect(getProviderPublishedModel('anthropic', gpt, provider)?.contextWindow).toBe(131072);
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined();
    const catalog = await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false });
    expect(catalog.flatMap(entry => entry.models.map(model => model.id))).toEqual([gpt, qwen]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${gpt}:classifier`, virtual: true, api: 'openai-completions', contextWindow: 131072 }]);
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.'); expect(calls).toEqual([]);
  });

  it('uses physical Bearer/native output/system/effort policies under Azure and local aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['azure', 'local', 'operator-cerebras']) {
      const provider = new CerebrasProvider({ type, apiKey: 'disposable-cerebras', baseUrl, model: gpt });
      const result = await provider.chat([message], { systemPrompt: 'System', thinking: 'off', maxTokens: 64, temperature: 0.2,
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
      expect(result).toMatchObject({ provider: type, api: 'openai-completions', model: gpt, content: 'Ready', reasoning: 'Thought', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.35 + 2 * 0.75) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fcerebras/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-cerebras'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ max_completion_tokens: 64, reasoning_effort: 'low', temperature: 0.2, messages: [{ role: 'system' }, { role: 'user' }], tools: [{ function: { name: 'read' } }] });
      expect(call.body).not.toHaveProperty('max_tokens'); expect(call.body).not.toHaveProperty('store'); expect(JSON.stringify(call.body.tools)).not.toContain('strict');
    }
    const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: qwen });
    await provider.chat([message], { thinking: 'off', sessionId: '🔑'.repeat(70), cacheRetention: 'long' });
    expect(calls[3].body).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: 40960, prompt_cache_key: '🔑'.repeat(64), prompt_cache_retention: '24h' });
    await provider.chat([message], { sessionId: 'not-an-affinity', cacheRetention: 'none' });
    expect(calls[4].body).not.toHaveProperty('prompt_cache_key'); expect(calls[4].body).not.toHaveProperty('prompt_cache_retention');
    expect(calls[4].headers['x-session-id']).toBeUndefined(); expect(calls[4].headers.session_id).toBeUndefined();
    let endpoint = '';
    vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new CerebrasProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(endpoint).toBe('https://api.cerebras.ai/v1/chat/completions');
  });

  it('clamps every pinned level and rejects unknown models, images and output before I/O', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'dall-e-3', 'openai/gpt-oss-120b']) {
      expect(() => provider.setConfiguredModel(model)).toThrow('Cerebras chat model is not supported.');
      await expect(provider.chat([message], { model })).rejects.toThrow('Cerebras chat model is not supported.');
    }
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Cerebras chat model does not support images.');
    for (const maxTokens of [0, -1, 40961, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Cerebras output limit.');
    expect(calls).toEqual([]); expect(provider.getConfiguredModel()).toBe(gpt);
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const model of [gpt, qwen]) for (const thinking of levels) await provider.chat([message], { model, thinking });
    expect(calls.map(call => call.body.reasoning_effort)).toEqual(['low', 'low', 'low', 'medium', 'high', 'high', 'high', 'none', 'low', 'low', 'medium', 'high', 'high', 'high']);
    await provider.chat([image], { model: qwen }); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]);
  });

  it('requires explicit representable keys/headers and safe endpoint forms without ambient credential fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('CEREBRAS_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) {
      const provider = new CerebrasProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false);
      await expect(provider.chat([message])).rejects.toThrow('Cerebras API key is required.');
    }
    for (const endpoint of ['https://user:private@host/v1', 'https://host/v1?private=key', 'https://host/v1#private', 'ftp://host/v1']) expect(() => new CerebrasProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Cerebras endpoint.');
    await expect(new CerebrasProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Cerebras request headers.');
    expect(calls).toEqual([]);
    await new CerebrasProvider({ type: 'operator', baseUrl: baseUrl + '/chat/completions/', apiKey: 'disposable' }).chat([message]);
    expect(calls[0].url).toBe('/owned%2Fcerebras/v1/chat/completions');
  });

  it('awaits reasoning first, captures the pending model/price and suppresses buffered delivery after withdrawal', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const events: string[] = []; let complete: unknown;
    await provider.streamChat([message], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(qwen); }, value => { complete = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(calls[0].body).toMatchObject({ model: gpt, stream_options: { include_usage: true } });
    expect(complete).toMatchObject({ model: gpt, provider: 'operator', api: 'openai-completions', reasoning: 'Thought', usage: { costUsd: (5 * 0.35 + 2 * 0.75) / 1e6 } });
    const abort = new AbortController(), finished = vi.fn(), failed = vi.fn(), seen: string[] = [];
    await provider.streamChat([message], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, finished, failed, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(finished).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Cerebras request aborted.');
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response((body.model === gpt ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n');
    });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn();
    await provider.streamChat([message], async () => { await provider.streamChat([message], () => {}, nestedComplete, nestedError, { model: qwen }); }, outerComplete, undefined, { model: gpt });
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError).toHaveBeenCalledOnce();
    expect(nestedError.mock.calls[0][0].message).toBe('Invalid Cerebras chat response.');
  });

  it('requires a valid native finish before publishing tools or success and refuses mixed failure frames privately', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'network_error', 'future']) {
      const events = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }];
      const { baseUrl } = await fixture(events); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
      const chunks = vi.fn(), complete = vi.fn(), error = vi.fn(); await provider.streamChat([message], chunks, complete, error);
      expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('Invalid Cerebras chat response.');
    }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]);
    const toolEvents: unknown[] = []; let goodResult: unknown;
    await new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message], (_text, event) => { toolEvents.push(event); }, value => { goodResult = value; });
    expect(toolEvents).toEqual([{ type: 'tool_call', data: { id: 'read', name: 'read', input: { path: 'file' } } }]);
    expect(goodResult).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }], api: 'openai-completions' });
    const { baseUrl } = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]);
    const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await expect(provider.streamChat([message], () => { throw new Error('Unexpected chunk'); })).rejects.toThrow('Cerebras chat request failed.');
  });

  it('preserves finite virtual classification while rejecting malformed reasoning and incomplete accounting', async () => {
    const { baseUrl } = await fixture(); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: qwen });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })));
    expect(await new SpecializedModels(provider).classify({ model: `${qwen}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.99 + 2 * 1.49 + 4 * 0.99) / 1e6 } });
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage })));
      expect((await provider.chat([message])).usage).toBeUndefined();
    }
    for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', [field]: { private: 'not-text' } }, finish_reason: 'stop' }] })));
      await expect(provider.chat([message])).rejects.toThrow('Invalid Cerebras chat response.');
    }
  });
});
