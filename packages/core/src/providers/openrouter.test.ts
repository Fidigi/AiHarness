import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import * as providers from './index.js';
import { SpecializedModels, SPECIALIZED_MODEL_LIMITS } from './specialized-models.js';

const a = 'anthropic/claude-sonnet-4.6', overlap = 'google/gemini-3-pro-image', t = '~typesafe/jev-latest';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

describe('explicit mixed OpenRouter SDK', () => {
  it('composes bounded native catalogues without confusing overlapping operations or reserving a host', async () => {
    expect(providers).toHaveProperty('OpenRouterProvider');
    const provider = new providers.OpenRouterProvider({ type: 'operator-router', apiKey: 'disposable-mixed-key', model: overlap });
    expect(await provider.getAvailableModels()).toHaveLength(393);
    expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi(a)).toBe('anthropic-messages'); expect(provider.getModelApi(overlap)).toBe('openai-completions');
    expect(provider.getModelApi(t)).toBe('typesafe-system-one');
    expect(provider.getModelApi('black-forest-labs/flux-3-image')).toBe('openrouter-images');
    expect(provider.getModelApi('future/private')).toBeUndefined();
    const models = new SpecializedModels(provider);
    expect(models.getModelsOfType('image')).toHaveLength(61);
    expect(models.getModelsOfType('classifier')).toHaveLength(22);
    expect(models.getModelsOfType('image').find(profile => profile.id === overlap)?.api).toBe('openrouter-images');
    expect(models.getModelsOfType('classifier').find(profile => profile.id === `${overlap}:classifier`)).toMatchObject({ api: 'openai-completions', virtual: true });
    expect(JSON.stringify(provider.getSpecializedModels())).not.toContain('disposable-mixed-key');
    expect(SPECIALIZED_MODEL_LIMITS.models).toBe(100);
    expect(() => provider.setConfiguredModel(t)).toThrow('OpenRouter chat model is not supported.');
    expect(provider.getConfiguredModel()).toBe(overlap);
    provider.setConfiguredModel(a); expect(provider.getModelApi()).toBe('anthropic-messages');
    expect(providers.ProviderFactory.has('openrouter')).toBe(false);
  });

  it('routes A/C/I/T on one explicit service base using operation-owned authentication and cache semantics', async () => {
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
    const server = createServer(async (incoming, response) => {
      let text = ''; for await (const chunk of incoming) text += chunk;
      const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
      response.setHeader('content-type', 'application/json');
      if (incoming.url?.endsWith('/messages')) response.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'A ready' }],
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 1 } } }));
      else if (incoming.url?.endsWith('/systemone')) response.end(JSON.stringify({ answers: { approved: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 2 } }));
      else response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: body.modalities ? 'Caption' : 'C ready',
        ...(body.modalities ? { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } : {}) }, ...(body.modalities ? {} : { finish_reason: 'stop' }) }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = new providers.OpenRouterProvider({ type: 'azure', apiKey: 'disposable-mixed-key', model: overlap,
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fprefix/api/v1` });
    const messages = [{ id: 'user-1', role: 'user' as const, content: 'Hello', timestamp: new Date(1) }];
    const nativeA = await provider.chat(messages, { model: a, thinking: 'high', maxTokens: 64 });
    expect(nativeA).toMatchObject({ provider: 'azure', api: 'anthropic-messages', content: 'A ready', usage: { promptTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, costUsd: 0.0000522 } });
    const nativeC = await provider.chat(messages, { model: overlap });
    expect(nativeC).toMatchObject({ provider: 'azure', api: 'openai-completions', content: 'C ready', usage: { promptTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 } });
    const models = new SpecializedModels(provider);
    expect((await models.classifyQuestions({ model: t, state: {}, questions: { approved: { type: 'boolean', prompt: 'Approved?' } } })).answers.approved.value).toBe(true);
    const image = await models.generateImages({ model: overlap, prompt: 'Generate' });
    expect(image.images).toEqual([{ mediaType: 'image/png', data: png }]);
    expect(image.usage).toMatchObject({ inputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 1 });
    expect(calls).toHaveLength(4);
    expect(calls.map(call => call.url)).toEqual(['/proxy%2Fprefix/api/v1/messages', '/proxy%2Fprefix/api/v1/chat/completions',
      '/proxy%2Fprefix/api/v1/systemone', '/proxy%2Fprefix/api/v1/chat/completions']);
    expect(calls[0].headers['x-api-key']).toBe('disposable-mixed-key'); expect(calls[0].headers.authorization).toBeUndefined();
    for (const call of calls.slice(1)) { expect(call.headers.authorization).toBe('Bearer disposable-mixed-key'); expect(call.headers['x-api-key']).toBeUndefined(); }
    expect(calls[0].body.thinking.type).toBe('adaptive'); expect(calls[1].body).not.toHaveProperty('modalities');
    expect(calls[2].body.questions.approved.type).toBe('noul'); expect(calls[3].body.modalities).toContain('image');
    await expect(provider.chat([], { model: t })).rejects.toThrow('OpenRouter chat model is not supported.');
    expect(calls).toHaveLength(4);
  });

  it('captures the native stream operation when the configured chat API changes during an awaited callback', async () => {
    const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders }> = [];
    const server = createServer(async (incoming, response) => {
      let text = ''; for await (const chunk of incoming) text += chunk;
      const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers });
      response.setHeader('content-type', 'text/event-stream');
      if (incoming.url?.endsWith('/messages')) {
        const events = [{ type: 'message_start', message: { model: body.model, usage: { input_tokens: 5, output_tokens: 2,
          cache_read_input_tokens: 4, cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 1 } } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A stream' } }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      } else response.end(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'C stream' } }] })}\n\ndata: ${JSON.stringify({ model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } })}\n\ndata: [DONE]\n\n`);
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = new providers.OpenRouterProvider({ type: 'operator-router', model: a, apiKey: 'disposable-stream-key',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1` });
    const completions: providers.ChatResponse[] = [], messages = [{ id: 'user-1', role: 'user' as const, content: 'Hello', timestamp: new Date(1) }];
    await provider.streamChat(messages, async text => { if (text) provider.setConfiguredModel(overlap); await Promise.resolve(); },
      value => { if (value) completions.push(value); }, error => { throw error; }, { maxTokens: 64 });
    expect(provider.getModelApi()).toBe('openai-completions');
    expect(completions[0]).toMatchObject({ provider: 'operator-router', model: a, api: 'anthropic-messages', content: 'A stream', usage: { costUsd: 0.0000522 } });
    await provider.streamChat(messages, async () => { await Promise.resolve(); }, value => { if (value) completions.push(value); }, error => { throw error; });
    expect(completions[1]).toMatchObject({ provider: 'operator-router', model: overlap, api: 'openai-completions', content: 'C stream', usage: { promptTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 } });
    expect(calls.map(call => call.url)).toEqual(['/api/v1/messages', '/api/v1/chat/completions']);
    expect(calls[0].headers['x-api-key']).toBe('disposable-stream-key'); expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[1].headers.authorization).toBe('Bearer disposable-stream-key'); expect(calls[1].headers['x-api-key']).toBeUndefined();
  });
});
