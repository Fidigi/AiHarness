import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoonshotProvider, MOONSHOT_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'kimi-k2.6', second = 'kimi-k2.7-code', fast = 'kimi-k2.7-code-highspeed', latest = 'kimi-k3';
const ids = [first, second, fast, latest], levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fmoonshot/v1` };
}

describe('explicit native Moonshot C SDK', () => {
  it('keeps generic compatible thinking distinct from native K2 policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }).chat([input], { thinking: 'high' });
    expect(calls[0].body.reasoning_effort).toBe('high'); expect(calls[0].body).not.toHaveProperty('thinking');
  });

  it('publishes four deeply frozen profiles and defensive alias-independent metadata without discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(MOONSHOT_MODELS.map(row => row.id)).toEqual(ids); expect(Object.isFrozen(MOONSHOT_MODELS)).toBe(true);
    expect(MOONSHOT_MODELS.every(row => Object.isFrozen(row) && Object.isFrozen(row.pricing) && Object.isFrozen(row.declaredInput) && Object.isFrozen(row.declaredInputLimits?.images.resize))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(ProviderFactory.has('moonshotai')).toBe(false);
    const row = getProviderPublishedModel('azure', latest, provider)!;
    expect(row).toMatchObject({ name: 'Kimi K3', api: 'openai-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.low = 'changed';
    expect(getProviderPublishedModel('azure', latest, provider)).toMatchObject({ contextWindow: 1048576, thinkingLevelMap: { low: 'low' }, pricing: { inputPerMillion: 3 } });
    expect(getProviderPublishedModel('azure', 'gpt-4o', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('azure', first, undefined, provider)).toEqual(levels.slice(0, 5));
    expect(getSupportedThinkingLevels('azure', second, undefined, provider)).toEqual(levels.slice(1, 5));
    expect(getSupportedThinkingLevels('azure', latest, undefined, provider)).toEqual(['low', 'high', 'max']);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${first}:classifier`, virtual: true, imageInput: true, contextWindow: 262144 }]); expect(calls).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('owns K2 thinking versus K3 effort, mandatory replay and non-strict tools under unrelated aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const history: Message = { ...input, role: 'assistant', content: 'Before', blocks: [{ type: 'reasoning', text: 'Earlier' }, { type: 'text', text: 'Before' }] };
    for (const type of ['azure', 'local', 'operator-moonshot']) {
      const provider = new MoonshotProvider({ type, apiKey: 'disposable-moonshot', baseUrl });
      for (const model of ids) await provider.chat([history, input], { model, thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
    }
    for (const [index, call] of calls.entries()) {
      expect(call.url).toBe('/owned%2Fmoonshot/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-moonshot');
      expect(call.body).toMatchObject({ max_tokens: 64, messages: [{ role: 'system' }, { role: 'assistant', reasoning_content: 'Earlier' }, { role: 'user' }] });
      expect((call.body.tools as Array<{ function: object }>)[0].function).not.toHaveProperty('strict');
      expect(call.body).not.toHaveProperty('store'); expect(call.body).not.toHaveProperty('tool_stream');
      if (index % 4 === 3) { expect(call.body.reasoning_effort).toBe('high'); expect(call.body).not.toHaveProperty('thinking'); }
      else { expect(call.body.thinking).toEqual({ type: 'enabled' }); expect(call.body).not.toHaveProperty('reasoning_effort'); }
    }
    const provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...history, blocks: undefined }, input], { model: latest, thinking: 'off' });
    expect(calls.at(-1)?.body).toMatchObject({ reasoning_effort: 'low', max_tokens: 1048576, messages: [{ role: 'assistant', reasoning_content: '' }, { role: 'user' }] });
    await provider.chat([{ ...history, blocks: undefined }, input]); expect((calls.at(-1)?.body.messages as unknown[])[0]).not.toHaveProperty('reasoning_content');
    await provider.chat([{ ...history, content: '', blocks: undefined, toolCalls: [{ id: 'read', name: 'read', input: {} }] }, input], { model: latest });
    expect(calls.at(-1)?.body.tools).toEqual([]); expect((calls.at(-1)?.body.messages as unknown[])[0]).toHaveProperty('reasoning_content', '');
  });

  it('clamps four physical maps, preserves native output and accepts declared vision without mutating selection', async () => {
    const { calls, baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ids) for (const thinking of levels) await provider.chat([input], { model, thinking });
    expect(calls.map(call => call.body.reasoning_effort)).toEqual([...Array(21).fill(undefined), 'low', 'low', 'low', 'high', 'high', 'max', 'max']);
    for (const [index, call] of calls.entries()) { if (index < 21) expect(call.body.thinking).toEqual({ type: index === 0 ? 'disabled' : 'enabled' }); else expect(call.body).not.toHaveProperty('thinking'); }
    const image: Message = { ...input, blocks: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    for (const model of ids) await provider.chat([image], { model });
    expect(provider.getConfiguredModel()).toBe(first); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]);
  });

  it('requires explicit keys and refuses invalid selections, limits, endpoints and headers before I/O', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('MOONSHOT_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new MoonshotProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('Moonshot API key is required.'); }
    const provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'moonshotai', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Moonshot chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Moonshot chat model is not supported.'); }
    for (const maxTokens of [0, -1, 262145, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Moonshot output limit.');
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new MoonshotProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Moonshot endpoint.');
    await expect(new MoonshotProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid Moonshot request headers.'); expect(calls).toEqual([]);
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new MoonshotProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://api.moonshot.ai/v1/chat/completions');
  });

  it('captures physical model/prices, awaits reasoning and suppresses withdrawn callbacks', async () => {
    const { baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(latest); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(result).toMatchObject({ provider: 'operator', model: first, api: 'openai-completions', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.95 + 2 * 4 + 4 * 0.16) / 1e6 } });
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Moonshot request aborted.');
  });

  it('requires a request-owned valid finish before publishing tools or nested success', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Invalid Moonshot chat response.');
    }
    const { baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === first ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn(); await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: latest }); }, outerComplete);
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid Moonshot chat response.');
  });

  it('keeps typed overflow, safe usage and configured finite-classifier privacy distinct', async () => {
    const { baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 })); await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: { private: 'not-text' } }, finish_reason: 'stop' }] }))); await expect(provider.chat([input])).rejects.toThrow('Invalid Moonshot chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })));
    expect(await new SpecializedModels(provider).classify({ model: `${first}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, totalTokens: 12 } });
    provider.setConfiguredModel(latest); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${latest}:classifier`, contextWindow: 1048576, imageInput: true }]);
  });
});

