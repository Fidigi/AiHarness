import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareWorkersAiProvider, CLOUDFLARE_CLASSIFIER_MODELS, TypesafeProvider } from './index.js';
import { SpecializedModelError, SpecializedModels } from './specialized-models.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const model = '@cf/cloudflare/clef';
const native = { model, state: { approved: true }, questions: {
  approved: { type: 'bool' as const, instructions: 'Approved?', criteria: { true: 'Approved', false: 'Needs review' } },
  severity: { type: 'score' as const, instructions: 'Severity?', criteria: ['Low', 'High'] },
} };
const output = () => ({ answers: { approved: { type: 'noul', noul: 0.8 }, severity: { type: 'score', score: 1.25, confidence: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 } });
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply: (response: import('node:http').ServerResponse) => void = response => response.end(JSON.stringify({ success: true, result: output() }))) {
  const calls: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json'); reply(response);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy/accounts/explicit/ai`;
  const provider = new CloudflareWorkersAiProvider({ type: 'operator-cloudflare', apiKey: 'disposable-cloudflare', baseUrl });
  return { provider, calls, baseUrl };
}

describe('native Cloudflare Workers AI System One', () => {
  it('publishes the three pinned classifier profiles without chat/discovery or free-cost invention', async () => {
    const { provider, calls } = await fixture();
    const profiles = new SpecializedModels(provider).getModelsOfType('classifier');
    expect(profiles).toEqual(CLOUDFLARE_CLASSIFIER_MODELS.map(profile => ({ ...profile, provider: 'operator-cloudflare', model: profile.id })));
    expect(profiles.map(profile => [profile.id, profile.name, profile.contextWindow, profile.pricing?.inputPerMillion])).toEqual([
      [model, 'Clef', 65536, 0.24], ['@cf/cloudflare/clef-flash', 'Clef Flash', 65536, 0.09], ['typesafe/jev', 'Jev', 32000, 0],
    ]);
    profiles[0].pricing!.inputPerMillion = 999;
    expect(provider.getSpecializedModels()[0].pricing?.inputPerMillion).toBe(0.24);
    expect(provider.getConfiguredModel()).toBeUndefined(); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi(model)).toBe('cloudflare-workers-ai-system-one');
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.chat([])).rejects.toThrow('Cloudflare Workers AI is classifier-only.');
    expect(JSON.stringify(profiles)).not.toMatch(/disposable|proxy|accounts/); expect(calls).toEqual([]);
  });

  it('dispatches native wrapped input and both direct/Completed result envelopes with scalar confidence', async () => {
    let wrapped = false;
    const { provider, calls } = await fixture(response => response.end(JSON.stringify({ success: true,
      result: wrapped ? { state: 'Completed', result: output() } : output() })));
    for (const id of [model, 'typesafe/jev']) {
      wrapped = id === 'typesafe/jev';
      const result = await provider.classifyNativeQuestions({ ...native, model: id });
      expect(result).toMatchObject({ api: 'cloudflare-workers-ai-system-one', provider: 'operator-cloudflare', model: id, stopReason: 'stop',
        answers: { approved: { type: 'bool', probability: 0.8 }, severity: { type: 'score', score: 1.25, confidence: 0.9 } },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
      expect(result.usage?.costUsd).toBeCloseTo(wrapped ? 0 : 0.0000024, 12);
      expect(result.answers.severity).not.toHaveProperty('probabilities');
      expect(calls.at(-1)).toEqual({ url: '/proxy/accounts/explicit/ai/run', authorization: 'Bearer disposable-cloudflare', body: {
        model: id, input: { state: native.state, questions: { ...native.questions, approved: { ...native.questions.approved, type: 'noul' } } },
      } });
    }
  });

  it('preserves decoded failed-answer usage, not unsuccessful envelope claims or private error bodies', async () => {
    let result: unknown = { state: 'Completed', result: { answers: {}, usage: { input_tokens: 10, output_tokens: 2 } } }, success = true;
    const { provider } = await fixture(response => response.end(JSON.stringify({ success, result, errors: [{ message: 'private disposable-cloudflare' }] })));
    expect(await provider.classifyNativeQuestions(native)).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'Invalid System One response.',
      usage: { totalTokens: 12, costUsd: 0.0000024 } });
    const finite = { model, state: {}, questions: { approved: { type: 'boolean' as const, prompt: 'Approved?' } } };
    const failure = await new SpecializedModels(provider).classifyQuestions(finite).catch(error => error);
    expect(failure).toBeInstanceOf(SpecializedModelError); expect(failure.usage).toMatchObject({ totalTokens: 12, costUsd: 0.0000024 });
    expect(Object.isFrozen(failure.usage)).toBe(true);
    for (const value of [null, {}, { state: 'Queued', result: output() }, { state: 'Failed', result: output() }]) {
      result = value;
      const failed = await provider.classifyNativeQuestions(native);
      expect(failed).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'System One classification failed.' });
      expect(failed.usage).toBeUndefined(); expect(JSON.stringify(failed)).not.toMatch(/private|disposable/);
    }
    result = output(); success = false;
    const rejected = await provider.classifyNativeQuestions(native);
    expect(rejected.stopReason).toBe('error'); expect(rejected.usage).toBeUndefined();
    expect(JSON.stringify(rejected)).not.toMatch(/private|disposable/);
  });

  it('keeps finite labels/questions and authentic guest failed-call accounting on the native transport', async () => {
    let malformed = false;
    const { provider, calls } = await fixture(response => response.end(JSON.stringify({ success: true, result: { answers: malformed ? {} : {
      label: { type: 'choice', choice: 'safe', confidence: 0.75, probabilities: { safe: 0.75, review: 0.25 } },
    }, usage: { input_tokens: 10, output_tokens: 2 } } })));
    expect(await new SpecializedModels(provider).classify({ model, input: 'Approved', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { totalTokens: 12 } });
    expect(calls[0].body).toMatchObject({ model, input: { state: { input: 'Approved' }, questions: { label: { type: 'choice' } } } });
    malformed = true;
    const request = { model, state: {}, questions: { approved: { type: 'boolean', prompt: 'Approved?' } } };
    const result = await runCodemode({ code: `store('bad',true); await models.classifyQuestions(${JSON.stringify(request)})`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(result.isError).toBe(true); expect(result.details?.store).toBeUndefined();
    expect(result.details).toMatchObject({ usage: { totalTokens: 12, costUsd: 0.0000024 }, costComplete: true,
      nestedCalls: [{ state: 'failed', usage: { totalTokens: 12 } }] });
    expect(result.details?.nestedCalls).toHaveLength(1); expect(calls).toHaveLength(2);
  });

  it('requires explicit account/endpoint and credential inputs, never imports ambient configuration', async () => {
    const { baseUrl, calls } = await fixture();
    for (const config of [{}, { accountId: '' }, { accountId: 'bad\0account' }, { baseUrl: 'https://user:private@host/ai' },
      { baseUrl: 'https://host/ai?private=token' }, { baseUrl: 'https://host/ai#private' }, { baseUrl: 'ftp://host/ai' }]) {
      expect(() => new CloudflareWorkersAiProvider({ type: 'cloudflare-test', apiKey: 'disposable', ...config })).toThrow('Invalid Cloudflare Workers AI endpoint.');
    }
    for (const apiKey of [undefined, 'bad\0key', 'bad\nkey', 'bad\u{1f4a5}key']) {
      const invalid = new CloudflareWorkersAiProvider({ type: 'cloudflare-test', baseUrl, apiKey });
      expect(invalid.validateConfig()).toBe(false);
      await expect(invalid.classify({ model, input: 'text', labels: ['safe', 'review'] })).rejects.toThrow('Cloudflare Workers AI API key is required.');
    }
    const invalid = new CloudflareWorkersAiProvider({ type: 'cloudflare-test', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } });
    await expect(invalid.classify({ model, input: 'text', labels: ['safe', 'review'] })).rejects.toThrow('Invalid Cloudflare Workers AI request headers.');
    expect(calls).toEqual([]);
    let endpoint = '';
    vi.stubGlobal('fetch', async (url: string) => { endpoint = String(url); return new Response(JSON.stringify({ success: true, result: output() })); });
    const explicit = new CloudflareWorkersAiProvider({ type: 'cloudflare-test', apiKey: 'disposable', accountId: 'account:explicit' });
    expect((await explicit.classifyNativeQuestions(native)).stopReason).toBe('stop');
    expect(endpoint).toBe('https://api.cloudflare.com/client/v4/accounts/account%3Aexplicit/ai/run');
  });

  it('normalizes explicit full endpoints, conserves unknown prices and cancels held bodies without inventing usage', async () => {
    const { baseUrl, calls } = await fixture();
    const unknown = new CloudflareWorkersAiProvider({ type: 'cloudflare-test', apiKey: 'disposable', baseUrl: baseUrl + '/run/', model: 'future' });
    expect(unknown.getSpecializedModels()).toEqual([{ id: 'future', model: 'future', provider: 'cloudflare-test', type: 'classifier', api: 'cloudflare-workers-ai-system-one' }]);
    const result = await unknown.classifyNativeQuestions({ ...native, model: 'future' });
    expect(result.stopReason).toBe('stop'); expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(calls[0].url).toBe('/proxy/accounts/explicit/ai/run');
    const controller = new AbortController();
    const held = await fixture(response => { response.write('{"success":true,"result":'); controller.abort(); });
    const cancelled = await held.provider.classifyNativeQuestions(native, { signal: controller.signal });
    expect(cancelled).toMatchObject({ answers: {}, stopReason: 'aborted', errorMessage: 'System One request cancelled.' });
    expect(cancelled.usage).toBeUndefined();
    const withdrawn = new AbortController(); withdrawn.abort();
    expect((await held.provider.classifyNativeQuestions(native, { signal: withdrawn.signal })).stopReason).toBe('aborted');
    expect(held.calls).toHaveLength(1);
    // Physical TypeSafe models do not inherit Cloudflare prices or its native API merely from an operator ID.
    const typesafe = new TypesafeProvider({ type: 'cloudflare-workers-ai', apiKey: 'disposable', baseUrl });
    expect(typesafe.getModelApi()).toBe('typesafe-system-one'); expect(typesafe.getSpecializedModels()[0].pricing?.inputPerMillion).toBe(0);
  });
});
