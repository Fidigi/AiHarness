import { describe, expect, it, vi } from 'vitest';
import { MockProvider, OpenAiProvider } from './index.js';
import { SpecializedModels, validateGeneratedImages } from './specialized-models.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';

describe('credential-private specialized model SDK', () => {
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
      await expect(bridge.generateImages({ model: 'dall-e-3', prompt: 'pixel', count: 2 })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
