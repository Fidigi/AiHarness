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
import { CloudflareWorkersAiChatProvider, CLOUDFLARE_CHAT_MODELS, ProviderFactory, CloudflareWorkersAiProvider } from './index.js';
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/cloudflare-workers-ai-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const first = '@cf/deepseek-ai/deepseek-v4-flash-0731', second = '@cf/deepseek-ai/deepseek-v4-pro-0813';
const model = '@cf/deepseek-ai/deepseek-v4-flash-0731', vision = '@cf/google/gemma-4-26b-a4b-it';
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply?: ((body: Record<string, unknown>) => Record<string, unknown>) | { C?: unknown[] }, replies?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      response.end(((typeof reply === 'function' ? undefined : reply?.C) ?? [{ choices: [{ delta: { reasoning_content: 'Thought' } }] }, { model: body.model, choices: [{ delta: { content: 'Ready' }, finish_reason: 'stop' }], usage }])
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    } else response.end(JSON.stringify(replies?.C ?? { model: body.model, usage, ...(typeof reply === 'function' ? reply(body) : { choices: [{ message: { content: 'Ready', reasoning_content: 'Thought' }, finish_reason: 'stop' }] }) }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fowned/ai`;
  return { calls, baseUrl, provider: new CloudflareWorkersAiChatProvider({ type: 'operator-cloudflare', apiKey: 'disposable-cloudflare-chat', model, baseUrl }) };
}

describe('explicit Cloudflare Workers AI C SDK', () => {
  it.each(completionModels)('compares independently bound whole private Cloudflare Workers AI C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const Ctor of [providers.CloudflareWorkersAiChatProvider, providers.CloudflareWorkersAiMixedProvider]) for (const facade of ['chat', 'stream']) {
      const provider = new Ctor({ type: 'cloudflare-workers-ai', model, apiKey: 'disposable-cloudflare-workers-ai-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned Cloudflare Workers AI C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-cloudflare-workers-ai-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'cloudflare-workers-ai', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: firstResult.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Cloudflare Workers AI C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Cloudflare Workers AI C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-cloudflare-workers-ai-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-cloudflare-workers-ai-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Cloudflare Workers AI C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', ...(reference.published.compat.requiresReasoningContentOnAssistantMessages ? { reasoning_content: '' } : {}) }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'cloudflare-workers-ai', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'cloudflare-workers-ai', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-cloudflare-workers-ai-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-cloudflare-workers-ai-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'cloudflare-workers-ai', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-cloudflare-workers-ai-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_CLOUDFLARE_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_CLOUDFLARE_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned Cloudflare Workers AI C reference system\n\n[Context Summary] PUBLIC_CLOUDFLARE_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(108); for (const call of calls) { expect(call.url).toBe('/proxy%2Fowned/ai/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-cloudflare-workers-ai-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins private C body identity/prices and marker policy, awaits publication and refuses forged grants', async () => {
    for (const Ctor of [providers.CloudflareWorkersAiChatProvider, providers.CloudflareWorkersAiMixedProvider]) {
    let reference = completions.rows.find((row: { model: string }) => row.model === first); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const user: Message = { ...message, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [first, second]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new Ctor({ type: 'cloudflare-workers-ai', apiKey: 'disposable-cloudflare-workers-ai-c', model, baseUrl }); provider.getProviderType = () => 'forged-cloudflare-workers-ai-c-provider'; provider.getModelApi = () => 'forged-cloudflare-workers-ai-c-api'; let captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned Cloudflare Workers AI C reference system', sessionId: 'cloudflare-workers-ai-c-bound' }, options = { ...base, get model() { return model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === first ? second : first); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'cloudflare-workers-ai', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = providers.CLOUDFLARE_CHAT_MODELS.find(profile => profile.id === model)!.pricing!; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === first ? second : first)); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) for (const field of ['session_id', 'x-client-request-id', 'x-session-affinity']) expect(call.headers[field]).toBeUndefined();
    reference = completions.rows.find((row: { model: string }) => row.model === first); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new Ctor({ type: 'operator', apiKey: 'disposable-cloudflare-workers-ai-c', model: first, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(alias).not.toHaveProperty(field);
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [first, second]) { const errors: Error[] = []; await new Ctor({ type: 'cloudflare-workers-ai', apiKey: 'disposable-cloudflare-workers-ai-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_CLOUDFLARE_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['Cloudflare chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'cloudflare-workers-ai', api: 'openai-completions', model: first, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'cloudflare-workers-ai', apiKey: 'disposable-cloudflare-workers-ai-c', model: first, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedDirect extends providers.CloudflareWorkersAiChatProvider {} class DerivedMixed extends providers.CloudflareWorkersAiMixedProvider {} const DerivedCloudflare = Ctor === providers.CloudflareWorkersAiChatProvider ? DerivedDirect : DerivedMixed, derived = new DerivedCloudflare(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; derived.getProviderType = () => 'cloudflare-workers-ai'; expect((await derived.chat([source, user])).blocks).toBeUndefined();
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-cloudflare-workers-ai-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-cloudflare-workers-ai-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new Ctor(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedCloudflare(config).chat([user])).reasoning).toBe('LEGACY_SUMMARY'); expect(calls).toHaveLength(20);
    }
  });

  it('keeps existing C tool-image attribution once and refuses undeclared images without decoding', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const Ctor of [providers.CloudflareWorkersAiChatProvider, providers.CloudflareWorkersAiMixedProvider]) for (const profile of providers.CLOUDFLARE_CHAT_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...message, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'cloudflare-workers-ai', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...message, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new Ctor({ type: 'cloudflare-workers-ai', apiKey: 'disposable-cloudflare-workers-ai-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('Cloudflare chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', ...(profile.compat.requiresReasoningContentOnAssistantMessages ? { reasoning_content: '' } : {}), tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); } expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(28); expect(refusals).toBe(44);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === first), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const Ctor of [providers.CloudflareWorkersAiChatProvider, providers.CloudflareWorkersAiMixedProvider]) for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_CLOUDFLARE_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new Ctor({ type: 'cloudflare-workers-ai', apiKey: 'disposable-cloudflare-workers-ai-c', model: first, baseUrl }).streamChat([message], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-cloudflare-workers-ai-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-cloudflare-workers-ai-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(6);
  });


  it('publishes eighteen reviewed chat profiles, not classifier/image models or a factory reservation', async () => {
    const { provider, calls } = await fixture();
    expect(CLOUDFLARE_CHAT_MODELS).toHaveLength(18); expect(Object.isFrozen(CLOUDFLARE_CHAT_MODELS)).toBe(true);
    expect(CLOUDFLARE_CHAT_MODELS.every(profile => Object.isFrozen(profile) && Object.isFrozen(profile.pricing) && Object.isFrozen(profile.declaredInput))).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(CLOUDFLARE_CHAT_MODELS.map(profile => profile.id));
    expect(provider.canDiscoverModels()).toBe(false); expect(provider.getModelApi(model)).toBe('openai-completions');
    expect(provider.getConfiguredModel()).toBe(model); expect(ProviderFactory.has('cloudflare-workers-ai')).toBe(false);
    expect(new SpecializedModels(provider).getModelsOfType('image')).toEqual([]);
    expect(provider.getSpecializedModels()).toMatchObject([{ id: `${model}:classifier`, virtual: true, api: 'openai-completions' }]);
    expect(new CloudflareWorkersAiProvider({ type: 'cloudflare-test', apiKey: 'disposable', baseUrl: 'https://proxy/ai' }).getConfiguredModel()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('uses native Bearer/versioned proxy, DeepSeek thinking/replay and disjoint priced counters under operator aliases', async () => {
    const { provider, calls, baseUrl } = await fixture();
    const history: Message = { ...message, role: 'assistant', blocks: [{ type: 'reasoning', text: 'Earlier thought' }] };
    const result = await provider.chat([history, message], { thinking: 'max', systemPrompt: 'System', sessionId: 'owned-session', maxTokens: 100 });
    expect(result).toMatchObject({ content: 'Ready', reasoning: 'Thought', api: 'openai-completions', provider: 'operator-cloudflare', model,
      usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.44 + 2 * 1.32 + 4 * 0.014) / 1_000_000 } });
    expect(calls[0].url).toBe('/proxy%2Fowned/ai/v1/chat/completions');
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer disposable-cloudflare-chat', session_id: 'owned-session', 'x-client-request-id': 'owned-session', 'x-session-affinity': 'owned-session' });
    expect(calls[0].headers['api-key']).toBeUndefined(); expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].body).toMatchObject({ model, max_completion_tokens: 100, thinking: { type: 'enabled' }, reasoning_effort: 'max',
      messages: [{ role: 'system', content: 'System' }, { role: 'assistant', content: 'Earlier thoughtHello', reasoning_content: '' }, { role: 'user', content: 'Hello' }] });
    expect(calls[0].body).not.toHaveProperty('max_tokens');
    expect(calls[0].body).not.toHaveProperty('store'); expect(calls[0].body).not.toHaveProperty('prompt_cache_retention');
    const chunks: Array<{ chunk: string; event: unknown }> = []; let complete: unknown;
    await provider.streamChat([message], async (chunk, event) => { chunks.push({ chunk, event }); }, value => { complete = value; }, undefined, { thinking: 'off', cacheRetention: 'long', sessionId: 'owned-session' });
    expect(chunks).toEqual([{ chunk: '', event: { type: 'reasoning_delta', data: { content: 'Thought' } } }, { chunk: 'Ready', event: { type: 'text_delta' } }]); expect(complete).toMatchObject({ content: 'Ready', provider: 'operator-cloudflare', api: 'openai-completions', usage: result.usage });
    expect(calls[1].body).toMatchObject({ thinking: { type: 'disabled' }, stream_options: { include_usage: true } });
    expect(calls[1].body).not.toHaveProperty('reasoning_effort'); expect(calls[1].body).not.toHaveProperty('prompt_cache_retention');
    const azure = new CloudflareWorkersAiChatProvider({ type: 'azure', apiKey: 'disposable-cloudflare-chat', baseUrl, model });
    expect((await azure.chat([message])).api).toBe('openai-completions');
    expect(calls[2].url).toBe(calls[0].url); expect(calls[2].headers['api-key']).toBeUndefined();
  });

  it('admits only reviewed chat IDs/images/output limits before I/O and keeps unknown transport prices out', async () => {
    const { provider, calls, baseUrl } = await fixture();
    for (const target of ['future', '@cf/cloudflare/clef', 'typesafe/jev']) {
      expect(() => new CloudflareWorkersAiChatProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: target })).toThrow('Cloudflare chat model is not supported.');
      await expect(provider.chat([message], { model: target })).rejects.toThrow('Cloudflare chat model is not supported.');
      expect(() => provider.setConfiguredModel(target)).toThrow('Cloudflare chat model is not supported.');
    }
    expect(provider.getConfiguredModel()).toBe(model);
    const image: Message = { ...message, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L3sAAAAASUVORK5CYII=' }] };
    await expect(provider.chat([image])).rejects.toThrow('Cloudflare chat model does not support images.');
    await expect(provider.chat([message], { maxTokens: 0 })).rejects.toThrow('Invalid Cloudflare output limit.');
    expect(calls).toEqual([]);
    provider.setConfiguredModel(vision); await provider.chat([image], { thinking: 'off' });
    expect(calls[0].body).toMatchObject({ model: vision, reasoning_effort: 'none', messages: [{ content: [{ type: 'text', text: 'Hello' }, { type: 'image_url' }] }] });
  });

  it('requires explicit account/key or safe full endpoint, never ambient auth or gateway headers', async () => {
    const { calls, baseUrl } = await fixture();
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'ambient-account'); vi.stubEnv('CLOUDFLARE_API_KEY', 'ambient-key');
    for (const config of [{}, { accountId: '' }, { accountId: 'bad\0account' }, { baseUrl: 'https://user:private@host/ai' },
      { baseUrl: 'https://host/ai?private=key' }, { baseUrl: 'https://host/ai#private' }, { baseUrl: 'ftp://host/ai' }, { baseUrl: 'https://host/ai/run' }]) {
      expect(() => new CloudflareWorkersAiChatProvider({ type: 'operator', apiKey: 'disposable', model, ...config })).toThrow('Invalid Cloudflare Workers AI endpoint.');
    }
    for (const apiKey of [undefined, 'bad\0key', 'bad\nkey', 'bad\u{1f4a5}key']) {
      const invalid = new CloudflareWorkersAiChatProvider({ type: 'operator', baseUrl, apiKey, model });
      expect(invalid.validateConfig()).toBe(false); await expect(invalid.chat([message])).rejects.toThrow('Cloudflare API key is required.');
    }
    const invalid = new CloudflareWorkersAiChatProvider({ type: 'operator', baseUrl, apiKey: 'disposable', model, customHeaders: { 'x-private': 'private\0header' } });
    await expect(invalid.chat([message])).rejects.toThrow('Invalid Cloudflare request headers.'); expect(calls).toEqual([]);
    const full = new CloudflareWorkersAiChatProvider({ type: 'operator', baseUrl: baseUrl + '/v1/chat/completions/', apiKey: 'disposable', model });
    await full.chat([message], { cacheRetention: 'none', sessionId: 'not-an-affinity' });
    expect(calls[0].url).toBe('/proxy%2Fowned/ai/v1/chat/completions');
    for (const name of ['session_id', 'x-client-request-id', 'x-session-affinity', 'cf-aig-authorization']) expect(calls[0].headers[name]).toBeUndefined();
    let endpoint = '';
    vi.stubGlobal('fetch', async (url: unknown) => { endpoint = String(url); return new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
    await new CloudflareWorkersAiChatProvider({ type: 'operator', accountId: 'explicit:account', apiKey: 'disposable', model }).chat([message]);
    expect(endpoint).toBe('https://api.cloudflare.com/client/v4/accounts/explicit%3Aaccount/ai/v1/chat/completions');
  });

  it('keeps real C tools and virtual finite classification separate from native S and image generation', async () => {
    let mode = 'tool';
    const { provider, calls } = await fixture(() => ({ choices: [{ finish_reason: mode === 'tool' ? 'tool_calls' : 'stop', message: mode === 'tool' ? { content: null,
      tool_calls: [{ id: 'read-native', type: 'function', function: { name: 'read', arguments: '{"path":"file"}' } }] }
      : { content: JSON.stringify(mode === 'label' ? { label: 'safe' } : { answers: { approved: { value: true, probabilities: [{ value: true, probability: 0.8 }, { value: false, probability: 0.2 }] } } }) } }] }));
    expect(await provider.chat([message], { tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] })).toMatchObject({
      toolCalls: [{ id: 'read-native', name: 'read', input: { path: 'file' } }], usage: { totalTokens: 12 } });
    expect(calls[0].body).toMatchObject({ tools: [{ function: { name: 'read', strict: false } }] }); expect(calls[0].body).not.toHaveProperty('tool_choice');
    mode = 'label';
    const sdk = new SpecializedModels(provider);
    expect(await sdk.classify({ model: `${model}:classifier`, input: 'Approved', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 } });
    mode = 'questions';
    expect(await sdk.classifyQuestions({ model: `${model}:classifier`, state: {}, questions: { approved: { type: 'boolean', prompt: 'Approved?' } } })).toMatchObject({ answers: { approved: { value: true } }, usage: { totalTokens: 12 } });
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'Draw' })).rejects.toThrow('Image model or options are not supported.');
    expect(calls).toHaveLength(3); expect(calls.every(call => call.url === '/proxy%2Fowned/ai/v1/chat/completions')).toBe(true);
  });

  it('withdraws awaited reasoning, rejects non-text reasoning and conserves genuine partial/invalid usage', async () => {
    const { provider, calls } = await fixture(); const signal = new AbortController(); const complete = vi.fn(), failure = vi.fn();
    await provider.streamChat([message], async (_chunk, event) => { expect(event?.type).toBe('reasoning_delta'); await Promise.resolve(); signal.abort(); }, complete, failure, { signal: signal.signal });
    expect(complete).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce(); expect(failure.mock.calls[0][0].message).toBe('Cloudflare request aborted.');
    expect(calls).toHaveLength(1);
    for (const usage of [{ prompt_tokens: 10 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage })));
      expect((await provider.chat([message])).usage).toBeUndefined();
    }
    for (const field of ['reasoning_content', 'reasoning_summary']) {
      for (const value of [{ private: 'not-native-text' }, [], 1, true]) {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', [field]: value }, finish_reason: 'stop' }] })));
        if (field === 'reasoning_content') await expect(provider.chat([message])).rejects.toThrow('Invalid Cloudflare chat response.');
        else expect(await provider.chat([message])).toMatchObject({ content: 'Ready', blocks: [{ type: 'text', text: 'Ready' }] });
      }
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ready', [field]: 'Thought' }, finish_reason: 'stop' }] })));
      expect((await provider.chat([message])).reasoning).toBe(field === 'reasoning_content' ? 'Thought' : undefined);
    }
  });
});
