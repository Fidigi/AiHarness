import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import * as providers from './index.js';
import { SpecializedModelError, SpecializedModels, SPECIALIZED_MODEL_LIMITS } from './specialized-models.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const chat = '@cf/deepseek-ai/deepseek-v4-flash-0731', vision = '@cf/google/gemma-4-26b-a4b-it', native = '@cf/cloudflare/clef';
const message = { id: 'user-1', role: 'user' as const, content: 'Approved', timestamp: new Date(1) };
const questions = { approved: { type: 'boolean' as const, prompt: 'Approved?' } };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const state = { malformed: false };
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
    response.setHeader('content-type', 'application/json');
    if (incoming.url?.endsWith('/run')) {
      const answers = Object.fromEntries(Object.entries(body.input.questions).map(([id, question]) => [id,
        (question as { type: string }).type === 'noul' ? { type: 'noul', noul: 0.8 }
          : { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.8, review: 0.2 } }]));
      response.end(JSON.stringify({ success: true, result: { state: 'Completed', result: { answers: state.malformed ? {} : answers, usage: { input_tokens: 10, output_tokens: 2 } } } }));
    } else {
      const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream');
        response.end(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { reasoning_content: 'Thought' } }] })}\n\ndata: ${JSON.stringify({ model: body.model,
          choices: [{ index: 0, delta: { content: 'Ready' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
      } else {
        const system = body.messages[0]?.content ?? '';
        const content = system.includes('Classify the user input') ? JSON.stringify({ label: 'safe' })
          : system.includes('Answer these finite-domain questions') ? JSON.stringify({ answers: { approved: { value: true, probabilities: [{ value: false, probability: 0.2 }, { value: true, probability: 0.8 }] } } }) : 'Ready';
        response.end(JSON.stringify({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage }));
      }
    }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, state, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe('explicit mixed Cloudflare Workers AI SDK', () => {
  it('composes eighteen C chats and three native S classifiers without changing the classifier-only SDK or factory authority', async () => {
    const provider = new providers.CloudflareWorkersAiMixedProvider({ type: 'operator-cloudflare', apiKey: 'disposable-mixed-cloudflare', accountId: 'explicit' });
    expect(provider.getConfiguredModel()).toBe(chat); expect(await provider.getAvailableModels()).toHaveLength(18); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi(chat)).toBe('openai-completions'); expect(provider.getModelApi(native)).toBe('cloudflare-workers-ai-system-one'); expect(provider.getModelApi('future')).toBeUndefined();
    const models = new SpecializedModels(provider);
    expect(models.getModelsOfType('classifier')).toHaveLength(4); expect(models.getModelsOfType('image')).toEqual([]); expect(SPECIALIZED_MODEL_LIMITS.models).toBe(100);
    expect(models.getModelsOfType('classifier').find(model => model.id === `${chat}:classifier`)).toMatchObject({ virtual: true, api: 'openai-completions', pricing: { inputPerMillion: 0.44 } });
    expect(models.getModelsOfType('classifier').find(model => model.id === native)).toMatchObject({ api: 'cloudflare-workers-ai-system-one', pricing: { inputPerMillion: 0.24 } });
    expect(() => provider.setConfiguredModel(native)).toThrow('Cloudflare chat model is not supported.'); expect(provider.getConfiguredModel()).toBe(chat);
    provider.setConfiguredModel(vision); expect(provider.getSpecializedModels().find(model => model.virtual)).toMatchObject({ model: vision, imageInput: true });
    expect(new providers.CloudflareWorkersAiProvider({ type: 'legacy-s', accountId: 'explicit' }).getConfiguredModel()).toBeUndefined();
    expect(providers.ProviderFactory.has('cloudflare-workers-ai')).toBe(false); expect(JSON.stringify(provider.getSpecializedModels())).not.toContain('disposable-mixed-cloudflare');
  });

  it('executes native S and virtual C labels/questions in one guest while preserving physical prices and failed-S billing', async () => {
    const { baseUrl, calls, state } = await fixture();
    const provider = new providers.CloudflareWorkersAiMixedProvider({ type: 'azure', apiKey: 'disposable-mixed-cloudflare', baseUrl: baseUrl + '/proxy%2Fowned/ai' });
    expect(await provider.chat([message])).toMatchObject({ content: 'Ready', provider: 'azure', api: 'openai-completions', usage: { promptTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 } });
    const models = new SpecializedModels(provider);
    for (const model of [native, `${chat}:classifier`]) {
      expect((await models.classify({ model, input: 'Approved', labels: ['safe', 'review'] })).label).toBe('safe');
      expect((await models.classifyQuestions({ model, state: {}, questions })).answers.approved.value).toBe(true);
    }
    const result = await runCodemode({ code: `await models.classifyQuestions(${JSON.stringify({ model: native, state: {}, questions })}); await models.classifyQuestions(${JSON.stringify({ model: `${chat}:classifier`, state: {}, questions })}); store('mixed',true); return 'Ready';`,
      context: { provider } as unknown as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(result.isError).not.toBe(true); expect(result.details).toMatchObject({ store: { mixed: true }, usage: { totalTokens: 24 }, costComplete: true, nestedCalls: [{ state: 'completed', usage: { totalTokens: 12 } }, { state: 'completed', usage: { totalTokens: 12 } }] });
    expect(calls).toHaveLength(7); expect(calls.map(call => call.url)).toEqual(['/proxy%2Fowned/ai/v1/chat/completions', '/proxy%2Fowned/ai/run', '/proxy%2Fowned/ai/run',
      '/proxy%2Fowned/ai/v1/chat/completions', '/proxy%2Fowned/ai/v1/chat/completions', '/proxy%2Fowned/ai/run', '/proxy%2Fowned/ai/v1/chat/completions']);
    for (const call of calls) { expect(call.headers.authorization).toBe('Bearer disposable-mixed-cloudflare'); expect(call.headers['api-key']).toBeUndefined(); expect(call.headers['x-api-key']).toBeUndefined(); }
    expect(calls[1].body).toMatchObject({ model: native, input: { state: { input: 'Approved' }, questions: { label: { type: 'choice' } } } });
    state.malformed = true;
    const error = await models.classifyQuestions({ model: native, state: {}, questions }).catch(error => error);
    expect(error).toBeInstanceOf(SpecializedModelError); expect(error.usage).toMatchObject({ totalTokens: 12, costUsd: 0.0000024 });
    const failed = await runCodemode({ code: `store('bad',true); await models.classifyQuestions(${JSON.stringify({ model: native, state: {}, questions })});`,
      context: { provider } as unknown as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(failed.isError).toBe(true); expect(failed.details?.store).toBeUndefined(); expect(failed.details).toMatchObject({ usage: { totalTokens: 12, costUsd: 0.0000024 }, nestedCalls: [{ state: 'failed' }] });
    await expect(provider.chat([], { model: native })).rejects.toThrow('Cloudflare chat model is not supported.');
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.'); expect(calls).toHaveLength(9);
  });

  it('normalizes operation-specific endpoints and captures a C stream while an awaited callback dispatches S and changes configuration', async () => {
    const { baseUrl, calls } = await fixture();
    for (const suffix of ['/ai', '/ai/v1/', '/ai/v1/chat/completions/', '/ai/run/']) {
      const provider = new providers.CloudflareWorkersAiMixedProvider({ type: 'operator-cloudflare', apiKey: 'disposable', baseUrl: baseUrl + suffix });
      await provider.chat([message]); await new SpecializedModels(provider).classifyQuestions({ model: native, state: {}, questions });
      expect(calls.at(-2)?.url).toBe('/ai/v1/chat/completions'); expect(calls.at(-1)?.url).toBe('/ai/run');
    }
    const provider = new providers.CloudflareWorkersAiMixedProvider({ type: 'operator-cloudflare', apiKey: 'disposable', baseUrl: baseUrl + '/proxy%2Fowned/ai' });
    const completions: providers.ChatResponse[] = [], seen: string[] = [];
    await provider.streamChat([message], async (chunk, event) => {
      seen.push(event?.type ?? chunk);
      if (event?.type === 'reasoning_delta') { await new SpecializedModels(provider).classifyQuestions({ model: native, state: {}, questions }); provider.setConfiguredModel(vision); }
    }, result => { if (result) completions.push(result); }, error => { throw error; });
    expect(seen).toEqual(['reasoning_delta', 'text_delta']); expect(provider.getConfiguredModel()).toBe(vision);
    expect(completions).toHaveLength(1); expect(completions[0]).toMatchObject({ model: chat, provider: 'operator-cloudflare', api: 'openai-completions', content: 'Ready', reasoning: 'Thought', usage: { promptTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1 } });
    expect(calls.at(-2)?.body.model).toBe(chat); expect(calls.at(-1)?.body.model).toBe(native);
  });
});
