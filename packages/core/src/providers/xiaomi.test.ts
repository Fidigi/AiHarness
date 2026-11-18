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

const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/xiaomi-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const first = 'mimo-v2.5', last = 'mimo-v2.6-pro-ultraspeed';
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[] | { C?: unknown[] }, reply?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) { response.setHeader('content-type', 'text/event-stream'); response.end(((Array.isArray(events) ? events : events?.C) ?? [{ choices: [{ delta: { reasoning_content: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage }]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'); }
    else response.end(JSON.stringify(reply?.C ?? reply ?? { choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fxiaomi/v1` };
}

describe('explicit native Xiaomi C SDK', () => {
  it.each(completionModels)('compares independently bound whole private Xiaomi C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.XiaomiProvider({ type: 'xiaomi', model, apiKey: 'disposable-xiaomi-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Xiaomi C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-xiaomi-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'xiaomi', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: firstResult.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Xiaomi C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'developer', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'developer', content: 'owned Xiaomi C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-xiaomi-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-xiaomi-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Xiaomi C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', reasoning_content: '' }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'xiaomi', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'xiaomi', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-xiaomi-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-xiaomi-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'xiaomi', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-xiaomi-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_XIAOMI_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_XIAOMI_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'developer', content: 'owned Xiaomi C reference system\n\n[Context Summary] PUBLIC_XIAOMI_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(54); for (const call of calls) { expect(call.url).toBe('/owned%2Fxiaomi/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-xiaomi-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins private C body identity/prices and marker policy, awaits publication and refuses forged grants', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === first); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const user: Message = { ...message, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [first, last]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new providers.XiaomiProvider({ type: 'xiaomi', apiKey: 'disposable-xiaomi-c', model, baseUrl }); provider.getProviderType = () => 'forged-xiaomi-c-provider'; provider.getModelApi = () => 'forged-xiaomi-c-api'; let captured: providers.ChatResponse | undefined;
      let reads = 0; const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Xiaomi C reference system', sessionId: 'xiaomi-c-bound' }, options = { ...base, get model() { return ++reads === 1 ? (model === first ? last : first) : model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === first ? last : first); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(reads).toBeGreaterThan(1); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'xiaomi', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = providers.XIAOMI_MODELS.find(profile => profile.id === model)!.pricing!; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === first ? last : first)); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) for (const field of ['session_id', 'x-client-request-id', 'x-session-affinity']) expect(call.headers[field]).toBeUndefined();
    reference = completions.rows.find((row: { model: string }) => row.model === first); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable-xiaomi-c', model: first, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(alias).not.toHaveProperty(field);
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [first, last]) { const errors: Error[] = []; await new providers.XiaomiProvider({ type: 'xiaomi', apiKey: 'disposable-xiaomi-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_XIAOMI_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['Xiaomi chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'xiaomi', api: 'openai-completions', model: first, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'xiaomi', apiKey: 'disposable-xiaomi-c', model: first, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedXiaomi extends providers.XiaomiProvider {} const derived = new DerivedXiaomi(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; derived.getProviderType = () => 'xiaomi'; await expect(derived.chat([source, user])).rejects.toThrow('Unsupported Xiaomi reasoning replay.');
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-xiaomi-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-xiaomi-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new providers.XiaomiProvider(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedXiaomi(config).chat([user])).reasoning).toBeUndefined(); expect(calls).toHaveLength(20);
  });

  it('keeps existing C tool-image attribution once and refuses undeclared images without decoding', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const profile of providers.XIAOMI_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...message, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'xiaomi', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...message, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new providers.XiaomiProvider({ type: 'xiaomi', apiKey: 'disposable-xiaomi-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('Xiaomi chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', reasoning_content: '', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); } expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(8); expect(refusals).toBe(4);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === first), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_XIAOMI_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new providers.XiaomiProvider({ type: 'xiaomi', apiKey: 'disposable-xiaomi-c', model: first, baseUrl }).streamChat([message], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-xiaomi-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-xiaomi-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });


  it('does not borrow native metadata from a compatible URL or routed Xiaomi identity', async () => {
    const { calls, baseUrl } = await fixture(), generic = new providers.OpenAiProvider({ type: 'xiaomi', apiKey: 'disposable', baseUrl, model: first });
    await generic.chat([message], { maxTokens: 64 }); expect(calls).toHaveLength(1);
    expect(getProviderPublishedModel('xiaomi', first, generic)).toBeUndefined();
  });

  it('publishes six frozen direct profiles with defensive actual-adapter metadata and one configured classifier', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    const profiles = providers.XIAOMI_MODELS, ids = profiles.map(profile => profile.id);
    expect(ids).toEqual([first, 'mimo-v2.5-pro', 'mimo-v2.5-pro-ultraspeed', 'mimo-v2.6-flash', 'mimo-v2.6-pro', last]);
    expect(Object.isFrozen(profiles)).toBe(true); expect(profiles.every(p => Object.isFrozen(p) && Object.isFrozen(p.pricing) && Object.isFrozen(p.declaredInput) && Object.isFrozen(p.thinkingLevelMap))).toBe(true);
    expect(profiles.filter(p => p.declaredInput.includes('image'))).toHaveLength(4); expect(profiles.every(p => p.reasoning)).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.getConfiguredModel()).toBe(first); expect(provider.canDiscoverModels()).toBe(false); expect(providers.ProviderFactory.has('xiaomi')).toBe(false);
    const row = getProviderPublishedModel('anthropic', first, provider)!;
    expect(row).toMatchObject({ name: 'MiMo-V2.5', api: 'openai-completions', contextWindow: 1048576, maxOutputTokens: 131072, pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheReadPerMillion: 0.0028, cacheWritePerMillion: 0 }, capabilities: { reasoning: true, imageInput: true, toolCalls: true } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', first, provider)).toMatchObject({ contextWindow: 1048576, pricing: { inputPerMillion: 0.14 }, thinkingLevelMap: { high: 'high', xhigh: null, max: null } });
    expect(getProviderPublishedModel('anthropic', 'xiaomi/mimo-v2.5', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', first, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(p => p.id)).toEqual(ids);
    expect(provider.getSpecializedModels()).toEqual([expect.objectContaining({ model: first, type: 'classifier', virtual: true, api: 'openai-completions', imageInput: true })]); expect(calls).toEqual([]);
  });

  it('owns developer/store/deepseek-format/replay/non-strict/max-completion policy independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const prior: Message = { ...message, id: 'prior', role: 'assistant', content: 'Prior', blocks: [{ type: 'reasoning', text: 'Saved thought' }, { type: 'text', text: 'Prior' }] };
    for (const type of ['openai', 'anthropic', 'deepseek', 'operator-xiaomi']) {
      const provider = new providers.XiaomiProvider({ type, apiKey: 'disposable-xiaomi', baseUrl, model: first });
      expect(await provider.chat([prior, message], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: first, api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.14 + 2 * 0.28 + 4 * 0.0028) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fxiaomi/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-xiaomi');
      expect(call.body).toMatchObject({ store: false, max_completion_tokens: 64, thinking: { type: 'enabled' }, reasoning_effort: 'high', messages: [{ role: 'developer' }, { role: 'assistant', content: 'Saved thoughtPrior', reasoning_content: '' }, { role: 'user' }], tools: [{ function: { strict: false } }] });
      for (const key of ['max_tokens', 'enable_thinking', 'tool_stream', 'chat_template_args', 'chat_template_kwargs', 'reasoning', 'prompt_cache_key', 'prompt_cache_retention']) expect(call.body).not.toHaveProperty(key);
    }
    const provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...message, role: 'assistant', content: 'Prior' }, message]); expect(calls.at(-1)!.body.messages[0]).toMatchObject({ role: 'assistant', reasoning_content: '' });
    expect(calls.at(-1)!.body.thinking).toEqual({ type: 'disabled' }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort'); expect(calls.at(-1)!.body).not.toHaveProperty('max_completion_tokens');
    for (const thinking of levels) await provider.chat([message], { thinking });
    expect(calls.slice(-7).map(c => c.body.reasoning_effort)).toEqual([undefined, 'minimal', 'low', 'medium', 'high', 'high', 'high']);
  });

  it('admits only six direct IDs, exact safe caps and four declared image inputs before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'xiaomi/mimo-v2.5', 'deepseek-flash']) { expect(() => provider.setConfiguredModel(model)).toThrow('Xiaomi chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Xiaomi chat model is not supported.'); }
    for (const maxTokens of [0, -1, 131073, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Xiaomi output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Xiaomi thinking level.'); expect(calls).toEqual([]);
    const image: Message = { ...message, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] };
    for (const profile of providers.XIAOMI_MODELS) {
      if (profile.declaredInput.includes('image')) { await provider.chat([image], { model: profile.id, maxTokens: 131072 }); expect(calls.at(-1)!.body.max_completion_tokens).toBe(131072); }
      else await expect(provider.chat([image], { model: profile.id })).rejects.toThrow('Xiaomi chat model does not support images.');
    }
    expect(calls).toHaveLength(4); expect(provider.getConfiguredModel()).toBe(first);
  });

  it('owns explicit long24h Unicode64 cache without automatic affinity and preserves configured headers', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const cacheRetention of ['short', 'long', 'none'] as const) await provider.chat([message], { sessionId: '🙂'.repeat(70), cacheRetention });
    expect(calls[1].body).toMatchObject({ prompt_cache_retention: '24h', prompt_cache_key: '🙂'.repeat(64) });
    for (const i of [0, 2]) { expect(calls[i].body).not.toHaveProperty('prompt_cache_retention'); expect(calls[i].body).not.toHaveProperty('prompt_cache_key'); }
    for (const call of calls) for (const name of ['session_id', 'session-id', 'x-client-request-id', 'x-session-affinity', 'nvcf-poll-seconds']) expect(call.headers[name]).toBeUndefined();
    await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-session-affinity': 'operator-owned' } }).chat([message]); expect(calls.at(-1)!.headers['x-session-affinity']).toBe('operator-owned');
  });

  it.each(['chat', 'stream'] as const)('captures physical fallback and prices for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    let result: providers.ChatResponse | undefined;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(last); }, response => { result = response; }, undefined, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(first);
    expect(result).toMatchObject({ provider: 'operator', model: first, api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.14 + 2 * 0.28 + 4 * 0.0028) / 1e6 } });
    if (operation === 'stream') expect(provider.getConfiguredModel()).toBe(last);
  });

  it('suppresses buffered callbacks and completion after awaited withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const abort = new AbortController(), complete = vi.fn(), failed = vi.fn(), seen: string[] = [];
    await provider.streamChat([message], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, failed, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Xiaomi request aborted.');
  });

  it('keeps partial usage unknown and rejects invalid terminal/replay authority privately', async () => {
    const partial = await fixture(undefined, { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } });
    expect((await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: partial.baseUrl }).chat([message])).usage).toBeUndefined();
    const bad = await fixture(undefined, { choices: [{ message: { content: 'private-body', reasoning_details: [{ secret: 'private-body' }] }, finish_reason: 'stop' }] });
    expect(await new providers.XiaomiProvider({ type: 'operator', apiKey: 'private-key', baseUrl: bad.baseUrl }).chat([message])).toMatchObject({ content: 'private-body', blocks: [{ type: 'text', text: 'private-body' }] });
    const truncated = await fixture([{ choices: [{ delta: { content: 'Prefix' } }] }]);
    await expect(new providers.XiaomiProvider({ type: 'operator', apiKey: 'private-key', baseUrl: truncated.baseUrl }).streamChat([message], () => {})).rejects.toThrow('Invalid Xiaomi chat response.');
  });

  it('requires a supplied representable key and safely composes encoded/full/default endpoints without ambient auth', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('XIAOMI_API_KEY', 'ambient-key'); vi.stubEnv('OPENAI_API_KEY', 'ambient-key');
    expect(new providers.XiaomiProvider({ type: 'xiaomi' }).validateConfig()).toBe(false);
    for (const apiKey of ['', 'bad\nkey', '🙂']) await expect(new providers.XiaomiProvider({ type: 'operator', apiKey, baseUrl }).chat([message])).rejects.toThrow('Xiaomi API key is required.');
    expect(calls).toEqual([]); expect(() => new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: 'https://user:secret@example.test' })).toThrow('Invalid Xiaomi endpoint.');
    await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions' }).chat([message]); expect(calls[0].url).toBe('/owned%2Fxiaomi/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => { url = String(input); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }), { status: 200 }); }));
    await new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
  });

  it('retains the existing configured virtual classifier512 and refuses image generation', async () => {
    const { calls, baseUrl } = await fixture(undefined, { choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }] });
    const provider = new providers.XiaomiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const model = provider.getSpecializedModels()[0];
    expect(await new SpecializedModels(provider).classify({ model: model.id, input: 'hello', labels: ['safe', 'unsafe'] })).toMatchObject({ label: 'safe' });
    expect(calls).toHaveLength(1); expect(calls[0].body.max_completion_tokens).toBe(512);
    await expect(provider.generateImages({ model: 'image', prompt: 'Image' })).rejects.toThrow('Image model or options are not supported.');
  });
});
