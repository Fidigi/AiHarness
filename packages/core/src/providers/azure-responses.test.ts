import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProviderFactory, OpenAiProvider, type ChatOptions, type ChatResponse } from './index.js';
import { getProviderPublishedModels } from './provider-model-metadata.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { azureEnvironmentConfig } from './azure-config.js';
import type { Message, ProviderConfig } from '../types/index.js';

const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/azure-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; catalogueSha256: string; profiles: Array<{
    profile: { id: string; name: string; api: string; contextWindow: number; maxTokens: number; reasoning: boolean;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number } };
    cases: Array<{ level: ChatOptions['thinking'] | null; fields: Record<string, unknown> }>;
    path: string; auth: string; rawAnswer1: Record<string, unknown>; rawDefault: Record<string, unknown>;
    systemRole: string; tools: unknown[]; temperature: number; noneSessionKey: string | null;
    expectedUsage: NonNullable<ChatResponse['usage']>;
  }>;
};
const usageReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/original-responses-usage-reference.json', import.meta.url), 'utf8')) as {
  pinnedCommit: string; captureSha256: string; modelProjections: number; tieredModelProjections: number;
  rows: Array<{ provider: string; model: string; api: string; case: string; observed: unknown; expected: NonNullable<ChatResponse['usage']> }>;
};
const messages: Message[] = [{ id: 'question', role: 'user', content: 'hello', timestamp: new Date(0) }];
const completed = (output: unknown[] = []) => new Response([
  { type: 'response.output_text.delta', delta: 'Azure answer' },
  { type: 'response.completed', response: { id: 'azure-response', model: 'actual-deployment', output,
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 2, total_tokens: 12 } } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

afterEach(async () => { vi.unstubAllGlobals(); await closeProviderNetworkDispatchers(); });

describe('Azure environment composition', () => {
  it('keeps legacy environment defaults and requires an explicit credential/endpoint', () => {
    expect(azureEnvironmentConfig({ AZURE_OPENAI_API_KEY: 'key' })).toBeUndefined();
    expect(azureEnvironmentConfig({ AZURE_OPENAI_BASE_URL: 'https://tenant.openai.azure.com' })).toBeUndefined();
    expect(azureEnvironmentConfig({ AZURE_OPENAI_ENDPOINT: 'https://legacy.openai.azure.com', AZURE_OPENAI_DEPLOYMENT: 'legacy' }, 'stored-key'))
      .toEqual({ type: 'azure', apiKey: 'stored-key', baseUrl: 'https://legacy.openai.azure.com', deployment: 'legacy', model: 'legacy' });
  });

  it.each([
    { AZURE_OPENAI_BASE_URL: 'https://tenant.openai.azure.com' },
    { AZURE_OPENAI_RESOURCE_NAME: 'tenant' },
  ])('composes Responses without discarding model/deployment/version metadata: %j', endpoint => {
    expect(azureEnvironmentConfig({ ...endpoint, AZURE_OPENAI_API_KEY: 'key', AZURE_OPENAI_ENDPOINT: 'https://legacy.openai.azure.com',
      AZURE_OPENAI_MODEL: 'logical', AZURE_OPENAI_API_VERSION: 'preview', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'logical=deployment, next=other' }))
      .toEqual({ type: 'azure', azureApi: 'native', apiKey: 'key', baseUrl: 'https://tenant.openai.azure.com/openai/v1',
        model: 'logical', apiVersion: 'preview', azureDeploymentMap: { logical: 'deployment', next: 'other' } });
  });

  it('honors deployment maps on an explicitly versioned legacy environment endpoint', () => {
    expect(azureEnvironmentConfig({ AZURE_OPENAI_API_KEY: 'key', AZURE_OPENAI_ENDPOINT: 'https://tenant.openai.azure.com/openai/v1',
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'logical=physical' })).toMatchObject({ azureApi: 'native', azureDeploymentMap: { logical: 'physical' } });
  });

  it.each([
    { AZURE_OPENAI_RESOURCE_NAME: 'tenant/unsafe' },
    { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'missing-equals' },
    { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'model=a,model=b' },
    { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'model=' },
  ])('rejects invalid configuration without reflecting its values: %j', invalid => {
    expect(() => azureEnvironmentConfig({ AZURE_OPENAI_BASE_URL: 'https://tenant.openai.azure.com', AZURE_OPENAI_API_KEY: 'key', ...invalid,
      ...(invalid.AZURE_OPENAI_RESOURCE_NAME ? { AZURE_OPENAI_BASE_URL: undefined } : {}) })).toThrow('Invalid Azure Responses configuration.');
  });
});

describe('original Azure scoped declarations and physical policies', () => {
  const config = (model: string): ProviderConfig => ({ type: 'azure', model, apiKey: 'disposable-azure-key',
    baseUrl: 'https://owned-reference.openai.azure.com/openai/v1', azureDeploymentMap: { [model]: 'owned-deployment' }, providerMaxRetries: 0 });
  const response = (api: string, stream: boolean, observed?: unknown) => {
    if (api === 'openai-completions') {
      const usage = observed ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } };
      const choice = { index: 0, finish_reason: 'stop' };
      return stream ? new Response('data: ' + JSON.stringify({ model: 'untrusted-response-alias', choices: [{ ...choice, delta: { content: 'ok', reasoning_content: 'owned thought' } }], usage }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify({ model: 'untrusted-response-alias', choices: [{ ...choice, message: { content: 'ok', reasoning_content: 'owned thought' } }], usage }));
    }
    return new Response([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { id: 'owned-response', model: 'untrusted-response-alias', status: 'completed', output: [],
        usage: observed ?? { input_tokens: 11, output_tokens: 2, total_tokens: 13, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 } } } },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  };

  it('binds 45 independent pinned declarations, without credential/discovery I/O', () => {
    expect(reference.pinnedCommit).toBe('06a466935536f8c9bcacb2d5efc0fc021be1bdff');
    expect(reference.catalogueSha256).toBe('46c4e25b84463c6475e706c581196d2735c35feb9612d2efca0ab932c917d727');
    expect(reference.profiles).toHaveLength(45);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const { profile } of reference.profiles) {
      const provider = ProviderFactory.create({ ...config(profile.id), apiKey: undefined });
      expect(provider.getModelApi?.(profile.id)).toBe(profile.api);
      const rows = getProviderPublishedModels(provider)!;
      expect(rows).toHaveLength(45);
      expect(rows.find(row => row.id === profile.id)).toMatchObject({ name: profile.name, api: profile.api,
        contextWindow: profile.contextWindow, maxOutputTokens: profile.maxTokens, capabilities: { reasoning: profile.reasoning },
        pricing: { inputPerMillion: profile.cost.input, outputPerMillion: profile.cost.output,
          cacheReadPerMillion: profile.cost.cacheRead, cacheWritePerMillion: profile.cost.cacheWrite } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dispatches native v1 per turn while retaining explicit selectors and legacy endpoints', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const path = new URL(String(url)).pathname, body = JSON.parse(String(init.body)); calls.push({ path, body });
      return response(path.endsWith('/responses') ? 'azure-openai-responses' : 'openai-completions', body.stream === true);
    }));
    const provider = ProviderFactory.create({ ...config('gpt-5'), azureDeploymentMap: { 'gpt-5': 'r-deployment', 'deepseek-v4-pro': 'c-deployment' } });
    const r = await provider.chat(messages), c = await provider.chat(messages, { model: 'deepseek-v4-pro' });
    expect(r).toMatchObject({ model: 'gpt-5', api: 'azure-openai-responses' });
    expect(c).toMatchObject({ model: 'deepseek-v4-pro', api: 'openai-completions' });
    expect(provider.getConfiguredModel()).toBe('gpt-5');
    expect(calls).toEqual([{ path: '/openai/v1/responses', body: expect.objectContaining({ model: 'r-deployment' }) },
      { path: '/openai/v1/chat/completions', body: expect.objectContaining({ model: 'c-deployment' }) }]);
    expect(ProviderFactory.create({ ...config('gpt-5'), azureApi: 'responses' }).getModelApi?.()).toBe('azure-openai-responses');
    expect(ProviderFactory.create({ ...config('deepseek-v4-pro'), azureApi: 'completions' }).getModelApi?.()).toBe('openai-completions');
    expect(ProviderFactory.create({ type: 'azure', apiKey: 'key', baseUrl: 'https://legacy.openai.azure.com' })).toBeInstanceOf(OpenAiProvider);
    expect(ProviderFactory.create({ ...config('gpt-5'), azureApi: 'native', baseUrl: 'https://owned-reference.openai.azure.com/proxy/v1' } as ProviderConfig)
      .getModelApi?.('deepseek-v4-pro')).toBe('openai-completions');
  });

  it('pins native identity/prices/caps independently of public methods, metadata and later configuration', async () => {
    for (const id of ['gpt-5', 'deepseek-v4-pro']) {
      const row = reference.profiles.find(row => row.profile.id === id)!;
      const provider = ProviderFactory.create(config(id)), calls: unknown[] = [];
      const exposed = provider.getPublishedModels!()!.find(row => row.id === id)!;
      exposed.maxOutputTokens = Number.MAX_SAFE_INTEGER;
      exposed.pricing!.inputPerMillion = 999999;
      provider.getModelApi = () => 'forged-api'; provider.getProviderType = () => 'operator-alias';
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init.body)); calls.push(body); provider.setConfiguredModel('unknown-after-send');
        return response(row.profile.api, body.stream === true);
      }));
      const options: ChatOptions = { maxTokens: 64, get thinkingBudgets(): never { throw new Error('Unused numeric map was read'); } };
      const result = await provider.chat(messages, options);
      expect(result).toMatchObject({ model: id, api: row.profile.api, provider: row.profile.api === 'openai-completions' ? 'azure' : 'operator-alias' });
      expect(result.usage?.costUsd).toBeCloseTo(row.expectedUsage.costUsd!, 12);
      await expect(provider.chat(messages, { model: id, maxTokens: row.profile.maxTokens + 1 })).rejects.toThrow('Invalid Azure output limit.');
      expect(calls).toHaveLength(1);
    }
  });

  it('omits malformed native usage and preserves unattributed totals without fallback price', async () => {
    for (const id of ['gpt-5', 'deepseek-v4-pro']) {
      const row = reference.profiles.find(row => row.profile.id === id)!, c = row.profile.api === 'openai-completions';
      let usage: Record<string, unknown> = {};
      vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(row.profile.api, JSON.parse(String(init.body)).stream === true, usage)));
      const provider = ProviderFactory.create(config(id));
      const counters = c ? { prompt_tokens: 10, completion_tokens: 2 } : { input_tokens: 11, output_tokens: 2 };
      for (const total of [undefined, null, '13', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1]) {
        usage = { ...counters, total_tokens: total };
        expect((await provider.chat(messages)).usage).toBeUndefined();
      }
      usage = { ...counters, total_tokens: 99 };
      const unattributed = (await provider.chat(messages)).usage;
      expect(unattributed?.totalTokens).toBe(99); expect(unattributed?.costUsd).toBeUndefined();
    }
  });

  for (const id of ['gpt-5', 'deepseek-v4-pro']) it(`${id}: callback cancellation withdraws later buffered text/tools/completion`, async () => {
    const c = id === 'deepseek-v4-pro';
    const events = c ? [
      { choices: [{ delta: { reasoning_content: 'first thought', content: 'later text', tool_calls: [{ index: 0, id: 'pending', type: 'function', function: { name: 'echo', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ] : [
      { type: 'response.reasoning_summary_text.delta', delta: 'first thought' },
      { type: 'response.output_text.delta', delta: 'later text' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'pending', call_id: 'pending', name: 'echo', arguments: '{}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })));
    const controller = new AbortController(), seen: string[] = [], complete = vi.fn(), failed = vi.fn();
    await ProviderFactory.create(config(id)).streamChat(messages, async (_text, chunk) => {
      seen.push(chunk?.type ?? 'text'); await Promise.resolve(); controller.abort();
    }, complete, failed, { signal: controller.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1);
  });

  it('does not grant native C replay from legacy metadata-only provenance', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown; reasoning_content?: unknown }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const body = JSON.parse(String(init.body)); bodies.push(body); return response('openai-completions', body.stream === true); }));
    const provider = ProviderFactory.create(config('deepseek-v4-pro'));
    const metadata = { provider: 'azure', model: 'deepseek-v4-pro', api: 'openai-completions' };
    for (const provenance of [metadata, { ...metadata, provider: 'deepseek' }, { ...metadata, api: 'azure-openai-responses' }, { ...metadata, model: 'other' }, undefined]) {
      await provider.chat([...messages, { id: 'assistant', role: 'assistant', content: 'ok', timestamp: new Date(0),
        blocks: [{ type: 'reasoning', text: 'owned thought' }], metadata: provenance }]);
      expect(bodies.at(-1)!.messages.find(message => message.role === 'assistant')).toEqual({ role: 'assistant', content: 'owned thoughtok', reasoning_content: '' });
    }
  });

  for (const row of reference.profiles) it(`${row.profile.id}: owns eight request vectors, both facade modes, usage and logical/API identity`, async () => {
    const profile = row.profile, calls: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
    let observed: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = JSON.parse(String(init.body));
      calls.push({ path: new URL(String(url)).pathname + new URL(String(url)).search, headers: new Headers(init.headers), body });
      return response(profile.api, body.stream === true, observed);
    }));
    const provider = ProviderFactory.create(config(profile.id));
    const parameters = { type: 'object', required: ['x'], properties: { x: { type: 'string' } }, additionalProperties: false };
    for (const vector of row.cases) for (const mode of ['chat', 'stream'] as const) {
      const options: ChatOptions = { ...(vector.level === null ? {} : { thinking: vector.level }), systemPrompt: 'guard', maxTokens: 64,
        temperature: 0.7, tools: [{ name: 'echo', description: 'Echo', parameters }] };
      let result: ChatResponse | undefined;
      if (mode === 'chat') result = await provider.chat(messages, options);
      else await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, options);
      const call = calls.at(-1)!;
      expect(call.path).toBe(row.path); expect(call.headers.get(row.auth === 'api-key' ? 'api-key' : 'authorization'))
        .toBe(row.auth === 'api-key' ? 'disposable-azure-key' : 'Bearer disposable-azure-key');
      expect(call.headers.has(row.auth === 'api-key' ? 'authorization' : 'api-key')).toBe(false);
      expect(call.body.model).toBe('owned-deployment');
      expect(Object.fromEntries(['reasoning', 'include', 'reasoning_effort'].filter(key => call.body[key] !== undefined).map(key => [key, call.body[key]])))
        .toEqual(vector.fields);
      expect(call.body.tools).toEqual(row.tools); expect(call.body.temperature).toBe(row.temperature);
      expect((call.body.input as Array<{ role?: string }> | undefined)?.[0].role
        ?? (call.body.messages as Array<{ role?: string }> | undefined)?.[0].role).toBe(row.systemRole);
      expect(call.body[profile.api === 'openai-completions' ? 'max_completion_tokens' : 'max_output_tokens']).toBe(64);
      expect(result).toMatchObject({ content: 'ok', model: profile.id, api: profile.api, provider: 'azure' });
      expect(result?.usage).toMatchObject({ promptTokens: row.expectedUsage.promptTokens, completionTokens: row.expectedUsage.completionTokens,
        totalTokens: row.expectedUsage.totalTokens });
      expect(result?.usage?.cacheReadTokens ?? 0).toBe(row.expectedUsage.cacheReadTokens);
      expect(result?.usage?.cacheWriteTokens ?? 0).toBe(row.expectedUsage.cacheWriteTokens);
      expect(result?.usage?.costUsd).toBeCloseTo(row.expectedUsage.costUsd!, 12);
    }
    expect(calls).toHaveLength(16);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, profile.maxTokens + 1]) {
      await expect(provider.chat(messages, { maxTokens: bad })).rejects.toThrow('Invalid Azure output limit.');
    }
    expect(calls).toHaveLength(16);
    await provider.chat(messages, { maxTokens: 1 });
    const last = calls.at(-1)!.body;
    expect(last[profile.api === 'openai-completions' ? 'max_completion_tokens' : 'max_output_tokens'])
      .toBe(row.rawAnswer1[profile.api === 'openai-completions' ? 'max_completion_tokens' : 'max_output_tokens']);
    await provider.chat(messages, { sessionId: 'owned-' + 'é'.repeat(70), cacheRetention: 'none' });
    expect(calls.at(-1)!.body.prompt_cache_key ?? null).toBe(row.noneSessionKey);
    expect(calls.at(-1)!.body[profile.api === 'openai-completions' ? 'max_completion_tokens' : 'max_output_tokens'])
      .toBeUndefined(); // Raw omitted output is not the pinned simple maximum/context allocation.
    expect(usageReference.pinnedCommit).toBe(reference.pinnedCommit);
    expect(usageReference.captureSha256).toBe('8d0b14426afcce841415ad2489e8f17ffc8240865bb855310ada55b3f57cfa10');
    expect(usageReference.modelProjections).toBe(89); expect(usageReference.tieredModelProjections).toBe(12); expect(usageReference.rows).toHaveLength(214);
    const accounting = usageReference.rows.filter(vector => vector.provider === 'azure' && vector.model === profile.id);
    expect(accounting.map(vector => vector.case)).toEqual(expect.arrayContaining(['zero', 'base']));
    for (const vector of accounting) for (const streaming of [false, true]) {
      observed = vector.observed;
      let result: ChatResponse | undefined;
      if (!streaming) result = await provider.chat(messages, { maxTokens: 16 });
      else await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, { maxTokens: 16 });
      expect(result).toMatchObject({ model: profile.id, api: vector.api, provider: 'azure' });
      const { costUsd, ...counts } = vector.expected;
      expect(result?.usage).toMatchObject(counts); expect(result?.usage?.costUsd).toBeCloseTo(costUsd!, 12);
    }
    expect(calls).toHaveLength(18 + accounting.length * 2);
  });
});

