import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type ChatOptions, type ChatResponse } from './index.js';
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
  let usage: Record<string, unknown> = structuredClone(observed), delta: Record<string, unknown> | undefined;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.stream) return new Response(JSON.stringify({ model: responseModel,
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }));
    return new Response([
      { type: 'message_start', message: { usage } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta ?? usage },
      { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const call = async (stream: boolean, retention: 'none' | 'short' | 'long' = 'short', options?: ChatOptions) => {
    if (!stream) return provider.chat(input, { maxTokens: 64, cacheRetention: retention, ...options });
    let result: ChatResponse | undefined, failure: Error | undefined;
    await provider.streamChat(input, () => {}, value => { result = value; }, error => { failure = error; },
      { maxTokens: 64, cacheRetention: retention, ...options });
    if (failure) throw failure; return result!;
  };
  return { provider, fetch, call, usage: (value: Record<string, unknown>, next?: Record<string, unknown>) => { usage = value; delta = next; } };
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
      expect(result.api).toBe('anthropic-messages'); expect(result.content).toBe('ok');
      expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3, totalTokens: 14 });
      expect(result.usage?.costUsd).toBeCloseTo((5 * profile.cost.input + 2 * profile.cost.output
        + 4 * profile.cost.cacheRead + 2 * profile.cost.cacheWrite + 2 * profile.cost.input) / 1e6, 12);
    }
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  for (const profile of profiles) it(`${profile.id}: enforces the owned output ceiling on SDK and preflight`, async () => {
    const f = fixture(profile.id), policy = captureNativeOutputBudget(f.provider)!;
    for (const maxTokens of [undefined, 1, profile.maxTokens]) {
      const options = { maxTokens }, expected = maxTokens ?? 1024;
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
  for (const profile of adaptiveProfiles) it(`${profile.id}: retains omitted thinking and output allocation, rejects invalid levels before HTTP`, async () => {
    const f = fixture(profile.id), policy = captureNativeOutputBudget(f.provider)!;
    for (const thinking of [undefined, 'high', 'xhigh', 'max'] as const) {
      const options = { thinking, maxTokens: undefined, temperature: 0.25 };
      const maximum = thinking === undefined ? 1024 : thinking === 'high' ? 9216 : thinking === 'xhigh' ? 17408 : 33792;
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
  it('captures the adaptive dialect independently of public metadata, later model changes and derived transports', async () => {
    const f = fixture('claude-opus-4-7'), policy = captureNativeOutputBudget(f.provider)!;
    const row = getProviderPublishedModel('operator-alias', 'claude-opus-4-7', f.provider)!;
    row.thinkingLevelMap!.xhigh = 'not-an-effort'; row.thinkingLevelMap!.off = null;
    f.provider.setConfiguredModel('claude-haiku-4-5');
    for (const stream of [false, true]) {
      await f.call(stream, 'short', policy({ thinking: 'xhigh', maxTokens: 64 }).options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).output_config).toEqual({ effort: 'xhigh' });
      await f.call(stream, 'short', policy({ model: 'claude-haiku-4-5', thinking: 'high', maxTokens: 64 }).options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
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
  it('preserves numeric allocation while rejecting invalid explicit caps before thinking can raise them', async () => {
    const f = fixture('claude-haiku-4-5'), policy = captureNativeOutputBudget(f.provider)!;
    const options = { maxTokens: 64, thinking: 'high' as const };
    expect(policy(options).maxTokens).toBe(9216);
    for (const stream of [false, true]) {
      await f.call(stream, 'short', options);
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).max_tokens).toBe(9216);
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
    for (const row of native.filter(row => !adaptiveProfiles.some(profile => profile.id === row.id))) {
      expect(getSupportedThinkingLevels('operator-alias', row.id, undefined, f.provider)).toEqual(['off']);
    }
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
