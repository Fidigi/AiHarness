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
import { SpecializedModels } from './specialized-models.js';
import type { Message } from '../types/index.js';

const continuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/opencode-go-continuation-reference.json', import.meta.url), 'utf8'));
const continuationModels: string[] = continuation.rows.map((row: { model: string }) => row.model);
const completions = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/opencode-go-continuation-reference-completions.json', import.meta.url), 'utf8'));
const completionModels: string[] = completions.rows.map((row: { model: string }) => row.model);

const a = 'claude-haiku-5-5', c = 'glm-5.3', r = 'gpt-6-luna', numeric = 'qwen3.7-plus';
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const usage = { A: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 }, C: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } }, R: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
function sse(response: ServerResponse, values: unknown[], done = false): void { response.setHeader('content-type', 'text/event-stream'); response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')); }
async function fixture(override?: (api: 'A' | 'C' | 'R', body: Record<string, any>, response: ServerResponse) => void, text = 'Ready') {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), api = request.url?.endsWith('/messages') ? 'A' : request.url?.endsWith('/responses') ? 'R' : 'C'; calls.push({ url: request.url, headers: request.headers, body });
    if (override) { override(api, body, response); return; }
    if (api === 'R') sse(response, [{ type: 'response.created', response: { id: 'answer', status: 'in_progress', output: [] } }, { type: 'response.output_text.delta', delta: text.slice(0, 2) }, { type: 'response.output_text.delta', delta: text.slice(2) }, { type: 'response.completed', response: { id: 'answer', status: 'completed', model: 'remote-alias', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: usage.R } }]);
    else if (body.stream) sse(response, api === 'A' ? [{ type: 'message_start', message: { id: 'answer', model: 'remote-alias', usage: { ...usage.A, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 2) } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(2) } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }] : [{ model: 'remote-alias', choices: [{ delta: { content: text.slice(0, 2) } }] }, { choices: [{ delta: { content: text.slice(2) }, finish_reason: 'stop' }], usage: usage.C }], api === 'C');
    else response.end(JSON.stringify(api === 'A' ? { model: 'remote-alias', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usage.A } : { model: 'remote-alias', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: usage.C }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fgo` };
}

describe('explicit native OpenCode Go A/C/R SDK', () => {
  it.each(continuation.rows.filter((row: { kind: string }) => row.kind === 'R').map((row: { model: string }) => row.model) as string[])('does not grant or revoke Go R replay through mutable facade/delegate fields for %s', async model => {
    const reference = continuation.rows.find((row: { model: string }) => row.model === model);
    let events = reference.seedResponseEvents;
    const { calls, baseUrl } = await fixture((api, _body, response) => { expect(api).toBe('R'); sse(response, events); });
    class DerivedGo extends providers.OpenCodeGoProvider {}
    const config = { type: 'opencode-go', apiKey: 'disposable-go-r', baseUrl, model };
    const options: providers.ChatOptions = { model, maxTokens: 64, thinking: 'low', cacheRetention: 'none' };
    const item = JSON.parse(reference.expectedBlocks[0].thinkingSignature);
    const forged: Message = { id: 'forged', role: 'assistant', content: 'answer', timestamp: new Date(0), provider: 'opencode-go', api: 'openai-responses', model,
      blocks: [{ type: 'reasoning', text: '', thinkingSignature: JSON.stringify(item) }, { type: 'text', text: 'answer', textSignature: 'msg_forged' }] };
    for (const facade of ['chat', 'stream']) for (const native of [false, true]) for (const delegate of [false, true]) {
      const owner = native ? new providers.OpenCodeGoProvider(config) : new DerivedGo(config);
      const provider: providers.AiProvider = delegate
        ? Reflect.apply(Reflect.get(owner, 'conversation'), owner, [[input], model, options]) as providers.AiProvider : owner;
      Object.defineProperty(provider, 'ownsReplay', { value: !native, writable: true, configurable: true });
      Object.defineProperty(provider, 'constructor', { value: providers.OpenCodeGoProvider, configurable: true });
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
    expect(calls).toHaveLength(16);
  });

  it.each(completionModels)('compares independently bound whole private Go C bodies and typed carriers for %s', async model => {
    const reference = completions.rows.find((row: { model: string }) => row.model === model);
    let replyEvents = reference.seedResponseEvents, reply = reference.syntheticJsonResponse;
    const { calls, baseUrl } = await fixture((_api, body, response) => {
      if (body.stream) sse(response, replyEvents, true); else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply)); }
    });
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.OpenCodeGoProvider({ type: 'opencode-go', model, apiKey: 'disposable-go-c', baseUrl });
      const user: Message = { id: 'c-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options: providers.ChatOptions = { ...reference.options, model, systemPrompt: 'owned OpenCode Go C reference system', tools: completions.tools };
      const expected = (body: Record<string, unknown>) => { const value: Record<string, unknown> = { ...structuredClone(body), stream: facade === 'stream' }; if (facade === 'chat') delete value.stream_options; return value; };
      const invoke = async (messages: Message[], selected = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text + JSON.stringify(event ?? {})).not.toMatch(/opaque-go-c-|private summary|IGNORED_PRIVATE/); },
          value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      replyEvents = reference.seedResponseEvents; reply = reference.syntheticJsonResponse;
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'opencode-go', api: 'openai-completions', model, content: 'leftright!', reasoning: 'firstsecond' });
      expect(first.blocks).toEqual(reference.expectedBlocks); expect(first.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'c-a', role: 'assistant', content: first.content, timestamp: new Date(0), ...projection.source,
          blocks: structuredClone(projection.blocks), toolCalls: structuredClone(projection.toolCalls), ...(projection.failed ? { metadata: { outputError: 'Failed Go C producer' } } : {}) };
        const result: Message[] = projection.toolResult ? [{ id: 'c-r', role: 'tool', name: 'echo', toolCallId: projection.toolResult.toolCallId,
          content: projection.toolResult.content.map((block: { text: string }) => block.text).join('\n'), isError: projection.toolResult.isError, timestamp: new Date(0) }] : [];
        const history = [user, source, ...result, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
        replyEvents = projection.responseEvents; reply = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'c-sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined });
      expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned OpenCode Go C reference system\n\nLeading system' }, { role: 'user', content: 'probe' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-go-c-replay-')), credential = 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-go-c']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'Go C private replay' }), registry = new ExtensionRegistry();
      const same = reference.cases[0].expectedBody.messages;
      const finalBlocks = [{ type: 'text', text: 'ok' }], finalItem = { role: 'assistant', content: 'ok', ...(providers.OPENCODE_GO_MODELS.find(profile => profile.id === model)!.requiresReasoningContent ? { reasoning_content: '' } : {}) };
      const native = () => calls.at(-1)!.body.messages; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; replyEvents = reference.cases[0].responseEvents; reply = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } }));
      replyEvents = reference.seedResponseEvents; reply = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'opencode-go', tools: completions.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'opencode-go', model, messages,
            tools: completions.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: 64, thinking: options.thinking, cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant');
        expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-go-c'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-go-c-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        const edited = { ...same[2], content: 'edited answer' }; delete edited.reasoning_details;
        expect(native()).toEqual([...same.slice(0, 2), edited, same[3], finalItem]);
        const canonicalTarget = getCompactionModelMessages(restarted, clone.id).find(message => message.content === 'edited answer')!;
        expect(canonicalTarget).toMatchObject({ provider: 'opencode-go', api: 'openai-completions', model }); expect(canonicalTarget.metadata).toBeUndefined(); expect(canonicalTarget.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) { const raw = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(raw).toHaveLength(2); expect(raw.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); }
        expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-go-c-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_GO_C_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_GO_C_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        const raw = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(raw).toHaveLength(2); expect(raw.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [{ role: 'system', content: 'owned OpenCode Go C reference system\n\n[Context Summary] PUBLIC_GO_C_PREFIX' }, finalItem] });
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(48); for (const call of calls) { expect(call.url).toBe('/owned%2Fgo/v1/chat/completions'); expect(call.headers.authorization).toBe('Bearer disposable-go-c');
      expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers['x-opencode-session']).toBeUndefined(); }
  });

  it('pins private C body identity and prices, awaits completion and refuses generic or derived grants', async () => {
    let reference = completions.rows.find((row: { model: string }) => row.model === c), plain = false;
    const { calls, baseUrl } = await fixture((_api, body, response) => {
      const row = completions.rows.find((row: { model: string }) => row.model === body.model) ?? reference;
      if (plain) { response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); return; }
      if (body.stream) sse(response, row.seedResponseEvents, true); else response.end(JSON.stringify(row.syntheticJsonResponse));
    });
    const user: Message = { ...input, content: 'probe' }, expected = (body: Record<string, unknown>, stream: boolean) => { const value: Record<string, unknown> = { ...structuredClone(body), stream }; if (!stream) delete value.stream_options; return value; };
    for (const model of [c, 'deepseek-v4-flash']) for (const facade of ['chat', 'stream']) {
      reference = completions.rows.find((row: { model: string }) => row.model === model);
      const provider = new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-c', model, baseUrl });
      provider.getProviderType = () => 'forged-go-c-provider'; provider.getModelApi = () => 'forged-go-c-api'; let reads = 0, captured: providers.ChatResponse | undefined;
      const base: providers.ChatOptions = { ...reference.options, tools: completions.tools, systemPrompt: 'owned OpenCode Go C reference system', sessionId: 'go-c-bound' };
      const options = { ...base, get model() { return ++reads === 1 ? model : a; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(a); } }, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody, facade === 'stream')); expect(captured).toMatchObject({ provider: 'opencode-go', api: 'openai-completions', model, blocks: reference.expectedBlocks });
      const rates = providers.OPENCODE_GO_MODELS.find(profile => profile.id === model)!.pricing!;
      expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'c-getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls },
        { id: 'c-getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'c-next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual(expected(reference.cases[0].expectedBody, false));
      const other = completions.rows.find((row: { model: string }) => row.model === (model === c ? 'deepseek-v4-flash' : c));
      await provider.chat(history, { ...base, model: other.model }); expect(calls.at(-1)!.body).toEqual(expected(other.cases.find((projection: { case: string }) => projection.case === 'model').expectedBody, false)); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(12); for (const call of calls) { expect(call.headers['x-opencode-session']).toBe('go-c-bound'); expect(call.headers['x-client-request-id']).toBeUndefined(); }
    for (const model of [c, 'deepseek-v4-flash']) { const errors: Error[] = [];
      await new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-c', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_GO_C_COMPLETION'); }, error => { errors.push(error); }, { maxTokens: 64, thinking: 'high' });
      expect(errors.map(error => error.message)).toEqual(['OpenCode Go chat request failed.']);
    }
    reference = completions.rows.find((row: { model: string }) => row.model === c);
    const source: Message = { ...user, role: 'assistant', content: 'leftright!', provider: 'opencode-go', api: 'openai-completions', model: c, blocks: reference.expectedBlocks, toolCalls: reference.expectedToolCalls };
    const config = { type: 'opencode-go', apiKey: 'disposable-go-c', model: c, baseUrl };
    expect((await new providers.OpenAiProvider(config).chat([source, user])).blocks).toBeUndefined();
    class DerivedGo extends providers.OpenCodeGoProvider {}
    await expect(new DerivedGo(config).chat([source, user])).rejects.toThrow('Unsupported OpenCode Go reasoning replay.');
    plain = true; expect((await new providers.OpenCodeProvider({ ...config, type: 'opencode' }).chat([source, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]);
    for (const call of calls.slice(-3)) expect(JSON.stringify(call.body)).not.toMatch(/opaque-go-c-|reasoning_details/); expect(calls).toHaveLength(17);
  });

  it('keeps existing C image attribution once and refuses undeclared images without preparing or decoding them', async () => {
    const { calls, baseUrl } = await fixture(); let refusals = 0;
    for (const profile of providers.OPENCODE_GO_MODELS.filter(profile => profile.api === 'openai-completions')) for (const facade of ['chat', 'stream']) {
      const history: Message[] = [{ ...input, content: 'before' }, { id: 'c-image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'opencode-go', api: 'openai-completions', model: profile.id,
        toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'c-image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'c-after', content: 'after' }], before = structuredClone(history);
      const provider = new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-c', model: profile.id, baseUrl }), invoke = () => facade === 'chat' ? provider.chat(history) : provider.streamChat(history, () => {}, undefined, error => { throw error; });
      if (!profile.declaredInput.includes('image')) { await expect(invoke()).rejects.toThrow('OpenCode Go chat model does not support images.'); refusals++; }
      else { await invoke(); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'before' }, { role: 'assistant', content: 'called', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'read', arguments: '{}' } }], ...(profile.requiresReasoningContent ? { reasoning_content: '' } : {}) },
        { role: 'tool', content: 'result', tool_call_id: 'image-call' }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }, { role: 'user', content: 'after' }]); }
      expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(22); expect(refusals).toBe(18);
  });

  it('withdraws private C pending tools on EOF, provider error and awaited abort without exposing opaque fields', async () => {
    const reference = completions.rows.find((row: { model: string }) => row.model === c); let mode = 'eof';
    const { calls, baseUrl } = await fixture((_api, _body, response) => {
      const events = structuredClone(reference.seedResponseEvents); events[0].choices[0].delta.reasoning_details = [events[4].choices[0].delta.reasoning_details[0]];
      sse(response, mode === 'eof' ? events.slice(0, -1) : mode === 'error' ? [...events.slice(0, -1), { error: { message: 'PRIVATE_GO_C_FAILURE' } }] : events, true);
    });
    for (mode of ['eof', 'error', 'abort']) { const controller = new AbortController(), complete = vi.fn(), errors: Error[] = [], seen: string[] = [];
      await new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-c', model: c, baseUrl }).streamChat([input], async (text, event) => {
        seen.push(text + JSON.stringify(event ?? {})); if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); }
      }, complete, error => { errors.push(error); }, { signal: controller.signal, maxTokens: 64, thinking: 'high' });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toMatch(/PRIVATE_|opaque-go-c-/); expect(complete).not.toHaveBeenCalled(); expect(seen.join('')).not.toMatch(/opaque-go-c-|private summary|tool_call/);
      if (mode === 'abort') expect(seen).toHaveLength(1);
    }
    expect(calls).toHaveLength(3);
  });

  it.each(continuationModels)('compares independent whole private A/R bodies and ordered carriers for %s', async model => {
    const reference = continuation.rows.find((row: { model: string }) => row.model === model), isA = reference.kind === 'A';
    let replyEvents = reference.seedResponseEvents, reply = reference.syntheticJsonResponse;
    const { calls, baseUrl } = await fixture((api, body, response) => {
      if (api === 'A' && !body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply)); }
      else sse(response, replyEvents, api === 'R');
    });
    for (const facade of ['chat', 'stream']) {
      const provider = new providers.OpenCodeGoProvider({ type: 'opencode-go', model, apiKey: 'disposable-go-private', baseUrl });
      const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options = { model, maxTokens: isA ? 4096 : 64, thinking: 'low' as const, cacheRetention: 'none' as const, systemPrompt: 'owned OpenCode Go reference system', tools: continuation.tools };
      const expected = (body: Record<string, unknown>) => ({ ...structuredClone(body), stream: isA ? facade === 'stream' : true });
      const invoke = async (messages: Message[], selected: providers.ChatOptions = options) => {
        if (facade === 'chat') return provider.chat(messages, selected); let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text).not.toContain('PRIVATE_GO_HEADER'); expect(JSON.stringify(event ?? {})).not.toContain('PRIVATE_GO_HEADER'); },
          value => { complete = value; }, error => { throw error; }, selected); expect(complete).toBeDefined(); return complete!;
      };
      replyEvents = reference.seedResponseEvents.map((event: Record<string, any>) => isA && event.type === 'message_start'
        ? { ...event, message: { ...event.message, content: [{ type: 'text', text: 'PRIVATE_GO_HEADER' }] } } : event);
      reply = reference.syntheticJsonResponse;
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'opencode-go', api: reference.api, model, content: isA ? 'left!right?' : 'leftright' });
      expect(first.blocks).toEqual(reference.expectedBlocks); expect(first.toolCalls).toEqual(reference.expectedToolCalls); expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'a', role: 'assistant', content: first.content, timestamp: new Date(0), provider: projection.source.provider, api: projection.source.api, model: projection.source.model,
          blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls) };
        if (isA) {
          const thought = source.blocks!.find(block => block.type === 'reasoning' && !block.redacted)!; expect(thought.type).toBe('reasoning'); if (thought.type !== 'reasoning') throw new Error('Missing reference thought');
          if (projection.case === 'unsigned') delete thought.thinkingSignature; if (projection.case === 'empty-thinking') thought.text = ''; if (projection.case === 'blank-thinking') thought.text = ' \t';
          if (projection.case === 'empty-signature') thought.thinkingSignature = ''; if (projection.case === 'blank-signature') thought.thinkingSignature = ' \t';
        } else if (projection.case === 'expurgated') for (const block of source.blocks!) { if (block.type === 'text') delete block.textSignature; if (block.type === 'reasoning') delete block.thinkingSignature; }
        const failed = projection.case.startsWith('failed-') || projection.case === 'failed'; if (failed) source.metadata = { outputError: 'Failed OpenCode Go producer' };
        const results: Message[] = failed ? [] : [{ id: 'r', role: 'tool', name: 'echo', toolCallId: first.toolCalls![0].id, content: 'result', timestamp: new Date(0) }];
        const history = [user, source, ...results, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history);
        replyEvents = projection.responseEvents; reply = projection.syntheticJsonResponse;
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined });
      expect(calls.at(-1)!.body).toEqual(isA ? { ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'Leading system' }] }
        : { ...expected(reference.expectedInitialBody), input: [{ role: 'developer', content: 'Leading system' }, ...reference.expectedInitialBody.input.slice(1)] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual(isA ? { ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'owned OpenCode Go reference system\n\nLeading system' }] }
        : { ...expected(reference.expectedInitialBody), input: [reference.expectedInitialBody.input[0], { role: 'developer', content: 'Leading system' }, ...reference.expectedInitialBody.input.slice(1)] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-go-replay-')), credential = isA ? 'opaque-go-signature' : 'sensitive', redactor = new CredentialRedactor([credential, 'disposable-go-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'OpenCode Go private replay' }), registry = new ExtensionRegistry();
      const finalBlocks = isA ? [{ type: 'text', text: 'ok' }] : [{ type: 'text', text: 'ok', textSignature: '{"v":1,"id":"msg_ok","phase":"final_answer"}' }];
      const finalItem = isA ? { role: 'assistant', content: finalBlocks } : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }], status: 'completed', id: 'msg_ok', phase: 'final_answer' };
      const field = isA ? 'messages' : 'input', same = reference.cases[0].expectedBody[field], native = () => calls.at(-1)!.body[field]; let effects = 0;
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; replyEvents = reference.cases[0].responseEvents; reply = reference.cases[0].syntheticJsonResponse; return { content: 'result' }; } }));
      replyEvents = reference.seedResponseEvents; reply = reference.syntheticJsonResponse;
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'opencode-go', tools: continuation.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'opencode-go', model, messages,
            tools: continuation.tools, systemPrompt: options.systemPrompt, extensionRegistry: registry, maxRetries: 0, maxTokens: options.maxTokens, thinking: 'low', cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1); expect(native()).toEqual(redactJson(same.slice(0, -1)));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), history = session.messages.filter(item => item.role === 'assistant');
        expect(history.map(item => item.blocks)).toEqual([redactJson(reference.expectedBlocks), finalBlocks]); expect(bytes).not.toContain(credential); expect(bytes).not.toContain('disposable-go-private'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-go-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain(credential);
        await invoke(loaded.messages); expect(native()).toEqual([...redactJson(same.slice(0, -1)), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy(); await invoke(getCompactionModelMessages(restarted, clone.id));
        expect(native()).toEqual(isA ? [same[0], { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }, { type: 'text', text: 'edited answer' }] }, same.at(-2), finalItem]
          : [...same.slice(0, 2), { type: 'function_call', call_id: 'call_native', id: 'fc_native', name: 'echo', arguments: '{"x":1}' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'edited answer', annotations: [] }], status: 'completed', id: 'msg_pi_1' }, same.at(-2), finalItem]);
        const originalRaw = (await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(originalRaw).toHaveLength(2); expect(originalRaw.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks))); expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(history.map(item => item.blocks));
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical); expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-go-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8'); await restarted.applyCompaction(clone.id, 'PUBLIC_GO_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy(); const compacted = getCompactionModelMessages(compactedManager, clone.id);
        expect(compacted.some(item => item.content.includes('PUBLIC_GO_COMPACTED_PREFIX'))).toBe(true); expect(compacted.map(item => ({ role: item.role, content: item.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_GO_COMPACTED_PREFIX' }, { role: 'assistant', content: 'ok' }]); expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalBlocks]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        const retained = (await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(retained).toHaveLength(2); expect(retained.map(entry => entry.blocks)).toEqual(expect.arrayContaining(history.map(item => item.blocks)));
        const ancestry = (await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant'); expect(ancestry.map(entry => entry.blocks)).toEqual(history.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual(isA ? { ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'owned OpenCode Go reference system\n\n[Context Summary] PUBLIC_GO_COMPACTED_PREFIX' }], messages: [finalItem] }
          : { ...expected(reference.expectedInitialBody), input: [same[0], { role: 'developer', content: '[Context Summary] PUBLIC_GO_COMPACTED_PREFIX' }, finalItem] });
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(isA ? 40 : 30);
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fgo/v1/' + (isA ? 'messages' : 'responses')); expect(call.headers[isA ? 'x-api-key' : 'authorization']).toBe(isA ? 'disposable-go-private' : 'Bearer disposable-go-private');
      expect(call.headers[isA ? 'authorization' : 'x-api-key']).toBeUndefined(); expect(call.headers['anthropic-beta']).toBe(reference.sdkBeta ?? undefined);
    }
  });

  it('pins A/R body identity and prices across getters, awaits publication and rejects forged or derived admission', async () => {
    let reference = continuation.rows[0];
    const { calls, baseUrl } = await fixture((api, body, response) => { if (api === 'C') { response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }] })); return; }
      if (api === 'A' && !body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reference.syntheticJsonResponse)); } else sse(response, reference.seedResponseEvents, api === 'R'); });
    const user: Message = { ...input, content: 'probe' };
    for (const model of [a, r]) for (const facade of ['chat', 'stream']) {
      reference = continuation.rows.find((row: { model: string }) => row.model === model); const isA = reference.kind === 'A', selectedReference = reference;
      const foreignReference = continuation.rows.find((row: { model: string; kind: string }) => row.kind === reference.kind && row.model !== model);
      const provider = new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-private', baseUrl, model });
      provider.getProviderType = () => 'forged-public-provider'; provider.getModelApi = () => 'forged-public-api'; let reads = 0, captured: providers.ChatResponse | undefined;
      const base = { maxTokens: isA ? 4096 : 64, thinking: 'low' as const, cacheRetention: 'none' as const, systemPrompt: 'owned OpenCode Go reference system', sessionId: 'go-bound', tools: continuation.tools };
      const options = { ...base, get model() { return ++reads === 1 ? model : isA ? r : a; } };
      if (facade === 'chat') captured = await provider.chat([user], options); else await provider.streamChat([user], () => {}, value => { captured = value; }, error => { throw error; }, options);
      expect(calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, stream: isA ? facade === 'stream' : true });
      expect(captured).toMatchObject({ provider: 'opencode-go', api: reference.api, model, blocks: reference.expectedBlocks });
      const rates = providers.OPENCODE_GO_MODELS.find(profile => profile.id === model)!.pricing!;
      expect(captured!.usage?.costUsd).toBeCloseTo((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + (isA ? 3 : 1) * rates.cacheWritePerMillion) / 1e6, 12);
      const history: Message[] = [user, { id: 'getter-a', role: 'assistant', content: captured!.content, timestamp: new Date(0), provider: captured!.provider, api: captured!.api, model: captured!.model, blocks: captured!.blocks, toolCalls: captured!.toolCalls },
        { id: 'getter-r', role: 'tool', name: 'echo', toolCallId: captured!.toolCalls![0].id, content: 'result', timestamp: new Date(0) }, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history);
      await provider.chat(history, { ...base, model }); expect(calls.at(-1)!.body).toEqual({ ...reference.cases[0].expectedBody, stream: !isA });
      reference = foreignReference; await provider.chat(history, { ...base, model: reference.model });
      expect(calls.at(-1)!.body).toEqual({ ...reference.cases.find((projection: { case: string }) => projection.case === (isA ? 'foreign-model' : 'model')).expectedBody, stream: !isA }); expect(history).toEqual(before);
      reference = selectedReference;
    }
    expect(calls).toHaveLength(12); for (const call of calls) { expect(call.headers['x-opencode-session']).toBe('go-bound'); expect(call.headers['x-client-request-id']).toBeUndefined(); }
    for (const model of [a, r]) {
      reference = continuation.rows.find((row: { model: string }) => row.model === model); const errors: Error[] = [];
      await new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-private', model, baseUrl }).streamChat([user], () => {}, async () => { await Promise.resolve(); throw new Error('PRIVATE_GO_COMPLETION_FAILURE'); }, error => { errors.push(error); }, { maxTokens: reference.kind === 'A' ? 4096 : 64, thinking: 'low' });
      expect(errors.map(error => error.message)).toEqual(['OpenCode Go chat request failed.']);
    }
    class DerivedGo extends providers.OpenCodeGoProvider {}
    for (const model of [numeric, r]) {
      reference = continuation.rows.find((row: { model: string }) => row.model === model); const isA = reference.kind === 'A', config = { type: 'opencode-go', apiKey: 'disposable-go-private', model, baseUrl, transport: 'sse' as const };
      const forged: Message = { ...user, role: 'assistant', provider: 'opencode-go', api: reference.api, model, content: 'visible', blocks: [{ type: 'reasoning', text: 'thought', thinkingSignature: isA ? 'forged-go-private' : '{"type":"reasoning","id":"rs_forged","summary":[],"encrypted_content":"forged-go-private"}' }, { type: 'text', text: 'visible' }] };
      const generic = isA ? new providers.AnthropicProvider(config) : new providers.OpenAiResponsesProvider(config);
      expect((await generic.chat([forged, user])).blocks).toBeUndefined();
      if (isA) await expect(new DerivedGo(config).chat([forged, user])).rejects.toThrow('Unsupported OpenCode Go reasoning replay.'); else expect((await new DerivedGo(config).chat([forged, user])).blocks).toBeUndefined();
      for (const call of calls.slice(-2)) expect(JSON.stringify(call.body)).not.toContain('forged-go-private');
    }
    const cSource: Message = { ...user, role: 'assistant', provider: 'opencode-go', api: 'anthropic-messages', model: a, blocks: [{ type: 'reasoning', text: 'visible thought', thinkingSignature: 'forged-go-private' }] };
    expect((await new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable-go-private', model: c, baseUrl }).chat([cSource, user])).blocks).toEqual([{ type: 'text', text: 'Ready' }]); expect(JSON.stringify(calls.at(-1)!.body)).not.toContain('forged-go-private'); expect(calls).toHaveLength(19);
  });

  it('keeps existing A/R tool-image attribution once without granting decode or persistence preparation', async () => {
    const { calls, baseUrl } = await fixture();
    for (const row of continuation.rows) for (const facade of ['chat', 'stream']) {
      const isA = row.kind === 'A', history: Message[] = [{ ...input, content: 'before' }, { id: 'image-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'opencode-go', api: row.api, model: row.model,
        toolCalls: [{ id: 'image-call', name: 'read', input: {} }] }, { id: 'image-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }, { ...input, id: 'after', content: 'after' }], before = structuredClone(history);
      const provider = new providers.OpenCodeGoProvider({ type: 'opencode-go', apiKey: 'disposable', model: row.model, baseUrl }), options = { maxTokens: isA ? 4096 : 64, thinking: 'low' as const, cacheRetention: 'none' as const };
      if (facade === 'chat') await provider.chat(history, options); else await provider.streamChat(history, () => {}, undefined, error => { throw error; }, options);
      expect(calls.at(-1)!.body[isA ? 'messages' : 'input']).toEqual(isA ? [{ role: 'user', content: 'before' }, { role: 'assistant', content: [{ type: 'text', text: 'called' }, { type: 'tool_use', id: 'image-call', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-call', content: 'result', is_error: false }] }, { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }, { role: 'user', content: 'after' }]
        : [{ role: 'user', content: [{ type: 'input_text', text: 'before' }] }, { role: 'assistant', content: 'called' }, { type: 'function_call', call_id: 'image-call', name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: 'image-call', output: 'result' }, { role: 'user', content: [{ type: 'input_text', text: 'Tool images for image-call' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] }, { role: 'user', content: [{ type: 'input_text', text: 'after' }] }]);
      expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(22);
  });

  it('does not turn a compatible generic adapter into OpenCode Go policy', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.OpenAiProvider({ type: 'opencode-go', apiKey: 'disposable', model: c, baseUrl: baseUrl + '/v1' }).chat([input], { sessionId: 'generic' });
    expect(calls[0].headers['x-opencode-session']).toBeUndefined(); expect(getProviderPublishedModel('opencode-go', c, new providers.OpenAiProvider({ type: 'opencode-go', model: c }))).toBeUndefined();
  });

  it('publishes31 frozen physical A/C/R profiles with defensive metadata and two unknown zero-only prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl }), profiles = providers.OPENCODE_GO_MODELS;
    expect(profiles).toHaveLength(31); expect(new Set(profiles.map(p => p.id)).size).toBe(31); expect(profiles.filter(p => p.api === 'anthropic-messages')).toHaveLength(5); expect(profiles.filter(p => p.api === 'openai-completions')).toHaveLength(20); expect(profiles.filter(p => p.api === 'openai-responses')).toHaveLength(6);
    expect(Object.isFrozen(profiles)).toBe(true); for (const p of profiles) expect(Object.isFrozen(p) && Object.isFrozen(p.declaredInput) && Object.isFrozen(p.declaredPricing) && Object.isFrozen(p.thinkingLevelMap)).toBe(true);
    expect(profiles.filter(p => p.pricing)).toHaveLength(29); expect(profiles.filter(p => !p.pricing).map(p => p.id)).toEqual(['longcat-2.5-preview-free', 'step-5-preview-free']);
    expect(await provider.getAvailableModels()).toEqual(profiles.map(p => p.id)); expect(provider.canDiscoverModels()).toBe(false); expect(providers.ProviderFactory.has('opencode-go')).toBe(false); expect(provider.getModelApi(a)).toBe('anthropic-messages'); expect(provider.getModelApi(c)).toBe('openai-completions'); expect(provider.getModelApi(r)).toBe('openai-responses'); expect(provider.getModelApi('future')).toBeUndefined();
    const row = getProviderPublishedModel('anthropic', 'mimo-v2.5-pro', provider)!; expect(row).toMatchObject({ contextWindow: 1048576, maxOutputTokens: 128000, pricing: { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheReadPerMillion: 0.003625 } }); row.contextWindow = 1; row.pricing!.inputPerMillion = 999; row.thinkingLevelMap!.high = 'foreign'; expect(getProviderPublishedModel('anthropic', 'mimo-v2.5-pro', provider)?.contextWindow).toBe(1048576); expect(getProviderPublishedModel('anthropic', 'mimo-v2.5-pro', provider)?.pricing?.inputPerMillion).toBe(0.435); expect(getProviderPublishedModel('anthropic', 'mimo-v2.5-pro', provider)?.thinkingLevelMap?.high).toBe('high');
    expect(getProviderPublishedModel('anthropic', 'step-5-preview-free', provider)?.pricing).toBeUndefined(); expect(getProviderPublishedModel('anthropic', 'claude-sonnet-4-6', provider)).toBeUndefined(); expect(getSupportedThinkingLevels('anthropic', 'kimi-k3', undefined, provider)).toEqual(['max']); expect(getSupportedThinkingLevels('anthropic', a, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']); expect(calls).toEqual([]);
  });

  it('dispatches every physical profile through its native API and captures physical known-or-unknown prices', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'openai', apiKey: 'disposable', baseUrl });
    for (const p of providers.OPENCODE_GO_MODELS) {
      const options = { model: p.id, thinking: 'high' as const, sessionId: 'go-session', systemPrompt: 'System', cacheRetention: 'long' as const, tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] }, complete = vi.fn(), answer = await provider.chat([input], options); await provider.streamChat([input], () => {}, complete, error => { throw error; }, options);
      const cost = p.pricing ? (5 * p.pricing.inputPerMillion + 2 * p.pricing.outputPerMillion + 4 * p.pricing.cacheReadPerMillion + p.pricing.cacheWritePerMillion) / 1e6 : undefined;
      for (const result of [answer, complete.mock.calls[0][0]]) { expect(result).toMatchObject({ provider: 'openai', model: p.id, api: p.api, content: 'Ready', usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 } }); expect(result.usage.costUsd).toBe(cost); }
      for (const call of calls.slice(-2)) { expect(call.url).toBe('/owned%2Fgo/v1/' + (p.api === 'anthropic-messages' ? 'messages' : p.api === 'openai-completions' ? 'chat/completions' : 'responses')); expect(call.headers['x-opencode-session']).toBe('go-session'); if (p.api === 'anthropic-messages') { expect(call.headers['x-api-key']).toBe('disposable'); expect(call.headers.authorization).toBeUndefined(); expect(call.body.max_tokens).toBe(p.maxOutputTokens); expect(call.body.tools[0]).toMatchObject({ input_schema: { type: 'object' }, eager_input_streaming: true, cache_control: { type: 'ephemeral', ttl: '1h' } }); expect(call.body.tools[0]).not.toHaveProperty('strict'); } else { expect(call.headers.authorization).toBe('Bearer disposable'); expect(call.headers['x-api-key']).toBeUndefined(); expect(call.body).not.toHaveProperty('max_completion_tokens'); if (p.api === 'openai-completions') { expect(call.body).not.toHaveProperty('store'); expect(call.body).not.toHaveProperty('max_tokens'); expect(call.body.tools[0].function.strict).toBe(false); } else { expect(call.body.store).toBe(false); expect(call.body.input[0].role).toBe('developer'); expect(call.body).not.toHaveProperty('instructions'); expect(call.body.tools[0]).not.toHaveProperty('strict'); } } }
    }
    expect(calls).toHaveLength(62);
  });

  it('owns adaptive versus numeric A and routed C effort without borrowing direct-vendor policies', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    await provider.chat([input], { model: a, thinking: 'max', temperature: 0.5, maxTokens: 1 }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 1, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } }); expect(calls.at(-1)!.body).not.toHaveProperty('temperature');
    await provider.chat([input], { model: a, thinking: 'off', temperature: 0.5 }); expect(calls.at(-1)!.body.thinking).toEqual({ type: 'disabled' }); expect(calls.at(-1)!.body).not.toHaveProperty('temperature');
    await provider.streamChat([input], () => {}, undefined, error => { throw error; }, { model: a, thinking: 'off', temperature: 0.5 }); expect(calls.at(-1)!.body).not.toHaveProperty('temperature');
    await provider.chat([input], { model: numeric, thinking: 'low', maxTokens: 5120, thinkingBudgets: { low: 4096 } }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 5120, thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' } }); expect(calls.at(-1)!.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) await provider.chat([input], { model: 'deepseek-v4.1-flash', thinking }); expect(calls.slice(-7).map(call => call.body.reasoning_effort)).toEqual(['low', 'low', 'low', 'high', 'high', 'max', 'max']);
    await provider.chat([input], { model: 'kimi-k3', thinking: 'off' }); expect(calls.at(-1)!.body.reasoning_effort).toBe('max'); expect(calls.at(-1)!.body).not.toHaveProperty('thinking'); await provider.chat([input], { model: c, thinking: 'high' }); expect(calls.at(-1)!.body.reasoning_effort).toBe('high'); expect(calls.at(-1)!.body).not.toHaveProperty('thinking'); expect(calls.at(-1)!.body).not.toHaveProperty('tool_stream');
  });

  it('owns wrapper session headers independently of cache retention and model-specific unsigned A/C replay', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl }), history: Message[] = [{ ...input, role: 'assistant', content: 'Before', blocks: [{ type: 'reasoning', text: 'Earlier plan' }] }, input];
    for (const model of [a, 'qwen3.8-flash', c, r]) for (const cacheRetention of ['none', 'short', 'long'] as const) { const ownedHistory = history.map(message => message.role === 'assistant' ? { ...message, provider: 'operator', api: provider.getModelApi(model), model } : message); await provider.chat(ownedHistory, { model, sessionId: 'go-session', cacheRetention, systemPrompt: 'System', tools: [{ name: 'first', description: 'First', parameters: {} }, { name: 'last', description: 'Last', parameters: {} }] }); const call = calls.at(-1)!, b = call.body; expect(call.headers['x-opencode-session']).toBe('go-session'); expect(call.headers.session_id).toBeUndefined(); expect(call.headers['session-id']).toBeUndefined(); expect(call.headers['x-session-affinity']).toBeUndefined(); expect(call.headers['x-client-request-id']).toBe(model === r && cacheRetention !== 'none' ? 'go-session' : undefined);
      if (model === a || model === 'qwen3.8-flash') { const control = cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(cacheRetention === 'long' ? { ttl: '1h' } : {}) }; expect(b.system[0].cache_control).toEqual(control); expect(b.tools[0].cache_control).toBeUndefined(); expect(b.tools[1].cache_control).toEqual(control); expect(b.messages[0].content[0]).toEqual(model === a ? { type: 'text', text: 'Earlier plan' } : { type: 'thinking', thinking: 'Earlier plan', signature: '' }); }
      else { expect(b.prompt_cache_key).toBe(cacheRetention === 'none' || (model === c && cacheRetention === 'short') ? undefined : 'go-session'); expect(b.prompt_cache_retention).toBe(cacheRetention === 'long' ? '24h' : undefined); if (model === c) expect(b.messages.find((m: { role: string }) => m.role === 'assistant').reasoning_content).toBeUndefined(); }
    }
    const overridden = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'X-OpenCode-Session': 'operator-owned', 'x-client-request-id': 'operator-request' } }); await overridden.chat([input], { model: r, sessionId: 'automatic', cacheRetention: 'none' }); expect(calls.at(-1)!.headers['x-opencode-session']).toBe('operator-owned'); expect(calls.at(-1)!.headers['x-client-request-id']).toBe('operator-request');
    const unicode = '字🙂'.repeat(40); await overridden.chat([input], { model: r, sessionId: unicode, cacheRetention: 'long' }); expect(calls.at(-1)!.body.prompt_cache_key).toBe(Array.from(unicode).slice(0, 64).join(''));
  });

  it('keeps exact safe A/C caps and the native R floor without changing numeric budgets or omission scope', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of [a, c, r]) { await provider.chat([input], { model, maxTokens: 1 }); expect(calls.at(-1)!.body[model === r ? 'max_output_tokens' : 'max_tokens']).toBe(model === r ? 16 : 1); }
    const count = calls.length; for (const maxTokens of [0, -1, 0.5, 128001, Number.NaN]) await expect(provider.chat([input], { model: a, maxTokens })).rejects.toThrow('Invalid OpenCode Go output limit.'); await expect(provider.chat([input], { model: numeric, thinking: 'high', maxTokens: 1024 })).rejects.toThrow('Invalid OpenCode Go output limit.'); expect(calls).toHaveLength(count);
    provider.setConfiguredModel(a); const captured = captureNativeOutputBudget(provider)!; provider.setConfiguredModel('kimi-k3'); expect(captured({}).maxTokens).toBe(128000); expect(captureNativeOutputBudget(provider)!({}).maxTokens).toBe(131072);
  });

  it.each([a, c, r].flatMap(model => (['chat', 'stream'] as const).map(operation => ({ model, operation }))))('captures empty-override physical provenance before awaited mutation ($model/$operation)', async ({ model, operation }) => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model }); let result: providers.ChatResponse | undefined;
    if (operation === 'chat') result = await provider.chat([input], { model: '' }); else await provider.streamChat([input], async text => { if (text) { await Promise.resolve(); provider.setConfiguredModel(model === a ? c : a); } }, answer => { result = answer; }, undefined, { model: '' }); expect(calls[0].body.model).toBe(model); expect(result).toMatchObject({ model, provider: 'operator', api: model === a ? 'anthropic-messages' : model === c ? 'openai-completions' : 'openai-responses', usage: { totalTokens: 12 } });
  });

  it('retains observed tier thresholds and genuine API-specific cache accounting without pricing zero-only profiles', async () => {
    let value: Record<string, unknown> = usage.A;
    const { baseUrl } = await fixture((api, _body, response) => { if (api === 'A') response.end(JSON.stringify({ content: [{ type: 'text', text: 'Ready' }], stop_reason: 'end_turn', usage: value })); else if (api === 'C') response.end(JSON.stringify({ choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }], usage: value })); else sse(response, [{ type: 'response.completed', response: { id: 'answer', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready' }] }], usage: value } }]); }), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const [model, threshold, rates] of [[a, 100000, [0.5, 2.5, 0.05, 0.625]], [numeric, 256000, [1.2, 4.8, 0.12, 1.5]], ['minimax-m3', 512000, [0.6, 2.4, 0.12, 0]], [r, 272000, [0.2, 0.75, 0.02, 0.25]], ['grok-4.7', 200000, [4, 12, 1, 0]]] as const) { const gross = threshold + 1; value = model === r || model === 'grok-4.7' ? { ...usage.R, input_tokens: gross } : { ...usage.A, input_tokens: gross - 5 }; expect((await provider.chat([input], { model })).usage?.costUsd).toBe(((gross - 5) * rates[0] + 2 * rates[1] + 4 * rates[2] + rates[3]) / 1e6); }
    value = { ...usage.A, cache_creation: { ephemeral_1h_input_tokens: 1 } }; expect((await provider.chat([input], { model: a })).usage?.costUsd).toBe((5 * 0.1 + 2 * 0.5 + 4 * 0.01 + 0.2) / 1e6);
    value = usage.C; expect((await provider.chat([input], { model: 'step-5-preview-free' })).usage?.costUsd).toBeUndefined(); for (const bad of [{ input_tokens: 5 }, { ...usage.A, cache_creation_input_tokens: null }]) { value = bad; expect((await provider.chat([input], { model: a })).usage).toBeUndefined(); } for (const model of [c, r]) { value = model === c ? { ...usage.C, prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } } : { ...usage.R, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 2 } }; expect((await provider.chat([input], { model })).usage).toBeUndefined(); }
  });

  it('withdraws awaited delivery before buffered output or completion in every physical API', async () => {
    const { baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); for (const model of [a, c, r]) { const abort = new AbortController(), done = vi.fn(), seen: string[] = []; await expect(provider.streamChat([input], async text => { if (!text) return; seen.push(text); await Promise.resolve(); abort.abort(); }, done, undefined, { model, signal: abort.signal })).rejects.toThrow('OpenCode Go request aborted.'); expect(seen).toEqual(['Re']); expect(done).not.toHaveBeenCalled(); }
  });

  it('rejects missing terminal authority before pending tools and preserves private diagnostics', async () => {
    const { baseUrl } = await fixture((api, _body, response) => sse(response, api === 'A' ? [{ type: 'message_start', message: { id: 'answer', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} } }] : api === 'C' ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{}' } }] } }] }] : [{ type: 'response.created', response: { id: 'answer', status: 'in_progress' } }, { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' } }], api === 'C')), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'private-key', baseUrl }); for (const model of [a, c, r]) { const done = vi.fn(), chunks: string[] = []; await expect(provider.streamChat([input], (_text, event) => { chunks.push(event!.type); }, done, undefined, { model })).rejects.toThrow(/OpenCode Go/); expect(chunks).not.toContain('tool_call'); expect(done).not.toHaveBeenCalled(); }
  });

  it('admits only declared data images, native IDs, safe endpoints and supplied representable keys', async () => {
    const { calls, baseUrl } = await fixture(), provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl }); vi.stubEnv('OPENCODE_API_KEY', 'ambient-key'); vi.stubEnv('OPENAI_API_KEY', 'ambient-key'); vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key'); expect(new providers.OpenCodeGoProvider({ type: 'opencode-go' }).validateConfig()).toBe(false);
    for (const model of ['future', 'claude-sonnet-4-6', 'opencode/gpt-6-luna']) { expect(() => provider.setConfiguredModel(model)).toThrow('OpenCode Go chat model is not supported.'); await expect(provider.chat([input], { model })).rejects.toThrow('OpenCode Go chat model is not supported.'); } for (const apiKey of [undefined, '', 'bad\nkey', '🙂']) await expect(new providers.OpenCodeGoProvider({ type: 'operator', apiKey, baseUrl }).chat([input])).rejects.toThrow('OpenCode Go API key is required.'); expect(calls).toEqual([]);
    const image: Message = { ...input, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }; for (const model of [a, 'deepseek-v4.1-flash', r]) await provider.chat([image], { model }); await expect(provider.chat([image], { model: c })).rejects.toThrow('OpenCode Go chat model does not support images.'); for (const endpoint of ['ftp://example.test', 'https://user:secret@example.test', 'https://example.test?secret=1', 'https://example.test#secret']) expect(() => new providers.OpenCodeGoProvider({ type: 'operator', baseUrl: endpoint })).toThrow('Invalid OpenCode Go endpoint.');
  });

  it('retains instance virtual classifier512 and normalized TokenUsage across A/C/R without an image-generation API', async () => {
    const { calls, baseUrl } = await fixture(undefined, '{"label":"safe"}'); for (const model of [a, c, r]) { const provider = new providers.OpenCodeGoProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model }), sdk = new SpecializedModels(provider); expect(sdk.getModelsOfType('image')).toEqual([]); expect(await sdk.classify({ model: `${model}:classifier`, input: 'Hello', labels: ['safe', 'unsafe'] })).toMatchObject({ label: 'safe', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12 } }); expect(calls.at(-1)!.body[model === r ? 'max_output_tokens' : 'max_tokens']).toBe(512); await expect(provider.generateImages({ model: 'image', prompt: 'Image' })).rejects.toThrow('Image generation is not supported by this provider.'); }
  });
});
