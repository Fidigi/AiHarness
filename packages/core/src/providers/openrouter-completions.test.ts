import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';

const model = '~anthropic/claude-fable-latest';
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply?: (body: Record<string, unknown>, response: import('node:http').ServerResponse) => void) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
    if (reply) { reply(body, response); return; }
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      for (const value of [{ choices: [{ delta: { reasoning: 'Plan' } }] }, { choices: [{ delta: { content: 'Ready' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read', arguments: '{"path":"README.md"}' } }] } }] },
        { choices: [], usage }]) response.write(`data: ${JSON.stringify(value)}\n\n`);
      response.end('data: [DONE]\n\n');
    } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Ready', reasoning: 'Plan' } }], usage })); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fprefix/api/v1/chat/completions` };
}

describe('native OpenRouter Chat Completions', () => {
  it('owns 377 C projections without inheriting A/I/T or ambiguous zero prices', async () => {
    expect(providers).toHaveProperty('OpenRouterCompletionsProvider');
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator-router', apiKey: 'disposable-router' });
    expect(providers.OPENROUTER_COMPLETION_MODELS).toHaveLength(377);
    expect(Object.isFrozen(providers.OPENROUTER_COMPLETION_MODELS)).toBe(true);
    expect(providers.OPENROUTER_COMPLETION_MODELS.filter(profile => profile.pricing === undefined)).toHaveLength(21);
    expect(await provider.getAvailableModels()).toHaveLength(377); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi()).toBe('openai-completions');
    expect(provider.getSpecializedModels().filter(profile => profile.type === 'image')).toEqual([]);
    expect(provider.getSpecializedModels()[0]).toMatchObject({ api: 'openai-completions', virtual: true });
    expect(JSON.stringify(provider.getSpecializedModels())).not.toContain('disposable-router');
    await expect(provider.chat([], { model: 'anthropic/claude-fable-5' })).rejects.toThrow('OpenRouter chat model is not supported.');
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'No fallback' })).rejects.toThrow('Image model or options are not supported.');
    expect(new providers.OpenRouterImagesProvider({ type: 'operator-router', apiKey: 'disposable' }).getModelApi()).toBe('openrouter-images');
  });

  it('uses actual Bearer C requests, nested effort, cache accounting and awaited reasoning/tools independently of operator names', async () => {
    expect(providers).toHaveProperty('OpenRouterCompletionsProvider');
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'azure', apiKey: 'disposable-router', baseUrl, model });
    const messages = [{ id: 'user-1', role: 'user' as const, content: 'Read the file', timestamp: new Date() }];
    const result = await provider.chat(messages, { thinking: 'max', sessionId: 'session-1' });
    expect(result).toMatchObject({ api: 'openai-completions', content: 'Ready', reasoning: 'Plan', usage: {
      promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
    } });
    const events: unknown[] = []; const complete = vi.fn();
    await provider.streamChat(messages, async (text, event) => { await Promise.resolve(); events.push({ text, type: event?.type }); }, complete,
      error => { throw error; }, { thinking: 'max', sessionId: 'session-1' });
    expect(events).toEqual([{ text: '', type: 'reasoning_delta' }, { text: 'Ready', type: 'text_delta' }, { text: '', type: 'tool_call' }]);
    expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject({ api: 'openai-completions', content: 'Ready', reasoning: 'Plan',
      toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'README.md' } }] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('/proxy%2Fprefix/api/v1/chat/completions');
      expect(call.headers.authorization).toBe('Bearer disposable-router'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ model, reasoning: { effort: 'max' } }); expect(call.body).not.toHaveProperty('reasoning_effort');
    }
    expect(calls[1].body.stream_options).toEqual({ include_usage: true });
    expect(provider.getProviderType()).toBe('azure'); expect(messages[0].content).toBe('Read the file');
    expect(calls.every(call => call.headers['x-session-id'] === 'session-1')).toBe(true);
  });

  it('executes every C identity with independent per-profile arithmetic and owned descriptors', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'local', apiKey: 'disposable-router', baseUrl });
    for (const profile of providers.OPENROUTER_COMPLETION_MODELS) {
      const history = profile.compat?.requiresReasoningContentOnAssistantMessages ? [{ id: 'previous', role: 'assistant' as const,
        content: 'Earlier', blocks: [{ type: 'reasoning' as const, text: 'Owned planning' }], timestamp: new Date() }] : [];
      const result = await provider.chat(history, { model: profile.id });
      if (history.length) expect(calls.at(-1)?.body.messages).toMatchObject([{ role: 'assistant', reasoning_content: 'Owned planning' }]);
      const rates = profile.pricing;
      expect(result.usage?.costUsd).toBe(rates ? (5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1_000_000 : undefined);
      expect(result.api).toBe(profile.api); expect(calls.at(-1)?.body.model).toBe(profile.id);
      expect(Object.isFrozen(profile.declaredInput)).toBe(true); expect(Object.isFrozen(profile.declaredPricing)).toBe(true);
      for (const tier of profile.declaredPricing.tiers ?? []) expect(Object.isFrozen(tier)).toBe(true);
    }
    expect(calls).toHaveLength(377);
    const before = provider.getConfiguredModel(); expect(() => provider.setConfiguredModel('future/unknown')).toThrow('OpenRouter chat model is not supported.');
    expect(provider.getConfiguredModel()).toBe(before);
  });

  it('uses strict tier thresholds and omits invalid or incomplete primary accounting', async () => {
    const profile = providers.OPENROUTER_COMPLETION_MODELS.find(profile => profile.pricing && profile.declaredPricing.tiers?.length === 1)!;
    const tier = profile.declaredPricing.tiers![0]; let input = tier.inputTokensAbove;
    let usage: unknown;
    const { baseUrl } = await fixture((body, response) => response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Ready' } }],
      usage: usage ?? { prompt_tokens: input, completion_tokens: 2 } })));
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator-router', apiKey: 'disposable', baseUrl, model: profile.id });
    expect((await provider.chat([])).usage?.costUsd).toBe((input * profile.pricing!.inputPerMillion + 2 * profile.pricing!.outputPerMillion) / 1_000_000);
    input += 1;
    expect((await provider.chat([])).usage?.costUsd).toBe((input * tier.inputPerMillion + 2 * tier.outputPerMillion) / 1_000_000);
    for (const invalid of [{ prompt_tokens: 7 }, { completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 },
      { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } },
      { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 } }]) {
      usage = invalid; expect((await provider.chat([])).usage).toBeUndefined();
    }
    for (const alternate of ['prompt_cache_hit_tokens', 'cached_tokens']) {
      usage = { prompt_tokens: 10, completion_tokens: 2, [alternate]: 4 };
      expect((await provider.chat([])).usage).toMatchObject({ promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12 });
    }
  });

  it('refuses private endpoint/header values before I/O and remote refusals without leaking bodies or inventing replay', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const baseUrl of ['https://user:PRIVATE@example.invalid', 'https://example.invalid/v1?PRIVATE=1', 'https://example.invalid/#PRIVATE']) {
      expect(() => new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey: 'disposable', baseUrl })).toThrow('Invalid OpenRouter completions endpoint.');
    }
    for (const apiKey of ['', 'PRIVATE\u0000value', 'PRIVATE😀']) {
      await expect(new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey }).chat([])).rejects.toThrow('OpenRouter API key is required.');
    }
    await expect(new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey: 'disposable', customHeaders: { 'x-private': 'PRIVATE\u0000value' } }).chat([]))
      .rejects.toThrow('Invalid OpenRouter request headers.');
    expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
    for (const message of [{ content: 'PRIVATE', refusal: 'PRIVATE' }, { content: 'PRIVATE', reasoning_details: [{ type: 'reasoning.encrypted', data: 'PRIVATE' }] }]) {
      const { baseUrl } = await fixture((_body, response) => response.end(JSON.stringify({ choices: [{ message }] })));
      const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
      await expect(provider.chat([])).rejects.toThrow(message.refusal ? 'Invalid OpenRouter chat response.' : 'Unsupported OpenRouter reasoning replay.');
    }
  });

  it('withdraws buffered callbacks, tools and completion after awaited cancellation', async () => {
    const { baseUrl } = await fixture(); const controller = new AbortController();
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator-router', apiKey: 'disposable', baseUrl });
    const events: string[] = []; const complete = vi.fn(); const error = vi.fn();
    await provider.streamChat([], async (_text, event) => { events.push(event!.type); await Promise.resolve(); controller.abort(); }, complete, error,
      { signal: controller.signal });
    expect(events).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0].message).toBe('OpenRouter request aborted.');
  });
});
