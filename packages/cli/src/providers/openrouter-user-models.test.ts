import { afterEach, expect, it, vi } from 'vitest';
import { collectProviderModelCatalog, OpenRouterProvider, ProviderFactory, MockProvider } from '@ai-harness/core';
import { createConfiguredProviders, resolveStartupProvider } from './configured-providers.js';
const c = 'openai/gpt-4o', a = 'anthropic/claude-haiku-4.5', base = 'https://synthetic-cli-router.test/proxy', key = 'synthetic-cli-router-key';
afterEach(() => vi.restoreAllMocks());
it('personalizes only foreground native OpenRouter selection with real effective C body and usage, not passive catalogues', async () => {
  const providers = createConfiguredProviders({ OPENROUTER_API_KEY: key, OPENROUTER_BASE_URL: base }), fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`);
    if (String(url).endsWith('/models/user')) { expect(String(url)).toBe(base + '/v1/models/user'); return Response.json({ data: [{ id: c, top_provider: { context_length: 5000, max_completion_tokens: 64 }, pricing: { prompt: '0.000003', completion: '0.000015' } }] }); }
    expect(JSON.parse(String(init?.body)).max_completion_tokens).toBe(64); return Response.json({ choices: [{ message: { role: 'assistant', content: 'cli-user-models' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  });
  await collectProviderModelCatalog(providers, { discover: false }); expect(fetcher).not.toHaveBeenCalled();
  const selected = await resolveStartupProvider(providers, { model: `openrouter/${c}` }, {}); expect(selected.provider).toBeInstanceOf(OpenRouterProvider); expect(selected.provider.getPublishedModels?.()).toMatchObject([{ id: c, contextWindow: 5000, maxOutputTokens: 64 }]);
  expect(await selected.provider.chat([])).toMatchObject({ content: 'cli-user-models', usage: { totalTokens: 10, costUsd: 0.000054 } }); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('starts glob scopes with the invocation key and proxy instead of borrowing the stored-key catalogue or limits', async () => {
  const providers = createConfiguredProviders({ OPENROUTER_API_KEY: key, OPENROUTER_BASE_URL: base }), native = providers.get('openrouter') as OpenRouterProvider;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { expect(String(url)).toBe(base + '/v1/models/user'); const fresh = new Headers(init?.headers).get('authorization') === 'Bearer synthetic-invocation-key'; return Response.json({ data: [{ id: fresh ? a : c, top_provider: { context_length: fresh ? 7000 : 5000, max_completion_tokens: fresh ? 128 : 64 } }] }); });
  await native.refreshUserModels(); const selected = await resolveStartupProvider(providers, { models: ['openrouter/*'], apiKey: 'synthetic-invocation-key' }, {});
  expect(selected.model).toBe(a); expect(selected.provider).not.toBe(native); expect(selected.provider.getPublishedModels?.()).toMatchObject([{ id: a, contextWindow: 7000, maxOutputTokens: 128 }]); expect(fetcher).toHaveBeenCalledTimes(2);
  const cold = await resolveStartupProvider(createConfiguredProviders({}), { model: `openrouter/${a}`, apiKey: 'synthetic-invocation-key' }, { OPENROUTER_BASE_URL: base }); expect(cold.model).toBe(a); expect(cold.provider.getPublishedModels?.()).toMatchObject([{ id: a, contextWindow: 7000 }]); expect(fetcher).toHaveBeenCalledTimes(3);
});
it('does not query a stored key before an invocation key when provider glob syntax cannot be prebound', async () => {
  const providers = createConfiguredProviders({ OPENROUTER_API_KEY: key, OPENROUTER_BASE_URL: base }); providers.delete('local');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { expect(String(url)).toBe(base + '/v1/models/user'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-invocation-key'); return Response.json({ data: [{ id: a, top_provider: { max_completion_tokens: 128 } }] }); });
  const selected = await resolveStartupProvider(providers, { models: ['*openrouter/*'], apiKey: 'synthetic-invocation-key' }, {}); expect(selected.model).toBe(a); expect(selected.provider.getPublishedModels?.()).toMatchObject([{ id: a, maxOutputTokens: 128 }]); expect(fetcher).toHaveBeenCalledOnce();
});
it('rejects key-excluded exact/scoped chat selection while keeping offline cold declarations passive', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [] }));
  for (const selection of [{ model: `openrouter/${c}` }, { models: ['openrouter/*'] }]) { const providers = createConfiguredProviders({ OPENROUTER_API_KEY: key }); providers.delete('local'); await expect(resolveStartupProvider(providers, selection, {})).rejects.toThrow(); } expect(fetcher).toHaveBeenCalledTimes(2); fetcher.mockClear();
  for (const selection of [{ model: `openrouter/${c}` }, { models: [`openrouter/${c}`] }]) expect((await resolveStartupProvider(createConfiguredProviders({}), { ...selection, apiKey: key, offline: true }, {})).model).toBe(c); expect(fetcher).not.toHaveBeenCalled();
});
it('does not discover unrelated scopes or promote a factory label into native user-catalogue authority', async () => {
  const providers = createConfiguredProviders({ OPENROUTER_API_KEY: key }), fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected catalogue request'));
  providers.delete('local'); // Isolate this new hook from the existing broad scope collector's local discovery.
  await resolveStartupProvider(providers, { models: ['mock/*'] }, {}); expect(fetcher).not.toHaveBeenCalled();
  const unregister = ProviderFactory.register('openrouter', config => new MockProvider(config));
  try { await resolveStartupProvider(createConfiguredProviders({ OPENROUTER_API_KEY: key }), { provider: 'openrouter', model: 'factory-model' }, {}); expect(fetcher).not.toHaveBeenCalled(); }
  finally { unregister(); }
});
it('links foreground catalogue discovery to caller retirement and refuses late selection publication', async () => {
  const providers = createConfiguredProviders({ OPENROUTER_API_KEY: key }); let release!: (response: Response) => void, entered!: () => void, cancelled = 0;
  const held = new Promise<Response>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; }); vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { entered(); return held; });
  const caller = new AbortController(), pending = resolveStartupProvider(providers, { model: `openrouter/${c}` }, {}, undefined, { signal: caller.signal }).catch(error => error); await ready; caller.abort(); expect(await pending).toBeInstanceOf(Error);
  release(new Response(new ReadableStream({ cancel() { cancelled++; } }))); await vi.waitFor(() => expect(cancelled).toBe(1));
});
