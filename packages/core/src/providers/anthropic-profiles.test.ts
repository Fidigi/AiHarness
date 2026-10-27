import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type ChatOptions, type ChatResponse } from './index.js';
import type { Message } from '../types/index.js';
import { SessionManager } from '../sessions/session-manager.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { captureNativeOutputBudget, ProviderOutputBudgetError } from './provider-output-budget.js';
import { getProviderPublishedModels, getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels, PUBLISHED_THINKING_LEVELS, type PublishedThinkingLevel } from './model-metadata.js';

const bytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-reference.json', import.meta.url));
const pin = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-reference.json', import.meta.url), 'utf8'));
const profiles = Object.values(JSON.parse(bytes.toString())['anthropic-messages']) as Array<{
  id: string; name: string; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Partial<Record<PublishedThinkingLevel, string | null>>;
  compat?: { forceAdaptiveThinking?: boolean; supportsMidConvoEffort?: boolean; supportsTemperature?: boolean };
}>;
const adaptiveProfiles = profiles.filter(profile => profile.compat?.forceAdaptiveThinking && !profile.compat.supportsMidConvoEffort);
const managedProfiles = profiles.filter(profile => profile.compat?.supportsMidConvoEffort);
const numericProfiles = profiles.filter(profile => !profile.compat?.forceAdaptiveThinking && !profile.compat?.supportsMidConvoEffort);
const supported = (profile: typeof profiles[number]) => PUBLISHED_THINKING_LEVELS.filter(level =>
  profile.thinkingLevelMap?.[level] !== null && (!['xhigh', 'max'].includes(level) || profile.thinkingLevelMap?.[level] !== undefined));
