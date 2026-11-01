import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, BedrockProvider, MockProvider, type ChatOptions } from './index.js';
import { applyAnthropicThinking, applyNativeAnthropicOutputPolicy, prepareAnthropicOutputBudget } from './anthropic-thinking.js';
import { captureNativeConfiguredModel, captureNativeOutputBudget, ProviderOutputBudgetError, registerNativeOutputBudget } from './provider-output-budget.js';
import { ExtensionRegistry, type BeforeProviderData } from '../extensions/extension-registry.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import type { Message } from '../types/index.js';

const numeric = 'claude-3-7-sonnet-20250219', adaptive = 'claude-sonnet-4-6';
const message = (): Message => ({ id: 'public', role: 'user', content: 'hi', timestamp: new Date(0) });
const provider = (model = numeric) => new AnthropicProvider({ type: 'anthropic', model, apiKey: 'LOCAL_CONTROL_ONLY' });

describe('private first-party native output policy without new structural provider capabilities', () => {
  it('does not look up or execute properties on unknown/legacy providers', () => {
    const get = vi.fn(), legacy = new Proxy({}, { get });
    expect(captureNativeOutputBudget(legacy)).toBeUndefined(); expect(get).not.toHaveBeenCalled();
    expect(captureNativeOutputBudget(new MockProvider({ type: 'mock' }))).toBeUndefined();
  });
  it('captures one registered policy before later registration cannot redirect it', () => {
    const owner = {}, first = vi.fn(() => ({ options: {}, maxTokens: 64 })), second = vi.fn(() => ({ options: {}, maxTokens: 4096 }));
    registerNativeOutputBudget(owner, () => first); const captured = captureNativeOutputBudget(owner)!;
    registerNativeOutputBudget(owner, () => second);
    expect(captured({}).maxTokens).toBe(64); expect(second).not.toHaveBeenCalled(); expect(captureNativeOutputBudget(owner)!({}).maxTokens).toBe(4096);
  });
  it('pins native configured model before callbacks while explicit post-hook models remain effective', () => {
    const owner = provider(), policy = captureNativeOutputBudget(owner)!; owner.setConfiguredModel(adaptive);
    const pinned = policy({ maxTokens: 64, thinking: 'high' }), explicit = policy({ model: adaptive, maxTokens: 64, thinking: 'high' });
    expect(pinned.options.model).toBe(numeric); expect(pinned.maxTokens).toBe(9216); expect(explicit.options.model).toBe(adaptive); expect(explicit.maxTokens).toBe(64);
  });
  it('does not certify a subclass or add a required method to it', () => {
    class ExtensionProvider extends AnthropicProvider {}
    expect(captureNativeOutputBudget(new ExtensionProvider({ type: 'anthropic', model: numeric, apiKey: 'CONTROL' }))).toBeUndefined();
  });
  for (const value of [undefined, '', ' ', numeric]) it(`preserves own native configured model ${String(value)}`, () => {
    expect(captureNativeConfiguredModel({ model: value }, 'fallback')).toBe(value || 'fallback');
  });
  it('ignores unrelated legacy configuration getters without losing a valid source', () => {
    const get = vi.fn(), config = Object.defineProperty({ model: numeric }, 'legacy', { enumerable: true, get });
    expect(captureNativeConfiguredModel(config, 'fallback')).toBe(numeric); expect(get).not.toHaveBeenCalled();
  });
  for (const inherited of [false, true]) it(`refuses ${inherited ? 'inherited' : 'own'} configured model accessor unread`, () => {
    const get = vi.fn(() => numeric), config = Object.defineProperty({}, 'model', { get });
    expect(() => captureNativeConfiguredModel(inherited ? Object.create(config) : config, 'fallback')).toThrow(ProviderOutputBudgetError); expect(get).not.toHaveBeenCalled();
  });
  it('refuses inherited model data rather than inventing absence', () => {
    expect(() => captureNativeConfiguredModel(Object.create({ model: numeric }), 'fallback')).toThrow(ProviderOutputBudgetError);
  });
  for (const value of [null, 1, {}, []]) it(`refuses non-string configured model ${JSON.stringify(value)}`, () => {
    expect(() => captureNativeConfiguredModel({ model: value }, 'fallback')).toThrow('Provider native output policy is invalid.');
  });
  it('normalizes descriptor trap failure without exposing its secret', () => {
    expect(() => captureNativeConfiguredModel(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE'); } }), 'fallback')).toThrow('Provider native output policy is invalid.');
  });
});

describe('Anthropic native output projection uses the actual thinking/default policy', () => {
  const cases: Array<[string, ChatOptions, number]> = [
    [numeric, { thinking: 'off', maxTokens: 64 }, 64],
    [numeric, { thinking: 'off' }, 1024],
    [numeric, { thinking: 'low', maxTokens: 64, thinkingBudgets: { low: 2048 } }, 3072],
    [numeric, { thinking: 'low', thinkingBudgets: { low: 2048 } }, 3072],
    [numeric, { thinking: 'low', maxTokens: 4096, thinkingBudgets: { low: 2048 } }, 4096],
    [numeric, { thinking: 'low', maxTokens: 64, thinkingBudgets: { low: 0 } }, 2048],
    [numeric, { thinking: 'high', thinkingBudgets: { high: 1_000_000 } }, 33792],
    [adaptive, { thinking: 'high' }, 128000],
    [adaptive, { thinking: 'high', maxTokens: 64 }, 64],
    [adaptive, { thinking: 'low' }, 128000],
    [adaptive, { thinking: 'off' }, 128000],
  ];
  for (const [model, options, expected] of cases) it(`${model} ${JSON.stringify(options)} projects ${expected}`, () => {
    const prepared = prepareAnthropicOutputBudget(options, model), body: Record<string, unknown> = { model, max_tokens: options.maxTokens ?? 1024 };
    applyNativeAnthropicOutputPolicy(body, options);
    expect(prepared.maxTokens).toBe(expected); expect(prepared.maxTokens).toBe(body.max_tokens); expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared.options)).toBe(false); expect(prepared.options.maxTokens).toBe(options.maxTokens);
  });
  it('owns used numeric overrides after observers without freezing or mutating the caller map', () => {
    const map = { low: 2048 }, signal = new AbortController().signal, tools: NonNullable<ChatOptions['tools']> = [];
    const prepared = prepareAnthropicOutputBudget({ thinking: 'low', maxTokens: 64, thinkingBudgets: map, signal, tools }, numeric);
    expect(prepared.options.thinkingBudgets).not.toBe(map); map.low = 8192;
    expect(prepared.options.thinkingBudgets?.low).toBe(2048); expect(Object.isFrozen(map)).toBe(false); expect(prepared.options.signal).toBe(signal); expect(prepared.options.tools).toBe(tools);
    const body: Record<string, unknown> = { model: prepared.options.model, max_tokens: prepared.options.maxTokens };
    applyAnthropicThinking(body, prepared.options); expect(body.max_tokens).toBe(prepared.maxTokens);
  });
  for (const [model, thinking] of [[numeric, 'off'], [adaptive, 'low'], [adaptive, 'high'], [adaptive, 'max']] as const) it(`keeps unused ${model}/${thinking} override maps opaque and mutable`, () => {
    const get = vi.fn(() => { throw new Error('UNUSED'); }), map = Object.defineProperty({}, 'low', { enumerable: true, get });
    const prepared = prepareAnthropicOutputBudget({ thinking, thinkingBudgets: map }, model);
    expect(prepared.options.thinkingBudgets).toBe(map); expect(get).not.toHaveBeenCalled(); expect(Object.isFrozen(map)).toBe(false);
  });
  it('refuses used numeric override accessors unread with the original fixed diagnostic', () => {
    const get = vi.fn(() => 2048), map = Object.defineProperty({}, 'low', { enumerable: true, get });
    expect(() => prepareAnthropicOutputBudget({ thinking: 'low', thinkingBudgets: map }, numeric)).toThrow('Thinking budgets must contain only safe nonnegative integer minimal/low/medium/high values.'); expect(get).not.toHaveBeenCalled();
  });
});

