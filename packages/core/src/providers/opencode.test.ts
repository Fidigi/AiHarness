import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { getProviderPublishedModel } from './provider-model-metadata.js';
import { getSupportedThinkingLevels } from './model-metadata.js';
import { captureNativeOutputBudget } from './provider-output-budget.js';
import { SpecializedModels, SpecializedModelError } from './specialized-models.js';
import type { Message } from '../types/index.js';

const continuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/opencode-continuation-reference-ar.json', import.meta.url), 'utf8'));
const continuationModels: string[] = continuation.rows.map((row: { model: string }) => row.model);
const googleContinuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/opencode-continuation-reference-google.json', import.meta.url), 'utf8'));
const googleContinuationModels: string[] = googleContinuation.rows.map((row: { model: string }) => row.model);
const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/opencode-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);
const a = 'claude-haiku-5-5', g = 'gemini-3.1-pro', c = 'glm-5.3', r = 'gpt-6-luna';
const models = [a, g, c, r];
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const usage = { A: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 }, C: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } }, R: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } }, G: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 4, totalTokenCount: 15 }, T: { input_tokens: 10, output_tokens: 2 } };
type Api = keyof typeof usage;
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
function sse(response: ServerResponse, values: unknown[], done = false): void { response.setHeader('content-type', 'text/event-stream'); response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')); }
async function fixture(override?: (api: Api, body: Record<string, any>, response: ServerResponse) => void, text = 'Ready') {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any>; model: string; api: Api }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), url = request.url ?? '', api: Api = url.endsWith('/systemone') ? 'T' : url.includes('/models/') ? 'G' : url.endsWith('/messages') ? 'A' : url.endsWith('/responses') ? 'R' : 'C', model = api === 'G' ? decodeURIComponent(url.match(/\/models\/([^/]+):/)![1]) : body.model; calls.push({ url, headers: request.headers, body, model, api });
    if (override) { override(api, body, response); return; }
    if (api === 'T') { response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, question]) => { const values = Object.keys(question.criteria); return [id, question.type === 'noul' ? { type: 'noul', noul: 0.75 } : question.type === 'score' ? { type: 'score', score: 3.5, confidence: 0.8 } : { type: 'choice', choice: values[0], confidence: 1, probabilities: Object.fromEntries(values.map((value, i) => [value, i === 0 ? 1 : 0])) }]; })), usage: usage.T })); return; }
    if (api === 'G') { const value = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage.G }; if (url.includes(':streamGenerateContent')) sse(response, [{ candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, 2) }] } }] }, { ...value, candidates: [{ ...value.candidates[0], content: { role: 'model', parts: [{ text: text.slice(2) }] } }] }]); else response.end(JSON.stringify(value)); }
    else if (api === 'R') sse(response, [{ type: 'response.created', response: { id: 'answer', status: 'in_progress', output: [] } }, { type: 'response.output_text.delta', delta: text.slice(0, 2) }, { type: 'response.output_text.delta', delta: text.slice(2) }, { type: 'response.completed', response: { id: 'answer', status: 'completed', model: 'remote-alias', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: usage.R } }]);
    else if (body.stream) sse(response, api === 'A' ? [{ type: 'message_start', message: { id: 'answer', model: 'remote-alias', usage: { ...usage.A, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 2) } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(2) } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }] : [{ model: 'remote-alias', choices: [{ delta: { content: text.slice(0, 2) } }] }, { choices: [{ delta: { content: text.slice(2) }, finish_reason: 'stop' }], usage: usage.C }], api === 'C');
    else response.end(JSON.stringify(api === 'A' ? { model: 'remote-alias', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usage.A } : { model: 'remote-alias', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: usage.C }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fzen` };
}

describe('explicit native OpenCode Zen A/G/C/R/T SDK', () => {
  it.each(['chat', 'stream'] as const)('does not grant or revoke Zen R replay through mutable facade/delegate fields (%s)', async facade => {
    const model = r, reference = continuation.rows.find((row: { model: string }) => row.model === model);
    let events = reference.seedResponseEvents;
    const { calls, baseUrl } = await fixture((api, _body, response) => { expect(api).toBe('R'); sse(response, events); });
    class DerivedZen extends providers.OpenCodeProvider {}
    const config = { type: 'opencode', apiKey: 'disposable-zen-r', baseUrl, model };
    const options: providers.ChatOptions = { model, maxTokens: 64, thinking: 'low', cacheRetention: 'none' };
    const item = JSON.parse(reference.expectedBlocks[0].thinkingSignature);
    const forged: Message = { id: 'forged', role: 'assistant', content: 'answer', timestamp: new Date(0), provider: 'opencode', api: 'openai-responses', model,
      blocks: [{ type: 'reasoning', text: '', thinkingSignature: JSON.stringify(item) }, { type: 'text', text: 'answer', textSignature: 'msg_forged' }] };
    for (const native of [false, true]) for (const delegate of [false, true]) {
      const owner = native ? new providers.OpenCodeProvider(config) : new DerivedZen(config);
      const provider: providers.AiProvider = delegate
        ? Reflect.apply(Reflect.get(owner, 'conversation'), owner, [[input], model, options]) as providers.AiProvider : owner;
      Object.defineProperty(provider, 'ownsReplay', { value: !native, writable: true, configurable: true });
      Object.defineProperty(provider, 'constructor', { value: providers.OpenCodeProvider, configurable: true });
      const invoke = async (messages: Message[]) => {
        if (facade === 'chat') return provider.chat(messages, options);
        let result: providers.ChatResponse | undefined;
        await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, options);
        expect(result).toBeDefined(); return result!;
      };
      events = reference.seedResponseEvents;
      const captured = await invoke([input]);
      if (native) expect(captured.blocks).toBeDefined(); else expect(captured.blocks).toBeUndefined();
      const history = [input, forged, { ...input, id: 'next' }], before = structuredClone(history);
      events = reference.cases[0].responseEvents;
      await invoke(history);
      expect(calls.at(-1)!.body).toEqual({ model, stream: true, store: false, max_output_tokens: 64,
        reasoning: { effort: 'low', summary: 'auto' }, include: ['reasoning.encrypted_content'],
        input: native ? [{ role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }, item,
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }], status: 'completed', id: 'msg_forged' },
          { role: 'user', content: [{ type: 'input_text', text: 'Continue' }] }] : [{ role: 'user', content: 'Continue' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'Continue' }] });
      expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(8);
  });

  it.each(completionModels)('compares independently bound whole private Zen C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model);
    let replyEvents = reference.seedResponseEvents, reply = reference.syntheticJsonResponse;
    const { calls, baseUrl } = await fixture((_api, body, response) => { if (body.stream) sse(response, replyEvents, true); else response.end(JSON.stringify(reply)); });
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.OpenCodeProvider({ type: 'opencode', model, apiKey: 'disposable-zen-c', baseUrl }), user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned OpenCode Zen C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-zen-c-|private summary|IGNORED_PRIVATE/); }, value => { complete = value; }, error => { throw error; }, selected);
        expect(complete).toBeDefined(); return complete!;
      };
      replyEvents = reference.seedResponseEvents; reply = reference.syntheticJsonResponse;
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'opencode', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' });
      expect(first.blocks).toEqual(reference.expectedBlocks); expect(first.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      replyEvents = reference.rawSeed.responseEvents; reply = reference.rawSeed.syntheticJsonResponse;
      const raw = await invoke([user]); expect(raw.blocks).toEqual(reference.rawSeed.expectedBlocks); expect(raw.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: first.content, timestamp: new Date(0), ...projection.source, blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Zen C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId, content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
        replyEvents = projection.responseEvents; reply = projection.syntheticJsonResponse; expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned OpenCode Zen C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-zen-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-zen-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Zen C private replay' }), registry = new ExtensionRegistry(), same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', ...(providers.OPENCODE_MODELS.find(profile => profile.id === model)!.requiresReasoningContent ? { reasoning_content: '' } : {}) };
      const native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; replyEvents = reference.cases[0].responseEvents; reply = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } }));
      replyEvents = reference.seedResponseEvents; reply = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'opencode', tools: completions.tools, toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'opencode', model, messages, tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson, createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant');
        expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-zen-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true }); expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-zen-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id)); const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]); const canonicalTarget = getCompactionModelMessages(restarted, clone.id).find(message => message.content === 'edited answer')!;
        expect(canonicalTarget).toMatchObject({ provider: 'opencode', api: 'openai-completions', model }); expect(canonicalTarget.metadata).toBeUndefined(); expect(canonicalTarget.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const entries = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); }
        expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-zen-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_ZEN_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_ZEN_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        const entries = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(entries).toHaveLength(2); expect(entries.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned OpenCode Zen C reference system\n\n[Context Summary] PUBLIC_ZEN_C_PREFIX' }, finalItem] }); expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(52); for (const call of calls) { expect(call.url).toBe('/owned%2Fzen/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-zen-c'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['x-opencode-session']).toBeUndefined(); }
  });

  it('pins private C body identity and prices, keeps independent marker policies and awaits completion', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === c), plain = false, raw = false;
    const { calls, baseUrl } = await fixture((_api, body, response) => {
      const row = completions.rows.find((row: { model: string }) => row.model === body.model) ?? reference;
      if (plain) { response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); return; }
      if (body.stream) sse(response, raw ? row.rawSeed.responseEvents : row.seedResponseEvents, true); else response.end(JSON.stringify(raw ? row.rawSeed.syntheticJsonResponse : row.syntheticJsonResponse));
    });
    const user: Message = { ...input, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [c, 'deepseek-v4-flash']) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model); const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-c', model, baseUrl });
      provider.getProviderType = () => 'forged-zen-c-provider'; provider.getModelApi = () => 'forged-zen-c-api'; let reads = 0, captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned OpenCode Zen C reference system', sessionId: 'zen-c-bound' }, options = { ...base, get model() { return ++reads === 1 ? model : a; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(a); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'opencode', api: 'openai-completions', model, blocks: reference.expectedBlocks }); expect(captured).not.toHaveProperty('normalizeReasoningMarker');
      const rates = providers.OPENCODE_MODELS.find(profile => profile.id === model)!.pricing!; expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls }, { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false));
      const other = completions.rows.find((row: { model: string }) => row.model === (model === c ? 'deepseek-v4-flash' : c)); await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) { expect(call.headers['x-opencode-session']).toBe('zen-c-bound'); expect(call.headers['x-client-request-id']).toBeUndefined(); }
    raw = true;
    for (const [Constructor, marker] of [[providers.OpenCodeProvider, 'reasoning'], [providers.OpenCodeGoProvider, 'reasoning_content']] as const) {
      const result = await new Constructor({ type: 'operator', apiKey: 'disposable-zen-c', model: c, baseUrl }).chat([user], { maxTokens: 64, thinking: 'high' }); expect(result.blocks?.find(block => block.type === 'reasoning')).toMatchObject({ thinkingSignature: marker }); expect(result).not.toHaveProperty('normalizeReasoningMarker');
    }
    raw = false;
    for (const model of [c, 'deepseek-v4-flash']) { const errors: Error[] = []; await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_ZEN_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' }); expect(errors.map(error => error.message)).toEqual(['OpenCode chat request failed.']); }
    reference = completions.rows.find((row: { model: string }) => row.model === c); const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'opencode', api: 'openai-completions', model: c, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls }, config = { type: 'opencode', apiKey: 'disposable-zen-c', model: c, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined(); class DerivedZen extends providers.OpenCodeProvider {} await expect(new DerivedZen(config).chat([source, user])).rejects.toThrow('Unsupported OpenCode reasoning replay.');
    plain = true; expect((await new providers.OpenCodeGoProvider({ ...config, type: 'opencode-go' }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-zen-c-|reasoning_details/); expect(calls).toHaveLength(19);
  });

  it('keeps existing C image attribution once and refuses undeclared images without decoding or preparation', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const profile of providers.OPENCODE_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'opencode', api: 'openai-completions', model: profile.id, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'c-after', content: 'after' }], before = structuredClone(history);
      const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('OpenCode chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }], ...(profile.requiresReasoningContent ? { reasoning_content: '' } : {}) }, { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); } expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(30); expect(refusals).toBe(26);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without opaque callbacks', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === c); let mode = 'eof';
    const { calls, baseUrl } = await fixture((_api, _body, response) => { const events = structuredClone(reference.seedResponseEvents); events[0].choices[0].delta.reasoning_details = [events[4].choices[0].delta.reasoning_details[0]]; sse(response, mode === 'eof' ? events.slice(0, -1) : mode === 'error' ? [...events.slice(0, -1), { error: { message: 'PRIVATE_ZEN_C_FAILURE' } }] : events, true); });
    for (mode of ['eof', 'error', 'abort']) { const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = [];
      await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-c', model: c, baseUrl }).streamChat([input], async (text, event) => { seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); } }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-zen-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-zen-c-|private summary|tool_call/); if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });

  it.each(googleContinuationModels)('compares independently bound whole private Zen Google bodies for %s', async model => {
    const reference = googleContinuation.rows.find((row: { model: string }) => row.model === model);
    let reply = reference.seedResponseFrames;
    const { calls, baseUrl } = await fixture((_api, _body, response) => sse(response, reply));
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.OpenCodeProvider({ type: 'opencode', model, apiKey: 'disposable-zen-google-private', baseUrl });
      const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.coreOptions, model, systemPrompt: 'owned OpenCode Zen Google reference system', tools: googleContinuation.tools };
      const invoke = async (messages: Message[], selected: providers.ChatOptions = options) => { if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, () => {}, value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      reply = reference.seedResponseFrames;
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'opencode', api: reference.api, model, content: 'left!right?', reasoning: 'firstsecond' });
      expect(first.blocks).toEqual(reference.expectedBlocks); expect(first.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(reference.expectedInitialBody);
      for (const projection of reference.cases) {
        const source: Message = { id: 'a', role: 'assistant', content: first.content, timestamp: new Date(0), provider: projection.source.provider, api: projection.source.api, model: projection.source.model, blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls) };
        if (projection.case === 'expurgated' || projection.case === 'malformed-signatures') {
          const expurgated = projection.case === 'expurgated';
          for (const block of source.blocks!) {
            if (block.type === 'text') { if (expurgated) delete block.textSignature; else block.textSignature = 'invalid-signature'; }
            if (block.type === 'reasoning') { if (expurgated) delete block.thinkingSignature; else block.thinkingSignature = 'invalid-signature'; }
            if (block.type === 'tool_call') { if (expurgated) delete block.thoughtSignature; else block.thoughtSignature = 'invalid-signature'; }
          }
          for (const call of source.toolCalls!) { if (expurgated) delete call.thoughtSignature; else call.thoughtSignature = 'invalid-signature'; }
        }
        const failed = projection.case.startsWith('failed-'); if (failed) source.metadata = { outputError: 'Failed Zen Google producer' };
        const results: Message[] = failed ? [] : [{ id: 'r', role: 'tool', name: 'echo', toolCallId: first.toolCalls![0].id, content: projection.case === 'empty-result' ? '' : 'result', isError: projection.case === 'tool-error', timestamp: new Date(0) }];
        const history = [user, source, ...results, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history); reply = projection.responseFrames;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(projection.expectedBody); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, systemInstruction: { parts: [{ text: 'Leading system' }], role: 'user' } });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, systemInstruction: { parts: [{ text: 'owned OpenCode Zen Google reference system\n\nLeading system' }], role: 'user' } }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-zen-google-replay-')), credential: string = googleContinuation.signatures.thinking, redactor = new CredentialRedactor([credential, 'disposable-zen-google-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Zen Google private replay' }), registry = new ExtensionRegistry();
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'model', parts: [{ text: 'ok' }] }, retained = structuredClone(reference.cases[0].expectedBody.contents.slice(0, -1));
      // Credential redaction invalidates this base64 carrier; raw retention is not replay authority.
      expect(retained[1].parts[1].thoughtSignature).toBe(credential); delete retained[1].parts[1].thoughtSignature;
      let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; reply = reference.cases[0].responseFrames; return { content: 'result' }; } }));
      reply = reference.seedResponseFrames;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'opencode', tools: googleContinuation.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'opencode', model, messages,
            tools: googleContinuation.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: options.maxTokens, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, contents: retained });
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant');
        expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-zen-google-private'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toMatch(/Signature/); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).toContain(googleContinuation.signatures.tool); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, contents: [...retained, finalItem] }); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, contents: [retained[0], { role: 'model', parts: [retained[1].parts[3], { text: 'edited answer' }] }, retained[2], finalItem] });
        const raw = (await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(raw).toHaveLength(history.length); expect(raw.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        expect((await restarted.getActiveBranchEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(item => item.blocks)); expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|b3BhcXVl/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_ZEN_GOOGLE_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_ZEN_GOOGLE_COMPACTED_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        const retainedRaw = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(retainedRaw).toHaveLength(history.length); expect(retainedRaw.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        expect((await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, systemInstruction: { parts: [{ text: 'owned OpenCode Zen Google reference system\n\n[Context Summary] PUBLIC_ZEN_GOOGLE_COMPACTED_PREFIX' }], role: 'user' }, contents: [finalItem] });
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(38);
    for (const call of calls) { expect(call.url).toBe('/owned%2Fzen/v1/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse'); expect(call.headers['x-goog-api-key']).toBe('disposable-zen-google-private'); expect(call.headers.authorization).toBeUndefined(); expect(call.headers['x-opencode-session']).toBeUndefined(); }
  });

  it('pins private Google body identity and prices, awaits publication and refuses generic or derived grants', async () => {
    const reference = googleContinuation.rows[0], foreignReference = googleContinuation.rows[1], model: string = reference.model;
    let reply = reference.seedResponseFrames;
    const { calls, baseUrl } = await fixture((api, _body, response) => {
      if (api === 'C') { response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); return; }
      if (response.req.url?.includes(':generateContent')) response.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: reply.flatMap((frame: Record<string, any>) => frame.candidates[0].content.parts) }, finishReason: 'STOP' }] }));
      else sse(response, reply);
    });
    const user: Message = { ...input, content: 'probe' }, base = { ...reference.coreOptions, systemPrompt: 'owned OpenCode Zen Google reference system', sessionId: 'zen-google-bound', tools: googleContinuation.tools };
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-google-private', model, baseUrl }); provider.getProviderType = () => 'forged-zen-google-provider'; provider.getModelApi = () => 'forged-zen-google-api';
      let reads = 0, captured: providers.ChatResponse | undefined; const options = { ...base, get model() { return ++reads === 1 ? model : c; } }; reply = reference.seedResponseFrames;
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(c); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(reference.expectedInitialBody); expect(captured).toMatchObject({ provider: 'opencode', api: reference.api, model, blocks: reference.expectedBlocks });
      const rates = providers.OPENCODE_MODELS.find(profile => profile.id === model)!.pricing!; expect(captured!.usage?.costUsd).toBeCloseTo((6 * rates.inputPerMillion + 5 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'getter-a', role: 'assistant', content: captured!.content, provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls, timestamp: new Date(0) },
        { id: 'getter-r', role: 'tool', name: 'echo', toolCallId: 'call/zen', content: 'result', timestamp: new Date(0) }, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history);
      reply = reference.cases[0].responseFrames; await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(reference.cases[0].expectedBody);
      await provider.chat(history, { ...base, model: foreignReference.model }); expect(calls.at(-1)!.body).toEqual(foreignReference.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(6); for (const call of calls) { expect(call.headers['x-opencode-session']).toBe('zen-google-bound'); expect(call.headers['x-client-request-id']).toBeUndefined(); }
    const errors: Error[] = []; reply = reference.seedResponseFrames;
    await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-google-private', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_ZEN_GOOGLE_COMPLETION_FAILURE'); }, error => { errors.push(error); }, reference.coreOptions);
    expect(errors.map(error => error.message)).toEqual(['OpenCode chat request failed.']);
    class DerivedZen extends providers.OpenCodeProvider {}
    const source: Message = { ...user, role: 'assistant', provider: 'opencode', api: reference.api, model, content: 'left!right?', blocks: structuredClone(reference.expectedBlocks), toolCalls: structuredClone(reference.expectedToolCalls) }, before = structuredClone(source), config = { type: 'opencode', model, apiKey: 'disposable-zen-google-private', baseUrl };
    for (const facade of ['chat', 'stream']) {
      const generic = new providers.GeminiProvider(config); let result: providers.ChatResponse | undefined;
      if (facade === 'chat') result = await generic.chat([source, user], reference.coreOptions); else await generic.streamChat([source, user], () => {}, value => { result = value; }, error => { throw error; }, reference.coreOptions);
      expect(result?.blocks).toBeUndefined();
      const derived = new DerivedZen(config); if (facade === 'chat') await expect(derived.chat([source, user], reference.coreOptions)).rejects.toThrow('Unsupported OpenCode reasoning replay.'); else await expect(derived.streamChat([source, user], () => {}, undefined, undefined, reference.coreOptions)).rejects.toThrow('Unsupported OpenCode reasoning replay.');
      for (const call of calls.slice(-2)) for (const opaque of Object.values(googleContinuation.signatures)) expect(JSON.stringify(call.body)).not.toContain(opaque);
    }
    expect((await new providers.OpenCodeProvider({ ...config, model: c }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); for (const opaque of Object.values(googleContinuation.signatures)) expect(JSON.stringify(calls.at(-1)!.body)).not.toContain(opaque); expect(source).toEqual(before); expect(calls).toHaveLength(12);
  });

  it('keeps existing Google tool-image attribution once without granting native decoding or preparation', async () => {
    const { calls, baseUrl } = await fixture();
    for (const row of googleContinuation.rows) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { id: 'image-a', role: 'assistant', content: 'called', provider: 'opencode', api: row.api, model: row.model, timestamp: new Date(0), toolCalls: [{ id: 'image-call', name: 'read', input: {} }] },
        { id: 'image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'after', content: 'after' }], before = structuredClone(history);
      const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable', model: row.model, baseUrl });
      if (facade === 'chat') await provider.chat(history, row.coreOptions); else await provider.streamChat(history, () => {}, undefined, error => { throw error; }, row.coreOptions);
      expect(calls.at(-1)!.body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'before' }] }, { role: 'model', parts: [{ text: 'called' }, { functionCall: { id: 'image-call', name: 'read', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'result' }, id: 'image-call' } }] }, { role: 'user', parts: [{ text: 'Tool images for image-call' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }, { role: 'user', parts: [{ text: 'after' }] }],
        generationConfig: { maxOutputTokens: 64, thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } } }); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(14);
  });

  it('withdraws private Google output on EOF,error or awaited abort before pending tools and completion', async () => {
    const reference = googleContinuation.rows[0]; let mode = 'eof';
    const { calls, baseUrl } = await fixture((_api, _body, response) => sse(response, mode === 'abort' ? reference.seedResponseFrames : [...reference.seedResponseFrames.slice(0, -1), ...(mode === 'error' ? [{ error: { message: 'PRIVATE_ZEN_GOOGLE_TRANSPORT_FAILURE' } }] : [])]));
    for (mode of ['eof', 'error', 'abort']) {
      const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable', model: reference.model, baseUrl }), abort = new AbortController(), complete = vi.fn(), seen: unknown[] = [];
      await expect(provider.streamChat([input], async (text, event) => { seen.push({ text, event }); if (mode === 'abort' && text) { await Promise.resolve(); abort.abort(); } }, complete, undefined, { ...reference.coreOptions, signal: abort.signal })).rejects.toThrow(/OpenCode/);
      expect(complete).not.toHaveBeenCalled(); expect(JSON.stringify(seen)).not.toContain('tool_call'); for (const opaque of Object.values(googleContinuation.signatures)) expect(JSON.stringify(seen)).not.toContain(opaque);
    }
    expect(calls).toHaveLength(3);
  });

  it.each(continuationModels)('compares independently bound whole private Zen A/R bodies for %s', async model => {
    const reference = continuation.rows.find((row: { model: string }) => row.model === model), isA = reference.kind === 'A';
    let replyEvents = reference.seedResponseEvents, reply = reference.syntheticJsonResponse;
    const { calls, baseUrl } = await fixture((api, body, response) => {
      if (api === 'A' && !body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply)); } else sse(response, replyEvents, api === 'R');
    });
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.OpenCodeProvider({ type: 'opencode', model, apiKey: 'disposable-zen-private', baseUrl });
      const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.coreOptions, model, systemPrompt: 'owned OpenCode Zen reference system', tools: continuation.tools };
      const expected = (body: Record<string, unknown>) => ({ ...structuredClone(body), stream: isA ? facade === 'stream' : true });
      const invoke = async (messages: Message[], selected: providers.ChatOptions = options) => { if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text).not.toContain('PRIVATE_ZEN_HEADER'); expect(JSON.stringify(event ?? {})).not.toContain('PRIVATE_ZEN_HEADER'); },
          value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      replyEvents = reference.seedResponseEvents.map((event: Record<string, any>) => isA && event.type === 'message_start' ? { ...event, message: { ...event.message, content: [{ type: 'text', text: 'PRIVATE_ZEN_HEADER' }] } } : event); reply = reference.syntheticJsonResponse;
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'opencode', api: reference.api, model, content: isA ? 'left!right?' : 'leftright' });
      expect(first.blocks).toEqual(reference.expectedBlocks); expect(first.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'a', role: 'assistant', content: first.content, timestamp: new Date(0), provider: projection.source.provider, api: projection.source.api, model: projection.source.model, blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls) };
        if (isA) { const thought = source.blocks!.find(block => block.type === 'reasoning' && !block.redacted)!; if (thought.type !== 'reasoning') throw new Error('Missing reference thought');
          if (projection.case === 'unsigned') delete thought.thinkingSignature; if (projection.case === 'empty-thinking') thought.text = ''; if (projection.case === 'blank-thinking') thought.text = ' \t'; if (projection.case === 'empty-signature') thought.thinkingSignature = ''; if (projection.case === 'blank-signature') thought.thinkingSignature = ' \t';
        } else if (projection.case === 'expurgated') for (const block of source.blocks!) { if (block.type === 'text') delete block.textSignature; if (block.type === 'reasoning') delete block.thinkingSignature; }
        const failed = projection.case.startsWith('failed-') || projection.case === 'failed'; if (failed) source.metadata = { outputError: 'Failed OpenCode Zen producer' };
        const results: Message[] = failed ? [] : [{ id: 'r', role: 'tool', name: 'echo', toolCallId: first.toolCalls![0].id, content: 'result', timestamp: new Date(0) }];
        const history = [user, source, ...results, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history); replyEvents = projection.responseEvents; reply = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined });
      expect(calls.at(-1)!.body).toEqual(isA ? { ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'Leading system' }] }
        : { ...expected(reference.expectedInitialBody), input: [{ role: 'developer', content: 'Leading system' }, ...reference.expectedInitialBody.input.slice(1)] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual(isA ? { ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'owned OpenCode Zen reference system\n\nLeading system' }] }
        : { ...expected(reference.expectedInitialBody), input: [reference.expectedInitialBody.input[0], { role: 'developer', content: 'Leading system' }, ...reference.expectedInitialBody.input.slice(1)] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-zen-replay-')), credential = isA ? 'opaque-zen-signature' : 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-zen-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'OpenCode Zen private replay' }), registry = new ExtensionRegistry();
      const finalBlocks = isA ? [{ type: 'text', text: 'ok' }] : [{ type: 'text', text: 'ok', textSignature: '{"v":1,"id":"msg_ok","phase":"final_answer"}' }];
      const finalItem = isA ? { role: 'assistant', content: finalBlocks } : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }], status: 'completed', id: 'msg_ok', phase: 'final_answer' };
      const field = isA ? 'messages' : 'input', same = reference.cases[0].expectedBody[field], native = () => calls.at(-1)!.body[field]; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; replyEvents = reference.cases[0].responseEvents; reply = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } }));
      replyEvents = reference.seedResponseEvents; reply = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'opencode', tools: continuation.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'opencode', model, messages,
            tools: continuation.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: options.maxTokens, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant');
        expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-zen-private'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-zen-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        expect(native()).toEqual(isA ? [same[0], { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }, { type: 'text', text: 'edited answer' }] }, same.at(-2), finalItem]
          : [...same.slice(0, 2), { type: 'function_call', call_id: 'call_native', id: 'fc_native', name: 'echo', arguments: '{"x":1}' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'edited answer', annotations: [] }], status: 'completed', id: 'msg_pi_1' }, same.at(-2), finalItem]);
        expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(item => item.blocks)); expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-zen-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_ZEN_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_ZEN_COMPACTED_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        const retained = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant');
        expect(retained).toHaveLength(history.length); expect(retained.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        expect((await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual(isA ? { ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'owned OpenCode Zen reference system\n\n[Context Summary] PUBLIC_ZEN_COMPACTED_PREFIX' }], messages: [finalItem] }
          : { ...expected(reference.expectedInitialBody), input: [same[0], { role: 'developer', content: '[Context Summary] PUBLIC_ZEN_COMPACTED_PREFIX' }, finalItem] });
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(isA ? 40 : 30);
    for (const call of calls) { expect(call.url).toBe('/owned%2Fzen/v1/' + (isA ? 'messages' : 'responses')); expect(call.headers[isA ? 'x-api-key' : 'authorization']).toBe(isA ? 'disposable-zen-private' : 'Bearer disposable-zen-private'); expect(call.headers[isA ? 'authorization' : 'x-api-key']).toBeUndefined(); expect(call.headers['anthropic-beta']).toBe(reference.sdkBeta ?? undefined); }
  });

  it('pins private A/R body identity and prices, awaits publication and refuses forged or derived admission', async () => {
    let reference = continuation.rows[0];
    const { calls, baseUrl } = await fixture((api, body, response) => { if (api === 'C') { response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); return; }
      if (api === 'A' && !body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reference.syntheticJsonResponse)); } else sse(response, reference.seedResponseEvents, api === 'R'); });
    const user: Message = { ...input, content: 'probe' };
    for (const model of [a, r]) for (const facade of ['chat', 'stream']) {
      reference = continuation.rows.find((row: { model: string }) => row.model === model); const isA = reference.kind === 'A', selectedReference = reference;
      const foreignReference = continuation.rows.find((row: { model: string; kind: string }) => row.kind === reference.kind && row.model !== model);
      const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-private', baseUrl, model });
      provider.getProviderType = () => 'forged-public-provider'; provider.getModelApi = () => 'forged-public-api'; let reads = 0, captured: providers.ChatResponse | undefined;
      const base = { ...reference.coreOptions, systemPrompt: 'owned OpenCode Zen reference system', sessionId: 'zen-bound', tools: continuation.tools };
      const options = { ...base, get model() { return ++reads === 1 ? model : isA ? r : a; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], () => {}, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, stream: isA ? facade === 'stream' : true }); expect(captured).toMatchObject({ provider: 'opencode', api: reference.api, model, blocks: reference.expectedBlocks });
      const rates = providers.OPENCODE_MODELS.find(profile => profile.id === model)!.pricing!;
      expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + (isA ? 3 : 1) * rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls },
        { id: 'getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual({ ...reference.cases[0].expectedBody, stream: !isA });
      reference = foreignReference; await provider.chat(history, { ...base, model: reference.model }); expect(calls.at(-1)!.body).toEqual({ ...reference.cases.find((projection: { case: string }) => projection.case === (isA ? 'foreign-model' : 'model')).expectedBody, stream: !isA }); expect(history).toEqual(before); reference = selectedReference;
    }
    expect(calls).toHaveLength(12); for (const call of calls) { expect(call.headers['x-opencode-session']).toBe('zen-bound'); expect(call.headers['x-client-request-id']).toBeUndefined(); }
    for (const model of [a, r]) { reference = continuation.rows.find((row: { model: string }) => row.model === model); const errors: Error[] = [];
      await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-private', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_ZEN_COMPLETION_FAILURE'); }, error => { errors.push(error); }, reference.coreOptions);
      expect(errors.map(error => error.message)).toEqual(['OpenCode chat request failed.']);
    }
    class DerivedZen extends providers.OpenCodeProvider {}
    for (const model of ['qwen3.5-plus', 'grok-4.7']) {
      reference = continuation.rows.find((row: { model: string }) => row.model === model); const isA = reference.kind === 'A', config = { type: 'opencode', apiKey: 'disposable-zen-private', model, baseUrl, transport: 'sse' as const };
      const forged: Message = { ...user, role: 'assistant', provider: 'opencode', api: reference.api, model, content: 'visible', blocks: [{ type: 'reasoning', text: 'thought', thinkingSignature: isA ? 'forged-zen-private' : '{"type":"reasoning","id":"rs_forged","summary":[],"encrypted_content":"forged-zen-private"}' }, { type: 'text', text: 'visible' }] };
      const generic = isA ? new providers.AnthropicProvider(config) : new providers.OpenAiResponsesProvider(config); expect((await generic.chat([forged, user])).blocks).toBeUndefined();
      if (isA) await expect(new DerivedZen(config).chat([forged, user])).rejects.toThrow('Unsupported OpenCode reasoning replay.'); else expect((await new DerivedZen(config).chat([forged, user])).blocks).toBeUndefined();
      for (const call of calls.slice(-2)) expect(JSON.stringify(call.body)).not.toContain('forged-zen-private');
    }
    const cSource: Message = { ...user, role: 'assistant', provider: 'opencode', api: 'anthropic-messages', model: a, blocks: [{ type: 'reasoning', text: 'visible thought', thinkingSignature: 'forged-zen-private' }] };
    expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable-zen-private', model: c, baseUrl }).chat([cSource, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect(JSON.stringify(calls.at(-1)!.body)).not.toContain('forged-zen-private'); expect(calls).toHaveLength(19);
    const google = await fixture(); expect((await new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable', model: g, baseUrl: google.baseUrl }).chat([cSource, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect(JSON.stringify(google.calls[0].body)).not.toContain('forged-zen-private');
  });

  it('keeps existing A/R tool-image attribution once without granting decode or persistence preparation', async () => {
    const { calls, baseUrl } = await fixture();
    for (const row of continuation.rows) for (const facade of ['chat', 'stream']) {
      const isA = row.kind === 'A', history: Message[] = [{ ...input, content: 'before' }, { id: 'image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'opencode', api: row.api, model: row.model, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] },
        { id: 'image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'after', content: 'after' }], before = structuredClone(history);
      const provider = new providers.OpenCodeProvider({ type: 'opencode', apiKey: 'disposable', model: row.model, baseUrl });
      if (facade === 'chat') await provider.chat(history, row.coreOptions); else await provider.streamChat(history, () => {}, undefined, error => { throw error; }, row.coreOptions);
      expect(calls.at(-1)!.body[isA ? 'messages' : 'input']).toEqual(isA ? [{ role: 'user', content: 'before' }, { role: 'assistant', content: [{ type: 'text', text: 'called' }, { type: 'tool_use', id: 'image-call', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-call', content: 'result', is_error: false }] }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }, { role: 'user', content: 'after' }]
        : [{ role: 'user', content: [{ type: 'input_text', text: 'before' }] }, { role: 'assistant', content: 'called' }, { type: 'function_call', call_id: 'image-call', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'image-call', output: 'result' }, { role: 'user', content: [{ type: 'input_text', text: 'Tool images for image-call' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] }, { role: 'user', content: [{ type: 'input_text', text: 'after' }] }]); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(96);
  });

  it('does not grant Zen policy to generic adapters or the separate Go SDK', async () => {
    const { calls, baseUrl } = await fixture(); await new providers.OpenAiProvider({ type: 'opencode', apiKey: 'disposable', model: c, baseUrl: baseUrl + '/v1' }).chat([input], { sessionId: 'generic' }); expect(calls[0].headers['x-opencode-session']).toBeUndefined(); expect(getProviderPublishedModel('opencode', g, new providers.OpenCodeGoProvider({ type: 'opencode' }))).toBeUndefined();
  });

  it('publishes83 frozen chat profiles and two native classifier declarations without borrowing alias metadata or zero-only prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl }), profiles = providers.OPENCODE_MODELS;
    expect(profiles).toHaveLength(83); expect(new Set(profiles.map(p => p.id)).size).toBe(83); expect(profiles.filter(p => p.pricing)).toHaveLength(72); expect(profiles.filter(p => p.api === 'anthropic-messages')).toHaveLength(18); expect(profiles.filter(p => p.api === 'google-generative-ai')).toHaveLength(7); expect(profiles.filter(p => p.api === 'openai-completions')).toHaveLength(28); expect(profiles.filter(p => p.api === 'openai-responses')).toHaveLength(30);
    expect(Object.isFrozen(profiles)).toBe(true); for (const p of profiles) expect(Object.isFrozen(p) && Object.isFrozen(p.declaredInput) && Object.isFrozen(p.declaredPricing) && Object.isFrozen(p.thinkingLevelMap)).toBe(true);
    expect(providers.OPENCODE_CLASSIFIER_MODELS).toHaveLength(2); expect(Object.isFrozen(providers.OPENCODE_CLASSIFIER_MODELS)).toBe(true); expect(await provider.getAvailableModels()).toEqual(profiles.map(p => p.id)); expect(provider.canDiscoverModels()).toBe(false); expect(providers.ProviderFactory.has('opencode')).toBe(false);
    const row = getProviderPublishedModel('anthropic', g, provider)!; expect(row).toMatchObject({ contextWindow: 1048576, maxOutputTokens: 65536, pricing: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.2 } }); row.contextWindow = 1; row.pricing!.inputPerMillion = 999; row.thinkingLevelMap!.high = 'foreign'; expect(getProviderPublishedModel('anthropic', g, provider)?.pricing?.inputPerMillion).toBe(2); expect(getProviderPublishedModel('anthropic', g, provider)?.thinkingLevelMap?.high).toBe('high'); expect(getProviderPublishedModel('anthropic', 'space-bunny-free', provider)?.pricing).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', g, undefined, provider)).toEqual(['low', 'medium', 'high']); expect(provider.getModelApi('jev-1.13')).toBe('typesafe-system-one'); expect(provider.getModelApi('future')).toBeUndefined(); expect(calls).toEqual([]);
  });

  it('routes every physical chat through native auth/API and preserves captured known-or-unknown disjoint prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator-zen', apiKey: 'disposable', baseUrl });
    for (const p of providers.OPENCODE_MODELS) { const options = { model: p.id, thinking: 'high' as const, sessionId: 'zen-session', systemPrompt: 'System', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } }] }, done = vi.fn(), answer = await provider.chat([input], options); await provider.streamChat([input], () => {}, done, error => { throw error; }, options); const google = p.api === 'google-generative-ai', prompt = google ? 6 : 5, completion = google ? 5 : 2, write = google ? 0 : 1, cost = p.pricing ? (prompt * p.pricing.inputPerMillion + completion * p.pricing.outputPerMillion + 4 * p.pricing.cacheReadPerMillion + write * p.pricing.cacheWritePerMillion) / 1e6 : undefined;
      for (const result of [answer, done.mock.calls[0][0]]) { expect(result).toMatchObject({ provider: 'operator-zen', model: p.id, api: p.api, content: 'Ready', usage: { promptTokens: prompt, completionTokens: completion, cacheReadTokens: 4, totalTokens: google ? 15 : 12 } }); expect(result.usage.costUsd).toBe(cost); }
      for (const call of calls.slice(-2)) { expect(call.model).toBe(p.id); expect(call.headers['x-opencode-session']).toBe('zen-session'); expect(call.headers['session-id']).toBeUndefined(); if (google) { expect(call.url).toBe('/owned%2Fzen/v1/models/' + encodeURIComponent(p.id) + ':streamGenerateContent?alt=sse'); expect(call.headers['x-goog-api-key']).toBe('disposable'); expect(call.headers.authorization).toBeUndefined(); expect(call.body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' }); expect(call.body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(options.tools[0].parameters); expect(call.body).not.toHaveProperty('toolConfig'); } else if (p.api === 'anthropic-messages') { expect(call.headers['x-api-key']).toBe('disposable'); expect(call.body.max_tokens).toBe(p.maxOutputTokens); expect(call.body.tools[0].eager_input_streaming).toBe(true); expect(call.body.tools[0]).not.toHaveProperty('strict'); } else { expect(call.headers.authorization).toBe('Bearer disposable'); expect(call.body).not.toHaveProperty('max_completion_tokens'); if (p.api === 'openai-completions') { expect(call.body).not.toHaveProperty('store'); expect(call.body.tools[0].function.strict).toBe(false); } else { expect(call.body.store).toBe(false); expect(call.body.tools[0]).not.toHaveProperty('strict'); expect(call.body.input[0].role).toBe('developer'); expect(call.body).not.toHaveProperty('instructions'); } } }
    } expect(calls).toHaveLength(166);
  });

  it('owns per-model A temperature/numeric budgets,C cache/effort exceptions,R effort omission and mandatory Google levels', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of [a, 'claude-opus-4-7', 'claude-sonnet-5-5']) { await provider.chat([input], { model, thinking: 'off', temperature: 0.5 }); expect(calls.at(-1)!.body).not.toHaveProperty('temperature'); }
    await provider.chat([input], { model: 'qwen3.8-flash', thinking: 'low', maxTokens: 5120, thinkingBudgets: { low: 4096 } }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 5120, thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' } });
    for (const model of ['deepseek-v4-flash', 'kimi-k2.6', c]) { await provider.chat([input], { model, thinking: 'high', sessionId: 'session', cacheRetention: 'long' }); expect(calls.at(-1)!.body.prompt_cache_key).toBe(model === c ? 'session' : undefined); expect(calls.at(-1)!.body.prompt_cache_retention).toBe(model === c ? '24h' : undefined); if (model === 'kimi-k2.6') { expect(calls.at(-1)!.body.thinking).toEqual({ type: 'enabled' }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning_effort'); } }
    await provider.chat([input], { model: 'grok-build-0.1', thinking: 'high' }); expect(calls.at(-1)!.body).not.toHaveProperty('reasoning');
    for (const [model, level] of [[g, 'LOW'], ['gemini-3-flash', 'MINIMAL']]) { await provider.chat([input], { model, thinking: 'off', maxTokens: 1 }); expect(calls.at(-1)!.body.generationConfig).toMatchObject({ maxOutputTokens: 1, thinkingConfig: { includeThoughts: true, thinkingLevel: level } }); }
  });

  it('keeps wrapper session affinity independent of retention,explicit case-insensitive overrides and Google key out of URLs', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of models) for (const cacheRetention of ['none', 'short', 'long'] as const) { await provider.chat([input], { model, sessionId: 'zen-session', cacheRetention }); expect(calls.at(-1)!.headers['x-opencode-session']).toBe('zen-session'); expect(calls.at(-1)!.headers['x-client-request-id']).toBe(model === r && cacheRetention !== 'none' ? 'zen-session' : undefined); if (model === g) expect(calls.at(-1)!.url).not.toContain('key='); }
    const overridden = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'X-OpenCode-Session': 'operator-owned', 'X-Goog-Api-Key': 'operator-key', 'x-client-request-id': 'operator-request' } }); await overridden.chat([input], { model: g, sessionId: 'automatic' }); expect(calls.at(-1)!.headers['x-goog-api-key']).toBe('operator-key'); expect(calls.at(-1)!.headers['x-opencode-session']).toBe('operator-owned'); const unicode = '字🙂'.repeat(40); await overridden.chat([input], { model: r, sessionId: unicode, cacheRetention: 'long' }); expect(calls.at(-1)!.body.prompt_cache_key).toBe(Array.from(unicode).slice(0, 64).join('')); expect(calls.at(-1)!.headers['x-client-request-id']).toBe('operator-request');
  });

  it.each(models.flatMap(model => (['chat', 'stream'] as const).map(operation => ({ model, operation }))))('captures empty-override physical provenance before awaited mutation ($model/$operation)', async ({ model, operation }) => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model }); let result: providers.ChatResponse | undefined;
    if (operation === 'chat') result = await provider.chat([input], { model: '' }); else await provider.streamChat([input], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === a ? g : a); } }, answer => { result = answer; }, undefined, { model: '' }); expect(calls[0].model).toBe(model); expect(result).toMatchObject({ model, provider: 'operator', api: model === a ? 'anthropic-messages' : model === g ? 'google-generative-ai' : model === c ? 'openai-completions' : 'openai-responses' });
  });

  it('retains native output caps and omission without inventing a Google/Responses default cap', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of models) { await provider.chat([input], { model, maxTokens: 1 }); const body = calls.at(-1)!.body; expect(model === g ? body.generationConfig.maxOutputTokens : body[model === r ? 'max_output_tokens' : 'max_tokens']).toBe(model === r ? 16 : 1); }
    provider.setConfiguredModel(g); const captured = captureNativeOutputBudget(provider)!; provider.setConfiguredModel(a); const prepared = captured({}); expect(prepared.maxTokens).toBe(65536); expect(prepared.options).not.toHaveProperty('maxTokens'); expect(captureNativeOutputBudget(provider)!({}).maxTokens).toBe(128000); const count = calls.length; for (const maxTokens of [0, -1, 0.5, 65537, Number.NaN]) await expect(provider.chat([input], { model: g, maxTokens })).rejects.toThrow('Invalid OpenCode output limit.'); expect(calls).toHaveLength(count);
  });

  it('exposes owned native T descriptors and scalar/bool results separately from finite distributions and unknown free pricing', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), sdk = new SpecializedModels(provider), native = sdk.getModelsOfType('classifier').filter(p => p.api === 'typesafe-system-one'); expect(native.map(p => p.id)).toEqual(['jev-1.13', 'jev-1.13-free']); expect(native[0]).toMatchObject({ contextWindow: 32000, pricing: { inputPerMillion: 0.042, outputPerMillion: 0 } }); expect(native[1].pricing).toBeUndefined();
    for (const model of ['jev-1.13', 'jev-1.13-free']) { const result = await provider.classifyNativeQuestions({ model, state: { input: 'Continue' }, questions: { approved: { type: 'bool', instructions: 'Approved?', criteria: { true: 'Approved', false: 'Not approved' } }, level: { type: 'score', instructions: 'Level', criteria: ['Low', 'High'] } } }); expect(result).toMatchObject({ api: 'typesafe-system-one', provider: 'operator', model, stopReason: 'stop', answers: { approved: { type: 'bool', probability: 0.75 }, level: { type: 'score', score: 3.5, confidence: 0.8 } }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }); expect(result.usage?.costUsd).toBe(model === 'jev-1.13' ? 10 * 0.042 / 1e6 : undefined); expect(calls.at(-1)!.headers['x-opencode-session']).toBeUndefined(); expect(calls.at(-1)!.url).toBe('/owned%2Fzen/v1/systemone'); expect((await sdk.classify({ model, input: 'Continue', labels: ['safe', 'review'] })).label).toBe('safe'); }
    const count = calls.length; await expect(sdk.classify({ model: 'foreign-classifier', input: 'Continue', labels: ['safe', 'review'] })).rejects.toThrow(); expect(calls).toHaveLength(count); expect(sdk.getModelsOfType('image')).toEqual([]);
  });

  it('preserves genuine native T usage on malformed finite answers without fabricating a scalar distribution', async () => {
    const { baseUrl } = await fixture((_api, _body, response) => response.end(JSON.stringify({ answers: { level: { type: 'score', score: 3.5, confidence: 0.8 } }, usage: usage.T }))), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    try { await provider.classifyQuestions({ model: 'jev-1.13', state: {}, questions: { level: { type: 'score', prompt: 'Level', values: [0, 2, 4] } } }); expect.fail('A scalar answer is not a finite distribution.'); } catch (error) { expect(error).toBeInstanceOf(SpecializedModelError); expect((error as SpecializedModelError).usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 10 * 0.042 / 1e6 }); }
  });

  it('separates native Google signatures and independently bound Zen C reasoning markers', async () => {
    let opaque = false;
    const { baseUrl } = await fixture((api, _body, response) => api === 'G' ? sse(response, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Plan', thought: true, ...(opaque ? { thoughtSignature: 'opaque-native-signature' } : {}) }, { text: 'Ready' }] }, finishReason: 'STOP' }], usageMetadata: usage.G }]) : response.end(JSON.stringify({ choices: [{ message: { content: 'Ready', reasoning: 'Foreign field signature' }, finish_reason: 'stop' }], usage: usage.C }))), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), events: string[] = []; let result: providers.ChatResponse | undefined;
    await provider.streamChat([input], (_text, event) => { if (event) events.push(event.type); }, answer => { result = answer; }, undefined, { model: g }); expect(result).toMatchObject({ content: 'Ready', reasoning: 'Plan', usage: { completionTokens: 5 } }); expect(events).toContain('reasoning_delta'); opaque = true; expect((await provider.chat([input], { model: g })).blocks).toEqual([{ type: 'reasoning', text: 'Plan', thinkingSignature: 'opaque-native-signature' }, { type: 'text', text: 'Ready' }]); expect((await provider.chat([input], { model: c })).blocks).toEqual([{ type: 'text', text: 'Ready' }, { type: 'reasoning', text: 'Foreign field signature', thinkingSignature: 'reasoning' }]); expect((await new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl }).chat([input], { model: c })).blocks).toEqual([{ type: 'text', text: 'Ready' }, { type: 'reasoning', text: 'Foreign field signature', thinkingSignature: 'reasoning_content' }]);
  });

  it('prices Google inclusive-cache/thought usage at strict gross-input tiers without inventing partial or invalid counters', async () => {
    let value: Record<string, unknown> = usage.G;
    const { baseUrl } = await fixture((_api, _body, response) => sse(response, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Ready' }] }, finishReason: 'STOP' }], usageMetadata: value }])), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const [gross, rates] of [[200000, [2, 12, 0.2]], [200001, [4, 18, 0.4]]] as const) { value = { ...usage.G, promptTokenCount: gross, totalTokenCount: gross + 5 }; expect((await provider.chat([input], { model: g })).usage?.costUsd).toBe(((gross - 4) * rates[0] + 5 * rates[1] + 4 * rates[2]) / 1e6); }
    for (const invalid of [{ promptTokenCount: 10 }, { ...usage.G, cachedContentTokenCount: 11 }, { ...usage.G, candidatesTokenCount: -1 }, { ...usage.G, thoughtsTokenCount: null }]) { value = invalid; expect((await provider.chat([input], { model: g })).usage).toBeUndefined(); }
  });

  it('withdraws awaited delivery before buffered output or completion in all four chat APIs', async () => {
    const { baseUrl } = await fixture(), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); for (const model of models) { const abort = new AbortController(), done = vi.fn(), seen: string[] = []; await expect(provider.streamChat([input], async text => { if (!text) return; seen.push(text); await Promise.resolve(); abort.abort(); }, done, undefined, { model, signal: abort.signal })).rejects.toThrow('OpenCode request aborted.'); expect(seen).toEqual(['Re']); expect(done).not.toHaveBeenCalled(); }
  });

  it('requires native terminal authority before delivering pending tools in every chat API', async () => {
    const { baseUrl } = await fixture((api, _body, response) => sse(response, api === 'A' ? [{ type: 'message_start', message: { id: 'answer', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} } }] : api === 'G' ? [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] } }] }] : api === 'C' ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{}' } }] } }] }] : [{ type: 'response.created', response: { id: 'answer', status: 'in_progress' } }, { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' } }], api === 'C')), provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); for (const model of models) { const done = vi.fn(), events: string[] = []; await expect(provider.streamChat([input], (_text, event) => { if (event) events.push(event.type); }, done, undefined, { model })).rejects.toThrow(/OpenCode/); expect(events).not.toContain('tool_call'); expect(done).not.toHaveBeenCalled(); }
  });

  it('keeps instance virtual classifier512 across A/G/C/R distinct from native T and never loads ambient credentials', async () => {
    const { calls, baseUrl } = await fixture(undefined, '{"label":"safe"}'); vi.stubEnv('OPENCODE_API_KEY', 'ambient'); expect(new providers.OpenCodeProvider({ type: 'opencode' }).validateConfig()).toBe(false);
    for (const model of models) { const provider = new providers.OpenCodeProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model }); expect(await new SpecializedModels(provider).classify({ model: `${model}:classifier`, input: 'Continue', labels: ['safe', 'review'] })).toMatchObject({ label: 'safe', usage: { inputTokens: model === g ? 6 : 5, outputTokens: model === g ? 5 : 2 } }); const body = calls.at(-1)!.body; expect(model === g ? body.generationConfig.maxOutputTokens : body[model === r ? 'max_output_tokens' : 'max_tokens']).toBe(512); }
    for (const endpoint of ['ftp://example.test', 'https://user:secret@example.test', 'https://example.test?secret=1', 'https://example.test#secret']) expect(() => new providers.OpenCodeProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid OpenCode endpoint.');
  });
});
