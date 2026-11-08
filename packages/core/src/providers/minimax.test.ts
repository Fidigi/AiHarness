import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { deserializeSession, serializeSession, serializeSessionForExport } from '../sessions/serialization.js';
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
import { captureNativeOutputBudget } from './provider-output-budget.js';
import type { Message } from '../types/index.js';

const continuationBytes = readFileSync(new URL('../../../../tests/fixtures/minimax-continuation-reference.json', import.meta.url));
const continuation = JSON.parse(continuationBytes.toString()) as {
  pinnedCommit: string; captureSha256: string; profiles: number; replayProjections: number; freshSdkRequests: number;
  tools: NonNullable<providers.ChatOptions['tools']>; syntheticJsonContent: unknown[]; seedEvents: unknown[];
  expectedBlocks: NonNullable<Message['blocks']>;
  rows: Array<{ scope: 'minimax' | 'minimax-cn'; model: string; api: string; cases: Array<{ case: string; expectedMessages: unknown[] }> }>;
};
const numericBytes = readFileSync(new URL('../../../../tests/fixtures/minimax-numeric-reference.json', import.meta.url));
const numeric = JSON.parse(numericBytes.toString()) as {
  pinnedCommit: string; captureSha256: string; originalSdkRequests: number; newSdkRequests: number;
  vectors: Array<{ scope: 'minimax' | 'minimax-cn'; model: string; id: string; context: string; characters: number;
    logicalOptions: { reasoning?: providers.ChatOptions['thinking']; maxTokens?: number; thinkingBudgets?: providers.ChatOptions['thinkingBudgets'] };
    expected: { maxTokens: number; thinking: { type: string; budget_tokens?: number; display?: string } } }>;
};
const first = 'MiniMax-M2.7', latest = 'MiniMax-M3';
const input: Message = { id: 'input', role: 'user', content: 'Continue', timestamp: new Date(0) };
const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
const events = (model: unknown, initial: unknown = { ...usage, output_tokens: 0 }, delta: unknown = { output_tokens: 2 }) => [
  { type: 'message_start', message: { type: 'message', id: 'message-1', model, usage: initial } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Re' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ady' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: delta }, { type: 'message_stop' },
];
function stream(response: ServerResponse, values: unknown[]): void {
  response.setHeader('content-type', 'text/event-stream'); response.end(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
}
async function fixture(reply?: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ url: request.url, headers: request.headers, body });
    if (reply) { reply(body, response); return; }
    if (body.stream) stream(response, events(body.model));
    else response.end(JSON.stringify({ type: 'message', model: body.model, stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Re' }, { type: 'text', text: 'ady' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/owned%2Fminimax/anthropic` };
}

describe('native MiniMax private continuation', () => {
  it('binds the six physical profiles and complete replay arrays to fresh pinned SDK execution', () => {
    expect(createHash('sha256').update(continuationBytes).digest('hex')).toBe('6671155239d400520bb007617f1e014a244e5aa6331fe8d080081d70c747ad9b');
    expect(continuation).toMatchObject({ pinnedCommit: '06a466935536f8c9bcacb2d5efc0fc021be1bdff',
      captureSha256: '8e9fd562ef800e77ec18aee132198b53cbb44543c3a8894080966a264b3830d2', profiles: 6, replayProjections: 72, freshSdkRequests: 78 });
    expect(continuation.rows.map(row => [row.scope, row.model])).toEqual(['minimax', 'minimax-cn'].flatMap(scope => providers.MINIMAX_MODELS.map(row => [scope, row.id])));
  });

  it.each(continuation.rows)('$scope/$model captures and replays full owned JSON/SSE arrays without getter or response-label authority', async row => {
    let values = continuation.seedEvents;
    const { calls, baseUrl } = await fixture((body, response) => body.stream ? stream(response, values)
      : response.end(JSON.stringify({ type: 'message', role: 'assistant', model: 'untrusted-response-alias', stop_reason: 'tool_use', content: continuation.syntheticJsonContent, usage })));
    const owner = `owned-${row.scope}`, Constructor = row.scope === 'minimax' ? providers.MiniMaxProvider : providers.MiniMaxCnProvider;
    const provider = new Constructor({ type: owner, apiKey: 'disposable', baseUrl, model: row.model });
    vi.spyOn(provider, 'getProviderType').mockReturnValue('foreign-getter');
    expect(row.cases.map(vector => vector.case)).toEqual(['same', 'foreign-provider', 'foreign-api', 'foreign-model', 'missing-api',
      'failed-error', 'failed-aborted', 'unsigned', 'empty-thinking', 'blank-thinking', 'empty-signature', 'blank-signature']);
    for (const binary of [false, true]) {
      const initial: Message[] = [{ ...input, content: 'probe' }], options: providers.ChatOptions = { model: row.model, maxTokens: 64, cacheRetention: 'none', tools: structuredClone(continuation.tools) };
      let result: providers.ChatResponse | undefined; const callbacks: unknown[] = [];
      if (binary) await provider.streamChat(initial, (text, event) => { callbacks.push({ text, event }); }, value => { result = value; }, error => { throw error; }, options);
      else result = await provider.chat(initial, options);
      expect(result).toMatchObject({ content: 'left!right?', reasoning: 'firstsecond', provider: owner, model: row.model, api: row.api,
        toolCalls: [{ id: 'call', name: 'echo', input: { x: 1 } }] });
      expect(result?.blocks).toEqual(continuation.expectedBlocks); expect(JSON.stringify(callbacks)).not.toContain('opaque-');
      for (const vector of row.cases) {
        const assistant: Message = { id: 'a', role: 'assistant', content: result!.content, timestamp: new Date(1), provider: result!.provider,
          model: result!.model, api: result!.api, blocks: structuredClone(result!.blocks), toolCalls: structuredClone(result!.toolCalls) };
        if (vector.case === 'foreign-provider') assistant.provider = row.scope === 'minimax' ? 'owned-minimax-cn' : 'owned-minimax';
        if (vector.case === 'foreign-api') assistant.api = 'foreign-api';
        if (vector.case === 'foreign-model') assistant.model = row.model === first ? latest : first;
        if (vector.case === 'missing-api') delete assistant.api;
        if (vector.case.startsWith('failed-')) assistant.metadata = { outputError: true };
        const thought = assistant.blocks![1]; if (thought.type !== 'reasoning') throw new Error('Expected reference thinking block.');
        if (vector.case === 'unsigned') delete thought.thinkingSignature;
        if (vector.case === 'empty-thinking') thought.text = '';
        if (vector.case === 'blank-thinking') thought.text = ' \t';
        if (vector.case === 'empty-signature') thought.thinkingSignature = '';
        if (vector.case === 'blank-signature') thought.thinkingSignature = ' \t';
        const history: Message[] = [...initial, assistant, ...(vector.case.startsWith('failed-') ? [] : [
          { id: 't', role: 'tool' as const, content: 'result', toolCallId: 'call', timestamp: new Date(2) }]),
          { id: 'u2', role: 'user', content: 'continue', timestamp: new Date(3) }];
        const before = structuredClone({ history, options });
        if (binary) await provider.streamChat(history, () => {}, () => {}, error => { throw error; }, options);
        else await provider.chat(history, options);
        expect(calls.at(-1)!.body.messages, vector.case).toEqual(vector.expectedMessages);
        expect({ history, options }).toEqual(before);
      }
    }
    expect(calls).toHaveLength(26);
    values = structuredClone(continuation.seedEvents);
    (values[0] as { message: { content: unknown[] } }).message.content = structuredClone(continuation.syntheticJsonContent);
    const headerCallbacks: unknown[] = [], complete = vi.fn();
    await provider.streamChat([{ ...input, content: 'probe' }], (text, event) => { headerCallbacks.push({ text, event }); }, complete,
      error => { throw error; }, { model: row.model, maxTokens: 64, cacheRetention: 'none', tools: structuredClone(continuation.tools) });
    expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0].blocks).toEqual(continuation.expectedBlocks);
    expect(JSON.stringify(headerCallbacks)).not.toContain('opaque-'); expect(calls).toHaveLength(27);
    for (const call of calls) {
      expect(call.url).toBe('/owned%2Fminimax/anthropic/v1/messages'); expect(call.headers['x-api-key']).toBe('disposable');
      expect(call.headers.authorization).toBeUndefined(); expect(call.body.model).toBe(row.model); expect(call.body.max_tokens).toBe(64);
    }
  });

  it.each(continuation.rows.flatMap(row => [false, true].map(useStream => ({ ...row, useStream }))))(
    '$scope/$model persists both append paths, private reload/edit/clone/compaction and physical replay (stream=$useStream)', async row => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-minimax-replay-')), secret = 'disposable-session-key';
      const redactor = new CredentialRedactor([secret]), redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const native = (structuredClone(continuation.syntheticJsonContent) as Array<Record<string, unknown>>).map(block => block.type === 'thinking'
        ? { ...block, signature: `${block.signature}-${secret}` } : block.type === 'redacted_thinking' ? { ...block, data: `${block.data}-${secret}` } : block);
      const seed = structuredClone(continuation.seedEvents) as Array<{ type: string; index?: number; content_block?: Record<string, unknown>; delta?: Record<string, unknown> }>;
      for (let index = 0; index < seed.length; index++) {
        const event = seed[index];
        if (event.content_block?.type === 'redacted_thinking') event.content_block.data = `${event.content_block.data}-${secret}`;
        if (event.delta?.type === 'signature_delta' && seed[index + 1]?.type === 'content_block_stop') event.delta.signature = `${event.delta.signature}-${secret}`;
      }
      let turn = 0, effects = 0;
      const { calls, baseUrl } = await fixture((body, response) => {
        const firstTurn = turn++ === 0, content = firstTurn ? native : native.filter(block => block.type !== 'tool_use');
        const values = seed.filter(event => firstTurn || event.index !== 5).map(event => event.type === 'message_delta'
          ? { ...event, delta: { stop_reason: firstTurn ? 'tool_use' : 'end_turn' } } : event);
        if (body.stream) stream(response, values);
        else response.end(JSON.stringify({ type: 'message', role: 'assistant', model: 'untrusted-response-alias', content,
          stop_reason: firstTurn ? 'tool_use' : 'end_turn', usage }));
      });
      const owner = `owned-${row.scope}`, Constructor = row.scope === 'minimax' ? providers.MiniMaxProvider : providers.MiniMaxCnProvider;
      const provider = new Constructor({ type: owner, model: row.model, apiKey: secret, baseUrl }), registry = new ExtensionRegistry();
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), options: providers.ChatOptions = {
        model: row.model, maxTokens: 64, cacheRetention: 'none', tools: structuredClone(continuation.tools) };
      const call = async (messages: Message[], target: providers.AiProvider = provider, extra: providers.ChatOptions = {}): Promise<providers.ChatResponse> => {
        if (!row.useStream) return target.chat(messages, { ...options, ...extra });
        let result: providers.ChatResponse | undefined;
        await target.streamChat(messages, () => {}, response => { result = response; }, error => { throw error; }, { ...options, ...extra });
        if (!result) throw new Error('Missing MiniMax completion.'); return result;
      };
      try {
        const session = await manager.create({ title: 'Private MiniMax continuation' });
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: async () => { effects++; return { content: 'result' }; } }));
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: owner,
          tools: options.tools!, redactText, toolContext: { sessionManager: manager, notify: () => {} }, streamTurn: messages => row.useStream
            ? streamProviderTurn({ provider, providerName: owner, ...options, messages, tools: options.tools!, extensionRegistry: registry,
              sessionManager: manager, sessionId: session.id, cacheWarming: 'off', maxRetries: 0, redactText, redactJson,
              createTextRedactor: () => redactor.createStream() }) : call(messages) });
        const history = session.messages.filter(message => message.role === 'assistant'), expected = continuation.expectedBlocks.map(block => block.type === 'reasoning'
          ? { ...block, thinkingSignature: `${block.thinkingSignature}-[REDACTED]` } : block);
        expect(effects).toBe(1); expect(history.map(message => message.blocks)).toEqual([expected, expected.slice(0, -1)]);
        expect(history.map(message => [message.provider, message.model, message.api])).toEqual(Array.from({ length: 2 }, () => [owner, row.model, row.api]));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8');
        expect((await stat(file)).mode & 0o777).toBe(0o600); expect(bytes).not.toContain(secret); expect(bytes).toContain('opaque-redacted-[REDACTED]');
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        const imported = deserializeSession(JSON.parse(JSON.stringify(serializeSession(loaded))));
        expect(imported.messages.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([expected, expected.slice(0, -1)]);
        const publicExport = serializeSessionForExport(loaded), completeExport = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(publicExport.warning).toContain('Native continuation'); expect(JSON.stringify(publicExport.session)).not.toContain('opaque-');
        expect(completeExport.warning).toBeUndefined(); expect(JSON.stringify(completeExport.session)).not.toContain(secret);
        expect(JSON.stringify(completeExport.session)).toContain('opaque-redacted-[REDACTED]');
        const nativeRedacted = native.map(block => block.type === 'thinking' ? { ...block, signature: redactText(String(block.signature)) }
          : block.type === 'redacted_thinking' ? { ...block, data: redactText(String(block.data)) } : block);
        const assistantArrays = () => (calls.at(-1)!.body.messages as Array<{ role: string; content: unknown }>).filter(message => message.role === 'assistant').map(message => message.content);
        imported.messages.push({ ...input, id: 'continue', content: 'continue' });
        await call(imported.messages); expect(assistantArrays()).toEqual([nativeRedacted, nativeRedacted.slice(0, -1)]);
        expect(await readFile(file, 'utf8')).toBe(bytes);
        const foreign = [{ type: 'text', text: 'left!' }, { type: 'text', text: 'firstsecond' }, { type: 'text', text: 'right?' }, native.at(-1)!];
        await call(imported.messages, new Constructor({ type: 'foreign-target', model: row.model, apiKey: secret, baseUrl }));
        expect(assistantArrays()).toEqual([foreign, foreign.slice(0, -1)]);
        const nextModel = row.model === first ? latest : first;
        registry.virtualModels.register({ provider: 'router', id: 'auto', maxOutputTokens: 64, route: () => ({ provider: owner, id: nextModel }) });
        const routed = await streamProviderTurn({ provider: registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto', messages: imported.messages,
          tools: [], extensionRegistry: registry, resolveProvider: name => name === owner ? provider : undefined, maxRetries: 0, cacheRetention: 'none' });
        expect(routed.model).toBe(nextModel); expect(routed.selection).toMatchObject({ provider: 'router', id: 'auto' });
        expect(assistantArrays()).toEqual([foreign, foreign.slice(0, -1)]);
        await restarted.appendContextEdit(session.id, { targetEntryId: history[0].id, replacement: 'edited answer' });
        const clone = await restarted.cloneSession(session.id), canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-|firstsecond/); expect(canonical).toEqual(beforeSummary);
        await call(canonical); expect(assistantArrays()).toEqual([[native.at(-1)!, { type: 'text', text: 'edited answer' }], nativeRedacted.slice(0, -1)]);
        const sourceBytes = await readFile(file, 'utf8'), cloneRaw = await restarted.getRawEntries(clone.id);
        const cloneAssistants = clone.messages.filter(message => message.role === 'assistant'), kept = cloneAssistants.at(-1)!;
        expect(cloneAssistants.map(message => message.blocks)).toEqual([expected, expected.slice(0, -1)]);
        await restarted.applyCompaction(clone.id, 'PUBLIC_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
        await compactedManager.loadFromStore(clone.id);
        const compacted = getCompactionModelMessages(compactedManager, clone.id), raw = await compactedManager.getRawEntries(clone.id);
        expect(compacted.filter(message => message.role === 'assistant').map(message => message.blocks)).toEqual([expected.slice(0, -1)]);
        expect(compacted.filter(message => message.role === 'tool')).toEqual([]);
        const entries = raw.filter(entry => entry.type !== 'metadata');
        expect(entries.slice(0, -1)).toEqual(cloneRaw.filter(entry => entry.type !== 'metadata'));
        expect(entries.at(-1)).toMatchObject({ type: 'compaction', firstKeptEntryId: kept.id });
        const rawMessages = raw.filter(entry => entry.type === 'message');
        expect(cloneAssistants.map(message => rawMessages.find(entry => entry.id === message.id)?.blocks)).toEqual([expected, expected.slice(0, -1)]);
        const cloneFile = path.join(root, clone.id + '.jsonl'), cloneBytes = await readFile(cloneFile, 'utf8');
        expect((await stat(cloneFile)).mode & 0o777).toBe(0o600);
        await call(compacted, provider, { systemPrompt: 'TRUSTED_SYSTEM_PREFIX' });
        expect(calls.at(-1)!.body.system).toEqual([{ type: 'text', text: 'TRUSTED_SYSTEM_PREFIX\n\n[Context Summary] PUBLIC_COMPACTED_PREFIX' }]);
        expect(assistantArrays()).toEqual([nativeRedacted.slice(0, -1)]);
        expect(await readFile(cloneFile, 'utf8')).toBe(cloneBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes);
        expect(calls).toHaveLength(7); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    });
});

