import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, MockProvider, type ChatOptions } from './index.js';
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
