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
import * as providers from './index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CerebrasProvider, CEREBRAS_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import { ProviderType, type Message } from '../types/index.js';

const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/cerebras-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const gpt = 'gpt-oss-120b', qwen = 'qwen-3.8-27b';
const input = message;
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[] | { C?: unknown[] }, reply?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      response.end(((Array.isArray(events) ? events : events?.C) ?? [{ choices: [{ delta: { reasoning_content: 'Thought', reasoning: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage }])
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } else response.end(JSON.stringify(reply?.C ?? reply ?? { model: body.model, choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fcerebras/v1`;
  return { calls, baseUrl };
}

describe('explicit Cerebras C SDK', () => {
  it.each(completionModels)('compares independently bound whole private Cerebras C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.CerebrasProvider({ type: 'cerebras', model, apiKey: 'disposable-cerebras-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Cerebras C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-cerebras-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'cerebras', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: firstResult.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Cerebras C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Cerebras C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cerebras-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-cerebras-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Cerebras C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok' }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'cerebras', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'cerebras', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-cerebras-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-cerebras-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'cerebras', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-cerebras-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_CEREBRAS_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_CEREBRAS_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Cerebras C reference system\n\n[Context Summary] PUBLIC_CEREBRAS_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(54); for (const call of calls) { expect(call.url).toBe('/owned%2Fcerebras/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-cerebras-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins private C body identity/prices and marker policy, awaits publication and refuses forged grants', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === gpt); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const user: Message = { ...input, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [gpt, qwen]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new providers.CerebrasProvider({ type: 'cerebras', apiKey: 'disposable-cerebras-c', model, baseUrl }); provider.getProviderType = () => 'forged-cerebras-c-provider'; provider.getModelApi = () => 'forged-cerebras-c-api'; let captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Cerebras C reference system', sessionId: 'cerebras-c-bound' }, options = { ...base, get model() { return model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === gpt ? qwen : gpt); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'cerebras', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = providers.CEREBRAS_MODELS.find(profile => profile.id === model)!.pricing!; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === gpt ? qwen : gpt)); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) for (const field of ['session_id', 'x-client-request-id', 'x-session-affinity']) expect(call.headers[field]).toBeUndefined();
    reference = completions.rows.find((row: { model: string }) => row.model === gpt); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new providers.CerebrasProvider({ type: 'operator', apiKey: 'disposable-cerebras-c', model: gpt, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(alias).not.toHaveProperty(field);
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [gpt, qwen]) { const errors: Error[] = []; await new providers.CerebrasProvider({ type: 'cerebras', apiKey: 'disposable-cerebras-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_CEREBRAS_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['Cerebras chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'cerebras', api: 'openai-completions', model: gpt, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'cerebras', apiKey: 'disposable-cerebras-c', model: gpt, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedCerebras extends providers.CerebrasProvider {} const derived = new DerivedCerebras(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; derived.getProviderType = () => 'cerebras'; await expect(derived.chat([source, user])).rejects.toThrow('Unsupported Cerebras reasoning replay.');
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-cerebras-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-cerebras-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new providers.CerebrasProvider(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedCerebras(config).chat([user])).reasoning).toBeUndefined(); expect(calls).toHaveLength(20);
  });

  it('keeps existing C tool-image attribution once and refuses undeclared images without decoding', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const profile of providers.CEREBRAS_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'cerebras', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new providers.CerebrasProvider({ type: 'cerebras', apiKey: 'disposable-cerebras-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('Cerebras chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); } expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(2); expect(refusals).toBe(2);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === gpt), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_CEREBRAS_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new providers.CerebrasProvider({ type: 'cerebras', apiKey: 'disposable-cerebras-c', model: gpt, baseUrl }).streamChat([input], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-cerebras-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-cerebras-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });


  it('keeps the legacy compatible envelope distinct from the missing native profile policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'compatible-cerebras', apiKey: 'disposable', baseUrl, model: gpt }).chat([message], { maxTokens: 64 });
    expect(calls[0].body).toHaveProperty('max_tokens', 64); expect(calls[0].body).not.toHaveProperty('max_completion_tokens');
  });

  it('composes Cerebras through the native Core factory without registration', async () => {
    const provider = ProviderFactory.create({ type: 'cerebras', apiKey: 'disposable-factory' });
    expect(provider).toBeInstanceOf(CerebrasProvider);
    expect(ProviderType.CEREBRAS).toBe('cerebras');
    expect(ProviderFactory.has('CEREBRAS')).toBe(true);
    expect(ProviderFactory.getDefaultModel(ProviderType.CEREBRAS)).toBe(gpt);
    expect(provider.getConfiguredModel()).toBe(gpt);
    expect(await provider.getAvailableModels()).toEqual([gpt, qwen]);
    expect(provider.validateConfig()).toBe(true);
    expect(ProviderFactory.create({ type: 'cerebras' }).validateConfig()).toBe(false);
    expect(() => ProviderFactory.create({ type: 'cerebras', model: 'unknown' })).toThrow('Cerebras chat model is not supported.');
    expect(() => ProviderFactory.register(' CEREBRAS ', () => provider)).toThrow('Cannot register reserved provider type:');
    expect(ProviderFactory.getRegisteredTypes()).not.toContain('cerebras');
  });

  it('publishes two frozen profiles and alias-independent metadata without inherited DALL-E', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new CerebrasProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(CEREBRAS_MODELS).toHaveLength(2); expect(Object.isFrozen(CEREBRAS_MODELS)).toBe(true);
    expect(CEREBRAS_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.thinkingLevelMap) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual([gpt, qwen]); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getConfiguredModel()).toBe(gpt); expect(provider.getModelApi(gpt)).toBe('openai-completions'); expect(ProviderFactory.has('cerebras')).toBe(true);
    const row = getProviderPublishedModel('anthropic', gpt, provider)!;
    expect(row).toMatchObject({ id: gpt, name: 'GPT OSS 120B', contextWindow: 131072, maxOutputTokens: 40960, capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.35, outputPerMillion: 0.75, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99;
    expect(getProviderPublishedModel('anthropic', gpt, provider)?.contextWindow).toBe(131072);
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined();
    const catalog = await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false });
    expect(catalog.flatMap(entry => entry.models.map(model => model.id))).toEqual([gpt, qwen]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${gpt}:classifier`, virtual: true, api: 'openai-completions', contextWindow: 131072 }]);
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.'); expect(calls).toEqual([]);
  });

  it('uses physical Bearer/native output/system/effort policies under Azure and local aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['azure', 'local', 'operator-cerebras']) {
      const provider = new CerebrasProvider({ type, apiKey: 'disposable-cerebras', baseUrl, model: gpt });
      const result = await provider.chat([message], { systemPrompt: 'System', thinking: 'off', maxTokens: 64, temperature: 0.2,
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
      expect(result).toMatchObject({ provider: type, api: 'openai-completions', model: gpt, content: 'Ready', reasoning: 'Thought', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.35 + 2 * 0.75) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fcerebras/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-cerebras'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ max_completion_tokens: 64, reasoning_effort: 'low', temperature: 0.2, messages: [{ role: 'system' }, { role: 'user' }], tools: [{ function: { name: 'read' } }] });
      expect(call.body).not.toHaveProperty('max_tokens'); expect(call.body).not.toHaveProperty('store'); expect(JSON.stringify(call.body.tools)).not.toContain('strict');
    }
    const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: qwen });
    await provider.chat([message], { thinking: 'off', sessionId: '🔑'.repeat(70), cacheRetention: 'long' });
    expect(calls[3].body).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: 40960, prompt_cache_key: '🔑'.repeat(64), prompt_cache_retention: '24h' });
    await provider.chat([message], { sessionId: 'not-an-affinity', cacheRetention: 'none' });
    expect(calls[4].body).not.toHaveProperty('prompt_cache_key'); expect(calls[4].body).not.toHaveProperty('prompt_cache_retention');
    expect(calls[4].headers['x-session-id']).toBeUndefined(); expect(calls[4].headers.session_id).toBeUndefined();
    let endpoint = '';
    vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new CerebrasProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(endpoint).toBe('https://api.cerebras.ai/v1/chat/completions');
  });

  it('clamps every pinned level and rejects unknown models, images and output before I/O', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'dall-e-3', 'openai/gpt-oss-120b']) {
      expect(() => provider.setConfiguredModel(model)).toThrow('Cerebras chat model is not supported.');
      await expect(provider.chat([message], { model })).rejects.toThrow('Cerebras chat model is not supported.');
    }
    const image: Message = { ...message, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Cerebras chat model does not support images.');
    for (const maxTokens of [0, -1, 40961, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Cerebras output limit.');
    expect(calls).toEqual([]); expect(provider.getConfiguredModel()).toBe(gpt);
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const model of [gpt, qwen]) for (const thinking of levels) await provider.chat([message], { model, thinking });
    expect(calls.map(call => call.body.reasoning_effort)).toEqual(['low', 'low', 'low', 'medium', 'high', 'high', 'high', 'none', 'low', 'low', 'medium', 'high', 'high', 'high']);
    await provider.chat([image], { model: qwen }); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]);
  });

  it('requires explicit representable keys/headers and safe endpoint forms without ambient credential fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('CEREBRAS_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) {
      const provider = new CerebrasProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false);
      await expect(provider.chat([message])).rejects.toThrow('Cerebras API key is required.');
    }
    for (const endpoint of ['https://user:private@host/v1', 'https://host/v1?private=key', 'https://host/v1#private', 'ftp://host/v1']) expect(() => new CerebrasProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Cerebras endpoint.');
    await expect(new CerebrasProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Cerebras request headers.');
    expect(calls).toEqual([]);
    await new CerebrasProvider({ type: 'operator', baseUrl: baseUrl + '/chat/completions/', apiKey: 'disposable' }).chat([message]);
    expect(calls[0].url).toBe('/owned%2Fcerebras/v1/chat/completions');
  });

  it('awaits reasoning first, captures the pending model/price and suppresses buffered delivery after withdrawal', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const events: string[] = []; let complete: unknown;
    await provider.streamChat([message], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(qwen); }, value => { complete = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(calls[0].body).toMatchObject({ model: gpt, stream_options: { include_usage: true } });
    expect(complete).toMatchObject({ model: gpt, provider: 'operator', api: 'openai-completions', reasoning: 'Thought', usage: { costUsd: (5 * 0.35 + 2 * 0.75) / 1e6 } });
    const abort = new AbortController(), finished = vi.fn(), failed = vi.fn(), seen: string[] = [];
    await provider.streamChat([message], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, finished, failed, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(finished).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Cerebras request aborted.');
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response((body.model === gpt ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n');
    });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn();
    await provider.streamChat([message], async () => { await provider.streamChat([message], () => {}, nestedComplete, nestedError, { model: qwen }); }, outerComplete, undefined, { model: gpt });
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError).toHaveBeenCalledOnce();
    expect(nestedError.mock.calls[0][0].message).toBe('Invalid Cerebras chat response.');
  });

  it('requires a valid native finish before publishing tools or success and refuses mixed failure frames privately', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'network_error', 'future']) {
      const events = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }];
      const { baseUrl } = await fixture(events); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
      const chunks = vi.fn(), complete = vi.fn(), error = vi.fn(); await provider.streamChat([message], chunks, complete, error);
      expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('Invalid Cerebras chat response.');
    }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]);
    const toolEvents: unknown[] = []; let goodResult: unknown;
    await new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message], (_text, event) => { toolEvents.push(event); }, value => { goodResult = value; });
    expect(toolEvents).toEqual([{ type: 'tool_call', data: { id: 'read', name: 'read', input: { path: 'file' } } }]);
    expect(goodResult).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }], api: 'openai-completions' });
    const { baseUrl } = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]);
    const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await expect(provider.streamChat([message], () => { throw new Error('Unexpected chunk'); })).rejects.toThrow('Cerebras chat request failed.');
  });

  it('preserves finite virtual classification while rejecting malformed reasoning and incomplete accounting', async () => {
    const { baseUrl } = await fixture(); const provider = new CerebrasProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: qwen });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })));
    expect(await new SpecializedModels(provider).classify({ model: `${qwen}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.99 + 2 * 1.49 + 4 * 0.99) / 1e6 } });
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage })));
      expect((await provider.chat([message])).usage).toBeUndefined();
    }
    for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', [field]: { private: 'not-text' } }, finish_reason: 'stop' }] })));
      await expect(provider.chat([message])).rejects.toThrow('Invalid Cerebras chat response.');
    }
  });
});
