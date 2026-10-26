import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'mimo-v2.5', last = 'mimo-v2.6-pro-ultraspeed';
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fxiaomi/v1` };
}

describe('explicit native Xiaomi C SDK', () => {
  it('does not borrow native metadata from a compatible URL or routed Xiaomi identity', async () => {
    const { calls, baseUrl } = await fixture(), generic = new providers.OpenAiProvider({ type: 'xiaomi', apiKey: 'disposable', baseUrl, model: first });
    await generic.chat([message], { maxTokens: 64 }); expect(calls).toHaveLength(1);
    expect(getProviderPublishedModel('xiaomi', first, generic)).toBeUndefined();
  });

  it('publishes six frozen direct profiles with defensive actual-adapter metadata and one configured classifier', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    const profiles = providers.XIAOMI_MODELS, ids = profiles.map(profile => profile.id);
    expect(ids).toEqual([first, 'mimo-v2.5-pro', 'mimo-v2.5-pro-ultraspeed', 'mimo-v2.6-flash', 'mimo-v2.6-pro', last]);
    expect(Object.isFrozen(profiles)).toBe(true); expect(profiles.every(p => Object.isFrozen(p) && Object.isFrozen(p.pricing) && Object.isFrozen(p.declaredInput) && Object.isFrozen(p.thinkingLevelMap))).toBe(true);
    expect(profiles.filter(p => p.declaredInput.includes('image'))).toHaveLength(4); expect(profiles.every(p => p.reasoning)).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.getConfiguredModel()).toBe(first); expect(provider.canDiscoverModels()).toBe(false); expect(providers.ProviderFactory.has('xiaomi')).toBe(false);
    const row = getProviderPublishedModel('anthropic', first, provider)!;
    expect(row).toMatchObject({ name: 'MiMo-V2.5', api: 'openai-completions', contextWindow: 1048576, maxOutputTokens: 131072, pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028, cacheWritePerMillion: 0 }, capabilities: { reasoning: true, imageInput: true, toolCalls: true } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', first, provider)).toMatchObject({ contextWindow: 1048576, pricing: { inputPerMillion: 0.14 }, thinkingLevelMap: { high: 'high', xhigh: null, max: null } });
    expect(getProviderPublishedModel('anthropic', 'xiaomi/mimo-v2.5', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', first, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(p => p.id)).toEqual(ids);
    expect(provider.getSpecializedModels()).toEqual([expect.objectContaining({ model: first, type: 'classifier', virtual: true, api: 'openai-completions', imageInput: true })]); expect(calls).toEqual([]);
  });

  it('owns developer/store/deepseek-format/replay/non-strict/max-completion policy independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const prior: Message = { ...message, id: 'prior', role: 'assistant', content: 'Prior', blocks: [{ type: 'reasoning', text: 'Saved thought' }, { type: 'text', text: 'Prior' }] };
    for (const type of ['openai', 'anthropic', 'deepseek', 'operator-xiaomi']) {
      const provider = new providers.XiaomiProvider({ type, apiKey: 'disposable-xiaomi', baseUrl, model: first });
      expect(await provider.chat([prior, message], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: first, api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.14 + 2 * 0.28 + 4 * 0.0028) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fxiaomi/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-xiaomi');
      expect(call.body).toMatchObject({ store: false, max_completion_tokens: 64, thinking: { type: 'enabled' }, reasoning_effort: 'high', messages: [{ role: 'developer' }, { role: 'assistant', reasoning_content: 'Saved thought' }, { role: 'user' }], tools: [{ function: { strict: false } }] });
      for (const key of ['max_tokens', 'enable_thinking', 'tool_stream', 'chat_template_args', 'chat_template_kwargs', 'reasoning', 'prompt_cache_key', 'prompt_cache_retention']) expect(call.body).not.toHaveProperty(key);
    }
    const provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...message, role: 'assistant', content: 'Prior' }, message]); expect(calls.at(-1)!.body.messages[0]).toMatchObject({ role: 'assistant', reasoning_content: '' });
    expect(calls.at(-1)!.body.thinking).toEqual({ type: 'disabled' }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort'); expect(calls.at(-1)!.body).not.toHaveProperty('max_completion_tokens');
    for (const thinking of levels) await provider.chat([message], { thinking });
    expect(calls.slice(-7).map(c => c.body.reasoning_effort)).toEqual([undefined, 'minimal', 'low', 'medium', 'high', 'high', 'high']);
  });

  it('admits only six direct IDs, exact safe caps and four declared image inputs before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'xiaomi/mimo-v2.5', 'deepseek-flash']) { expect(() => provider.setConfiguredModel(model)).toThrow('Xiaomi chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Xiaomi chat model is not supported.'); }
    for (const maxTokens of [0, -1, 131073, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Xiaomi output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Xiaomi thinking level.'); expect(calls).toEqual([]);
    const image: Message = { ...message, blocks: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] };
    for (const profile of providers.XIAOMI_MODELS) {
      if (profile.declaredInput.includes('image')) { await provider.chat([image], { model: profile.id, maxTokens: 131072 }); expect(calls.at(-1)!.body.max_completion_tokens).toBe(131072); }
      else await expect(provider.chat([image], { model: profile.id })).rejects.toThrow('Xiaomi chat model does not support images.');
    }
    expect(calls).toHaveLength(4); expect(provider.getConfiguredModel()).toBe(first);
  });

  it('owns explicit long24h Unicode64 cache without automatic affinity and preserves configured headers', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const cacheRetention of ['short', 'long', 'none'] as const) await provider.chat([message], { sessionId: '🙂'.repeat(70), cacheRetention });
    expect(calls[1].body).toMatchObject({ prompt_cache_retention: '24h', prompt_cache_key: '🙂'.repeat(64) });
    for (const i of [0, 2]) { expect(calls[i].body).not.toHaveProperty('prompt_cache_retention'); expect(calls[i].body).not.toHaveProperty('prompt_cache_key'); }
    for (const call of calls) for (const name of ['session_id', 'session-id', 'x-client-request-id', 'x-session-affinity', 'nvcf-poll-seconds']) expect(call.headers[name]).toBeUndefined();
    await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([message]); expect(calls.at(-1)!.headers['x-session-affinity']).toBe('operator-owned');
  });

  it.each(['chat', 'stream'] as const)('captures physical fallback and prices for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    let result: providers.ChatResponse | undefined;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(last); }, response => { result = response; }, undefined, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(first);
    expect(result).toMatchObject({ provider: 'operator', model: first, api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.14 + 2 * 0.28 + 4 * 0.0028) / 1e6 } });
    if (operation === 'stream') expect(provider.getConfiguredModel()).toBe(last);
  });

  it('suppresses buffered callbacks and completion after awaited withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const abort = new AbortController(), complete = vi.fn(), failed = vi.fn(), seen: string[] = [];
    await provider.streamChat([message], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, failed, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Xiaomi request aborted.');
  });

  it('keeps partial usage unknown and rejects invalid terminal/replay authority privately', async () => {
    const partial = await fixture(undefined, { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } });
    expect((await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: partial.baseUrl }).chat([message])).usage).toBeUndefined();
    const bad = await fixture(undefined, { choices: [{ message: { content: 'private-body', reasoning_details: [{ secret: 'private-body' }] }, finish_reason: 'stop' }] });
    await expect(new providers.XiaomiProvider({ type: 'operator', apiKey: 'private-key', baseUrl: bad.baseUrl }).chat([message])).rejects.toThrow('Unsupported Xiaomi reasoning replay.');
    const truncated = await fixture([{ choices: [{ delta: { content: 'Prefix' } }] }]);
    await expect(new providers.XiaomiProvider({ type: 'operator', apiKey: 'private-key', baseUrl: truncated.baseUrl }).streamChat([message], () => {})).rejects.toThrow('Invalid Xiaomi chat response.');
  });

  it('requires a supplied representable key and safely composes encoded/full/default endpoints without ambient auth', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('XIAOMI_API_KEY', 'ambient-key'); vi.stubEnv('OPENAI_API_KEY', 'ambient-key');
    expect(new providers.XiaomiProvider({ type: 'xiaomi' }).validateConfig()).toBe(false);
    for (const apiKey of ['', 'bad\nkey', '🙂']) await expect(new providers.XiaomiProvider({ type: 'operator', apiKey, baseUrl }).chat([message])).rejects.toThrow('Xiaomi API key is required.');
    expect(calls).toEqual([]); expect(() => new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: 'https://user:secret@example.test' })).toThrow('Invalid Xiaomi endpoint.');
    await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions' }).chat([message]); expect(calls[0].url).toBe('/owned%2Fxiaomi/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => { url = String(input); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }), { status: 200 }); }));
    await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  });

  it('retains the existing configured virtual classifier512 and refuses image generation', async () => {
    const { calls, baseUrl } = await fixture(undefined, { choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }] });
    const provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const model = provider.getSpecializedModels()[0];
    expect(await new SpecializedModels(provider).classify({ model: model.id, input: 'hello', labels: ['safe', 'unsafe'] })).toMatchObject({ label: 'safe' });
    expect(calls).toHaveLength(1); expect(calls[0].body.max_completion_tokens).toBe(512);
    await expect(provider.generateImages({ model: 'image', prompt: 'Image' })).rejects.toThrow('Image model or options are not supported.');
  });
});
