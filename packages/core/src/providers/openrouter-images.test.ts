import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterImagesProvider, OPENROUTER_IMAGE_MODELS, OpenAiProvider } from './index.js';
import { SpecializedModelError, SpecializedModels } from './specialized-models.js';
import { runCodemode } from '../tools/codemode.js';
import type { ExtensionRuntimeContext } from '../extensions/extension-registry.js';

const model = 'google/gemini-2.5-flash-image';
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' };
const input = [{ type: 'text' as const, text: 'A pixel' }, { type: 'image' as const, ...image }];
const usage = { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } };
const payload = () => ({ id: 'image-response', usage, choices: [{ message: { content: 'A pixel.', images: [{ image_url: { url: `data:image/png;base64,${image.data}` } }] } }] });
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply: (response: import('node:http').ServerResponse) => void = response => response.end(JSON.stringify(payload()))) {
  const calls: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    calls.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(text) });
    response.setHeader('content-type', 'application/json'); reply(response);
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Ftenant/api/v1`;
  const provider = new OpenRouterImagesProvider({ type: 'operator-images', apiKey: 'disposable-images', baseUrl });
  return { provider, calls, baseUrl };
}

describe('native OpenRouter images', () => {
  it('publishes 61 owned pinned image profiles without advertising chat, ambient availability or free unknown images', async () => {
    const { provider, calls } = await fixture();
    const models = new SpecializedModels(provider).getModelsOfType('image');
    expect(models).toHaveLength(61); expect(OPENROUTER_IMAGE_MODELS).toHaveLength(61);
    expect(models.find(row => row.id === model)).toMatchObject({ name: 'Google: Nano Banana (Gemini 2.5 Flash Image)', imageInput: true,
      api: 'openrouter-images', pricing: { inputPerMillion: 0.3, outputPerMillion: 2.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0.083333 } });
    expect(models.find(row => row.id === 'openrouter/auto')?.pricing).toBeUndefined();
    expect(models.find(row => row.id === 'inclusionai/ming-image-0.1-design')?.imageInput).not.toBe(true);
    models.find(row => row.id === model)!.pricing!.inputPerMillion = 999;
    expect(provider.getSpecializedModels().find(row => row.id === model)?.pricing?.inputPerMillion).toBe(0.3);
    expect(Object.isFrozen(OPENROUTER_IMAGE_MODELS[0])).toBe(true); expect(Object.isFrozen(OPENROUTER_IMAGE_MODELS[0].input)).toBe(true);
    expect(provider.getConfiguredModel()).toBeUndefined(); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi(model)).toBe('openrouter-images'); expect(new SpecializedModels(provider).getModelsOfType('classifier')).toEqual([]);
    await expect(provider.chat([])).rejects.toThrow('OpenRouter images is image-only.');
    expect(new OpenAiProvider({ type: 'openrouter' }).getModelApi()).toBe('openai-completions');
    expect(calls).toEqual([]); expect(JSON.stringify(models)).not.toMatch(/disposable|proxy/);
  });

  it('sends ordered native text/image parts and profile-owned modalities and retains response text/id/cache prices', async () => {
    const { provider, calls, baseUrl } = await fixture();
    const request = { model, input: structuredClone(input) };
    const pending = provider.generateNativeImages(request); request.input[0] = { type: 'text', text: 'Late' };
    const result = await pending;
    expect(result).toMatchObject({ api: 'openrouter-images', provider: 'operator-images', model, stopReason: 'stop', responseId: 'image-response',
      output: [{ type: 'text', text: 'A pixel.' }, { type: 'image', ...image }],
      usage: { inputTokens: 70, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 102 } });
    expect(result.usage?.costUsd).toBeCloseTo((70 * 0.3 + 2 * 2.5 + 20 * 0.03 + 10 * 0.083333) / 1e6, 12);
    expect(calls[0]).toEqual({ url: '/proxy%2Ftenant/api/v1/chat/completions', authorization: 'Bearer disposable-images', body: {
      model, messages: [{ role: 'user', content: [{ type: 'text', text: 'A pixel' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } }] }],
      stream: false, modalities: ['image', 'text'],
    } });
    const configured = new OpenRouterImagesProvider({ type: 'operator-images', apiKey: 'disposable-images', baseUrl: baseUrl + '/chat/completions/', model: 'black-forest-labs/flux-3-image' });
    await configured.generateNativeImages({ model: 'black-forest-labs/flux-3-image', input: [{ type: 'text', text: 'A\ud800 pixel \ud83d\ude80' }] });
    expect(calls[1].body).toMatchObject({ modalities: ['image'], messages: [{ content: [{ type: 'text', text: 'A pixel 🚀' }] }] });
  });

  it('clears malformed output atomically, retains billed usage and never follows remote image URLs', async () => {
    let body: unknown = payload();
    const { provider, calls } = await fixture(response => response.end(JSON.stringify(body)));
    const invalid = [undefined, [], [{ image_url: 'https://never-fetch.test/private?key=disposable-images' }],
      [{ image_url: `data:image/svg+xml;base64,${image.data}` }], [{ image_url: 'data:image/png;base64,AAAA' }],
      Array(5).fill({ image_url: `data:image/png;base64,${image.data}` })];
    for (const images of invalid) {
      body = { ...payload(), choices: [{ message: { images } }], error: 'private disposable-images' };
      const result = await provider.generateNativeImages({ model, input });
      expect(result).toMatchObject({ output: [], stopReason: 'error', errorMessage: 'Invalid OpenRouter image response.', usage: { totalTokens: 102 } });
      expect(JSON.stringify(result)).not.toMatch(/private|disposable|never-fetch/);
    }
    body = { ...payload(), choices: [{ message: { content: 'Caption only.' } }] };
    expect((await provider.generateNativeImages({ model, input })).output).toEqual([{ type: 'text', text: 'Caption only.' }]);
    expect(calls).toHaveLength(invalid.length + 1);
  });

  it('bridges bounded SDK/guest image results and attributes decoded image failures once without publishing store/images', async () => {
    let multiple = false;
    const { provider, calls } = await fixture(response => { const body = payload(); if (multiple) body.choices[0].message.images.push(body.choices[0].message.images[0]); response.end(JSON.stringify(body)); });
    const sdk = new SpecializedModels(provider);
    expect(await sdk.generateImages({ model, prompt: 'Pixel' })).toMatchObject({ images: [image], usage: { totalTokens: 102 } });
    multiple = true;
    const error = await sdk.generateImages({ model, prompt: 'Pixel' }).catch(error => error);
    expect(error).toBeInstanceOf(SpecializedModelError); expect(error.usage?.totalTokens).toBe(102); expect(Object.isFrozen(error.usage)).toBe(true);
    const failed = await runCodemode({ code: `store('bad',true); await models.generateImages({model:${JSON.stringify(model)},prompt:'Pixel'})`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(failed.isError).toBe(true); expect(failed.blocks).toBeUndefined(); expect(failed.details?.store).toBeUndefined();
    expect(failed.details).toMatchObject({ costComplete: true, usage: { totalTokens: 102 }, nestedCalls: [{ kind: 'image', state: 'failed', usage: { totalTokens: 102 } }] });
    expect(failed.details?.nestedCalls).toHaveLength(1);
    multiple = false;
    const success = await runCodemode({ code: `const r=await models.generateImages({model:${JSON.stringify(model)},prompt:'Pixel'}); await image(r.images[0]); store('shown',true);`,
      context: { provider } as ExtensionRuntimeContext, tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(success.isError).toBe(false); expect(success.blocks).toEqual([{ type: 'image', mediaType: 'image/png', url: `data:image/png;base64,${image.data}` }]);
    expect(success.details).toMatchObject({ costComplete: true, store: { shown: true }, nestedCalls: [{ kind: 'image', state: 'completed' }] });
    expect(calls).toHaveLength(4);
  });

  it('uses explicit safe credentials/endpoints and owned bounded inputs, refusing unsupported controls before I/O', async () => {
    const { provider, calls, baseUrl } = await fixture();
    for (const bad of ['ftp://host/api/v1', 'https://user:private@host/api/v1', 'https://host/api/v1?private=key', 'https://host/api/v1#private'])
      expect(() => new OpenRouterImagesProvider({ type: 'openrouter', apiKey: 'disposable', baseUrl: bad })).toThrow('Invalid OpenRouter images endpoint.');
    vi.stubEnv('OPENROUTER_API_KEY', 'private-ambient');
    for (const apiKey of [undefined, 'private\0key', 'private\nkey', 'private💥key']) {
      const invalid = new OpenRouterImagesProvider({ type: 'openrouter', baseUrl, apiKey }); expect(invalid.validateConfig()).toBe(false);
      expect((await invalid.generateNativeImages({ model, input })).errorMessage).toBe('OpenRouter image generation failed.');
    }
    const headers = new OpenRouterImagesProvider({ type: 'openrouter', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } });
    expect((await headers.generateNativeImages({ model, input })).errorMessage).toBe('OpenRouter image generation failed.');
    let evaluated = 0; const getter = { model, get input() { evaluated++; throw new Error('private'); } };
    expect((await provider.generateNativeImages(getter)).stopReason).toBe('error'); expect(evaluated).toBe(0);
    for (const input of [[], Array(5).fill({ type: 'image', ...image }), [{ type: 'text', text: 'x'.repeat(32769) }]])
      expect((await provider.generateNativeImages({ model, input } as never)).stopReason).toBe('error');
    expect((await provider.generateNativeImages({ model: 'inclusionai/ming-image-0.1-design', input })).stopReason).toBe('error');
    for (const controls of [{ count: 2 }, { size: '1024x1024' as const }]) await expect(provider.generateImages({ model, prompt: 'Pixel', ...controls })).rejects.toThrow('Image model or options are not supported.');
    expect(calls).toEqual([]);
  });

  it('keeps unknown/zero-fallback prices and incomplete usage unknown, and cancels held reads without invented accounting', async () => {
    let raw: unknown = { prompt_tokens: 10 };
    const { provider, baseUrl } = await fixture(response => response.end(JSON.stringify({ ...payload(), usage: raw })));
    expect((await provider.generateNativeImages({ model, input })).usage).toEqual({ inputTokens: 10 });
    raw = { prompt_tokens: 10, completion_tokens: 2 };
    const unknown = new OpenRouterImagesProvider({ type: 'openrouter', apiKey: 'disposable', baseUrl, model: 'future-image' });
    expect((await unknown.generateNativeImages({ model: 'future-image', input: [{ type: 'text', text: 'Pixel' }] })).usage?.costUsd).toBeUndefined();
    expect((await provider.generateNativeImages({ model: 'openrouter/auto', input })).usage?.costUsd).toBeUndefined();
    raw = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } };
    expect((await provider.generateNativeImages({ model, input })).usage).toEqual({ outputTokens: 2, totalTokens: 12 });
    raw = { prompt_tokens: 10, completion_tokens: 2 };
    const unpriced = await runCodemode({ code: `await models.generateImages({model:'openrouter/auto',prompt:'Pixel'})`, context: { provider } as ExtensionRuntimeContext,
      tools: () => [], execute: async () => { throw new Error('Unexpected tool'); } });
    expect(unpriced.isError).toBe(false); expect(unpriced.details?.costComplete).toBe(false); expect(unpriced.details?.usage?.costUsd).toBeUndefined();
    const withdrawn = new AbortController(); withdrawn.abort();
    expect((await provider.generateNativeImages({ model, input }, { signal: withdrawn.signal })).stopReason).toBe('aborted');
    const controller = new AbortController(); const held = await fixture(response => { response.write('{"choices":'); controller.abort(); });
    const cancelled = await held.provider.generateNativeImages({ model, input }, { signal: controller.signal });
    expect(cancelled).toMatchObject({ output: [], stopReason: 'aborted', errorMessage: 'OpenRouter image request cancelled.' }); expect(cancelled.usage).toBeUndefined();
    const decoded = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { decoded.abort(); return payload(); } } as Response)));
    expect(await provider.generateNativeImages({ model, input }, { signal: decoded.signal })).toMatchObject({ output: [], stopReason: 'aborted', usage: { totalTokens: 102 } });
  });
});
