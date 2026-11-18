import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as providers from './index.js';
import { SpecializedModels } from './specialized-models.js';
import { ProviderContextOverflowError } from './context-overflow.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const model = 'gpt-6-luna';
const message = { id: 'user-1', role: 'user' as const, content: 'Approved', timestamp: 1 };
const questions = { approved: { type: 'boolean' as const, prompt: 'Approved?' } };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const state = { malformed: false, httpFailure: 'none' as 'none' | 'overflow' | 'unrecognized',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } as unknown };
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
    if (state.httpFailure !== 'none') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: state.httpFailure === 'overflow' ? 'context_length_exceeded' : 'private-unrecognized', message: 'private disposable-openai failure prose' } })); return;
    }
    if (incoming.url?.endsWith('/decisions')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ answers: state.malformed ? [] : body.questions.map((question: { name: string; type: string }) => question.type === 'predicate'
        ? { name: question.name, type: 'predicate', probability: 0.8 }
        : { name: question.name, type: 'choice', choice: 'safe', confidence: 0.8, probabilities: [{ value: 'safe', probability: 0.8 }, { value: 'review', probability: 0.2 }] }), usage: { input_tokens: 10, output_tokens: 2 } }));
    } else {
      const system = [body.instructions ?? '', ...body.input.filter((item: { role?: string }) => ['system', 'developer'].includes(item.role ?? '')).map((item: { content: string }) => item.content)].join('\n');
      const content = system.includes('Classify the user input') ? JSON.stringify({ label: 'safe' })
        : system.includes('Answer these finite-domain questions') ? JSON.stringify({ answers: { approved: { value: true, probabilities: [{ value: false, probability: 0.2 }, { value: true, probability: 0.8 }] } } }) : 'Ready';
      response.setHeader('content-type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'Thought' })}\n\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'response-1', model: body.model, usage: state.usage } })}\n\n`);
    }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, state, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Ftenant/v1` };
}

const reasoningReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/openai-reasoning-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; rows: Array<{ model: string; cases: Array<{ thinking?: providers.ChatOptions['thinking']; fields: { reasoning?: unknown; include?: unknown } }> }>;
};

const physicalReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/openai-response-physical-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; rows: Array<{ model: string; systemRole: string; observed: unknown; expected: NonNullable<providers.ChatResponse['usage']> }>;
};

const usageReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/original-responses-usage-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; modelProjections: number; tieredModelProjections: number; requests: number;
  rows: Array<{ provider: string; model: string; api: string; case: string; observed: unknown; expected: NonNullable<providers.ChatResponse['usage']> }>;
};

describe('explicit mixed OpenAI Responses/Decisions SDK', () => {
  for (const profile of reasoningReference.rows) it(`${profile.model}: distinguishes omitted reasoning from explicit levels on chat and stream`, async () => {
    expect(reasoningReference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
    expect(reasoningReference.rows).toHaveLength(44); expect(profile.cases).toHaveLength(8);
    const physical = physicalReference.rows.find(row => row.model === profile.model)!;
    expect(physicalReference.pinnedCommit).toBe(reasoningReference.pinnedCommit); expect(physicalReference.rows).toHaveLength(44);
    const { calls, baseUrl, state } = await fixture(); state.usage = physical.observed;
    const provider = new providers.OpenAiMixedProvider({ type: 'anthropic', apiKey: 'disposable-openai', baseUrl, model: profile.model, transport: 'sse' });
    for (const example of profile.cases) for (const streaming of [false, true]) {
      let result: providers.ChatResponse | undefined, failure: Error | undefined;
      const options = { thinking: example.thinking, systemPrompt: 'guard' };
      if (!streaming) result = await provider.chat([message], options);
      else await provider.streamChat([message], () => {}, response => { result = response; }, error => { failure = error; }, options);
      expect(failure).toBeUndefined(); expect(result).toMatchObject({ content: 'Ready', model: profile.model, api: 'openai-responses' });
      expect(result?.usage).toMatchObject({ promptTokens: physical.expected.promptTokens, completionTokens: physical.expected.completionTokens,
        cacheReadTokens: physical.expected.cacheReadTokens, cacheWriteTokens: physical.expected.cacheWriteTokens, totalTokens: physical.expected.totalTokens });
      expect(result?.usage?.costUsd).toBeCloseTo(physical.expected.costUsd!, 12);
      const body = calls.at(-1)!.body;
      expect(body.input[0]).toEqual({ role: physical.systemRole, content: 'guard' });
      expect(body.model).toBe(profile.model); expect(body.stream).toBe(true);
      expect(body.reasoning).toEqual(example.fields.reasoning); expect(body.include).toEqual(example.fields.include);
      // This increment does not replace the existing raw-transport omitted-output surface with streamSimple's context allocation.
      expect(body.max_output_tokens).toBeUndefined();
    }
    expect(calls).toHaveLength(16);
    expect(usageReference.pinnedCommit).toBe(reasoningReference.pinnedCommit);
    expect(usageReference.captureSha256).toBe('8d0b14426afcce841415ad2489e8f17ffc8240865bb855310ada55b3f57cfa10');
    expect(usageReference.modelProjections).toBe(89); expect(usageReference.tieredModelProjections).toBe(12); expect(usageReference.rows).toHaveLength(214);
    const accounting = usageReference.rows.filter(row => row.provider === 'openai' && row.model === profile.model);
    expect(accounting.map(row => row.case)).toEqual(expect.arrayContaining(['zero', 'base']));
    for (const vector of accounting) for (const streaming of [false, true]) {
      state.usage = vector.observed;
      let result: providers.ChatResponse | undefined;
      if (!streaming) result = await provider.chat([message], { maxTokens: 16 });
      else await provider.streamChat([message], () => {}, value => { result = value; }, error => { throw error; }, { maxTokens: 16 });
      expect(result).toMatchObject({ model: profile.model, api: vector.api });
      const { costUsd, ...counts } = vector.expected;
      expect(result?.usage).toMatchObject(counts); expect(result?.usage?.costUsd).toBeCloseTo(costUsd!, 12);
    }
    expect(calls).toHaveLength(16 + accounting.length * 2);
  });
  it('requires observed native total counters and leaves unattributed totals unpriced', async () => {
    const { state, baseUrl } = await fixture();
    const provider = new providers.OpenAiMixedProvider({ type: 'operator-openai', apiKey: 'disposable-openai', baseUrl, model, transport: 'sse' });
    for (const usage of [{ input_tokens: 11, output_tokens: 2 }, { input_tokens: 11, output_tokens: 2, total_tokens: null },
      { input_tokens: 11, output_tokens: 2, total_tokens: 12 }, { input_tokens: 11, output_tokens: 2, total_tokens: '13' }]) {
      state.usage = usage;
      expect((await provider.chat([message])).usage).toBeUndefined();
    }
    state.usage = { input_tokens: 11, output_tokens: 2, total_tokens: 14, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 } };
    const unattributed = (await provider.chat([message])).usage;
    expect(unattributed).toMatchObject({ promptTokens: 7, completionTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 14 });
    expect(unattributed?.costUsd).toBeUndefined();
    state.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    expect((await provider.chat([message])).usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
  });

  it('preserves recognized value-free context overflow authority without trusting arbitrary remote failure prose', async () => {
    const { state, baseUrl } = await fixture();
    const provider = new providers.OpenAiMixedProvider({ type: 'operator-openai', apiKey: 'disposable-openai', baseUrl, model, transport: 'sse' });
    state.httpFailure = 'overflow';
    const failure = await provider.chat([message]).catch(error => error);
    expect(failure).toBeInstanceOf(ProviderContextOverflowError); expect(failure.message).toBe('The provider context window was exceeded.');
    const callbacks: string[] = [], errors: Error[] = [];
    await provider.streamChat([message], () => { callbacks.push('chunk'); }, () => { callbacks.push('complete'); }, error => { errors.push(error); });
    expect(callbacks).toEqual([]); expect(errors).toHaveLength(1); expect(errors[0]).toBeInstanceOf(ProviderContextOverflowError);
    state.httpFailure = 'unrecognized'; const ordinary = await provider.chat([message]).catch(error => error);
    expect(ordinary).not.toBeInstanceOf(ProviderContextOverflowError); expect(ordinary.message).toBe('OpenAI response request failed.');
    expect(JSON.stringify([failure, errors, ordinary])).not.toMatch(/private|disposable/);
  });
  it('keeps native R wire defaults, mapped efforts, cache modes and Unicode cache-key truncation independent of logical aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenAiMixedProvider({ type: 'anthropic', apiKey: 'disposable-openai', baseUrl: baseUrl + '/decisions', transport: 'sse' });
    const tools = [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    await provider.chat([message], { tools, maxTokens: 1, sessionId: 'explicit-session', cacheRetention: 'long' });
    expect(calls[0].body).toMatchObject({ model: 'gpt-4o', stream: true, store: false, max_output_tokens: 16, prompt_cache_key: 'explicit-session', prompt_cache_retention: '24h', tools: [{ type: 'function', strict: false }] });
    expect(calls[0].body.reasoning).toBeUndefined(); expect(calls[0].headers.session_id).toBe('explicit-session'); expect(calls[0].headers['session-id']).toBeUndefined();
    const sessionId = '🙂'.repeat(70);
    await provider.chat([message], { model, thinking: 'max', sessionId, cacheRetention: 'long' });
    expect(calls[1].body).toMatchObject({ reasoning: { effort: 'max', summary: 'auto' }, prompt_cache_key: '🙂'.repeat(64), prompt_cache_options: { ttl: '30m' } });
    expect(calls[1].body.prompt_cache_retention).toBeUndefined();
    await provider.chat([message], { model, sessionId: 'explicit-session', cacheRetention: 'none' });
    expect(calls[2].body.prompt_cache_options).toEqual({ mode: 'explicit' }); expect(calls[2].body.prompt_cache_key).toBeUndefined();
    expect(calls[2].headers.session_id).toBeUndefined(); expect(calls[2].headers['x-client-request-id']).toBeUndefined();
    for (const base of ['https://private:token@example.test/v1', 'file:///tmp', baseUrl + '?token=private', baseUrl + '#private']) expect(() => new providers.OpenAiMixedProvider({ type: 'x', baseUrl: base })).toThrow('Invalid OpenAI endpoint.');
    await expect(provider.chat([], { model: 'future' })).rejects.toThrow('OpenAI response model is not supported.'); expect(calls).toHaveLength(3);
    const compatible = new providers.OpenAiResponsesProvider({ type: 'openai', apiKey: 'disposable-openai', baseUrl, model, transport: 'sse' });
    await compatible.chat([message]); expect(calls[3].body.reasoning).toBeUndefined(); expect(calls[3].body.include).toBeUndefined();
    await compatible.chat([message], { thinking: 'high' });
    expect(calls[4].body.reasoning).toEqual({ effort: 'high' }); expect(calls[4].body.include).toBeUndefined();
  });

  it('keeps overlapping D/R guest operations distinct, exposes direct native bools and bills a failed D answer once without publishing its store', async () => {
    const { calls, state, baseUrl } = await fixture();
    const provider = new providers.OpenAiMixedProvider({ type: 'operator-openai', apiKey: 'disposable-openai', baseUrl, model, transport: 'sse' });
    const direct = await provider.classifyNativeQuestions({ model, state: {}, questions: { approved: { type: 'bool', instructions: 'Approved?', criteria: { true: 'Approved', false: 'Review' } } } });
    expect(direct).toMatchObject({ api: 'openai-decisions', model, stopReason: 'stop', answers: { approved: { type: 'bool', probability: 0.8 } } });
    const context = { provider } as ExtensionRuntimeContext;
    const code = `await models.classifyQuestions(${JSON.stringify({ model, state: {}, questions })}); await models.classifyQuestions(${JSON.stringify({ model: `${model}:classifier`, state: {}, questions })}); store('approved', true); return 'Ready';`;
    const result = await runCodemode({ code, context, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(result.isError).not.toBe(true); expect(result.details).toMatchObject({ store: { approved: true }, costComplete: true, usage: { totalTokens: 24, costUsd: 0.000001 + 0.000001665 }, nestedCalls: [{ state: 'completed' }, { state: 'completed' }] });
    state.malformed = true;
    const failed = await runCodemode({ code: `store('bad', true); await models.classifyQuestions(${JSON.stringify({ model, state: {}, questions })});`, context, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(failed.isError).toBe(true); expect(failed.details?.store).toBeUndefined(); expect(failed.details).toMatchObject({ usage: { totalTokens: 12, costUsd: 0.000001 }, nestedCalls: [{ state: 'failed', usage: { totalTokens: 12 } }] });
    expect(calls.map(call => call.url)).toEqual(['/proxy%2Ftenant/v1/decisions', '/proxy%2Ftenant/v1/decisions', '/proxy%2Ftenant/v1/responses', '/proxy%2Ftenant/v1/decisions']); expect(provider.getConfiguredModel()).toBe(model);
  });
  it('publishes 44 reviewed R conversations and distinct R/D descriptors for the overlapping physical ID without changing the existing factory', async () => {
    const previous = providers.ProviderFactory.getRegisteredTypes();
    const provider = new providers.OpenAiMixedProvider({ type: 'operator-openai', apiKey: 'disposable-openai', model });
    expect(await provider.getAvailableModels()).toHaveLength(44); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi(model)).toBe('openai-responses'); expect(provider.getModelApi('future')).toBeUndefined();
    expect(new SpecializedModels(provider).getModelsOfType('classifier')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: model, model, api: 'openai-decisions', contextWindow: 922000, pricing: { inputPerMillion: 0.1, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } }),
      expect.objectContaining({ id: `${model}:classifier`, model, virtual: true, api: 'openai-responses', contextWindow: 272000, pricing: { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWritePerMillion: 0.125 } }),
    ]));
    expect(provider.getSpecializedModels()).toHaveLength(2); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    expect(() => provider.setConfiguredModel('future')).toThrow('OpenAI response model is not supported.'); expect(provider.getConfiguredModel()).toBe(model);
    expect(providers.ProviderFactory.getRegisteredTypes()).toEqual(previous);
    expect(new providers.OpenAiProvider({ type: 'openai', apiKey: 'disposable' }).getModelApi()).toBe('openai-completions');
  });

  it('routes native D and virtual R labels/questions with the same physical ID by the resolved operation and preserves each price', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenAiMixedProvider({ type: 'azure', apiKey: 'disposable-openai', model, baseUrl: baseUrl + '/responses', transport: 'sse' });
    const sdk = new SpecializedModels(provider);
    for (const selected of [model, `${model}:classifier`]) {
      const label = await sdk.classify({ model: selected, input: 'Approved', labels: ['safe', 'review'] });
      expect(label.label).toBe('safe'); expect(label.usage?.costUsd).toBe(selected === model ? 0.000001 : 0.000001665);
      const result = await sdk.classifyQuestions({ model: selected, state: {}, questions });
      expect(result.answers.approved.value).toBe(true); expect(result.usage?.costUsd).toBe(selected === model ? 0.000001 : 0.000001665);
    }
    expect(calls.map(call => call.url)).toEqual(['/proxy%2Ftenant/v1/decisions', '/proxy%2Ftenant/v1/decisions', '/proxy%2Ftenant/v1/responses', '/proxy%2Ftenant/v1/responses']);
    for (const call of calls) { expect(call.body.model).toBe(model); expect(call.headers.authorization).toBe('Bearer disposable-openai'); expect(call.headers['api-key']).toBeUndefined(); expect(call.headers['x-api-key']).toBeUndefined(); }
    expect(provider.getConfiguredModel()).toBe(model);
  });

  it('captures pending R ownership across nested D dispatch and configuration changes, and stops after awaited callback withdrawal', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenAiMixedProvider({ type: 'operator-openai', apiKey: 'disposable-openai', model, baseUrl, transport: 'sse' });
    const completions: providers.ChatResponse[] = [], events: string[] = [];
    await provider.streamChat([message], async (_chunk, event) => {
      events.push(event?.type ?? '');
      if (event?.type === 'reasoning_delta') { await new SpecializedModels(provider).classifyQuestions({ model, state: {}, questions }); provider.setConfiguredModel('gpt-4o'); }
    }, result => { if (result) completions.push(result); }, error => { throw error; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ provider: 'operator-openai', api: 'openai-responses', model, content: 'Ready', reasoning: 'Thought', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: 0.000001665 } });
    expect(calls.map(call => call.body.model)).toEqual([model, model]); expect(provider.getConfiguredModel()).toBe('gpt-4o');
    const controller = new AbortController(), withdrawn: string[] = [], errors: Error[] = [];
    await provider.streamChat([message], async (_chunk, event) => { withdrawn.push(event?.type ?? ''); await Promise.resolve(); controller.abort(); },
      () => { withdrawn.push('complete'); }, error => { errors.push(error); }, { signal: controller.signal });
    expect(withdrawn).toEqual(['reasoning_delta']); expect(errors).toHaveLength(1); expect(errors[0].message).toBe('OpenAI request aborted.');
  });
});
