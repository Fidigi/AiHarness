import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, DEEPSEEK_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const flash = 'deepseek-flash', pro = 'deepseek-v4-pro';
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const prior: Message = { id: 'prior', role: 'assistant', content: 'Prior', timestamp: new Date(0),
  blocks: [{ type: 'reasoning', text: 'Owned reasoning' }, { type: 'text', text: 'Prior' }] };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[], reply?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 };
    if (body.stream) { response.setHeader('content-type', 'text/event-stream'); response.end((events ?? [
      { choices: [{ delta: { reasoning_content: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage },
    ]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'); }
    else response.end(JSON.stringify(reply ?? { model: body.model, choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fdeepseek` };
}

describe('explicit native DeepSeek C SDK', () => {
  it('leaves the generic compatible thinking/replay envelope distinct', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: flash }).chat([prior, input], { thinking: 'high', maxTokens: 64 });
    expect(calls[0].body).toHaveProperty('reasoning_effort', 'high'); expect(calls[0].body).not.toHaveProperty('thinking');
    expect(calls[0].body.messages).toEqual([{ role: 'assistant', content: 'Prior' }, { role: 'user', content: 'Continue' }]);
  });

  it('publishes two defensive physical profiles and one configured virtual without aliases or DALL-E', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new DeepSeekProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    expect(DEEPSEEK_MODELS).toHaveLength(2); expect(Object.isFrozen(DEEPSEEK_MODELS)).toBe(true);
    expect(DEEPSEEK_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.thinkingLevelMap))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual([flash, pro]); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getModelApi(flash)).toBe('openai-completions');
    expect(ProviderFactory.has('deepseek')).toBe(false); expect(provider.getConfiguredModel()).toBe(flash);
    const row = getProviderPublishedModel('openai', flash, provider)!;
    expect(row).toMatchObject({ name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutputTokens: 384000,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.006, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'changed';
    expect(getProviderPublishedModel('openai', flash, provider)).toMatchObject({ contextWindow: 1000000, thinkingLevelMap: { high: 'high' } });
    expect(getProviderPublishedModel('openai', 'gpt-4o', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('openai', flash, undefined, provider)).toEqual(['off', 'low', 'high', 'max']);
    expect(getSupportedThinkingLevels('openai', pro, undefined, provider)).toEqual(['off', 'high', 'max']);
    const catalog = await collectProviderModelCatalog(new Map([['openai', provider]]), { discover: false });
    expect(catalog[0].models.map(model => model.id)).toEqual([flash, pro]); expect(calls).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${flash}:classifier`, virtual: true, imageInput: true, api: 'openai-completions', contextWindow: 1000000 }]);
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('uses owned native thinking, required reasoning replay, strict tools, cache prices and encoded endpoints', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['azure', 'local', 'operator-deepseek']) {
      const provider = new DeepSeekProvider({ type, apiKey: 'disposable-deepseek', baseUrl });
      expect(await provider.chat([prior, input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System',
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: flash, api: 'openai-completions',
        reasoning: 'Thought', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.3 + 2 * 1.2 + 4 * 0.006) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fdeepseek/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-deepseek'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ max_tokens: 64, thinking: { type: 'enabled' }, reasoning_effort: 'high',
        messages: [{ role: 'system' }, { role: 'assistant', reasoning_content: 'Owned reasoning' }, { role: 'user' }], tools: [{ function: { strict: true } }] });
      expect(call.body).not.toHaveProperty('max_completion_tokens'); expect(call.body).not.toHaveProperty('store'); expect(call.body).not.toHaveProperty('prompt_cache_key');
    }
    const provider = new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...prior, blocks: undefined }, input], { thinking: 'off' });
    expect(calls[3].body).toMatchObject({ max_tokens: 384000, thinking: { type: 'disabled' }, messages: [{ reasoning_content: '' }, {}] }); expect(calls[3].body).not.toHaveProperty('reasoning_effort');
    await provider.chat([input], { sessionId: '🔑'.repeat(70), cacheRetention: 'long' });
    expect(calls[4].body).toMatchObject({ prompt_cache_key: '🔑'.repeat(64), prompt_cache_retention: '24h' });
    await provider.chat([input], { sessionId: 'not-affinity', cacheRetention: 'none' }); expect(calls[5].body).not.toHaveProperty('prompt_cache_key');
    expect(calls[5].headers['x-session-id']).toBeUndefined();
    await provider.chat([{ ...prior, toolCalls: [{ id: 'read', name: 'read', input: { path: 'file' } }] },
      { id: 'tool', role: 'tool', toolCallId: 'read', content: 'Done', timestamp: new Date(0) }, input], { thinking: 'high' });
    expect(calls[6].body).toMatchObject({ tools: [], messages: [{ role: 'assistant', reasoning_content: 'Owned reasoning', tool_calls: [{ id: 'read' }] }, { role: 'tool', tool_call_id: 'read' }, { role: 'user' }] });
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new DeepSeekProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://api.deepseek.com/chat/completions');
  });

  it('clamps all levels physically and refuses unsupported models, image input and limits before I/O', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'deepseek-chat', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('DeepSeek chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('DeepSeek chat model is not supported.'); }
    for (const maxTokens of [0, -1, 384001, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid DeepSeek output limit.');
    const image: Message = { ...input, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    await expect(provider.chat([image], { model: pro })).rejects.toThrow('DeepSeek chat model does not support images.'); expect(calls).toEqual([]);
    for (const model of [flash, pro]) for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) await provider.chat([input], { model, thinking });
    expect(calls.map(call => call.body.reasoning_effort)).toEqual([undefined, 'low', 'low', 'high', 'high', 'max', 'max', undefined, 'high', 'high', 'high', 'high', 'max', 'max']);
    await provider.chat([image]); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]);
    expect(provider.getConfiguredModel()).toBe(flash);
  });

  it('requires explicit representable credentials and safe headers/endpoints without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new DeepSeekProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('DeepSeek API key is required.'); }
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new DeepSeekProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid DeepSeek endpoint.');
    await expect(new DeepSeekProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid DeepSeek request headers.'); expect(calls).toEqual([]);
    await new DeepSeekProvider({ type: 'operator', baseUrl: baseUrl + '/chat/completions/', apiKey: 'disposable' }).chat([input]); expect(calls[0].url).toBe('/owned%2Fdeepseek/chat/completions');
  });

  it('awaits native reasoning and captures prices/model while suppressing callbacks after withdrawal', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(pro); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(calls[0].body).toMatchObject({ model: flash, stream_options: { include_usage: true } });
    expect(result).toMatchObject({ model: flash, provider: 'operator', api: 'openai-completions', reasoning: 'Thought', usage: { costUsd: (6 * 0.3 + 2 * 1.2 + 4 * 0.006) / 1e6 } });
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('DeepSeek request aborted.');
  });

  it('requires each stream own valid finish before tools/success and rejects private failure frames', async () => {
    for (const finish_reason of [undefined, 'insufficient_system_resource', 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('Invalid DeepSeek chat response.');
    }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]);
    const toolEvents: unknown[] = []; let toolResult: unknown;
    await new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([input], (_text, event) => { toolEvents.push(event); }, value => { toolResult = value; });
    expect(toolEvents).toEqual([{ type: 'tool_call', data: { id: 'read', name: 'read', input: { path: 'file' } } }]);
    expect(toolResult).toMatchObject({ api: 'openai-completions', toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const { baseUrl } = await fixture(); const provider = new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === flash ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn();
    await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: pro }); }, outerComplete, undefined, { model: flash });
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid DeepSeek chat response.');
    vi.stubGlobal('fetch', async () => new Response('data: ' + JSON.stringify({ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }) + '\n\n'));
    await expect(provider.streamChat([input], () => { throw new Error('Unexpected chunk'); })).rejects.toThrow('DeepSeek chat request failed.');
  });

  it('keeps genuine overflow authority, unknown incomplete usage and finite virtual classification private', async () => {
    const { baseUrl } = await fixture(); const provider = new DeepSeekProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 }));
    await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 11 }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning_content: { private: 'not-text' } }, finish_reason: 'stop' }] })));
    await expect(provider.chat([input])).rejects.toThrow('Invalid DeepSeek chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 } })));
    expect(await new SpecializedModels(provider).classify({ model: `${flash}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12 } });
  });
});
