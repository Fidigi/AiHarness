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
import type { Message } from '../types/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from './index.js';

const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/openrouter-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const first = '~anthropic/claude-fable-latest', second = 'openrouter/auto';
const message: Message = { id: 'input', role: 'user', content: 'Hello', timestamp: new Date(0) };
const model = '~anthropic/claude-fable-latest';
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  // Filesystem teardown must not consume the request/persistence assertion deadline.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(reply?: ((body: Record<string, unknown>, response: import('node:http').ServerResponse) => void) | { C?: unknown[] }, replies?: Record<string, unknown>) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
    if (typeof reply === 'function') { reply(body, response); return; }
    const usage = { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } };
    if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      for (const value of reply?.C ?? [{ choices: [{ delta: { reasoning: 'Plan' } }] }, { choices: [{ delta: { content: 'Ready' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'read', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage }]) response.write(`data: ${JSON.stringify(value)}\n\n`);
      response.end('data: [DONE]\n\n');
    } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(replies?.C ?? { model: body.model, choices: [{ message: { content: 'Ready', reasoning: 'Plan' }, finish_reason: 'stop' }], usage })); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fprefix/api/v1/chat/completions` };
}

describe('native OpenRouter Chat Completions', () => {
  it.each(completionModels)('compares independently bound whole private OpenRouter C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model), events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse };
    const { calls, baseUrl } = await fixture(events, replies);
    for (const Ctor of [providers.OpenRouterCompletionsProvider, providers.OpenRouterProvider]) for (const facade of ['chat', 'stream']) {
      const provider = new Ctor({ type: 'openrouter', model, apiKey: 'disposable-openrouter-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned OpenRouter C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-openrouter-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const firstResult = await invoke([user]); expect(firstResult).toMatchObject({ provider: 'openrouter', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' }); expect(firstResult.blocks).toEqual(reference.expectedBlocks); expect(firstResult.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: firstResult.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed OpenRouter C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history); events.C = projection.responseEvents; replies.C = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const instructionRole = reference.expectedInitialBody.messages[0].role; const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: instructionRole, content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: instructionRole, content: 'owned OpenRouter C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-openrouter-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-openrouter-c']);
      roots.push(root);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'OpenRouter C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', ...(reference.published.compat.requiresReasoningContentOnAssistantMessages ? { reasoning_content: '' } : {}) }, native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; events.C = reference.cases[0].responseEvents; replies.C = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } })); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'openrouter', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'openrouter', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant'); expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-openrouter-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!; expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-openrouter-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' }); const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const target = getCompactionModelMessages(restarted, clone.id).find(item => item.content === 'edited answer')!; expect(target).toMatchObject({ provider: 'openrouter', api: 'openai-completions', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); } expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-openrouter-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_OPENROUTER_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_OPENROUTER_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600); const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: instructionRole, content: 'owned OpenRouter C reference system\n\n[Context Summary] PUBLIC_OPENROUTER_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); }
    }
    expect(calls).toHaveLength(108); for (const call of calls) { expect(call.url).toBe('/proxy%2Fprefix/api/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-openrouter-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['session_id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); }
  });

  it('pins private C body identity/prices and marker policy, awaits publication and refuses forged grants', async () => {
    for (const Ctor of [providers.OpenRouterCompletionsProvider, providers.OpenRouterProvider]) {
    let reference = completions.rows.find((row: { model: string }) => row.model === first); const events = { C: reference.seedResponseEvents }, replies = { C: reference.syntheticJsonResponse }, { calls, baseUrl } = await fixture(events, replies);
    const user: Message = { ...message, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [first, second]) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
      const provider = new Ctor({ type: 'openrouter', apiKey: 'disposable-openrouter-c', model, baseUrl }); provider.getProviderType = () => 'forged-openrouter-c-provider'; provider.getModelApi = () => 'forged-openrouter-c-api'; let captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned OpenRouter C reference system', sessionId: 'openrouter-c-bound' }, options = { ...base, get model() { return model; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === first ? second : first); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'openrouter', api: 'openai-completions', model, blocks: reference.expectedBlocks }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(captured).not.toHaveProperty(field);
      const rates = providers.OPENROUTER_COMPLETION_MODELS.find(profile => profile.id === model)!.pricing; if (rates) expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12); else expect(captured!.usage?.costUsd).toBeUndefined();
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false)); const other = completions.rows.find((row: { model: string }) => row.model === (model === first ? second : first)); events.C = other.seedResponseEvents; replies.C = other.syntheticJsonResponse;
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) for (const field of ['session_id', 'x-client-request-id', 'x-session-affinity']) expect(call.headers[field]).toBeUndefined();
    for (const facade of ['chat', 'stream']) {
      const logical = facade === 'chat' ? first : second, physical = logical === first ? second : first, selected = completions.rows.find((row: { model: string }) => row.model === physical); let reads = 0, captured: providers.ChatResponse | undefined;
      const options: providers.ChatOptions = { maxTokens: 64, thinking: 'high', cacheRetention: 'none', systemPrompt: 'owned OpenRouter C reference system', tools: completions.tools, get model() { return reads++ === 0 ? logical : physical; } };
      expect(options.model).toBe(logical); events.C = selected.seedResponseEvents; replies.C = selected.syntheticJsonResponse;
      const provider = new Ctor({ type: 'openrouter', model: logical, apiKey: 'disposable-openrouter-c', baseUrl }); provider.getProviderType = () => 'forged-changing-provider'; provider.getModelApi = () => 'forged-changing-api';
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], () => {}, value => { captured = value; }, error => { throw error; }, options);
      expect(reads).toBeGreaterThan(1); expect(calls.at(-1)!.body).toEqual(expected(selected.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'openrouter', api: 'openai-completions', model: physical, blocks: selected.expectedBlocks });
      const rates = providers.OPENROUTER_COMPLETION_MODELS.find(profile => profile.id === physical)!.pricing; if (rates) expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12); else expect(captured!.usage?.costUsd).toBeUndefined();
    }
    expect(calls).toHaveLength(14);
    reference = completions.rows.find((row: { model: string }) => row.model === first); events.C = reference.rawSeed.responseEvents; replies.C = reference.rawSeed.syntheticJsonResponse;
    const alias = await new Ctor({ type: 'operator', apiKey: 'disposable-openrouter-c', model: first, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(alias.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: 'reasoning' }); for (const field of ['normalizeReasoningMarker', 'invalidResponse']) expect(alias).not.toHaveProperty(field);
    events.C = reference.seedResponseEvents; replies.C = reference.syntheticJsonResponse;
    for (const model of [first, second]) { const errors: Error[] = []; await new Ctor({ type: 'openrouter', apiKey: 'disposable-openrouter-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_OPENROUTER_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['OpenRouter chat request failed.']); }
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'openrouter', api: 'openai-completions', model: first, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'openrouter', apiKey: 'disposable-openrouter-c', model: first, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedDirect extends providers.OpenRouterCompletionsProvider {} class DerivedMixed extends providers.OpenRouterProvider {} const DerivedOpenRouter = Ctor === providers.OpenRouterCompletionsProvider ? DerivedDirect : DerivedMixed, derived = new DerivedOpenRouter(config); (derived as unknown as { ownsReplay: boolean }).ownsReplay = true; derived.getProviderType = () => 'openrouter'; await expect(derived.chat([source, user])).rejects.toThrow('Unsupported OpenRouter reasoning replay.');
    events.C = []; replies.C = { choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] }; expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-openrouter-c', model: 'glm-5.3', baseUrl }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-openrouter-c-|reasoning_details/);
    replies.C = { choices: [{ message: { content: 'Ready', reasoning_summary: 'LEGACY_SUMMARY' }, finish_reason: 'stop' }] }; const native = await new Ctor(config).chat([user]); expect(native.reasoning).toBeUndefined(); expect(native.blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect((await new DerivedOpenRouter(config).chat([user])).reasoning).toBe('LEGACY_SUMMARY'); expect(calls).toHaveLength(22);
    }
  });

  it('keeps existing C tool-image attribution once and refuses undeclared images without decoding', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const Ctor of [providers.OpenRouterCompletionsProvider, providers.OpenRouterProvider]) for (const profile of providers.OPENROUTER_COMPLETION_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...message, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'openrouter', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...message, id: 'c-after', content: 'after' }], before = structuredClone(history), provider = new Ctor({ type: 'openrouter', apiKey: 'disposable-openrouter-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history, { cacheRetention: 'none' }) : provider.streamChat(history, () => {}, undefined, error => { throw error; }, { cacheRetention: 'none' });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('OpenRouter chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', ...(profile.compat?.requiresReasoningContentOnAssistantMessages ? { reasoning_content: '' } : {}), tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); } expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(1028); expect(refusals).toBe(480);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === first), events = { C: reference.seedResponseEvents }, { calls, baseUrl } = await fixture(events);
    for (const Ctor of [providers.OpenRouterCompletionsProvider, providers.OpenRouterProvider]) for (const mode of ['eof', 'error', 'abort']) { const frames = structuredClone(reference.seedResponseEvents); frames[0].choices[0].delta.reasoning_details = [frames[4].choices[0].delta.reasoning_details[0]]; events.C = mode === 'eof' ? frames.slice(0, -1) : mode === 'error' ? [...frames.slice(0, -1), { error: { message: 'PRIVATE_OPENROUTER_C_FAILURE' } }] : frames;
      const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = []; await new Ctor({ type: 'openrouter', apiKey: 'disposable-openrouter-c', model: first, baseUrl }).streamChat([message], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-openrouter-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-openrouter-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(6);
  });

  it('owns 377 C projections without inheriting A/I/T or ambiguous zero prices', async () => {
    expect(providers).toHaveProperty('OpenRouterCompletionsProvider');
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator-router', apiKey: 'disposable-router' });
    expect(providers.OPENROUTER_COMPLETION_MODELS).toHaveLength(377);
    expect(Object.isFrozen(providers.OPENROUTER_COMPLETION_MODELS)).toBe(true);
    expect(providers.OPENROUTER_COMPLETION_MODELS.filter(profile => profile.pricing === undefined)).toHaveLength(21);
    expect(await provider.getAvailableModels()).toHaveLength(377); expect(provider.canDiscoverModels()).toBe(false);
    expect(provider.getModelApi()).toBe('openai-completions');
    expect(provider.getSpecializedModels().filter(profile => profile.type === 'image')).toEqual([]);
    expect(provider.getSpecializedModels()[0]).toMatchObject({ api: 'openai-completions', virtual: true });
    expect(JSON.stringify(provider.getSpecializedModels())).not.toContain('disposable-router');
    await expect(provider.chat([], { model: 'anthropic/claude-fable-5' })).rejects.toThrow('OpenRouter chat model is not supported.');
    await expect(provider.generateImages({ model: 'dall-e-3', prompt: 'No fallback' })).rejects.toThrow('Image model or options are not supported.');
    expect(new providers.OpenRouterImagesProvider({ type: 'operator-router', apiKey: 'disposable' }).getModelApi()).toBe('openrouter-images');
  });

  it('uses actual Bearer C requests, nested effort, cache accounting and awaited reasoning/tools independently of operator names', async () => {
    expect(providers).toHaveProperty('OpenRouterCompletionsProvider');
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'azure', apiKey: 'disposable-router', baseUrl, model });
    const messages = [{ id: 'user-1', role: 'user' as const, content: 'Read the file', timestamp: new Date() }];
    const result = await provider.chat(messages, { thinking: 'max', sessionId: 'session-1' });
    expect(result).toMatchObject({ api: 'openai-completions', content: 'Ready', reasoning: 'Plan', usage: {
      promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
    } });
    const events: unknown[] = []; const complete = vi.fn();
    await provider.streamChat(messages, async (text, event) => { await Promise.resolve(); events.push({ text, type: event?.type }); }, complete,
      error => { throw error; }, { thinking: 'max', sessionId: 'session-1' });
    expect(events).toEqual([{ text: '', type: 'reasoning_delta' }, { text: 'Ready', type: 'text_delta' }, { text: '', type: 'tool_call' }]);
    expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject({ api: 'openai-completions', content: 'Ready', reasoning: 'Plan',
      toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'README.md' } }] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('/proxy%2Fprefix/api/v1/chat/completions');
      expect(call.headers.authorization).toBe('Bearer disposable-router'); expect(call.headers['api-key']).toBeUndefined();
      expect(call.body).toMatchObject({ model, reasoning: { effort: 'max' } }); expect(call.body).not.toHaveProperty('reasoning_effort');
    }
    expect(calls[1].body.stream_options).toEqual({ include_usage: true });
    expect(provider.getProviderType()).toBe('azure'); expect(messages[0].content).toBe('Read the file');
    expect(calls.every(call => call.headers['x-session-id'] === 'session-1')).toBe(true);
  });

  it('executes every C identity with independent per-profile arithmetic and owned descriptors', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'local', apiKey: 'disposable-router', baseUrl });
    for (const profile of providers.OPENROUTER_COMPLETION_MODELS) {
      const history = profile.compat?.requiresReasoningContentOnAssistantMessages ? [{ id: 'previous', role: 'assistant' as const,
        content: 'Earlier', blocks: [{ type: 'reasoning' as const, text: 'Owned planning' }], timestamp: new Date() }] : [];
      const result = await provider.chat(history, { model: profile.id });
      if (history.length) expect(calls.at(-1)?.body.messages).toEqual([{ role: 'assistant', content: 'Owned planningEarlier', reasoning_content: '' }]);
      const rates = profile.pricing;
      expect(result.usage?.costUsd).toBe(rates ? (5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1_000_000 : undefined);
      expect(result.api).toBe(profile.api); expect(calls.at(-1)?.body.model).toBe(profile.id);
      expect(Object.isFrozen(profile.declaredInput)).toBe(true); expect(Object.isFrozen(profile.declaredPricing)).toBe(true);
      for (const tier of profile.declaredPricing.tiers ?? []) expect(Object.isFrozen(tier)).toBe(true);
    }
    expect(calls).toHaveLength(377);
    const before = provider.getConfiguredModel(); expect(() => provider.setConfiguredModel('future/unknown')).toThrow('OpenRouter chat model is not supported.');
    expect(provider.getConfiguredModel()).toBe(before);
  });

  it('uses strict tier thresholds and omits invalid or incomplete primary accounting', async () => {
    const profile = providers.OPENROUTER_COMPLETION_MODELS.find(profile => profile.pricing && profile.declaredPricing.tiers?.length === 1)!;
    const tier = profile.declaredPricing.tiers![0]; let input = tier.inputTokensAbove;
    let usage: unknown;
    const { baseUrl } = await fixture((body, response) => response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }],
      usage: usage ?? { prompt_tokens: input, completion_tokens: 2 } })));
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator-router', apiKey: 'disposable', baseUrl, model: profile.id });
    expect((await provider.chat([])).usage?.costUsd).toBe((input * profile.pricing!.inputPerMillion + 2 * profile.pricing!.outputPerMillion) / 1_000_000);
    input += 1;
    expect((await provider.chat([])).usage?.costUsd).toBe((input * tier.inputPerMillion + 2 * tier.outputPerMillion) / 1_000_000);
    for (const invalid of [{ prompt_tokens: 7 }, { completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 },
      { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } },
      { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 } }]) {
      usage = invalid; expect((await provider.chat([])).usage).toBeUndefined();
    }
    for (const alternate of ['prompt_cache_hit_tokens', 'cached_tokens']) {
      usage = { prompt_tokens: 10, completion_tokens: 2, [alternate]: 4 };
      expect((await provider.chat([])).usage).toMatchObject({ promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12 });
    }
  });

  it('refuses private endpoint/header values before I/O and keeps derived replay refusals separate', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const baseUrl of ['https://user:PRIVATE@example.invalid', 'https://example.invalid/v1?PRIVATE=1', 'https://example.invalid/#PRIVATE']) {
      expect(() => new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey: 'disposable', baseUrl })).toThrow('Invalid OpenRouter completions endpoint.');
    }
    for (const apiKey of ['', 'PRIVATE\u0000value', 'PRIVATE😀']) {
      await expect(new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey }).chat([])).rejects.toThrow('OpenRouter API key is required.');
    }
    await expect(new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey: 'disposable', customHeaders: { 'x-private': 'PRIVATE\u0000value' } }).chat([]))
      .rejects.toThrow('Invalid OpenRouter request headers.');
    expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
    for (const message of [{ content: 'PRIVATE', refusal: 'PRIVATE' }, { content: 'PRIVATE', reasoning_details: [{ type: 'reasoning.encrypted', data: 'PRIVATE' }] }]) {
      const { baseUrl } = await fixture((_body, response) => response.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] })));
      const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
      if (message.refusal) await expect(provider.chat([])).rejects.toThrow('Invalid OpenRouter chat response.');
      else {
        expect(await provider.chat([])).toMatchObject({ content: 'PRIVATE' });
        class DerivedOpenRouter extends providers.OpenRouterCompletionsProvider {}
        await expect(new DerivedOpenRouter({ type: 'operator', apiKey: 'disposable', baseUrl }).chat([])).rejects.toThrow('Unsupported OpenRouter reasoning replay.');
      }
    }
  });

  it('withdraws buffered callbacks, tools and completion after awaited cancellation', async () => {
    const { baseUrl } = await fixture(); const controller = new AbortController();
    const provider = new providers.OpenRouterCompletionsProvider({ type: 'operator-router', apiKey: 'disposable', baseUrl });
    const events: string[] = []; const complete = vi.fn(); const error = vi.fn();
    await provider.streamChat([], async (_text, event) => { events.push(event!.type); await Promise.resolve(); controller.abort(); }, complete, error,
      { signal: controller.signal });
    expect(events).toEqual(['reasoning_delta']); expect(complete).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0].message).toBe('OpenRouter request aborted.');
  });
});
