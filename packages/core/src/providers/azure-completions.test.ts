import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { serializeSessionForExport } from '../sessions/serialization.js';
import { getCompactionModelMessages } from '../sessions/compaction-model-messages.js';
import { getSummaryModelMessages } from '../sessions/summary-model-messages.js';
import { CredentialRedactor } from './credentials.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { runToolLoop } from '../agent/tool-loop.js';
import { streamProviderTurn } from '../agent/provider-turn.js';
import * as providers from './index.js';
import type { Message } from '../types/index.js';

const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/azure-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionScopes: string[] = completions.rows.map((row: { deploymentScope: string }) => row.deploymentScope);
afterEach(async () => { vi.unstubAllGlobals(); await closeProviderNetworkDispatchers(); });
async function fixture(events: { C: unknown[] }, replies: { C: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const baseUrl = 'https://owned-reference.openai.azure.com/owned%2Fazure/openai/v1';
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: new URL(String(url)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), body });
    return body.stream ? new Response(events.C.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(replies.C), { headers: { 'content-type': 'application/json' } });
  });
  return { calls, baseUrl };
}

describe('independently bound native Azure C continuation', () => {
  it.each(completionScopes)('compares independently bound whole private Azure C bodies and typed carriers for deployment %s', async scope => {
    const reference = completions.rows.find((row: { deploymentScope: string }) => row.deploymentScope === scope), model: string = reference.model, events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const Constructor of [providers.AzureCompletionsProvider, providers.AzureProvider]) for (const facade of ['chat', 'stream']) {
      const provider = new Constructor({ type: 'azure', model, apiKey: 'disposable-azure-c', baseUrl, ...reference.deploymentConfig }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Azure C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-azure-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'azure', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(firstResult.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }); expect(firstResult.usage?.costUsd).toBeCloseTo(0.000017941, 12); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: firstResult.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Azure C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Azure C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-azure-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-azure-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Azure C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', reasoning_content: '' }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'azure', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'azure', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-azure-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-azure-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'azure', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-azure-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_CEREBRAS_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_CEREBRAS_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Azure C reference system\n\n[Context Summary] PUBLIC_CEREBRAS_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(108); for (const call of calls) { expect(call.url).toBe('/owned%2Fazure/openai/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-azure-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins prepared C profile/deployment/prices despite public getters and caller-state changes', async () => {
    let capturedRequests = 0, changingCallers = 0;
    for (const reference of completions.rows) for (const Constructor of [providers.AzureCompletionsProvider, providers.AzureProvider]) for (const facade of ['chat', 'stream']) for (const changing of [false, true]) {
      const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies), model: string = reference.model;
      const provider = new Constructor({ type: 'azure', apiKey: 'disposable-azure-c', model, baseUrl, ...reference.deploymentConfig });
      const exposed = provider.getPublishedModels!()!.find(row => row.id === model)!; exposed.pricing!.inputPerMillion = 999999;
      provider.getProviderType = () => 'forged-azure-c'; provider.getModelApi = () => 'forged-api';
      let reads = 0, current = model, result: providers.ChatResponse | undefined;
      const options = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Azure C reference system', get model() { reads++; const selected = current; if (changing) current = 'unowned-after-selection'; return selected; } };
      const user: Message = { id: 'c-owned-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      if (facade === 'chat') result = await provider.chat([user], options);
      else await provider.streamChat([user], async () => { await Promise.resolve(); provider.setConfiguredModel('changed-after-send'); }, value => { result = value; }, error => { throw error; }, options);
      expect(reads).toBe(1); expect(current).toBe(changing ? 'unowned-after-selection' : model); if (changing) changingCallers++;
      const expected: Record<string, unknown> = { ...structuredClone(reference.expectedInitialBody), stream: facade === 'stream' }; if (facade === 'chat') delete expected.stream_options;
      expect(calls.at(-1)!.body).toEqual(expected); expect(result).toMatchObject({ provider: 'azure', api: 'openai-completions', model, blocks: reference.expectedBlocks });
      expect(result!.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 }); expect(result!.usage!.costUsd).toBeCloseTo(0.000017941, 12);
      for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(result).not.toHaveProperty(field);
      const history: Message[] = [user, { id: 'c-owned-a', role: 'assistant', content: result!.content, provider: result!.provider, api: result!.api, model: result!.model, blocks: result!.blocks, toolCalls: result!.toolCalls, timestamp: new Date(0) }, { id: 'c-owned-r', role: 'tool', name: 'echo', toolCallId: result!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...reference.options, model, tools: completions.tools, systemPrompt: 'owned Azure C reference system' }); const replay = { ...structuredClone(reference.cases[0].expectedBody), stream: false }; delete replay.stream_options;
      expect(calls.at(-1)!.body).toEqual(replay); expect(history).toEqual(before); expect(calls).toHaveLength(2); capturedRequests += calls.length;
    }
    expect(capturedRequests).toBe(48); expect(changingCallers).toBe(12); // Azure pins the first selection; this is not internal logical/body divergence.
  });

  it('keeps exact factory/alias admission separate from derived, unknown and legacy C', async () => {
    const reference = completions.rows[0], events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const model: string = reference.model, user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) }, options = { ...reference.options, tools: completions.tools };
    for (const azureApi of ['native', 'completions'] as const) expect((await providers.ProviderFactory.create({ type: 'azure', azureApi, model, apiKey: 'disposable-azure-c', baseUrl }).chat([user], options)).blocks).toEqual(reference.expectedBlocks);
    for (const Constructor of [providers.AzureCompletionsProvider, providers.AzureProvider]) expect((await new Constructor({ type: 'operator-azure', model, apiKey: 'disposable-azure-c', baseUrl }).chat([user], options))).toMatchObject({ provider: 'operator-azure', model, blocks: reference.expectedBlocks });
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'azure', api: 'openai-completions', model, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls };
    class DerivedC extends providers.AzureCompletionsProvider {} class DerivedMixed extends providers.AzureProvider {}
    for (const Constructor of [DerivedC, DerivedMixed, providers.OpenAiProvider]) {
      const provider = new Constructor({ type: 'azure', model, apiKey: 'disposable-azure-c', baseUrl }); (provider as unknown as { ownsReplay: boolean }).ownsReplay = true;
      expect((await provider.chat([source, user], options)).blocks).toBeUndefined(); expect(JSON.stringify(calls.at(-1)!.body)).not.toMatch(/opaque-azure-c-|reasoning_details/);
    }
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_AZURE_SUMMARY' } }] };
    expect((await new providers.AzureCompletionsProvider({ type: 'azure', model: 'unknown-c-profile', apiKey: 'disposable-azure-c', baseUrl }).chat([user])).reasoning).toBe('LEGACY_AZURE_SUMMARY');
    expect((await new DerivedC({ type: 'azure', model, apiKey: 'disposable-azure-c', baseUrl }).chat([user])).reasoning).toBe('LEGACY_AZURE_SUMMARY');
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'IGNORED_NATIVE_SUMMARY' }, finish_reason: 'stop' }] };
    events.C = [{ choices: [{ delta: { content: 'Ready', reasoning_summary: 'IGNORED_NATIVE_SUMMARY' }, finish_reason: 'stop' }] }];
    for (const Constructor of [providers.AzureCompletionsProvider, providers.AzureProvider]) for (const stream of [false, true]) {
      const provider = new Constructor({ type: 'azure', model, apiKey: 'disposable-azure-c', baseUrl }); let result: providers.ChatResponse | undefined;
      if (stream) await provider.streamChat([user], () => {}, value => { result = value; }, error => { throw error; }); else result = await provider.chat([user]);
      expect(result!.reasoning).toBeUndefined(); expect(result!.blocks).toEqual([{ type: 'text', text: 'Ready' }]);
    }
    expect(calls).toHaveLength(13);
  });

  it('refuses text-only C user/tool images before transport without decoding', async () => {
    const reference = completions.rows[0], { calls, baseUrl } = await fixture({ C: reference.seedResponseEvents }, { C: reference.syntheticJsonResponse }); let refused = 0;
    for (const Constructor of [providers.AzureCompletionsProvider, providers.AzureProvider]) for (const stream of [false, true]) for (const tool of [false, true]) {
      const user: Message = { id: 'image-u', role: 'user', content: 'before', timestamp: new Date(0) }, image = { type: 'image' as const, mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' };
      const history: Message[] = tool ? [user, { ...user, id: 'image-a', role: 'assistant', content: 'called', toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { ...user, id: 'image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', blocks: [image] }] : [{ ...user, blocks: [image] }], before = structuredClone(history);
      const provider = new Constructor({ type: 'azure', model: reference.model, apiKey: 'disposable-azure-c', baseUrl }), invoke = () => stream ? provider.streamChat(history, () => {}, undefined, error => { throw error; }) : provider.chat(history);
      await expect(invoke()).rejects.toThrow('Azure completion model does not support images.'); expect(history).toEqual(before); refused++;
    }
    expect(refused).toBe(8); expect(calls).toHaveLength(0);
  });

  it('withdraws C pending tools on EOF/error/awaited abort and awaits completion failures', async () => {
    const reference = completions.rows[0], events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events, { C: reference.syntheticJsonResponse });
    const user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
    for (const Constructor of [providers.AzureCompletionsProvider, providers.AzureProvider]) {
      for (const mode of ['eof', 'error', 'abort']) {
        const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]];
        events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_AZURE_C_FAILURE' } }] : frames;
        const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = [];
        await new Constructor({ type: 'azure', model: reference.model, apiKey: 'disposable-azure-c', baseUrl }).streamChat([user], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
        expect(complete).not.toHaveBeenCalled(); expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-azure-c-/); expect(seen.join('')).not.toMatch(/opaque-azure-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
      }
      events.C = reference.seedResponseEvents; const errors: Error[] = [];
      await new Constructor({ type: 'azure', model: reference.model, apiKey: 'disposable-azure-c', baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_AZURE_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' });
      expect(errors.map(error => error.message)).toEqual(['Azure completion request failed.']);
    }
    expect(calls).toHaveLength(8);
  });
});
