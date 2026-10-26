import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const flash = 'deepseek-ai/DeepSeek-V4-Flash-0731', kimi = 'moonshotai/Kimi-K2.6', combined = 'zai-org/GLM-5.2';
const ids = [flash, 'deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-V4-Pro-0813', 'deepseek-ai/DeepSeek-V4.1-Flash', 'deepseek-ai/DeepSeek-V4.1-Flash-Fast', 'moonshotai/Kimi-K2.5', kimi, 'moonshotai/Kimi-K2.7-Code', 'moonshotai/Kimi-K3', 'nvidia/Nemotron-120B-A12B', 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B', 'openai/gpt-oss-120b', 'thinkingmachines/inkling', 'thinkingmachines/inkling-small', 'zai-org/GLM-4.7', 'zai-org/GLM-5', 'zai-org/GLM-5.1', combined, 'zai-org/GLM-5.2-Fast', 'zai-org/GLM-5.3', 'zai-org/GLM-5.3-Fast', 'zai-org/GLM-5.3-Flash'];
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[], reply?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) { response.setHeader('content-type', 'text/event-stream'); response.end((events ?? [{ choices: [{ delta: { reasoning_content: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage }]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'); }
    else response.end(JSON.stringify(reply ?? { choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fbaseten/v1` };
}

describe('explicit native Baseten C SDK', () => {
  it('keeps generic compatible C distinct from native template args and effort mappings', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.OpenAiProvider({ type: 'baseten', apiKey: 'disposable', baseUrl, model: kimi }).chat([message], { thinking: 'high', maxTokens: 64 });
    expect(calls[0].body).toMatchObject({ max_tokens: 64, reasoning_effort: 'high' }); expect(calls[0].body).not.toHaveProperty('chat_template_args');
  });

  it('publishes22 immutable priced profiles and defensive actual-adapter metadata without factory or discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.BasetenProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(providers.BASETEN_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.BASETEN_MODELS)).toBe(true);
    expect(providers.BASETEN_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.thinkingLevelMap))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(flash); expect(providers.ProviderFactory.has('baseten')).toBe(false);
    const row = getProviderPublishedModel('anthropic', kimi, provider)!;
    expect(row).toMatchObject({ name: 'Kimi K2.6', api: 'openai-completions', contextWindow: 262000, maxOutputTokens: 262000, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', kimi, provider)).toMatchObject({ contextWindow: 262000, thinkingLevelMap: { off: 'off', high: 'high' } });
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', kimi, undefined, provider)).toEqual(['off', 'high']); expect(getSupportedThinkingLevels('anthropic', flash, undefined, provider)).toEqual(levels);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
  });

  it('owns system roles, default non-strict tools, exact caps and template versus combined effort independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['openai', 'anthropic', 'azure', 'operator-baseten']) {
      const provider = new providers.BasetenProvider({ type, apiKey: 'disposable-baseten', baseUrl, model: combined });
      expect(await provider.chat([message], { thinking: 'off', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: combined, api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 1.4 + 2 * 4.4 + 4 * 0.3) / 1e6 } });
    }
    for (const call of calls) { expect(call.url).toBe('/owned%2Fbaseten/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-baseten'); expect(call.headers['api-key']).toBeUndefined(); expect(call.body).toMatchObject({ max_tokens: 64, chat_template_args: { enable_thinking: false }, reasoning_effort: 'none', messages: [{ role: 'system' }, { role: 'user' }], tools: [{ function: { strict: false } }] }); for (const key of ['max_completion_tokens', 'store', 'prompt_cache_key', 'prompt_cache_retention', 'thinking', 'reasoning', 'tool_stream', 'chat_template_kwargs']) expect(call.body).not.toHaveProperty(key); }
    await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: kimi }).chat([message], { thinking: 'high' }); expect(calls.at(-1)!.body).toMatchObject({ chat_template_args: { enable_thinking: true } }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort'); expect(calls.at(-1)!.body).not.toHaveProperty('max_tokens');
    await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).chat([message]); expect(calls.at(-1)!.body.reasoning_effort).toBe('none'); expect(calls.at(-1)!.body).not.toHaveProperty('chat_template_args');
  });

  it('clamps sparse maps and refuses unsupported models, text-only images and invalid caps before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'dall-e-3', 'gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('Baseten chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Baseten chat model is not supported.'); }
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Baseten chat model does not support images.');
    for (const maxTokens of [0, -1, 384001, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Baseten output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Baseten thinking level.'); expect(calls).toEqual([]);
    for (const model of [kimi, combined, 'zai-org/GLM-5.3']) for (const thinking of levels) await provider.chat([message], { model, thinking });
    expect(calls.slice(0,7).map(call => call.body.chat_template_args.enable_thinking)).toEqual([false,true,true,true,true,true,true]);
    expect(calls.slice(7,14).map(call => call.body.reasoning_effort)).toEqual(['none','high','high','high','high','max','max']);
    expect(calls.slice(14).map(call => call.body.reasoning_effort)).toEqual(['low','low','low','high','high','max','max']);
    await provider.chat([image], { model: kimi }); expect(calls.at(-1)!.body.messages[0].content).toMatchObject([{ type: 'text' }, { type: 'image_url' }]); expect(provider.getConfiguredModel()).toBe(flash);
  });

  it('owns three session affinity headers, suppresses none and never sends unsupported long-cache body fields', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.BasetenProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const cacheRetention of ['short','long','none'] as const) await provider.chat([message], { sessionId: 'baseten-session', cacheRetention });
    for (const [index, call] of calls.entries()) { for (const name of ['session_id','x-client-request-id','x-session-affinity']) expect(call.headers[name]).toBe(index < 2 ? 'baseten-session' : undefined); expect(call.headers['session-id']).toBeUndefined(); expect(call.headers['nvcf-poll-seconds']).toBeUndefined(); expect(call.body).not.toHaveProperty('prompt_cache_key'); expect(call.body).not.toHaveProperty('prompt_cache_retention'); }
    await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([message], { sessionId: 'automatic' }); expect(calls.at(-1)!.headers['x-session-affinity']).toBe('operator-owned');
    await expect(provider.chat([message], { sessionId: 'bad\nidentity' })).rejects.toThrow('Invalid Baseten session identity.');
  });

  it('requires supplied representable keys and safe endpoints without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('BASETEN_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new providers.BasetenProvider({ type: 'operator', apiKey, baseUrl }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([message])).rejects.toThrow('Baseten API key is required.'); }
    for (const endpoint of ['https://user:private@host/v1', 'https://host/v1?private=key', 'https://host/v1#private', 'ftp://host/v1']) expect(() => new providers.BasetenProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Baseten endpoint.');
    await expect(new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Baseten request headers.'); expect(calls).toEqual([]);
    await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions/' }).chat([message]); expect(calls[0].url).toBe('/owned%2Fbaseten/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch', async endpoint => { url = String(endpoint); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); }); await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://inference.baseten.co/v1/chat/completions');
  });

  it.each(['chat', 'stream'] as const)('captures configured physical fallback for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.BasetenProvider({ type: 'operator-baseten', apiKey: 'disposable', baseUrl, model: flash });
    let result: unknown;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(kimi); }, value => { result = value; }, error => { throw error; }, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(flash);
    expect(result).toMatchObject({ provider: 'operator-baseten', model: flash, api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.13 + 2 * 0.26 + 4 * 0.028) / 1e6 } });
    expect(provider.getConfiguredModel()).toBe(operation === 'stream' ? kimi : flash);
  });

  it('captures physical prices and model before awaited callbacks and suppresses buffered delivery after withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); const seen: string[] = []; let completed: unknown;
    await provider.streamChat([message], async (_text, event) => { await Promise.resolve(); seen.push(event!.type); provider.setConfiguredModel(kimi); }, value => { completed = value; }); expect(seen).toEqual(['reasoning_delta', 'text_delta']); expect(completed).toMatchObject({ model: flash, api: 'openai-completions', usage: { costUsd: (5 * 0.13 + 2 * 0.26 + 4 * 0.028) / 1e6 } });
    const abort = new AbortController(), done = vi.fn(), failed = vi.fn(), withdrawn: string[] = []; await provider.streamChat([message], async (_text, event) => { withdrawn.push(event!.type); await Promise.resolve(); abort.abort(); }, done, failed, { signal: abort.signal }); expect(withdrawn).toEqual(['reasoning_delta']); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Baseten request aborted.');
  });

  it('requires native terminal authority before deferred tools and keeps errors and unsupported replay private', async () => {
    for (const finish of [undefined, 'content_filter', 'network_error']) { const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish ? { finish_reason: finish } : {}) }] }]); const chunks = vi.fn(), complete = vi.fn(), failed = vi.fn(); await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).streamChat([message], chunks, complete, failed); expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Invalid Baseten chat response.'); }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]); let result: unknown; await new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message], () => {}, value => { result = value; }); expect(result).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const bad = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]); await expect(new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl }).streamChat([message], () => { throw Error('Unexpected chunk'); })).rejects.toThrow('Baseten chat request failed.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning_details: [{ type: 'encrypted', data: 'private' }] }, finish_reason: 'stop' }] }))); await expect(new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).chat([message])).rejects.toThrow('Unsupported Baseten reasoning replay.');
  });

  it('keeps only the configured512-token virtual classifier and genuine accounting without image generation', async () => {
    const { baseUrl } = await fixture(), provider = new providers.BasetenProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${flash}:classifier`, virtual: true, api: 'openai-completions', imageInput: false }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]); await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    let body: Record<string, any> = {}; vi.stubGlobal('fetch', async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })); }); expect(await new SpecializedModels(provider).classify({ model: `${flash}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.13 + 2 * 0.26 + 4 * 0.028) / 1e6 } }); expect(body.max_tokens).toBe(512);
    provider.setConfiguredModel(kimi); expect(provider.getSpecializedModels()[0].imageInput).toBe(true);
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([message])).usage).toBeUndefined(); }
  });
});