describe('native Azure Responses', () => {
  it.each([
    ['https://tenant.openai.azure.com', 'https://tenant.openai.azure.com/openai/v1/responses?api-version=v1'],
    ['https://tenant.cognitiveservices.azure.com/openai/', 'https://tenant.cognitiveservices.azure.com/openai/v1/responses?api-version=v1'],
    ['https://tenant.ai.azure.com/openai/v1/responses/', 'https://tenant.ai.azure.com/openai/v1/responses?api-version=v1'],
    ['http://127.0.0.1:9999/proxy/v1', 'http://127.0.0.1:9999/proxy/v1/responses?api-version=v1'],
  ])('dispatches Responses, not Completions, at %s', async (baseUrl, url) => {
    const fetch = vi.fn(async () => completed()); vi.stubGlobal('fetch', fetch);
    const socket = vi.fn(() => { throw new Error('Azure must not probe OpenAI WebSockets'); });
    const provider = ProviderFactory.create({ type: 'azure', azureApi: 'responses', baseUrl, apiKey: 'disposable-azure-key',
      model: 'logical-model', deployment: 'actual-deployment', transport: 'websocket-cached', webSocketFactory: socket,
      customHeaders: { Authorization: 'untrusted', 'API-KEY': 'untrusted', 'x-extra': 'allowed' } });
    const answer = await provider.chat(messages, { sessionId: 'azure-session', systemPrompt: 'Be concise', maxTokens: 40,
      tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object' } }] });
    expect(answer).toMatchObject({ content: 'Azure answer', model: 'actual-deployment',
      usage: { promptTokens: 7, cacheReadTokens: 3, completionTokens: 2, totalTokens: 12 } });
    expect(provider.getProviderType()).toBe('azure'); expect(provider.getConfiguredModel()).toBe('logical-model');
    expect(socket).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
    const [target, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(target)).toBe(url);
    const headers = new Headers(init.headers);
    expect(headers.get('api-key')).toBe('disposable-azure-key'); expect(headers.has('authorization')).toBe(false);
    expect(headers.get('x-extra')).toBe('allowed'); expect(headers.has('openai-beta')).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'actual-deployment', stream: true, store: false,
      input: [{ role: 'user', content: 'hello' }], instructions: 'Be concise', max_output_tokens: 40,
      tools: [{ type: 'function', name: 'echo' }] });
    expect(String(init.body)).not.toContain('disposable-azure-key');
    expect(await provider.getAvailableModels()).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses canonical v1 URLs explicitly while conserving the legacy default', () => {
    expect(ProviderFactory.create({ type: 'azure', apiKey: 'key', baseUrl: 'https://tenant.openai.azure.com' })).toBeInstanceOf(OpenAiProvider);
    expect(ProviderFactory.create({ type: 'azure', apiKey: 'key', baseUrl: 'https://tenant.openai.azure.com/openai/v1' })).not.toBeInstanceOf(OpenAiProvider);
    expect(() => ProviderFactory.create({ type: 'azure', azureApi: 'typo', apiKey: 'key' } as unknown as ProviderConfig)).toThrow('Invalid Azure API selection.');
  });

  it('selects a deployment per requested model without mutating the catalogue identity', async () => {
    const bodies: unknown[] = []; vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return completed(); }));
    const provider = ProviderFactory.create({ type: 'azure', azureApi: 'responses', apiKey: 'key',
      baseUrl: 'https://tenant.openai.azure.com', model: 'logical-a', azureDeploymentMap: { 'logical-a': 'deployment-a', 'logical-b': 'deployment-b' },
      apiVersion: '2025-04-01-preview' });
    await provider.chat(messages); await provider.chat(messages, { model: 'logical-b' }); await provider.chat(messages, { model: 'unmapped' });
    expect(bodies).toMatchObject([{ model: 'deployment-a' }, { model: 'deployment-b' }, { model: 'unmapped' }]);
    expect(provider.getConfiguredModel()).toBe('logical-a');
  });

  it('replays tool calls/results and consumes genuine streamed tool arguments', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).input).toEqual([
        { role: 'user', content: 'hello' },
        { type: 'function_call', call_id: 'old', name: 'echo', arguments: '{"text":"old"}' },
        { type: 'function_call_output', call_id: 'old', output: 'old result' },
      ]);
      return new Response([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'new', name: 'echo', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"text":' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"new"}' },
        { type: 'response.completed', response: { id: 'r', model: 'deployment' } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    }));
    const provider = ProviderFactory.create({ type: 'azure', azureApi: 'responses', baseUrl: 'https://tenant.openai.azure.com', apiKey: 'key' });
    const response = await provider.chat([...messages,
      { id: 'assistant', role: 'assistant', content: '', timestamp: new Date(0), toolCalls: [{ id: 'old', name: 'echo', input: { text: 'old' } }] },
      { id: 'result', role: 'tool', content: 'old result', toolCallId: 'old', timestamp: new Date(0) },
    ]);
    expect(response.toolCalls).toEqual([{ id: 'new|item', name: 'echo', input: { text: 'new' } }]);
  });

  it.each(['https://name:secret@tenant.openai.azure.com', 'https://tenant.openai.azure.com?token=secret',
    'https://tenant.openai.azure.com/#secret', 'https://tenant.openai.azure.com/openai/deployments/old', 'file:///tmp/secret'])('refuses unsafe or legacy Responses URL %s before dispatch', async baseUrl => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(async () => ProviderFactory.create({ type: 'azure', azureApi: 'responses', apiKey: 'key', baseUrl }).chat(messages)).rejects.toThrow('Invalid Azure Responses configuration.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not complete a truncated Azure stream after publishing its visible prefix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"response.output_text.delta","delta":"prefix"}\n\n')));
    const provider = ProviderFactory.create({ type: 'azure', azureApi: 'responses', baseUrl: 'https://tenant.openai.azure.com', apiKey: 'key' });
    const chunks: string[] = [], complete = vi.fn(), error = vi.fn();
    await provider.streamChat(messages, chunk => { chunks.push(chunk); }, complete, error);
    expect(chunks.join('')).toBe('prefix'); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toMatchObject({ message: 'The provider response was invalid.', code: 'incomplete_sse_response' });
  });

  it('cancels an owned request without retrying or reflecting the abort reason', async () => {
    const fetch = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const provider = ProviderFactory.create({ type: 'azure', azureApi: 'responses', baseUrl: 'https://tenant.openai.azure.com', apiKey: 'key' });
    const pending = provider.chat(messages, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new Error('private-abort-reason'));
    await rejected; expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires a credential and rejects reflected error bodies', async () => {
    const fetch = vi.fn(async () => new Response('disposable-secret echoed', { status: 401 })); vi.stubGlobal('fetch', fetch);
    const config = { type: 'azure', azureApi: 'responses' as const, baseUrl: 'https://tenant.openai.azure.com' };
    await expect(ProviderFactory.create(config).chat(messages)).rejects.toThrow('configuration is invalid'); expect(fetch).not.toHaveBeenCalled();
    await expect(ProviderFactory.create({ ...config, apiKey: 'disposable-secret', providerMaxRetries: 0 }).chat(messages)).rejects.toThrow('OpenAI Responses API error (401).');
  });
});
