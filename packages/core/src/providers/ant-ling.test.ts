import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const ids = ['Ling-2.6-1T', 'Ling-2.6-flash', 'Ring-2.6-1T'];
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fant-ling/v1` };
}

describe('explicit native Ant Ling C SDK', () => {
  it('keeps generic compatible C distinct from native Ring policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.OpenAiProvider({ type: 'ant-ling', apiKey: 'disposable', baseUrl, model: ids[2] }).chat([message], { thinking: 'high', maxTokens: 64 });
    expect(calls[0].body.max_tokens).toBe(64); expect(calls[0].body).not.toHaveProperty('reasoning');
  });

  it('publishes three immutable text-only profiles and defensive metadata without factory or discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(providers.ANT_LING_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.ANT_LING_MODELS)).toBe(true);
    expect(providers.ANT_LING_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(ids[0]); expect(providers.ProviderFactory.has('ant-ling')).toBe(false);
    const row = getProviderPublishedModel('anthropic', ids[2], provider)!;
    expect(row).toMatchObject({ name: 'Ring 2.6 1T', api: 'openai-completions', contextWindow: 262144, maxOutputTokens: 65536, capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.06, outputPerMillion: 0.25, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', ids[2], provider)).toMatchObject({ contextWindow: 262144, thinkingLevelMap: { high: 'high', xhigh: 'xhigh' } });
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', ids[2], undefined, provider)).toEqual(['high', 'xhigh']);
    expect(getSupportedThinkingLevels('anthropic', ids[0], undefined, provider)).toEqual(['off']); expect(getSupportedThinkingLevels('anthropic', 'gpt-4o', undefined, provider)).toEqual(['off']);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
  });

  it('owns system roles, nested Ring effort, supported non-strict tools and explicit output independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['openai', 'anthropic', 'azure', 'operator-ant-ling']) {
      const provider = new providers.AntLingProvider({ type, apiKey: 'disposable-ant-ling', baseUrl, model: ids[2] });
      expect(await provider.chat([message], { thinking: 'off', maxTokens: 64, systemPrompt: 'System', sessionId: 'not-cache-authority', cacheRetention: 'long', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: ids[2], api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.06 + 2 * 0.25) / 1e6 } });
    }
    for (const call of calls) { expect(call.url).toBe('/owned%2Fant-ling/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-ant-ling'); expect(call.headers['api-key']).toBeUndefined(); expect(call.body).toMatchObject({ max_tokens: 64, reasoning: { effort: 'high' }, messages: [{ role: 'system' }, { role: 'user' }], tools: [{ function: { strict: false } }] }); for (const key of ['max_completion_tokens', 'reasoning_effort', 'store', 'prompt_cache_key', 'prompt_cache_retention', 'thinking', 'tool_stream']) expect(call.body).not.toHaveProperty(key); }
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).chat([message]); expect(calls.at(-1)!.body).not.toHaveProperty('max_tokens'); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning');
  });

  it('clamps Ring high/xhigh, keeps Ling nonreasoning and refuses unsupported models/images/caps before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'dall-e-3', 'gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('Ant Ling chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Ant Ling chat model is not supported.'); }
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] };
    for (const model of ids) await expect(provider.chat([image], { model })).rejects.toThrow('Ant Ling chat model does not support images.');
    for (const maxTokens of [0, -1, 65537, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Ant Ling output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Ant Ling thinking level.'); expect(calls).toEqual([]);
    for (const model of ids) for (const thinking of levels) await provider.chat([message], { model, thinking, maxTokens: 65536 });
    expect(calls.slice(0, 14).every(call => !('reasoning' in call.body))).toBe(true); expect(calls.slice(14).map(call => call.body.reasoning.effort)).toEqual(['high', 'high', 'high', 'high', 'high', 'xhigh', 'xhigh']);
  });

  it('requires supplied representable keys and safe endpoints without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('ANT_LING_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new providers.AntLingProvider({ type: 'operator', apiKey, baseUrl }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([message])).rejects.toThrow('Ant Ling API key is required.'); }
    for (const endpoint of ['https://user:private@host/v1', 'https://host/v1?private=key', 'https://host/v1#private', 'ftp://host/v1']) expect(() => new providers.AntLingProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Ant Ling endpoint.');
    await expect(new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Ant Ling request headers.'); expect(calls).toEqual([]);
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions/' }).chat([message]); expect(calls[0].url).toBe('/owned%2Fant-ling/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch', async endpoint => { url = String(endpoint); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://api.ant-ling.com/v1/chat/completions');
  });

  it.each(['chat', 'stream'] as const)('captures configured physical fallback for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator-ant-ling', apiKey: 'disposable', baseUrl, model: ids[0] });
    let result: unknown;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(ids[1]); }, value => { result = value; }, error => { throw error; }, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(ids[0]);
    expect(result).toMatchObject({ provider: 'operator-ant-ling', model: ids[0], api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.06 + 2 * 0.25) / 1e6 } });
    expect(provider.getConfiguredModel()).toBe(operation === 'stream' ? ids[1] : ids[0]);
  });

  it('captures model/prices before awaited callbacks and suppresses buffered delivery after withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: ids[2] });
    const seen: string[] = []; let completed: unknown;
    await provider.streamChat([message], async (_text, event) => { await Promise.resolve(); seen.push(event!.type); provider.setConfiguredModel(ids[1]); }, value => { completed = value; });
    expect(seen).toEqual(['reasoning_delta', 'text_delta']); expect(completed).toMatchObject({ model: ids[2], api: 'openai-completions', usage: { costUsd: (5 * 0.06 + 2 * 0.25) / 1e6 } });
    const abort = new AbortController(), done = vi.fn(), failed = vi.fn(), withdrawn: string[] = [];
    await provider.streamChat([message], async (_text, event) => { withdrawn.push(event!.type); await Promise.resolve(); abort.abort(); }, done, failed, { signal: abort.signal });
    expect(withdrawn).toEqual(['reasoning_delta']); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Ant Ling request aborted.');
  });

  it('requires native terminal authority before deferred tools/success and keeps errors private', async () => {
    for (const finish of [undefined, 'content_filter', 'network_error']) { const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish ? { finish_reason: finish } : {}) }] }]); const chunks = vi.fn(), complete = vi.fn(), failed = vi.fn(); await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).streamChat([message], chunks, complete, failed); expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Invalid Ant Ling chat response.'); }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]); let result: unknown;
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message], () => {}, value => { result = value; }); expect(result).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const bad = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]); await expect(new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl }).streamChat([message], () => { throw Error('Unexpected chunk'); })).rejects.toThrow('Ant Ling chat request failed.');
  });

  it('keeps only the configured classifier and genuine accounting without exposing image operations', async () => {
    const { baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: ids[1] });
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${ids[1]}:classifier`, virtual: true, api: 'openai-completions', imageInput: false }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]); await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })));
    expect(await new SpecializedModels(provider).classify({ model: `${ids[1]}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.01 + 2 * 0.02) / 1e6 } });
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([message])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning_details: [{ type: 'encrypted', data: 'private' }] }, finish_reason: 'stop' }] }))); await expect(provider.chat([message])).rejects.toThrow('Unsupported Ant Ling reasoning replay.');
  });
});