describe('native MiniMax simple allocation', () => {
  it('binds all scalar vectors to the retained independent SDK capture without rewriting unsafe allocations', () => {
    expect(createHash('sha256').update(numericBytes).digest('hex')).toBe('53f3b8ad65cadd59b084b14da965f9e73ea40676240579d8f8ccff067f63fbb2');
    expect(numeric).toMatchObject({ pinnedCommit: '06a466935536f8c9bcacb2d5efc0fc021be1bdff', originalSdkRequests: 102, newSdkRequests: 0,
      captureSha256: '7f195456c402f7d528fe862fbee603eda354564baa50a3e266f6fcc0a8076136' });
    expect(numeric.vectors).toHaveLength(102);
  });

  it.each(['minimax', 'minimax-cn'].flatMap(scope => providers.MINIMAX_MODELS.map(profile => ({ scope, model: profile.id }))))(
    '$scope/$model matches safe SDK allocations on both facades and preflight without double expansion', async ({ scope, model }) => {
      const { calls, baseUrl } = await fixture();
      const Provider = scope === 'minimax' ? providers.MiniMaxProvider : providers.MiniMaxCnProvider;
      const provider = new Provider({ type: scope, apiKey: 'disposable', model, baseUrl });
      const prepare = captureNativeOutputBudget(provider)!, vectors = numeric.vectors.filter(row => row.scope === scope && row.model === model);
      expect(vectors).toHaveLength(17);
      for (const vector of vectors) {
        const { reasoning, ...logical } = vector.logicalOptions;
        const options: providers.ChatOptions = { ...logical, ...(reasoning === undefined ? {} : { thinking: reasoning }), cacheRetention: 'none' };
        const messages: Message[] = [{ ...input, content: vector.context === 'small' ? 'probe' : 'x'.repeat(vector.characters) }];
        const before = JSON.stringify({ messages, options }), count = calls.length, budget = vector.expected.thinking.budget_tokens;
        const unsafe = budget !== undefined && (budget < 1024 || vector.expected.maxTokens - budget < 1024);
        if (unsafe) {
          expect(['low-map1', 'exhausted-context-high']).toContain(vector.id);
          expect(() => prepare(options, messages)).toThrow('Provider native output policy is invalid.');
          await expect(provider.chat(messages, options)).rejects.toThrow('Invalid MiniMax thinking allocation.');
          await expect(provider.streamChat(messages, () => {}, undefined, error => { throw error; }, options)).rejects.toThrow('Invalid MiniMax thinking allocation.');
          expect(calls).toHaveLength(count);
        } else {
          const prepared = prepare(options, messages);
          await provider.chat(messages, prepared.options);
          await provider.streamChat(messages, () => {}, undefined, error => { throw error; }, prepared.options);
          for (const call of calls.slice(count)) {
            expect({ maxTokens: call.body.max_tokens, thinking: call.body.thinking }, vector.id).toEqual(vector.expected);
            expect(call.body.model).toBe(model); expect(call.body.messages).toEqual([{ role: 'user', content: messages[0].content }]);
            expect(call.headers['x-api-key']).toBe('disposable'); expect(call.headers.authorization).toBeUndefined();
            expect(call.headers['anthropic-version']).toBe('2023-06-01');
            expect(call.headers['anthropic-beta']).toBe(budget === undefined ? undefined : 'interleaved-thinking-2025-05-14');
          }
          expect(calls).toHaveLength(count + 2); expect(prepared.maxTokens).toBe(vector.expected.maxTokens);
          if (options.maxTokens !== undefined) expect(prepared.options.maxTokens).toBe(options.maxTokens);
        }
        expect(JSON.stringify({ messages, options })).toBe(before);
      }
      expect(calls).toHaveLength(30);
    });
});