describe('Bedrock selected simple output preparation', () => {
  const model = 'anthropic.claude-haiku-4-5-20251001-v1:0';
  const bedrock = () => new BedrockProvider({ type: 'bedrock', model, apiKey: 'DISPOSABLE', baseUrl: 'http://127.0.0.1:1/owned-unused' });
  it('captures private fallback identity without rewriting the caller cap or double allocating', () => {
    const owner = bedrock(), policy = captureNativeOutputBudget(owner);
    expect(policy).toBeDefined(); owner.setConfiguredModel('unknown');
    const options: ChatOptions = { thinking: 'high', maxTokens: 64 }, before = structuredClone(options);
    const prepared = policy!(options);
    expect(prepared.maxTokens).toBe(16448); expect(prepared.options.model).toBe(model);
    expect(prepared.options.maxTokens).toBe(64); expect(options).toEqual(before);
    class Compatible extends BedrockProvider {}
    expect(captureNativeOutputBudget(new Compatible({ type: 'bedrock', model, apiKey: 'DISPOSABLE' }))).toBeUndefined();
  });
  it('uses the projected transcript and refuses subminimum thinking before provider work', () => {
    const policy = captureNativeOutputBudget(bedrock()); expect(policy).toBeDefined();
    const input: Message[] = [{ id: 'a', role: 'assistant', content: 'prior answer', timestamp: new Date(1), usage: { totalTokens: 193854 } },
      { id: 'u', role: 'user', content: 'probe', timestamp: new Date(3) }];
    const options: ChatOptions = { thinking: 'high', maxTokens: 64, systemPrompt: 'owned tool system' };
    expect(policy!(options, input).maxTokens).toBe(2048);
    input[0].usage!.totalTokens = 193855;
    expect(() => policy!(options, input)).toThrow('Provider native output policy is invalid.');
  });
  it('reserves final native output after awaited observers and refuses without dispatch or retry', async () => {
    const registry = new ExtensionRegistry(), owner = bedrock(), dispatch = vi.spyOn(owner, 'streamChat').mockImplementation(async () => {
      throw new Error('Unexpected native provider dispatch.');
    }), onError = vi.fn(), onRetryStart = vi.fn();
    let raw: BeforeProviderData | undefined;
    await registry.load('bedrock-selected-output', api => api.before('before:provider', data => { raw = data; }));
    try {
      await expect(streamProviderTurn({ provider: owner, providerName: 'bedrock', model, messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: { contextWindow: 12000, reserveTokens: 100 }, onError, onRetryStart, maxRetries: 3,
        onStart: () => { raw!.options.thinking = 'high'; raw!.options.maxTokens = 64; },
      })).rejects.toThrow('Provider request exceeds the owned context budget.');
      expect(dispatch).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1); expect(onRetryStart).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
  for (const field of ['usage', 'metadata'] as const) it(`refuses a late callable ${field} carrier without running its accessor`, async () => {
    const registry = new ExtensionRegistry(), owner = bedrock(), get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); });
    const carrier = Object.defineProperty(() => {}, field === 'usage' ? 'inputTokens' : 'stopReason', { get });
    const dispatch = vi.spyOn(owner, 'streamChat').mockImplementation(async () => { throw new Error('Unexpected native provider dispatch.'); });
    const onError = vi.fn(), onRetryStart = vi.fn(); let raw: BeforeProviderData | undefined;
    await registry.load('bedrock-context-carrier', api => api.before('before:provider', data => { raw = data; }));
    try {
      await expect(streamProviderTurn({ provider: owner, providerName: 'bedrock', model, messages: [message()], tools: [], extensionRegistry: registry,
        maxTokens: 64, thinking: 'off', contextBudget: { contextWindow: 5000, reserveTokens: 100 }, maxRetries: 0, onError, onRetryStart,
        onStart: async () => {
          await Promise.resolve();
          Object.assign(raw!.messages[0], { role: 'assistant', usage: { totalTokens: 1 }, metadata: {}, [field]: carrier });
        },
      })).rejects.toThrow('Provider native output policy is invalid.');
      expect(get).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1); expect(onRetryStart).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(raw!.messages[0], field)?.value).toBe(carrier);
    } finally { await registry.shutdown(); }
  });
  for (const inherited of [false, true]) it(`refuses a direct ${inherited ? 'inherited' : 'own'} usage accessor unread`, () => {
    const get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); });
    const usage = Object.defineProperty({}, 'totalTokens', { get });
    const input = [{ ...message(), role: 'assistant' as const, usage: inherited ? Object.create(usage) : usage }];
    const policy = captureNativeOutputBudget(bedrock())!;
    expect(() => policy({ maxTokens: 64, thinking: 'off' }, input)).toThrow('Provider native output policy is invalid.');
    expect(get).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptor(usage, 'totalTokens')?.get).toBe(get);
  });
  const assistant = (usage: unknown): Message => Object.defineProperty({ ...message(), role: 'assistant' as const, timestamp: new Date(1) },
    'usage', { value: usage, enumerable: true, writable: true, configurable: true });
  const allocation = (input: Message[]) => captureNativeOutputBudget(bedrock())!({ maxTokens: 64000, thinking: 'off' }, input).maxTokens;
  const components = { inputTokens: 189999, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  it('uses a positive total without evaluating unused components, costs or serializers', () => {
    const get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); }), usage = { totalTokens: 190000 };
    for (const key of [...Object.keys(components), 'costUsd', 'toJSON']) Object.defineProperty(usage, key, { get, enumerable: true });
    const before = Object.getOwnPropertyDescriptors(usage);
    expect(allocation([assistant(usage)])).toBe(5904);
    expect(get).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptors(usage)).toEqual(before); expect(Object.isFrozen(usage)).toBe(false);
  });
  const totals: Array<[string, unknown, number]> = [
    ['missing usage', undefined, 64000], ['null usage', null, 64000], ['missing counters', {}, 64000],
    ['positive total', { totalTokens: 190000 }, 5904], ['complete components', components, 5904],
    ['zero total with complete components', { totalTokens: 0, ...components }, 5904],
    ['zero total with incomplete components', { totalTokens: 0, inputTokens: 190000 }, 64000],
    ['all zero', { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 64000],
    ['overflow sum', { ...components, inputTokens: Number.MAX_SAFE_INTEGER }, 64000],
    ...[1.5, -1, '190000', Infinity, NaN].map(totalTokens => [String(totalTokens), { totalTokens, ...components }, Number.isNaN(totalTokens) ? 5904 : 64000] as [string, unknown, number]),
  ];
  for (const [name, usage, expected] of totals) it(`preserves total/component semantics: ${name}`, () => {
    expect(allocation([assistant(usage)])).toBe(expected);
  });
  for (const nullPrototype of [false, true]) it(`accepts nonenumerable own data on ${nullPrototype ? 'null' : 'ordinary'} carriers`, () => {
    const usage = Object.defineProperty(nullPrototype ? Object.create(null) : {}, 'totalTokens', { value: 190000 });
    const metadata = Object.defineProperty(nullPrototype ? Object.create(null) : {}, 'stopReason', { value: 'end_turn' });
    const input = assistant(usage); Object.defineProperty(input, 'metadata', { value: metadata });
    expect(allocation([input])).toBe(5904);
  });
  for (const field of ['usage', 'metadata'] as const) {
    for (const kind of ['array', 'null-prototype-array', 'class', 'callable', 'proxy', 'revoked-proxy'] as const) it(`refuses ${kind} ${field} carriers without traps`, () => {
      const trap = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); });
      class Carrier {}
      const revoked = Proxy.revocable({}, {}); revoked.revoke();
      const carrier = kind === 'array' ? [] : kind === 'null-prototype-array' ? Object.setPrototypeOf([], null)
        : kind === 'class' ? new Carrier() : kind === 'callable' ? () => {} : kind === 'revoked-proxy' ? revoked.proxy
        : new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap });
      const input = assistant({ totalTokens: 190000 }); Object.defineProperty(input, field, { value: carrier });
      expect(() => allocation([input])).toThrow('Provider native output policy is invalid.'); expect(trap).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(input, field)?.value).toBe(carrier);
    });
    for (const inherited of [false, true]) it(`refuses ${inherited ? 'inherited' : 'own'} outer ${field} accessors unread`, () => {
      const get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); }), input = assistant({ totalTokens: 190000 });
      if (inherited) { Reflect.deleteProperty(input, field); Object.setPrototypeOf(input, Object.defineProperty({}, field, { get })); }
      else Object.defineProperty(input, field, { get });
      expect(() => allocation([input])).toThrow('Provider native output policy is invalid.'); expect(get).not.toHaveBeenCalled();
    });
  }
  for (const key of [...Object.keys(components), 'stopReason']) for (const inherited of [false, true]) it(`refuses ${inherited ? 'inherited' : 'own'} consumed ${key} accessors unread`, () => {
    const get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); }), carrier = Object.defineProperty({}, key, { get });
    const input = key === 'stopReason' ? assistant({ totalTokens: 190000 }) : assistant(inherited ? Object.create(carrier) : carrier);
    if (key === 'stopReason') Object.defineProperty(input, 'metadata', { value: inherited ? Object.create(carrier) : carrier });
    expect(() => allocation([input])).toThrow('Provider native output policy is invalid.'); expect(get).not.toHaveBeenCalled();
  });
  for (const field of ['usage', 'metadata'] as const) it(`refuses inherited ${field} data rather than inventing absence`, () => {
    const input = assistant({ totalTokens: 190000 }); Reflect.deleteProperty(input, field);
    Object.setPrototypeOf(input, { [field]: field === 'usage' ? { totalTokens: 190000 } : { stopReason: 'end_turn' } });
    expect(() => allocation([input])).toThrow('Provider native output policy is invalid.');
  });
  for (const key of ['totalTokens', 'inputTokens', 'stopReason']) it(`refuses executable ${key} values without coercion`, () => {
    const convert = vi.fn(() => 190000), value = { valueOf: convert, toString: convert, [Symbol.toPrimitive]: convert };
    const input = assistant(key === 'stopReason' ? { totalTokens: 190000 } : { [key]: value });
    if (key === 'stopReason') Object.defineProperty(input, 'metadata', { value: { stopReason: value } });
    expect(() => allocation([input])).toThrow('Provider native output policy is invalid.'); expect(convert).not.toHaveBeenCalled();
  });
  for (const stopReason of ['error', 'aborted', 'end_turn', undefined, null]) it(`retains stop metadata semantics: ${String(stopReason)}`, () => {
    const input = assistant({ totalTokens: 190000 }); input.metadata = { stopReason };
    expect(allocation([input])).toBe(stopReason === 'error' || stopReason === 'aborted' ? 64000 : 5904);
  });
  it('leaves metadata opaque without positive usage and usage opaque outside eligible assistant prefixes', () => {
    const get = vi.fn(() => { throw new Error('PRIVATE_CONTEXT_ACCESSOR'); });
    for (const usage of [undefined, {}, { totalTokens: 0 }]) {
      const input = assistant(usage); Object.defineProperty(input, 'metadata', { get });
      expect(allocation([input])).toBe(64000);
    }
    const user = Object.defineProperty(message(), 'usage', { get }); expect(allocation([user])).toBe(64000);
    const unknown = Object.defineProperty(assistant(undefined), 'usage', { get });
    expect(captureNativeOutputBudget(bedrock())!({ model: 'unknown', maxTokens: 64000 }, [unknown]).maxTokens).toBe(64000);
    const previous = assistant({ totalTokens: 190000 }); previous.timestamp = new Date(2);
    const older = Object.defineProperty(assistant(undefined), 'usage', { get });
    expect(allocation([previous, older])).toBe(5903); expect(get).not.toHaveBeenCalled();
  });
});

