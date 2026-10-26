import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const flash = 'deepseek-ai/DeepSeek-V4-Flash-0731', pro = 'deepseek-ai/DeepSeek-V4-Pro-0813', mini = 'MiniMaxAI/MiniMax-M2.7', vision = 'MiniMaxAI/MiniMax-M3', gpt = 'openai/gpt-oss-120b';
const ids = [flash, pro, 'deepseek-ai/DeepSeek-V4.1-Flash', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', mini, vision, 'moonshotai/Kimi-K3', 'nvidia/nemotron-3-ultra-550b-a55b', gpt, 'Qwen/Qwen2.5-7B-Instruct-Turbo', 'Qwen/Qwen3.5-9B', 'Qwen/Qwen3.6-Plus', 'Qwen/Qwen3.7-Max', 'thinkingmachines/Inkling', 'zai-org/GLM-5.2', 'zai-org/GLM-5.3', 'zai-org/GLM-5.3-Flash'];
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Ftogether/v1` };
}

describe('explicit native Together C SDK', () => {
  it('keeps generic compatible C distinct from native enabled reasoning', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.OpenAiProvider({ type: 'together', apiKey: 'disposable', baseUrl, model: flash }).chat([message], { thinking: 'high', maxTokens: 64 });
    expect(calls[0].body).toMatchObject({ max_tokens: 64, reasoning_effort: 'high' }); expect(calls[0].body).not.toHaveProperty('reasoning');
  });

  it('publishes17 immutable known-priced profiles and defensive actual-adapter metadata without discovery or factory', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.TogetherProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(providers.TOGETHER_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.TOGETHER_MODELS)).toBe(true);
    expect(providers.TOGETHER_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.thinkingLevelMap))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(flash); expect(providers.ProviderFactory.has('together')).toBe(false);
    const row = getProviderPublishedModel('anthropic', vision, provider)!;
    expect(row).toMatchObject({ name: 'MiniMax-M3', api: 'openai-completions', contextWindow: 524288, maxOutputTokens: 250000, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.06, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', vision, provider)).toMatchObject({ contextWindow: 524288, thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: null } });
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', flash, undefined, provider)).toEqual(['off','high']); expect(getSupportedThinkingLevels('anthropic', mini, undefined, provider)).toEqual(['high']); expect(getSupportedThinkingLevels('anthropic', gpt, undefined, provider)).toEqual(['low','medium','high']);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
  });

  it('owns enabled versus combined or effort-only reasoning, system roles, omitted strict fields and exact caps', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['openai','anthropic','azure','operator-together']) {
      const provider = new providers.TogetherProvider({ type, apiKey: 'disposable-together', baseUrl, model: pro });
      expect(await provider.chat([message], { thinking: 'off', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: pro, api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 1.32 + 2 * 3.96 + 4 * 0.13) / 1e6 } });
    }
    for (const call of calls) { expect(call.url).toBe('/owned%2Ftogether/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-together'); expect(call.body).toMatchObject({ max_tokens: 64, reasoning: { enabled: false }, messages: [{ role: 'system' }, { role: 'user' }] }); expect(call.body.tools[0].function).not.toHaveProperty('strict'); for (const key of ['reasoning_effort','max_completion_tokens','store','prompt_cache_key','prompt_cache_retention','thinking','tool_stream','chat_template_args','chat_template_kwargs']) expect(call.body).not.toHaveProperty(key); }
    const provider = new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([message], { model: pro, thinking: 'high' }); expect(calls.at(-1)!.body).toMatchObject({ reasoning: { enabled: true }, reasoning_effort: 'high' });
    await provider.chat([message], { model: mini }); expect(calls.at(-1)!.body).toMatchObject({ reasoning: { enabled: true } }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort'); expect(calls.at(-1)!.body).not.toHaveProperty('max_tokens');
    await provider.chat([message], { model: gpt, thinking: 'off' }); expect(calls.at(-1)!.body.reasoning_effort).toBe('low'); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning');
    await provider.chat([message], { model: ids[3], thinking: 'high' }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning'); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort');
  });

  it('clamps missing extended levels and mandatory reasoning, admitting only declared models and images', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future','dall-e-3','gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('Together chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Together chat model is not supported.'); }
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Together chat model does not support images.');
    for (const maxTokens of [0,-1,384001,1.5,Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Together output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Together thinking level.'); expect(calls).toEqual([]);
    for (const model of [flash,mini,gpt]) for (const thinking of levels) await provider.chat([message], { model, thinking });
    expect(calls.slice(0,7).map(call => call.body.reasoning.enabled)).toEqual([false,true,true,true,true,true,true]); expect(calls.slice(7,14).map(call => call.body.reasoning.enabled)).toEqual([true,true,true,true,true,true,true]); expect(calls.slice(14).map(call => call.body.reasoning_effort)).toEqual(['low','low','low','medium','high','high','high']);
    await provider.chat([image], { model: vision }); expect(calls.at(-1)!.body.messages[0].content).toMatchObject([{ type: 'text' }, { type: 'image_url' }]); expect(provider.getConfiguredModel()).toBe(flash);
  });

  it('adds neither automatic affinity nor foreign cache or poll fields while preserving configured headers', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.TogetherProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const cacheRetention of ['short','long','none'] as const) await provider.chat([message], { sessionId: 'together-session', cacheRetention });
    for (const call of calls) { for (const name of ['session_id','session-id','x-client-request-id','x-session-affinity','nvcf-poll-seconds']) expect(call.headers[name]).toBeUndefined(); expect(call.body).not.toHaveProperty('prompt_cache_key'); expect(call.body).not.toHaveProperty('prompt_cache_retention'); }
    await new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([message], { sessionId: 'not-automatic' }); expect(calls.at(-1)!.headers['x-session-affinity']).toBe('operator-owned');
  });

  it('requires supplied representable keys and safe endpoints without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('TOGETHER_API_KEY','ambient-private'); vi.stubEnv('OPENAI_API_KEY','ambient-openai');
    for (const apiKey of [undefined,'','bad\0key','bad\nkey','bad🔑key']) { const provider = new providers.TogetherProvider({ type: 'operator', apiKey, baseUrl }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([message])).rejects.toThrow('Together API key is required.'); }
    for (const endpoint of ['https://user:private@host/v1','https://host/v1?private=key','https://host/v1#private','ftp://host/v1']) expect(() => new providers.TogetherProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Together endpoint.');
    await expect(new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Together request headers.'); expect(calls).toEqual([]);
    await new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions/' }).chat([message]); expect(calls[0].url).toBe('/owned%2Ftogether/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch',async endpoint => { url = String(endpoint); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); }); await new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://api.together.ai/v1/chat/completions');
  });

  it.each(['chat', 'stream'] as const)('captures configured physical fallback for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.TogetherProvider({ type: 'operator-together', apiKey: 'disposable', baseUrl, model: flash });
    let result: unknown;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(mini); }, value => { result = value; }, error => { throw error; }, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(flash);
    expect(result).toMatchObject({ provider: 'operator-together', model: flash, api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.14 + 2 * 0.28 + 4 * 0.03) / 1e6 } });
    expect(provider.getConfiguredModel()).toBe(operation === 'stream' ? mini : flash);
  });

  it('captures physical prices and model before awaited callbacks and suppresses buffered delivery after withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); const seen: string[] = []; let completed: unknown;
    await provider.streamChat([message],async (_text,event) => { await Promise.resolve(); seen.push(event!.type); provider.setConfiguredModel(mini); },value => { completed = value; }); expect(seen).toEqual(['reasoning_delta','text_delta']); expect(completed).toMatchObject({ model: flash, api: 'openai-completions', usage: { costUsd: (5 * 0.14 + 2 * 0.28 + 4 * 0.03) / 1e6 } });
    const abort = new AbortController(), done = vi.fn(), failed = vi.fn(), withdrawn: string[] = []; await provider.streamChat([message],async (_text,event) => { withdrawn.push(event!.type); await Promise.resolve(); abort.abort(); },done,failed,{ signal: abort.signal }); expect(withdrawn).toEqual(['reasoning_delta']); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Together request aborted.');
  });

  it('requires terminal authority before deferred tools and keeps errors and unsupported replay private', async () => {
    for (const finish of [undefined,'content_filter','network_error']) { const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish ? { finish_reason: finish } : {}) }] }]); const chunks = vi.fn(), complete = vi.fn(), failed = vi.fn(); await new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).streamChat([message],chunks,complete,failed); expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Invalid Together chat response.'); }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]); let result: unknown; await new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message],() => {},value => { result = value; }); expect(result).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const bad = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]); await expect(new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl }).streamChat([message],() => { throw Error('Unexpected chunk'); })).rejects.toThrow('Together chat request failed.');
    vi.stubGlobal('fetch',async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning_details: [{ type: 'encrypted', data: 'private' }] }, finish_reason: 'stop' }] }))); await expect(new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).chat([message])).rejects.toThrow('Unsupported Together reasoning replay.');
  });

  it('keeps only the configured512-token virtual classifier and genuine accounting without image generation', async () => {
    const { baseUrl } = await fixture(), provider = new providers.TogetherProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${flash}:classifier`, virtual: true, api: 'openai-completions', imageInput: false }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]); await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    let body: Record<string, any> = {}; vi.stubGlobal('fetch',async (_url,init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })); }); expect(await new SpecializedModels(provider).classify({ model: `${flash}:classifier`, input: 'Approve', labels: ['safe','review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.14 + 2 * 0.28 + 4 * 0.03) / 1e6 } }); expect(body.max_tokens).toBe(512);
    provider.setConfiguredModel(vision); expect(provider.getSpecializedModels()[0].imageInput).toBe(true);
    for (const usage of [{ prompt_tokens: 10 },{ prompt_tokens: -1, completion_tokens: 2 },{ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) { vi.stubGlobal('fetch',async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([message])).usage).toBeUndefined(); }
  });
});
