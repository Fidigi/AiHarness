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

const ids = ['Ling-2.6-1T', 'Ling-2.6-flash', 'Ring-2.6-1T'];
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/ant-ling-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fant-ling/v1` };
}

describe('explicit native Ant Ling C SDK', () => {
  it.each(completionModels)('compares independently bound whole private Ant Ling C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.AntLingProvider({ type: 'ant-ling', model, apiKey: 'disposable-ant-ling-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Ant Ling C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-ant-ling-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'ant-ling', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(first.blocks).toEqual(reference.expectedBlocks); expect(first.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: first.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Ant Ling C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Ant Ling C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-ant-ling-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-ant-ling-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Ant Ling C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok' }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'ant-ling', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'ant-ling', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-ant-ling-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-ant-ling-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'ant-ling', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-ant-ling-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_ANT_LING_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_ANT_LING_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Ant Ling C reference system\n\n[Context Summary] PUBLIC_ANT_LING_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(54); for (const call of calls) { expect(call.url).toBe('/owned%2Fant-ling/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-ant-ling-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins private C body identity/prices and marker policy, awaits publication and refuses forged grants', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === ids[0]); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const user: Message = { ...message, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [ids[0], ids[2]]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new providers.AntLingProvider({ type: 'ant-ling', apiKey: 'disposable-ant-ling-c', model, baseUrl }); provider.getProviderType = () => 'forged-ant-ling-c-provider'; provider.getModelApi = () => 'forged-ant-ling-c-api'; let reads = 0, captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Ant Ling C reference system', sessionId: 'ant-ling-c-bound' }, options = { ...base, get model() { return ++reads === 1 && facade === 'chat' ? (model === ids[0] ? ids[2] : ids[0]) : model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === ids[0] ? ids[2] : ids[0]); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'ant-ling', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = providers.ANT_LING_MODELS.find(profile => profile.id === model)!.pricing; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === ids[0] ? ids[2] : ids[0])); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) for (const field of ['session_id', 'x-client-request-id', 'x-session-affinity']) expect(call.headers[field]).toBeUndefined();
    reference = completions.rows.find((row: { model: string }) => row.model === ids[0]); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable-ant-ling-c', model: ids[0], baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(alias).not.toHaveProperty(field);
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [ids[0], ids[2]]) { const errors: Error[] = []; await new providers.AntLingProvider({ type: 'ant-ling', apiKey: 'disposable-ant-ling-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_ANT_LING_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['Ant Ling chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'ant-ling', api: 'openai-completions', model: ids[0], blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'ant-ling', apiKey: 'disposable-ant-ling-c', model: ids[0], baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedAntLing extends providers.AntLingProvider {} const derived = new DerivedAntLing(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; derived.getProviderType = () => 'ant-ling'; await expect(derived.chat([source, user])).rejects.toThrow('Unsupported Ant Ling reasoning replay.');
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-ant-ling-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-ant-ling-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new providers.AntLingProvider(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedAntLing(config).chat([user])).reasoning).toBeUndefined(); expect(calls).toHaveLength(20);
  });

  it('refuses all text-only native C tool-result images without effects or decoding', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const model of ids) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...message, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'ant-ling', api: 'openai-completions', model, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...message, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new providers.AntLingProvider({ type: 'ant-ling', apiKey: 'disposable-ant-ling-c', model, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      await expect(invoke()).rejects.toThrow('Ant Ling chat model does not support images.'); refusals++; expect(history).toEqual(before);
    }
    expect(calls).toEqual([]); expect(refusals).toBe(6);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === ids[0]), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_ANT_LING_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new providers.AntLingProvider({ type: 'ant-ling', apiKey: 'disposable-ant-ling-c', model: ids[0], baseUrl }).streamChat([message], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-ant-ling-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-ant-ling-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });

  it('keeps generic compatible C distinct from native Ring policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.OpenAiProvider({ type: 'ant-ling', apiKey: 'disposable', baseUrl, model: ids[2] }).chat([message], { thinking: 'high', maxTokens: 64 });
    expect(calls[0].body.max_tokens).toBe(64); expect(calls[0].body).not.toHaveProperty('reasoning');
  });

  it('publishes three immutable text-only profiles and defensive metadata without factory or discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl });
    expect(providers.ANT_LING_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(providers.ANT_LING_MODELS)).toBe(true);
    expect(providers.ANT_LING_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(ids[0]); expect(providers.ProviderFactory.has('ant-ling')).toBe(false);
    const row = getProviderPublishedModel('anthropic', ids[2], provider)!;
    expect(row).toMatchObject({ name: 'Ring 2.6 1T', api: 'openai-completions', contextWindow: 262144, maxOutputTokens: 65536, capabilities: { reasoning: true, imageInput: false, toolCalls: true }, pricing: { inputPerMillion: 0.06, outputPerMillion: 0.25, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'foreign';
    expect(getProviderPublishedModel('anthropic', ids[2], provider)).toMatchObject({ contextWindow: 262144, thinkingLevelMap: { high: 'high', xhigh: 'xhigh' } });
    expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', ids[2], undefined, provider)).toEqual(['high', 'xhigh']);
    expect(getSupportedThinkingLevels('anthropic', ids[0], undefined, provider)).toEqual(['off']); expect(getSupportedThinkingLevels('anthropic', 'gpt-4o', undefined, provider)).toEqual(['off']);
    expect((await collectProviderModelCatalog(new Map([['anthropic', provider]]), { discover: false }))[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
  });

  it('owns system roles, nested Ring effort, supported non-strict tools and explicit output independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    for (const type of ['openai', 'anthropic', 'azure', 'operator-ant-ling']) {
      const provider = new providers.AntLingProvider({ type, apiKey: 'disposable-ant-ling', baseUrl, model: ids[2] });
      expect(await provider.chat([message], { thinking: 'off', maxTokens: 64, systemPrompt: 'System', sessionId: 'not-cache-authority', cacheRetention: 'long', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: ids[2], api: 'openai-completions', content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.06 + 2 * 0.25) / 1e6 } });
    }
    for (const call of calls) { expect(call.url).toBe('/owned%2Fant-ling/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-ant-ling'); expect(call.headers['api-key']).toBeUndefined(); expect(call.body).toMatchObject({ max_tokens: 64, reasoning: { effort: 'high' }, messages: [{ role: 'system' }, { role: 'user' }], tools: [{ function: { strict: false } }] }); for (const key of ['max_completion_tokens', 'reasoning_effort', 'store', 'prompt_cache_key', 'prompt_cache_retention', 'thinking', 'tool_stream']) expect(call.body).not.toHaveProperty(key); }
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).chat([message]); expect(calls.at(-1)!.body).not.toHaveProperty('max_tokens'); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning');
  });

  it('clamps Ring high/xhigh, keeps Ling nonreasoning and refuses unsupported models/images/caps before I/O', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'dall-e-3', 'gpt-4o']) { expect(() => provider.setConfiguredModel(model)).toThrow('Ant Ling chat model is not supported.'); await expect(provider.chat([message], { model })).rejects.toThrow('Ant Ling chat model is not supported.'); }
    const image: Message = { ...message, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] };
    for (const model of ids) await expect(provider.chat([image], { model })).rejects.toThrow('Ant Ling chat model does not support images.');
    for (const maxTokens of [0, -1, 65537, 1.5, Number.NaN]) await expect(provider.chat([message], { maxTokens })).rejects.toThrow('Invalid Ant Ling output limit.');
    await expect(provider.chat([message], { thinking: 'future' as 'high' })).rejects.toThrow('Invalid Ant Ling thinking level.'); expect(calls).toEqual([]);
    for (const model of ids) for (const thinking of levels) await provider.chat([message], { model, thinking, maxTokens: 65536 });
    expect(calls.slice(0, 14).every(call => !('reasoning' in call.body))).toBe(true); expect(calls.slice(14).map(call => call.body.reasoning.effort)).toEqual(['high', 'high', 'high', 'high', 'high', 'xhigh', 'xhigh']);
  });

  it('requires supplied representable keys and safe endpoints without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('ANT_LING_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new providers.AntLingProvider({ type: 'operator', apiKey, baseUrl }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([message])).rejects.toThrow('Ant Ling API key is required.'); }
    for (const endpoint of ['https://user:private@host/v1', 'https://host/v1?private=key', 'https://host/v1#private', 'ftp://host/v1']) expect(() => new providers.AntLingProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Ant Ling endpoint.');
    await expect(new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'x-private': 'private\0header' } }).chat([message])).rejects.toThrow('Invalid Ant Ling request headers.'); expect(calls).toEqual([]);
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: baseUrl + '/chat/completions/' }).chat([message]); expect(calls[0].url).toBe('/owned%2Fant-ling/v1/chat/completions');
    let url = ''; vi.stubGlobal('fetch', async (endpoint: string | URL | Request) => { url = String(endpoint); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable' }).chat([message]); expect(url).toBe('https://api.ant-ling.com/v1/chat/completions');
  });

  it.each(['chat', 'stream'] as const)('captures configured physical fallback for an empty per-turn model (%s)', async operation => {
    const { calls, baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator-ant-ling', apiKey: 'disposable', baseUrl, model: ids[0] });
    let result: unknown;
    if (operation === 'chat') result = await provider.chat([message], { model: '' });
    else await provider.streamChat([message], async () => { await Promise.resolve(); provider.setConfiguredModel(ids[1]); }, value => { result = value; }, error => { throw error; }, { model: '' });
    expect(calls).toHaveLength(1); expect(calls[0].body.model).toBe(ids[0]);
    expect(result).toMatchObject({ provider: 'operator-ant-ling', model: ids[0], api: 'openai-completions', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.06 + 2 * 0.25) / 1e6 } });
    expect(provider.getConfiguredModel()).toBe(operation === 'stream' ? ids[1] : ids[0]);
  });

  it('captures model/prices before awaited callbacks and suppresses buffered delivery after withdrawal', async () => {
    const { baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: ids[2] });
    const seen: string[] = []; let completed: unknown;
    await provider.streamChat([message], async (_text, event) => { await Promise.resolve(); seen.push(event!.type); provider.setConfiguredModel(ids[1]); }, value => { completed = value; });
    expect(seen).toEqual(['reasoning_delta', 'text_delta']); expect(completed).toMatchObject({ model: ids[2], api: 'openai-completions', usage: { costUsd: (5 * 0.06 + 2 * 0.25) / 1e6 } });
    const abort = new AbortController(), done = vi.fn(), failed = vi.fn(), withdrawn: string[] = [];
    await provider.streamChat([message], async (_text, event) => { withdrawn.push(event!.type); await Promise.resolve(); abort.abort(); }, done, failed, { signal: abort.signal });
    expect(withdrawn).toEqual(['reasoning_delta']); expect(done).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Ant Ling request aborted.');
  });

  it('requires native terminal authority before deferred tools/success and keeps errors private', async () => {
    for (const finish of [undefined, 'content_filter', 'network_error']) { const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish ? { finish_reason: finish } : {}) }] }]); const chunks = vi.fn(), complete = vi.fn(), failed = vi.fn(); await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).streamChat([message], chunks, complete, failed); expect(chunks).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(failed.mock.calls[0][0].message).toBe('Invalid Ant Ling chat response.'); }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]); let result: unknown;
    await new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl }).streamChat([message], () => {}, value => { result = value; }); expect(result).toMatchObject({ toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    const bad = await fixture([{ error: { message: 'private-remote' }, choices: [{ delta: { content: 'not-published' }, finish_reason: 'stop' }] }]); await expect(new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl: bad.baseUrl }).streamChat([message], () => { throw Error('Unexpected chunk'); })).rejects.toThrow('Ant Ling chat request failed.');
  });

  it('keeps only the configured classifier and genuine accounting without exposing image operations', async () => {
    const { baseUrl } = await fixture(), provider = new providers.AntLingProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: ids[1] });
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${ids[1]}:classifier`, virtual: true, api: 'openai-completions', imageInput: false }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]); await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4 } })));
    expect(await new SpecializedModels(provider).classify({ model: `${ids[1]}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.01 + 2 * 0.02) / 1e6 } });
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([message])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning_details: [{ type: 'encrypted', data: 'private' }] }, finish_reason: 'stop' }] }))); expect((await provider.chat([message])).blocks).toEqual([{ type: 'text', text: 'Ready' }]);
  });
});