describe('explicit native MiniMax A SDK', () => {
  it('keeps generic Anthropic defaults distinct from a MiniMax-looking alias and URL', async () => {
    const { calls, baseUrl } = await fixture();
    await new providers.AnthropicProvider({ type: 'minimax', apiKey: 'disposable', model: first, baseUrl }).chat([input]);
    expect(calls[0].body.max_tokens).toBe(1024); expect(calls[0].body.thinking).toBeUndefined();
  });

  it('owns three immutable profiles, metadata, caps and configured-only classifiers without discovery or ambient keys', async () => {
    const { calls, baseUrl } = await fixture(); vi.stubEnv('MINIMAX_API_KEY', 'not-authorized');
    const provider = new providers.MiniMaxProvider({ type: 'azure', apiKey: 'disposable', baseUrl });
    expect(providers.MINIMAX_MODELS).toHaveLength(3); expect(Object.isFrozen(providers.MINIMAX_MODELS)).toBe(true);
    expect(providers.ProviderFactory.has('minimax')).toBe(false); expect(provider.canDiscoverModels()).toBe(false);
    expect(await provider.getAvailableModels()).toEqual([first, 'MiniMax-M2.7-highspeed', latest]);
    for (const profile of providers.MINIMAX_MODELS) {
      expect(Object.isFrozen(profile) && Object.isFrozen(profile.declaredInput) && Object.isFrozen(profile.pricing)).toBe(true);
      for (const tier of profile.declaredPricing.tiers ?? []) expect(Object.isFrozen(tier)).toBe(true);
      const row = getProviderPublishedModel('azure', profile.id, provider)!;
      expect(row).toMatchObject({ id: profile.id, api: 'anthropic-messages', contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
        capabilities: { reasoning: true, imageInput: profile.id === latest, toolCalls: true } });
      row.contextWindow = 1; row.pricing!.inputPerMillion = 99;
      expect(getProviderPublishedModel('azure', profile.id, provider)?.pricing?.inputPerMillion).toBe(profile.pricing.inputPerMillion);
      expect(getSupportedThinkingLevels('azure', profile.id, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    }
    expect(getProviderPublishedModel('azure', 'claude-sonnet-4-6', provider)).toBeUndefined();
    const captured = captureNativeOutputBudget(provider)!; provider.setConfiguredModel(latest);
    expect(captured({}).maxTokens).toBe(131072); expect(captureNativeOutputBudget(provider)!({}).maxTokens).toBe(512000);
    expect(provider.getSpecializedModels()).toMatchObject([{ model: latest, type: 'classifier', virtual: true, api: 'anthropic-messages', imageInput: true }]);
    await expect(new providers.MiniMaxProvider({ type: 'minimax', baseUrl }).chat([input])).rejects.toThrow('MiniMax API key is required.');
    expect(calls).toHaveLength(0);
  });

  it('dispatches every native profile over JSON/SSE with physical A auth, budgets and disjoint priced usage', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.MiniMaxProvider({ type: 'nvidia', apiKey: 'disposable', baseUrl });
    for (const profile of providers.MINIMAX_MODELS) for (const thinking of ['off', 'high'] as const) {
      const options = { model: profile.id, thinking, temperature: 0.25, systemPrompt: 'System', sessionId: 'not-openrouter',
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] };
      const costUsd = (5 * profile.pricing.inputPerMillion + 2 * profile.pricing.outputPerMillion + 4 * profile.pricing.cacheReadPerMillion + profile.pricing.cacheWritePerMillion) / 1000000;
      expect(await provider.chat([input], options)).toMatchObject({ content: 'Ready', reasoning: 'Plan', provider: 'nvidia', api: 'anthropic-messages',
        usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd } });
      const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; }, options);
      expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject({ content: 'Ready', reasoning: 'Plan', api: 'anthropic-messages', usage: { totalTokens: 12, costUsd } });
      for (const call of calls.slice(-2)) {
        expect(call.url).toBe('/owned%2Fminimax/anthropic/v1/messages');
        expect(call.headers['x-api-key']).toBe('disposable'); expect(call.headers['anthropic-version']).toBe('2023-06-01');
        for (const name of ['authorization', 'api-key', 'nvcf-poll-seconds', 'x-session-id']) expect(call.headers[name]).toBeUndefined();
        expect(call.headers['anthropic-beta']).toBe(thinking === 'off' ? undefined : 'interleaved-thinking-2025-05-14');
        expect(call.body).toMatchObject({ model: profile.id, max_tokens: profile.maxOutputTokens,
          thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 16384, display: 'summarized' },
          system: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }],
          tools: [{ name: 'read', eager_input_streaming: true, input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] });
        for (const key of ['output_config', 'reasoning_effort', 'store', 'tool_stream']) expect(call.body).not.toHaveProperty(key);
        if (thinking === 'high') expect(call.body).not.toHaveProperty('temperature'); else expect(call.body.temperature).toBe(0.25);
      }
    }
    expect(calls).toHaveLength(12);
  });

  it('keeps canonical plain reasoning, tools, image admission and three cache modes physically owned', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl, model: latest });
    const history: Message[] = [{ ...input, role: 'assistant', content: 'Earlier', blocks: [{ type: 'reasoning', text: 'Earlier plan' }], toolCalls: [{ id: 'read-1', name: 'read', input: {} }] }, input];
    for (const cacheRetention of ['none', 'short', 'long'] as const) {
      await provider.chat(history, { cacheRetention, systemPrompt: 'System', tools: [{ name: 'first', description: 'First', parameters: {} }, { name: 'last', description: 'Last', parameters: {} }] });
      const body = calls.at(-1)!.body, control = cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(cacheRetention === 'long' ? { ttl: '1h' } : {}) };
      expect((body.messages as Array<{ content: unknown }>)[0].content).toEqual([{ type: 'text', text: 'Earlier plan' }, { type: 'text', text: 'Earlier' }, { type: 'tool_use', id: 'read-1', name: 'read', input: {} }]);
      expect((body.system as Array<Record<string, unknown>>)[0].cache_control).toEqual(control);
      const tools = body.tools as Array<Record<string, unknown>>; expect(tools[0].cache_control).toBeUndefined(); expect(tools[1].cache_control).toEqual(control);
      expect(tools.every(tool => tool.eager_input_streaming === true && !('strict' in tool))).toBe(true);
    }
    expect(history[0].content).toBe('Earlier');
    const image: Message = { ...input, blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] };
    await provider.chat([image]); expect((calls.at(-1)!.body.messages as unknown[])[0]).toMatchObject({ content: [{ type: 'text' }, { type: 'image', source: { media_type: 'image/png', data: 'aGVsbG8=' } }] });
    await expect(provider.chat([image], { model: first })).rejects.toThrow('MiniMax chat model does not support images.');
  });

  it('uses pinned numeric level defaults, inert overrides and expanded simple output allocations', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const [thinking, budget] of [['minimal', 1024], ['low', 2048], ['medium', 8192], ['high', 16384], ['xhigh', 16384], ['max', 16384]] as const) {
      await provider.chat([input], { thinking }); expect(calls.at(-1)!.body.thinking).toMatchObject({ budget_tokens: budget });
    }
    await provider.chat([input], { thinking: 'high', thinkingBudgets: { high: 4096 }, maxTokens: 10000 });
    expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 14096, thinking: { budget_tokens: 4096 } });
    await provider.chat([input], { thinking: 'high', maxTokens: 4096 }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 20480, thinking: { budget_tokens: 16384 } });
    await provider.chat([input], { thinking: 'high', maxTokens: 1024 }); expect(calls.at(-1)!.body).toMatchObject({ max_tokens: 17408, thinking: { budget_tokens: 16384 } });
    const getter = vi.fn(() => 9999), opaque = Object.defineProperty({}, 'high', { get: getter });
    await provider.chat([input], { thinking: 'off', thinkingBudgets: opaque }); expect(getter).not.toHaveBeenCalled();
    await expect(provider.chat([input], { thinking: 'high', thinkingBudgets: opaque })).rejects.toThrow('MiniMax chat request failed.'); expect(getter).not.toHaveBeenCalled();
  });

  it('accounts gross-input M3 thresholds, observed 1h writes and nullable partial SSE without forged usage', async () => {
    let current: unknown = usage, delta: unknown = { output_tokens: 2 };
    const { baseUrl } = await fixture((body, response) => body.stream ? stream(response, events(body.model, current, delta))
      : response.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage: current })));
    const provider = new providers.MiniMaxProvider({ type: 'anthropic', apiKey: 'disposable', baseUrl, model: latest });
    const profile = providers.MINIMAX_MODELS.find(p => p.id === latest)!;
    for (const above of [false, true]) {
      const inputTokens = 512000 - 5 + Number(above), rates = above ? profile.pricing.tiers![0] : profile.pricing;
      current = { ...usage, input_tokens: inputTokens }; expect((await provider.chat([input])).usage?.costUsd).toBe((inputTokens * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1000000);
    }
    current = { ...usage, cache_creation: { ephemeral_1h_input_tokens: 1 } }; delta = { input_tokens: null, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: null } };
    const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; });
    expect(complete.mock.calls[0][0].usage).toEqual({ promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12, costUsd: (5 * 0.3 + 2 * 1.2 + 4 * 0.06 + 0.6) / 1000000 });
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 }, { ...usage, cache_read_input_tokens: null }, { ...usage, cache_creation: { ephemeral_1h_input_tokens: 2 } }]) {
      current = invalid; expect((await provider.chat([input])).usage).toBeUndefined();
    }
  });

  it('gates missing finishes, trailing output and unowned opaque signatures before tools or success and keeps remote failures private', async () => {
    let values: unknown[] = [], json: unknown;
    const { baseUrl } = await fixture((body, response) => body.stream ? stream(response, values) : response.end(JSON.stringify(json)));
    const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const tool = [{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'read', input: {} } }, { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }];
    for (const malformed of [[...events(first).slice(0, -2), ...tool], [...events(first), { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'LATE' } }],
      [events(first)[0], { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'secret-remote-value' } }]]) {
      values = malformed; const complete = vi.fn(), chunks: unknown[] = [];
      await expect(provider.streamChat([input], (text, event) => { chunks.push({ text, type: event?.type }); }, complete)).rejects.toThrow(/MiniMax/);
      expect(complete).not.toHaveBeenCalled(); expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'tool_call' })); expect(JSON.stringify(chunks)).not.toContain('LATE');
    }
    json = { error: { message: 'secret-remote-value' } }; await expect(provider.chat([input])).rejects.toThrow('Invalid MiniMax chat response.');
    json = { model: first, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Plan', signature: 17 }] };
    await expect(provider.chat([input])).rejects.toThrow('Unsupported MiniMax reasoning replay.');
    json = { model: first, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Plan', signature: 'secret-remote-value' }] };
    class DerivedGlobal extends providers.MiniMaxProvider {}
    class DerivedCn extends providers.MiniMaxCnProvider {}
    values = continuation.seedEvents;
    for (const Constructor of [DerivedGlobal, DerivedCn]) {
      const derived = new Constructor({ type: 'minimax', apiKey: 'disposable', baseUrl, model: first });
      await expect(derived.chat([input])).rejects.toThrow('Unsupported MiniMax reasoning replay.');
      const complete = vi.fn(), chunks: unknown[] = [];
      await expect(derived.streamChat([input], (text, event) => { chunks.push({ text, event }); }, complete)).rejects.toThrow(/MiniMax/);
      expect(complete).not.toHaveBeenCalled(); expect(JSON.stringify(chunks)).not.toContain('opaque-');
      expect(chunks).not.toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'tool_call' }) }));
    }
  });

  it('awaits withdrawal and suppresses buffered text, tools and completion', async () => {
    const { baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    const controller = new AbortController(), chunks: string[] = [], complete = vi.fn();
    await expect(provider.streamChat([input], async text => { if (!text) return; chunks.push(text); await Promise.resolve(); controller.abort(); }, complete, undefined,
      { signal: controller.signal })).rejects.toThrow('MiniMax request aborted.');
    expect(chunks).toEqual(['Re']); expect(complete).not.toHaveBeenCalled();
  });

  it('captures physical A pricing and provenance before callback configuration mutation', async () => {
    const { baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'azure', apiKey: 'disposable', baseUrl, model: first });
    const complete = vi.fn(); await provider.streamChat([input], text => { if (text) provider.setConfiguredModel('MiniMax-M2.7-highspeed'); }, complete, error => { throw error; });
    expect(complete.mock.calls[0][0]).toMatchObject({ model: first, provider: 'azure', api: 'anthropic-messages', usage: { costUsd: (5 * 0.3 + 2 * 1.2 + 4 * 0.06 + 0.375) / 1000000 } });
  });

  it('refuses unknown models, output/image/header/endpoint inputs before I/O without borrowing foreign profiles', async () => {
    const { calls, baseUrl } = await fixture(); const provider = new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl });
    for (const model of ['future/private', 'claude-sonnet-4-6']) await expect(provider.chat([input], { model })).rejects.toThrow('MiniMax chat model is not supported.');
    expect(() => provider.setConfiguredModel('future/private')).toThrow('MiniMax chat model is not supported.'); expect(provider.getConfiguredModel()).toBe(first);
    for (const maxTokens of [0, -1, 0.5, 131073]) await expect(provider.chat([input], { maxTokens })).rejects.toThrow('Invalid MiniMax output limit.');
    await expect(provider.chat([input], { thinking: 'high', thinkingBudgets: { high: 0 }, maxTokens: 1024 })).rejects.toThrow('Invalid MiniMax thinking allocation.');
    await expect(new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl, customHeaders: { 'X-Test': 'secret\nvalue' } }).chat([input])).rejects.toThrow('Invalid MiniMax request headers.');
    for (const endpoint of ['ftp://example.test', 'https://key:secret@example.test', 'https://example.test?secret=1', 'https://example.test#secret']) expect(() => new providers.MiniMaxProvider({ type: 'operator', apiKey: 'disposable', baseUrl: endpoint })).toThrow('Invalid MiniMax endpoint.');
    expect(calls).toHaveLength(0);
  });
});

