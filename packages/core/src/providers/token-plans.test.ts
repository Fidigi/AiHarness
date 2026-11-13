import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QwenTokenPlanProvider, QwenTokenPlanCnProvider, QwenTokenPlanIndividualProvider,
  XiaomiTokenPlanAmsProvider, XiaomiTokenPlanCnProvider, XiaomiTokenPlanSgpProvider, ZaiCodingCnProvider,
  TOKEN_PLAN_MODELS, TOKEN_PLAN_BASE_URLS, type Message } from '../index.js';
import type { AiProvider, ChatResponse } from './index.js';

const adapters = [
  ['qwen-token-plan', QwenTokenPlanProvider], ['qwen-token-plan-cn', QwenTokenPlanCnProvider],
  ['qwen-token-plan-individual', QwenTokenPlanIndividualProvider], ['xiaomi-token-plan-ams', XiaomiTokenPlanAmsProvider],
  ['xiaomi-token-plan-cn', XiaomiTokenPlanCnProvider], ['xiaomi-token-plan-sgp', XiaomiTokenPlanSgpProvider],
  ['zai-coding-cn', ZaiCodingCnProvider],
] as const;
const user: Message = { id: 'user', role: 'user', content: 'Hello', timestamp: new Date(0) };
const tool = { name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } };
afterEach(() => vi.restoreAllMocks());

