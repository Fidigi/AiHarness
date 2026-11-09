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
import { ZaiProvider, ZAI_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { collectProviderModelCatalog } from './model-catalog.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'glm-4.7', second = 'glm-5.2', latest = 'glm-5.3', vision = 'glm-5.3-flash', unknown = 'glm-5.3-highspeed';
const ids = [first, 'glm-5-turbo', second, 'glm-5.2-highspeed', latest, vision, unknown];
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/zai-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(events?: unknown[] | { C?: unknown[] }, reply?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } };
    if (body.stream) { response.setHeader('content-type', 'text/event-stream'); response.end(((Array.isArray(events) ? events : events?.C) ?? [
      { choices: [{ delta: { reasoning_content: 'Thought', reasoning: 'Thought', content: 'Ready' }, finish_reason: 'stop' }] }, { choices: [], usage },
    ]).map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'); }
    else response.end(JSON.stringify(reply?.C ?? reply ?? { model: body.model, choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fzai/api/coding/paas/v4` };
}

describe('explicit native Z.ai C SDK', () => {
  it.each(completionModels)('compares independently bound whole private Z.ai C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.ZaiProvider({ type: 'zai', model, apiKey: 'disposable-zai-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Z.ai C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-zai-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'zai', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: firstResult.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Z.ai C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Z.ai C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-zai-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-zai-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Z.ai C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok' }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'zai', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'zai', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-zai-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-zai-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'zai', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-zai-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_ZAI_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_ZAI_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Z.ai C reference system\n\n[Context Summary] PUBLIC_ZAI_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(54); for (const call of calls) { expect(call.url).toBe('/owned%2Fzai/api/coding/paas/v4/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-zai-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins private C body identity/prices and marker policy, awaits publication and refuses forged grants', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === first); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const user: Message = { ...input, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [first, second]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new providers.ZaiProvider({ type: 'zai', apiKey: 'disposable-zai-c', model, baseUrl }); provider.getProviderType = () => 'forged-zai-c-provider'; provider.getModelApi = () => 'forged-zai-c-api'; let captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Z.ai C reference system', sessionId: 'zai-c-bound' }, options = { ...base, get model() { return model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === first ? second : first); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'zai', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = providers.ZAI_MODELS.find(profile => profile.id === model)!.pricing!; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === first ? second : first)); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) for (const field of ['session_id', 'x-client-request-id', 'x-session-affinity']) expect(call.headers[field]).toBeUndefined();
    reference = completions.rows.find((row: { model: string }) => row.model === first); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new providers.ZaiProvider({ type: 'operator', apiKey: 'disposable-zai-c', model: first, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(alias).not.toHaveProperty(field);
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [first, second]) { const errors: Error[] = []; await new providers.ZaiProvider({ type: 'zai', apiKey: 'disposable-zai-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_ZAI_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['Z.ai chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'zai', api: 'openai-completions', model: first, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'zai', apiKey: 'disposable-zai-c', model: first, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedZai extends providers.ZaiProvider {} const derived = new DerivedZai(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; derived.getProviderType = () => 'zai'; await expect(derived.chat([source, user])).rejects.toThrow('Unsupported Z.ai reasoning replay.');
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zai-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-zai-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new providers.ZaiProvider(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedZai(config).chat([user])).reasoning).toBe('LEGACY_SUMMARY'); expect(calls).toHaveLength(20);
  });

  it('keeps existing C tool-image attribution once and refuses undeclared images without decoding', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const profile of providers.ZAI_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'zai', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new providers.ZaiProvider({ type: 'zai', apiKey: 'disposable-zai-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('Z.ai chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); } expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(2); expect(refusals).toBe(12);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === first), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_ZAI_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new providers.ZaiProvider({ type: 'zai', apiKey: 'disposable-zai-c', model: first, baseUrl }).streamChat([input], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-zai-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-zai-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });

  it('leaves generic compatible thinking and tool-stream policy distinct', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }).chat([input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
    expect(calls[0].body).toMatchObject({ max_tokens: 64, reasoning_effort: 'high', messages: [{ role: 'system' }, { role: 'user' }] });
    expect(calls[0].body).not.toHaveProperty('thinking'); expect(calls[0].body).not.toHaveProperty('tool_stream');
  });

  it('publishes seven immutable profiles with defensive metadata and unknown highspeed prices', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(ZAI_MODELS.map(profile => profile.id)).toEqual(ids); expect(Object.isFrozen(ZAI_MODELS)).toBe(true);
    expect(ZAI_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.declaredPricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(provider.getConfiguredModel()).toBe(first); expect(ProviderFactory.has('zai')).toBe(false);
    for (const id of ids) expect(provider.getModelApi(id)).toBe('openai-completions');
    const row = getProviderPublishedModel('azure', vision, provider)!;
    expect(row).toMatchObject({ name: 'GLM-5.3-Flash', contextWindow: 1000000, maxOutputTokens: 131072, capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 0.15, outputPerMillion: 0.5, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.high = 'changed';
    expect(getProviderPublishedModel('azure', vision, provider)).toMatchObject({ contextWindow: 1000000, thinkingLevelMap: { high: 'high' } }); expect(getProviderPublishedModel('azure', 'gpt-4o', provider)).toBeUndefined();
    for (const id of ['glm-5.2-highspeed', unknown]) { expect(getProviderPublishedModel('azure', id, provider)?.pricing).toBeUndefined(); expect(ZAI_MODELS.find(row => row.id === id)?.declaredPricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 }); }
    expect(getSupportedThinkingLevels('azure', first, undefined, provider)).toEqual(levels.slice(0,5));
    expect(getSupportedThinkingLevels('azure', second, undefined, provider)).toEqual(['off', 'high', 'max']);
    expect(getSupportedThinkingLevels('azure', latest, undefined, provider)).toEqual(['low', 'high', 'max']);
    const catalog = await collectProviderModelCatalog(new Map([['azure', provider]]), { discover: false }); expect(catalog[0].models.map(model => model.id)).toEqual(ids); expect(calls).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${first}:classifier`, virtual: true, imageInput: false, api: 'openai-completions', contextWindow: 204800 }]); expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('owns native thinking/tool-stream, system roles and foreign visible reasoning independently of aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const history: Message = { id: 'history', role: 'assistant', content: 'Before', timestamp: new Date(0), blocks: [{ type: 'reasoning', text: 'Earlier' }, { type: 'text', text: 'Before' }] };
    for (const type of ['azure', 'local', 'operator-zai']) {
      const provider = new ZaiProvider({ type, apiKey: 'disposable-zai', baseUrl, model: first });
      expect(await provider.chat([history, input], { thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] })).toMatchObject({ provider: type, model: first, api: 'openai-completions', reasoning: 'Thought', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.6 + 2 * 2.2 + 4 * 0.11) / 1e6 } });
    }
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fzai/api/coding/paas/v4/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-zai'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ max_tokens: 64, thinking: { type: 'enabled', clear_thinking: false }, tool_stream: true, messages: [{ role: 'system' }, { role: 'assistant', content: 'EarlierBefore' }, { role: 'user' }], tools: [{ function: { strict: false } }] });
      expect(call.body).not.toHaveProperty('reasoning_effort'); expect(call.body).not.toHaveProperty('store'); expect(call.body).not.toHaveProperty('prompt_cache_key');
    }
    const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...history, blocks: [{ type: 'text', text: 'Before' }] }, input]); expect(calls[3].body).toMatchObject({ max_tokens: 131072, thinking: { type: 'disabled' } }); expect((calls[3].body.messages as unknown[])[0]).not.toHaveProperty('reasoning_content'); expect(calls[3].body).not.toHaveProperty('tool_stream');
    await provider.chat([input], { sessionId: '🔑'.repeat(70), cacheRetention: 'long' }); expect(calls[4].body).toMatchObject({ prompt_cache_key: '🔑'.repeat(64), prompt_cache_retention: '24h' });
    await provider.chat([input], { sessionId: 'not-affinity', cacheRetention: 'none' }); expect(calls[5].body).not.toHaveProperty('prompt_cache_key'); expect(calls[5].headers['x-session-id']).toBeUndefined();
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new ZaiProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  it('clamps all seven maps and refuses unsupported models, images and limits before I/O', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'zai', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Z.ai chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Z.ai chat model is not supported.'); }
    for (const maxTokens of [0, -1, 131073, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Z.ai output limit.');
    const image: Message = { ...input, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    for (const model of ids.filter(id => id !== vision)) await expect(provider.chat([image], { model })).rejects.toThrow('Z.ai chat model does not support images.'); expect(calls).toEqual([]);
    for (const model of ids) for (const thinking of levels) await provider.chat([input], { model, thinking, systemPrompt: 'System' });
    const effort52 = [undefined, 'high', 'high', 'high', 'high', 'max', 'max'], effort53 = ['low', 'low', 'low', 'high', 'high', 'max', 'max'];
    expect(calls.map(call => call.body.reasoning_effort)).toEqual([...Array(14).fill(undefined), ...effort52, ...effort52, ...effort53, ...effort53, ...effort53]);
    for (const [index,call] of calls.entries()) { expect(call.body.messages).toMatchObject([{ role: 'system' }, { role: 'user' }]); expect(call.body.thinking).toEqual(index < 28 && index % 7 === 0 ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false }); }
    await provider.chat([image], { model: vision }); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]); expect(provider.getConfiguredModel()).toBe(first);
  });

  it('requires explicit representable keys and safe endpoints/headers without environment fallback', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('ZAI_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new ZaiProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('Z.ai API key is required.'); }
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new ZaiProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Z.ai endpoint.');
    await expect(new ZaiProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid Z.ai request headers.'); expect(calls).toEqual([]);
    await new ZaiProvider({ type: 'operator', baseUrl: baseUrl + '/chat/completions/', apiKey: 'disposable' }).chat([input]); expect(calls[0].url).toBe('/owned%2Fzai/api/coding/paas/v4/chat/completions');
  });

  it('awaits deduplicated reasoning, captures physical prices/model and suppresses withdrawn callbacks', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(unknown); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(calls[0].body).toMatchObject({ model: first, stream_options: { include_usage: true } });
    expect(result).toMatchObject({ model: first, provider: 'operator', api: 'openai-completions', reasoning: 'Thought', usage: { costUsd: (6 * 0.6 + 2 * 2.2 + 4 * 0.11) / 1e6 } });
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0].message).toBe('Z.ai request aborted.');
  });

  it('requires own valid finish before tools/success, including nested calls and tool history', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Invalid Z.ai chat response.');
    }
    const good = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"file"}' } }] }, finish_reason: 'tool_calls' }] }]);
    const toolEvents: unknown[] = []; let toolResult: unknown; const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl: good.baseUrl });
    await provider.streamChat([input], (_text,event) => { toolEvents.push(event); }, value => { toolResult = value; });
    expect(toolEvents).toEqual([{ type: 'tool_call', data: { id: 'read', name: 'read', input: { path: 'file' } } }]); expect(toolResult).toMatchObject({ api: 'openai-completions', toolCalls: [{ id: 'read', input: { path: 'file' } }] });
    await provider.chat([{ ...input, role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', input: {} }] }, input]); expect(good.calls[1].body.tools).toEqual([]); expect(good.calls[1].body).not.toHaveProperty('tool_stream');
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === first ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn(); await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: vision }); }, outerComplete);
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid Z.ai chat response.');
  });

  it('preserves genuine overflow, unknown usage/prices and finite virtual classification privacy', async () => {
    const { baseUrl } = await fixture(); const provider = new ZaiProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 })); await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: { private: 'not-text' } }, finish_reason: 'stop' }] }))); await expect(provider.chat([input])).rejects.toThrow('Invalid Z.ai chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })));
    expect(await new SpecializedModels(provider).classify({ model: `${first}:classifier`, input: 'Approve', labels: ['safe','review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, totalTokens: 12 } });
    provider.setConfiguredModel(unknown); expect((await provider.chat([input])).usage).toMatchObject({ promptTokens: 6, completionTokens: 2, totalTokens: 12 }); expect((await provider.chat([input])).usage).not.toHaveProperty('costUsd'); expect(provider.getSpecializedModels()[0]).not.toHaveProperty('pricing');
  });
});