describe('shared ordinary native-output admission', () => {
  for (const cfg of [
    { kind: 'default', window: 1000, model: numeric, thinking: 'off' as const, max: undefined, budget: undefined },
    { kind: 'numeric', window: 2500, model: numeric, thinking: 'low' as const, max: 64, budget: 2048 },
    { kind: 'adaptive', window: 5000, model: adaptive, thinking: 'high' as const, max: undefined, budget: undefined },
  ]) it(`refuses known ${cfg.kind} output alone before native provider work and never retries`, async () => {
    const registry = new ExtensionRegistry(), owner = provider(cfg.model), dispatch = vi.spyOn(owner, 'streamChat'), onStart = vi.fn(), onError = vi.fn(), onRetryStart = vi.fn();
    await registry.load('output-bound', api => api.before('before:provider', data => {
      data.options.thinking = cfg.thinking;
      if (cfg.max !== undefined) data.options.maxTokens = cfg.max;
      if (cfg.budget !== undefined) data.options.thinkingBudgets = { low: cfg.budget };
    }));
    try {
      await expect(streamProviderTurn({ provider: owner, providerName: 'anthropic', model: cfg.model, messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: { contextWindow: cfg.window, reserveTokens: 100 }, onStart, onError, onRetryStart, maxRetries: 3,
      })).rejects.toThrow('Provider request exceeds the owned context budget.');
      expect(onStart).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled(); expect(onRetryStart).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
  it('pairs late used-map refusal with start/error,not retries or getter execution', async () => {
    const registry = new ExtensionRegistry(), owner = provider(), dispatch = vi.spyOn(owner, 'streamChat'), get = vi.fn(), onError = vi.fn(), onRetryStart = vi.fn(); let raw: BeforeProviderData | undefined;
    await registry.load('late-native-budget', api => api.before('before:provider', data => { raw = data; data.options.thinking = 'low'; }));
    try {
      await expect(streamProviderTurn({ provider: owner, providerName: 'anthropic', model: numeric, messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: { contextWindow: 5000, reserveTokens: 900 }, onError, onRetryStart, maxRetries: 3,
        onStart: () => { raw!.options.thinkingBudgets = Object.defineProperty({}, 'low', { enumerable: true, get }); },
      })).rejects.toThrow('Thinking budgets must contain only safe nonnegative integer minimal/low/medium/high values.');
      expect(onError).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(onRetryStart).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
  it('refuses a native configured-model accessor quietly before exposing the hook', async () => {
    const config = { type: 'anthropic', model: numeric, apiKey: 'CONTROL' }, owner = new AnthropicProvider(config), get = vi.fn(() => numeric), registry = new ExtensionRegistry();
    Object.defineProperty(config, 'model', { get });
    const before = vi.spyOn(registry, 'runBefore'), dispatch = vi.spyOn(owner, 'streamChat'), onStart = vi.fn(), onError = vi.fn();
    try {
      await expect(streamProviderTurn({ provider: owner, providerName: 'anthropic', messages: [message()], tools: [], extensionRegistry: registry,
        contextBudget: { contextWindow: 3000, reserveTokens: 900 }, onStart, onError,
      })).rejects.toThrow('Provider native output policy is invalid.');
      expect(get).not.toHaveBeenCalled(); expect(before).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    } finally { await registry.shutdown(); }
  });
});
