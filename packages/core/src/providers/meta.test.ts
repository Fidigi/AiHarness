import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { serializeSessionForExport } from '../sessions/serialization.js';
import { getCompactionModelMessages } from '../sessions/compaction-model-messages.js';
import { getSummaryModelMessages } from '../sessions/summary-model-messages.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { CredentialRedactor } from './credentials.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const ids = ['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.2-contributor', 'muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-wonder-1.0'];
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const replayReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/meta-continuation-reference.json', import.meta.url), 'utf8'));
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const state = { json: false, invalid: false, events: undefined as Record<string, any>[] | undefined, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    if (state.invalid) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'private-invalid', message: 'private disposable-meta failure' } })); return; }
    if (state.events) { response.setHeader('content-type', 'text/event-stream'); response.end(state.events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')); return; }
    const system = [body.instructions ?? '', ...body.input.filter((item: { role?: string }) => ['developer', 'system'].includes(item.role ?? '')).map((item: { content: string }) => item.content)].join('\n');
    const content = system.includes('Classify the user input') ? JSON.stringify({ label: 'safe' }) : 'Ready';
    const terminal = { id: 'response-1', status: 'completed', usage: state.usage, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] };
    if (state.json) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(terminal)); }
    else { response.setHeader('content-type', 'text/event-stream'); response.end([{ type: 'response.reasoning_summary_text.delta', delta: 'Thought' }, { type: 'response.output_text.delta', delta: content }, { type: 'response.completed', response: terminal }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, state, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fmeta/v1` };
}

describe('explicit native Meta Responses SDK', () => {
  it('leaves generic Responses policy distinct from native Meta declarations', async () => {
    const { calls, state, baseUrl } = await fixture();
    await new providers.OpenAiResponsesProvider({ type: 'meta', apiKey: 'disposable', baseUrl, model: ids[0], transport: 'sse' }).chat([input], { thinking: 'off', maxTokens: 1, systemPrompt: 'System', sessionId: 'generic', cacheRetention: 'long' });
    expect(calls[0].body).toMatchObject({ max_output_tokens: 1, instructions: 'System', store: false });
    expect(calls[0].body).not.toHaveProperty('reasoning'); expect(calls[0].body).not.toHaveProperty('include'); expect(calls[0].body).not.toHaveProperty('prompt_cache_key');
    class DerivedMeta extends providers.MetaProvider {}
    state.events = replayReference.rows[0].initialEvents;
    const forged: Message = { id: 'forged', role: 'assistant', content: 'answer', timestamp: new Date(0), provider: 'meta', api: 'openai-responses', model: ids[0],
      blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: JSON.stringify(replayReference.items[0]) }, { type: 'text', text: 'answer', textSignature: 'msg_forged' }] };
    for (const provider of [new providers.OpenAiResponsesProvider({ type: 'meta', apiKey: 'disposable', baseUrl, model: ids[0], transport: 'sse' }),
      new DerivedMeta({ type: 'meta', apiKey: 'disposable', baseUrl, model: ids[0] })]) {
      expect((await provider.chat([input], { maxTokens: 64 })).blocks).toBeUndefined();
      await provider.chat([input, forged, input], { maxTokens: 64 });
      expect(calls.at(-1)!.body.input).toEqual([{ role: 'user', content: 'Continue' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'Continue' }]);
    }
  });

  it('publishes six immutable profiles and defensive physical metadata with unknown Wonder prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MetaProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(providers.META_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.META_MODELS)).toBe(true);
    expect(providers.META_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.declaredPricing) && (!profile.pricing || Object.isFrozen(profile.pricing)) && Object.isFrozen(profile.thinkingLevelMap) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.declaredInputLimits.images.resize))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(ids[0]); expect(providers.ProviderFactory.has('meta')).toBe(false);
    const row = getProviderPublishedModel('anthropic', ids[3], provider)!;
    expect(row).toMatchObject({ name: 'Muse Spark 1.3', api: 'openai-responses', contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 1.25, outputPerMillion: 4.25, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'changed';
    expect(getProviderPublishedModel('anthropic', ids[3], provider)).toMatchObject({ contextWindow: 1048576, thinkingLevelMap: { high: 'high' } }); expect(getProviderPublishedModel('anthropic', 'gpt-4o', provider)).toBeUndefined();
    expect(getProviderPublishedModel('anthropic', ids[5], provider)?.pricing).toBeUndefined();
    expect(providers.META_MODELS[5].declaredPricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 });
    for (const id of ids) expect(getSupportedThinkingLevels('anthropic', id, undefined, provider)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', ...([ids[3], ids[5]].includes(id) ? ['max'] : [])]);
    expect(getSupportedThinkingLevels('anthropic', 'gpt-4o', undefined, provider)).toEqual(['off']);
    const catalog = await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }); expect(catalog[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${ids[0]}:classifier`, virtual: true, api: 'openai-responses', contextWindow: 1048576, imageInput: true }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
  });

  it('owns developer roles, output floor, include, non-strict tools and native long-cache defaults independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['anthropic', 'azure', 'operator-meta']) {
      const provider = new providers.MetaProvider({ type, apiKey: 'disposable-meta', baseUrl: baseUrl + '/responses', model: ids[0] });
      expect(await provider.chat([input], { thinking: 'off', maxTokens: 1, systemPrompt: 'System', sessionId: 'meta-session', cacheRetention: 'long', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: ids[0], api: 'openai-responses', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 1.25 + 2 * 4.25 + 4 * 0.15) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fmeta/v1/responses'); expect(call.headers.authorization).toBe('Bearer disposable-meta'); expect(call.headers.session_id).toBe('meta-session'); expect(call.headers['x-client-request-id']).toBe('meta-session'); expect(call.headers['session-id']).toBeUndefined(); expect(call.headers['api-key']).toBeUndefined(); expect(call.headers['nvcf-poll-seconds']).toBeUndefined();
      expect(call.body).toMatchObject({ stream: true, store: false, max_output_tokens: 16, reasoning: { effort: 'minimal', summary: 'auto' }, include: ['reasoning.encrypted_content'], input: [{ role: 'developer', content: 'System' }, { role: 'user' }], prompt_cache_key: 'meta-session', prompt_cache_retention: '24h', tools: [{ type: 'function', strict: false }] });
      for (const field of ['instructions', 'prompt_cache_options', 'service_tier', 'thinking']) expect(call.body).not.toHaveProperty(field);
    }
  });

  it('clamps all six maps and preserves exact allowed output caps, ordinary omission and no-cache authority', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MetaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ids) for (const thinking of levels) {
      await provider.chat([input], { model, thinking, maxTokens: 64 });
      const selected = thinking === 'off' ? 'minimal' : thinking === 'max' && ![ids[3], ids[5]].includes(model) ? 'xhigh' : thinking;
      expect(calls.at(-1)!.body.reasoning).toEqual({ effort: selected, summary: 'auto' }); expect(calls.at(-1)!.body.max_output_tokens).toBe(64);
    }
    await provider.chat([input], { sessionId: '🙂'.repeat(70), cacheRetention: 'long' }); expect(calls.at(-1)!.body.prompt_cache_key).toBe('🙂'.repeat(64)); expect(calls.at(-1)!.body.prompt_cache_retention).toBe('24h'); expect(calls.at(-1)!.body.max_output_tokens).toBeUndefined();
    await provider.chat([input], { sessionId: 'not-affinity', cacheRetention: 'none' }); for (const field of ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options']) expect(calls.at(-1)!.body).not.toHaveProperty(field); expect(calls.at(-1)!.headers.session_id).toBeUndefined(); expect(calls.at(-1)!.headers['x-client-request-id']).toBeUndefined();
  });

  it('uses genuine disjoint R counters and physical base prices without declaring zero-only Wonder free', async () => {
    const { state, baseUrl } = await fixture(), provider = new providers.MetaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const rates = [[1.25, 4.25, 0.15], [1.25, 4.25, 0.15], [0.1, 0.2, 0.002], [1.25, 4.25, 0.15], [0.1, 0.2, 0.002]];
    for (const [index, model] of ids.entries()) {
      const result = await provider.chat([input], { model }); expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 });
      if (index === 5) expect(result.usage!.costUsd).toBeUndefined(); else expect(result.usage!.costUsd).toBeCloseTo((5 * rates[index][0] + 2 * rates[index][1] + 4 * rates[index][2]) / 1e6, 12);
    }
    state.usage = { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    expect((await provider.chat([input], { model: ids[0] })).usage?.costUsd).toBe(0); expect((await provider.chat([input], { model: ids[5] })).usage?.costUsd).toBeUndefined();
    state.usage.input_tokens_details.cached_tokens = 1; expect((await provider.chat([input])).usage).toBeUndefined();
  });

  it.each(ids)('captures and replays exact native Meta private items on both facades for %s', async model => {
    const reference = replayReference.rows.find((row: { model: string }) => row.model === model), { calls, state, baseUrl } = await fixture();
    expect(reference).toBeDefined(); expect(replayReference.sdkRequests).toBe(48); expect(replayReference.replayProjections).toBe(42);
    const expectedBody = (body: Record<string, any>) => ({ ...structuredClone(body),
      input: body.input.map((item: Record<string, any>) => item.role === 'user' && Array.isArray(item.content) && item.content.length === 1 && item.content[0].type === 'input_text' ? { ...item, content: item.content[0].text } : item),
      tools: body.tools.map((tool: Record<string, any>) => ({ ...tool, strict: false })), tool_choice: 'auto' });
    const expectedBlocks = reference.first.content.map((block: Record<string, any>) => block.type === 'thinking'
      ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
      : block.type === 'toolCall' ? { type: 'tool_call', id: block.id, name: block.name, input: block.arguments } : block);
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.MetaProvider({ type: 'meta', apiKey: 'disposable-meta-private', baseUrl, model });
      const options = { maxTokens: 64, thinking: 'low' as const, cacheRetention: 'none' as const, systemPrompt: 'Public Meta system', tools: replayReference.tools };
      const invoke = async (messages: Message[]) => {
        if (facade === 'chat') return provider.chat(messages, options);
        let final: providers.ChatResponse | undefined;
        await provider.streamChat(messages, () => {}, response => { final = response; }, error => { throw error; }, options);
        expect(final).toBeDefined(); return final!;
      };
      const user: Message = { ...input, content: 'probe' }, initial = structuredClone([user]); state.events = reference.initialEvents;
      const first = await invoke(initial); expect(first).toMatchObject({ provider: 'meta', api: 'openai-responses', model, content: 'leftright',
        toolCalls: [{ id: 'call_native|fc_native', name: 'echo', input: { x: 1 } }], usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
      expect(first.blocks).toEqual(expectedBlocks); expect(initial).toEqual([user]); expect(calls.at(-1)!.body).toEqual(expectedBody(reference.expectedInitialBody));
      for (const projection of reference.projections) {
        const assistant: Message = { id: 'native', role: 'assistant', timestamp: new Date(0), content: first.content,
          provider: projection.source.provider, api: projection.source.api, model: projection.source.model, blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls) };
        if (projection.case === 'failed') assistant.metadata = { outputError: 'Failed Meta producer' };
        if (projection.case === 'expurgated') for (const block of assistant.blocks ?? []) { if (block.type === 'text') delete block.textSignature; if (block.type === 'reasoning') delete block.thinkingSignature; }
        const results: Message[] = projection.case === 'failed' ? [] : [{ id: 'result', role: 'tool', name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(0) }];
        const messages: Message[] = [user, assistant, ...results, { ...input, id: 'next', content: 'continue' }], before = structuredClone(messages); state.events = projection.responseEvents;
        expect(await invoke(messages)).toMatchObject({ provider: 'meta', api: 'openai-responses', model, content: 'ok' });
        expect(calls.at(-1)!.body).toEqual(expectedBody(projection.expectedBody)); expect(messages).toEqual(before);
      }
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-meta-replay-')), redactor = new CredentialRedactor(['sensitive', 'disposable-meta-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Meta replay' }), registry = new ExtensionRegistry();
      let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; state.events = reference.projections[0].responseEvents; return { content: 'result' }; } }));
      state.events = reference.initialEvents;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'meta', tools: replayReference.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'meta', model, messages,
            tools: replayReference.tools, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: 'low', cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1);
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(message => message.role === 'assistant');
        expect(history.map(message => message.blocks)).toEqual([redactJson(expectedBlocks), reference.projections[0].second.content]);
        expect(bytes).not.toContain('sensitive'); expect(bytes).not.toContain('disposable-meta-private'); expect(bytes).toContain('opaque-meta-[REDACTED]-tail'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-meta-');
        expect(JSON.stringify(complete.session)).toContain('opaque-meta-[REDACTED]-tail'); expect(JSON.stringify(complete.session)).not.toContain('sensitive');
        const same = reference.projections[0].expectedBody.input.filter((item: Record<string, any>) => ['reasoning', 'message', 'function_call'].includes(item.type));
        const finalItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }], status: 'completed', id: 'msg_ok', phase: 'final_answer' };
        const native = () => calls.at(-1)!.body.input.filter((item: Record<string, any>) => ['reasoning', 'message', 'function_call'].includes(item.type));
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same), finalItem]);
        expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => item.type === 'function_call_output')).toEqual([{ type: 'function_call_output', call_id: 'call_native', output: 'result' }]);
        expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        expect(native()).toEqual([{ type: 'function_call', call_id: 'call_native', id: 'fc_native', name: 'echo', arguments: '{"x":1}' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'edited answer', annotations: [] }], status: 'completed', id: 'msg_pi_1' }, finalItem]);
        expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(message => message.blocks));
        expect(clone.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-meta-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(message => message.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_META_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy();
        const compacted = getCompactionModelMessages(compactedManager, clone.id); expect(compacted.some(message => message.content.includes('PUBLIC_META_COMPACTED_PREFIX'))).toBe(true);
        expect(compacted.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([reference.projections[0].second.content]); expect(compacted.filter(message => message.role === 'tool')).toEqual([]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        expect((await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(message => message.blocks));
        await invoke(compacted); expect(native()).toEqual([finalItem]); expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => item.type === 'function_call_output')).toEqual([]);
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(26); for (const call of calls) { expect(call.url).toBe('/owned%2Fmeta/v1/responses'); expect(call.headers.authorization).toBe('Bearer disposable-meta-private'); expect(call.headers['api-key']).toBeUndefined(); }
  });

  it('keeps the shared JSON reply opt-in exclusive to reviewed xAI and all Meta requests stream true', async () => {
    const { calls, state, baseUrl } = await fixture(), provider = new providers.MetaProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    state.json = true; await expect(provider.chat([input])).rejects.toThrow('Meta response request failed.'); expect(calls[0].body.stream).toBe(true);
  });

  it('refuses unsupported configuration before I/O and keeps private remote failures body-free', async () => {
    const { calls, state, baseUrl } = await fixture(), provider = new providers.MetaProvider({ type: 'operator', apiKey: 'disposable-meta', baseUrl });
    for (const model of ['future', 'gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('Meta response model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Meta response model is not supported.'); }
    for (const maxTokens of [0, -1, 131073, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Meta output limit.');
    for (const base of ['file:///private', 'https://private:token@example.test/v1', baseUrl + '?secret=private', baseUrl + '#private']) expect(() => new providers.MetaProvider({ type: 'x', apiKey: 'disposable', baseUrl: base })).toThrow('Invalid Meta endpoint.');
    await expect(new providers.MetaProvider({ type: 'x', baseUrl }).chat([input])).rejects.toThrow('Meta API key is required.'); expect(calls).toEqual([]);
    state.invalid = true; await expect(provider.chat([input])).rejects.toThrow('Meta response request failed.'); expect(calls).toHaveLength(1);
  });

  it('captures physical prices and provenance before callback mutation and suppresses buffered output after withdrawal', async () => {
    const { baseUrl, state, calls } = await fixture(), provider = new providers.MetaProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl }), completions: providers.ChatResponse[] = [];
    await provider.streamChat([input], async (_text, event) => { if (event?.type === 'reasoning_delta') provider.setConfiguredModel(ids[5]); }, result => { if (result) completions.push(result); }, error => { throw error; });
    expect(completions).toMatchObject([{ provider: 'anthropic', api: 'openai-responses', model: ids[0], usage: { costUsd: (5 * 1.25 + 2 * 4.25 + 4 * 0.15) / 1e6 } }]); expect(provider.getConfiguredModel()).toBe(ids[5]);
    const controller = new AbortController(), events: string[] = [], errors: Error[] = [];
    await provider.streamChat([input], async (_text, event) => { events.push(event?.type ?? ''); await Promise.resolve(); controller.abort(); }, () => { events.push('complete'); }, error => { errors.push(error); }, { signal: controller.signal });
    expect(events).toEqual(['reasoning_delta']); expect(errors).toHaveLength(1); expect(errors[0].message).toBe('Meta request aborted.');
    state.events = replayReference.rows[0].initialEvents; const completionErrors: Error[] = [];
    await new providers.MetaProvider({ type: 'meta', apiKey: 'disposable', baseUrl }).streamChat([input], () => {}, async () => {
      await Promise.resolve(); throw new Error('PRIVATE_META_COMPLETION_FAILURE');
    }, error => { completionErrors.push(error); });
    expect(completionErrors.map(error => error.message)).toEqual(['Meta response request failed.']);
    let reads = 0; const selected: providers.ChatResponse[] = [], changing = new providers.MetaProvider({ type: 'meta', apiKey: 'disposable', baseUrl });
    await changing.streamChat([input], () => {}, response => { if (response) selected.push(response); }, error => { throw error; }, {
      get model() { return ++reads <= 2 ? ids[0] : ids[2]; }, thinking: 'low', maxTokens: 64,
    });
    expect(calls.at(-1)!.body.model).toBe(ids[2]); expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ provider: 'meta', api: 'openai-responses', model: calls.at(-1)!.body.model });
    expect(selected[0].blocks).toBeDefined(); expect(selected[0].usage?.costUsd).toBeCloseTo((0.1 + 2 * 0.2) / 1e6, 12);
    const history: Message[] = [input, { id: 'a', role: 'assistant', timestamp: new Date(0), content: selected[0].content,
      provider: selected[0].provider, api: selected[0].api, model: selected[0].model, blocks: selected[0].blocks, toolCalls: selected[0].toolCalls },
      { id: 'r', role: 'tool', name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(0) }, { ...input, id: 'next' }];
    await changing.chat(history, { model: ids[2], maxTokens: 64 });
    expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => ['reasoning', 'message', 'function_call'].includes(item.type)))
      .toEqual(replayReference.rows[2].projections[0].expectedBody.input.filter((item: Record<string, any>) => ['reasoning', 'message', 'function_call'].includes(item.type)));
    await changing.chat(history, { model: ids[0], maxTokens: 64 }); expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => item.type === 'reasoning')).toEqual([]);
    expect(JSON.stringify(calls.at(-1)!.body.input)).not.toContain('opaque-meta-');
  });

  it('exposes only the configured virtual classifier with its unchanged explicit512 cap and unknown Wonder cost', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MetaProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: ids[5] });
    const result = await new SpecializedModels(provider).classify({ model: `${ids[5]}:classifier`, input: 'Approved', labels: ['safe', 'review'] }); expect(result.label).toBe('safe'); expect(result.usage?.totalTokens).toBe(12); expect(result.usage?.costUsd).toBeUndefined(); expect(calls).toHaveLength(1); expect(calls[0].body).toMatchObject({ model: ids[5], max_output_tokens: 512, reasoning: { effort: 'minimal', summary: 'auto' }, include: ['reasoning.encrypted_content'] });
    expect(new SpecializedModels(provider).getModelsOfType('classifier')).toHaveLength(1); expect(providers.ProviderFactory.has('meta')).toBe(false);
    await expect(provider.generateImages({ model: 'muse-image', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });
});
