import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';

const model = 'anthropic/claude-sonnet-4.6';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply?: (body: Record<string, unknown>, response: import('node:http').ServerResponse) => void) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
    if (reply) { reply(body, response); return; }
    const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
    response.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (body.stream) {
      const events = [
        { type: 'message_start', message: { id: 'message-1', model: body.model, usage: { ...usage, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ready' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'read', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } else response.end(JSON.stringify({ model: body.model, content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Ready' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fprefix/api/v1/messages` };
}

describe('native OpenRouter Anthropic Messages', () => {
  it('owns sixteen A profiles without inheriting C/I/T or ambient account authority', async () => {
    expect(providers).toHaveProperty('OpenRouterMessagesProvider');
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', apiKey: 'disposable-router', model });
    expect(providers.OPENROUTER_MESSAGE_MODELS).toHaveLength(16);
    expect(Object.isFrozen(providers.OPENROUTER_MESSAGE_MODELS)).toBe(true);
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS) {
      expect(profile.api).toBe('anthropic-messages'); expect(profile.reasoning).toBe(true);
      expect(profile.declaredInput).toEqual(['text', 'image']); expect(profile.pricing).toBeDefined();
      expect(Object.isFrozen(profile)).toBe(true); expect(Object.isFrozen(profile.declaredInput)).toBe(true);
      expect(Object.isFrozen(profile.declaredPricing)).toBe(true);
    }
    expect(await provider.getAvailableModels()).toEqual(providers.OPENROUTER_MESSAGE_MODELS.map(profile => profile.id));
    expect(provider.canDiscoverModels()).toBe(false); expect(provider.getModelApi()).toBe('anthropic-messages');
    expect(provider.getSpecializedModels()).toMatchObject([{ type: 'classifier', virtual: true, api: 'anthropic-messages', model }]);
    expect(JSON.stringify(provider.getSpecializedModels())).not.toContain('disposable-router');
    await expect(provider.chat([], { model: 'openai/gpt-4o' })).rejects.toThrow('OpenRouter message model is not supported.');
    expect(() => provider.setConfiguredModel('future/unknown')).toThrow('OpenRouter message model is not supported.');
    expect(provider.getConfiguredModel()).toBe(model);
  });

  it('uses actual x-api-key A requests and adaptive effort independently of operator names', async () => {
    expect(providers).toHaveProperty('OpenRouterMessagesProvider');
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterMessagesProvider({ type: 'azure', apiKey: 'disposable-router', model, baseUrl });
    const messages = [{ id: 'user-1', role: 'user' as const, content: 'Read the file', timestamp: new Date() }];
    const options = { thinking: 'max' as const, maxTokens: 64, sessionId: 'session-1', temperature: 0.25,
      thinkingBudgets: { high: Number.MAX_SAFE_INTEGER }, systemPrompt: 'System probe',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }] };
    const usage = { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
      costUsd: (5 * 3 + 2 * 15 + 4 * 0.3 + 3.75) / 1_000_000 };
    expect(await provider.chat(messages, options)).toMatchObject({ api: 'anthropic-messages', content: 'Ready', reasoning: 'Plan', usage });
    const events: unknown[] = []; const complete = vi.fn();
    await provider.streamChat(messages, async (text, event) => { await Promise.resolve(); events.push({ text, type: event?.type }); }, complete,
      error => { throw error; }, options);
    expect(events.filter(event => (event as { type?: string }).type !== 'message_start')).toEqual([
      { text: '', type: 'reasoning_delta' }, { text: 'Ready', type: 'text_delta' }, { text: '', type: 'tool_call' },
    ]);
    expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject({ api: 'anthropic-messages', content: 'Ready', reasoning: 'Plan', usage,
      toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'README.md' } }] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('/proxy%2Fprefix/api/v1/messages');
      expect(call.headers['x-api-key']).toBe('disposable-router'); expect(call.headers.authorization).toBeUndefined();
      expect(call.headers['anthropic-version']).toBe('2023-06-01'); expect(call.headers['x-session-id']).toBe('session-1');
      expect(call.body).toMatchObject({ model, max_tokens: 64, thinking: { type: 'adaptive' }, output_config: { effort: 'max' }, system: [{ type: 'text', text: 'System probe', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] });
      expect(call.body).not.toHaveProperty('temperature'); expect(call.body).not.toHaveProperty('reasoning');
      expect(call.body).not.toHaveProperty('reasoning_effort');
    }
    for (const cacheRetention of ['none', 'short', 'long'] as const) {
      await provider.chat(messages, { ...options, cacheRetention }); const call = calls.at(-1)!;
      const control = cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(cacheRetention === 'long' ? { ttl: '1h' } : {}) };
      expect(call.body.system).toEqual([{ type: 'text', text: 'System probe', ...(control ? { cache_control: control } : {}) }]);
      expect((call.body.tools as Record<string, unknown>[])[0].cache_control).toEqual(control);
      expect(call.headers['x-session-id']).toBe(cacheRetention === 'none' ? undefined : 'session-1');
    }
    expect(provider.getProviderType()).toBe('azure'); expect(messages[0].content).toBe('Read the file');
  });

  it('executes every A identity with its own effort, pricing and declared compatibility', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterMessagesProvider({ type: 'local', apiKey: 'disposable', model, baseUrl });
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
    const messages = [{ id: 'image-1', role: 'user' as const, content: 'See image', timestamp: new Date(),
      blocks: [{ type: 'image' as const, mediaType: 'image/png', url: `data:image/png;base64,${data}` }] }];
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS) {
      const result = await provider.chat(messages, { model: profile.id, thinking: 'high', maxTokens: profile.maxOutputTokens, temperature: 0.25,
        systemPrompt: 'Profile system', tools: [{ name: 'first', description: 'First', parameters: { type: 'object' } },
          { name: 'read', description: 'Read', parameters: { type: 'object' } }] });
      expect(result.api).toBe('anthropic-messages');
      const rates = profile.pricing;
      expect(result.usage?.costUsd).toBe((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1_000_000);
      const call = calls.at(-1)!;
      expect(call.body).toMatchObject({ model: profile.id, max_tokens: profile.maxOutputTokens,
        thinking: { type: profile.compat?.forceAdaptiveThinking ? 'adaptive' : 'enabled' } });
      expect(call.body).not.toHaveProperty('temperature');
      expect(call.body.system).toEqual([{ type: 'text', text: 'Profile system', cache_control: { type: 'ephemeral' } }]);
      const tools = call.body.tools as Record<string, unknown>[];
      expect(tools[0].cache_control).toBeUndefined(); expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
      expect((call.body.messages as unknown[])[0]).toMatchObject({ role: 'user', content: [
        { type: 'text', text: 'See image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ] });
      if (profile.compat?.supportsMidConvoEffort) {
        expect(call.headers['anthropic-beta']).toBe('mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01');
        expect((call.body.messages as unknown[]).at(-1)).toEqual({ role: 'system', content: [], output_config: { effort: 'high' } });
        expect(call.body.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: 'drop_block' } });
      }
      for (const tier of profile.declaredPricing.tiers ?? []) expect(Object.isFrozen(tier)).toBe(true);
      if (profile.compat) expect(Object.isFrozen(profile.compat)).toBe(true);
      if (profile.declaredInputLimits) expect(Object.isFrozen(profile.declaredInputLimits.images.resize)).toBe(true);
      provider.setConfiguredModel(profile.id);
      const descriptor = provider.getSpecializedModels()[0]!;
      expect(descriptor).toMatchObject({ model: profile.id, api: profile.api, contextWindow: profile.contextWindow, imageInput: true });
      expect(descriptor.pricing).not.toBe(profile.pricing);
    }
    expect(calls).toHaveLength(16);
  });

  it('uses gross-input tiers, observed initial/delta/1h accounting and conservative partials', async () => {
    let usage: unknown, deltaUsage: unknown;
    const { baseUrl } = await fixture((body, response) => {
      if (!body.stream) { response.end(JSON.stringify({ model: body.model, content: [{ type: 'text', text: 'Ready' }], usage })); return; }
      response.setHeader('content-type', 'text/event-stream');
      const events = [{ type: 'message_start', message: { model: body.model, usage } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready' } },
        ...(deltaUsage === undefined ? [] : [{ type: 'message_delta', usage: deltaUsage }]), { type: 'message_stop' }];
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', apiKey: 'disposable', model, baseUrl });
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS.filter(profile => profile.declaredPricing.tiers?.length)) {
      const tier = profile.declaredPricing.tiers![0]!;
      for (const above of [false, true]) {
        const input = tier.inputTokensAbove - 5 + Number(above), rates = above ? tier : profile.pricing;
        usage = { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
        expect((await provider.chat([], { model: profile.id })).usage?.costUsd).toBe((input * rates.inputPerMillion + 2 * rates.outputPerMillion
          + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1_000_000);
      }
    }
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: null }, { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0.5 },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 }]) {
      usage = invalid; expect((await provider.chat([])).usage).toBeUndefined();
    }
    usage = { input_tokens: 0, output_tokens: 0 };
    expect((await provider.chat([])).usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
    usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_1h_input_tokens: 1 } };
    const streamUsage = async () => {
      let result: providers.ChatResponse | undefined;
      await provider.streamChat([], () => undefined, value => { result = value; }, error => { throw error; }, { cacheRetention: 'long' });
      return result?.usage;
    };
    const observed = [(await provider.chat([], { cacheRetention: 'long' })).usage, await streamUsage()];
    deltaUsage = { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 6, cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_1h_input_tokens: 1 } };
    observed.push(await streamUsage());
    deltaUsage = { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null,
      cache_creation: { ephemeral_1h_input_tokens: null } };
    observed.push(await streamUsage());
    const initial = { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
      costUsd: (5 * 3 + 2 * 15 + 4 * 0.3 + 3 * 2) / 1_000_000 };
    expect(observed).toEqual([initial, initial,
      { promptTokens: 7, completionTokens: 3, cacheReadTokens: 6, cacheWriteTokens: 2, totalTokens: 18,
        costUsd: (7 * 3 + 3 * 15 + 6 * 0.3 + 3.75 + 3 * 2) / 1_000_000 }, initial]);
    for (const long of [-1, 0.5, 2, null]) {
      usage = { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: long } };
      expect((await provider.chat([])).usage).toBeUndefined();
    }
  });

  it('keeps endpoint/header/decoded JSON errors private and ignores unused adaptive numeric maps', async () => {
    let reply: unknown;
    const { calls, baseUrl } = await fixture((body, response) => response.end(JSON.stringify(reply ?? {
      model: body.model, content: [{ type: 'text', text: 'Ready' }], usage: { input_tokens: 5, output_tokens: 2 },
    })));
    for (const endpoint of ['https://private:secret@example.test/api', 'https://example.test/api?private=secret', 'https://example.test/api#private-secret', 'file:///private/secret']) {
      expect(() => new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl: endpoint }))
        .toThrow('Invalid OpenRouter messages endpoint.');
    }
    for (const apiKey of ['', 'disposable\u0000private', 'disposable\ud83d']) {
      const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey, baseUrl });
      await expect(provider.chat([])).rejects.toThrow('OpenRouter API key is required.');
    }
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl,
      customHeaders: { 'x-private': 'disposable\u0000private' } });
    await expect(provider.chat([])).rejects.toThrow('Invalid OpenRouter request headers.');
    expect(calls).toHaveLength(0);
    const getter = vi.fn(() => 1000), budgets = Object.defineProperty({}, 'high', { get: getter });
    const adaptive = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl });
    await adaptive.chat([], { thinking: 'high', maxTokens: 64, thinkingBudgets: budgets });
    expect(getter).not.toHaveBeenCalled(); expect(calls).toHaveLength(1);
    await expect(adaptive.chat([], { maxTokens: 0 })).rejects.toThrow('Invalid OpenRouter output limit.');
    expect(calls).toHaveLength(1);
    for (const invalid of [
      { model, error: { message: 'DISPOSABLE-PRIVATE' }, content: [{ type: 'text', text: 'DISPOSABLE-PRIVATE' }] },
      { model: 'DISPOSABLE\u0000PRIVATE', content: [{ type: 'text', text: 'Ready' }] },
      { model, content: [{ type: 'text', text: { private: 'DISPOSABLE-PRIVATE' } }] },
      { model, content: [{ type: 'thinking', thinking: { private: 'DISPOSABLE-PRIVATE' } }] },
      { model, content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: null }] },
    ]) {
      reply = invalid; await expect(adaptive.chat([])).rejects.toThrow('Invalid OpenRouter message response.');
    }
    reply = { model, content: [{ type: 'text', text: 'One' }, { type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Two' }] };
    expect(await adaptive.chat([])).toMatchObject({ content: 'OneTwo', reasoning: 'Plan' });
  });

  it('withdraws later buffered text, tools and completion after an awaited reasoning callback', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl });
    const controller = new AbortController(), events: string[] = [], complete = vi.fn(), failure = vi.fn();
    await provider.streamChat([], async (_text, event) => {
      events.push(event?.type ?? 'text');
      if (event?.type === 'reasoning_delta') { await Promise.resolve(); controller.abort(); }
    }, complete, failure, { thinking: 'high', maxTokens: 64, signal: controller.signal });
    expect(calls).toHaveLength(1); expect(events).toEqual(['message_start', 'reasoning_delta']);
    expect(complete).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][0].message).toBe('OpenRouter request aborted.');
  });
});
