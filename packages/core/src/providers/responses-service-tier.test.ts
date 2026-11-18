import { afterEach, expect, it, vi } from 'vitest';
import { AzureProvider, OpenAiMixedProvider, OpenAiResponsesProvider, type AiProvider, type ChatResponse, type Message } from '../../dist/index.js';
const input: Message[] = [{ id: 'u', role: 'user', content: 'tier probe', timestamp: new Date(0) }];
const config = (model: string) => ({ type: 'operator-tier', model, apiKey: 'synthetic-tier-key', baseUrl: 'https://tier.synthetic/v1', transport: 'sse' as const });
let tier: unknown, gross = 20;
const bodies: Array<Record<string, unknown>> = [];
function mock() {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const response = { id: 'tier-response', status: 'completed', model: 'untrusted-price-alias', ...(tier === undefined ? {} : { service_tier: tier }), usage: { input_tokens: gross, output_tokens: 4, total_tokens: gross + 4, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 } }, output: [{ id: 'm', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'tier-ready', annotations: [] }] }] };
    return new Response('data: ' + JSON.stringify({ type: 'response.created', response: { id: response.id, service_tier: 'priority' } }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }); vi.stubGlobal('fetch', fetch); return fetch;
}
async function call(provider: AiProvider, stream: boolean, model?: string): Promise<ChatResponse> {
  const options = { ...(model ? { model } : {}), maxTokens: 64 };
  if (!stream) return provider.chat(input, options);
  let result: ChatResponse | undefined; const error = vi.fn(); await provider.streamChat(input, () => {}, value => { result = value; }, error, options); expect(error).not.toHaveBeenCalled(); expect(result).toBeDefined(); return result!;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); bodies.length = 0; gross = 20; tier = undefined; });
it('prices observed native OpenAI terminal service tiers after ordinary disjoint accounting on JSON requests/SSE chat/stream without selecting a paid tier', async () => {
  mock(); const saved = structuredClone(input);
  for (const model of ['gpt-5.4', 'gpt-5.5']) {
    const provider = new OpenAiMixedProvider(config(model)), base = model === 'gpt-5.5' ? 0.000183 : 0.0000915;
    for (tier of [undefined, 'default', 'auto', 'flex', 'priority', 'fast', 'operator-future-tier']) for (const stream of [false, true]) {
      const result = await call(provider, stream), factor = tier === 'flex' ? 0.5 : tier === 'priority' || tier === 'fast' ? model === 'gpt-5.5' ? 2.5 : 2 : 1;
      expect(result).toMatchObject({ model, usage: { promptTokens: 12, completionTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2, totalTokens: 24 } }); expect(result.usage?.costUsd).toBeCloseTo(base * factor, 12);
      expect(bodies.at(-1)).not.toHaveProperty('service_tier'); expect(result).not.toHaveProperty('serviceTier');
    }
  }
  expect(input).toEqual(saved);
});
it('uses captured per-call OpenAI identity and the reconciled gross-context tariff before the observed tier multiplier, not response aliases or created events', async () => {
  mock(); gross = 272001; tier = 'flex'; const provider = new OpenAiMixedProvider(config('gpt-5.5'));
  for (const stream of [false, true]) {
    const result = await call(provider, stream, 'gpt-5.4'); expect(result.model).toBe('gpt-5.4');
    expect(result.usage).toMatchObject({ promptTokens: 271993, completionTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2, totalTokens: 272005 });
    expect(result.usage?.costUsd).toBeCloseTo((271993 * 5 + 4 * 22.5 + 6 * 0.5) / 1e6 * 0.5, 12);
  }
});
it('keeps Azure and generic compatible Responses independent of first-party OpenAI service-tier pricing', async () => {
  mock(); tier = 'priority';
  for (const provider of [new AzureProvider(config('gpt-5.4')), new OpenAiResponsesProvider(config('gpt-5.4'))]) for (const stream of [false, true]) {
    const result = await call(provider, stream); expect(result.usage?.totalTokens).toBe(24);
    if (provider instanceof AzureProvider) expect(result.usage?.costUsd).toBeCloseTo(0.0000915, 12); else expect(result.usage?.costUsd).toBeUndefined();
    expect(bodies.at(-1)).not.toHaveProperty('service_tier');
  }
});