function reply(stream: boolean, tools = false): Response {
  const message = { content: tools ? 'working' : 'done', reasoning_content: 'consider',
    ...(tools ? { tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"file"}' } }] } : {}) };
  return stream ? new Response([
    { choices: [{ index: 0, delta: { ...message, ...(tools ? { tool_calls: message.tool_calls!.map(call => ({ ...call, index: 0 })) } : {}) } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    : Response.json({ choices: [{ message, finish_reason: tools ? 'tool_calls' : 'stop' }], usage });
}
async function invoke(provider: AiProvider, stream: boolean, messages: Message[], options = {}) {
  if (!stream) return provider.chat(messages, options);
  let result: ChatResponse | undefined;
  await provider.streamChat(messages, () => {}, response => { result = response; }, error => { throw error; }, options);
  expect(result).toBeDefined(); return result!;
}

describe('explicit native regional/token-plan C integrations', () => {
  it.each(adapters)('%s matches its independently pinned catalogue without free-price or vendor policy inference', async (plan, Adapter) => {
    const reference = JSON.parse(await readFile(new URL(`../../../../tests/fixtures/token-plans/${plan}.json`, import.meta.url), 'utf8')) as Record<string, Record<string, {
      id: string; name: string; api: string; provider: string; baseUrl: string; contextWindow: number; maxTokens: number;
      input: string[]; reasoning: boolean; thinkingLevelMap?: object; inputLimits?: object; cost: Record<string, number>;
    }>>;
    const rows = Object.values(reference['openai-completions']!), provider = new Adapter({ type: 'operator-owned', apiKey: 'synthetic-plan' });
    expect(await provider.getAvailableModels()).toEqual(rows.map(row => row.id));
    expect(provider.canDiscoverModels()).toBe(false); expect(provider.getModelApi()).toBe('openai-completions');
    expect(TOKEN_PLAN_BASE_URLS[plan]).toBe(rows[0]!.baseUrl);
    expect(provider.getPublishedModels()).toEqual(rows.map(row => ({ id: row.id, name: row.name, api: row.api,
      contextWindow: row.contextWindow, maxOutputTokens: row.maxTokens,
      ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
      ...(Object.values(row.cost).some(value => value > 0) ? { pricing: { inputPerMillion: row.cost.input, outputPerMillion: row.cost.output,
        cacheReadPerMillion: row.cost.cacheRead, cacheWritePerMillion: row.cost.cacheWrite } } : {}),
      capabilities: { reasoning: row.reasoning, imageInput: row.input.includes('image'), toolCalls: true } })));
    for (const row of rows) {
      expect(row.provider).toBe(plan);
      expect(TOKEN_PLAN_MODELS[plan].find(profile => profile.id === row.id)).toMatchObject({ declaredInput: row.input });
      expect(TOKEN_PLAN_MODELS[plan].find(profile => profile.id === row.id)?.declaredInputLimits).toEqual(row.inputLimits);
    }
    expect(provider.getPublishedModels().filter(row => row.pricing)).toHaveLength(plan === 'zai-coding-cn' ? 3 : 0);
    expect(() => provider.setConfiguredModel('future/private')).toThrow('Token-plan chat model is not supported.');
  });

  it.each(adapters)('%s uses exact plan endpoints, useful tools/plain replay and unknown pricing through both facades', async (plan, Adapter) => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push({ url: String(url), headers: new Headers(init?.headers), body });
      return reply(body.stream === true, calls.length % 2 === 1);
    });
    const provider = new Adapter({ type: 'operator-owned', apiKey: 'synthetic-plan' }), model = provider.getConfiguredModel()!;
    const options = { model, maxTokens: 64, thinking: 'high' as const, systemPrompt: 'Follow instructions', cacheRetention: 'none' as const, tools: [tool] };
    const original = structuredClone({ user, options });
    for (const stream of [false, true]) {
      const first = await invoke(provider, stream, [user], options);
      expect(first).toMatchObject({ content: 'working', provider: 'operator-owned', api: 'openai-completions', model,
        toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'file' } }], usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12 } });
      const pricing = TOKEN_PLAN_MODELS[plan].find(row => row.id === model)!.pricing;
      if (pricing) expect(first.usage?.costUsd).toBe((6 * pricing.inputPerMillion + 2 * pricing.outputPerMillion + 4 * pricing.cacheReadPerMillion) / 1000000);
      else expect(first.usage).not.toHaveProperty('costUsd');
      expect(first.blocks).toContainEqual({ type: 'reasoning', text: 'consider', thinkingSignature: 'reasoning_content' });
      const assistant: Message = { id: 'assistant', role: 'assistant', timestamp: new Date(0), content: first.content,
        provider: first.provider, model: first.model, api: first.api, blocks: first.blocks, toolCalls: first.toolCalls };
      await invoke(provider, stream, [user, assistant, { id: 'result', role: 'tool', timestamp: new Date(0), content: 'output', toolCallId: 'read-1', name: 'read' }], options);
      const replay = calls.at(-1)!.body.messages;
      expect(replay).toContainEqual({ role: 'assistant', content: 'working', reasoning_content: 'consider',
        tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"file"}' } }] });
      expect(replay).toContainEqual({ role: 'tool', tool_call_id: 'read-1', content: 'output' });
    }
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const call of calls) {
      expect(call.url).toBe(TOKEN_PLAN_BASE_URLS[plan] + '/chat/completions');
      expect(call.headers.get('authorization')).toBe('Bearer synthetic-plan'); expect(call.headers.has('x-api-key')).toBe(false);
      expect(call.body.model).toBe(model); expect(call.body.tools[0].function.strict).toBe(false);
      expect(call.body).not.toHaveProperty('prompt_cache_key'); expect(call.body).not.toHaveProperty('prompt_cache_retention');
      if (plan.startsWith('qwen-')) {
        expect(call.body.enable_thinking).toBe(true); expect(call.body).not.toHaveProperty('thinking'); expect(call.body).not.toHaveProperty('store');
        expect(call.body.max_completion_tokens).toBe(64); expect(call.body.messages[0].role).toBe('system');
      } else if (plan.startsWith('xiaomi-')) {
        expect(call.body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high', store: false, max_completion_tokens: 64 });
        expect(call.body.messages[0].role).toBe('developer');
      } else {
        expect(call.body).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false }, tool_stream: true, max_tokens: 64 });
        expect(call.body).not.toHaveProperty('reasoning_effort'); expect(call.body.messages[0].role).toBe('system');
      }
    }
    expect({ user, options }).toEqual(original);
  });

  it.each([
    ['qwen-token-plan', 'qwen3.8-flash', 'high', 'xhigh'],
    ['qwen-token-plan-cn', 'deepseek-v4-flash', 'off', 'high'],
    ['qwen-token-plan-individual', 'glm-5.2', 'off', 'high'],
    ['xiaomi-token-plan-cn', 'mimo-v2.5', 'off', undefined],
    ['zai-coding-cn', 'glm-5.3', 'off', 'low'],
  ] as const)('%s/%s keeps its effort/off exceptions and explicit long cache', async (plan, model, thinking, effort) => {
    const Adapter = adapters.find(([id]) => id === plan)![1];
    const provider = new Adapter({ type: 'operator', apiKey: 'synthetic', model, baseUrl: 'http://127.0.0.1/owned' });
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { body = JSON.parse(String(init?.body)); return reply(false); });
    await provider.chat([user], { thinking, cacheRetention: 'long', sessionId: 'é'.repeat(70) });
    expect(body.reasoning_effort).toBe(effort); expect(body.prompt_cache_key).toBe('é'.repeat(64)); expect(body.prompt_cache_retention).toBe('24h');
    expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens');
    if (plan.startsWith('qwen-')) expect(body.enable_thinking).toBe(true);
    else expect(body.thinking).toMatchObject({ type: effort ? 'enabled' : 'disabled' });
  });

  it.each(adapters)('%s refuses invalid models/caps/unsupported images and opaque replay before transport', async (plan, Adapter) => {
    const provider = new Adapter({ type: 'operator', apiKey: 'synthetic' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not send'));
    await expect(provider.chat([user], { model: 'future/private' })).rejects.toThrow('Token-plan chat model is not supported.');
    for (const maxTokens of [0, -1, NaN, Number.MAX_SAFE_INTEGER]) await expect(provider.chat([user], { maxTokens })).rejects.toThrow('Invalid token-plan output limit.');
    const text = TOKEN_PLAN_MODELS[plan].find(row => !row.declaredInput.includes('image'))!;
    await expect(provider.chat([{ ...user, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] }], { model: text.id }))
      .rejects.toThrow('Token-plan model does not support images.');
    await expect(provider.chat([{ id: 'opaque', timestamp: new Date(0), role: 'assistant', content: 'visible', provider: 'operator', model: provider.getConfiguredModel(),
      api: 'openai-completions', blocks: [{ type: 'reasoning', text: 'thought', thinkingSignature: 'opaque' }] }])).rejects.toThrow('Opaque token-plan replay is not supported.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not admit a derived constructor into private replay and does not replay foreign opaque fields', async () => {
    class Derived extends QwenTokenPlanProvider {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => reply(JSON.parse(String(init?.body)).stream === true));
    const derived = await new Derived({ type: 'operator', apiKey: 'synthetic' }).chat([user]);
    expect(derived.blocks?.some(block => block.type === 'reasoning' && block.thinkingSignature)).not.toBe(true);
    let body: Record<string, any> = {};
    vi.mocked(fetch).mockImplementation(async (_url, init) => { body = JSON.parse(String(init?.body)); return reply(false); });
    const provider = new QwenTokenPlanProvider({ type: 'operator', apiKey: 'synthetic' });
    await provider.chat([{ id: 'foreign', timestamp: new Date(0), role: 'assistant', provider: 'foreign', api: 'openai-completions', model: provider.getConfiguredModel(), content: 'visible',
      blocks: [{ type: 'reasoning', text: 'foreign thought', thinkingSignature: 'opaque' }, { type: 'text', text: 'visible' }] }]);
    expect(JSON.stringify(body.messages)).not.toContain('opaque'); expect(JSON.stringify(body.messages)).toContain('foreign thought');
  });

  it('requires successful terminal authority and awaits completion without exposing remote errors', async () => {
    const provider = new QwenTokenPlanProvider({ type: 'operator', apiKey: 'synthetic', providerMaxRetries: 0 });
    const done = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"prefix"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await expect(provider.streamChat([user], () => {}, done)).rejects.toThrow('Invalid token-plan response.'); expect(done).not.toHaveBeenCalled();
    for (const delta of [{ refusal: 'private-refusal', content: 'must-not-publish' }, { content: { private: 'not-text' } }, { reasoning: {} }]) {
      vi.mocked(fetch).mockResolvedValue(new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
      const chunk = vi.fn();
      await expect(provider.streamChat([user], chunk, done)).rejects.toThrow('Invalid token-plan response.');
      expect(chunk).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
    }
    vi.mocked(fetch).mockResolvedValue(reply(true));
    await expect(provider.streamChat([user], () => {}, async () => { throw new Error('private-completion'); })).rejects.toThrow('Token-plan request failed.');
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: 'private-remote' } }, { status: 400 }));
    await expect(provider.chat([user])).rejects.toThrow('Token-plan request failed.');
  });

  it('cancels the common C stream before terminal publication', async () => {
    const provider = new QwenTokenPlanProvider({ type: 'operator', apiKey: 'synthetic' }), controller = new AbortController(), done = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(true));
    await expect(provider.streamChat([user], () => { controller.abort(); }, done, undefined, { signal: controller.signal })).rejects.toThrow('Token-plan request aborted.');
    expect(done).not.toHaveBeenCalled();
  });
});
