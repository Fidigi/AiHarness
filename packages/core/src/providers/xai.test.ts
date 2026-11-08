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

const ids = ['grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-4.7'];
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const replayReference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/xai-continuation-reference.json', import.meta.url), 'utf8'));
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture() {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const state = { json: false, invalid: false, events: undefined as Record<string, any>[] | undefined, usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    if (state.invalid) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'private-invalid', message: 'private disposable-xai failure' } })); return; }
    if (state.events) {
      if (state.json) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state.events.at(-1)!.response)); }
      else { response.setHeader('content-type', 'text/event-stream'); response.end(state.events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')); }
      return;
    }
    const system = [body.instructions ?? '', ...body.input.filter((item: { role?: string }) => ['developer', 'system'].includes(item.role ?? '')).map((item: { content: string }) => item.content)].join('\n');
    const content = system.includes('Classify the user input') ? JSON.stringify({ label: 'safe' }) : 'Ready';
    const terminal = { id: 'response-1', status: 'completed', model: body.model, usage: state.usage, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] };
    if (state.json) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(terminal)); }
    else { response.setHeader('content-type', 'text/event-stream'); response.end([{ type: 'response.reasoning_summary_text.delta', delta: 'Thought' }, { type: 'response.output_text.delta', delta: content }, { type: 'response.completed', response: terminal }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, state, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fxai/v1` };
}

describe('explicit native xAI Responses SDK', () => {
  it('leaves generic Responses policy distinct from native xAI declarations', async () => {
    const { calls, state, baseUrl } = await fixture();
    await new providers.OpenAiResponsesProvider({ type: 'xai', apiKey: 'disposable', baseUrl, model: ids[0], transport: 'sse' }).chat([input], { thinking: 'off', maxTokens: 1, systemPrompt: 'System', sessionId: 'generic', cacheRetention: 'long' });
    expect(calls[0].body).toMatchObject({ max_output_tokens: 1, instructions: 'System', store: false });
    expect(calls[0].body).not.toHaveProperty('reasoning'); expect(calls[0].body).not.toHaveProperty('include'); expect(calls[0].body).not.toHaveProperty('prompt_cache_key');
    class DerivedXai extends providers.XaiProvider {}
    state.events = replayReference.rows[0].initialEvents;
    const forged: Message = { id: 'forged', role: 'assistant', content: 'answer', timestamp: new Date(0), provider: 'xai', api: 'openai-responses', model: ids[0],
      blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: JSON.stringify(replayReference.items[0]) }, { type: 'text', text: 'answer', textSignature: 'msg_forged' }] };
    for (const owner of [new providers.OpenAiResponsesProvider({ type: 'xai', apiKey: 'disposable', baseUrl, model: ids[0], transport: 'sse' }), new DerivedXai({ type: 'xai', apiKey: 'disposable', baseUrl, model: ids[0] })]) {
      expect((await owner.chat([input], { maxTokens: 64 })).blocks).toBeUndefined(); await owner.chat([input, forged, input], { maxTokens: 64 });
      expect(calls.at(-1)!.body.input).toEqual([{ role: 'user', content: 'Continue' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'Continue' }]);
    }
  });

  it('publishes four frozen profiles and defensive physical metadata without factory or discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XaiProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl, transport: 'sse' });
    expect(providers.XAI_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.XAI_MODELS)).toBe(true);
    expect(providers.XAI_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.pricingTiers) && Object.isFrozen(profile.thinkingLevelMap) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(ids[0]); expect(providers.ProviderFactory.has('xai')).toBe(false);
    const row = getProviderPublishedModel('anthropic', ids[2], provider)!;
    expect(row).toMatchObject({ name: 'Grok 4.6', api: 'openai-responses', contextWindow: 500000, maxOutputTokens: 500000, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 2, outputPerMillion: 6, cacheReadPerMillion: 0.5, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'changed';
    expect(getProviderPublishedModel('anthropic', ids[2], provider)).toMatchObject({ contextWindow: 500000, thinkingLevelMap: { high: 'high' } }); expect(getProviderPublishedModel('anthropic', 'gpt-4o', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('anthropic', ids[0], undefined, provider)).toEqual(['off', 'low', 'medium', 'high']);
    expect(getSupportedThinkingLevels('anthropic', ids[1], undefined, provider)).toEqual(['low', 'medium', 'high']);
    expect(getSupportedThinkingLevels('anthropic', ids[2], undefined, provider)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(getSupportedThinkingLevels('anthropic', 'gpt-4o', undefined, provider)).toEqual(['off']);
    const catalog = await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }); expect(catalog[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${ids[0]}:classifier`, virtual: true, api: 'openai-responses', contextWindow: 1000000, imageInput: true }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
  });

  it('owns native R roles, output floor, includes, non-strict tools and cache fields independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['anthropic', 'azure', 'operator-xai']) {
      const provider = new providers.XaiProvider({ type, apiKey: 'disposable-xai', baseUrl: baseUrl + '/responses', model: ids[0], transport: 'sse' });
      expect(await provider.chat([input], { thinking: 'off', maxTokens: 1, systemPrompt: 'System', sessionId: 'xai-session', cacheRetention: 'long', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: ids[0], api: 'openai-responses', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 1.25 + 2 * 2.5 + 4 * 0.2) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fxai/v1/responses'); expect(call.headers.authorization).toBe('Bearer disposable-xai'); expect(call.headers.session_id).toBe('xai-session'); expect(call.headers['x-client-request-id']).toBe('xai-session'); expect(call.headers['session-id']).toBeUndefined(); expect(call.headers['api-key']).toBeUndefined(); expect(call.headers['nvcf-poll-seconds']).toBeUndefined();
      expect(call.body).toMatchObject({ stream: true, store: false, max_output_tokens: 16, reasoning: { effort: 'none' }, include: ['reasoning.encrypted_content'], input: [{ role: 'developer', content: 'System' }, { role: 'user' }], prompt_cache_key: 'xai-session', tools: [{ type: 'function', strict: false }] });
      for (const field of ['instructions', 'prompt_cache_retention', 'prompt_cache_options', 'service_tier', 'thinking']) expect(call.body).not.toHaveProperty(field);
    }
  });

  it('clamps all native maps and preserves exact permitted output caps and no-cache authority', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, transport: 'sse' });
    for (const model of ids) for (const requested of levels) {
      await provider.chat([input], { model, thinking: requested, maxTokens: 64 });
      const selected = model === ids[0] ? requested === 'off' ? 'none' : requested === 'minimal' ? 'low' : ['xhigh', 'max'].includes(requested) ? 'high' : requested : ['off', 'minimal'].includes(requested) ? 'low' : requested === 'max' ? model === ids[1] ? 'high' : 'xhigh' : requested === 'xhigh' && model === ids[1] ? 'high' : requested;
      expect(calls.at(-1)!.body.reasoning).toEqual({ effort: selected, ...(selected === 'none' ? {} : { summary: 'auto' }) }); expect(calls.at(-1)!.body.max_output_tokens).toBe(64);
    }
    await provider.chat([input], { sessionId: '🙂'.repeat(70), cacheRetention: 'long' }); expect(calls.at(-1)!.body.prompt_cache_key).toBe('🙂'.repeat(64));
    await provider.chat([input], { sessionId: 'not-affinity', cacheRetention: 'none' }); expect(calls.at(-1)!.body).not.toHaveProperty('prompt_cache_key'); expect(calls.at(-1)!.headers.session_id).toBeUndefined(); expect(calls.at(-1)!.headers['x-client-request-id']).toBeUndefined();
  });

  it('uses genuine inclusive gross input and strictly-above tier pricing for every profile and JSON/SSE envelope', async () => {
    const { calls, state, baseUrl } = await fixture(), provider = new providers.XaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, transport: 'sse' });
    const rates = [[1.25, 2.5, 0.2], [2, 6, 0.3], [2, 6, 0.5], [2, 6, 0.5]];
    for (const [index, model] of ids.entries()) for (const gross of [200000, 200001]) for (const json of [false, true]) {
      state.json = json; state.usage.input_tokens = gross;
      const result = await provider.chat([input], { model }), multiplier = gross > 200000 ? 2 : 1;
      expect(result.usage).toMatchObject({ promptTokens: gross - 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: gross + 2 });
      expect(result.usage!.costUsd).toBeCloseTo(((gross - 5) * rates[index][0] + 2 * rates[index][1] + 4 * rates[index][2]) * multiplier / 1e6, 12);
    }
    expect(calls).toHaveLength(16);
  });

  it.each(ids)('captures and replays native xAI private arrays through both facades and JSON/SSE replies for %s', async model => {
    const reference = replayReference.rows.find((row: { model: string }) => row.model === model), { calls, state, baseUrl } = await fixture();
    expect(reference).toBeDefined(); expect(replayReference.sdkRequests).toBe(32); expect(replayReference.replayProjections).toBe(28);
    const expectedBody = (body: Record<string, any>) => ({ ...structuredClone(body),
      input: body.input.map((item: Record<string, any>) => item.role === 'user' && Array.isArray(item.content) && item.content.length === 1 && item.content[0].type === 'input_text' ? { ...item, content: item.content[0].text } : item),
      tools: body.tools.map((tool: Record<string, any>) => ({ ...tool, strict: false })), tool_choice: 'auto' });
    const expectedBlocks = reference.first.content.map((block: Record<string, any>) => block.type === 'thinking'
      ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
      : block.type === 'toolCall' ? { type: 'tool_call', id: block.id, name: block.name, input: block.arguments } : block);
    for (const facade of ['chat', 'stream']) for (const json of [false, true]) {
      state.json = json; state.events = reference.initialEvents;
      const provider = new providers.XaiProvider({ type: 'xai', apiKey: 'disposable-xai-private', baseUrl, model });
      const options = { maxTokens: 64, thinking: 'low' as const, cacheRetention: 'none' as const, systemPrompt: 'Public xAI system', tools: replayReference.tools };
      const invoke = async (messages: Message[]) => {
        if (facade === 'chat') return provider.chat(messages, options);
        let final: providers.ChatResponse | undefined;
        await provider.streamChat(messages, () => {}, response => { final = response; }, error => { throw error; }, options); expect(final).toBeDefined(); return final!;
      };
      const user: Message = { ...input, content: 'probe' }, initial = structuredClone([user]), first = await invoke(initial);
      expect(first).toMatchObject({ provider: 'xai', api: 'openai-responses', model, content: 'leftright', toolCalls: [{ id: 'call_native|fc_native', name: 'echo', input: { x: 1 } }], usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
      expect(first.blocks).toEqual(expectedBlocks); expect(initial).toEqual([user]); expect(calls.at(-1)!.body).toEqual(expectedBody(reference.expectedInitialBody));
      for (const projection of reference.projections) {
        const assistant: Message = { id: 'native', role: 'assistant', timestamp: new Date(0), content: first.content, provider: projection.source.provider,
          api: projection.source.api, model: projection.source.model, blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls) };
        if (projection.case === 'failed') assistant.metadata = { outputError: 'Failed xAI producer' };
        if (projection.case === 'expurgated') for (const block of assistant.blocks ?? []) { if (block.type === 'text') delete block.textSignature; if (block.type === 'reasoning') delete block.thinkingSignature; }
        const results: Message[] = projection.case === 'failed' ? [] : [{ id: 'result', role: 'tool', name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(0) }];
        const messages: Message[] = [user, assistant, ...results, { ...input, id: 'next', content: 'continue' }], before = structuredClone(messages); state.events = projection.responseEvents;
        expect(await invoke(messages)).toMatchObject({ provider: 'xai', api: 'openai-responses', model, content: 'ok' });
        expect(calls.at(-1)!.body).toEqual(expectedBody(projection.expectedBody)); expect(messages).toEqual(before);
      }
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-xai-replay-')), redactor = new CredentialRedactor(['sensitive', 'disposable-xai-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'xAI replay' }), registry = new ExtensionRegistry();
      let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; state.events = reference.projections[0].responseEvents; return { content: 'result' }; } }));
      state.events = reference.initialEvents;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'xai', tools: replayReference.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'xai', model, messages,
            tools: replayReference.tools, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: 'low', cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1);
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(message => message.role === 'assistant');
        expect(history.map(message => message.blocks)).toEqual([redactJson(expectedBlocks), reference.projections[0].second.content]);
        expect(bytes).not.toContain('sensitive'); expect(bytes).not.toContain('disposable-xai-private'); expect(bytes).toContain('opaque-xai-[REDACTED]-tail'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual(history.map(message => message.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-xai-');
        expect(JSON.stringify(complete.session)).toContain('opaque-xai-[REDACTED]-tail'); expect(JSON.stringify(complete.session)).not.toContain('sensitive');
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
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-xai-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(message => message.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_XAI_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy();
        const compacted = getCompactionModelMessages(compactedManager, clone.id); expect(compacted.some(message => message.content.includes('PUBLIC_XAI_COMPACTED_PREFIX'))).toBe(true);
        expect(compacted.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([reference.projections[0].second.content]); expect(compacted.filter(message => message.role === 'tool')).toEqual([]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        expect((await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(message => message.blocks));
        await invoke(compacted); expect(native()).toEqual([finalItem]); expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => item.type === 'function_call_output')).toEqual([]);
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(52); for (const call of calls) { expect(call.url).toBe('/owned%2Fxai/v1/responses'); expect(call.headers.authorization).toBe('Bearer disposable-xai-private'); expect(call.headers['api-key']).toBeUndefined(); }
  });

  it('refuses unsupported configuration before I/O and keeps private remote failures body-free', async () => {
    const { calls, state, baseUrl } = await fixture(), provider = new providers.XaiProvider({ type: 'operator', apiKey: 'disposable-xai', baseUrl, transport: 'sse' });
    for (const model of ['future', 'gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('xAI response model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('xAI response model is not supported.'); }
    for (const maxTokens of [0, -1, 30001, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid xAI output limit.');
    for (const base of ['file:///private', 'https://private:token@example.test/v1', baseUrl + '?secret=private', baseUrl + '#private']) expect(() => new providers.XaiProvider({ type: 'x', apiKey: 'disposable', baseUrl: base })).toThrow('Invalid xAI endpoint.');
    await expect(new providers.XaiProvider({ type: 'x', baseUrl, transport: 'sse' }).chat([input])).rejects.toThrow('xAI API key is required.'); expect(calls).toEqual([]);
    state.invalid = true; await expect(provider.chat([input])).rejects.toThrow('xAI response request failed.'); expect(calls).toHaveLength(1);
  });

  it('captures physical prices/provenance before callback mutation and suppresses buffered output after awaited withdrawal', async () => {
    const { baseUrl, state, calls } = await fixture(), provider = new providers.XaiProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl, transport: 'sse' }), completions: providers.ChatResponse[] = [];
    await provider.streamChat([input], async (_text, event) => { if (event?.type === 'reasoning_delta') provider.setConfiguredModel(ids[3]); }, result => { if (result) completions.push(result); }, error => { throw error; });
    expect(completions).toMatchObject([{ provider: 'anthropic', api: 'openai-responses', model: ids[0], usage: { costUsd: (5 * 1.25 + 2 * 2.5 + 4 * 0.2) / 1e6 } }]); expect(provider.getConfiguredModel()).toBe(ids[3]);
    const controller = new AbortController(), events: string[] = [], errors: Error[] = [];
    await provider.streamChat([input], async (_text, event) => { events.push(event?.type ?? ''); await Promise.resolve(); controller.abort(); }, () => { events.push('complete'); }, error => { errors.push(error); }, { signal: controller.signal });
    expect(events).toEqual(['reasoning_delta']); expect(errors).toHaveLength(1); expect(errors[0].message).toBe('xAI request aborted.');
    state.events = replayReference.rows[0].initialEvents;
    for (const json of [false, true]) {
      state.json = json; const completionErrors: Error[] = [];
      await new providers.XaiProvider({ type: 'xai', apiKey: 'disposable', baseUrl }).streamChat([input], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_XAI_COMPLETION_FAILURE'); }, error => { completionErrors.push(error); });
      expect(completionErrors.map(error => error.message)).toEqual(['xAI response request failed.']);
      let reads = 0; const selected: providers.ChatResponse[] = [], changing = new providers.XaiProvider({ type: 'xai', apiKey: 'disposable', baseUrl });
      await changing.streamChat([input], () => {}, response => { if (response) selected.push(response); }, error => { throw error; }, {
        get model() { return ++reads <= 2 ? ids[0] : ids[1]; }, thinking: 'low', maxTokens: 64,
      });
      expect(calls.at(-1)!.body.model).toBe(ids[1]); expect(selected).toHaveLength(1); expect(selected[0]).toMatchObject({ provider: 'xai', api: 'openai-responses', model: calls.at(-1)!.body.model });
      expect(selected[0].usage?.costUsd).toBeCloseTo((2 + 2 * 6) / 1e6, 12);
      const history: Message[] = [input, { id: 'a', role: 'assistant', timestamp: new Date(0), content: selected[0].content, provider: selected[0].provider,
        api: selected[0].api, model: selected[0].model, blocks: selected[0].blocks, toolCalls: selected[0].toolCalls },
        { id: 'r', role: 'tool', name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(0) }, { ...input, id: 'next' }];
      await changing.chat(history, { model: ids[1], maxTokens: 64 });
      expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => ['reasoning', 'message', 'function_call'].includes(item.type)))
        .toEqual(replayReference.rows[1].projections[0].expectedBody.input.filter((item: Record<string, any>) => ['reasoning', 'message', 'function_call'].includes(item.type)));
      await changing.chat(history, { model: ids[0], maxTokens: 64 }); expect(calls.at(-1)!.body.input.filter((item: Record<string, any>) => item.type === 'reasoning')).toEqual([]);
      expect(JSON.stringify(calls.at(-1)!.body.input)).not.toContain('opaque-xai-');
    }
  });

  it('exposes only the configured virtual classifier and does not reserve authentication or image operations', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: ids[2], transport: 'sse' });
    const result = await new SpecializedModels(provider).classify({ model: `${ids[2]}:classifier`, input: 'Approved', labels: ['safe', 'review'] }); expect(result.label).toBe('safe'); expect(result.usage?.totalTokens).toBe(12); expect(calls).toHaveLength(1); expect(calls[0].body).toMatchObject({ model: ids[2], reasoning: { effort: 'low', summary: 'auto' }, include: ['reasoning.encrypted_content'] });
    expect(new SpecializedModels(provider).getModelsOfType('classifier')).toHaveLength(1); expect(providers.ProviderFactory.has('xai')).toBe(false);
    await expect(provider.generateImages({ model: 'grok-image', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });
});