// Independent expected native efforts, in published level order; sparse xhigh clamps upward.
const efforts: Record<string, readonly (string | undefined)[]> = {
  'claude-fable-5': ['low', 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': [undefined, 'low', 'low', 'medium', 'high', 'max', 'max'],
  'claude-opus-4-7': [undefined, 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': [undefined, 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': [undefined, 'low', 'low', 'medium', 'high', 'max', 'max'],
  'claude-sonnet-5': [undefined, 'low', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const input = [{ id: 'user', role: 'user' as const, content: 'probe', timestamp: new Date() }];
const observed = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4,
  cache_creation_input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 1 } };
afterEach(() => vi.restoreAllMocks());
function fixture(model: string, responseModel = 'untrusted-response-alias', Provider = AnthropicProvider) {
  const provider = new Provider({ type: 'operator-alias', model, apiKey: 'disposable-profile-key' });
  let usage: Record<string, unknown> = structuredClone(observed), delta: Record<string, unknown> | undefined, tool = false;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.stream) return new Response(JSON.stringify({ model: responseModel,
      content: [{ type: 'text', text: 'ok' }, ...(tool ? [{ type: 'tool_use', id: 'echo-call', name: 'echo', input: {} }] : [])], stop_reason: tool ? 'tool_use' : 'end_turn', usage }));
    return new Response([
      { type: 'message_start', message: { usage } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      ...(tool ? [{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'echo-call', name: 'echo' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }] : []),
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: delta ?? usage },
      { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const call = async (stream: boolean, retention: 'none' | 'short' | 'long' = 'short', options?: ChatOptions, messages: Message[] = input) => {
    if (!stream) return provider.chat(messages, { maxTokens: 64, cacheRetention: retention, ...options });
    let result: ChatResponse | undefined, failure: Error | undefined;
    await provider.streamChat(messages, () => {}, value => { result = value; }, error => { failure = error; },
      { maxTokens: 64, cacheRetention: retention, ...options });
    if (failure) throw failure; return result!;
  };
  return { provider, fetch, call, tool: (enabled: boolean) => { tool = enabled; }, usage: (value: Record<string, unknown>, next?: Record<string, unknown>) => { usage = value; delta = next; } };
}

describe('pinned original Anthropic metadata and observed accounting', () => {
  it('binds the independent seventeen-profile fixture to the approved catalogue hash', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.files.anthropic.catalogue);
    expect(profiles).toHaveLength(17);
    expect(adaptiveProfiles.map(profile => profile.id).sort()).toEqual(Object.keys(efforts).sort());
  });
  for (const profile of profiles) it(profile.id, async () => {
    const f = fixture(profile.id);
    const row = getProviderPublishedModel('unrelated-alias', profile.id, f.provider);
    expect(row).toMatchObject({ id: profile.id, name: profile.name, api: 'anthropic-messages',
      contextWindow: profile.contextWindow, maxOutputTokens: profile.maxTokens,
      pricing: { inputPerMillion: profile.cost.input, outputPerMillion: profile.cost.output,
        cacheReadPerMillion: profile.cost.cacheRead, cacheWritePerMillion: profile.cost.cacheWrite } });
    for (const stream of [false, true]) for (const retention of ['short', 'long'] as const) {
      const result = await f.call(stream, retention);
      expect(result.api).toBe('anthropic-messages'); expect(result.model).toBe(profile.id); expect(result.content).toBe('ok');
      expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3, totalTokens: 14 });
      expect(result.usage?.costUsd).toBeCloseTo((5 * profile.cost.input + 2 * profile.cost.output
        + 4 * profile.cost.cacheRead + 2 * profile.cost.cacheWrite + 2 * profile.cost.input) / 1e6, 12);
    }
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  for (const profile of profiles) it(`${profile.id}: enforces the owned output ceiling on SDK and preflight`, async () => {
    const f = fixture(profile.id), policy = captureNativeOutputBudget(f.provider)!;
    for (const maxTokens of [undefined, 1, profile.maxTokens]) {
      const options = { maxTokens }, expected = maxTokens ?? profile.maxTokens;
      const prepared = policy(options);
      expect(prepared.maxTokens).toBe(expected); expect(options).toEqual({ maxTokens });
      for (const stream of [false, true]) {
        await f.call(stream, 'short', options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.model).toBe(profile.id); expect(body.max_tokens).toBe(expected);
      }
    }
    const count = f.fetch.mock.calls.length;
    for (const value of [profile.maxTokens + 1, 0, -1, 0.5, Number.NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 1]) {
      const options = { maxTokens: value as number };
      expect(() => policy(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'short', options)).rejects.toThrow('Invalid Anthropic output limit.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  for (const profile of adaptiveProfiles) for (const [index, thinking] of PUBLISHED_THINKING_LEVELS.entries()) {
    it(`${profile.id}/${thinking}: owns adaptive wire policy without consuming numeric maps`, async () => {
      const f = fixture(profile.id), get = vi.fn(() => { throw new Error('UNUSED'); });
      const thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
      const options: ChatOptions = { thinking, thinkingBudgets, maxTokens: 64, temperature: 0.25 };
      const prepared = captureNativeOutputBudget(f.provider)!(options), effort = efforts[profile.id]![index];
      expect(prepared.maxTokens).toBe(64); expect(prepared.options.thinkingBudgets).toBe(thinkingBudgets);
      expect(getSupportedThinkingLevels('operator-alias', profile.id, undefined, f.provider)).toEqual(supported(profile));
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.model).toBe(profile.id); expect(body.max_tokens).toBe(prepared.maxTokens);
        expect(body.thinking).toEqual(effort ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' });
        expect(body.output_config).toEqual(effort ? { effort } : undefined);
        expect(body.temperature).toBe(effort || profile.compat?.supportsTemperature === false ? undefined : 0.25);
      }
      expect(get).not.toHaveBeenCalled(); expect(options).toEqual({ thinking, thinkingBudgets, maxTokens: 64, temperature: 0.25 });
      expect(Object.isFrozen(thinkingBudgets)).toBe(false);
    });
  }
  for (const profile of adaptiveProfiles) it(`${profile.id}: retains omitted thinking and uses published output defaults, rejects invalid levels before HTTP`, async () => {
    const f = fixture(profile.id), policy = captureNativeOutputBudget(f.provider)!;
    for (const thinking of [undefined, 'high', 'xhigh', 'max'] as const) {
      const options = { thinking, maxTokens: undefined, temperature: 0.25 };
      const maximum = profile.maxTokens;
      expect(policy(options).maxTokens).toBe(maximum);
      for (const stream of [false, true]) {
        await f.call(stream, 'short', options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.max_tokens).toBe(maximum);
        if (thinking === undefined) {
          expect(body.thinking).toBeUndefined(); expect(body.output_config).toBeUndefined();
          expect(body.temperature).toBe(profile.compat?.supportsTemperature === false ? undefined : 0.25);
        }
      }
    }
    const count = f.fetch.mock.calls.length;
    for (const thinking of [null, 'HIGH', 'fake', 1, {}]) {
      const options = { thinking: thinking as PublishedThinkingLevel };
      expect(() => policy(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'short', options)).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
  });
  for (const profile of numericProfiles) for (const thinking of [undefined, ...PUBLISHED_THINKING_LEVELS]) {
    it(`${profile.id}/${thinking}: owns numeric budgets and published output defaults`, async () => {
      const f = fixture(profile.id), options: ChatOptions = { thinking, maxTokens: undefined, temperature: 0.25 };
      const expectedBudget = thinking === undefined || thinking === 'off' ? undefined
        : ({ minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 } as const)[thinking];
      const prepared = captureNativeOutputBudget(f.provider)!(options);
      expect(prepared.maxTokens).toBe(profile.maxTokens);
      expect(getSupportedThinkingLevels('operator-alias', profile.id, undefined, f.provider)).toEqual(supported(profile));
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const [, init] = f.fetch.mock.calls.at(-1)!, body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBe(profile.maxTokens);
        expect(body.thinking).toEqual(expectedBudget === undefined ? thinking === 'off' ? { type: 'disabled' } : undefined
          : { type: 'enabled', budget_tokens: expectedBudget, display: 'summarized' });
        expect(body.temperature).toBe(expectedBudget === undefined ? 0.25 : undefined);
        expect(body.output_config).toBeUndefined();
        expect(new Headers(init?.headers).get('anthropic-beta')).toBe(expectedBudget === undefined ? null : 'interleaved-thinking-2025-05-14');
      }
      expect(options).toEqual({ thinking, maxTokens: undefined, temperature: 0.25 });
    });
  }
  for (const profile of numericProfiles) it(`${profile.id}: accepts minimal thinking with a small valid explicit answer allocation`, async () => {
    const f = fixture(profile.id), prepare = captureNativeOutputBudget(f.provider)!;
    // The pinned helper reserves 1024 only when reasoning reaches the total ceiling.
    for (const maxTokens of [1, 64]) {
      const options: ChatOptions = { maxTokens, thinking: 'minimal' }, prepared = prepare(options);
      expect(prepared.maxTokens).toBe(maxTokens + 1024);
      expect(prepare(prepared.options).maxTokens).toBe(maxTokens + 1024);
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.max_tokens).toBe(maxTokens + 1024);
        expect(body.thinking).toMatchObject({ budget_tokens: 1024 });
      }
      expect(options.maxTokens).toBe(maxTokens);
    }
  });
  for (const profile of numericProfiles) it(`${profile.id}: fits numeric answer room without double allocation or borrowing mutable metadata`, async () => {
    const f = fixture(profile.id), prepare = captureNativeOutputBudget(f.provider)!;
    const published = f.provider.getPublishedModels().find(row => row.id === profile.id)!;
    published.thinkingLevelMap!.high = 'off'; published.maxOutputTokens = Number.MAX_SAFE_INTEGER;
    for (const [maxTokens, high, maximum, budget] of [[64, undefined, 16448, 16384], [1, undefined, 16385, 16384],
      [64000, undefined, 64000, 16384], [64, 32000, 32064, 32000], [64, Number.MAX_SAFE_INTEGER, 64000, 62976], [64000, 0, 64000, 1024]] as const) {
      const options: ChatOptions = { maxTokens, thinking: 'high', ...(high === undefined ? {} : { thinkingBudgets: { high } }) };
      const prepared = prepare(options), again = prepare(prepared.options);
      expect(prepared.maxTokens).toBe(maximum); expect(again.maxTokens).toBe(maximum);
      for (const stream of [false, true]) {
        await f.call(stream, 'none', prepared.options);
        const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.max_tokens).toBe(maximum); expect(body.thinking).toMatchObject({ budget_tokens: budget });
      }
      expect(options.maxTokens).toBe(maxTokens); expect(options.thinkingBudgets?.high).toBe(high);
    }
    const count = f.fetch.mock.calls.length;
    for (const options of [{ maxTokens: 64, thinking: 'minimal', thinkingBudgets: { minimal: 1 } }, { maxTokens: 64, thinking: 'high', thinkingBudgets: { high: 0 } }]) {
      expect(() => prepare(options as ChatOptions)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'none', options as ChatOptions)).rejects.toThrow('Invalid Anthropic thinking allocation.');
    }
    for (const thinking of [null, 'PRIVATE-invalid', 1]) {
      const options = { thinking: thinking as PublishedThinkingLevel };
      expect(() => prepare(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'none', options)).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
    const get = vi.fn(() => { throw new Error('PRIVATE-unused'); }), thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
    for (const thinking of [undefined, 'off'] as const) {
      const options = prepare({ thinking, thinkingBudgets });
      await f.call(false, 'none', options.options);
    }
    expect(get).not.toHaveBeenCalled();
    expect(() => prepare({ thinking: 'high', thinkingBudgets })).toThrow(ProviderOutputBudgetError);
    expect(get).not.toHaveBeenCalled();
    class Compatible extends AnthropicProvider {}
    const compatible = fixture(profile.id, 'alias', Compatible);
    await compatible.call(false, 'none', { thinking: 'high' });
    const body = JSON.parse(String(compatible.fetch.mock.calls.at(-1)?.[1]?.body));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 }); expect(body.max_tokens).toBe(9216);
  });
  for (const profile of managedProfiles) for (const thinking of [undefined, ...PUBLISHED_THINKING_LEVELS]) {
    it(`${profile.id}/${thinking}: emits managed active effort, binding controls and native betas`, async () => {
      const f = fixture(profile.id), get = vi.fn(() => { throw new Error('UNUSED'); });
      const thinkingBudgets = Object.defineProperty({}, 'high', { enumerable: true, get });
      const levels = supported(profile), requested = thinking ?? 'high';
      const selected = levels.includes(requested) ? requested : levels.find(level => PUBLISHED_THINKING_LEVELS.indexOf(level) > PUBLISHED_THINKING_LEVELS.indexOf(requested))!;
      const effort = selected === 'minimal' ? 'low' : selected;
      const options = { thinking, thinkingBudgets, temperature: 0.25, maxTokens: 64 };
      const prepared = captureNativeOutputBudget(f.provider)!(options);
      expect(prepared.maxTokens).toBe(64); expect(prepared.options.thinkingBudgets).toBe(thinkingBudgets);
      expect(getSupportedThinkingLevels('operator-alias', profile.id, undefined, f.provider)).toEqual(levels);
      for (const stream of [false, true]) {
        const result = await f.call(stream, 'none', prepared.options);
        const [, init] = f.fetch.mock.calls.at(-1)!, body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
        expect(body.output_config).toEqual({ effort: 'high' }); expect(body.temperature).toBeUndefined();
        expect(body.messages).toEqual([{ role: 'user', content: 'probe' }, { role: 'system', content: [], output_config: { effort } }]);
        expect(new Headers(init?.headers).get('anthropic-beta')?.split(',')).toEqual(expect.arrayContaining([
          'mid-conversation-output-config-2026-07-01', 'thinking-binding-controls-2026-08-01',
        ]));
        expect(result.providerThinkingLevel).toBe(effort); expect(result.thinkingLevel).toBeUndefined(); expect(result.model).toBe(profile.id);
      }
      expect(get).not.toHaveBeenCalled(); expect(options.thinkingBudgets).toBe(thinkingBudgets);
    });
  }
  for (const profile of managedProfiles) it(`${profile.id}: replays only owned historical efforts and keeps tool pairs adjacent`, async () => {
    const f = fixture(profile.id), timestamp = new Date(0);
    const history: Message[] = [input[0],
      { id: 'assistant', role: 'assistant', content: 'prior', timestamp, provider: 'operator-alias', model: profile.id,
        api: 'anthropic-messages', metadata: { providerThinkingLevel: 'xhigh' }, toolCalls: [{ id: 'call', name: 'echo', input: {} }] },
      { id: 'tool', role: 'tool', content: 'result', timestamp, toolCallId: 'call' },
      { id: 'foreign-api', role: 'assistant', content: 'foreign-api', timestamp, provider: 'operator-alias', api: 'openai-responses', metadata: { providerThinkingLevel: 'max' } },
      { id: 'foreign-provider', role: 'assistant', content: 'foreign-provider', timestamp, provider: 'other', api: 'anthropic-messages', metadata: { providerThinkingLevel: 'max' } },
      { id: 'legacy', role: 'assistant', content: 'legacy', timestamp, provider: 'operator-alias', api: 'anthropic-messages', metadata: { providerThinkingLevel: 'PRIVATE-invalid' } },
      { id: 'logical', role: 'assistant', content: 'logical', timestamp, provider: 'operator-alias', model: profile.id,
        api: 'anthropic-messages', metadata: { thinkingLevel: 'high' } },
      { ...input[0], id: 'next' }];
    for (const stream of [false, true]) {
      await f.call(stream, 'none', { thinking: 'max' }, history);
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.messages.filter((message: { role: string }) => message.role === 'system')).toEqual([
        { role: 'system', content: [], output_config: { effort: 'xhigh' } },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ]);
      const assistant = body.messages.findIndex((message: { role: string }) => message.role === 'assistant');
      expect(body.messages[assistant + 1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] });
      expect(JSON.stringify(body)).not.toContain('PRIVATE-invalid');
    }
    expect(history[1].metadata).toEqual({ providerThinkingLevel: 'xhigh' });
    const count = f.fetch.mock.calls.length;
    for (const thinking of [null, 'PRIVATE-invalid', 1, {}]) {
      const options = { thinking: thinking as PublishedThinkingLevel };
      expect(() => captureNativeOutputBudget(f.provider)!(options)).toThrow(ProviderOutputBudgetError);
      for (const stream of [false, true]) await expect(f.call(stream, 'none', options)).rejects.toThrow('Invalid Anthropic thinking level.');
    }
    expect(f.fetch).toHaveBeenCalledTimes(count);
    class Compatible extends AnthropicProvider {}
    const compatible = fixture(profile.id, 'alias', Compatible);
    for (const stream of [false, true]) {
      await compatible.call(stream, 'none', { thinking: 'high' });
      const [, init] = compatible.fetch.mock.calls.at(-1)!, body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
      expect(body.output_config).toBeUndefined(); expect(new Headers(init?.headers).get('anthropic-beta')).toBeNull();
    }
  });
  it('persists physical managed effort on both tool and final responses for the next native turn', async () => {
    const f = fixture('claude-haiku-5-5'), manager = new SessionManager(), session = await manager.create({ title: 'Managed effort' });
    const registry = new ExtensionRegistry(), tools = [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }];
    await manager.addMessage(session.id, input[0]);
    await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: async () => ({ content: 'result' }) }));
    let turn = 0;
    try {
      await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'operator-alias', tools,
        toolContext: { sessionManager: manager, notify: () => {} }, streamTurn: async messages => {
          f.tool(turn === 0);
          return f.call(true, 'none', { thinking: turn++ === 0 ? 'max' : 'low', tools }, messages);
        } });
      const history = session.messages.filter(message => message.role === 'assistant');
      expect(history.map(message => message.metadata?.providerThinkingLevel)).toEqual(['max', 'low']);
      expect(history.map(message => message.metadata?.thinkingLevel)).toEqual([undefined, undefined]);
      expect(history.map(message => message.api)).toEqual(['anthropic-messages', 'anthropic-messages']);
      expect(history[0].toolCalls).toHaveLength(1); expect(history[1].toolCalls).toBeUndefined();
      const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body));
      expect(body.messages.filter((message: { role: string }) => message.role === 'system')).toEqual([
        { role: 'system', content: [], output_config: { effort: 'max' } }, { role: 'system', content: [], output_config: { effort: 'low' } },
      ]);
      registry.virtualModels.register({ provider: 'router', id: 'auto', maxOutputTokens: 64,
        route: () => ({ provider: 'operator-alias', id: 'claude-fable-5-1', thinkingLevel: 'minimal' }) });
      const routed = await streamProviderTurn({ provider: registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
        messages: input, tools: [], extensionRegistry: registry, resolveProvider: name => name === 'operator-alias' ? f.provider : undefined, maxRetries: 0 });
      expect(routed.providerThinkingLevel).toBe('low'); expect(routed.thinkingLevel).toBe('minimal');
      expect(routed.selection).toMatchObject({ provider: 'router', id: 'auto' });
    } finally { await registry.shutdown(); }
  });
  it('captures the adaptive dialect independently of public metadata, later model changes and derived transports', async () => {
    const f = fixture('claude-opus-4-7'), policy = captureNativeOutputBudget(f.provider)!;
    const row = getProviderPublishedModel('operator-alias', 'claude-opus-4-7', f.provider)!;
    row.thinkingLevelMap!.xhigh = 'not-an-effort'; row.thinkingLevelMap!.off = null;
    f.provider.setConfiguredModel('claude-haiku-4-5');
    for (const stream of [false, true]) {
      await f.call(stream, 'short', policy({ thinking: 'xhigh', maxTokens: 64 }).options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).output_config).toEqual({ effort: 'xhigh' });
      await f.call(stream, 'short', policy({ model: 'claude-haiku-4-5', thinking: 'high', maxTokens: 64 }).options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).thinking).toEqual({ type: 'enabled', budget_tokens: 16384, display: 'summarized' });
    }
    class Compatible extends AnthropicProvider {}
    for (const model of ['claude-opus-4-7', 'claude-opus-4-7-unverified']) {
      const derived = fixture(model, 'alias', model.endsWith('unverified') ? AnthropicProvider : Compatible);
      for (const stream of [false, true]) {
        await derived.call(stream, 'short', { thinking: 'xhigh', maxTokens: 64 });
        const body = JSON.parse(String(derived.fetch.mock.calls.at(-1)?.[1]?.body));
        expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 }); expect(body.output_config).toBeUndefined();
      }
    }
  });
  it('captures configured ceiling before model changes but honors explicit per-call models', async () => {
    const small = 'claude-haiku-4-5', large = 'claude-opus-5', f = fixture(small);
    const pinned = captureNativeOutputBudget(f.provider)!;
    f.provider.setConfiguredModel(large);
    expect(() => pinned({ maxTokens: 64001 })).toThrow(ProviderOutputBudgetError);
    expect(captureNativeOutputBudget(f.provider)!({ maxTokens: 64001 }).maxTokens).toBe(64001);
    expect(pinned({ model: large, maxTokens: 64001 }).maxTokens).toBe(64001);
    for (const stream of [false, true]) {
      await f.call(stream, 'short', { maxTokens: 64001 });
      await expect(f.call(stream, 'short', { model: small, maxTokens: 64001 })).rejects.toThrow('Invalid Anthropic output limit.');
      await expect(f.call(stream, 'short', { model: small, maxTokens: 64001, thinking: 'high' })).rejects.toThrow('Invalid Anthropic output limit.');
    }
    const row = getProviderPublishedModel('operator-alias', small, f.provider)!; row.maxOutputTokens = 999999;
    expect(() => pinned({ maxTokens: 64001 })).toThrow(ProviderOutputBudgetError);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid explicit caps before native numeric allocation can raise them', async () => {
    const f = fixture('claude-haiku-4-5'), policy = captureNativeOutputBudget(f.provider)!;
    const options = { maxTokens: 64, thinking: 'high' as const };
    expect(policy(options).maxTokens).toBe(16448);
    for (const stream of [false, true]) {
      await f.call(stream, 'short', options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).max_tokens).toBe(16448);
      await expect(f.call(stream, 'short', { maxTokens: 0, thinking: 'high' })).rejects.toThrow('Invalid Anthropic output limit.');
    }
    expect(() => policy({ maxTokens: 0, thinking: 'high' })).toThrow(ProviderOutputBudgetError);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not borrow ceilings by name for derived transports or unknown models', async () => {
    class Compatible extends AnthropicProvider {}
    const compatible = fixture('claude-haiku-4-5', 'alias', Compatible);
    expect(captureNativeOutputBudget(compatible.provider)).toBeUndefined();
    for (const stream of [false, true]) await compatible.call(stream, 'short', { maxTokens: 64001 });
    const unknown = fixture('claude-opus-5-unverified');
    expect(captureNativeOutputBudget(unknown.provider)!({ maxTokens: 128001 }).maxTokens).toBe(128001);
    for (const stream of [false, true]) await unknown.call(stream, 'short', { maxTokens: 128001 });
  });
  it('uses gross input at the Haiku 5.5 boundary, not output tokens or response aliases', async () => {
    const f = fixture('claude-haiku-5-5');
    for (const stream of [false, true]) for (const [inputTokens, read, write, price] of [
      [99993, 4, 3, 0.1], [99994, 4, 3, 0.5], [5, 4, 3, 0.1],
    ]) {
      f.usage({ input_tokens: inputTokens, output_tokens: 100001, cache_read_input_tokens: read, cache_creation_input_tokens: write });
      const result = await f.call(stream);
      expect(result.usage?.costUsd).toBeCloseTo((inputTokens * price + 100001 * price * 5 + read * price / 10 + write * price * 1.25) / 1e6, 12);
    }
  });
  it('retains nullable SSE snapshots and an explicit zero one-hour write count', async () => {
    const f = fixture('claude-opus-5');
    f.usage(structuredClone(observed), { input_tokens: null, output_tokens: 3, cache_read_input_tokens: null,
      cache_creation_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: 0 } });
    const result = await f.call(true, 'long');
    expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 3, totalTokens: 15 });
    expect(result.usage?.costUsd).toBeCloseTo((5 * 5 + 3 * 25 + 4 * 0.5 + 3 * 6.25) / 1e6, 12);
    f.usage({ ...observed, cache_creation: undefined });
    for (const stream of [false, true]) expect((await f.call(stream, 'long')).usage?.costUsd)
      .toBeCloseTo((5 * 5 + 2 * 25 + 4 * 0.5 + 3 * 6.25) / 1e6, 12);
  });
  it('does not manufacture complete usage from missing or malformed counters', async () => {
    const f = fixture('claude-fable-5');
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { ...observed, input_tokens: -1 },
      { ...observed, output_tokens: 0.5 }, { ...observed, cache_read_input_tokens: null },
      { ...observed, cache_creation: { ephemeral_1h_input_tokens: 4 } }]) {
      f.usage(invalid);
      for (const stream of [false, true]) expect((await f.call(stream)).usage).toBeUndefined();
    }
  });
  it('returns defensive owned rows without enabling additional paid warming or borrowing unknown-model limits', async () => {
    const f = fixture('claude-fable-5');
    const first = getProviderPublishedModels(f.provider)!;
    const native = first.filter(row => profiles.some(profile => profile.id === row.id)); expect(native).toHaveLength(17);
    expect(native.filter(row => row.promptCache).map(row => row.id)).toEqual(['claude-sonnet-4-6']);
    first.find(row => row.id === 'claude-fable-5')!.pricing!.inputPerMillion = 999;
    expect(getProviderPublishedModel('operator-alias', 'claude-fable-5', f.provider)?.pricing?.inputPerMillion).toBe(10);
    expect(getProviderPublishedModel('anthropic', 'claude-fable-5-unverified', f.provider)).toBeUndefined();
    expect(first.some(row => row.id === 'claude-3-haiku-20240307')).toBe(true);
    class CompatibilityProvider extends AnthropicProvider {}
    expect(new CompatibilityProvider({ type: 'custom', apiKey: 'disposable' }).getPublishedModels?.()).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
    const unknown = fixture('claude-fable-5-unverified', 'claude-opus-5');
    for (const stream of [false, true]) expect((await unknown.call(stream, 'long')).usage?.costUsd).toBeUndefined();
  });
});
