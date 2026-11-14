import { afterEach, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../index.js';
const c = 'openai/gpt-4o', a = 'anthropic/claude-haiku-4.5', base = 'https://synthetic-router.test/regional', key = 'synthetic-user-model-key';
afterEach(() => vi.restoreAllMocks());
it('filters only native chat and uses personalized context/output/pricing tiers on actual C wire and usage', async () => {
  const provider = new OpenRouterProvider({ type: 'router-user', baseUrl: base, apiKey: key }), native = provider.getSpecializedModels().filter(model => !model.virtual);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const headers = new Headers(init?.headers); expect(headers.get('authorization')).toBe(`Bearer ${key}`);
    if (String(url).endsWith('/models/user')) { expect(String(url)).toBe(base + '/v1/models/user'); expect(init?.redirect).toBe('manual'); return Response.json({ data: [{ id: c, context_length: 1000000, top_provider: { context_length: 262144, max_completion_tokens: 32768 }, pricing: { prompt: '0.000003', completion: '0.000015', overrides: [{ min_prompt_tokens: 100, prompt: '0.000006', completion: '0.000030' }] } }] }); }
    expect(String(url)).toBe(base + '/v1/chat/completions'); const body = JSON.parse(String(init?.body)); expect(body.max_completion_tokens).toBe(20000); expect(body.max_tokens).toBeUndefined(); return Response.json({ choices: [{ message: { role: 'assistant', content: 'personalized' }, finish_reason: 'stop' }], usage: { prompt_tokens: 101, completion_tokens: 2 } });
  });
  expect(await provider.refreshUserModels()).toEqual([c]); expect(await provider.getAvailableModels()).toEqual([c]); expect(provider.getPublishedModels()).toMatchObject([{ id: c, contextWindow: 262144, maxOutputTokens: 32768, pricing: { inputPerMillion: 3, outputPerMillion: 15 } }]); expect(provider.getSpecializedModels().filter(model => !model.virtual)).toEqual(native);
  expect(await provider.chat([{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }], { model: c, maxTokens: 20000 })).toMatchObject({ content: 'personalized', usage: { totalTokens: 103, costUsd: 0.000666 } });
  await expect(provider.chat([], { model: a })).rejects.toThrow(); await expect(provider.chat([], { model: c, maxTokens: 32769 })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('applies personalized A default cap and cache/long-cache prices without changing physical headers or thinking policy', async () => {
  const provider = new OpenRouterProvider({ type: 'router-a', apiKey: key, baseUrl: base, model: a });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/models/user')) return Response.json({ data: [{ id: a, top_provider: { max_completion_tokens: 1024 }, pricing: { prompt: '0.000004', completion: '0.000020', input_cache_read: '0.0000004', input_cache_write: '0.000005' } }] });
    expect(String(url)).toBe(base + '/v1/messages'); expect(new Headers(init?.headers).get('x-api-key')).toBe(key); const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ max_tokens: 1024, thinking: { type: 'disabled' } });
    return Response.json({ content: [{ type: 'text', text: 'personal-a' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 1 } } });
  });
  await provider.refreshUserModels(); expect(await provider.chat([], { thinking: 'off' })).toMatchObject({ api: 'anthropic-messages', usage: { totalTokens: 13, costUsd: 0.0000854 } });
});
it('captures effective pricing per SSE operation rather than reusing a later refresh during awaited callbacks', async () => {
  const provider = new OpenRouterProvider({ type: 'router-stream', apiKey: key }); let refreshes = 0, refreshed = false, result: Awaited<ReturnType<OpenRouterProvider['chat']>> | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/models/user')) return Response.json({ data: [{ id: c, pricing: { prompt: refreshes++ ? '0.000009' : '0.000003', completion: '0.000015' } }] });
    expect(JSON.parse(String(init?.body)).stream).toBe(true); return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'stream-price' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  await provider.refreshUserModels(); await provider.streamChat([], async () => { if (!refreshed) { refreshed = true; await provider.refreshUserModels(); } }, value => { result = value; }, error => { throw error; });
  expect(result?.usage).toMatchObject({ totalTokens: 10, costUsd: 0.000054 }); expect(provider.getPublishedModels()[0].pricing?.inputPerMillion).toBe(9);
});
it('keeps unknown account prices unknown and rejects malformed refresh atomically without manufacturing limits', async () => {
  const provider = new OpenRouterProvider({ type: 'router-unknown', apiKey: key }), fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/models/user')) return Response.json({ data: [{ id: c, context_length: 0, top_provider: { context_length: null, max_completion_tokens: 0 }, pricing: { prompt: '-1', completion: '-1' } }] });
    const body = JSON.parse(String(init?.body)); expect(body.max_tokens).toBeUndefined(); expect(body.max_completion_tokens).toBeUndefined();
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'unknown-price' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  });
  await provider.refreshUserModels(); expect(provider.getPublishedModels()[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 16384 }); expect(provider.getPublishedModels()[0].pricing).toBeUndefined(); expect((await provider.chat([])).usage?.costUsd).toBeUndefined();
  fetcher.mockResolvedValueOnce(Response.json({ data: {} })); await expect(provider.refreshUserModels()).rejects.toThrow(); expect(await provider.getAvailableModels()).toEqual([c]);
});
it.each([401, 403, 404])('keeps the declaration catalogue rather than inventing access when user endpoint returns %s', async status => {
  const provider = new OpenRouterProvider({ type: 'router-fallback', apiKey: key }), before = await provider.getAvailableModels(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status })).mockResolvedValueOnce(Response.json({ data: [{ id: c }] }));
  expect(await provider.refreshUserModels()).toEqual([c]); expect(await provider.refreshUserModels()).toEqual(before); expect(await provider.getAvailableModels()).toEqual(before); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('keeps known-empty chat authoritative while preserving native image/classifier services and passive getters', async () => {
  const provider = new OpenRouterProvider({ type: 'router-empty', apiKey: key }), native = provider.getSpecializedModels().filter(model => !model.virtual), fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
  expect(await provider.refreshUserModels()).toEqual([]); expect(await provider.getAvailableModels()).toEqual([]); expect(provider.getPublishedModels()).toEqual([]); expect(provider.getConfiguredModel()).toBeUndefined(); expect(provider.getSpecializedModels()).toEqual(native); await expect(provider.chat([])).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
});
it('uses catalogue-sized JSON bounds while keeping malformed/oversized responses atomic and releasing their body', async () => {
  const provider = new OpenRouterProvider({ type: 'router-bounds', apiKey: key }), fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ id: c, description: 'x'.repeat(300000) }] }));
  expect(await provider.refreshUserModels()).toEqual([c]); let cancelled = 0;
  fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } })); await expect(provider.refreshUserModels()).rejects.toThrow(); await vi.waitFor(() => expect(cancelled).toBe(1));
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([0xff]))); await expect(provider.refreshUserModels()).rejects.toThrow(); expect(await provider.getAvailableModels()).toEqual([c]);
});
it('does not let a cancelled overlapping refresh revoke an independent refresh or leak its late body', async () => {
  const provider = new OpenRouterProvider({ type: 'router-concurrent', apiKey: key }); let releaseA!: (response: Response) => void, releaseB!: (response: Response) => void, first!: () => void, second!: () => void, calls = 0, cancelled = 0;
  const heldA = new Promise<Response>(resolve => { releaseA = resolve; }), heldB = new Promise<Response>(resolve => { releaseB = resolve; }), readyA = new Promise<void>(resolve => { first = resolve; }), readyB = new Promise<void>(resolve => { second = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { if (calls++ === 0) { first(); return heldA; } second(); return heldB; });
  const pendingA = provider.refreshUserModels().catch(error => error); await readyA; const preaborted = new AbortController(); preaborted.abort(); await expect(provider.refreshUserModels({ signal: preaborted.signal })).rejects.toThrow(); const caller = new AbortController(), pendingB = provider.refreshUserModels({ signal: caller.signal }).catch(error => error); await readyB; caller.abort(); expect(await pendingB).toBeInstanceOf(Error);
  releaseA(Response.json({ data: [{ id: c }] })); expect(await pendingA).toEqual([c]); releaseB(new Response(new ReadableStream({ cancel() { cancelled++; } }))); await vi.waitFor(() => expect(cancelled).toBe(1)); expect(await provider.getAvailableModels()).toEqual([c]);
  let releaseOld!: (response: Response) => void; const old = new Promise<Response>(resolve => { releaseOld = resolve; }); vi.mocked(fetch).mockReturnValueOnce(old).mockResolvedValueOnce(Response.json({ data: [{ id: a }] }));
  const stale = provider.refreshUserModels().catch(error => error); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); expect(await provider.refreshUserModels()).toEqual([a]); releaseOld(Response.json({ data: [{ id: c }] })); expect(await stale).toBeInstanceOf(Error); expect(await provider.getAvailableModels()).toEqual([a]);
});
it('does not apply another key/header scope and refuses stale discovery publication after I/O', async () => {
  const headers = { 'x-tenant': 'synthetic-first' }, provider = new OpenRouterProvider({ type: 'router-scope', apiKey: key, baseUrl: base, customHeaders: headers }); let release!: (value: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; }); vi.spyOn(globalThis, 'fetch').mockReturnValue(held); const pending = provider.refreshUserModels().catch(error => error); headers['x-tenant'] = 'synthetic-other'; release(Response.json({ data: [{ id: c }] })); expect(await pending).toBeInstanceOf(Error);
});
