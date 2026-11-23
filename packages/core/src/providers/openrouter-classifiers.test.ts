import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClassifiersProvider, OPENROUTER_CLASSIFIER_MODELS, TypesafeProvider, OpenAiDecisionsProvider } from './index.js';
import { SpecializedModelError, SpecializedModels } from './specialized-models.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const model = '~typesafe/jev-latest';
const request = { model, state: { approved: true }, questions: {
  approved: { type: 'bool' as const, instructions: 'Approved?', criteria: { true: 'Approved', false: 'Review' } },
  severity: { type: 'score' as const, instructions: 'Severity?', criteria: ['Low', 'High'] },
} };
const output = () => ({ answers: { approved: { type: 'noul', noul: 0.5 }, severity: { type: 'score', score: 1.25, confidence: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 } });
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply: (response: import('node:http').ServerResponse) => void = response => response.end(JSON.stringify(output()))) {
  const calls: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    calls.push({ url: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json'); reply(response);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy/api/v1`;
  const provider = new OpenRouterClassifiersProvider({ type: 'operator-router', apiKey: 'disposable-router', baseUrl });
  return { provider, calls, baseUrl };
}

describe('native OpenRouter System One classifiers', () => {
  it('publishes twenty-one owned profiles without claiming ambiguous zero prices or image transport', async () => {
    const { provider, calls } = await fixture();
    expect(OPENROUTER_CLASSIFIER_MODELS).toHaveLength(21); expect(Object.isFrozen(OPENROUTER_CLASSIFIER_MODELS)).toBe(true);
    expect(OPENROUTER_CLASSIFIER_MODELS.filter(profile => profile.declaredInput.includes('image'))).toHaveLength(6);
    expect(OPENROUTER_CLASSIFIER_MODELS.filter(profile => profile.pricing === undefined)).toHaveLength(3);
    const profiles = new SpecializedModels(provider).getModelsOfType('classifier');
    expect(profiles).toHaveLength(21); expect(profiles.every(profile => profile.imageInput !== true)).toBe(true);
    expect(profiles.find(profile => profile.model === model)).toMatchObject({ name: 'TypeSafe: Jev Latest', api: 'typesafe-system-one',
      contextWindow: 64000, pricing: { inputPerMillion: 0.042 } });
    profiles[0].pricing!.inputPerMillion = 999;
    expect(provider.getSpecializedModels()[0].pricing?.inputPerMillion).toBe(0.02);
    expect(provider.getModelApi('openai/gpt-6-luna-decisions')).toBe('typesafe-system-one');
    expect(provider.getConfiguredModel()).toBeUndefined(); expect(provider.canDiscoverModels()).toBe(false);
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.chat([])).rejects.toThrow('OpenRouter classifiers is classifier-only.');
    expect(JSON.stringify(profiles)).not.toMatch(/disposable|proxy/); expect(calls).toEqual([]);
  });

  it('dispatches real System One questions and scalar confidence with provider-local prices', async () => {
    const { provider, calls } = await fixture();
    for (const profile of OPENROUTER_CLASSIFIER_MODELS) {
      const result = await provider.classifyNativeQuestions({ ...request, model: profile.id });
      expect(result).toMatchObject({ api: 'typesafe-system-one', provider: 'operator-router', model: profile.id, stopReason: 'stop',
        answers: { approved: { type: 'bool', probability: 0.5 }, severity: { type: 'score', score: 1.25, confidence: 0.9 } },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
      expect(result.usage?.costUsd).toBe(profile.pricing ? 10 * profile.pricing.inputPerMillion / 1_000_000 : undefined);
      expect(result.answers.severity).not.toHaveProperty('probabilities');
      expect(calls.at(-1)).toEqual({ url: '/proxy/api/v1/systemone', authorization: 'Bearer disposable-router', body: {
        model: profile.id, state: request.state, questions: { ...request.questions, approved: { ...request.questions.approved, type: 'noul' } },
      } });
    }
    const typesafe = new TypesafeProvider({ type: 'openrouter', apiKey: 'disposable', baseUrl: 'https://fixture.invalid' });
    expect(typesafe.getSpecializedModels()[0].pricing?.inputPerMillion).toBe(0);
    const decisions = new OpenAiDecisionsProvider({ type: 'openrouter', apiKey: 'disposable', baseUrl: 'https://fixture.invalid' });
    expect(decisions.getModelApi()).toBe('openai-decisions');
  });

  it('refuses every image before I/O even for the six declared image-input projections', async () => {
    const { provider, calls } = await fixture();
    const images = [{ mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }];
    for (const profile of OPENROUTER_CLASSIFIER_MODELS.filter(profile => profile.declaredInput.includes('image'))) {
      expect(await provider.classifyNativeQuestions({ ...request, model: profile.id, images })).toMatchObject({ stopReason: 'error', answers: {}, errorMessage: 'Invalid native classifier request.' });
      await expect(new SpecializedModels(provider).classify({ model: profile.id, input: 'Review', labels: ['safe'], images })).rejects.toThrow('does not support image input');
    }
    expect(calls).toEqual([]);
  });

  it('preserves decoded failure accounting through finite labels, questions and failed guest settlement', async () => {
    let malformed = false;
    const { provider, calls } = await fixture(response => response.end(JSON.stringify({ answers: malformed ? {} : {
      label: { type: 'choice', choice: 'safe', confidence: 0.75, probabilities: { safe: 0.75, review: 0.25 } },
    }, usage: { input_tokens: 10, output_tokens: 2 } })));
    const cost = 10 * 0.042 / 1_000_000;
    expect(await new SpecializedModels(provider).classify({ model, input: 'Reviewed', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { totalTokens: 12, costUsd: cost } });
    malformed = true;
    const finite = { model, state: 7, questions: { approved: { type: 'boolean' as const, prompt: 'Approved?' } } };
    const failure = await new SpecializedModels(provider).classifyQuestions(finite).catch(error => error);
    expect(failure).toBeInstanceOf(SpecializedModelError); expect(failure.usage).toMatchObject({ totalTokens: 12, costUsd: cost });
    expect(Object.isFrozen(failure.usage)).toBe(true); expect(calls.at(-1)?.body).toMatchObject({ state: { input: 7 } });
    const result = await runCodemode({ code: `store('bad',true); await models.classifyQuestions(${JSON.stringify(finite)})`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(result.isError).toBe(true); expect(result.details?.store).toBeUndefined();
    expect(result.details).toMatchObject({ usage: { totalTokens: 12, costUsd: cost }, costComplete: true,
      nestedCalls: [{ state: 'failed', usage: { totalTokens: 12 } }] });
    expect(result.details?.nestedCalls).toHaveLength(1); expect(calls).toHaveLength(3);
  });

  it('requires explicit safe endpoints and representable keys/headers without ambient authentication', async () => {
    const { baseUrl, calls } = await fixture();
    for (const bad of ['https://user:private@host/v1', 'https://host/v1?private=token', 'https://host/v1#private', 'ftp://host/v1', 'bad']) {
      expect(() => new OpenRouterClassifiersProvider({ type: 'router', apiKey: 'disposable', baseUrl: bad })).toThrow('Invalid OpenRouter classifiers endpoint.');
    }
    for (const apiKey of [undefined, 'bad\0key', 'bad\nkey', 'bad\u{1f4a5}key']) {
      const invalid = new OpenRouterClassifiersProvider({ type: 'router', baseUrl, apiKey });
      expect(invalid.validateConfig()).toBe(false);
      await expect(invalid.classify({ model, input: 'text', labels: ['safe'] })).rejects.toThrow('OpenRouter classifiers API key is required.');
    }
    const invalid = new OpenRouterClassifiersProvider({ type: 'router', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } });
    await expect(invalid.classify({ model, input: 'text', labels: ['safe'] })).rejects.toThrow('Invalid OpenRouter classifiers request headers.');
    expect(calls).toEqual([]);
    let endpoint = '';
    vi.stubGlobal('fetch', async (url: string) => { endpoint = String(url); return new Response(JSON.stringify(output())); });
    expect((await new OpenRouterClassifiersProvider({ type: 'router', apiKey: 'disposable' }).classifyNativeQuestions(request)).stopReason).toBe('stop');
    expect(endpoint).toBe('https://openrouter.ai/api/v1/systemone');
  });

  it('handles full encoded endpoints, unknown prices, private failures, partial usage and held aborts', async () => {
    let body: unknown = output(); let raw: string | undefined;
    const { baseUrl, calls } = await fixture(response => response.end(raw ?? JSON.stringify(body)));
    const unknown = new OpenRouterClassifiersProvider({ type: 'router', apiKey: 'disposable-router', baseUrl: baseUrl + '/systemone/', model: 'future' });
    expect(await unknown.classifyNativeQuestions({ ...request, model: 'future' })).toMatchObject({ stopReason: 'stop', usage: { totalTokens: 12 } });
    expect((await unknown.classifyNativeQuestions({ ...request, model: 'future' })).usage?.costUsd).toBeUndefined();
    expect(calls[0].url).toBe('/proxy/api/v1/systemone');
    body = { answers: request.questions, usage: { input_tokens: 10 } };
    expect(await unknown.classifyNativeQuestions({ ...request, model: 'future' })).toMatchObject({ stopReason: 'error', usage: { inputTokens: 10 } });
    raw = '{private disposable-router';
    const failure = await unknown.classifyNativeQuestions({ ...request, model: 'future' });
    expect(failure.stopReason).toBe('error'); expect(failure.usage).toBeUndefined(); expect(JSON.stringify(failure)).not.toMatch(/private|disposable/);
    const controller = new AbortController();
    const held = await fixture(response => { response.write('{"answers":'); controller.abort(); });
    expect(await held.provider.classifyNativeQuestions(request, { signal: controller.signal })).toMatchObject({ stopReason: 'aborted', answers: {}, errorMessage: 'System One request cancelled.' });
    expect(held.calls).toHaveLength(1);
  });
});
