import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'deepseek-ai/DeepSeek-R1', sparse = 'Qwen/Qwen3.8-2.4T-A95B', mini = 'MiniMaxAI/MiniMax-M3', unknown = 'zai-org/GLM-4.7-Flash';
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fhuggingface/v1` };
}

describe('explicit native Hugging Face C SDK', () => {
  it('does not treat a compatible C URL or shared model ID as published HF metadata', async () => {
    const { calls, baseUrl } = await fixture(), generic = new providers.OpenAiProvider({ type: 'huggingface', apiKey: 'disposable', baseUrl, model: first });
    await generic.chat([message], { maxTokens: 64 }); expect(calls).toHaveLength(1);
    expect(getProviderPublishedModel('huggingface', first, generic)).toBeUndefined();
  });

  it('publishes78 immutable profiles with defensive owned metadata and one unknown zero-only price table', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.HuggingFaceProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    const profiles = providers.HUGGINGFACE_MODELS, ids = profiles.map(profile => profile.id);
    expect(ids).toHaveLength(78); expect(ids[0]).toBe(first); expect(ids.at(-1)).toBe('zai-org/GLM-5.3-Flash'); expect(Object.isFrozen(profiles)).toBe(true);
    expect(profiles.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.declaredPricing) && (!profile.pricing || Object.isFrozen(profile.pricing)) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.thinkingLevelMap))).toBe(true);
    expect(profiles.filter(profile => !profile.pricing).map(profile => profile.id)).toEqual([unknown]); expect(profiles.filter(profile => profile.reasoning)).toHaveLength(60); expect(profiles.filter(profile => profile.declaredInput.includes('image'))).toHaveLength(29);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(first); expect(providers.ProviderFactory.has('huggingface')).toBe(false);
    const row = getProviderPublishedModel('anthropic', mini, provider)!;
    expect(row).toMatchObject({ name: 'MiniMax-M3', api: 'openai-completions', contextWindow: 524288, maxOutputTokens: 512000, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', mini, provider)).toMatchObject({ contextWindow: 524288, maxOutputTokens: 512000, thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: null } });
    expect(getProviderPublishedModel('anthropic', unknown, provider)?.pricing).toBeUndefined(); expect(getProviderPublishedModel('anthropic', 'thinkingmachines/Inkling-Small', provider)).toMatchObject({ contextWindow: 524288, maxOutputTokens: 1048576 });
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', sparse, undefined, provider)).toEqual(['low','medium','xhigh']);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
  });

  it('owns system/store/effort/non-strict tools/max-completion fields regardless of aliases or shared vendor names', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['openai','anthropic','deepseek','operator-hf']) {
      const provider = new providers.HuggingFaceProvider({ type, apiKey: 'disposable-hf', baseUrl, model: first });
      expect(await provider.chat([message], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: first, api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.7 + 2 * 2.5) / 1e6 } });
    }
    for (const call of calls) { expect(call.url).toBe('/owned%2Fhuggingface/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-hf'); expect(call.body).toMatchObject({ max_completion_tokens: 64, store: false, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }], tools: [{ function: { strict: false } }] }); for (const key of ['reasoning','max_tokens','prompt_cache_key','prompt_cache_retention','thinking','enable_thinking','tool_stream','chat_template_args','chat_template_kwargs']) expect(call.body).not.toHaveProperty(key); }
    const provider = new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([message], { model: 'deepseek-ai/DeepSeek-V4-Pro', thinking: 'off' }); expect(calls.at(-1)!.body.reasoning_effort).toBe('high'); expect(calls.at(-1)!.body).not.toHaveProperty('max_completion_tokens');
    await provider.chat([message], { model: 'google/gemma-3-4b-it', thinking: 'high' }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort');
    await provider.chat([message], { model: 'deepseek-ai/DeepSeek-V4.1-Flash', thinking: 'off' }); expect(calls.at(-1)!.body.reasoning_effort).toBe('none'); expect(calls.at(-1)!.body).not.toHaveProperty('thinking');
    const previous: Message = { ...message, id: 'previous', role: 'assistant', content: 'Prior', blocks: [{ type: 'reasoning', text: 'Visible thought' }, { type: 'text', text: 'Prior' }] };
    await provider.chat([previous,message], { model: 'moonshotai/Kimi-K3' }); expect(calls.at(-1)!.body.messages[0]).not.toHaveProperty('reasoning_content'); expect(calls.at(-1)!.body).not.toHaveProperty('thinking');
  });

  it('clamps sparse maps and admits only declared models, caps and images before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future','dall-e-3','gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('Hugging Face chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Hugging Face chat model is not supported.'); }
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Hugging Face chat model does not support images.');
    for (const maxTokens of [0,-1,32769,1.5,Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Hugging Face output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Hugging Face thinking level.'); expect(calls).toEqual([]);
    for (const thinking of levels) await provider.chat([message], { model: sparse, thinking }); expect(calls.map(call => call.body.reasoning_effort)).toEqual(['low','low','low','medium','xhigh','xhigh','xhigh']);
    await provider.chat([image], { model: mini }); expect(calls.at(-1)!.body.messages[0].content).toMatchObject([{ type: 'text' }, { type: 'image_url' }]); expect(provider.getConfiguredModel()).toBe(first);
    await provider.chat([message], { model: 'meta-llama/Llama-3.1-8B-Instruct', maxTokens: 4096 }); expect(calls.at(-1)!.body.max_completion_tokens).toBe(4096);
    await expect(provider.chat([message], { model: 'meta-llama/Llama-3.1-8B-Instruct', maxTokens: 4097 })).rejects.toThrow('Invalid Hugging Face output limit.');
  });

  it('owns explicit long24h cache with64 Unicode code points and no automatic affinity', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.HuggingFaceProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const cacheRetention of ['short','long','none'] as const) await provider.chat([message], { sessionId: '🙂'.repeat(70), cacheRetention });
    for (const call of calls) for (const name of ['session_id','session-id','x-client-request-id','x-session-affinity','nvcf-poll-seconds']) expect(call.headers[name]).toBeUndefined();
    expect(calls[1].body).toMatchObject({ store: false, prompt_cache_key: '🙂'.repeat(64), prompt_cache_retention: '24h' });
    for (const index of [0,2]) { expect(calls[index].body).not.toHaveProperty('prompt_cache_key'); expect(calls[index].body).not.toHaveProperty('prompt_cache_retention'); }
    await new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([message], { sessionId: 'not-automatic', cacheRetention: 'none' }); expect(calls.at(-1)!.headers['x-session-affinity']).toBe('operator-owned');
  });

  it('requires supplied representable tokens and safe endpoints without HF_TOKEN fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('HF_TOKEN','ambient-private'); vi.stubEnv('OPENAI_API_KEY','ambient-openai');
    for (const apiKey of [undefined,'','bad\0key','bad\nkey','bad🔑key']) { const provider = new providers.HuggingFaceProvider({ type: 'operator', apiKey, baseUrl }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([message])).rejects.toThrow('Hugging Face API key is required.'); }
    for (const endpoint of ['https://user:private@host/v1','https://host/v1?private=key','https://host/v1#private','ftp://host/v1']) expect(() => new providers.HuggingFaceProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Hugging Face endpoint.');
    await expect(new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Hugging Face request headers.'); expect(calls).toEqual([]);
    await new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions/' }).chat([message]); expect(calls[0].url).toBe('/owned%2Fhuggingface/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch',async endpoint => { url = String(endpoint); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); }); await new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://router.huggingface.co/v1/chat/completions');
  });

  it.each(['chat', 'stream'] as const)('captures configured physical fallback for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.HuggingFaceProvider({ type: 'operator-hf', apiKey: 'disposable', baseUrl, model: first });
    let result: unknown;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(unknown); }, value => { result = value; }, undefined, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(first);
    expect(result).toMatchObject({ provider: 'operator-hf', model: first, api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.7 + 2 * 2.5) / 1e6 } });
    expect(provider.getConfiguredModel()).toBe(operation === 'stream' ? unknown : first);
  });

  it('captures physical model and known or unknown prices before awaited callbacks and withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); const seen: string[] = []; let completed: unknown;
    await provider.streamChat([message],async (_text,event) => { await Promise.resolve(); seen.push(event!.type); provider.setConfiguredModel(unknown); },value => { completed = value; }); expect(seen).toEqual(['reasoning_delta','text_delta']); expect(completed).toMatchObject({ model: first, api: 'openai-completions', usage: { costUsd: (5 * 0.7 + 2 * 2.5) / 1e6 } });
    const unpriced = await provider.chat([message]); expect(unpriced.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, totalTokens: 12 }); expect(unpriced.usage?.costUsd).toBeUndefined();
    const abort = new AbortController(), done = vi.fn(), failed = vi.fn(), withdrawn: string[] = []; await provider.streamChat([message],async (_text,event) => { withdrawn.push(event!.type); await Promise.resolve(); abort.abort(); },done,failed,{ signal: abort.signal }); expect(withdrawn).toEqual(['reasoning_delta']); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Hugging Face request aborted.');
  });

  it('requires terminal authority before deferred tools and keeps errors and opaque replay private', async () => {
    for (const finish of [undefined,'content_filter','network_error']) { const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish ? { finish_reason: finish } : {}) }] }]); const chunks = vi.fn(), complete = vi.fn(), failed = vi.fn(); await new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).streamChat([message],chunks,complete,failed); expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Invalid Hugging Face chat response.'); }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]); let result: unknown; await new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message],() => {},value => { result = value; }); expect(result).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const bad = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]); await expect(new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl }).streamChat([message],() => { throw Error('Unexpected chunk'); })).rejects.toThrow('Hugging Face chat request failed.');
    vi.stubGlobal('fetch',async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning_details: [{ type: 'encrypted', data: 'private' }] }, finish_reason: 'stop' }] }))); await expect(new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).chat([message])).rejects.toThrow('Unsupported Hugging Face reasoning replay.');
  });

  it('keeps only the configured512-token virtual classifier, genuine accounting and no image generation', async () => {
    const { baseUrl } = await fixture(), provider = new providers.HuggingFaceProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${first}:classifier`, virtual: true, api: 'openai-completions', imageInput: false }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]); await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    let body: Record<string, any> = {}; vi.stubGlobal('fetch',async (_url,init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })); }); expect(await new SpecializedModels(provider).classify({ model: `${first}:classifier`, input: 'Approve', labels: ['safe','review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.7 + 2 * 2.5) / 1e6 } }); expect(body.max_completion_tokens).toBe(512);
    provider.setConfiguredModel(mini); expect(provider.getSpecializedModels()[0].imageInput).toBe(true);
    for (const usage of [{ prompt_tokens: 10 },{ prompt_tokens: -1, completion_tokens: 2 },{ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) { vi.stubGlobal('fetch',async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([message])).usage).toBeUndefined(); }
  });
});
