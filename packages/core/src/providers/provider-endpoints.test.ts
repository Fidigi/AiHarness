import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, GeminiProvider, OpenAiProvider, OpenAiResponsesProvider } from './index.js';
import { collectProviderModelCatalog, discoverProviderModelIds } from './model-catalog.js';
import { resolveProviderDiscoveryEndpoint } from './provider-endpoints.js';
import type { ProviderDialect } from '../types/index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function fixture(body: unknown = { data: [{ id: 'model-a' }] }) {
  const requests: Array<{ path: string; auth?: string; key?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, auth: request.headers.authorization, key: request.headers['x-api-key'] as string | undefined });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe('provider discovery endpoint resolution', () => {
  it('refuses native mixed OpenAI discovery without changing legacy Responses endpoint resolution', () => {
    expect(() => resolveProviderDiscoveryEndpoint('openai', 'https://example.test/proxy%2Fowned/v1/responses'))
      .toThrow('Provider does not support connection discovery.');
    expect(resolveProviderDiscoveryEndpoint('openai-responses', 'https://example.test/proxy%2Fowned/v1/responses'))
      .toBe('https://example.test/proxy%2Fowned/v1/models');
  });
  it('refuses native NVIDIA discovery instead of treating static profiles as a connection test', () => {
    expect(() => resolveProviderDiscoveryEndpoint('nvidia', 'https://example.test/proxy%2Fowned/v1/chat/completions'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses native Moonshot discovery instead of treating static profiles as a connection test', () => {
    expect(() => resolveProviderDiscoveryEndpoint('moonshot', 'https://example.test/proxy%2Fowned/v1/chat/completions'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses native Z.ai discovery instead of treating static profiles as a connection test', () => {
    expect(() => resolveProviderDiscoveryEndpoint('zai', 'https://example.test/proxy%2Fowned/v1/chat/completions'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses native Groq discovery instead of treating static profiles as a connection test', () => {
    expect(() => resolveProviderDiscoveryEndpoint('groq', 'https://example.test/proxy%2Fowned/v1/chat/completions'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses native DeepSeek discovery instead of treating static profiles as a connection test', () => {
    expect(() => resolveProviderDiscoveryEndpoint('deepseek', 'https://example.test/proxy%2Fowned/v1/chat/completions'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses native Cerebras discovery instead of treating a static profile list as a connection test', () => {
    expect(() => resolveProviderDiscoveryEndpoint('cerebras', 'https://example.test/proxy%2Fowned/v1/chat/completions'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses mixed Cloudflare discovery instead of interpreting the dialect as Google', () => {
    expect(() => resolveProviderDiscoveryEndpoint('cloudflare-workers-ai', 'https://example.test/accounts/owned/ai/v1'))
      .toThrow('Provider does not support connection discovery.');
  });
  it('refuses mixed OpenRouter discovery instead of interpreting the dialect as Google', () => {
    expect(() => resolveProviderDiscoveryEndpoint('openrouter', 'https://example.test/api/v1/messages'))
      .toThrow('Provider does not support connection discovery.');
  });
  it.each<[ProviderDialect, string, string]>([
    ['openai-completions', '/gateway/v1/chat/completions///', '/gateway/v1/models'],
    ['openai-responses', '/gateway/v1/responses', '/gateway/v1/models'],
    ['openai-completions', '/gateway/models', '/gateway/models'],
    ['anthropic', '/gateway', '/gateway/v1/models'],
    ['anthropic', '/gateway/v1/', '/gateway/v1/models'],
    ['anthropic', '/gateway/v1/messages', '/gateway/v1/models'],
    ['google', '/gateway/v1beta/models/gemini:generateContent', '/gateway/v1beta/models'],
  ])('resolves %s without losing base path', (dialect, input, expected) => {
    expect(resolveProviderDiscoveryEndpoint(dialect, `https://example.test${input}`)).toBe(`https://example.test${expected}`);
  });
  it.each(['https://user:secret@example.test/v1', 'https://example.test/v1?token=secret', 'https://example.test/#secret', 'file:///private', 'invalid'])('refuses unsafe endpoint without reflection', input => {
    expect(() => resolveProviderDiscoveryEndpoint('openai-completions', input)).toThrow('Invalid provider endpoint.');
  });
  it('uses real based-path HTTP fixtures without API-key gating or synthetic auth', async () => {
    const { base, requests } = await fixture();
    const providers = [
      new OpenAiProvider({ type: 'openai', baseUrl: `${base}/gateway/v1/chat/completions` }),
      new OpenAiResponsesProvider({ type: 'openai', baseUrl: `${base}/gateway/v1/responses` }),
      new AnthropicProvider({ type: 'anthropic', baseUrl: `${base}/gateway/v1/messages` }),
    ];
    for (const provider of providers) {
      expect(provider.canDiscoverModels()).toBe(true);
      expect(await provider.getAvailableModels()).toEqual(['model-a']);
    }
    expect(requests).toEqual(Array.from({ length: 3 }, () => ({ path: '/gateway/v1/models', auth: undefined, key: undefined })));
    const catalog = await collectProviderModelCatalog(new Map([['custom', providers[0]!]]), { retries: 0 });
    expect(catalog[0]?.models).toContainEqual(expect.objectContaining({ id: 'model-a', source: 'discovered', available: false }));
  });
  it('discovers Google without an empty key query and deduplicates bounded untrusted IDs', async () => {
    const { base, requests } = await fixture({ models: [
      { name: 'models/gemini-a' }, { name: 'models/gemini-a' }, { name: 'models/bad\nsecret' }, { name: 12 },
    ] });
    const provider = new GeminiProvider({ type: 'google', baseUrl: `${base}/proxy/v1beta/models/gemini:generateContent` });
    expect(await provider.getAvailableModels()).toEqual(['gemini-a']);
    expect(requests[0]?.path).toBe('/proxy/v1beta/models');
  });
  it('bounds real HTTP remote catalogues and request lifetimes', async () => {
    const { base } = await fixture({ data: Array.from({ length: 601 }, (_, index) => ({ id: `model-${index}` })) });
    const provider = new OpenAiProvider({ type: 'openai', baseUrl: `${base}/prefix/v1/responses`, requestTimeoutMs: 100, providerMaxRetries: 0 });
    expect(await discoverProviderModelIds(provider, { retries: 0 })).toHaveLength(500);
    const stalled = createServer(() => { /* Intentionally never return response headers. */ });
    servers.push(stalled);
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve));
    const hung = new OpenAiProvider({ type: 'openai', baseUrl: `http://127.0.0.1:${(stalled.address() as AddressInfo).port}/prefix/v1`,
      requestTimeoutMs: 100, providerMaxRetries: 0 });
    const started = Date.now();
    await expect(hung.getAvailableModels()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('never reflects a failed remote body', async () => {
    const server = createServer((_request, response) => { response.writeHead(401); response.end('private-secret-url-and-token'); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = new OpenAiProvider({ type: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    await expect(provider.getAvailableModels()).rejects.toThrow('Model discovery failed (401).');
  });
});