describe('explicit native MiniMax CN A SDK', () => {
  it('owns the reviewed immutable CN declarations without factory, foreign metadata or ambient authentication', async () => {
    const { calls, baseUrl } = await fixture();
    vi.stubEnv('MINIMAX_CN_API_KEY', 'not-authorized-cn'); vi.stubEnv('MINIMAX_API_KEY', 'not-authorized-global');
    const provider = new providers.MiniMaxCnProvider({ type: 'google', apiKey: 'disposable', baseUrl });
    expect(providers.MINIMAX_CN_MODELS).toBe(providers.MINIMAX_MODELS);
    expect(providers.MINIMAX_CN_MODELS).toHaveLength(3); expect(Object.isFrozen(providers.MINIMAX_CN_MODELS)).toBe(true);
    expect(providers.ProviderFactory.has('minimax-cn')).toBe(false); expect(provider.canDiscoverModels()).toBe(false);
    expect(await provider.getAvailableModels()).toEqual([first, 'MiniMax-M2.7-highspeed', latest]);
    for (const profile of providers.MINIMAX_CN_MODELS) {
      expect(getProviderPublishedModel('google', profile.id, provider)).toMatchObject({ id: profile.id, api: 'anthropic-messages',
        contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens,
        pricing: { inputPerMillion: profile.pricing.inputPerMillion, outputPerMillion: profile.pricing.outputPerMillion,
          cacheReadPerMillion: profile.pricing.cacheReadPerMillion, cacheWritePerMillion: profile.pricing.cacheWritePerMillion },
        capabilities: { reasoning: true, imageInput: profile.id === latest, toolCalls: true } });
      expect(getSupportedThinkingLevels('google', profile.id, undefined, provider)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    }
    expect(getProviderPublishedModel('google', 'gemini-2.5-pro', provider)).toBeUndefined();
    expect(provider.getSpecializedModels()).toMatchObject([{ model: first, type: 'classifier', virtual: true, api: 'anthropic-messages' }]);
    await expect(new providers.MiniMaxCnProvider({ type: 'minimax-cn', baseUrl }).chat([input])).rejects.toThrow('MiniMax API key is required.');
    expect(() => provider.setConfiguredModel('foreign')).toThrow('MiniMax chat model is not supported.'); expect(calls).toHaveLength(0);
  });

  it('dispatches all CN profiles over JSON and SSE with the inherited native policies and captured physical accounting', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.MiniMaxCnProvider({ type: 'minimax', apiKey: 'disposable-cn', baseUrl });
    for (const profile of providers.MINIMAX_CN_MODELS) for (const thinking of ['off', 'high'] as const) {
      const options = { model: profile.id, thinking, maxTokens: 32768, cacheRetention: 'long' as const, systemPrompt: 'CN system',
        tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] };
      const expected = { content: 'Ready', reasoning: 'Plan', model: profile.id, provider: 'minimax', api: 'anthropic-messages',
        usage: { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
          costUsd: (5 * profile.pricing.inputPerMillion + 2 * profile.pricing.outputPerMillion + 4 * profile.pricing.cacheReadPerMillion + profile.pricing.cacheWritePerMillion) / 1000000 } };
      expect(await provider.chat([input], options)).toMatchObject(expected);
      const complete = vi.fn(); await provider.streamChat([input], () => {}, complete, error => { throw error; }, options);
      expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject(expected);
      for (const call of calls.slice(-2)) {
        expect(call.url).toBe('/owned%2Fminimax/anthropic/v1/messages'); expect(call.headers['x-api-key']).toBe('disposable-cn');
        expect(call.headers.authorization).toBeUndefined(); expect(call.headers['anthropic-version']).toBe('2023-06-01');
        expect(call.body).toMatchObject({ model: profile.id, max_tokens: thinking === 'off' ? 32768 : 49152,
          thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 16384, display: 'summarized' },
          system: [{ type: 'text', text: 'CN system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
          tools: [{ eager_input_streaming: true, input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } }] });
        expect((call.body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty('strict');
      }
    }
    expect(calls).toHaveLength(12);
  });

  it('uses only the explicit constructor to select the CN default endpoint, retaining the global endpoint and safe configured prefixes', async () => {
    const hits: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      hits.push(url instanceof Request ? url.url : String(url));
      return new Response(JSON.stringify({ type: 'message', model: first, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage }));
    }));
    try {
      await new providers.MiniMaxCnProvider({ type: 'minimax', apiKey: 'disposable' }).chat([input]);
      await new providers.MiniMaxProvider({ type: 'minimax-cn', apiKey: 'disposable' }).chat([input]);
      await new providers.MiniMaxCnProvider({ type: 'operator', apiKey: 'disposable', baseUrl: 'https://proxy.invalid/owned%2Fcn/v1/messages/' }).chat([input]);
      expect(hits).toEqual(['https://api.minimaxi.com/anthropic/v1/messages', 'https://api.minimax.io/anthropic/v1/messages', 'https://proxy.invalid/owned%2Fcn/v1/messages']);
      for (const baseUrl of ['https://key:secret@proxy.invalid', 'https://proxy.invalid?key=secret', 'https://proxy.invalid#secret'])
        expect(() => new providers.MiniMaxCnProvider({ type: 'operator', apiKey: 'disposable', baseUrl })).toThrow('Invalid MiniMax endpoint.');
      expect(hits).toHaveLength(3);
    } finally { vi.unstubAllGlobals(); }
  });
});
