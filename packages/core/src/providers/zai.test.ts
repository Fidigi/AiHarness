import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZaiProvider, ZAI_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'glm-4.7', second = 'glm-5.2', latest = 'glm-5.3', vision = 'glm-5.3-flash', unknown = 'glm-5.3-highspeed';
const ids = [first, 'glm-5-turbo', second, 'glm-5.2-highspeed', latest, vision, unknown];
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fzai/api/coding/paas/v4` };
}

describe('explicit native Z.ai C SDK', () => {
  it('leaves generic compatible thinking and tool-stream policy distinct', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }).chat([input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
    expect(calls[0].body).toMatchObject({ max_tokens: 64, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }] });
    expect(calls[0].body).not.toHaveProperty('thinking'); expect(calls[0].body).not.toHaveProperty('tool_stream');
  });

  it('publishes seven immutable profiles with defensive metadata and unknown highspeed prices', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(ZAI_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(ZAI_MODELS)).toBe(true);
    expect(ZAI_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.declaredPricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(first); expect(ProviderFactory.has('zai')).toBe(false);
    for (const id of ids) expect(provider.getModelApi(id)).toBe('openai-completions');
    const row = getProviderPublishedModel('azure', vision, provider)!;
    expect(row).toMatchObject({ name: 'GLM-5.3-Flash', contextWindow: 1000000, maxOutputTokens: 131072, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'changed';
    expect(getProviderPublishedModel('azure', vision, provider)).toMatchObject({ contextWindow: 1000000, thinkingLevelMap: { high: 'high' } }); expect(getProviderPublishedModel('azure', 'gpt-4o', provider)).toBeUndefined();
    for (const id of ['glm-5.2-highspeed', unknown]) { expect(getProviderPublishedModel('azure', id, provider)?.pricing).toBeUndefined(); expect(ZAI_MODELS.find(row => row.id === id)?.declaredPricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }); }
    expect(getSupportedThinkingLevels('azure', first, undefined, provider)).toEqual(levels.slice(0,5));
    expect(getSupportedThinkingLevels('azure', second, undefined, provider)).toEqual(['off', 'high', 'max']);
    expect(getSupportedThinkingLevels('azure', latest, undefined, provider)).toEqual(['low', 'high', 'max']);
    const catalog = await collectProviderModelCatalog(new Map([['azure', provider]]), { discover: false }); expect(catalog[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${first}:classifier`, virtual: true, imageInput: false, api: 'openai-completions', contextWindow: 204800 }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('owns native thinking/tool-stream, system roles and optional plain replay independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const history: Message = { id: 'history', role: 'assistant', content: 'Before', timestamp: new Date(0), blocks: [{ type: 'reasoning', text: 'Earlier' }, { type: 'text', text: 'Before' }] };
    for (const type of ['azure', 'local', 'operator-zai']) {
      const provider = new ZaiProvider({ type, apiKey: 'disposable-zai', baseUrl, model: first });
      expect(await provider.chat([history, input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: first, api: 'openai-completions', reasoning: 'Thought', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.6 + 2 * 2.2 + 4 * 0.11) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fzai/api/coding/paas/v4/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-zai'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ max_tokens: 64, thinking: { type: 'enabled', clear_thinking: false }, tool_stream: true, messages: [{ role: 'system' }, { role: 'assistant', content: 'Before', reasoning_content: 'Earlier' }, { role: 'user' }], tools: [{ function: { strict: true } }] });
      expect(call.body).not.toHaveProperty('reasoning_effort'); expect(call.body).not.toHaveProperty('store'); expect(call.body).not.toHaveProperty('prompt_cache_key');
    }
    const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...history, blocks: [{ type: 'text', text: 'Before' }] }, input]); expect(calls[3].body).toMatchObject({ max_tokens: 131072, thinking: { type: 'disabled' } }); expect((calls[3].body.messages as unknown[])[0]).not.toHaveProperty('reasoning_content'); expect(calls[3].body).not.toHaveProperty('tool_stream');
    await provider.chat([input], { sessionId: '🔑'.repeat(70), cacheRetention: 'long' }); expect(calls[4].body).toMatchObject({ prompt_cache_key: '🔑'.repeat(64), prompt_cache_retention: '24h' });
    await provider.chat([input], { sessionId: 'not-affinity', cacheRetention: 'none' }); expect(calls[5].body).not.toHaveProperty('prompt_cache_key'); expect(calls[5].headers['x-session-id']).toBeUndefined();
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new ZaiProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  it('clamps all seven maps and refuses unsupported models, images and limits before I/O', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'zai', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Z.ai chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Z.ai chat model is not supported.'); }
    for (const maxTokens of [0, -1, 131073, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Z.ai output limit.');
    const image: Message = { ...input, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    for (const model of ids.filter(id => id !== vision)) await expect(provider.chat([image], { model })).rejects.toThrow('Z.ai chat model does not support images.'); expect(calls).toEqual([]);
    for (const model of ids) for (const thinking of levels) await provider.chat([input], { model, thinking, systemPrompt: 'System' });
    const effort52 = [undefined, 'high', 'high', 'high', 'high', 'max', 'max'], effort53 = ['low', 'low', 'low', 'high', 'high', 'max', 'max'];
    expect(calls.map(call => call.body.reasoning_effort)).toEqual([...Array(14).fill(undefined), ...effort52, ...effort52, ...effort53, ...effort53, ...effort53]);
    for (const [index,call] of calls.entries()) { expect(call.body.messages).toMatchObject([{ role: 'system' }, { role: 'user' }]); expect(call.body.thinking).toEqual(index < 28 && index % 7 === 0 ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false }); }
    await provider.chat([image], { model: vision }); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]); expect(provider.getConfiguredModel()).toBe(first);
  });

  it('requires explicit representable keys and safe endpoints/headers without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('ZAI_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new ZaiProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('Z.ai API key is required.'); }
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new ZaiProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Z.ai endpoint.');
    await expect(new ZaiProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid Z.ai request headers.'); expect(calls).toEqual([]);
    await new ZaiProvider({ type: 'operator', baseUrl: baseUrl + '/chat/completions/', apiKey: 'disposable' }).chat([input]); expect(calls[0].url).toBe('/owned%2Fzai/api/coding/paas/v4/chat/completions');
  });

  it('awaits deduplicated reasoning, captures physical prices/model and suppresses withdrawn callbacks', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(unknown); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(calls[0].body).toMatchObject({ model: first, stream_options: { include_usage: true } });
    expect(result).toMatchObject({ model: first, provider: 'operator', api: 'openai-completions', reasoning: 'Thought', usage: { costUsd: (6 * 0.6 + 2 * 2.2 + 4 * 0.11) / 1e6 } });
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('Z.ai request aborted.');
  });

  it('requires own valid finish before tools/success, including nested calls and tool history', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Invalid Z.ai chat response.');
    }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]);
    const toolEvents: unknown[] = []; let toolResult: unknown; const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl });
    await provider.streamChat([input], (_text,event) => { toolEvents.push(event); }, value => { toolResult = value; });
    expect(toolEvents).toEqual([{ type: 'tool_call', data: { id: 'read', name: 'read', input: { path: 'file' } } }]); expect(toolResult).toMatchObject({ api: 'openai-completions', toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    await provider.chat([{ ...input, role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', input: {} }] }, input]); expect(good.calls[1].body.tools).toEqual([]); expect(good.calls[1].body).not.toHaveProperty('tool_stream');
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === first ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn(); await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: vision }); }, outerComplete);
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid Z.ai chat response.');
  });

  it('preserves genuine overflow, unknown usage/prices and finite virtual classification privacy', async () => {
    const { baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 })); await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: { private: 'not-text' } }, finish_reason: 'stop' }] }))); await expect(provider.chat([input])).rejects.toThrow('Invalid Z.ai chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })));
    expect(await new SpecializedModels(provider).classify({ model: `${first}:classifier`, input: 'Approve', labels: ['safe','review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12 } });
    provider.setConfiguredModel(unknown); expect((await provider.chat([input])).usage).toMatchObject({ promptTokens: 6, completionTokens: 2, totalTokens: 12 }); expect((await provider.chat([input])).usage).not.toHaveProperty('costUsd'); expect(provider.getSpecializedModels()[0]).not.toHaveProperty('pricing');
  });
});
