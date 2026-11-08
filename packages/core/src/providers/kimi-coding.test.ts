import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { serializeSessionForExport } from '../sessions/serialization.js';
import { getCompactionModelMessages } from '../sessions/compaction-model-messages.js';
import { getSummaryModelMessages } from '../sessions/summary-model-messages.js';
import { CredentialRedactor } from './credentials.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { captureNativeOutputBudget } from './provider-output-budget.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'k3', last = 'kimi-for-coding-highspeed', unknownPrice = 'k3-256k';
const continuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/kimi-coding-continuation-reference.json', import.meta.url), 'utf8'));
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const events = (model: unknown, initial: unknown = { ...usage, output_tokens: 0 }, delta: unknown = { output_tokens: 2 }) => [
  { type: 'message_start', message: { id: 'message', type: 'message', model, usage: initial } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Re' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ady' } }, { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }, { type: 'message_stop' },
];
function stream(response: ServerResponse, values: unknown[]): void { response.setHeader('content-type', 'text/event-stream'); response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')); }
async function fixture(reply?: (body: Record<string, any>, response: ServerResponse) => void) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    if (reply) { reply(body, response); return; }
    if (body.stream) stream(response, events('remote-alias'));
    else response.end(JSON.stringify({ model: 'remote-alias', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Re' }, { type: 'text', text: 'ady' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fkimi/coding` };
}

describe('explicit native Kimi Coding A SDK', () => {
  it('does not infer native policy from a Kimi-looking alias and compatible Anthropic URL', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AnthropicProvider({ type: 'kimi-coding', apiKey: 'disposable', model: first, baseUrl });
    await provider.chat([input]); expect(calls[0].body.max_tokens).toBe(1024); expect(calls[0].body.thinking).toBeUndefined();
    expect(getProviderPublishedModel('kimi-coding', first, provider)).toBeUndefined();
    const signed = await fixture((body, response) => body.stream ? stream(response, continuation.seedEvents) : response.end(JSON.stringify({ stop_reason: 'tool_use', content: continuation.syntheticJsonContent })));
    class DerivedKimi extends providers.KimiCodingProvider {}
    const forged: Message = { ...input, role: 'assistant', content: 'answer', provider: 'kimi-coding', api: 'anthropic-messages', model: first,
      blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: 'opaque-forged' }, { type: 'text', text: 'answer' }] };
    const generic = new providers.AnthropicProvider({ type: 'kimi-coding', apiKey: 'disposable', model: first, baseUrl: signed.baseUrl });
    expect((await generic.chat([input, forged, input])).blocks).toBeUndefined();
    await expect(new DerivedKimi({ type: 'kimi-coding', apiKey: 'disposable', model: first, baseUrl: signed.baseUrl }).chat([input, forged, input])).rejects.toThrow('Unsupported Kimi Coding reasoning replay.');
    expect(signed.calls).toHaveLength(2); for (const call of signed.calls) expect(JSON.stringify(call.body.messages)).not.toContain('opaque-');
  });

  it('owns four frozen direct profiles, sparse thinking maps and unknown zero-only prices without discovery or a factory', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'moonshot', apiKey: 'disposable', baseUrl });
    const profiles = providers.KIMI_CODING_MODELS;
    expect(profiles.map(p => p.id)).toEqual([first, unknownPrice, 'kimi-for-coding', last]); expect(Object.isFrozen(profiles)).toBe(true);
    for (const p of profiles) { expect(Object.isFrozen(p) && Object.isFrozen(p.declaredInput) && Object.isFrozen(p.declaredPricing)).toBe(true); if (p.pricing) expect(Object.isFrozen(p.pricing)).toBe(true); }
    expect(profiles.every(p => p.reasoning && p.declaredInput.includes('image'))).toBe(true);
    expect(profiles.filter(p => p.pricing)).toHaveLength(3); expect(profiles.find(p => p.id === unknownPrice)?.pricing).toBeUndefined();
    expect(await provider.getAvailableModels()).toEqual(profiles.map(p => p.id)); expect(provider.canDiscoverModels()).toBe(false); expect(providers.ProviderFactory.has('kimi-coding')).toBe(false);
    const row = getProviderPublishedModel('moonshot', first, provider)!;
    expect(row).toMatchObject({ id: first, name: 'Kimi K3', api: 'anthropic-messages', contextWindow: 1048576, maxOutputTokens: 131072, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 }, capabilities: { reasoning: true, imageInput: true, toolCalls: true } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 999; row.thinkingLevelMap!.low = 'foreign';
    expect(getProviderPublishedModel('moonshot', first, provider)).toMatchObject({ contextWindow: 1048576, pricing: { inputPerMillion: 3 }, thinkingLevelMap: { off: null, low: 'low', medium: null, high: 'high', max: 'max' } });
    expect(getProviderPublishedModel('moonshot', unknownPrice, provider)?.pricing).toBeUndefined(); expect(getProviderPublishedModel('moonshot', 'moonshotai/kimi-k3', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('moonshot', first, undefined, provider)).toEqual(['low', 'high', 'max']); expect(getSupportedThinkingLevels('moonshot', last, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(provider.getSpecializedModels()).toEqual([expect.objectContaining({ model: first, api: 'anthropic-messages', type: 'classifier', virtual: true, imageInput: true })]); expect(calls).toEqual([]);
  });

  it('dispatches every direct profile over JSON/SSE with adaptive effort, owned caps and genuine known-or-unknown A costs', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const p of providers.KIMI_CODING_MODELS) for (const thinking of ['off', 'high'] as const) {
      const options = { model: p.id, thinking, temperature: 0.25, systemPrompt: 'System', sessionId: 'not-openrouter', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } }] };
      const expectedCost = p.pricing ? (5 * p.pricing.inputPerMillion + 2 * p.pricing.outputPerMillion + 4 * p.pricing.cacheReadPerMillion + p.pricing.cacheWritePerMillion) / 1e6 : undefined;
      const answer = await provider.chat([input], options), complete = vi.fn();
      await provider.streamChat([input], () => {}, complete, error => { throw error; }, options);
      for (const result of [answer, complete.mock.calls[0][0]]) { expect(result).toMatchObject({ provider: 'openai', model: p.id, api: 'anthropic-messages', content: 'Ready', reasoning: 'Plan', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 } }); expect(result.usage.costUsd).toBe(expectedCost); }
      for (const c of calls.slice(-2)) {
        expect(c.url).toBe('/owned%2Fkimi/coding/v1/messages'); expect(c.headers['x-api-key']).toBe('disposable'); expect(c.headers['anthropic-version']).toBe('2023-06-01');
        for (const name of ['authorization', 'anthropic-beta', 'api-key', 'x-session-id', 'x-session-affinity', 'nvcf-poll-seconds']) expect(c.headers[name]).toBeUndefined();
        const disabled = p.id === last && thinking === 'off';
        expect(c.body).toMatchObject({ model: p.id, max_tokens: p.maxOutputTokens, thinking: disabled ? { type: 'disabled' } : { type: 'adaptive', display: 'summarized' } });
        expect(c.body.output_config).toEqual(disabled ? undefined : { effort: thinking === 'off' ? 'low' : 'high' }); expect(c.body.temperature).toBe(disabled ? 0.25 : undefined);
        expect(c.body.tools[0]).toMatchObject({ input_schema: { type: 'object' }, eager_input_streaming: true, cache_control: { type: 'ephemeral' } }); expect(c.body.tools[0]).not.toHaveProperty('strict');
        for (const key of ['budget_tokens', 'reasoning_effort', 'store', 'tool_stream', 'max_completion_tokens', 'prompt_cache_key']) expect(c.body).not.toHaveProperty(key);
      }
    }
    expect(calls).toHaveLength(16);
  });

  it.each(['chat', 'stream'] as const)('uses only explicitly selected OAuth Bearer authentication over %s', async operation => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable-oauth-access', baseUrl,
      kimiAuthMode: 'oauth', customHeaders: { 'X-Api-Key': 'unselected-key', Authorization: 'unselected-auth', 'x-owned': 'kept' } });
    if (operation === 'chat') await provider.chat([input]);
    else await provider.streamChat([input], () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe('Bearer disposable-oauth-access');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].headers['x-owned']).toBe('kept');
    expect(calls[0].body.model).toBe(first);
  });

  it('refuses an invalid explicit auth mode before JSON or SSE dispatch', async () => {
    const { calls, baseUrl } = await fixture();
    for (const mode of ['invalid', null]) {
      const provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl,
        ...JSON.parse(JSON.stringify({ kimiAuthMode: mode })) });
      await expect(provider.chat([input])).rejects.toThrow('Invalid Kimi Coding request headers.');
      await expect(provider.streamChat([input], () => {})).rejects.toThrow('Invalid Kimi Coding request headers.');
    }
    expect(calls).toEqual([]);
  });

  it('physically clamps sparse maps and ignores numeric budget accessors in adaptive requests', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) await provider.chat([input], { thinking });
    expect(calls.map(c => c.body.output_config.effort)).toEqual(['low', 'low', 'low', 'high', 'high', 'max', 'max']);
    const getter = vi.fn(() => 99999), opaque = Object.defineProperty({}, 'high', { get: getter });
    await provider.chat([input], { thinking: 'high', thinkingBudgets: opaque, maxTokens: 1 }); expect(getter).not.toHaveBeenCalled(); expect(calls.at(-1)!.body.max_tokens).toBe(1);
    const captured = captureNativeOutputBudget(provider)!; provider.setConfiguredModel(last);
    expect(captured({}).maxTokens).toBe(131072); expect(captureNativeOutputBudget(provider)!({}).maxTokens).toBe(32768);
  });

  it('owns model-specific empty-signature replay and system/tool/history cache breakpoints without automatic affinity', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const history: Message[] = [{ ...input, role: 'assistant', content: 'Before', blocks: [{ type: 'reasoning', text: 'Earlier plan' }], toolCalls: [{ id: 'call-1', name: 'read', input: {} }] }, input];
    for (const p of providers.KIMI_CODING_MODELS) for (const cacheRetention of ['none', 'short', 'long'] as const) {
      history[0] = { ...history[0], provider: 'operator', api: 'anthropic-messages', model: p.id };
      await provider.chat(history, { model: p.id, cacheRetention, systemPrompt: 'System', tools: [{ name: 'first', description: 'First', parameters: {} }, { name: 'last', description: 'Last', parameters: {} }] });
      const b = calls.at(-1)!.body, control = cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(cacheRetention === 'long' ? { ttl: '1h' } : {}) };
      expect(b.messages[0].content).toEqual([p.id === first || p.id === 'kimi-for-coding' ? { type: 'thinking', thinking: 'Earlier plan', signature: '' } : { type: 'text', text: 'Earlier plan' }, { type: 'text', text: 'Before' }, { type: 'tool_use', id: 'call-1', name: 'read', input: {} }]);
      expect(b.system[0].cache_control).toEqual(control); expect(b.tools[0].cache_control).toBeUndefined(); expect(b.tools[1].cache_control).toEqual(control);
      if (cacheRetention === 'none') expect(JSON.stringify(b.messages)).not.toContain('cache_control'); else expect(b.messages.at(-1).content.at(-1).cache_control).toEqual(control);
    }
    expect(history[0].content).toBe('Before');
    await new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([input]); expect(calls.at(-1)!.headers['x-session-affinity']).toBe('operator-owned');
  });

  it.each(['chat', 'stream'] as const)('captures physical fallback and costs for an empty override before awaited mutation (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); let answer: providers.ChatResponse | undefined;
    if (operation === 'chat') answer = await provider.chat([input], { model: '' }); else await provider.streamChat([input], async () => { await Promise.resolve(); provider.setConfiguredModel(last); }, result => { answer = result; }, undefined, { model: '' });
    expect(calls[0].body.model).toBe(first); expect(answer).toMatchObject({ model: first, provider: 'operator', api: 'anthropic-messages', usage: { totalTokens: 12, costUsd: (5 * 3 + 2 * 15 + 4 * 0.3) / 1e6 } });
    if (operation === 'stream') expect(provider.getConfiguredModel()).toBe(last);
    const signed = await fixture((body, response) => body.stream ? stream(response, continuation.seedEvents) : response.end(JSON.stringify({ model: 'untrusted-response-alias', stop_reason: 'tool_use', content: continuation.syntheticJsonContent,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } })));
    const changing = new providers.KimiCodingProvider({ type: 'kimi-coding', apiKey: 'disposable', model: first, baseUrl: signed.baseUrl });
    const probe: Message = { ...input, content: 'probe' }; let reads = 0, snapshot: providers.ChatResponse | undefined;
    const selected = { get model() { return ++reads <= 2 ? first : last; }, thinking: 'low' as const, maxTokens: 64, cacheRetention: 'none' as const };
    if (operation === 'chat') snapshot = await changing.chat([probe], selected);
    else await changing.streamChat([probe], () => {}, result => { snapshot = result; }, error => { throw error; }, selected);
    expect(signed.calls.at(-1)!.body.model).toBe(last); expect(snapshot).toMatchObject({ model: signed.calls.at(-1)!.body.model, api: 'anthropic-messages', provider: 'kimi-coding' });
    expect(snapshot!.usage?.costUsd).toBeCloseTo((5 * 1.9 + 2 * 8 + 4 * 0.38) / 1e6, 12);
    const history: Message[] = [probe, { id: 'getter-a', role: 'assistant', timestamp: new Date(0), content: snapshot!.content, provider: snapshot!.provider, api: snapshot!.api,
      model: snapshot!.model, blocks: snapshot!.blocks, toolCalls: snapshot!.toolCalls }, { id: 'getter-r', role: 'tool', name: 'echo', toolCallId: 'call', content: 'result', timestamp: new Date(0) }, { ...input, id: 'getter-next', content: 'continue' }], before = structuredClone(history);
    await changing.chat(history, { model: last, maxTokens: 64, thinking: 'low', cacheRetention: 'none' });
    expect(signed.calls.at(-1)!.body.messages).toEqual(continuation.rows.find((row: { model: string }) => row.model === last).cases[0].expectedBody.messages);
    await changing.chat(history, { model: first, maxTokens: 64, thinking: 'low', cacheRetention: 'none' });
    expect(signed.calls.at(-1)!.body.messages).toEqual(continuation.rows.find((row: { model: string }) => row.model === first).cases.find((projection: { case: string }) => projection.case === 'foreign-model').expectedBody.messages);
    expect(history).toEqual(before);
  });

  it('keeps partial usage unknown, merges nullable SSE counters and prices observed 1h writes without making zero-only models free', async () => {
    let current: unknown = usage, delta: unknown = { output_tokens: 2 };
    const { baseUrl } = await fixture((b, response) => b.stream ? stream(response, events(b.model, current, delta)) : response.end(JSON.stringify({ model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage: current })));
    const provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    current = { ...usage, cache_creation: { ephemeral_1h_input_tokens: 1 } }; delta = { input_tokens: null, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: null } };
    const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; }); expect(complete.mock.calls[0][0].usage.costUsd).toBe((5 * 3 + 2 * 15 + 4 * 0.3 + 6) / 1e6);
    expect((await provider.chat([input], { model: unknownPrice })).usage?.costUsd).toBeUndefined();
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { ...usage, cache_read_input_tokens: null }, { ...usage, cache_creation: { ephemeral_1h_input_tokens: 2 } }]) { current = invalid; expect((await provider.chat([input])).usage).toBeUndefined(); }
  });

  it('gates missing terminal authority and opaque replay before pending tools or completion with private errors', async () => {
    let values: unknown[] = [], json: unknown;
    const { baseUrl } = await fixture((b, response) => b.stream ? stream(response, values) : response.end(JSON.stringify(json))), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'private-key', baseUrl });
    const tool = [{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} } }, { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }];
    for (const malformed of [[...events(first).slice(0, -2), ...tool], [...events(first), { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'LATE' } }], [events(first)[0], { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-source' } }]]) {
      values = malformed; const complete = vi.fn(), chunks: string[] = [];
      await expect(provider.streamChat([input], (_text, event) => { chunks.push(event!.type); }, complete)).rejects.toThrow(/Kimi Coding/); expect(chunks).not.toContain('tool_call'); expect(complete).not.toHaveBeenCalled();
    }
    json = { error: { message: 'private-source' } }; await expect(provider.chat([input])).rejects.toThrow('Invalid Kimi Coding chat response.');
  });

  it('awaits withdrawal before buffered output, pending tools or completion', async () => {
    const { baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), abort = new AbortController(), complete = vi.fn(), seen: string[] = [];
    await expect(provider.streamChat([input], async text => { if (!text) return; seen.push(text); await Promise.resolve(); abort.abort(); }, complete, undefined, { signal: abort.signal })).rejects.toThrow('Kimi Coding request aborted.'); expect(seen).toEqual(['Re']); expect(complete).not.toHaveBeenCalled();
    const failures: Error[] = [];
    await provider.streamChat([input], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_KIMI_COMPLETION_FAILURE'); }, error => { failures.push(error); });
    expect(failures.map(error => error.message)).toEqual(['Kimi Coding chat request failed.']);
  });

  it('admits only native IDs, exact safe output caps and declared data images without ambient keys or unsafe endpoints', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubEnv('KIMI_API_KEY', 'ambient-key'); vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key'); expect(new providers.KimiCodingProvider({ type: 'kimi-coding' }).validateConfig()).toBe(false);
    for (const model of ['future', 'moonshotai/kimi-k3', 'claude-sonnet-4-6']) { expect(() => provider.setConfiguredModel(model)).toThrow('Kimi Coding chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Kimi Coding chat model is not supported.'); }
    for (const maxTokens of [0, -1, 0.5, 131073, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Kimi Coding output limit.');
    for (const apiKey of ['', 'bad\nkey', '🙂']) await expect(new providers.KimiCodingProvider({ type: 'operator', apiKey, baseUrl }).chat([input])).rejects.toThrow('Kimi Coding API key is required.'); expect(calls).toEqual([]);
    const image: Message = { ...input, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] };
    for (const p of providers.KIMI_CODING_MODELS) { await provider.chat([image], { model: p.id, thinking: 'high', maxTokens: 1 }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 1, thinking: { type: 'adaptive' } }); }
    for (const profile of providers.KIMI_CODING_MODELS) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { id: 'image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'operator', api: 'anthropic-messages', model: profile.id,
        toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { ...image, id: 'tool-image', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result' }, { ...input, id: 'after', content: 'after' }], before = structuredClone(history);
      const options = { model: profile.id, maxTokens: 64, thinking: 'low' as const, cacheRetention: 'none' as const };
      if (facade === 'chat') await provider.chat(history, options); else await provider.streamChat(history, () => {}, undefined, error => { throw error; }, options);
      expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: [{ type: 'text', text: 'called' }, { type: 'tool_use', id: 'image-call', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-call', content: 'result', is_error: false }] },
        { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }, { role: 'user', content: 'after' }]);
      expect(history).toEqual(before);
    }
    for (const endpoint of ['ftp://example.test', 'https://user:secret@example.test', 'https://example.test?secret=1', 'https://example.test#secret']) expect(() => new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: endpoint })).toThrow('Invalid Kimi Coding endpoint.');
    let url = ''; vi.stubGlobal('fetch', vi.fn(async (value: string | URL | Request) => { url = String(value); return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }] }), { status: 200 }); }));
    await new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(url).toBe('https://api.kimi.com/coding/v1/messages');
  });

  it.each(providers.KIMI_CODING_MODELS.map(profile => profile.id))('captures and replays independently bound private JSON/SSE arrays for %s', async model => {
    const reference = continuation.rows.find((row: { model: string }) => row.model === model); expect(reference).toBeDefined();
    expect(continuation.freshSdkRequests).toBe(52); expect(continuation.replayProjections).toBe(48);
    let active = continuation.seedEvents as Record<string, any>[], content: unknown[] = continuation.syntheticJsonContent, stop = 'tool_use';
    const { calls, baseUrl } = await fixture((body, response) => body.stream ? stream(response, active) : response.end(JSON.stringify({ model: 'untrusted-response-alias', stop_reason: stop, content,
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } })));
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.KimiCodingProvider({ type: 'kimi-coding', apiKey: 'disposable-kimi-private', model, baseUrl });
      const options = { maxTokens: 64, thinking: 'low' as const, cacheRetention: 'none' as const, systemPrompt: 'owned Kimi Coding reference system', tools: continuation.tools };
      const expectedBody = (body: Record<string, any>) => ({ ...structuredClone(body), stream: facade === 'stream' });
      const invoke = async (messages: Message[]) => { if (facade === 'chat') return provider.chat(messages, options); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text).not.toContain('PRIVATE_KIMI_HEADER'); expect(JSON.stringify(event ?? {})).not.toContain('PRIVATE_KIMI_HEADER'); }, response => { complete = response; }, error => { throw error; }, options); expect(complete).toBeDefined(); return complete!; };
      active = continuation.seedEvents.map((event: Record<string, any>) => event.type === 'message_start' ? { ...event, message: { ...event.message, content: [{ type: 'text', text: 'PRIVATE_KIMI_HEADER' }] } } : event);
      content = continuation.syntheticJsonContent; stop = 'tool_use';
      const user: Message = { ...input, content: 'probe' }, initial = structuredClone([user]), captured = await invoke(initial);
      expect(captured).toMatchObject({ provider: 'kimi-coding', api: 'anthropic-messages', model, content: 'left!right?', toolCalls: [{ id: 'call', name: 'echo', input: { x: 1 } }] });
      expect(captured.blocks).toEqual(continuation.expectedBlocks); expect(initial).toEqual([user]); expect(calls.at(-1)!.body).toEqual(expectedBody(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const assistant: Message = { id: 'a', role: 'assistant', content: captured.content, timestamp: new Date(0), provider: projection.source.provider, api: projection.source.api,
          model: projection.source.model, blocks: structuredClone(captured.blocks), toolCalls: structuredClone(captured.toolCalls) };
        const thought = assistant.blocks!.find(block => block.type === 'reasoning' && !block.redacted)!; expect(thought.type).toBe('reasoning');
        if (thought.type !== 'reasoning') throw new Error('Missing reference reasoning');
        if (projection.case === 'unsigned') delete thought.thinkingSignature;
        if (projection.case === 'empty-thinking') thought.text = ''; if (projection.case === 'blank-thinking') thought.text = ' \t';
        if (projection.case === 'empty-signature') thought.thinkingSignature = ''; if (projection.case === 'blank-signature') thought.thinkingSignature = ' \t';
        if (projection.case.startsWith('failed-')) assistant.metadata = { outputError: 'Failed Kimi Coding producer' };
        const results: Message[] = projection.case.startsWith('failed-') ? [] : [{ id: 'r', role: 'tool', name: 'echo', toolCallId: 'call', content: 'result', timestamp: new Date(0) }];
        const history: Message[] = [user, assistant, ...results, { ...input, id: 'next', content: 'continue' }], before = structuredClone(history);
        active = projection.responseEvents; content = [{ type: 'text', text: 'ok' }]; stop = 'end_turn';
        expect(await invoke(history)).toMatchObject({ provider: 'kimi-coding', api: 'anthropic-messages', model, content: 'ok' });
        expect(calls.at(-1)!.body).toEqual(expectedBody(projection.expectedBody)); expect(history).toEqual(before);
      }
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-replay-')), redactor = new CredentialRedactor(['opaque-signature', 'disposable-kimi-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Kimi replay' }), registry = new ExtensionRegistry();
      let effects = 0;
      const finalEvents = reference.cases[0].responseEvents, finalContent = [{ type: 'text', text: 'ok' }];
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; active = finalEvents; content = finalContent; stop = 'end_turn'; return { content: 'result' }; } }));
      active = continuation.seedEvents; content = continuation.syntheticJsonContent; stop = 'tool_use';
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'kimi-coding', tools: continuation.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'kimi-coding', model, messages,
            tools: continuation.tools, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: 'low', cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1);
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(message => message.role === 'assistant');
        expect(history.map(message => message.blocks)).toEqual([redactJson(continuation.expectedBlocks), finalContent]);
        expect(bytes).not.toContain('opaque-signature'); expect(bytes).not.toContain('disposable-kimi-private'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-');
        expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain('opaque-signature');
        const same = reference.cases[0].expectedBody.messages.filter((message: Record<string, any>) => message.role === 'assistant'), finalMessage = { role: 'assistant', content: finalContent };
        const native = () => calls.at(-1)!.body.messages.filter((message: Record<string, any>) => message.role === 'assistant');
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same), finalMessage]);
        expect(calls.at(-1)!.body.messages.flatMap((message: Record<string, any>) => Array.isArray(message.content) ? message.content.filter((block: Record<string, any>) => block.type === 'tool_result') : []))
          .toEqual([{ type: 'tool_result', tool_use_id: 'call', content: 'result', is_error: false }]);
        expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        expect(native()).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }, { type: 'text', text: 'edited answer' }] }, finalMessage]);
        expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(message => message.blocks));
        expect(clone.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(message => message.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_KIMI_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy();
        const compacted = getCompactionModelMessages(compactedManager, clone.id); expect(compacted.some(message => message.content.includes('PUBLIC_KIMI_COMPACTED_PREFIX'))).toBe(true);
        expect(compacted.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([finalContent]); expect(compacted.filter(message => message.role === 'tool')).toEqual([]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        expect((await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(message => message.blocks));
        await invoke(compacted); expect(native()).toEqual([finalMessage]); expect(calls.at(-1)!.body.messages.flatMap((message: Record<string, any>) => Array.isArray(message.content) ? message.content.filter((block: Record<string, any>) => block.type === 'tool_result') : [])).toEqual([]);
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(36); for (const call of calls) { expect(call.url).toBe('/owned%2Fkimi/coding/v1/messages'); expect(call.headers['x-api-key']).toBe('disposable-kimi-private'); expect(call.headers.authorization).toBeUndefined(); expect(call.headers['anthropic-version']).toBe('2023-06-01'); }
  });

  it('retains the existing instance virtual classifier512 and refuses image generation', async () => {
    const { calls, baseUrl } = await fixture((_b, response) => response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"safe"}' }] }))), provider = new providers.KimiCodingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    expect(await new SpecializedModels(provider).classify({ model: provider.getSpecializedModels()[0].id, input: 'Hello', labels: ['safe', 'unsafe'] })).toMatchObject({ label: 'safe' }); expect(calls[0].body.max_tokens).toBe(512);
    await expect(provider.generateImages({ model: 'image', prompt: 'Image' })).rejects.toThrow('Image generation is not supported by this provider.');
  });
});
