import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareWorkersAiChatProvider, CLOUDFLARE_CHAT_MODELS, ProviderFactory, CloudflareWorkersAiProvider } from './index.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const model = '@cf/deepseek-ai/deepseek-v4-flash-0731', vision = '@cf/google/gemma-4-26b-a4b-it';
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply?: (body: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ choices: [{ delta: { reasoning_content: 'Thought' } }] }, { model: body.model, choices: [{ delta: { content: 'Ready' }, finish_reason: 'stop' }], usage }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } else response.end(JSON.stringify({ model: body.model, usage, ...(reply ? reply(body) : { choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' } }] }) }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fowned/ai`;
  return { calls, baseUrl, provider: new CloudflareWorkersAiChatProvider({ type: 'operator-cloudflare', apiKey: 'disposable-cloudflare-chat', model, baseUrl }) };
}

describe('explicit Cloudflare Workers AI C SDK', () => {
  it('publishes eighteen reviewed chat profiles, not classifier/image models or a factory reservation', async () => {
    const { provider, calls } = await fixture();
    expect(CLOUDFLARE_CHAT_MODELS).toHaveLength(18); expect(Object.isFrozen(CLOUDFLARE_CHAT_MODELS)).toBe(true);
    expect(CLOUDFLARE_CHAT_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(CLOUDFLARE_CHAT_MODELS.map(profile => profile.id));
    expect(provider.canDiscoverModels()).toBe(false); expect(provider.getModelApi(model)).toBe('openai-completions');
    expect(provider.getConfiguredModel()).toBe(model); expect(ProviderFactory.has('cloudflare-workers-ai')).toBe(false);
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${model}:classifier`, virtual: true, api: 'openai-completions' }]);
    expect(new CloudflareWorkersAiProvider({ type: 'cloudflare-test', apiKey: 'disposable', baseUrl: 'https://proxy/ai' }).getConfiguredModel()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('uses native Bearer/versioned proxy, DeepSeek thinking/replay and disjoint priced counters under operator aliases', async () => {
    const { provider, calls, baseUrl } = await fixture();
    const history: Message = { ...message, role: 'assistant', blocks: [{ type: 'reasoning', text: 'Earlier thought' }] };
    const result = await provider.chat([history, message], { thinking: 'max', systemPrompt: 'System', sessionId: 'owned-session', maxTokens: 100 });
    expect(result).toMatchObject({ content: 'Ready', reasoning: 'Thought', api: 'openai-completions', provider: 'operator-cloudflare', model,
      usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.44 + 2 * 1.32 + 4 * 0.014) / 1_000_000 } });
    expect(calls[0].url).toBe('/proxy%2Fowned/ai/v1/chat/completions');
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer disposable-cloudflare-chat', session_id: 'owned-session', 'x-client-request-id': 'owned-session', 'x-session-affinity': 'owned-session' });
    expect(calls[0].headers['api-key']).toBeUndefined(); expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].body).toMatchObject({ model, max_tokens: 100, thinking: { type: 'enabled' }, reasoning_effort: 'max',
      messages: [{ role: 'system', content: 'System' }, { role: 'assistant', reasoning_content: 'Earlier thought' }, { role: 'user', content: 'Hello' }] });
    expect(calls[0].body).not.toHaveProperty('store'); expect(calls[0].body).not.toHaveProperty('prompt_cache_retention');
    const chunks: Array<{ chunk: string; event: unknown }> = []; let complete: unknown;
    await provider.streamChat([message], async (chunk, event) => { chunks.push({ chunk, event }); }, value => { complete = value; }, undefined, { thinking: 'off', cacheRetention: 'long', sessionId: 'owned-session' });
    expect(chunks).toEqual([{ chunk: '', event: { type: 'reasoning_delta', data: { content: 'Thought' } } }, { chunk: 'Ready', event: { type: 'text_delta', data: {
      model, choices: [{ delta: { content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } },
    } } }]); expect(complete).toMatchObject({ content: 'Ready', provider: 'operator-cloudflare', api: 'openai-completions', usage: result.usage });
    expect(calls[1].body).toMatchObject({ thinking: { type: 'disabled' }, stream_options: { include_usage: true } });
    expect(calls[1].body).not.toHaveProperty('reasoning_effort'); expect(calls[1].body).not.toHaveProperty('prompt_cache_retention');
    const azure = new CloudflareWorkersAiChatProvider({ type: 'azure', apiKey: 'disposable-cloudflare-chat', baseUrl, model });
    expect((await azure.chat([message])).api).toBe('openai-completions');
    expect(calls[2].url).toBe(calls[0].url); expect(calls[2].headers['api-key']).toBeUndefined();
  });

  it('admits only reviewed chat IDs/images/output limits before I/O and keeps unknown transport prices out', async () => {
    const { provider, calls, baseUrl } = await fixture();
    for (const target of ['future', '@cf/cloudflare/clef', 'typesafe/jev']) {
      expect(() => new CloudflareWorkersAiChatProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: target })).toThrow('Cloudflare chat model is not supported.');
      await expect(provider.chat([message], { model: target })).rejects.toThrow('Cloudflare chat model is not supported.');
      expect(() => provider.setConfiguredModel(target)).toThrow('Cloudflare chat model is not supported.');
    }
    expect(provider.getConfiguredModel()).toBe(model);
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Cloudflare chat model does not support images.');
    await expect(provider.chat([message], { maxTokens: 0 })).rejects.toThrow('Invalid Cloudflare output limit.');
    expect(calls).toEqual([]);
    provider.setConfiguredModel(vision); await provider.chat([image], { thinking: 'off' });
    expect(calls[0].body).toMatchObject({ model: vision, reasoning_effort: 'none', messages: [{ content: [{ type: 'text', text: 'Hello' }, { type: 'image_url' }] }] });
  });

  it('requires explicit account/key or safe full endpoint, never ambient auth or gateway headers', async () => {
    const { calls, baseUrl } = await fixture();
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'ambient-account'); vi.stubEnv('CLOUDFLARE_API_KEY', 'ambient-key');
    for (const config of [{}, { accountId: '' }, { accountId: 'bad\0account' }, { baseUrl: 'https://user:private@host/ai' },
      { baseUrl: 'https://host/ai?private=key' }, { baseUrl: 'https://host/ai#private' }, { baseUrl: 'ftp://host/ai' }, { baseUrl: 'https://host/ai/run' }]) {
      expect(() => new CloudflareWorkersAiChatProvider({ type: 'operator', apiKey: 'disposable', model, ...config })).toThrow('Invalid Cloudflare Workers AI endpoint.');
    }
    for (const apiKey of [undefined, 'bad\0key', 'bad\nkey', 'bad\u{1f4a5}key']) {
      const invalid = new CloudflareWorkersAiChatProvider({ type: 'operator', baseUrl, apiKey, model });
      expect(invalid.validateConfig()).toBe(false); await expect(invalid.chat([message])).rejects.toThrow('Cloudflare API key is required.');
    }
    const invalid = new CloudflareWorkersAiChatProvider({ type: 'operator', baseUrl, apiKey: 'disposable', model, customHeaders: { 'x-private': 'private\0header' } });
    await expect(invalid.chat([message])).rejects.toThrow('Invalid Cloudflare request headers.'); expect(calls).toEqual([]);
    const full = new CloudflareWorkersAiChatProvider({ type: 'operator', baseUrl: baseUrl + '/v1/chat/completions/', apiKey: 'disposable', model });
    await full.chat([message], { cacheRetention: 'none', sessionId: 'not-an-affinity' });
    expect(calls[0].url).toBe('/proxy%2Fowned/ai/v1/chat/completions');
    for (const name of ['session_id', 'x-client-request-id', 'x-session-affinity', 'cf-aig-authorization']) expect(calls[0].headers[name]).toBeUndefined();
    let endpoint = '';
    vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
    await new CloudflareWorkersAiChatProvider({ type: 'operator', accountId: 'explicit:account', apiKey: 'disposable', model }).chat([message]);
    expect(endpoint).toBe('https://api.cloudflare.com/client/v4/accounts/explicit%3Aaccount/ai/v1/chat/completions');
  });

  it('keeps real C tools and virtual finite classification separate from native S and image generation', async () => {
    let mode = 'tool';
    const { provider, calls } = await fixture(() => ({ choices: [{ message: mode === 'tool' ? { content: null,
      tool_calls: [{ id: 'read-native', type: 'function', function: { name: 'read', arguments: '{"path":"file"}' } }] }
      : { content: JSON.stringify(mode === 'label' ? { label: 'safe' } : { answers: { approved: { value: true, probabilities: [{ value: true, probability: 0.8 }, { value: false, probability: 0.2 }] } } }) } }] }));
    expect(await provider.chat([message], { tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] })).toMatchObject({
      toolCalls: [{ id: 'read-native', name: 'read', input: { path: 'file' } }], usage: { totalTokens: 12 } });
    expect(calls[0].body).toMatchObject({ tools: [{ function: { name: 'read', strict: false } }], tool_choice: 'auto' });
    mode = 'label';
    const sdk = new SpecializedModels(provider);
    expect(await sdk.classify({ model: `${model}:classifier`, input: 'Approved', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 } });
    mode = 'questions';
    expect(await sdk.classifyQuestions({ model: `${model}:classifier`, state: {}, questions: { approved: { type: 'boolean', prompt: 'Approved?' } } })).toMatchObject({ answers: { approved: { value: true } }, usage: { totalTokens: 12 } });
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    expect(calls).toHaveLength(3); expect(calls.every(call => call.url === '/proxy%2Fowned/ai/v1/chat/completions')).toBe(true);
  });

  it('withdraws awaited reasoning, rejects non-text reasoning and conserves genuine partial/invalid usage', async () => {
    const { provider, calls } = await fixture(); const signal = new AbortController(); const complete = vi.fn(), failure = vi.fn();
    await provider.streamChat([message], async (_chunk, event) => { expect(event?.type).toBe('reasoning_delta'); await Promise.resolve(); signal.abort(); }, complete, failure, { signal: signal.signal });
    expect(complete).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce(); expect(failure.mock.calls[0][0].message).toBe('Cloudflare request aborted.');
    expect(calls).toHaveLength(1);
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' } }], usage })));
      expect((await provider.chat([message])).usage).toBeUndefined();
    }
    for (const field of ['reasoning_content', 'reasoning_summary']) {
      for (const value of [{ private: 'not-native-text' }, [], 1, true]) {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', [field]: value } }] })));
        await expect(provider.chat([message])).rejects.toThrow('Invalid Cloudflare chat response.');
      }
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', [field]: 'Thought' } }] })));
      expect((await provider.chat([message])).reasoning).toBe('Thought');
    }
  });
});
