import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, type ChatResponse } from './index.js';
import { getProviderPublishedModels, getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';

const bytes = readFileSync(new URL('../../../../tests/fixtures/anthropic-reference.json', import.meta.url));
const pin = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-reference.json', import.meta.url), 'utf8'));
const profiles = Object.values(JSON.parse(bytes.toString())['anthropic-messages']) as Array<{
  id: string; name: string; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}>;
const input = [{ id: 'user', role: 'user' as const, content: 'probe', timestamp: new Date() }];
const observed = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4,
  cache_creation_input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 1 } };
afterEach(() => vi.restoreAllMocks());
function fixture(model: string, responseModel = 'untrusted-response-alias') {
  const provider = new AnthropicProvider({ type: 'operator-alias', model, apiKey: 'disposable-profile-key' });
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
  const call = async (stream: boolean, retention: 'short' | 'long' = 'short') => {
    if (!stream) return provider.chat(input, { maxTokens: 64, cacheRetention: retention });
    let result: ChatResponse | undefined, failure: Error | undefined;
    await provider.streamChat(input, () => {}, value => { result = value; }, error => { failure = error; },
      { maxTokens: 64, cacheRetention: retention });
    if (failure) throw failure; return result!;
  };
  return { provider, fetch, call, usage: (value: Record<string, unknown>, next?: Record<string, unknown>) => { usage = value; delta = next; } };
}

describe('pinned original Anthropic metadata and observed accounting', () => {
  it('binds the independent seventeen-profile fixture to the approved catalogue hash', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.files.anthropic.catalogue);
    expect(profiles).toHaveLength(17);
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
    for (const row of native.filter(row => row.id !== 'claude-sonnet-4-6')) {
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