describe('explicit native Moonshot CN construction', () => {
  it('publishes the shared immutable four profiles with adapter-owned metadata and no factory', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MoonshotCnProvider({ type: 'google', apiKey: 'disposable', baseUrl });
    expect(providers.MOONSHOT_CN_MODELS).toBe(MOONSHOT_MODELS);
    expect(Object.isFrozen(providers.MOONSHOT_CN_MODELS)).toBe(true);
    expect(providers.MOONSHOT_CN_MODELS.every(row => Object.isFrozen(row) && Object.isFrozen(row.pricing) && Object.isFrozen(row.declaredInput) && Object.isFrozen(row.declaredInputLimits?.images.resize))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false);
    expect(ProviderFactory.has('moonshotai-cn')).toBe(false);
    expect(getProviderPublishedModel('google', latest, provider)).toMatchObject({ api: 'openai-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 } });
    expect(getProviderPublishedModel('google', 'gemini-2.5-pro', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('google', second, undefined, provider)).toEqual(levels.slice(1, 5));
    expect(getSupportedThinkingLevels('google', latest, undefined, provider)).toEqual(['low', 'high', 'max']);
    provider.setConfiguredModel(latest); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${latest}:classifier`, model: latest, api: 'openai-completions', contextWindow: 1048576, imageInput: true }]);
    expect(calls).toEqual([]);
  });

  it('selects the CN default only by explicit construction and never reads ambient keys', async () => {
    const calls: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
    vi.stubEnv('MOONSHOT_API_KEY', 'ambient-private');
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers); calls.push({ url: String(url), authorization: headers.get('authorization'), apiKey: headers.get('x-api-key') });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }));
    });
    await new providers.MoonshotCnProvider({ type: 'operator', apiKey: 'disposable-cn' }).chat([input]);
    await new MoonshotProvider({ type: 'moonshotai-cn', apiKey: 'disposable-global' }).chat([input]);
    await new providers.MoonshotCnProvider({ type: 'operator', apiKey: 'disposable-custom', baseUrl: 'https://proxy.invalid/owned%2Fcn/v1/' }).chat([input]);
    expect(calls).toEqual([
      { url: 'https://api.moonshot.cn/v1/chat/completions', authorization: 'Bearer disposable-cn', apiKey: null },
      { url: 'https://api.moonshot.ai/v1/chat/completions', authorization: 'Bearer disposable-global', apiKey: null },
      { url: 'https://proxy.invalid/owned%2Fcn/v1/chat/completions', authorization: 'Bearer disposable-custom', apiKey: null },
    ]);
    const missing = new providers.MoonshotCnProvider({ type: 'operator' }); expect(missing.validateConfig()).toBe(false);
    await expect(missing.chat([input])).rejects.toThrow('Moonshot API key is required.'); expect(calls).toHaveLength(3);
    expect(() => new providers.MoonshotCnProvider({ type: 'operator', baseUrl: 'https://user:private@host' })).toThrow('Invalid Moonshot endpoint.');
  });

  it('inherits native K2/K3 JSON-SSE policy, exact caps and captured physical prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MoonshotCnProvider({ type: 'google', apiKey: 'disposable-cn', baseUrl });
    for (const profile of MOONSHOT_MODELS) {
      provider.setConfiguredModel(profile.id);
      const response = await provider.chat([input], { model: '', thinking: 'high', maxTokens: 64 });
      expect(response).toMatchObject({ provider: 'google', model: profile.id, api: 'openai-completions', content: 'Ready',
        usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12,
          costUsd: (6 * profile.pricing.inputPerMillion + 2 * profile.pricing.outputPerMillion + 4 * profile.pricing.cacheReadPerMillion) / 1e6 } });
      let final: unknown; const events: string[] = [];
      await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(latest); }, value => { final = value; }, error => { throw error; }, { model: '', thinking: 'off', maxTokens: 64 });
      expect(events).toEqual(['reasoning_delta', 'text_delta']);
      expect(final).toMatchObject({ provider: 'google', model: profile.id, api: 'openai-completions', content: 'Ready', usage: response.usage });
    }
    expect(calls).toHaveLength(8);
    for (const [index, call] of calls.entries()) {
      const profile = MOONSHOT_MODELS[Math.floor(index / 2)];
      expect(call.url).toBe('/owned%2Fmoonshot/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-cn'); expect(call.headers['x-api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ model: profile.id, max_tokens: 64 });
      for (const field of ['store', 'max_completion_tokens', 'tool_stream']) expect(call.body).not.toHaveProperty(field);
      if (profile.id === latest) { expect(call.body.reasoning_effort).toBe(index % 2 ? 'low' : 'high'); expect(call.body).not.toHaveProperty('thinking'); }
      else { expect(call.body.thinking).toEqual({ type: index % 2 && profile.id === first ? 'disabled' : 'enabled' }); expect(call.body).not.toHaveProperty('reasoning_effort'); }
    }
  });
});

describe('native Moonshot operation-owned model provenance', () => {
  it.each([{ name: 'global', Provider: MoonshotProvider }, { name: 'CN', Provider: providers.MoonshotCnProvider }])('$name captures the physical model before awaits despite remote aliases and configuration changes', async ({ Provider }) => {
    for (const stream of [false, true]) {
      const provider = new Provider({ type: 'google', apiKey: 'disposable', model: first });
      const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); expect(body.model).toBe(first); expect(body.max_tokens).toBe(64);
        await Promise.resolve(); provider.setConfiguredModel(latest);
        const choices = [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }];
        return stream ? new Response([
          { model: 'remote-alias', choices: [{ delta: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }] }, { choices: [], usage },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
          : new Response(JSON.stringify({ model: 'remote-alias', choices, usage }));
      });
      let response: unknown;
      if (stream) await provider.streamChat([input], async () => { await Promise.resolve(); }, value => { response = value; }, error => { throw error; }, { model: '', maxTokens: 64 });
      else response = await provider.chat([input], { model: '', maxTokens: 64 });
      expect(provider.getConfiguredModel()).toBe(latest);
      expect(response).toMatchObject({ provider: 'google', model: first, api: 'openai-completions', content: 'Ready',
        usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.95 + 2 * 4 + 4 * 0.16) / 1e6 } });
    }
  });
});
