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
import { MoonshotProvider, MOONSHOT_MODELS, OpenAiProvider, ProviderFactory } from './index.js';
import * as providers from './index.js';
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const first = 'kimi-k2.6', second = 'kimi-k2.7-code', fast = 'kimi-k2.7-code-highspeed', latest = 'kimi-k3';
const ids = [first, second, fast, latest], levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/moonshot-continuation-reference-completions.json', import.meta.url), 'utf8'));
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
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fmoonshot/v1` };
}

describe('explicit native Moonshot C SDK', () => {
  it.each(completionModels)('compares independently bound whole private Moonshot C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    for (const facade of ['chat', 'stream']) {
      const provider = new MoonshotProvider({ type: 'moonshotai', model, apiKey: 'disposable-moonshot-c', baseUrl }), user: Message = { ...input, content: 'probe' };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Moonshot C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (history: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(history, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(history, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-moonshot-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'moonshotai', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { ...user, id: 'c-a', role: 'assistant', content: firstResult.content, ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Moonshot C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ ...user, id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ ...user, id: 'c-sys', role: 'system', content: 'Leading system' }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Moonshot C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-moonshot-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-moonshot-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value), registry = new ExtensionRegistry();
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Moonshot global private replay' }), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', ...(reference.published.compat.requiresReasoningContentOnAssistantMessages ? { reasoning_content: '' } : {}) }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'moonshotai', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'moonshotai', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-moonshot-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-moonshot-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'moonshotai', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-moonshot-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_MOONSHOT_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_MOONSHOT_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'), entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Moonshot C reference system\n\n[Context Summary] PUBLIC_MOONSHOT_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(54); for (const call of calls) { expect(call.url).toBe('/owned%2Fmoonshot/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-moonshot-c'); }
  });

  it('pins private global C body identity, awaits publication and refuses CN or derived grants', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === first); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies), user: Message = { ...input, content: 'probe' };
    const expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [first, latest]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new MoonshotProvider({ type: 'moonshotai', apiKey: 'disposable-moonshot-c', model, baseUrl }); provider.getProviderType = () => 'forged-moonshot-c-provider'; provider.getModelApi = () => 'forged-moonshot-c-api'; let reads = 0, captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Moonshot C reference system', sessionId: 'moonshot-c-bound' }, options = { ...base, get model() { return ++reads === 1 ? (model === first ? latest : first) : model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === first ? latest : first); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'moonshotai', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = MOONSHOT_MODELS.find(profile => profile.id === model)!.pricing; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { ...user, id: 'c-getter-a', role: 'assistant', content: captured!.content, provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { ...user, id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result' }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === first ? latest : first)); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); reference = completions.rows.find((row: { model: string }) => row.model === first); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new MoonshotProvider({ type: 'operator', apiKey: 'disposable-moonshot-c', model: first, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' });
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [first, latest]) { const errors: Error[] = []; await new MoonshotProvider({ type: 'moonshotai', apiKey: 'disposable-moonshot-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_MOONSHOT_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['Moonshot chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'moonshotai', api: 'openai-completions', model: first, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'moonshotai', apiKey: 'disposable-moonshot-c', model: first, baseUrl };
    expect((await new OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedMoonshot extends MoonshotProvider {} const derived = new DerivedMoonshot(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; await expect(derived.chat([source, user])).rejects.toThrow('Unsupported Moonshot reasoning replay.'); await expect(new providers.MoonshotCnProvider({ ...config, type: 'moonshotai-cn' }).chat([source, user])).rejects.toThrow('Unsupported Moonshot reasoning replay.');
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-moonshot-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-4)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-moonshot-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new MoonshotProvider(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedMoonshot(config).chat([user])).reasoning).toBe('LEGACY_SUMMARY'); expect(calls).toHaveLength(21);
  });

  it('keeps global C tool-image attribution once without changing CN or image preparation', async () => {
    const { calls, baseUrl } = await fixture();
    for (const profile of MOONSHOT_MODELS) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { ...input, id: 'c-image-a', role: 'assistant', content: 'called', provider: 'moonshotai', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { ...input, id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new MoonshotProvider({ type: 'moonshotai', apiKey: 'disposable-moonshot-c', model: profile.id, baseUrl });
      if (facade === 'chat') await provider.chat(history); else await provider.streamChat(history, () => {}, undefined, error => { throw error; });
      expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', ...(profile.requiresReasoningContent ? { reasoning_content: '' } : {}), tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(8);
  });

  it('withdraws global C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === first), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_MOONSHOT_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new MoonshotProvider({ type: 'moonshotai', apiKey: 'disposable-moonshot-c', model: first, baseUrl }).streamChat([input], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-moonshot-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-moonshot-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });

  it('keeps generic compatible thinking distinct from native K2 policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new OpenAiProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: first }).chat([input], { thinking: 'high' });
    expect(calls[0].body.reasoning_effort).toBe('high'); expect(calls[0].body).not.toHaveProperty('thinking');
  });

  it('publishes four deeply frozen profiles and defensive alias-independent metadata without discovery', async () => {
    const { calls, baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(MOONSHOT_MODELS.map(row => row.id)).toEqual(ids); expect(Object.isFrozen(MOONSHOT_MODELS)).toBe(true);
    expect(MOONSHOT_MODELS.every(row => Object.isFrozen(row) && Object.isFrozen(row.pricing) && Object.isFrozen(row.declaredInput) && Object.isFrozen(row.declaredInputLimits?.images.resize))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false); expect(ProviderFactory.has('moonshotai')).toBe(false);
    const row = getProviderPublishedModel('azure', latest, provider)!;
    expect(row).toMatchObject({ name: 'Kimi K3', api: 'openai-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 } });
    row.contextWindow = 1; row.pricing!.inputPerMillion = 99; row.thinkingLevelMap!.low = 'changed';
    expect(getProviderPublishedModel('azure', latest, provider)).toMatchObject({ contextWindow: 1048576, thinkingLevelMap: { low: 'low' }, pricing: { inputPerMillion: 3 } });
    expect(getProviderPublishedModel('azure', 'gpt-4o', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('azure', first, undefined, provider)).toEqual(levels.slice(0, 5));
    expect(getSupportedThinkingLevels('azure', second, undefined, provider)).toEqual(levels.slice(1, 5));
    expect(getSupportedThinkingLevels('azure', latest, undefined, provider)).toEqual(['low', 'high', 'max']);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${first}:classifier`, virtual: true, imageInput: true, contextWindow: 262144 }]); expect(calls).toEqual([]);
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
  });

  it('owns K2 thinking versus K3 effort, mandatory replay and non-strict tools under unrelated aliases', async () => {
    const { calls, baseUrl } = await fixture();
    const history: Message = { ...input, role: 'assistant', content: 'Before', blocks: [{ type: 'reasoning', text: 'Earlier' }, { type: 'text', text: 'Before' }] };
    for (const type of ['azure', 'local', 'operator-moonshot']) {
      const provider = new MoonshotProvider({ type, apiKey: 'disposable-moonshot', baseUrl });
      for (const model of ids) await provider.chat([history, input], { model, thinking: 'high', maxTokens: 64, systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] });
    }
    for (const [index, call] of calls.entries()) {
      expect(call.url).toBe('/owned%2Fmoonshot/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-moonshot');
      expect(call.body).toMatchObject({ max_tokens: 64, messages: [{ role: 'system' }, { role: 'assistant', content: 'EarlierBefore', ...(index % 4 === 3 ? { reasoning_content: '' } : {}) }, { role: 'user' }] });
      expect((call.body.tools as Array<{ function: object }>)[0].function).not.toHaveProperty('strict');
      expect(call.body).not.toHaveProperty('store'); expect(call.body).not.toHaveProperty('tool_stream');
      if (index % 4 === 3) { expect(call.body.reasoning_effort).toBe('high'); expect(call.body).not.toHaveProperty('thinking'); }
      else { expect(call.body.thinking).toEqual({ type: 'enabled' }); expect(call.body).not.toHaveProperty('reasoning_effort'); }
    }
    const provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([{ ...history, blocks: undefined }, input], { model: latest, thinking: 'off' });
    expect(calls.at(-1)?.body).toMatchObject({ reasoning_effort: 'low', max_tokens: 1048576, messages: [{ role: 'assistant', reasoning_content: '' }, { role: 'user' }] });
    await provider.chat([{ ...history, blocks: undefined }, input]); expect((calls.at(-1)?.body.messages as unknown[])[0]).not.toHaveProperty('reasoning_content');
    await provider.chat([{ ...history, content: '', blocks: undefined, toolCalls: [{ id: 'read', name: 'read', input: {} }] }, input], { model: latest });
    expect(calls.at(-1)?.body.tools).toEqual([]); expect((calls.at(-1)?.body.messages as unknown[])[0]).toHaveProperty('reasoning_content', '');
  });

  it('clamps four physical maps, preserves native output and accepts declared vision without mutating selection', async () => {
    const { calls, baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ids) for (const thinking of levels) await provider.chat([input], { model, thinking });
    expect(calls.map(call => call.body.reasoning_effort)).toEqual([...Array(21).fill(undefined), 'low', 'low', 'low', 'high', 'high', 'max', 'max']);
    for (const [index, call] of calls.entries()) { if (index < 21) expect(call.body.thinking).toEqual({ type: index === 0 ? 'disabled' : 'enabled' }); else expect(call.body).not.toHaveProperty('thinking'); }
    const image: Message = { ...input, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    for (const model of ids) await provider.chat([image], { model });
    expect(provider.getConfiguredModel()).toBe(first); expect(calls.at(-1)?.body.messages).toMatchObject([{ content: [{ type: 'text' }, { type: 'image_url' }] }]);
  });

  it('requires explicit keys and refuses invalid selections, limits, endpoints and headers before I/O', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('MOONSHOT_API_KEY', 'ambient-private'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai');
    for (const apiKey of [undefined, '', 'bad\0key', 'bad\nkey', 'bad🔑key']) { const provider = new MoonshotProvider({ type: 'operator', baseUrl, apiKey }); expect(provider.validateConfig()).toBe(false); await expect(provider.chat([input])).rejects.toThrow('Moonshot API key is required.'); }
    const provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future', 'moonshotai', 'dall-e-3']) { expect(() => provider.setConfiguredModel(model)).toThrow('Moonshot chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('Moonshot chat model is not supported.'); }
    for (const maxTokens of [0, -1, 262145, 1.5, Number.NaN]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid Moonshot output limit.');
    for (const endpoint of ['https://user:private@host', 'https://host?private=key', 'https://host#private', 'ftp://host']) expect(() => new MoonshotProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid Moonshot endpoint.');
    await expect(new MoonshotProvider({ type: 'operator', baseUrl, apiKey: 'disposable', customHeaders: { 'x-private': 'private\0header' } }).chat([input])).rejects.toThrow('Invalid Moonshot request headers.'); expect(calls).toEqual([]);
    let endpoint = ''; vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); });
    await new MoonshotProvider({ type: 'operator', apiKey: 'disposable' }).chat([input]); expect(endpoint).toBe('https://api.moonshot.ai/v1/chat/completions');
  });

  it('captures physical model/prices, awaits reasoning and suppresses withdrawn callbacks', async () => {
    const { baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); const events: string[] = []; let result: unknown;
    await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(latest); }, value => { result = value; });
    expect(events).toEqual(['reasoning_delta', 'text_delta']); expect(result).toMatchObject({ provider: 'operator', model: first, api: 'openai-completions', usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12, costUsd: (6 * 0.95 + 2 * 4 + 4 * 0.16) / 1e6 } });
    const abort = new AbortController(), complete = vi.fn(), error = vi.fn(), seen: string[] = [];
    await provider.streamChat([input], async (_text, event) => { seen.push(event!.type); await Promise.resolve(); abort.abort(); }, complete, error, { signal: abort.signal });
    expect(seen).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Moonshot request aborted.');
  });

  it('requires a request-owned valid finish before publishing tools or nested success', async () => {
    for (const finish_reason of [undefined, 'content_filter', 'future']) {
      const { baseUrl } = await fixture([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{}' } }] }, ...(finish_reason ? { finish_reason } : {}) }] }]);
      const provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), complete = vi.fn(), error = vi.fn(), chunk = vi.fn();
      await provider.streamChat([input], chunk, complete, error); expect(chunk).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled(); expect(error.mock.calls[0][0].message).toBe('Invalid Moonshot chat response.');
    }
    const { baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); return new Response((body.model === first ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Outer' }, finish_reason: 'stop' }] }) + '\n\n' : '') + 'data: [DONE]\n\n'); });
    const nestedComplete = vi.fn(), nestedError = vi.fn(), outerComplete = vi.fn(); await provider.streamChat([input], async () => { await provider.streamChat([input], () => {}, nestedComplete, nestedError, { model: latest }); }, outerComplete);
    expect(outerComplete).toHaveBeenCalledOnce(); expect(nestedComplete).not.toHaveBeenCalled(); expect(nestedError.mock.calls[0][0].message).toBe('Invalid Moonshot chat response.');
  });

  it('keeps typed overflow, safe usage and configured finite-classifier privacy distinct', async () => {
    const { baseUrl } = await fixture(), provider = new MoonshotProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'private-body', code: 'context_length_exceeded' } }), { status: 400 })); await expect(provider.chat([input])).rejects.toThrow('The provider context window was exceeded.');
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }]) { vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage }))); expect((await provider.chat([input])).usage).toBeUndefined(); }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: { private: 'not-text' } }, finish_reason: 'stop' }] }))); await expect(provider.chat([input])).rejects.toThrow('Invalid Moonshot chat response.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"safe"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })));
    expect(await new SpecializedModels(provider).classify({ model: `${first}:classifier`, input: 'Approve', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 6, outputTokens: 2, totalTokens: 12 } });
    provider.setConfiguredModel(latest); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${latest}:classifier`, contextWindow: 1048576, imageInput: true }]);
  });
});

describe('explicit native Moonshot CN construction', () => {
  it('publishes the shared immutable four profiles with adapter-owned metadata and no factory', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MoonshotCnProvider({ type: 'google', apiKey: 'disposable', baseUrl });
    expect(providers.MOONSHOT_CN_MODELS).toBe(MOONSHOT_MODELS);
    expect(Object.isFrozen(providers.MOONSHOT_CN_MODELS)).toBe(true);
    expect(providers.MOONSHOT_CN_MODELS.every(row => Object.isFrozen(row) && Object.isFrozen(row.pricing) && Object.isFrozen(row.declaredInput) && Object.isFrozen(row.declaredInputLimits?.images.resize))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(ids); expect(provider.canDiscoverModels()).toBe(false);
    expect(ProviderFactory.has('moonshotai-cn')).toBe(false);
    expect(getProviderPublishedModel('google', latest, provider)).toMatchObject({ api: 'openai-completions', contextWindow: 1048576, maxOutputTokens: 1048576,
      capabilities: { reasoning: true, imageInput: true, toolCalls: true }, pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 } });
    expect(getProviderPublishedModel('google', 'gemini-2.5-pro', provider)).toBeUndefined();
    expect(getSupportedThinkingLevels('google', second, undefined, provider)).toEqual(levels.slice(1, 5));
    expect(getSupportedThinkingLevels('google', latest, undefined, provider)).toEqual(['low', 'high', 'max']);
    provider.setConfiguredModel(latest); expect(provider.getSpecializedModels()).toMatchObject([{ id: `${latest}:classifier`, model: latest, api: 'openai-completions', contextWindow: 1048576, imageInput: true }]);
    expect(calls).toEqual([]);
  });

  it('selects the CN default only by explicit construction and never reads ambient keys', async () => {
    const calls: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
    vi.stubEnv('MOONSHOT_API_KEY', 'ambient-private');
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers); calls.push({ url: String(url), authorization: headers.get('authorization'), apiKey: headers.get('x-api-key') });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }));
    });
    await new providers.MoonshotCnProvider({ type: 'operator', apiKey: 'disposable-cn' }).chat([input]);
    await new MoonshotProvider({ type: 'moonshotai-cn', apiKey: 'disposable-global' }).chat([input]);
    await new providers.MoonshotCnProvider({ type: 'operator', apiKey: 'disposable-custom', baseUrl: 'https://proxy.invalid/owned%2Fcn/v1/' }).chat([input]);
    expect(calls).toEqual([
      { url: 'https://api.moonshot.cn/v1/chat/completions', authorization: 'Bearer disposable-cn', apiKey: null },
      { url: 'https://api.moonshot.ai/v1/chat/completions', authorization: 'Bearer disposable-global', apiKey: null },
      { url: 'https://proxy.invalid/owned%2Fcn/v1/chat/completions', authorization: 'Bearer disposable-custom', apiKey: null },
    ]);
    const missing = new providers.MoonshotCnProvider({ type: 'operator' }); expect(missing.validateConfig()).toBe(false);
    await expect(missing.chat([input])).rejects.toThrow('Moonshot API key is required.'); expect(calls).toHaveLength(3);
    expect(() => new providers.MoonshotCnProvider({ type: 'operator', baseUrl: 'https://user:private@host' })).toThrow('Invalid Moonshot endpoint.');
  });

  it('inherits native K2/K3 JSON-SSE policy, exact caps and captured physical prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.MoonshotCnProvider({ type: 'google', apiKey: 'disposable-cn', baseUrl });
    for (const profile of MOONSHOT_MODELS) {
      provider.setConfiguredModel(profile.id);
      const response = await provider.chat([input], { model: '', thinking: 'high', maxTokens: 64 });
      expect(response).toMatchObject({ provider: 'google', model: profile.id, api: 'openai-completions', content: 'Ready',
        usage: { promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12,
          costUsd: (6 * profile.pricing.inputPerMillion + 2 * profile.pricing.outputPerMillion + 4 * profile.pricing.cacheReadPerMillion) / 1e6 } });
      let final: unknown; const events: string[] = [];
      await provider.streamChat([input], async (_text, event) => { await Promise.resolve(); events.push(event!.type); provider.setConfiguredModel(latest); }, value => { final = value; }, error => { throw error; }, { model: '', thinking: 'off', maxTokens: 64 });
      expect(events).toEqual(['reasoning_delta', 'text_delta']);
      expect(final).toMatchObject({ provider: 'google', model: profile.id, api: 'openai-completions', content: 'Ready', usage: response.usage });
    }
    expect(calls).toHaveLength(8);
    for (const [index, call] of calls.entries()) {
      const profile = MOONSHOT_MODELS[Math.floor(index / 2)];
      expect(call.url).toBe('/owned%2Fmoonshot/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-cn'); expect(call.headers['x-api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ model: profile.id, max_tokens: 64 });
      for (const field of ['store', 'max_completion_tokens', 'tool_stream']) expect(call.body).not.toHaveProperty(field);
      if (profile.id === latest) { expect(call.body.reasoning_effort).toBe(index % 2 ? 'low' : 'high'); expect(call.body).not.toHaveProperty('thinking'); }
      else { expect(call.body.thinking).toEqual({ type: index % 2 && profile.id === first ? 'disabled' : 'enabled' }); expect(call.body).not.toHaveProperty('reasoning_effort'); }
    }
  });
});

describe('native Moonshot operation-owned model provenance', () => {
  it.each([{ name: 'global', Provider: MoonshotProvider }, { name: 'CN', Provider: providers.MoonshotCnProvider }])('$name captures the physical model before awaits despite remote aliases and configuration changes', async ({ Provider }) => {
    for (const stream of [false, true]) {
      const provider = new Provider({ type: 'google', apiKey: 'disposable', model: first });
      const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); expect(body.model).toBe(first); expect(body.max_tokens).toBe(64);
        await Promise.resolve(); provider.setConfiguredModel(latest);
        const choices = [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }];
        return stream ? new Response([
          { model: 'remote-alias', choices: [{ delta: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }] }, { choices: [], usage },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
          : new Response(JSON.stringify({ model: 'remote-alias', choices, usage }));
      });
      let response: unknown;
      if (stream) await provider.streamChat([input], async () => { await Promise.resolve(); }, value => { response = value; }, error => { throw error; }, { model: '', maxTokens: 64 });
      else response = await provider.chat([input], { model: '', maxTokens: 64 });
      expect(provider.getConfiguredModel()).toBe(latest);
      expect(response).toMatchObject({ provider: 'google', model: first, api: 'openai-completions', content: 'Ready',
        usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.95 + 2 * 4 + 4 * 0.16) / 1e6 } });
    }
  });
});
