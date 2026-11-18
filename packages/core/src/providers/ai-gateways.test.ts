import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareAiGatewayProvider, VercelAiGatewayProvider, CLOUDFLARE_AI_GATEWAY_MODELS, VERCEL_AI_GATEWAY_MODELS,
  VERCEL_AI_GATEWAY_CLASSIFIER_MODELS, ProviderFactory } from './index.js';
import { captureNativeOutputBudget } from './provider-output-budget.js';
import { gatewayModels, gatewayProfile, gatewayUsage } from './ai-gateways.js';
import { SessionManager, JsonlSessionStore } from '../sessions/session-manager.js';
import type { Message } from '../types/index.js';

const key = 'synthetic-gateway-key';
const user = (): Message => ({ id: 'user', role: 'user', content: 'probe', timestamp: new Date(0) });
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function aEvents() { return [
  { type: 'message_start', message: { id: 'a', type: 'message', role: 'assistant', usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'visible', signature: 'opaque-a' } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'gateway-ok' } }, { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'echo', input: { x: 1 } } }, { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
]; }
async function fixture() {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const upgrades: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders }> = [];
  let incomplete = false, unsigned = false, grammar = false;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { upgrades.push({ url: request.url, headers: request.headers }); response.writeHead(426, { connection: 'close' }); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk; const body = JSON.parse(text);
    calls.push({ url: request.url, headers: request.headers, body });
    if (request.url?.endsWith('/systemone')) { response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ answers: { label: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } } }, usage: { input_tokens: 10, output_tokens: 2 } })); return; }
    let events: Array<Record<string, any>>;
    if (request.url?.endsWith('/chat/completions')) events = [
      { choices: [{ index: 0, delta: { content: 'gateway-ok', reasoning_content: 'visible' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 } } },
    ];
    else if (request.url?.endsWith('/responses')) {
      const output = [{ type: 'reasoning', id: 'rs-gateway', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: 'opaque-r' },
        { type: 'message', id: 'msg-gateway', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'gateway-ok', annotations: [] }] }];
      if (grammar) output.push({ type: 'custom_tool_call', id: 'ctc_gateway', call_id: 'grammar-call', name: 'echo', input: 'print(1)' } as any);
      events = [{ type: 'response.output_text.delta', delta: 'gateway-ok' }, { type: 'response.completed', response: { id: 'r', status: 'completed', model: body.model, output,
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 } } } }];
    } else { events = aEvents(); if (unsigned) delete events[1]!.content_block.signature; }
    if (incomplete) events.pop();
    response.setHeader('content-type', 'text/event-stream'); response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
      + (!incomplete && request.url?.endsWith('/chat/completions') ? 'data: [DONE]\n\n' : ''));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, upgrades, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned`,
    incomplete: () => { incomplete = true; }, unsigned: () => { unsigned = true; }, grammar: () => { grammar = true; } };
}
const cf = 'cloudflare-ai-gateway', vc = 'vercel-ai-gateway';
const cfA = CLOUDFLARE_AI_GATEWAY_MODELS.find(profile => profile.api === 'anthropic-messages')!.id;
const cfC = CLOUDFLARE_AI_GATEWAY_MODELS.find(profile => profile.compat.thinkingFormat === 'deepseek')!.id;
const cfPlainC = CLOUDFLARE_AI_GATEWAY_MODELS.find(profile => profile.api === 'openai-completions' && !profile.compat.thinkingFormat)!.id;
const cfR = CLOUDFLARE_AI_GATEWAY_MODELS.find(profile => profile.api === 'openai-responses' && profile.reasoning)!.id;
const cfPlainR = CLOUDFLARE_AI_GATEWAY_MODELS.find(profile => profile.api === 'openai-responses' && !profile.reasoning)!.id;
const vcA = 'alibaba/qwen-3-14b';
const vcAdaptive = VERCEL_AI_GATEWAY_MODELS.find(profile => profile.compat.forceAdaptiveThinking && profile.compat.supportsTemperature === false)!.id;

describe('explicit native AI gateways', () => {
  it('owns pinned private A/C/R and A/T declarations without discovery/factory or zero-price borrowing', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const cloud = new CloudflareAiGatewayProvider({ type: 'operator', apiKey: key, accountId: 'synthetic-account', gatewayId: 'synthetic-gateway' });
    const vercel = new VercelAiGatewayProvider({ type: 'operator-vercel', apiKey: key });
    expect(cloud.getPublishedModels()).toHaveLength(57); expect(vercel.getPublishedModels()).toHaveLength(245);
    expect(VERCEL_AI_GATEWAY_CLASSIFIER_MODELS).toHaveLength(6); expect(vercel.getSpecializedModels().filter(model => !model.virtual)).toHaveLength(6);
    for (const [gateway, hash] of [[cf, '388aefd2f1e5c5b0783673de1acda4a7ea8de853ebb5beeeede9646a90159a2a'], [vc, '06e7ea1513bdcd3697b1b71f2b42654f8529d2c4d1c67cba8849053c04735c54']] as const) {
      const bytes = await readFile(new URL(`./data/${gateway}.json`, import.meta.url)); expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
      const original = Object.values(JSON.parse(bytes.toString()) as Record<string, Record<string, any>>).flatMap(rows => Object.values(rows));
      for (const raw of original) { const profile = gatewayProfile(gateway, raw.id);
        expect(profile).toMatchObject({ api: raw.api, contextWindow: raw.contextWindow, declaredInput: raw.input, compat: raw.compat ?? {} });
        expect(profile.maxOutputTokens).toBe(raw.maxTokens); expect(profile.thinkingLevelMap).toEqual(raw.thinkingLevelMap);
        expect(profile.declaredInputLimits).toEqual(raw.inputLimits); expect(Object.isFrozen(profile)).toBe(true);
        if (Object.values(raw.cost).every(value => value === 0)) expect(profile.pricing).toBeUndefined();
      }
      expect(ProviderFactory.has(gateway)).toBe(false);
    }
    expect(await cloud.getAvailableModels()).toHaveLength(57); expect(cloud.canDiscoverModels()).toBe(false); expect(vercel.canDiscoverModels()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new CloudflareAiGatewayProvider({ type: cf, apiKey: key })).toThrow('account and gateway');
    expect(() => new VercelAiGatewayProvider({ type: vc, apiKey: key, model: 'unknown' })).toThrow('not supported');
    expect(() => new VercelAiGatewayProvider({ type: vc, apiKey: key, baseUrl: 'https://key@bad.test' })).toThrow('Invalid gateway');
  });

  it.each([[cf, cfA, '/anthropic/v1/messages'], [cf, cfC, '/compat/chat/completions'], [cf, cfPlainC, '/compat/chat/completions'],
    [cf, cfR, '/openai/responses'], [cf, cfPlainR, '/openai/responses'], [vc, vcA, '/v1/messages'], [vc, vcAdaptive, '/v1/messages']] as const)(
    'dispatches %s %s through its real API/auth and private effective policy', async (gateway, model, suffix) => {
      const { baseUrl, calls } = await fixture(), profile = gatewayProfile(gateway, model);
      const config = { type: 'logical-gateway', apiKey: key, baseUrl, model, transport: 'sse' as const, customHeaders: { 'X-Tenant': 'synthetic-tenant', 'x-api-key': 'forbidden-vendor-key' } };
      const provider = gateway === cf ? new CloudflareAiGatewayProvider(config) : new VercelAiGatewayProvider(config);
      const options = { model, thinking: 'high' as const, temperature: 0.5, maxTokens: model === cfPlainR ? 1 : 64, sessionId: 'gateway-session', cacheRetention: 'long' as const,
        tools: [{ name: 'echo', description: 'echo', parameters: { type: 'object' as const, properties: { x: { type: 'number' } } } }] };
      const result = await provider.chat([user()], options); expect(result).toMatchObject({ content: 'gateway-ok', provider: 'logical-gateway', api: profile.api, model, usage: { totalTokens: 12 } });
      const call = calls[0]!; expect(call.url).toBe(`/owned${suffix}`); expect(call.headers['x-tenant']).toBe('synthetic-tenant');
      if (gateway === cf) { expect(call.headers['cf-aig-authorization']).toBe(`Bearer ${key}`); expect(call.headers.authorization).toBeUndefined(); expect(call.headers['x-api-key']).toBeUndefined(); }
      else { expect(call.headers['x-api-key']).toBe(key); expect(call.headers.authorization).toBeUndefined(); expect(call.headers['cf-aig-authorization']).toBeUndefined(); }
      expect(JSON.stringify(call)).not.toContain('forbidden-vendor-key');
      if (profile.compat.sendSessionAffinityHeaders) expect(call.headers['x-session-affinity']).toBe('gateway-session');
      const prepared = captureNativeOutputBudget(provider)!({ ...options }, [user()]);
      expect(call.body[profile.api === 'openai-responses' ? 'max_output_tokens' : 'max_tokens']).toBe(prepared.maxTokens);
      if (profile.api === 'anthropic-messages') {
        expect(call.headers['anthropic-version']).toBe('2023-06-01'); expect(call.body.temperature).toBeUndefined();
        expect(call.body.thinking.type).toBe(profile.compat.forceAdaptiveThinking ? 'adaptive' : 'enabled'); expect(call.body.tools[0].strict).toBeUndefined();
        expect(call.body.tools[0].eager_input_streaming).toBe(true);
        if (model === vcA) {
          expect(call.body.max_tokens).toBe(16384); expect(call.body.thinking.budget_tokens).toBe(15360);
          expect(call.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
          const long = { ...user(), content: 'x'.repeat((profile.contextWindow - 4096 - 8) * 3.5) };
          await provider.chat([long], { maxTokens: 64, thinking: 'off' }); expect(calls.at(-1)!.body.max_tokens).toBe(8);
        }
      } else if (profile.api === 'openai-completions') {
        expect(call.body.store).toBeUndefined(); expect(call.body.max_completion_tokens).toBeUndefined(); expect(call.body.reasoning_effort).toBeUndefined();
        expect(call.body.tools[0].function.strict).toBe(false);
        if (profile.compat.thinkingFormat) expect(call.body.thinking).toEqual({ type: 'enabled' }); else expect(call.body.thinking).toBeUndefined();
      } else {
        expect(call.body.store).toBe(false); expect(call.body.prompt_cache_retention).toBe('24h'); expect(call.body.tools[0].strict).toBe(false);
        if (profile.reasoning) expect(call.body.include).toEqual(['reasoning.encrypted_content']); else { expect(call.body.reasoning).toBeUndefined(); expect(call.body.max_output_tokens).toBe(16); }
      }
    });

  it('probes only the configured gateway R WebSocket path/auth before its existing automatic SSE fallback', async () => {
    const { baseUrl, upgrades, calls } = await fixture();
    const provider = new CloudflareAiGatewayProvider({ type: cf, apiKey: key, baseUrl, model: cfR });
    expect((await provider.chat([user()])).content).toBe('gateway-ok');
    expect(upgrades).toHaveLength(1); expect(upgrades[0]!.url).toBe('/owned/openai/responses');
    expect(upgrades[0]!.headers['cf-aig-authorization']).toBe(`Bearer ${key}`); expect(upgrades[0]!.headers.authorization).toBeUndefined();
    expect(upgrades[0]!.headers['openai-beta']).toBeDefined(); expect(calls[0]!.url).toBe('/owned/openai/responses');
  });

  it.each([cfA, cfR])('replays %s only after private reload in the same endpoint/key/header/constructor scope', async model => {
    const { baseUrl, calls } = await fixture(), directory = await mkdtemp(path.join(os.tmpdir(), 'aih-gateway-replay-')); roots.push(directory);
    const config = { type: 'gateway-owner', apiKey: key, baseUrl, model, transport: 'sse' as const, customHeaders: { 'X-Tenant': 'synthetic-owner' } };
    const provider = new CloudflareAiGatewayProvider(config), result = await provider.chat([user()]);
    const manager = new SessionManager({ store: new JsonlSessionStore(directory) }); const session = await manager.create({ cwd: directory });
    await manager.addMessage(session.id, { role: 'assistant', content: result.content, blocks: result.blocks, toolCalls: result.toolCalls,
      model, provider: 'gateway-owner', api: result.api });
    const restored = new SessionManager({ store: new JsonlSessionStore(directory) }); await restored.loadAllSessions();
    const history = [user(), restored.get(session.id)!.messages[0]!, ...(result.toolCalls?.length ? [{ id: 'tool', role: 'tool' as const, content: 'echoed', timestamp: new Date(), toolCallId: result.toolCalls[0]!.id }] : [])];
    await new CloudflareAiGatewayProvider(config).chat(history);
    expect(JSON.stringify(calls.at(-1)!.body)).toContain(model === cfA ? 'opaque-a' : 'opaque-r');
    class Derived extends CloudflareAiGatewayProvider {}
    for (const peer of [new CloudflareAiGatewayProvider({ ...config, apiKey: 'synthetic-other' }), new CloudflareAiGatewayProvider({ ...config, baseUrl: baseUrl + '/other' }),
      new CloudflareAiGatewayProvider({ ...config, customHeaders: { 'x-tenant': 'synthetic-other' } }), new Derived(config)]) {
      await peer.chat(history); expect(JSON.stringify(calls.at(-1)!.body)).not.toMatch(/opaque-a|opaque-r|gateway-v1/);
    }
    expect(await readFile(path.join(directory, `${session.id}.jsonl`), 'utf8')).not.toContain(key);
  });

  it('keeps native gateway R grammar tools and paired image results on the shared codec without borrowing an original vendor profile', async () => {
    const { baseUrl, calls, grammar } = await fixture(); grammar();
    const provider = new CloudflareAiGatewayProvider({ type: cf, apiKey: key, baseUrl, model: cfR, transport: 'sse' });
    const options = { tools: [{ name: 'echo', description: 'Grammar echo', parameters: { type: 'object' as const, properties: { source: { type: 'string' } }, required: ['source'] },
      constrainedSampling: { type: 'grammar' as const, variants: { openai_regex: '.+' } } }] };
    const result = await provider.chat([user()], options);
    expect(calls[0]!.body.tools).toEqual([{ type: 'custom', name: 'echo', description: 'Grammar echo', format: { type: 'grammar', syntax: 'regex', definition: '.+' } }]);
    expect(result.toolCalls).toMatchObject([{ id: 'grammar-call|ctc_gateway', name: 'echo', input: { source: 'print(1)' } }]);
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    await provider.chat([user(), { id: 'answer', role: 'assistant', content: result.content, blocks: result.blocks, toolCalls: result.toolCalls,
      model: cfR, api: 'openai-responses', provider: cf, timestamp: new Date() },
      { id: 'tool', role: 'tool', content: 'pixel', blocks: [{ type: 'image', mediaType: 'image/png', url: image }], toolCallId: result.toolCalls![0]!.id, timestamp: new Date() }], options);
    expect(calls[1]!.body.input).toContainEqual(expect.objectContaining({ type: 'custom_tool_call', call_id: 'grammar-call', id: 'ctc_gateway', input: 'print(1)' }));
    expect(calls[1]!.body.input).toContainEqual({ type: 'custom_tool_call_output', call_id: 'grammar-call', output: [
      { type: 'input_text', text: 'pixel' }, { type: 'input_image', detail: 'auto', image_url: image } ] });
  });

  it('preserves native Vercel unsigned thinking as empty-signature thinking on owned replay', async () => {
    const { baseUrl, calls, unsigned } = await fixture(); unsigned();
    const config = { type: vc, apiKey: key, baseUrl, model: vcA }, first = await new VercelAiGatewayProvider(config).chat([user()]);
    const assistant: Message = { id: 'answer', role: 'assistant', content: first.content, blocks: first.blocks, toolCalls: first.toolCalls, api: first.api, provider: vc, model: vcA, timestamp: new Date() };
    await new VercelAiGatewayProvider(config).chat([user(), assistant, { id: 'tool', role: 'tool', content: 'ok', toolCallId: 'call-1', timestamp: new Date() }]);
    expect(calls.at(-1)!.body.messages.find((message: any) => message.role === 'assistant').content).toContainEqual({ type: 'thinking', thinking: 'visible', signature: '' });
  });

  it.each(['convaiinnovations/laya', 'typesafe-ai/jev'])('routes native Vercel System One %s without a chat alias or zero-price certificate', async model => {
    const { baseUrl, calls } = await fixture(), provider = new VercelAiGatewayProvider({ type: 'vercel-owned', apiKey: key, baseUrl });
    const result = await provider.classify({ model, input: 'probe', labels: ['yes', 'no'] }); expect(result).toMatchObject({ label: 'yes', usage: { totalTokens: 12 } });
    expect(calls[0]).toMatchObject({ url: '/owned/typesafe/v1/systemone', headers: { authorization: `Bearer ${key}` }, body: { model, state: { input: 'probe' } } });
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    if (model.endsWith('laya')) expect(result.usage?.costUsd).toBeUndefined(); else expect(result.usage?.costUsd).toBeCloseTo(0.00000042);
    await expect(provider.chat([user()], { model })).rejects.toThrow('Gateway request failed.');
  });

  it.each([cfA, cfC, cfR])('refuses incomplete %s transport before successful completion', async model => {
    const { baseUrl, incomplete } = await fixture(); incomplete(); const provider = new CloudflareAiGatewayProvider({ type: cf, apiKey: key, baseUrl, model, transport: 'sse' });
    const complete = vi.fn(), failed = vi.fn(); await provider.streamChat([user()], () => undefined, complete, failed);
    expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1);
  });

  it.each(['reader', 'callback'] as const)('retires owned gateway %s cancellation without successful completion', async phase => {
    let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), cancel = vi.fn(() => new Promise<never>(() => undefined));
    const prefix = [aEvents()[0], { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(prefix)); }, pull() { if (phase === 'reader') entered(); return new Promise<never>(() => undefined); }, cancel });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const provider = new CloudflareAiGatewayProvider({ type: cf, apiKey: key, accountId: 'synthetic-account', gatewayId: 'synthetic-gateway', model: cfA });
    const controller = new AbortController(), completed = vi.fn(), failed = vi.fn();
    const pending = provider.streamChat([user()], () => { if (phase === 'callback') entered(); return phase === 'callback' ? new Promise<never>(() => undefined) : undefined; }, completed, failed, { signal: controller.signal });
    await reached; controller.abort(); await pending; expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('uses gateway-owned tiers/disjoint cache counters and rejects malformed counters instead of reusing vendor prices', () => {
    const profile = gatewayProfile(cf, 'claude-haiku-5-5');
    expect(gatewayUsage(profile, { input_tokens: 100001, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 1 } }))
      .toMatchObject({ promptTokens: 100001, completionTokens: 2, totalTokens: 100009, costUsd: (100001 * 0.5 + 2 * 2.5 + 4 * 0.05 + 0.625 + 1) / 1e6 });
    expect(gatewayUsage(gatewayProfile(cf, cfC), { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } })).toBeUndefined();
    expect(gatewayModels(vc).filter(profile => !profile.pricing)).toHaveLength(6);
  });
});
