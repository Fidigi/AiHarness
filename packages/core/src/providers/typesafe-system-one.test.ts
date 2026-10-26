import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypesafeProvider, TYPESAFE_CLASSIFIER_MODEL } from './index.js';
import { SpecializedModelError, SpecializedModels } from './specialized-models.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import type { QuestionClassificationRequest } from './classification-questions.js';
import type { NativeClassifierRequest } from './native-classification.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const request: QuestionClassificationRequest = { model: 'jev-latest', state: { approved: true }, questions: {
  approved: { type: 'boolean', prompt: 'Approved?' },
  route: { type: 'choice', prompt: 'Select route', choices: ['safe', 'review'] },
  level: { type: 'score', prompt: 'Select level', values: [0, 2, 4] },
} };
const body = () => ({ answers: {
  approved: { type: 'noul', noul: 0.8 },
  route: { type: 'choice', choice: 'safe', probabilities: { safe: 0.75, review: 0.25 }, confidence: 0.75 },
  level: { type: 'choice', choice: '4', probabilities: { 0: 0, 2: 0.25, 4: 0.75 }, confidence: 0.75 },
}, usage: { input_tokens: 10, output_tokens: 2 } });
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply: (response: import('node:http').ServerResponse) => void = response => response.end(JSON.stringify(body()))) {
  const calls: Array<{ url?: string; authorization?: string; accept?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ url: request.url, authorization: request.headers.authorization, accept: request.headers.accept, body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json'); reply(response);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy/v1`;
  const provider = new TypesafeProvider({ type: 'operator-typesafe', apiKey: 'disposable-typesafe-key', baseUrl });
  return { provider, calls, baseUrl };
}

describe('native TypeSafe System One classifier', () => {
  const nativeRequest = (): NativeClassifierRequest => ({ model: 'jev-latest', state: { reviewed: true }, questions: {
    approved: { type: 'bool', instructions: 'Approved?', criteria: { true: 'Reviewed and safe', false: 'Needs review' } },
    route: { type: 'choice', instructions: 'Choose route', criteria: { safe: 'Ready for use', review: 'Manual review' } },
    level: { type: 'score', instructions: 'Judge severity', criteria: ['Low severity', 'High severity'] },
  } });
  const nativeBody = () => ({ answers: { approved: { type: 'noul', noul: 0.8 },
    route: { type: 'choice', choice: 'safe', probabilities: { safe: 0.75, review: 0.25 }, confidence: 0.7 },
    level: { type: 'score', score: 1.25, confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } });

  it('exposes native criteria, scalar scores and structured results without changing finite distributions', async () => {
    const { provider, calls } = await fixture(response => response.end(JSON.stringify(nativeBody())));
    const request = nativeRequest(), before = structuredClone(request);
    const result = await provider.classifyNativeQuestions(request);
    expect(result).toMatchObject({ api: 'typesafe-system-one', provider: 'operator-typesafe', model: 'jev-latest', stopReason: 'stop', timestamp: expect.any(Number),
      answers: { approved: { type: 'bool', probability: 0.8 }, route: { type: 'choice', choice: 'safe', probabilities: { safe: 0.75, review: 0.25 }, confidence: 0.7 },
        level: { type: 'score', score: 1.25, confidence: 0.9 } }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 } });
    expect(result.answers.level).not.toHaveProperty('probabilities'); expect(result).not.toHaveProperty('errorMessage');
    expect(calls[0]).toMatchObject({ url: '/proxy/v1/systemone', authorization: 'Bearer disposable-typesafe-key', body: {
      model: 'jev-latest', state: request.state, questions: { ...request.questions, approved: { ...request.questions.approved, type: 'noul' } } } });
    expect(request).toEqual(before);
    // Existing finite scores must still reject a scalar rather than manufacture a histogram.
    await expect(provider.classifyQuestions({ model: 'jev-latest', state: {}, questions: { level: { type: 'score', prompt: 'Severity?', values: [0, 1, 2] } } })).rejects.toThrow('Invalid System One response.');
  });

  it('owns native input across I/O and preserves prototype-bearing names as inert JSON keys', async () => {
    const request = nativeRequest(), before = structuredClone(request);
    const { provider, calls } = await fixture(response => {
      request.model = 'changed'; request.state.reviewed = false;
      if (request.questions.level.type === 'score') request.questions.level.criteria.push('changed');
      response.end(JSON.stringify(nativeBody()));
    });
    expect(await provider.classifyNativeQuestions(request)).toMatchObject({ model: 'jev-latest', stopReason: 'stop', usage: { costUsd: 0 } });
    expect(calls[0].body).toMatchObject({ model: before.model, state: before.state, questions: { ...before.questions, approved: { ...before.questions.approved, type: 'noul' } } });
    const special = await fixture(response => response.end(JSON.stringify({ answers: Object.fromEntries([['__proto__', { type: 'choice', choice: '__proto__',
      probabilities: Object.fromEntries([['__proto__', 0.75], ['other', 0.25]]), confidence: 0.75 }]]) })));
    const result = await special.provider.classifyNativeQuestions({ model: 'jev-latest', state: {}, questions: Object.fromEntries([['__proto__',
      { type: 'choice', instructions: 'Inert names', criteria: Object.fromEntries([['__proto__', 'First'], ['other', 'Second']]) }]]) });
    expect(result.stopReason).toBe('stop'); expect(Object.hasOwn(result.answers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype); expect(result.usage).toBeUndefined();
  });

  it('returns no partial answers on native refusals/malformed values while preserving only observed usage', async () => {
    let payload: unknown = nativeBody(), status = 200;
    const { provider, baseUrl } = await fixture(response => { response.statusCode = status; response.end(JSON.stringify(payload)); });
    for (const answers of [ {}, { ...nativeBody().answers, level: { type: 'score', score: 1, confidence: 2 } },
      { ...nativeBody().answers, level: { type: 'choice', choice: '1', confidence: 1 } },
      { ...nativeBody().answers, route: { type: 'refusal', message: 'private disposable-typesafe-key' } },
      { ...nativeBody().answers, route: { type: 'choice', choice: 'safe', probabilities: { safe: 1 }, confidence: 1 } },
      { ...nativeBody().answers, foreign: {} }, { ...nativeBody().answers, approved: { type: 'noul', noul: -1 } },
    ]) {
      payload = { answers, usage: { input_tokens: 10, output_tokens: 2 }, private: 'disposable-typesafe-key' };
      const result = await provider.classifyNativeQuestions(nativeRequest());
      expect(result).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'Invalid System One response.', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 } });
      expect(JSON.stringify(result)).not.toContain('disposable-typesafe-key'); expect(result).not.toHaveProperty('cause');
    }
    payload = { answers: {}, usage: { input_tokens: 4, output_tokens: -1 } };
    expect((await provider.classifyNativeQuestions(nativeRequest())).usage).toEqual({ inputTokens: 4 });
    payload = { answers: {}, usage: { input_tokens: '10', output_tokens: 0.5 } };
    expect((await provider.classifyNativeQuestions(nativeRequest())).usage).toBeUndefined();
    payload = nativeBody();
    const unknown = new TypesafeProvider({ type: 'operator-typesafe', model: 'future', apiKey: 'disposable', baseUrl });
    expect((await unknown.classifyNativeQuestions({ ...nativeRequest(), model: 'future' })).usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    status = 403;
    expect(await provider.classifyNativeQuestions(nativeRequest())).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'System One classification failed.' });
    expect((await provider.classifyNativeQuestions(nativeRequest())).usage).toBeUndefined();
  });

  it('refuses unsafe/bounded native requests before dispatch and returns aborted results for held bodies', async () => {
    const { provider, calls } = await fixture(); let getters = 0;
    const accessor = Object.defineProperty({}, 'state', { enumerable: true, get() { getters++; throw new Error('private accessor'); } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const request of [ accessor, { ...nativeRequest(), state: cycle }, { ...nativeRequest(), state: [] },
      { ...nativeRequest(), state: { large: 'x'.repeat(32_768) } }, { ...nativeRequest(), questions: {} },
      { ...nativeRequest(), questions: { q: { type: 'score', instructions: 'Invalid scale', criteria: [] } } },
      { ...nativeRequest(), images: [{ mediaType: 'image/png', data: 'not-used' }] },
    ]) {
      expect(await provider.classifyNativeQuestions(request as NativeClassifierRequest)).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'Invalid native classifier request.' });
    }
    const withdrawn = new AbortController(); withdrawn.abort();
    expect(await provider.classifyNativeQuestions(nativeRequest(), { signal: withdrawn.signal })).toMatchObject({ answers: {}, stopReason: 'aborted', errorMessage: 'System One request cancelled.' });
    expect(getters).toBe(0); expect(calls).toEqual([]);
    const signal = new AbortController();
    const held = await fixture(response => { response.write('{"answers":'); signal.abort(); });
    const result = await held.provider.classifyNativeQuestions(nativeRequest(), { signal: signal.signal });
    expect(result).toMatchObject({ answers: {}, stopReason: 'aborted', errorMessage: 'System One request cancelled.' }); expect(result.usage).toBeUndefined();
    // A compatibility fetch shim can finish JSON decoding while observing withdrawal.
    // Only these actually decoded counters survive; the result still contains no answer.
    const decoded = new AbortController();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, async json() { decoded.abort(); return nativeBody(); } }));
    expect(await provider.classifyNativeQuestions(nativeRequest(), { signal: decoded.signal })).toMatchObject({ answers: {}, stopReason: 'aborted',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 } });
  });

  it('publishes its one classifier profile without inventing chat/discovery/image capability or exposing credentials', async () => {
    const { provider, calls } = await fixture();
    expect(provider.getModelApi('jev-latest')).toBe('typesafe-system-one');
    expect(provider.getConfiguredModel()).toBeUndefined(); expect(provider.canDiscoverModels()).toBe(false);
    const models = new SpecializedModels(provider).getAvailableOfType('classifier');
    expect(models).toEqual([{ ...TYPESAFE_CLASSIFIER_MODEL, provider: 'operator-typesafe', model: 'jev-latest' }]);
    expect(models[0]).toMatchObject({ id: 'jev-latest', name: 'Jev', api: 'typesafe-system-one', contextWindow: 64_000,
      pricing: { inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    models[0].pricing!.inputPerMillion = 100;
    expect(new SpecializedModels(provider).getModelsOfType('classifier')[0].pricing?.inputPerMillion).toBe(0);
    expect(JSON.stringify(models)).not.toContain('disposable-typesafe-key'); expect(JSON.stringify(models)).not.toContain('/proxy');
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    const catalog = await collectProviderModelCatalog(new Map([['operator-typesafe', provider]]), { includePublishedProviders: false });
    expect(catalog[0]?.models).toEqual([]); expect(calls).toEqual([]);
  });

  it('uses native authenticated systemone JSON, boolean noul and complete choice distributions, never chat completions', async () => {
    const { provider, calls, baseUrl } = await fixture();
    const result = await new SpecializedModels(provider).classifyQuestions(request);
    expect(calls).toEqual([{ url: '/proxy/v1/systemone', authorization: 'Bearer disposable-typesafe-key', accept: 'application/json', body: {
      model: 'jev-latest', state: request.state, questions: {
        approved: { type: 'noul', instructions: 'Approved?', criteria: { true: 'true', false: 'false' } },
        route: { type: 'choice', instructions: 'Select route', criteria: { safe: 'safe', review: 'review' } },
        level: { type: 'choice', instructions: 'Select level', criteria: { 0: '0', 2: '2', 4: '4' } },
      },
    } }]);
    expect(result.answers.approved.value).toBe(true);
    expect(result.answers.approved.probabilities[1].probability).toBeCloseTo(0.2);
    expect(result.answers.route).toEqual({ value: 'safe', probabilities: [{ value: 'safe', probability: 0.75 }, { value: 'review', probability: 0.25 }] });
    expect(result.answers.level).toEqual({ value: 4, probabilities: [{ value: 0, probability: 0 }, { value: 2, probability: 0.25 }, { value: 4, probability: 0.75 }] });
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 });
    const root = new TypesafeProvider({ type: 'typesafe', apiKey: 'root-disposable', baseUrl: new URL(baseUrl).origin });
    await root.classifyQuestions(request); expect(calls[1].url).toBe('/systemone');
  });

  it('classifies labels using native choices and wraps nonobject state without manufacturing a score distribution', async () => {
    let usage: unknown, change = () => {};
    const { provider, calls } = await fixture(response => { change(); response.end(JSON.stringify({ answers: { label: {
      type: 'choice', choice: 'safe', probabilities: { safe: 0.9, review: 0.1 }, confidence: 0.9,
    } }, ...(usage === undefined ? {} : { usage }) })); });
    const classify = () => new SpecializedModels(provider).classify({ model: 'jev-latest', input: 'some input', labels: ['safe', 'review'] });
    expect(await new SpecializedModels(provider).classify({ model: 'jev-latest', input: 'some input', labels: ['safe', 'review'] })).toEqual({ label: 'safe', usage: undefined });
    expect(calls[0].body).toMatchObject({ state: { input: 'some input' }, questions: { label: { type: 'choice', criteria: { safe: 'safe', review: 'review' } } } });
    usage = { input_tokens: 4 }; expect((await classify()).usage).toEqual({ inputTokens: 4 });
    usage = { input_tokens: -1, output_tokens: 2 }; expect((await classify()).usage).toEqual({ outputTokens: 2 });
    const mutable = { model: 'jev-latest', input: 'some input', labels: ['safe', 'review'] };
    change = () => { mutable.model = 'changed'; mutable.labels[0] = 'changed'; };
    usage = { input_tokens: 10, output_tokens: 2 };
    expect(await provider.classify(mutable)).toEqual({ label: 'safe', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 } });
  });

  it('reaches the real guest bridge and conserves successful billed usage once even after a later script failure', async () => {
    const { provider, calls } = await fixture();
    const result = await runCodemode({ code: `const m=await models.getModelOfType('classifier'); text(m.api); text((await models.classifyQuestions(${JSON.stringify(request)})).answers.level.value); store('ok',true);`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(result.isError, result.content).toBe(false); expect(result.content).toContain('typesafe-system-one');
    expect(result.details).toMatchObject({ costComplete: true, usage: { totalTokens: 12, costUsd: 0 }, store: { ok: true } });
    expect(result.details?.nestedCalls).toHaveLength(1);
    const failed = await runCodemode({ code: `await models.classifyQuestions(${JSON.stringify(request)}); store('bad',true); throw Error('after classifier');`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(failed.isError).toBe(true); expect(failed.details?.store).toBeUndefined();
    expect(failed.details?.usage?.totalTokens).toBe(12); expect(calls).toHaveLength(2);
  });

  it('rejects malformed/foreign/missing distributions, scalar score confidence, and invalid boolean probabilities', async () => {
    for (const invalid of [ {}, { ...body(), answers: { ...body().answers, approved: { type: 'noul', noul: 2 } } },
      { ...body(), answers: { ...body().answers, route: { type: 'choice', choice: 'safe', probabilities: { safe: 1 }, confidence: 1 } } },
      { ...body(), answers: { ...body().answers, level: { type: 'score', score: 4, confidence: 0.9 } } },
      { ...body(), answers: { ...body().answers, foreign: {} } },
    ]) {
      const { provider } = await fixture(response => response.end(JSON.stringify(invalid)));
      const failure = await provider.classifyQuestions(request).catch(error => error);
      expect(failure.message).toBe('Invalid System One response.');
      expect(failure.usage).toEqual('usage' in invalid ? { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 } : undefined);
    }
  });

  it('retains only genuine decoded usage on malformed label/question answers through SDK error boundaries', async () => {
    let payload: unknown = { answers: {}, usage: { input_tokens: 10, output_tokens: 2 }, error: 'private upstream body disposable-typesafe-key' };
    const { provider, baseUrl } = await fixture(response => response.end(JSON.stringify(payload)));
    for (const call of [() => provider.classifyQuestions(request),
      () => provider.classify({ model: 'jev-latest', input: 'test', labels: ['safe', 'review'] }),
      () => new SpecializedModels(provider).classifyQuestions(request),
      () => new SpecializedModels(provider).classify({ model: 'jev-latest', input: 'test', labels: ['safe', 'review'] })]) {
      const failure = await call().catch(error => error);
      expect(failure).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 } });
      expect(failure).toBeInstanceOf(SpecializedModelError);
      expect(Object.isFrozen(failure.usage)).toBe(true);
      expect(JSON.stringify(failure)).not.toMatch(/private|disposable|proxy/);
    }
    const unknown = new TypesafeProvider({ type: 'typesafe', apiKey: 'disposable', baseUrl, model: 'unpublished' });
    const failure = await unknown.classifyQuestions({ ...request, model: 'unpublished' }).catch(error => error);
    expect(failure.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    payload = { answers: {}, usage: { input_tokens: -1, output_tokens: 2 } };
    expect((await provider.classifyQuestions(request).catch(error => error)).usage).toEqual({ outputTokens: 2 });
    for (const usage of [undefined, {}, { input_tokens: 1.5, output_tokens: -2 }, { input_tokens: '10' }]) {
      payload = { answers: {}, usage };
      expect((await provider.classifyQuestions(request).catch(error => error)).usage).toBeUndefined();
    }
  });

  it('accounts failed billed guest calls once without inventing answers or committing an unhandled store', async () => {
    const { provider, calls, baseUrl } = await fixture(response => response.end(JSON.stringify({ answers: {}, usage: { input_tokens: 10, output_tokens: 2 } })));
    for (const handled of [false, true]) {
      const code = `store('pending',true); ${handled ? 'try {' : ''} await models.classifyQuestions(${JSON.stringify(request)}); ${handled ? '} catch (error) {text(error.message)}' : ''}`;
      const result = await runCodemode({ code, context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
      expect(result.isError).toBe(!handled);
      expect(result.details).toMatchObject({ costComplete: true, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0 },
        nestedCalls: [{ kind: 'classifier', state: 'failed', isError: true, usage: { totalTokens: 12 } }] });
      expect(result.details?.nestedCalls).toHaveLength(1);
      expect(result.details?.store).toEqual(handled ? { pending: true } : undefined);
      expect(result.content).not.toMatch(/private|disposable/);
    }
    const unknown = new TypesafeProvider({ type: 'typesafe', apiKey: 'disposable', baseUrl, model: 'unpublished' });
    const failed = await runCodemode({ code: `await models.classifyQuestions(${JSON.stringify({ ...request, model: 'unpublished' })});`,
      context: { provider: unknown } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(failed.isError).toBe(true);
    expect(failed.details?.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(failed.details?.costComplete).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('refuses images, missing/invalid credentials, unknown chat work and withdrawn input before network dispatch', async () => {
    const { provider, calls, baseUrl } = await fixture();
    const controller = new AbortController(); controller.abort('private reason');
    await expect(provider.classifyQuestions(request, { signal: controller.signal })).rejects.toThrow('cancelled');
    await expect(provider.classifyQuestions({ ...request, images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] })).rejects.toThrow('image');
    await expect(provider.chat([])).rejects.toThrow('classifier-only');
    const noKey = new TypesafeProvider({ type: 'typesafe', baseUrl }); expect(noKey.validateConfig()).toBe(false);
    await expect(noKey.classifyQuestions(request)).rejects.toThrow('API key');
    for (const apiKey of ['bad\nkey', 'bad\0key', 'bad\u{1f4a5}key']) {
      const invalid = new TypesafeProvider({ type: 'typesafe', apiKey, baseUrl });
      expect(invalid.validateConfig()).toBe(false);
      await expect(invalid.classifyQuestions(request)).rejects.toThrow('API key');
    }
    expect(calls).toEqual([]);
  });

  it('refuses endpoint secrets and keeps HTTP/error bodies out of diagnostics', async () => {
    for (const baseUrl of ['ftp://host/v1', 'https://user:private@host/v1', 'https://host/v1?token=private', 'https://host/v1#private']) {
      expect(() => new TypesafeProvider({ type: 'typesafe', baseUrl })).toThrow('Invalid TypeSafe endpoint');
    }
    const { provider, baseUrl } = await fixture(response => { response.statusCode = 401; response.end('private upstream body disposable-typesafe-key'); });
    for (const value of ['private\0header', 'private\u{1f4a5}header']) {
      const invalid = new TypesafeProvider({ type: 'typesafe', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': value } });
      await expect(invalid.classifyQuestions(request)).rejects.toThrow('Invalid TypeSafe request headers.');
    }
    await expect(provider.classifyQuestions(request)).rejects.toThrow('System One API error (401)');
    await provider.classifyQuestions(request).catch(error => expect(error.message).not.toMatch(/private|disposable|proxy/));
  });

  it('cancels a held native body and bounds declared response sizes', async () => {
    const { provider, calls } = await fixture(response => { response.writeHead(200); response.write('{"answers":'); });
    const controller = new AbortController(), pending = provider.classifyQuestions(request, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (calls.length) { clearInterval(timer); resolve(); } }, 5); });
    controller.abort('private reason'); await rejected;
    const oversized = await fixture(response => { response.setHeader('content-length', 17 * 1024 * 1024); response.end(); });
    await expect(oversized.provider.classifyQuestions(request)).rejects.toThrow('output limit');
  });
});
