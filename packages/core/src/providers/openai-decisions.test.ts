import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiDecisionsProvider, OPENAI_DECISIONS_MODEL, TypesafeProvider } from './index.js';
import { SpecializedModelError, SpecializedModels } from './specialized-models.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';
import type { NativeClassifierRequest, NativeClassifierResult } from './native-classification.js';

type PinnedRow = {
  case: string; model: string;
  context: Omit<NativeClassifierRequest, 'model' | 'images'> & { images?: Array<{ mimeType: 'image/png'; data: string }> };
  options: { apiKey: string; maxRetries: number; maxRetryDelayMs?: number };
  requests: Array<{ method: string; path: string; headers: { authorization: string }; body: unknown; response: { status: number; rawBody: string } }>;
  normalizedResult: Omit<NativeClassifierResult, 'usage'> & { usage?: { input: number; output: number; totalTokens: number; cost: { total: number } } };
};
const referenceBytes = readFileSync(new URL('../../../../tests/fixtures/openai-decisions-reference.json', import.meta.url));
const reference = JSON.parse(referenceBytes.toString()) as {
  pinnedCommit: string; sourceCaptureSha256: string; identity: { provider: string; model: string; api: string; type: string }; sourceRows: PinnedRow[];
};
const model = 'gpt-6-luna';
const native = { model, state: { approved: true }, questions: {
  approved: { type: 'bool' as const, instructions: 'Approved?', criteria: { true: 'Approved', false: 'Review' } },
  severity: { type: 'score' as const, instructions: 'Severity?', criteria: ['Low', 'High'] },
  label: { type: 'choice' as const, instructions: 'Label?', criteria: { safe: 'Safe', review: '' } },
} };
const answers = () => [
  { name: 'severity', type: 'score', score: 1.25, confidence: 0.9 },
  { name: 'label', type: 'choice', choice: 'safe', confidence: 0.8, probabilities: [{ value: 'safe', probability: 0.75 }, { value: 'review', probability: 0.25 }] },
  { name: 'approved', type: 'predicate', probability: 0.8 },
];
const png = { mediaType: 'image/png' as const, data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply: (response: import('node:http').ServerResponse) => void = response => response.end(JSON.stringify({ answers: answers(), usage: { input_tokens: 10, output_tokens: 2 } }))) {
  const calls: Array<{ method?: string; url?: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json'); reply(response);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Ftenant/v1`;
  const provider = new OpenAiDecisionsProvider({ type: 'operator-decisions', apiKey: 'disposable-decisions', baseUrl });
  return { provider, calls, baseUrl };
}

describe('native OpenAI Decisions', () => {
  it('publishes the pinned vision classifier and tiered prices independently of operator names', async () => {
    const { provider, calls } = await fixture();
    const profiles = new SpecializedModels(provider).getModelsOfType('classifier');
    expect(profiles).toEqual([{ id: model, model, provider: 'operator-decisions', type: 'classifier', name: 'GPT-6 Luna',
      api: 'openai-decisions', imageInput: true, contextWindow: 922000,
      pricing: { inputPerMillion: 0.1, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } }]);
    expect(OPENAI_DECISIONS_MODEL.pricingTiers).toEqual([{ inputTokensAbove: 272000, inputPerMillion: 0.2, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }]);
    expect(Object.isFrozen(OPENAI_DECISIONS_MODEL.pricingTiers[0])).toBe(true);
    profiles[0].pricing!.inputPerMillion = 999;
    expect(provider.getSpecializedModels()[0].pricing?.inputPerMillion).toBe(0.1);
    expect(provider.getConfiguredModel()).toBeUndefined(); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi(model)).toBe('openai-decisions');
    await expect(provider.chat([])).rejects.toThrow('OpenAI Decisions is classifier-only.');
    expect(new TypesafeProvider({ type: 'openai', apiKey: 'disposable' }).getModelApi()).toBe('typesafe-system-one');
    expect(calls).toEqual([]); expect(JSON.stringify(profiles)).not.toMatch(/disposable|proxy/);
  });

  it('sends native named predicate/choice/score questions and JSON text or bounded image content', async () => {
    const { provider, calls } = await fixture();
    for (const images of [undefined, [png]]) {
      const request = structuredClone({ ...native, ...(images ? { images } : {}) });
      const pending = provider.classifyNativeQuestions(request); request.state.approved = false; request.questions.severity.criteria.push('Late');
      const result = await pending;
      expect(result).toMatchObject({ api: 'openai-decisions', provider: 'operator-decisions', model, stopReason: 'stop',
        answers: { approved: { type: 'bool', probability: 0.8 }, severity: { type: 'score', score: 1.25, confidence: 0.9 },
          label: { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.75, review: 0.25 } } }, usage: { totalTokens: 12, costUsd: 0.000001 } });
      expect(result.answers.severity).not.toHaveProperty('probabilities');
      expect(calls.at(-1)).toEqual({ method: 'POST', url: '/proxy%2Ftenant/v1/decisions', authorization: 'Bearer disposable-decisions', body: {
        model, input: images ? [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(native.state) }, { type: 'input_image', image_url: `data:image/png;base64,${png.data}` }] }] : JSON.stringify(native.state),
        questions: [{ name: 'approved', type: 'predicate', instructions: 'Approved?\n\nTrue means: Approved\nFalse means: Review' },
          { name: 'severity', type: 'score', instructions: 'Severity?', levels: [{ label: 'Low' }, { label: 'High' }] },
          { name: 'label', type: 'choice', instructions: 'Label?', choices: [{ value: 'safe', description: 'Safe' }, { value: 'review' }] }],
      } });
    }
  });

  it('binds complete native requests and observed results to the pinned original classifier capture', async () => {
    expect(createHash('sha256').update(referenceBytes).digest('hex')).toBe('0580738b2b8fe40f173f6cebab58be5426bee5ce07fa9e6c4932418002cdde59');
    expect(reference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
    expect(reference.sourceCaptureSha256).toBe('84abbac9c2c8dc864f8953f976774be375181857cb3383841fd6c69b888d7d84');
    expect(reference.identity).toEqual({ provider: 'openai', model, api: 'openai-decisions', type: 'classifier' });
    expect(reference.sourceRows.map(row => row.case)).toEqual(['named-text', 'one-image', 'temperature-ignored', 'tier-boundary', 'tier-above',
      'refused-billed', 'missing-answer-billed', 'usage-absent', 'gateway-504-no-retry', 'retry-503-then-success']);
    let count = 0;
    for (const row of reference.sourceRows) {
      let attempt = 0;
      const { calls, baseUrl } = await fixture(response => {
        const observed = row.requests[Math.min(attempt++, row.requests.length - 1)].response;
        response.statusCode = observed.status; response.end(observed.rawBody);
      });
      const provider = new OpenAiDecisionsProvider({ type: 'operator-decisions', apiKey: row.options.apiKey, baseUrl,
        providerMaxRetries: row.options.maxRetries, providerMaxRetryDelayMs: row.options.maxRetryDelayMs });
      // SDK temperature is ignored on this native API; Core has no native temperature option.
      const request: NativeClassifierRequest = { model: row.model, state: row.context.state, questions: row.context.questions,
        ...(row.context.images ? { images: row.context.images.map(image => ({ mediaType: image.mimeType, data: image.data })) } : {}) };
      const before = structuredClone(request), result = await provider.classifyNativeQuestions(request);
      expect(calls, row.case).toEqual(row.requests.map(observed => ({ method: observed.method, url: observed.path,
        authorization: observed.headers.authorization, body: observed.body })));
      const { usage, timestamp, errorMessage, ...actual } = result;
      const { usage: sourceUsage, timestamp: _timestamp, errorMessage: _errorMessage, ...expected } = row.normalizedResult;
      expect(actual, row.case).toEqual({ ...expected, provider: 'operator-decisions' });
      expect(Number.isSafeInteger(timestamp)).toBe(true);
      expect(errorMessage).toBe(result.stopReason === 'error' ? row.case === 'gateway-504-no-retry'
        ? 'OpenAI Decisions classification failed.' : 'Invalid OpenAI Decisions response.' : undefined);
      if (sourceUsage) {
        expect(usage).toEqual({ inputTokens: sourceUsage.input, outputTokens: sourceUsage.output, totalTokens: sourceUsage.totalTokens, costUsd: expect.any(Number) });
        expect(usage!.costUsd).toBeCloseTo(sourceUsage.cost.total, 12);
      } else expect(result).not.toHaveProperty('usage');
      expect(request).toEqual(before); count += calls.length;
    }
    expect(count).toBe(11);
  });

  it('retains billed malformed/refused-answer usage and tier thresholds without remote error prose', async () => {
    let value: unknown = answers(), input = 272000;
    const { provider, baseUrl } = await fixture(response => response.end(JSON.stringify({ answers: value, usage: { input_tokens: input, output_tokens: 2 }, error: 'private disposable-decisions' })));
    for (const tokens of [272000, 272001]) {
      input = tokens;
      const result = await provider.classifyNativeQuestions(native);
      expect(result.stopReason).toBe('stop'); expect(result.usage?.costUsd).toBeCloseTo(tokens * (tokens > 272000 ? 0.2 : 0.1) / 1e6, 12);
    }
    const invalids = [undefined, {}, [], answers().slice(1), [...answers(), answers()[0]],
      answers().map(a => a.name === 'approved' ? { name: 'approved', type: 'refusal', reason: 'private disposable-decisions' } : a),
      answers().map(a => a.name === 'label' ? { ...a, probabilities: [{ value: 'safe', probability: 0.5 }, { value: 'safe', probability: 0.5 }] } : a),
      answers().map(a => a.name === 'label' ? { ...a, choice: 'foreign' } : a),
      answers().map(a => a.name === 'severity' ? { ...a, confidence: 1.1 } : a)];
    for (value of invalids) {
      const result = await provider.classifyNativeQuestions(native);
      expect(result).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'Invalid OpenAI Decisions response.', usage: { inputTokens: 272001, outputTokens: 2 } });
      expect(JSON.stringify(result)).not.toMatch(/private|disposable/);
    }
    const unknown = new OpenAiDecisionsProvider({ type: 'future', apiKey: 'disposable', baseUrl, model: 'future' }); value = answers();
    expect((await unknown.classifyNativeQuestions({ ...native, model: 'future' })).usage).toEqual({ inputTokens: 272001, outputTokens: 2, totalTokens: 272003 });
  });

  it('keeps finite numeric choices distinct from native scores and authentic failed guest accounting once', async () => {
    let malformed = false;
    const { provider, calls } = await fixture(response => response.end(JSON.stringify({ answers: malformed ? [] : [
      { name: 'approved', type: 'predicate', probability: 0.5 },
      { name: 'severity', type: 'choice', choice: '2', confidence: 0.8, probabilities: [{ value: '1', probability: 0.2 }, { value: '2', probability: 0.8 }] },
    ], usage: { input_tokens: 10, output_tokens: 2 } })));
    const request = { model, state: false, questions: { approved: { type: 'boolean' as const, prompt: 'Approved?' }, severity: { type: 'score' as const, prompt: 'Severity?', values: [1, 2] } }, images: [png] };
    const result = await new SpecializedModels(provider).classifyQuestions(request);
    expect(result.answers).toEqual({ approved: { value: true, probabilities: [{ value: true, probability: 0.5 }, { value: false, probability: 0.5 }] },
      severity: { value: 2, probabilities: [{ value: 1, probability: 0.2 }, { value: 2, probability: 0.8 }] } });
    expect(calls[0].body).toMatchObject({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'false' }, { type: 'input_image' }] }],
      questions: [{ type: 'predicate' }, { type: 'choice', choices: [{ value: '1', description: '1' }, { value: '2', description: '2' }] }] });
    malformed = true;
    const error = await new SpecializedModels(provider).classifyQuestions(request).catch(error => error);
    expect(error).toBeInstanceOf(SpecializedModelError); expect(Object.isFrozen(error.usage)).toBe(true);
    const failed = await runCodemode({ code: `store('bad',true); await models.classifyQuestions(${JSON.stringify(request)})`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(failed.isError).toBe(true); expect(failed.details?.store).toBeUndefined();
    expect(failed.details).toMatchObject({ usage: { totalTokens: 12, costUsd: 0.000001 }, costComplete: true, nestedCalls: [{ state: 'failed', usage: { totalTokens: 12 } }] });
    expect(failed.details?.nestedCalls).toHaveLength(1); expect(calls).toHaveLength(3);
  });

  it('admits explicit safe endpoints/headers and bounded owned images only, without ambient key or subscription loading', async () => {
    const { provider, calls, baseUrl } = await fixture();
    for (const bad of ['ftp://host/v1', 'https://user:private@host/v1', 'https://host/v1?private=token', 'https://host/v1#private']) {
      expect(() => new OpenAiDecisionsProvider({ type: 'openai', apiKey: 'disposable', baseUrl: bad })).toThrow('Invalid OpenAI Decisions endpoint.');
    }
    vi.stubEnv('OPENAI_API_KEY', 'private-ambient');
    for (const apiKey of [undefined, 'bad\0key', 'bad\nkey', 'bad\u{1f4a5}key']) {
      const invalid = new OpenAiDecisionsProvider({ type: 'openai', baseUrl, apiKey }); expect(invalid.validateConfig()).toBe(false);
      await expect(invalid.classify({ model, input: 'text', labels: ['safe', 'review'] })).rejects.toThrow('OpenAI Decisions API key is required.');
    }
    const invalid = new OpenAiDecisionsProvider({ type: 'openai', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } });
    await expect(invalid.classify({ model, input: 'text', labels: ['safe', 'review'] })).rejects.toThrow('Invalid OpenAI Decisions request headers.');
    let evaluations = 0; const getter = { ...native, get state() { evaluations++; throw new Error('private'); } };
    expect((await provider.classifyNativeQuestions(getter)).stopReason).toBe('error'); expect(evaluations).toBe(0);
    for (const images of [Array(5).fill(png), [{ ...png, data: 'not-base64' }]]) expect((await provider.classifyNativeQuestions({ ...native, images })).stopReason).toBe('error');
    expect(calls).toEqual([]);
    const full = new OpenAiDecisionsProvider({ type: 'openai', apiKey: 'disposable', baseUrl: baseUrl + '/decisions/' });
    expect((await full.classifyNativeQuestions(native)).stopReason).toBe('stop'); expect(calls[0].url).toBe('/proxy%2Ftenant/v1/decisions');
  });

  it('does not retry 504, preserves other configured retries, and cancels held reads without invented usage', async () => {
    let status = 504, attempts = 0;
    const { baseUrl, calls } = await fixture(response => { attempts++; response.statusCode = status; response.end('private disposable-decisions'); });
    const provider = new OpenAiDecisionsProvider({ type: 'openai', apiKey: 'disposable', baseUrl, providerMaxRetries: 2, providerMaxRetryDelayMs: 0 });
    const gateway = await provider.classifyNativeQuestions(native);
    expect(gateway).toMatchObject({ answers: {}, stopReason: 'error', errorMessage: 'OpenAI Decisions classification failed.' });
    expect(gateway.usage).toBeUndefined(); expect(attempts).toBe(1);
    status = 503; await provider.classifyNativeQuestions(native); expect(attempts).toBe(4);
    const withdrawn = new AbortController(); withdrawn.abort();
    expect((await provider.classifyNativeQuestions(native, { signal: withdrawn.signal })).stopReason).toBe('aborted'); expect(calls).toHaveLength(4);
    const controller = new AbortController();
    const held = await fixture(response => { response.write('{"answers":'); controller.abort(); });
    const cancelled = await held.provider.classifyNativeQuestions(native, { signal: controller.signal });
    expect(cancelled).toMatchObject({ answers: {}, stopReason: 'aborted', errorMessage: 'OpenAI Decisions request cancelled.' }); expect(cancelled.usage).toBeUndefined();
  });
});
