import { describe, expect, it, vi } from 'vitest';
import { MockProvider, OpenAiProvider, ProviderFactory, TypesafeProvider, type AiProvider } from './index.js';
import { SpecializedModels, validateGeneratedImages } from './specialized-models.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';

describe('credential-private specialized model SDK', () => {
  it('routes explicitly qualified auxiliary TypeSafe models without changing current IDs or conversational credentials', async () => {
    const chat = new MockProvider({ type: 'mock', model: 'chat' });
    const native = new TypesafeProvider({ type: 'operator-label', apiKey: 'private-typesafe-key' });
    const source = new Map<string, AiProvider>([['typesafe', native]]);
    const classify = vi.spyOn(native, 'classify').mockResolvedValue({ label: 'yes', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } });
    const chatClassify = vi.spyOn(chat, 'classify');
    const bridge = new SpecializedModels(chat, value => value.replaceAll('private-typesafe-key', '[REDACTED]'), undefined, () => source);
    expect(bridge.getModelsOfType('classifier')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'chat:classifier', provider: 'mock' }),
      expect.objectContaining({ id: 'typesafe::jev-latest', provider: 'typesafe', model: 'jev-latest', api: 'typesafe-system-one', type: 'classifier' }),
    ]));
    expect(JSON.stringify(bridge.getModelsOfType('classifier'))).not.toContain('private-typesafe-key');
    expect(await bridge.classify({ model: 'typesafe::jev-latest', input: 'Approve', labels: ['yes', 'no'] })).toMatchObject({ label: 'yes', usage: { totalTokens: 5 } });
    expect(classify).toHaveBeenCalledWith({ model: 'jev-latest', input: 'Approve', labels: ['yes', 'no'] }, expect.objectContaining({ api: 'typesafe-system-one', signal: expect.any(AbortSignal) }));
    expect(chatClassify).not.toHaveBeenCalled(); expect(chat.getConfiguredModel()).toBe('chat');
    await expect(bridge.classify({ model: 'typesafe::jev-latest', input: 'Approve', labels: ['yes'], images: [{ mediaType: 'image/png', data: png }] })).rejects.toThrow('does not support image');
    await expect(bridge.generateImages({ model: 'typesafe::jev-latest', prompt: 'image' })).rejects.toThrow('not available');
    expect(classify).toHaveBeenCalledTimes(1);
    vi.spyOn(native, 'validateConfig').mockReturnValue(false);
    expect(bridge.getAvailableOfType('classifier').map(model => model.id)).toEqual(['chat:classifier']);
  });

  it('does not turn an auxiliary namespace into a pricing or API identity', async () => {
    const chat = new MockProvider({ type: 'mock', model: 'chat' });
    const auxiliary = new MockProvider({ type: 'private-adapter', model: 'gpt-4o' });
    const classify = vi.spyOn(auxiliary, 'classify').mockResolvedValue({ label: 'yes', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    const bridge = new SpecializedModels(chat, undefined, undefined, () => new Map([['openai', auxiliary]]));
    const result = await bridge.classify({ model: 'openai::gpt-4o:classifier', input: 'Approve', labels: ['yes'] });
    expect(result.usage?.costUsd).toBeUndefined();
    expect(classify.mock.calls[0][1]).not.toHaveProperty('api');
  });

  it('revalidates auxiliary ownership after hooks and refuses withdrawn authority before effects', async () => {
    const chat = new MockProvider({ type: 'mock', model: 'chat' });
    const original = new TypesafeProvider({ type: 'original', apiKey: 'synthetic-first' });
    const replacement = new TypesafeProvider({ type: 'replacement', apiKey: 'synthetic-second' });
    const source = new Map<string, AiProvider>([['typesafe', original]]);
    const first = vi.spyOn(original, 'classify'), second = vi.spyOn(replacement, 'classify').mockResolvedValue({ label: 'yes' });
    const bridge = new SpecializedModels(chat, undefined, async (_type, request) => { source.set('typesafe', replacement); return request; }, () => source);
    await expect(bridge.classify({ model: 'typesafe::jev-latest', input: 'Approve', labels: ['yes'] })).resolves.toMatchObject({ label: 'yes' });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
    const withdrawn = new SpecializedModels(chat, undefined, async (_type, request) => { source.delete('typesafe'); return request; }, () => source);
    await expect(withdrawn.classify({ model: 'typesafe::jev-latest', input: 'Approve', labels: ['yes'] })).rejects.toThrow('operation failed');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each(['classify', 'classifyQuestions', 'generateImages'] as const)('rejects retired auxiliary %s publication while preserving observed failed-call usage', async method => {
    const chat = new MockProvider({ type: 'mock', model: 'chat' }), auxiliary = new MockProvider({ type: 'auxiliary', model: 'aux-chat' });
    const source = new Map<string, AiProvider>([['aux', auxiliary]]);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const wait = async () => { entered(); await held; return usage; };
    if (method === 'classify') vi.spyOn(auxiliary, method).mockImplementation(async () => ({ label: 'yes', usage: await wait() }));
    else if (method === 'classifyQuestions') vi.spyOn(auxiliary, method).mockImplementation(async () => ({ answers: {}, usage: await wait() }));
    else vi.spyOn(auxiliary, method).mockImplementation(async () => ({ images: [{ mediaType: 'image/png', data: png }], usage: await wait() }));
    const bridge = new SpecializedModels(chat, undefined, undefined, () => source);
    const operation = method === 'classify' ? bridge.classify({ model: 'aux::aux-chat:classifier', input: 'Approve', labels: ['yes'] })
      : method === 'classifyQuestions' ? bridge.classifyQuestions({ model: 'aux::aux-chat:classifier', state: {}, questions: { approved: { type: 'boolean', prompt: 'Approved?' } } })
        : bridge.generateImages({ model: 'aux::mock-image', prompt: 'pixel' });
    const pending = operation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await started; source.set('aux', new MockProvider({ type: 'auxiliary', model: 'aux-chat' })); release();
    const result = await pending;
    expect(result.value).toBeUndefined(); expect(result.error).toMatchObject({ message: 'Specialized model operation failed or was cancelled.', usage });
  });

  it('executes a typed virtual classifier without changing the conversational model', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' }, ['{"label":"yes"}']);
    const bridge = new SpecializedModels(provider);
    expect(bridge.getModelOfType('classifier')).toEqual({ id: 'virtual-chat:classifier', model: 'virtual-chat', provider: 'mock', type: 'classifier', virtual: true });
    const result = await bridge.classify({ model: 'virtual-chat:classifier', input: 'Is this safe?', labels: ['yes', 'no'] });
    expect(result).toMatchObject({ label: 'yes', usage: { totalTokens: expect.any(Number) } });
    expect(provider.getConfiguredModel()).toBe('virtual-chat');
    expect(await bridge.generateImages({ model: 'mock-image', prompt: 'pixel' })).toMatchObject({ images: [{ mediaType: 'image/png', data: png }] });
  });

  it('distinguishes discoverable models from credential-backed availability', () => {
    const bridge = new SpecializedModels(new OpenAiProvider({ type: 'openai', model: 'gpt-test' }));
    expect(bridge.getModelsOfType('image')).toHaveLength(2);
    expect(bridge.getAvailableOfType('image')).toEqual([]);
    expect(bridge.getModelOfType('image')).toBeUndefined();
  });

  it('bounds metadata and sanitizes provider catalogue/availability failures before execution', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    const bridge = new SpecializedModels(provider);
    const catalogue = vi.spyOn(provider, 'getSpecializedModels').mockImplementationOnce(() => { throw new Error('Authorization: private-catalogue-key'); });
    expect(() => bridge.getModelsOfType('classifier')).toThrow('Specialized model metadata is unavailable.');
    catalogue.mockReturnValue(Array(101).fill({ id: 'x', type: 'classifier', provider: 'mock', model: 'x' }));
    expect(() => bridge.getModelsOfType('classifier')).toThrow('metadata is unavailable');
    catalogue.mockRestore();
    vi.spyOn(provider, 'getProviderType').mockReturnValue('x'.repeat(501));
    expect(() => bridge.getModelsOfType('classifier')).toThrow('metadata is unavailable');
    vi.spyOn(provider, 'validateConfig').mockImplementation(() => { throw new Error('Authorization: private-config-key'); });
    expect(() => bridge.getAvailableOfType('classifier')).toThrow('Specialized model availability is unavailable.');
    await expect(bridge.classify({ model: 'virtual-chat:classifier', input: 'x', labels: ['a'] }))
      .rejects.toThrow('Specialized model availability is unavailable.');
  });

  it('revalidates live availability and rejects credential channels, wrong kinds and malformed inputs before side effects', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    const classify = vi.spyOn(provider, 'classify');
    const bridge = new SpecializedModels(provider);
    for (const request of [
      { model: 'mock-image', input: 'x', labels: ['a'] },
      { model: 'virtual-chat:classifier', input: 'x', labels: ['a', 'a'] },
      { model: 'virtual-chat:classifier', input: 'x'.repeat(32_769), labels: ['a'] },
      { model: 'virtual-chat:classifier', input: 'x', labels: ['a'], apiKey: 'do-not-send' },
    ]) await expect(bridge.classify(request)).rejects.toThrow();
    expect(classify).not.toHaveBeenCalled();
    provider.setConfiguredModel('new-model');
    await expect(bridge.classify({ model: 'virtual-chat:classifier', input: 'x', labels: ['a'] })).rejects.toThrow('not available');
    expect(classify).not.toHaveBeenCalled();
  });

  it('bounds and validates native results and prevents network error/credential disclosure', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    const bridge = new SpecializedModels(provider);
    vi.spyOn(provider, 'classify').mockResolvedValue({ label: 'not-in-labels' });
    await expect(bridge.classify({ model: 'virtual-chat:classifier', input: 'x', labels: ['a'] })).rejects.toThrow('operation failed');
    vi.spyOn(provider, 'classify').mockRejectedValue(Object.assign(new Error('Authorization: secret-example'), { usage: { totalTokens: 999 } }));
    const failure = await bridge.classify({ model: 'virtual-chat:classifier', input: 'x', labels: ['a'] }).catch(error => error);
    expect(failure.usage).toBeUndefined();
    expect(failure.message).not.toContain('secret-example');
    vi.spyOn(provider, 'generateImages').mockRejectedValue(new Error('Authorization: secret-example'));
    await expect(bridge.generateImages({ model: 'mock-image', prompt: 'pixel' })).rejects.toThrow('Specialized model operation failed');
    for (const images of [[{ mediaType: 'image/svg+xml', data: png }], [{ mediaType: 'image/png', data: 'AAAA' }],
      [{ mediaType: 'image/png', data: `${png}garbage` }], Array(5).fill({ mediaType: 'image/png', data: png })]) {
      expect(() => validateGeneratedImages(images)).toThrow();
    }
    expect(() => validateGeneratedImages([{ mediaType: 'image/png', data: Buffer.concat([
      Buffer.from(png, 'base64'), Buffer.alloc(8 * 1024 * 1024),
    ]).toString('base64') }])).toThrow();
  });

  it('does not price missing or incomplete token usage as a free classification', async () => {
    const provider = new OpenAiProvider({ type: 'openai', apiKey: 'unused-fixture-key', model: 'gpt-4o-mini' });
    const execute = vi.spyOn(provider, 'classify');
    const bridge = new SpecializedModels(provider);
    for (const usage of [{}, { totalTokens: 4 }, { inputTokens: 4 }]) {
      execute.mockResolvedValue({ label: 'a', usage });
      const result = await bridge.classify({ model: 'gpt-4o-mini:classifier', input: 'x', labels: ['a'] });
      expect(result.usage?.costUsd).toBeUndefined();
    }
  });

  it('validates megabyte-scale base64 without recursive-regex stack exhaustion', () => {
    const data = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(1024 * 1024)]).toString('base64');
    expect(validateGeneratedImages([{ mediaType: 'image/png', data }])).toHaveLength(1);
    expect(() => validateGeneratedImages([{ mediaType: 'image/png', data: `${data}A` }])).toThrow();
  });

  it('bounds hooks and revalidates transformed requests and live model policy before dispatch', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    const execute = vi.spyOn(provider, 'classify');
    const request = { model: 'virtual-chat:classifier', input: 'x', labels: ['a'] };
    const transformed = new SpecializedModels(provider, undefined, async () => ({ ...request, apiKey: 'forbidden' }));
    await expect(transformed.classify(request)).rejects.toThrow('operation failed');
    expect(execute).not.toHaveBeenCalled();
    const revoked = new SpecializedModels(provider, undefined, async (_type, input) => {
      provider.setConfiguredModel('replacement'); return input;
    });
    await expect(revoked.classify(request)).rejects.toThrow('operation failed');
    expect(execute).not.toHaveBeenCalled();
    provider.setConfiguredModel('virtual-chat');
    const controller = new AbortController();
    const stalled = new SpecializedModels(provider, undefined, () => new Promise(() => {})).classify(request, { signal: controller.signal });
    controller.abort(); await expect(stalled).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('links cancellation even to uncooperative native implementations and ignores late results', async () => {
    const provider = new MockProvider({ type: 'mock', model: 'virtual-chat' });
    let received: AbortSignal | undefined;
    vi.spyOn(provider, 'classify').mockImplementation(async (_request, options) => {
      received = options?.signal; return new Promise(() => {});
    });
    const controller = new AbortController();
    const result = new SpecializedModels(provider).classify({ model: 'virtual-chat:classifier', input: 'x', labels: ['a'] }, { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(result).rejects.toThrow('cancelled');
    expect(received?.aborted).toBe(true);
  });

  it.each([
    ['openai', 'gpt-4o', 'openai'], ['azure', 'gpt-4o', 'openai'],
    ['anthropic', 'claude-3-haiku-20240307', 'anthropic'],
    ['google', 'gemini-2.0-flash', 'gemini'], ['vertex', 'gemini-2.0-flash', 'gemini'],
    ['bedrock', 'anthropic.claude-3-haiku-20240307-v1:0', 'bedrock'],
  ])('passes classifier text/images through the actual %s adapter payload', async (type, model, protocol) => {
    const response = protocol === 'openai' ? { choices: [{ message: { content: '{"label":"yes"}' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
      : protocol === 'anthropic' ? { content: [{ type: 'text', text: '{"label":"yes"}' }], usage: { input_tokens: 3, output_tokens: 1 } }
      : protocol === 'gemini' ? { candidates: [{ content: { parts: [{ text: '{"label":"yes"}' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }
      : { output: { message: { content: [{ text: '{"label":"yes"}' }] } }, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const provider = ProviderFactory.create({ type, model, apiKey: 'disposable-key',
        baseUrl: 'https://fixture.test/v1', accessKeyId: 'disposable-access', secretAccessKey: 'disposable-secret', projectId: 'fixture', location: 'us-central1' });
      const bridge = new SpecializedModels(provider);
      expect(bridge.getModelOfType('classifier')).toMatchObject({ imageInput: true, virtual: true });
      expect(await bridge.classify({ model: `${model}:classifier`, input: 'Is this a pixel?', labels: ['yes', 'no'], images: [{ mediaType: 'image/png', data: png }] }))
        .toMatchObject({ label: 'yes', usage: { totalTokens: 4 } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      if (protocol === 'openai') expect(body.messages.at(-1).content).toEqual([
        { type: 'text', text: 'Is this a pixel?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      ]);
      else if (protocol === 'anthropic') expect(body.messages.at(-1).content).toEqual([
        { type: 'text', text: 'Is this a pixel?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png }, cache_control: { type: 'ephemeral' } },
      ]);
      else if (protocol === 'gemini') expect(body.contents.at(-1).parts).toEqual([
        { text: 'Is this a pixel?' }, { inlineData: { mimeType: 'image/png', data: png } },
      ]);
      else expect(body.messages.at(-1).content).toEqual([
        { text: 'Is this a pixel?' }, { image: { format: 'png', source: { bytes: png } } },
      ]);
      expect(JSON.stringify(body)).not.toContain('disposable-key');
      const answers = { pixel: { value: true, probabilities: [{ value: true, probability: 0.9 }, { value: false, probability: 0.1 }] } };
      const questionResponse = JSON.parse(JSON.stringify(response));
      const content = JSON.stringify({ answers });
      if (protocol === 'openai') questionResponse.choices[0].message.content = content;
      else if (protocol === 'anthropic') questionResponse.content[0].text = content;
      else if (protocol === 'gemini') questionResponse.candidates[0].content.parts[0].text = content;
      else questionResponse.output.message.content[0].text = content;
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(questionResponse), { headers: { 'Content-Type': 'application/json' } }));
      expect(await bridge.classifyQuestions({ model: `${model}:classifier`, state: { pixel: true },
        questions: { pixel: { type: 'boolean', prompt: 'Is this a pixel?' } }, images: [{ mediaType: 'image/png', data: png }] }))
        .toMatchObject({ answers, usage: { totalTokens: 4 } });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const questionBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
      const parts = protocol === 'gemini' ? questionBody.contents.at(-1).parts : questionBody.messages.at(-1).content;
      expect(parts[0]).toEqual(protocol === 'openai' || protocol === 'anthropic' ? { type: 'text', text: '{"pixel":true}' } : { text: '{"pixel":true}' });
      expect(JSON.stringify(parts[1])).toContain(png);
    } finally { vi.unstubAllGlobals(); }
  });

  it('rechecks image capabilities and image-model availability after hooks without dispatch', async () => {
    const provider = new OpenAiProvider({ type: 'openai', model: 'gpt-4o', apiKey: 'fixture' });
    const classify = vi.spyOn(provider, 'classify');
    const original = provider.getSpecializedModels.bind(provider);
    const image = { mediaType: 'image/png' as const, data: png };
    const bridge = new SpecializedModels(provider, undefined, async (_type, request) => {
      vi.spyOn(provider, 'getSpecializedModels').mockReturnValue(original().map(item => ({ ...item, imageInput: false })));
      return { ...request, images: [image] };
    });
    await expect(bridge.classify({ model: 'gpt-4o:classifier', input: 'pixel', labels: ['yes'] })).rejects.toThrow('operation failed');
    expect(classify).not.toHaveBeenCalled();
    const generate = vi.spyOn(provider, 'generateImages');
    const revoked = new SpecializedModels(provider, undefined, async (_type, request) => {
      vi.spyOn(provider, 'validateConfig').mockReturnValue(false); return request;
    });
    await expect(revoked.generateImages({ model: 'dall-e-2', prompt: 'pixel' })).rejects.toThrow('operation failed');
    expect(generate).not.toHaveBeenCalled();
  });

  it('uses the ordinary bounded network/credential path for OpenAI images, never fetches returned URLs', async () => {
    const fetcher = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: png, url: 'https://never-fetch.test/private' }] }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const provider = new OpenAiProvider({ type: 'openai', model: 'gpt-4o', apiKey: 'disposable-test-key' });
      const bridge = new SpecializedModels(provider);
      expect(JSON.stringify(bridge.getModelsOfType('image'))).not.toContain('disposable-test-key');
      expect(await bridge.generateImages({ model: 'dall-e-2', prompt: 'pixel', size: '256x256' })).toMatchObject({ images: [{ data: png }] });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ model: 'dall-e-2', prompt: 'pixel', n: 1, size: '256x256', response_format: 'b64_json' });
      await expect(bridge.generateImages({ model: 'dall-e-3', prompt: 'pixel', count: 2 })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
