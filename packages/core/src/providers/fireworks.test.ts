import { createServer, type Server } from 'node:http';
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
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const prefix = 'accounts/fireworks/', flash = prefix + 'models/deepseek-v4p1-flash', ember = prefix + 'models/ember-1', numeric = prefix + 'models/inkling', qwen = prefix + 'models/qwen3p8-max', glm = prefix + 'models/glm-5p3', kimi = prefix + 'models/kimi-k3';
const ids = ['models/deepseek-v4p1-flash','models/ember-1','models/gpt-oss-120b','models/inkling','models/minimax-m3','models/nemotron-3-ultra-nvfp4','models/nemotron-lightning-3p5-30b-a3b','models/qwen3p8-2p4t-a95b','models/qwen3p8-max','routers/deepseek-flash-latest','routers/kimi-fast-latest','routers/kimi-latest','routers/minimax-latest','routers/qwen-max-latest','models/glm-5p3','models/glm-5p3-flash','models/kimi-k3','routers/glm-5p3-fast','routers/glm-fast-latest','routers/glm-flash-latest','routers/glm-latest','routers/kimi-k3-fast'].map(id => prefix + id);
const levels = ['off','minimal','low','medium','high','xhigh','max'] as const;
const continuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/fireworks-continuation-reference.json', import.meta.url), 'utf8'));
const continuationModels: string[] = continuation.rows.map((row: { model: string }) => row.model);
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: { A?: unknown[]; C?: unknown[] }, replies?: { A?: Record<string, unknown>; C?: Record<string, unknown> }) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text), a = request.url?.endsWith('/messages'); calls.push({ url: request.url, headers: request.headers, body });
    const aUsage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 }, cUsage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      const values = a ? events?.A ?? [{ type: 'message_start', message: { id: 'answer', role: 'assistant', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thought' } }, { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ready' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
        : events?.C ?? [{ choices: [{ delta: { reasoning_content: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage: cUsage }];
      response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (a ? '' : 'data: [DONE]\n\n'));
    } else response.end(JSON.stringify(a ? replies?.A ?? { content: [{ type: 'thinking', thinking: 'Thought', signature: '' }, { type: 'text', text: 'Ready' }], stop_reason: 'end_turn', usage: aUsage } : replies?.C ?? { choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage: cUsage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Ffireworks/inference/v1` };
}

describe('explicit native mixed Fireworks A/C SDK', () => {
  it('keeps generic compatible C distinct from per-model Messages and native C cap policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.OpenAiProvider({ type: 'fireworks', apiKey: 'disposable', baseUrl, model: flash }).chat([message], { thinking: 'high', maxTokens: 20000 });
    expect(calls[0].url).toBe('/owned%2Ffireworks/inference/v1/chat/completions'); expect(calls[0].body).toMatchObject({ max_tokens: 20000, reasoning_effort: 'high' }); expect(calls[0].body).not.toHaveProperty('thinking');
    const signed = await fixture(undefined, { A: { content: continuation.syntheticJsonContent, stop_reason: 'tool_use' } });
    class DerivedFireworks extends providers.FireworksProvider {}
    const forged: Message = { ...message, role: 'assistant', content: 'answer', provider: 'fireworks', api: 'anthropic-messages', model: flash,
      blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: 'opaque-forged' }, { type: 'text', text: 'answer' }] };
    const generic = new providers.AnthropicProvider({ type: 'fireworks', apiKey: 'disposable', model: flash, baseUrl: signed.baseUrl });
    expect((await generic.chat([message, forged, message])).blocks).toBeUndefined();
    await expect(new DerivedFireworks({ type: 'fireworks', apiKey: 'disposable', model: flash, baseUrl: signed.baseUrl }).chat([message, forged, message])).rejects.toThrow('Unsupported Fireworks reasoning replay.');
    expect(signed.calls).toHaveLength(2); for (const call of signed.calls) expect(JSON.stringify(call.body.messages)).not.toContain('opaque-');
  });

  it('publishes22 immutable profiles and defensive per-model APIs, windows, prices and thinking without a factory', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.FireworksProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(providers.FIREWORKS_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.FIREWORKS_MODELS)).toBe(true); expect(providers.FIREWORKS_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.thinkingLevelMap))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(flash); expect(providers.ProviderFactory.has('fireworks')).toBe(false); expect(provider.getModelApi(flash)).toBe('anthropic-messages'); expect(provider.getModelApi(glm)).toBe('openai-completions'); expect(provider.getModelApi('future')).toBeUndefined();
    const row = getProviderPublishedModel('anthropic', glm, provider)!; expect(row).toMatchObject({ api: 'openai-completions', contextWindow: 1048573, maxOutputTokens: 262144, pricing: { inputPerMillion: 1.4, outputPerMillion: 4.4, cacheReadPerMillion: 0.26, cacheWritePerMillion: 0 } }); row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign'; expect(getProviderPublishedModel('anthropic', glm, provider)).toMatchObject({ contextWindow: 1048573, thinkingLevelMap: { off: null, high: 'high' } }); expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('anthropic', flash, undefined, provider)).toEqual(['off','low','high','max']); expect(getSupportedThinkingLevels('anthropic', qwen, undefined, provider)).toEqual(['off','low','medium','xhigh']); expect(getSupportedThinkingLevels('anthropic', numeric, undefined, provider)).toEqual(['off','minimal','low','medium','high']); expect(getSupportedThinkingLevels('anthropic', glm, undefined, provider)).toEqual(['low','high','max']); expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
  });

  it('dispatches native adaptive/numeric Messages versus C with exact explicit caps and captured physical prices', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['openai','anthropic','azure','operator-fireworks']) for (const model of [flash,numeric,glm]) {
      const provider = new providers.FireworksProvider({ type, apiKey: 'disposable-fireworks', baseUrl, model });
      expect(await provider.chat([message], { thinking: 'high', maxTokens: 20000, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model, api: model === glm ? 'openai-completions' : 'anthropic-messages', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: model === glm ? (5 * 1.4 + 2 * 4.4 + 4 * 0.26) / 1e6 : model === numeric ? (5 + 2 * 4.05 + 4 * 0.17) / 1e6 : (5 * 0.3 + 2 * 1.2 + 4 * 0.006) / 1e6 } });
    }
    for (const call of calls) {
      const a = call.body.model !== glm; expect(call.url).toBe('/owned%2Ffireworks/inference/v1/' + (a ? 'messages' : 'chat/completions'));
      if (a) { expect(call.headers['x-api-key']).toBe('disposable-fireworks'); expect(call.headers['anthropic-version']).toBe('2023-06-01'); expect(call.headers.authorization).toBeUndefined(); expect(call.body.max_tokens).toBe(20000); expect(call.body.system[0].text).toBe('System'); expect(call.body.tools[0]).toMatchObject({ name: 'read', input_schema: { type: 'object' } }); for (const key of ['strict','eager_input_streaming','cache_control']) expect(call.body.tools[0]).not.toHaveProperty(key); expect(call.body.thinking).toMatchObject(call.body.model === flash ? { type: 'adaptive', display: 'summarized' } : { type: 'enabled', budget_tokens: 16384, display: 'summarized' }); if (call.body.model === flash) expect(call.body.output_config).toEqual({ effort: 'high' }); else expect(call.body).not.toHaveProperty('output_config'); expect(call.body).not.toHaveProperty('max_completion_tokens'); expect(call.body).not.toHaveProperty('reasoning_effort'); }
      else { expect(call.headers.authorization).toBe('Bearer disposable-fireworks'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.body).toMatchObject({ max_completion_tokens: 20000, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }] }); expect(call.body.tools[0].function.strict).toBe(false); expect(call.body).not.toHaveProperty('max_tokens'); expect(call.body).not.toHaveProperty('thinking'); }
      for (const key of ['store','prompt_cache_key','prompt_cache_retention','chat_template_args','chat_template_kwargs','tool_stream']) expect(call.body).not.toHaveProperty(key);
    }
  });

  it('clamps sparse adaptive maps and numeric budgets without borrowing shared-ID policies or changing caps', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const thinking of levels) await provider.chat([message], { model: qwen, thinking, maxTokens: 20000 }); expect(calls.map(call => call.body.output_config?.effort ?? 'off')).toEqual(['off','low','low','medium','xhigh','xhigh','xhigh']);
    await provider.chat([message], { model: numeric, thinking: 'low', thinkingBudgets: { low: 4096 }, maxTokens: 5120 }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 5120, thinking: { type: 'enabled', budget_tokens: 4096 } });
    await provider.chat([message], { model: glm, thinking: 'off' }); expect(calls.at(-1)!.body.reasoning_effort).toBe('low'); expect(calls.at(-1)!.body).not.toHaveProperty('max_completion_tokens');
    const count = calls.length; for (const maxTokens of [0,-1,384001,1.5,Number.NaN]) await expect(provider.chat([message], { model: flash, maxTokens })).rejects.toThrow('Invalid Fireworks output limit.'); await expect(provider.chat([message], { model: numeric, thinking: 'high', maxTokens: 1024 })).rejects.toThrow('Invalid Fireworks output limit.'); await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Fireworks thinking level.'); expect(calls).toHaveLength(count);
  });

  it('owns one Messages versus three C affinity headers, short-only A cache and configured override priority', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of [flash,numeric,glm]) for (const cacheRetention of ['short','long','none'] as const) await provider.chat([message], { model, sessionId: 'fireworks-session', cacheRetention, systemPrompt: 'System' });
    for (const call of calls) { const a = call.body.model !== glm, none = calls.indexOf(call) % 3 === 2; expect(call.headers['x-session-affinity']).toBe(none ? undefined : 'fireworks-session'); for (const name of ['session_id','x-client-request-id']) expect(call.headers[name]).toBe(!a && !none ? 'fireworks-session' : undefined); if (a) { expect(call.body.system[0].cache_control).toEqual(none ? undefined : { type: 'ephemeral' }); expect(call.headers['anthropic-beta']).toBeUndefined(); } expect(call.body).not.toHaveProperty('prompt_cache_key'); expect(call.body).not.toHaveProperty('prompt_cache_retention'); }
    for (const model of [flash,glm]) await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([message], { sessionId: 'automatic', cacheRetention: 'none' }); expect(calls.slice(-2).map(call => call.headers['x-session-affinity'])).toEqual(['operator-owned','operator-owned']);
  });

  it('admits only declared images/models and supplied representable keys, safe shared/full endpoints and headers', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); vi.stubEnv('FIREWORKS_API_KEY','ambient-private'); vi.stubEnv('OPENAI_API_KEY','ambient-openai'); vi.stubEnv('ANTHROPIC_API_KEY','ambient-anthropic');
    for (const model of ['future','gpt-4o','MiniMax-M3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Fireworks chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Fireworks chat model is not supported.'); }
    const image: Message = { ...message, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }; for (const model of [ids[4],glm]) await expect(provider.chat([image], { model })).rejects.toThrow('Fireworks chat model does not support images.');
    for (const apiKey of [undefined,'','bad\0key','bad\nkey','bad🔑key']) { const invalid = new providers.FireworksProvider({ type: 'operator', apiKey, baseUrl }); expect(invalid.validateConfig()).toBe(false); await expect(invalid.chat([message])).rejects.toThrow('Fireworks API key is required.'); }
    for (const endpoint of ['https://user:private@host/v1','https://host/v1?private=key','https://host/v1#private','ftp://host/v1']) expect(() => new providers.FireworksProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Fireworks endpoint.'); await expect(new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Fireworks request headers.'); expect(calls).toEqual([]);
    for (const model of [flash,kimi]) await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/messages/', model }).chat([image]); expect(calls.map(call => call.url)).toEqual(['/owned%2Ffireworks/inference/v1/messages','/owned%2Ffireworks/inference/v1/chat/completions']);
    for (const profile of providers.FIREWORKS_MODELS.filter(row => row.api === 'anthropic-messages')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...message, content: 'before' }, { id: 'image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'operator', api: 'anthropic-messages', model: profile.id,
        toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { ...image, id: 'tool-image', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result' }, { ...message, id: 'after', content: 'after' }], before = structuredClone(history);
      const options = { model: profile.id, maxTokens: 4096, thinking: 'low' as const, cacheRetention: 'none' as const }, count = calls.length;
      const invoke = () => facade === 'chat' ? provider.chat(history, options) : provider.streamChat(history, () => {}, undefined, error => { throw error; }, options);
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('Fireworks chat model does not support images.'); expect(calls).toHaveLength(count); }
      else {
        await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: [{ type: 'text', text: 'called' }, { type: 'tool_use', id: 'image-call', name: 'read', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-call', content: 'result', is_error: false }] },
          { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }, { role: 'user', content: 'after' }]);
      }
      expect(history).toEqual(before);
    }
  });

  it('captures each physical API/model/price before awaited callbacks and suppresses buffered delivery after withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of [flash,glm]) { provider.setConfiguredModel(model); const seen: string[] = []; let completed: unknown; await provider.streamChat([message], async (_text,event) => { await Promise.resolve(); seen.push(event!.type); provider.setConfiguredModel(model === flash ? glm : flash); }, value => { completed = value; }); expect(seen).toEqual(model === flash ? ['message_start','reasoning_delta','text_delta'] : ['reasoning_delta','text_delta']); expect(completed).toMatchObject({ model, api: model === flash ? 'anthropic-messages' : 'openai-completions', usage: { costUsd: model === flash ? (5 * 0.3 + 2 * 1.2 + 4 * 0.006) / 1e6 : (5 * 1.4 + 2 * 4.4 + 4 * 0.26) / 1e6 } });
      const abort = new AbortController(), done = vi.fn(), failed = vi.fn(), withdrawn: string[] = []; await provider.streamChat([message], async (_text,event) => { withdrawn.push(event!.type); await Promise.resolve(); abort.abort(); }, done, failed, { model, signal: abort.signal }); expect(withdrawn).toEqual(model === flash ? ['message_start'] : ['reasoning_delta']); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Fireworks request aborted.'); }
    const values = { A: continuation.seedEvents }, replies = { A: { content: continuation.syntheticJsonContent, model: 'untrusted-response-alias', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } } }, signed = await fixture(values, replies);
    for (const facade of ['chat', 'stream']) {
      const changing = new providers.FireworksProvider({ type: 'fireworks', apiKey: 'disposable', baseUrl: signed.baseUrl, model: flash }); let reads = 0, snapshot: providers.ChatResponse | undefined;
      const probe: Message = { ...message, content: 'probe' }, selected = { get model() { return ++reads === 1 ? flash : glm; }, maxTokens: 4096, thinking: 'low' as const, cacheRetention: 'none' as const };
      if (facade === 'chat') snapshot = await changing.chat([probe], selected); else await changing.streamChat([probe], () => {}, result => { snapshot = result; }, error => { throw error; }, selected);
      expect(signed.calls.at(-1)!.body.model).toBe(flash); expect(snapshot).toMatchObject({ model: signed.calls.at(-1)!.body.model, provider: 'fireworks', api: 'anthropic-messages', blocks: continuation.expectedBlocks });
      expect(snapshot!.usage?.costUsd).toBeCloseTo((5 * 0.3 + 2 * 1.2 + 4 * 0.006) / 1e6, 12);
      const history: Message[] = [probe, { id: 'getter-a', role: 'assistant', content: snapshot!.content, timestamp: new Date(0), provider: snapshot!.provider, api: snapshot!.api, model: snapshot!.model, blocks: snapshot!.blocks, toolCalls: snapshot!.toolCalls },
        { id: 'getter-r', role: 'tool', name: 'echo', toolCallId: 'call', content: 'result', timestamp: new Date(0) }, { ...message, id: 'getter-next', content: 'continue' }], before = structuredClone(history);
      await changing.chat(history, { model: flash, maxTokens: 4096, thinking: 'low', cacheRetention: 'none' });
      expect(signed.calls.at(-1)!.body.messages).toEqual(continuation.rows.find((row: { model: string }) => row.model === flash).cases[0].expectedBody.messages);
      expect((await changing.chat(history, { model: glm, maxTokens: 4096, thinking: 'low', cacheRetention: 'none' })).blocks).toBeUndefined();
      expect(JSON.stringify(signed.calls.at(-1)!.body)).not.toMatch(/opaque-|Signature|redacted_thinking/); expect(history).toEqual(before);
    }
    const failures: Error[] = [];
    await new providers.FireworksProvider({ type: 'fireworks', apiKey: 'disposable', baseUrl: signed.baseUrl, model: flash }).streamChat([message], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_FIREWORKS_COMPLETION_FAILURE'); }, error => { failures.push(error); }, { maxTokens: 4096, thinking: 'low' });
    expect(failures.map(error => error.message)).toEqual(['Fireworks chat request failed.']);
  });

  it('requires native terminal authority, validates A carrier formats and keeps C encrypted refusal', async () => {
    const aStart = { type: 'message_start', message: { id: 'answer', content: [], usage: { input_tokens: 1 } } }, aTool = [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'read', name: 'read', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'content_block_stop', index: 0 }];
    for (const model of [flash,glm]) { const { baseUrl } = await fixture({ A: [aStart,...aTool,{ type: 'message_stop' }], C: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] } }] }] }); const chunks = vi.fn(), done = vi.fn(), failed = vi.fn(); await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model }).streamChat([message], chunks, done, failed); expect(chunks.mock.calls.map(call => call[1]?.type)).toEqual(model === flash ? ['message_start'] : []); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Invalid Fireworks chat response.'); }
    const good = await fixture({ A: [aStart,...aTool,{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },{ type: 'message_stop' }], C: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }] }); for (const model of [flash,glm]) { let result: unknown; await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl, model }).streamChat([message], () => {}, value => { result = value; }); expect(result).toMatchObject({ toolCalls: [{ id: 'read', input: {} }] }); }
    const bad = await fixture(undefined, { A: { content: [{ type: 'thinking', thinking: 'Thought', signature: 42 }], stop_reason: 'end_turn' }, C: { choices: [{ message: { content: 'Ready', reasoning_details: [{ type: 'encrypted', data: 'private' }] }, finish_reason: 'stop' }] } }); for (const model of [flash,glm]) await expect(new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl, model }).chat([message])).rejects.toThrow('Unsupported Fireworks reasoning replay.');
    const replay = await fixture(), assistant: Message = { ...message, id: 'assistant', role: 'assistant', content: 'Earlier', blocks: [{ type: 'reasoning', text: 'Earlier thought' },{ type: 'text', text: 'Earlier' }] }; await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl: replay.baseUrl, model: kimi }).chat([assistant,message], { thinking: 'high' }); expect(replay.calls[0].body.messages[0].reasoning_content).toBe('Earlier thought');
  });

  it('merges partial native A usage without losing counters and never fabricates usage from invalid A/C envelopes', async () => {
    const start = { type: 'message_start', message: { id: 'answer', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }, partial = await fixture({ A: [start,{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: null, output_tokens: 2, cache_read_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: 1 } } },{ type: 'message_stop' }] }); let result: unknown; await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl: partial.baseUrl, model: flash }).streamChat([message], () => {}, value => { result = value; }); expect(result).toMatchObject({ usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.3 + 2 * 1.2 + 4 * 0.006 + 0.6) / 1e6 } });
    for (const model of [flash,glm]) for (const invalid of [0,1]) { const bad = await fixture(undefined, { A: { content: [{ type: 'text', text: 'Ready' }], stop_reason: 'end_turn', usage: invalid === 0 ? { input_tokens: 5 } : { input_tokens: -1, output_tokens: 2 } }, C: { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage: invalid === 0 ? { prompt_tokens: 10 } : { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } } } }); expect((await new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl, model }).chat([message])).usage).toBeUndefined(); }
  });

  it.each(continuationModels)('captures and replays independently bound private A JSON/SSE arrays for %s', async model => {
    const reference = continuation.rows.find((row: { model: string }) => row.model === model); expect(reference).toBeDefined();
    expect(continuation.freshSdkRequests).toBe(182); expect(continuation.replayProjections).toBe(168); expect(continuation.unexecutedOtherProfiles).toBe(8);
    const events: { A?: unknown[]; C?: unknown[] } = { A: continuation.seedEvents }, replies: { A?: Record<string, unknown>; C?: Record<string, unknown> } = {};
    const seedReply = { model: 'untrusted-response-alias', stop_reason: 'tool_use', content: continuation.syntheticJsonContent, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.FireworksProvider({ type: 'fireworks', apiKey: 'disposable-fireworks-private', model, baseUrl });
      const options = { maxTokens: 4096, thinking: 'low' as const, cacheRetention: 'none' as const, systemPrompt: 'owned Fireworks reference system', tools: continuation.tools };
      const expectedBody = (body: Record<string, any>) => ({ ...structuredClone(body), stream: facade === 'stream' });
      const invoke = async (messages: Message[], requestOptions: providers.ChatOptions = options) => { if (facade === 'chat') return provider.chat(messages, requestOptions); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text).not.toContain('PRIVATE_FIREWORKS_HEADER'); expect(JSON.stringify(event ?? {})).not.toContain('PRIVATE_FIREWORKS_HEADER'); }, response => { complete = response; }, error => { throw error; }, requestOptions); expect(complete).toBeDefined(); return complete!; };
      events.A = continuation.seedEvents.map((event: Record<string, any>) => event.type === 'message_start' ? { ...event, message: { ...event.message, content: [{ type: 'text', text: 'PRIVATE_FIREWORKS_HEADER' }] } } : event); replies.A = seedReply;
      const user: Message = { ...message, content: 'probe' }, initial = structuredClone([user]), captured = await invoke(initial);
      expect(captured).toMatchObject({ provider: 'fireworks', api: 'anthropic-messages', model, content: 'left!right?', toolCalls: [{ id: 'call', name: 'echo', input: { x: 1 } }] });
      expect(captured.blocks).toEqual(continuation.expectedBlocks); expect(initial).toEqual([user]); expect(calls.at(-1)!.body).toEqual(expectedBody(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const assistant: Message = { id: 'a', role: 'assistant', content: captured.content, timestamp: new Date(0), provider: projection.source.provider, api: projection.source.api,
          model: projection.source.model, blocks: structuredClone(captured.blocks), toolCalls: structuredClone(captured.toolCalls) };
        const thought = assistant.blocks!.find(block => block.type === 'reasoning' && !block.redacted)!; if (thought.type !== 'reasoning') throw new Error('Missing reference reasoning');
        if (projection.case === 'unsigned') delete thought.thinkingSignature; if (projection.case === 'empty-thinking') thought.text = ''; if (projection.case === 'blank-thinking') thought.text = ' \t';
        if (projection.case === 'empty-signature') thought.thinkingSignature = ''; if (projection.case === 'blank-signature') thought.thinkingSignature = ' \t';
        if (projection.case.startsWith('failed-')) assistant.metadata = { outputError: 'Failed Fireworks producer' };
        const results: Message[] = projection.case.startsWith('failed-') ? [] : [{ id: 'r', role: 'tool', name: 'echo', toolCallId: 'call', content: 'result', timestamp: new Date(0) }];
        const history: Message[] = [user, assistant, ...results, { ...message, id: 'next', content: 'continue' }], before = structuredClone(history);
        events.A = projection.responseEvents; replies.A = { ...seedReply, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
        expect(await invoke(history)).toMatchObject({ provider: 'fireworks', api: 'anthropic-messages', model, content: 'ok' });
        expect(calls.at(-1)!.body).toEqual(expectedBody(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined });
      expect(calls.at(-1)!.body).toEqual({ ...expectedBody(reference.expectedInitialBody), system: [{ type: 'text', text: 'Leading system' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expectedBody(reference.expectedInitialBody), system: [{ type: 'text', text: 'owned Fireworks reference system\n\nLeading system' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-fireworks-replay-')), redactor = new CredentialRedactor(['opaque-signature', 'disposable-fireworks-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Fireworks replay' }), registry = new ExtensionRegistry();
      let effects = 0;
      const finalContent = [{ type: 'text', text: 'ok' }], finalReply = { ...seedReply, stop_reason: 'end_turn', content: finalContent };
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.A = reference.cases[0].responseEvents; replies.A = finalReply; return { content: 'result' }; } }));
      events.A = continuation.seedEvents; replies.A = seedReply;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'fireworks', tools: continuation.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'fireworks', model, messages,
            tools: continuation.tools, extensionRegistry: registry, maxRetries: 0, maxTokens: 4096, thinking: 'low', cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1);
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant');
        expect(history.map(item => item.blocks)).toEqual([redactJson(continuation.expectedBlocks), finalContent]);
        expect(bytes).not.toContain('opaque-signature'); expect(bytes).not.toContain('disposable-fireworks-private'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-');
        expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain('opaque-signature');
        const same = reference.cases[0].expectedBody.messages.filter((item: Record<string, any>) => item.role === 'assistant'), finalMessage = { role: 'assistant', content: finalContent };
        const native = () => calls.at(-1)!.body.messages.filter((item: Record<string, any>) => item.role === 'assistant');
        const results = () => calls.at(-1)!.body.messages.flatMap((item: Record<string, any>) => Array.isArray(item.content) ? item.content.filter((block: Record<string, any>) => block.type === 'tool_result') : []);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same), finalMessage]); expect(results()).toEqual([{ type: 'tool_result', tool_use_id: 'call', content: 'result', is_error: false }]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        expect(native()).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }, { type: 'text', text: 'edited answer' }] }, finalMessage]);
        expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_FIREWORKS_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy();
        const compacted = getCompactionModelMessages(compactedManager, clone.id); expect(compacted.some(item => item.content.includes('PUBLIC_FIREWORKS_COMPACTED_PREFIX'))).toBe(true);
        expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalContent]); expect(compacted.filter(item => item.role === 'tool')).toEqual([]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        expect((await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(native()).toEqual([finalMessage]); expect(results()).toEqual([]);
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(40); for (const call of calls) { expect(call.url).toBe('/owned%2Ffireworks/inference/v1/messages'); expect(call.headers['x-api-key']).toBe('disposable-fireworks-private'); expect(call.headers.authorization).toBeUndefined(); expect(call.headers['anthropic-version']).toBe('2023-06-01'); }
  });

  it('keeps only configured512-token virtual classifiers with API-specific accounting and no image generation', async () => {
    const { baseUrl } = await fixture();
    for (const model of [flash,glm]) { const provider = new providers.FireworksProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model }); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${model}:classifier`, virtual: true, api: model === flash ? 'anthropic-messages' : 'openai-completions', imageInput: model === flash }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]); await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.'); let body: Record<string, any> = {};
      vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(model === flash ? { content: [{ type: 'text', text: '{"label":"safe"}' }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4 } } : { choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })); }); expect(await new SpecializedModels(provider).classify({ model: `${model}:classifier`, input: 'Approve', labels: ['safe','review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: model === flash ? (6 * 0.3 + 2 * 1.2 + 4 * 0.006) / 1e6 : (6 * 1.4 + 2 * 4.4 + 4 * 0.26) / 1e6 } }); expect(body[model === flash ? 'max_tokens' : 'max_completion_tokens']).toBe(512);
    }
  });
});
