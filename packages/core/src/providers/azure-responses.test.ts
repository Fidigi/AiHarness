import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderFactory, OpenAiProvider } from './index.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { azureEnvironmentConfig } from './azure-config.js';
import type { Message, ProviderConfig } from '../types/index.js';

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
      .toEqual({ type: 'azure', azureApi: 'responses', apiKey: 'key', baseUrl: 'https://tenant.openai.azure.com/openai/v1',
        model: 'logical', apiVersion: 'preview', azureDeploymentMap: { logical: 'deployment', next: 'other' } });
  });

  it('honors deployment maps on an explicitly versioned legacy environment endpoint', () => {
    expect(azureEnvironmentConfig({ AZURE_OPENAI_API_KEY: 'key', AZURE_OPENAI_ENDPOINT: 'https://tenant.openai.azure.com/openai/v1',
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: 'logical=physical' })).toMatchObject({ azureApi: 'responses', azureDeploymentMap: { logical: 'physical' } });
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
    expect(response.toolCalls).toEqual([{ id: 'new', name: 'echo', input: { text: 'new' } }]);
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
