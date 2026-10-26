import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqProvider, GROQ_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const llama = 'llama-3.1-8b-instant', gpt = 'openai/gpt-oss-120b', q36 = 'qwen/qwen3.6-27b', q38 = 'qwen/qwen3.8-27b';
const ids = [llama, 'llama-3.3-70b-versatile', gpt, 'openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b', q36, q38];
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
      { choices: [{ delta: { reasoning: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage },
    ]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'); }
    else response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Ready', reasoning: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fgroq/openai/v1` };
}

describe('explicit native Groq C SDK', () => {
  it('leaves generic compatible output, instruction and effort policy distinct', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: q36 }).chat([input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System' });
    expect(calls[0].body).toMatchObject({ max_tokens: 64, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }] });
    expect(calls[0].body).not.toHaveProperty('max_completion_tokens'); expect(calls[0].body).not.toHaveProperty('store');
  });

  it('publishes seven immutable physical profiles, defensive declarations and one configured virtual', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new GroqProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(GROQ_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(GROQ_MODELS)).toBe(true);
    expect(GROQ_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(llama); expect(ProviderFactory.has('groq')).toBe(false);
    for (const id of ids) expect(provider.getModelApi(id)).toBe('openai-completions');
    const row = getProviderPublishedModel('azure', q38, provider)!;
    expect(row).toMatchObject({ name: 'Qwen3.8 27B', contextWindow: 131042, maxOutputTokens: 16384, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.8, outputPerMillion: 4, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'changed';
    expect(getProviderPublishedModel('azure', q38, provider)).toMatchObject({ contextWindow: 131042, thinkingLevelMap: { high: 'high' } }); expect(getProviderPublishedModel('azure', 'gpt-4o', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('azure', llama, undefined, provider)).toEqual(['off']);
    expect(getSupportedThinkingLevels('azure', gpt, undefined, provider)).toEqual(['low', 'medium', 'high']);
    expect(getSupportedThinkingLevels('azure', q36, undefined, provider)).toEqual(['off', 'high']);
    expect(getSupportedThinkingLevels('azure', q38, undefined, provider)).toEqual(['off', 'low', 'medium', 'high']);
    const catalog = await collectProviderModelCatalog(new Map([['azure', provider]]), { discover: false }); expect(catalog[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${llama}:classifier`, virtual: true, imageInput: false, api: 'openai-completions', contextWindow: 131072 }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('owns developer roles, completion limits, strict tools, cache and prices independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['azure', 'local', 'operator-groq']) {
      const provider = new GroqProvider({ type, apiKey: 'disposable-groq', baseUrl, model: q36 });
      expect(await provider.chat([input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: q36, api: 'openai-completions', reasoning: 'Thought', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.6 + 2 * 3 + 4 * 0.3) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fgroq/openai/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-groq'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ store: false, max_completion_tokens: 64, reasoning_effort: 'default', messages: [{ role: 'developer' }, { role: 'user' }], tools: [{ function: { strict: true } }] });
      expect(call.body).not.toHaveProperty('max_tokens'); expect(call.body).not.toHaveProperty('thinking'); expect(call.body).not.toHaveProperty('prompt_cache_key');
    }
    const provider = new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: q36 });
    await provider.chat([input], { thinking: 'off' }); expect(calls[3].body).toMatchObject({ max_completion_tokens: 16384, reasoning_effort: 'none', store: false });
    await provider.chat([input], { sessionId: '🔑'.repeat(70), cacheRetention: 'long' }); expect(calls[4].body).toMatchObject({ prompt_cache_key: '🔑'.repeat(64), prompt_cache_retention: '24h' });
    await provider.chat([input], { sessionId: 'not-affinity', cacheRetention: 'none' }); expect(calls[5].body).not.toHaveProperty('prompt_cache_key'); expect(calls[5].headers['x-session-id']).toBeUndefined();
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new GroqProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('clamps all seven maps and refuses unsupported models, images and limits before I/O', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'groq', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Groq chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Groq chat model is not supported.'); }
    for (const maxTokens of [0, -1, 131073, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Groq output limit.');
    const image: Message = { ...input, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    for (const model of ids.slice(0,5)) await expect(provider.chat([image], { model })).rejects.toThrow('Groq chat model does not support images.'); expect(calls).toEqual([]);
    for (const model of ids) for (const thinking of levels) await provider.chat([input], { model, thinking, systemPrompt: 'System' });
    const gptEfforts = ['low', 'low', 'low', 'medium', 'high', 'high', 'high'];
    expect(calls.map(call => call.body.reasoning_effort)).toEqual([...Array(14).fill(undefined), ...gptEfforts, ...gptEfforts, ...gptEfforts, 'none', 'default', 'default', 'default', 'default', 'default', 'default', 'none', 'low', 'low', 'medium', 'high', 'high', 'high']);
    for (const [index,call] of calls.entries()) expect(call.body.messages).toMatchObject([{ role: index < 14 ? 'system' : 'developer' }, { role: 'user' }]);
    for (const model of [q36,q38]) await provider.chat([image], { model }); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]); expect(provider.getConfiguredModel()).toBe(llama);
  });

  it('requires explicit representable credentials and safe headers/endpoints without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('GROQ_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new GroqProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('Groq API key is required.'); }
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new GroqProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Groq endpoint.');
    await expect(new GroqProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid Groq request headers.'); expect(calls).toEqual([]);
    await new GroqProvider({ type: 'operator', baseUrl: baseUrl + '/chat/completions/', apiKey: 'disposable' }).chat([input]); expect(calls[0].url).toBe('/owned%2Fgroq/openai/v1/chat/completions');
  });

  it('awaits native reasoning and captures physical prices/model while suppressing withdrawn callbacks', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: gpt }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(q38); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(calls[0].body).toMatchObject({ model: gpt, stream_options: { include_usage: true }, reasoning_effort: 'low' });
    expect(result).toMatchObject({ model: gpt, provider: 'operator', api: 'openai-completions', reasoning: 'Thought', usage: { costUsd: (6 * 0.15 + 2 * 0.6 + 4 * 0.075) / 1e6 } });
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('Groq request aborted.');
  });

  it('requires each stream own valid finish before tools/success without borrowing nested authority', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Invalid Groq chat response.');
    }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]);
    const toolEvents: unknown[] = []; let toolResult: unknown;
    await new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([input], (_text,event) => { toolEvents.push(event); }, value => { toolResult = value; });
    expect(toolEvents).toEqual([{ type: 'tool_call', data: { id: 'read', name: 'read', input: { path: 'file' } } }]); expect(toolResult).toMatchObject({ api: 'openai-completions', toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const { baseUrl } = await fixture(); const provider = new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === llama ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn(); await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: q36 }); }, outerComplete);
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid Groq chat response.');
  });

  it('preserves genuine overflow authority, unknown incomplete usage and finite virtual classification privacy', async () => {
    const { baseUrl } = await fixture(); const provider = new GroqProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 })); await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: { private: 'not-text' } }, finish_reason: 'stop' }] }))); await expect(provider.chat([input])).rejects.toThrow('Invalid Groq chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })));
    expect(await new SpecializedModels(provider).classify({ model: `${llama}:classifier`, input: 'Approve', labels: ['safe','review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12 } });
  });
});
