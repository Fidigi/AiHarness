import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NvidiaProvider, NVIDIA_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'deepseek-ai/deepseek-v4.1-flash', priced = 'nvidia/nemotron-3-super-120b-a12b', latest = 'moonshotai/kimi-k3';
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[]) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } };
    if (body.stream) { response.setHeader('content-type', 'text/event-stream'); response.end((events ?? [
      { choices: [{ delta: { reasoning_content: 'Thought', reasoning: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage },
    ]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'); }
    else response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fnvidia/v1` };
}

describe('explicit native NVIDIA C SDK', () => {
  it('keeps compatible effort distinct from physical NVIDIA policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }).chat([input], { thinking: 'high' });
    expect(calls[0].body.reasoning_effort).toBe('high'); expect(calls[0].body).not.toHaveProperty('thinking');
  });

  it('sends the native poll-header default for all21 physical profiles over JSON and SSE', async () => {
    const { calls, baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'nvidia', apiKey: 'disposable', baseUrl });
    for (const { id: model } of NVIDIA_MODELS) {
      await provider.chat([input], { model, maxTokens: 64 });
      await provider.streamChat([input], () => {}, undefined, undefined, { model, maxTokens: 64 });
    }
    expect(calls).toHaveLength(42);
    for (const call of calls) {
      expect(call.headers['nvcf-poll-seconds']).toBe('3600');
      expect(call.headers.authorization).toBe('Bearer disposable');
      expect(call.headers['content-type']).toBe('application/json');
    }
  });

  it.each(['NVCF-POLL-SECONDS', 'nvcf-poll-seconds'])('keeps explicit %s ahead of the native default over JSON and SSE', async name => {
    const { calls, baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl,
      customHeaders: { [name]: '17', 'X-Operator': 'kept' } });
    await provider.chat([input]); await provider.streamChat([input], () => {});
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers['nvcf-poll-seconds']).toBe('17'); expect(call.headers['x-operator']).toBe('kept');
      expect(call.headers.authorization).toBe('Bearer disposable');
    }
  });

  it('does not infer the native header from a generic adapter alias or NVIDIA-like proxy path', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['nvidia', 'operator-nvidia']) await new OpenAiProvider({ type, apiKey: 'disposable', baseUrl, model: first }).chat([input]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.headers).not.toHaveProperty('nvcf-poll-seconds');
  });

  it('publishes 21 defensive profiles, two prices and nineteen unknown zero-only tables without discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(NVIDIA_MODELS).toHaveLength(21); expect(Object.isFrozen(NVIDIA_MODELS)).toBe(true);
    expect(NVIDIA_MODELS.every(row => Object.isFrozen(row) && Object.isFrozen(row.declaredPricing) && Object.isFrozen(row.declaredInput)
      && (!row.pricing || Object.isFrozen(row.pricing)) && (!row.thinkingLevelMap || Object.isFrozen(row.thinkingLevelMap))
      && (!row.declaredInputLimits || Object.isFrozen(row.declaredInputLimits.images.resize)))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(NVIDIA_MODELS.map(row => row.id)); expect(provider.canDiscoverModels()).toBe(false); expect(ProviderFactory.has('nvidia')).toBe(false);
    expect(NVIDIA_MODELS.filter(row => row.pricing)).toHaveLength(2); expect(NVIDIA_MODELS.filter(row => !row.pricing)).toHaveLength(19);
    const row = getProviderPublishedModel('azure', priced, provider)!;
    expect(row).toMatchObject({ contextWindow: 262144, maxOutputTokens: 262144, capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.2, outputPerMillion: 0.8 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99;
    expect(getProviderPublishedModel('azure', priced, provider)).toMatchObject({ contextWindow: 262144, pricing: { inputPerMillion: 0.2 } });
    expect(getProviderPublishedModel('azure', latest, provider)).toMatchObject({ contextWindow: 1048576, maxOutputTokens: 131072 });
    expect(getProviderPublishedModel('azure', latest, provider)).not.toHaveProperty('pricing');
    expect(getProviderPublishedModel('azure', 'gpt-4o', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('azure', first, undefined, provider)).toEqual(['off', 'high', 'max']);
    expect(getSupportedThinkingLevels('azure', latest, undefined, provider)).toEqual(levels.slice(0, 5));
    expect(getSupportedThinkingLevels('azure', 'google/gemma-3-4b-it', undefined, provider)).toEqual(['off']);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${first}:classifier`, virtual: true, imageInput: true, contextWindow: 1000000 }]); expect(calls).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('owns system/output/tools and DeepSeek-only thinking and mandatory replay under unrelated aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const history: Message = { ...input, role: 'assistant', content: 'Before' };
    for (const type of ['azure', 'local', 'operator-nvidia']) {
      const provider = new NvidiaProvider({ type, apiKey: 'disposable-nvidia', baseUrl });
      for (const model of [first, latest, priced]) for (const thinking of ['off', 'high'] as const) await provider.chat([history, input], { model, thinking, maxTokens: 64, systemPrompt: 'System', cacheRetention: 'long', sessionId: 'owned-session', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fnvidia/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-nvidia'); expect(call.headers['nvcf-poll-seconds']).toBe('3600');
      expect(call.body).toMatchObject({ max_tokens: 64, messages: [{ role: 'system' }, { role: 'assistant' }, { role: 'user' }] });
      expect((call.body.tools as Array<{ function: object }>)[0].function).not.toHaveProperty('strict');
      for (const key of ['store', 'tool_stream', 'reasoning_effort', 'max_completion_tokens', 'prompt_cache_key', 'prompt_cache_retention']) expect(call.body).not.toHaveProperty(key);
      if (call.body.model === first) expect((call.body.messages as object[])[1]).toHaveProperty('reasoning_content', '');
      else { expect(call.body).not.toHaveProperty('thinking'); expect((call.body.messages as object[])[1]).not.toHaveProperty('reasoning_content'); }
    }
    expect(calls.filter(call => call.body.model === first).map(call => call.body.thinking)).toEqual(Array.from({ length: 3 }, () => [{ type: 'disabled' }, { type: 'enabled' }]).flat());
    const provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...history, content: '', toolCalls: [{ id: 'read', name: 'read', input: {} }] }, input]);
    expect(calls.at(-1)?.body.tools).toEqual([]); expect((calls.at(-1)?.body.messages as unknown[])[0]).toHaveProperty('reasoning_content', '');
  });

  it('clamps physical thinking and output, forwards declared vision and refuses text-only images before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const thinking of levels) await provider.chat([input], { thinking });
    expect(calls.map(call => call.body.thinking)).toEqual([{ type: 'disabled' }, ...Array(6).fill({ type: 'enabled' })]);
    expect(calls.every(call => call.body.max_tokens === 384000 && call.body.reasoning_effort === undefined)).toBe(true);
    const image: Message = { ...input, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    await provider.chat([image], { model: latest }); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]);
    const count = calls.length; await expect(provider.chat([image], { model: priced })).rejects.toThrow('Nvidia chat model does not support images.'); expect(calls).toHaveLength(count); expect(provider.getConfiguredModel()).toBe(first);
  });

  it('requires explicit keys and rejects invalid models, limits, endpoints and headers before I/O', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('NVIDIA_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new NvidiaProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('Nvidia API key is required.'); }
    const provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'nvidia', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Nvidia chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Nvidia chat model is not supported.'); }
    for (const maxTokens of [0, -1, 384001, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Nvidia output limit.');
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new NvidiaProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Nvidia endpoint.');
    await expect(new NvidiaProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid Nvidia request headers.'); expect(calls).toEqual([]);
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new NvidiaProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
  });

  it('captures physical prices across callback mutation and suppresses callbacks after awaited withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: priced }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(latest); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(result).toMatchObject({ provider: 'operator', model: priced, api: 'openai-completions', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.2 + 2 * 0.8) / 1e6 } });
    expect((await provider.chat([input])).usage).not.toHaveProperty('costUsd');
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Nvidia request aborted.');
  });

  it('requires a request-owned finish before deferred tools or nested success', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Invalid Nvidia chat response.');
    }
    const { baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === first ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn(); await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: latest }); }, outerComplete);
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid Nvidia chat response.');
  });

  it('keeps overflow authority, usage validity, replay privacy and configured-only classification distinct', async () => {
    const { baseUrl } = await fixture(), provider = new NvidiaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 })); await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: { private: 'not-text' } }, finish_reason: 'stop' }] }))); await expect(provider.chat([input])).rejects.toThrow('Invalid Nvidia chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })));
    expect(await new SpecializedModels(provider).classify({ model: `${first}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, totalTokens: 12 } });
    provider.setConfiguredModel(priced); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${priced}:classifier`, contextWindow: 262144, imageInput: false, pricing: { inputPerMillion: 0.2 } }]);
  });
});
