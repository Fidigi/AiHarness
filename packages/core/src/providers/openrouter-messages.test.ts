import { createServer, type Server } from 'node:http';
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
import type { Message } from '../types/index.js';
import * as providers from './index.js';

const continuation = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/openrouter-continuation-reference.json', import.meta.url), 'utf8'));
const continuationModels: string[] = continuation.rows.map((row: { model: string }) => row.model);

const model = 'anthropic/claude-sonnet-4.6';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(reply?: (body: Record<string, unknown>, response: import('node:http').ServerResponse) => void) {
  const calls: Array<{ url?: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (incoming, response) => {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const body = JSON.parse(text); calls.push({ url: incoming.url, headers: incoming.headers, body });
    if (reply) { reply(body, response); return; }
    const usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
    response.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (body.stream) {
      const events = [
        { type: 'message_start', message: { id: 'message-1', model: body.model, usage: { ...usage, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ready' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'read', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } else response.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Ready' }], usage }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy%2Fprefix/api/v1/messages` };
}

describe('native OpenRouter Anthropic Messages', () => {
  it.each(continuationModels)('compares independent whole private A arrays through both owning SDKs for %s', async model => {
    const reference = continuation.rows.find((row: { model: string }) => row.model === model);
    let responseEvents = continuation.seedEvents, responseContent = continuation.syntheticJsonContent, responseStop = 'tool_use';
    const { calls, baseUrl } = await fixture((body, response) => {
      response.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      if (body.stream) response.end(responseEvents.map((event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      else response.end(JSON.stringify({ model: 'untrusted-response-alias', stop_reason: responseStop, content: responseContent,
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } }));
    });
    for (const Provider of [providers.OpenRouterMessagesProvider, providers.OpenRouterProvider]) for (const facade of ['chat', 'stream']) {
      const provider = new Provider({ type: 'openrouter', model, apiKey: 'disposable-openrouter-private', baseUrl });
      const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
      const options = { model, thinking: 'low' as const, thinkingBudgets: { low: 2048 }, maxTokens: 4096, cacheRetention: 'none' as const,
        systemPrompt: 'owned OpenRouter reference system', tools: continuation.tools };
      const expected = (body: Record<string, unknown>) => ({ ...structuredClone(body), stream: facade === 'stream' });
      const invoke = async (messages: Message[], requestOptions: providers.ChatOptions = options) => {
        if (facade === 'chat') return provider.chat(messages, requestOptions);
        let complete: providers.ChatResponse | undefined;
        await provider.streamChat(messages, (text, event) => { expect(text).not.toContain('PRIVATE_OPENROUTER_HEADER'); expect(JSON.stringify(event ?? {})).not.toContain('PRIVATE_OPENROUTER_HEADER'); },
          response => { complete = response; }, error => { throw error; }, requestOptions);
        expect(complete).toBeDefined(); return complete!;
      };
      responseEvents = continuation.seedEvents.map((event: Record<string, any>) => event.type === 'message_start'
        ? { ...event, message: { ...event.message, content: [{ type: 'text', text: 'PRIVATE_OPENROUTER_HEADER' }] } } : event);
      responseContent = continuation.syntheticJsonContent; responseStop = 'tool_use';
      const first = await invoke([user]); expect(first).toMatchObject({ provider: 'openrouter', api: 'anthropic-messages', model, content: 'left!right?' });
      expect(first.blocks).toEqual(continuation.expectedBlocks); expect(first.providerThinkingLevel).toBe(reference.published.compat?.supportsMidConvoEffort ? 'low' : undefined); expect(first.toolCalls).toEqual([{ id: 'call', name: 'echo', input: { x: 1 } }]);
      expect(calls.at(-1)!.body).toEqual(expected(reference.expectedInitialBody));
      for (const projection of reference.cases) {
        const source: Message = { id: 'a', role: 'assistant', content: first.content, timestamp: new Date(0), provider: projection.source.provider,
          api: projection.source.api, model: projection.source.model, blocks: structuredClone(first.blocks), toolCalls: structuredClone(first.toolCalls),
          metadata: projection.source.providerThinkingLevel ? { providerThinkingLevel: projection.source.providerThinkingLevel } : undefined };
        const thought = source.blocks!.find(block => block.type === 'reasoning' && !block.redacted)!; expect(thought.type).toBe('reasoning'); if (thought.type !== 'reasoning') throw new Error('Missing reference thought');
        if (projection.case === 'unsigned') delete thought.thinkingSignature;
        if (projection.case === 'empty-thinking') thought.text = ''; if (projection.case === 'blank-thinking') thought.text = ' \t';
        if (projection.case === 'empty-signature') thought.thinkingSignature = ''; if (projection.case === 'blank-signature') thought.thinkingSignature = ' \t';
        if (projection.case.startsWith('failed-')) source.metadata = { ...source.metadata, outputError: 'Failed OpenRouter producer' };
        const results: Message[] = projection.case.startsWith('failed-') ? [] : [{ id: 'r', role: 'tool', name: 'echo', toolCallId: 'call', content: 'result', timestamp: new Date(0) }];
        const history = [user, source, ...results, { ...user, id: 'next', content: 'continue' }], before = structuredClone(history);
        responseEvents = projection.responseEvents; responseContent = [{ type: 'text', text: 'ok' }]; responseStop = 'end_turn';
        expect((await invoke(history)).content).toBe('ok'); expect(calls.at(-1)!.body).toEqual(expected(projection.expectedBody)); expect(history).toEqual(before);
      }
      const withSystem: Message[] = [{ id: 'sys', role: 'system', content: 'Leading system', timestamp: new Date(0) }, user], systemBefore = structuredClone(withSystem);
      await invoke(withSystem, { ...options, systemPrompt: undefined }); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'Leading system' }] });
      await invoke(withSystem); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), system: [{ type: 'text', text: 'owned OpenRouter reference system\n\nLeading system' }] }); expect(withSystem).toEqual(systemBefore);
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-openrouter-replay-')), redactor = new CredentialRedactor(['opaque-signature', 'disposable-openrouter-private']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'OpenRouter replay' }), registry = new ExtensionRegistry();
      let effects = 0; const finalContent = [{ type: 'text', text: 'ok' }];
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; responseEvents = reference.cases[0].responseEvents; responseContent = finalContent; responseStop = 'end_turn'; return { content: 'result' }; } }));
      responseEvents = continuation.seedEvents; responseContent = continuation.syntheticJsonContent; responseStop = 'tool_use';
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' });
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'openrouter', tools: continuation.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText,
          streamTurn: messages => facade === 'chat' ? provider.chat(messages, options) : streamProviderTurn({ provider, providerName: 'openrouter', model, messages,
            tools: continuation.tools, extensionRegistry: registry, maxRetries: 0, maxTokens: 4096, thinking: 'low', thinkingBudgets: { low: 2048 }, cacheRetention: 'none', redactText, redactJson,
            createTextRedactor: () => redactor.createStream() }) });
        expect(effects).toBe(1);
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8'), assistants = session.messages.filter(item => item.role === 'assistant');
        expect(assistants.map(item => item.blocks)).toEqual([redactJson(continuation.expectedBlocks), finalContent]);
        const managed = reference.published.compat?.supportsMidConvoEffort === true, level = managed ? 'low' : undefined;
        expect(assistants.map(item => item.metadata?.providerThinkingLevel)).toEqual([level, level]);
        expect(bytes).not.toContain('opaque-signature'); expect(bytes).not.toContain('disposable-openrouter-private'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
        expect(loaded.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(assistants.map(item => item.blocks));
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-'); expect(JSON.stringify(complete.session)).toContain('[REDACTED]'); expect(JSON.stringify(complete.session)).not.toContain('opaque-signature');
        const control = { role: 'system', content: [], output_config: { effort: 'low' } }, finalMessage = { role: 'assistant', content: finalContent };
        const prefix = reference.cases[0].expectedBody.messages.slice(0, managed ? -2 : -1), tail = [...(managed ? [control] : []), finalMessage, ...(managed ? [control] : [])];
        const loadedMessages = [...redactJson(prefix), ...tail];
        await invoke(loaded.messages); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: loadedMessages }); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: assistants[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!; expect(clone).toBeTruthy();
        const edited = getCompactionModelMessages(restarted, clone.id); expect(edited.filter(item => item.role === 'assistant').map(item => item.metadata?.providerThinkingLevel)).toEqual([undefined, level]);
        await invoke(edited);
        expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: [
          { role: 'user', content: 'probe' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'echo', input: { x: 1 } }, { type: 'text', text: 'edited answer' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result', is_error: false }] }, ...tail] });
        expect((await restarted.getRawEntries(session.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(assistants.map(item => item.blocks));
        expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual(assistants.map(item => item.blocks));
        expect(clone.messages.filter(item => item.role === 'assistant').map(item => item.metadata?.providerThinkingLevel)).toEqual([level, level]);
        const canonical = getCompactionModelMessages(restarted, clone.id), beforeSummary = structuredClone(canonical);
        expect(JSON.stringify(getSummaryModelMessages(canonical))).not.toMatch(/Signature|opaque-/); expect(canonical).toEqual(beforeSummary);
        const kept = clone.messages.filter(item => item.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_OPENROUTER_COMPACTED_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); expect(await compactedManager.loadFromStore(clone.id)).toBeTruthy();
        const compacted = getCompactionModelMessages(compactedManager, clone.id); expect(compacted.some(item => item.content.includes('PUBLIC_OPENROUTER_COMPACTED_PREFIX'))).toBe(true);
        expect(compacted.filter(item => item.role === 'assistant').map(item => item.blocks)).toEqual([finalContent]); expect(compacted.filter(item => item.role === 'tool')).toEqual([]);
        const compactedFile = path.join(root, clone.id + '.jsonl'), compactedBytes = await readFile(compactedFile, 'utf8'); expect((await stat(compactedFile)).mode & 0o777).toBe(0o600);
        expect((await compactedManager.getRawEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(assistants.map(item => item.blocks));
        await invoke(compacted); expect(calls.at(-1)!.body).toEqual({ ...expected(reference.expectedInitialBody), messages: tail,
          system: [{ type: 'text', text: 'owned OpenRouter reference system\n\n[Context Summary] PUBLIC_OPENROUTER_COMPACTED_PREFIX' }] });
        expect(await readFile(compactedFile, 'utf8')).toBe(compactedBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(80);
    for (const call of calls) {
      expect(call.url).toBe('/proxy%2Fprefix/api/v1/messages'); expect(call.headers['x-api-key']).toBe('disposable-openrouter-private');
      expect(call.headers.authorization).toBeUndefined(); expect(call.headers['anthropic-version']).toBe('2023-06-01');
      expect(call.headers['anthropic-beta']).toBe(reference.sdkBeta ?? undefined);
    }
  });

  it('owns sixteen A profiles without inheriting C/I/T or ambient account authority', async () => {
    expect(providers).toHaveProperty('OpenRouterMessagesProvider');
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', apiKey: 'disposable-router', model });
    expect(providers.OPENROUTER_MESSAGE_MODELS).toHaveLength(16);
    expect(Object.isFrozen(providers.OPENROUTER_MESSAGE_MODELS)).toBe(true);
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS) {
      expect(profile.api).toBe('anthropic-messages'); expect(profile.reasoning).toBe(true);
      expect(profile.declaredInput).toEqual(['text', 'image']); expect(profile.pricing).toBeDefined();
      expect(Object.isFrozen(profile)).toBe(true); expect(Object.isFrozen(profile.declaredInput)).toBe(true);
      expect(Object.isFrozen(profile.declaredPricing)).toBe(true);
    }
    expect(await provider.getAvailableModels()).toEqual(providers.OPENROUTER_MESSAGE_MODELS.map(profile => profile.id));
    expect(provider.canDiscoverModels()).toBe(false); expect(provider.getModelApi()).toBe('anthropic-messages');
    expect(provider.getSpecializedModels()).toMatchObject([{ type: 'classifier', virtual: true, api: 'anthropic-messages', model }]);
    expect(JSON.stringify(provider.getSpecializedModels())).not.toContain('disposable-router');
    await expect(provider.chat([], { model: 'openai/gpt-4o' })).rejects.toThrow('OpenRouter message model is not supported.');
    expect(() => provider.setConfiguredModel('future/unknown')).toThrow('OpenRouter message model is not supported.');
    expect(provider.getConfiguredModel()).toBe(model);
  });

  it('uses actual x-api-key A requests and adaptive effort independently of operator names', async () => {
    expect(providers).toHaveProperty('OpenRouterMessagesProvider');
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterMessagesProvider({ type: 'azure', apiKey: 'disposable-router', model, baseUrl });
    const messages = [{ id: 'user-1', role: 'user' as const, content: 'Read the file', timestamp: new Date() }];
    const options = { thinking: 'max' as const, maxTokens: 64, sessionId: 'session-1', temperature: 0.25,
      thinkingBudgets: { high: Number.MAX_SAFE_INTEGER }, systemPrompt: 'System probe',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }] };
    const usage = { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
      costUsd: (5 * 3 + 2 * 15 + 4 * 0.3 + 3.75) / 1_000_000 };
    expect(await provider.chat(messages, options)).toMatchObject({ api: 'anthropic-messages', content: 'Ready', reasoning: 'Plan', usage });
    const events: unknown[] = []; const complete = vi.fn();
    await provider.streamChat(messages, async (text, event) => { await Promise.resolve(); events.push({ text, type: event?.type }); }, complete,
      error => { throw error; }, options);
    expect(events.filter(event => (event as { type?: string }).type !== 'message_start')).toEqual([
      { text: '', type: 'reasoning_delta' }, { text: 'Ready', type: 'text_delta' }, { text: '', type: 'tool_call' },
    ]);
    expect(complete).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0]).toMatchObject({ api: 'anthropic-messages', content: 'Ready', reasoning: 'Plan', usage,
      toolCalls: [{ id: 'read-1', name: 'read', input: { path: 'README.md' } }] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('/proxy%2Fprefix/api/v1/messages');
      expect(call.headers['x-api-key']).toBe('disposable-router'); expect(call.headers.authorization).toBeUndefined();
      expect(call.headers['anthropic-version']).toBe('2023-06-01'); expect(call.headers['x-session-id']).toBe('session-1');
      expect(call.body).toMatchObject({ model, max_tokens: 64, thinking: { type: 'adaptive' }, output_config: { effort: 'max' }, system: [{ type: 'text', text: 'System probe', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] });
      expect(call.body).not.toHaveProperty('temperature'); expect(call.body).not.toHaveProperty('reasoning');
      expect(call.body).not.toHaveProperty('reasoning_effort');
    }
    for (const cacheRetention of ['none', 'short', 'long'] as const) {
      await provider.chat(messages, { ...options, cacheRetention }); const call = calls.at(-1)!;
      const control = cacheRetention === 'none' ? undefined : { type: 'ephemeral', ...(cacheRetention === 'long' ? { ttl: '1h' } : {}) };
      expect(call.body.system).toEqual([{ type: 'text', text: 'System probe', ...(control ? { cache_control: control } : {}) }]);
      expect((call.body.tools as Record<string, unknown>[])[0].cache_control).toEqual(control);
      expect(call.headers['x-session-id']).toBe(cacheRetention === 'none' ? undefined : 'session-1');
    }
    expect(provider.getProviderType()).toBe('azure'); expect(messages[0].content).toBe('Read the file');
  });

  it('executes every A identity with its own effort, pricing and declared compatibility', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterMessagesProvider({ type: 'local', apiKey: 'disposable', model, baseUrl });
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
    const messages = [{ id: 'image-1', role: 'user' as const, content: 'See image', timestamp: new Date(),
      blocks: [{ type: 'image' as const, mediaType: 'image/png', url: `data:image/png;base64,${data}` }] }];
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS) {
      const result = await provider.chat(messages, { model: profile.id, thinking: 'high', maxTokens: profile.maxOutputTokens, temperature: 0.25,
        systemPrompt: 'Profile system', tools: [{ name: 'first', description: 'First', parameters: { type: 'object' } },
          { name: 'read', description: 'Read', parameters: { type: 'object' } }] });
      expect(result.api).toBe('anthropic-messages');
      const rates = profile.pricing;
      expect(result.usage?.costUsd).toBe((5 * rates.inputPerMillion + 2 * rates.outputPerMillion + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1_000_000);
      const call = calls.at(-1)!;
      expect(call.body).toMatchObject({ model: profile.id, max_tokens: profile.maxOutputTokens,
        thinking: { type: profile.compat?.forceAdaptiveThinking ? 'adaptive' : 'enabled' } });
      expect(call.body).not.toHaveProperty('temperature');
      expect(call.body.system).toEqual([{ type: 'text', text: 'Profile system', cache_control: { type: 'ephemeral' } }]);
      const tools = call.body.tools as Record<string, unknown>[];
      expect(tools[0].cache_control).toBeUndefined(); expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
      expect((call.body.messages as unknown[])[0]).toMatchObject({ role: 'user', content: [
        { type: 'text', text: 'See image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ] });
      if (profile.compat?.supportsMidConvoEffort) {
        expect(call.headers['anthropic-beta']).toBe('mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01');
        expect((call.body.messages as unknown[]).at(-1)).toEqual({ role: 'system', content: [], output_config: { effort: 'high' } });
        expect(call.body.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: 'drop_block' } });
      }
      for (const tier of profile.declaredPricing.tiers ?? []) expect(Object.isFrozen(tier)).toBe(true);
      if (profile.compat) expect(Object.isFrozen(profile.compat)).toBe(true);
      if (profile.declaredInputLimits) expect(Object.isFrozen(profile.declaredInputLimits.images.resize)).toBe(true);
      provider.setConfiguredModel(profile.id);
      const descriptor = provider.getSpecializedModels()[0]!;
      expect(descriptor).toMatchObject({ model: profile.id, api: profile.api, contextWindow: profile.contextWindow, imageInput: true });
      expect(descriptor.pricing).not.toBe(profile.pricing);
    }
    expect(calls).toHaveLength(16);
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS) for (const Provider of [providers.OpenRouterMessagesProvider, providers.OpenRouterProvider]) for (const facade of ['chat', 'stream']) {
      const owner = new Provider({ type: 'openrouter', apiKey: 'disposable-media', model: profile.id, baseUrl });
      const history: Message[] = [{ id: 'media-u', role: 'user', content: 'before', timestamp: new Date(0) },
        { id: 'media-a', role: 'assistant', content: 'called', timestamp: new Date(0), provider: 'openrouter', api: 'anthropic-messages', model: profile.id,
          metadata: { providerThinkingLevel: 'low' }, toolCalls: [{ id: 'image-call', name: 'read', input: {} }] },
        { id: 'media-r', role: 'tool', name: 'read', toolCallId: 'image-call', content: 'result', timestamp: new Date(0), blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] },
        { id: 'media-next', role: 'user', content: 'after', timestamp: new Date(0) }], before = structuredClone(history);
      const options = { maxTokens: 4096, thinking: 'low' as const, thinkingBudgets: { low: 2048 }, cacheRetention: 'none' as const };
      if (facade === 'chat') await owner.chat(history, options); else await owner.streamChat(history, () => {}, undefined, error => { throw error; }, options);
      const expected = structuredClone(continuation.rows.find((row: { model: string }) => row.model === profile.id).expectedInitialBody);
      delete expected.tools; delete expected.system; expected.stream = facade === 'stream';
      const control = { role: 'system', content: [], output_config: { effort: 'low' } }, managed = profile.compat?.supportsMidConvoEffort;
      expected.messages = [{ role: 'user', content: 'before' }, ...(managed ? [control] : []),
        { role: 'assistant', content: [{ type: 'text', text: 'called' }, { type: 'tool_use', id: 'image-call', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-call', content: 'result', is_error: false }] },
        { role: 'user', content: [{ type: 'text', text: 'Tool images for image-call' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
        { role: 'user', content: 'after' }, ...(managed ? [control] : [])];
      expect(calls.at(-1)!.body).toEqual(expected); expect(history).toEqual(before);
    }
    expect(calls).toHaveLength(80);
  });

  it('uses gross-input tiers, observed initial/delta/1h accounting and conservative partials', async () => {
    let usage: unknown, deltaUsage: unknown;
    const { baseUrl } = await fixture((body, response) => {
      if (!body.stream) { response.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage })); return; }
      response.setHeader('content-type', 'text/event-stream');
      const events = [{ type: 'message_start', message: { model: body.model, usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready' } }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, ...(deltaUsage === undefined ? {} : { usage: deltaUsage }) }, { type: 'message_stop' }];
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', apiKey: 'disposable', model, baseUrl });
    for (const profile of providers.OPENROUTER_MESSAGE_MODELS.filter(profile => profile.declaredPricing.tiers?.length)) {
      const tier = profile.declaredPricing.tiers![0]!;
      for (const above of [false, true]) {
        const input = tier.inputTokensAbove - 5 + Number(above), rates = above ? tier : profile.pricing;
        usage = { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 };
        expect((await provider.chat([], { model: profile.id })).usage?.costUsd).toBe((input * rates.inputPerMillion + 2 * rates.outputPerMillion
          + 4 * rates.cacheReadPerMillion + rates.cacheWritePerMillion) / 1_000_000);
      }
    }
    for (const invalid of [{ input_tokens: 5 }, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: null }, { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0.5 },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 }]) {
      usage = invalid; expect((await provider.chat([])).usage).toBeUndefined();
    }
    usage = { input_tokens: 0, output_tokens: 0 };
    expect((await provider.chat([])).usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
    usage = { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_1h_input_tokens: 1 } };
    const streamUsage = async () => {
      let result: providers.ChatResponse | undefined;
      await provider.streamChat([], () => undefined, value => { result = value; }, error => { throw error; }, { cacheRetention: 'long' });
      return result?.usage;
    };
    const observed = [(await provider.chat([], { cacheRetention: 'long' })).usage, await streamUsage()];
    deltaUsage = { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 6, cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_1h_input_tokens: 1 } };
    observed.push(await streamUsage());
    deltaUsage = { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null,
      cache_creation: { ephemeral_1h_input_tokens: null } };
    observed.push(await streamUsage());
    const initial = { promptTokens: 5, completionTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 12,
      costUsd: (5 * 3 + 2 * 15 + 4 * 0.3 + 3 * 2) / 1_000_000 };
    expect(observed).toEqual([initial, initial,
      { promptTokens: 7, completionTokens: 3, cacheReadTokens: 6, cacheWriteTokens: 2, totalTokens: 18,
        costUsd: (7 * 3 + 3 * 15 + 6 * 0.3 + 3.75 + 3 * 2) / 1_000_000 }, initial]);
    for (const long of [-1, 0.5, 2, null]) {
      usage = { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: long } };
      expect((await provider.chat([])).usage).toBeUndefined();
    }
  });

  it('keeps endpoint/header/decoded JSON errors private and ignores unused adaptive numeric maps', async () => {
    let reply: unknown;
    const { calls, baseUrl } = await fixture((body, response) => response.end(JSON.stringify(reply ?? {
      model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }], usage: { input_tokens: 5, output_tokens: 2 },
    })));
    for (const endpoint of ['https://private:secret@example.test/api', 'https://example.test/api?private=secret', 'https://example.test/api#private-secret', 'file:///private/secret']) {
      expect(() => new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl: endpoint }))
        .toThrow('Invalid OpenRouter messages endpoint.');
    }
    for (const apiKey of ['', 'disposable\u0000private', 'disposable\ud83d']) {
      const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey, baseUrl });
      await expect(provider.chat([])).rejects.toThrow('OpenRouter API key is required.');
    }
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl,
      customHeaders: { 'x-private': 'disposable\u0000private' } });
    await expect(provider.chat([])).rejects.toThrow('Invalid OpenRouter request headers.');
    expect(calls).toHaveLength(0);
    const getter = vi.fn(() => 1000), budgets = Object.defineProperty({}, 'high', { get: getter });
    const adaptive = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl });
    await adaptive.chat([], { thinking: 'high', maxTokens: 64, thinkingBudgets: budgets });
    expect(getter).not.toHaveBeenCalled(); expect(calls).toHaveLength(1);
    await expect(adaptive.chat([], { maxTokens: 0 })).rejects.toThrow('Invalid OpenRouter output limit.');
    expect(calls).toHaveLength(1);
    for (const invalid of [
      { model, error: { message: 'DISPOSABLE-PRIVATE' }, content: [{ type: 'text', text: 'DISPOSABLE-PRIVATE' }] },
      { model: 'DISPOSABLE\u0000PRIVATE', content: [{ type: 'text', text: 'Ready' }] },
      { model, content: [{ type: 'text', text: { private: 'DISPOSABLE-PRIVATE' } }] },
      { model, content: [{ type: 'thinking', thinking: { private: 'DISPOSABLE-PRIVATE' } }] },
      { model, content: [{ type: 'tool_use', id: 'read-1', name: 'read', input: null }] },
    ]) {
      reply = invalid; await expect(adaptive.chat([])).rejects.toThrow('Invalid OpenRouter message response.');
    }
    reply = { model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'One' }, { type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Two' }] };
    expect(await adaptive.chat([])).toMatchObject({ content: 'OneTwo', reasoning: 'Plan' });
  });

  it('withdraws later buffered text, tools and completion after an awaited reasoning callback', async () => {
    const { calls, baseUrl } = await fixture();
    const provider = new providers.OpenRouterMessagesProvider({ type: 'operator-router', model, apiKey: 'disposable', baseUrl });
    const controller = new AbortController(), events: string[] = [], complete = vi.fn(), failure = vi.fn();
    await provider.streamChat([], async (_text, event) => {
      events.push(event?.type ?? 'text');
      if (event?.type === 'reasoning_delta') { await Promise.resolve(); controller.abort(); }
    }, complete, failure, { thinking: 'high', maxTokens: 64, signal: controller.signal });
    expect(calls).toHaveLength(1); expect(events).toEqual(['message_start', 'reasoning_delta']);
    expect(complete).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0][0].message).toBe('OpenRouter request aborted.');
    let seed = true;
    const signed = await fixture((body, response) => {
      response.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
      const events = seed ? continuation.seedEvents : continuation.rows[0].cases[0].responseEvents;
      if (body.stream) response.end(events.map((event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      else response.end(JSON.stringify({ model: 'untrusted-response-alias', stop_reason: seed ? 'tool_use' : 'end_turn', content: seed ? continuation.syntheticJsonContent : [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } }));
    });
    const physical = 'anthropic/claude-opus-5.5', later = 'anthropic/claude-sonnet-4.6', reference = continuation.rows.find((row: { model: string }) => row.model === physical);
    const options = { maxTokens: 4096, thinking: 'low' as const, thinkingBudgets: { low: 2048 }, cacheRetention: 'none' as const,
      systemPrompt: 'owned OpenRouter reference system', tools: continuation.tools };
    for (const Provider of [providers.OpenRouterMessagesProvider, providers.OpenRouterProvider]) for (const facade of ['chat', 'stream']) {
      const owner = new Provider({ type: 'openrouter', model: later, apiKey: 'disposable-getter', baseUrl: signed.baseUrl }); let reads = 0, snapshot: providers.ChatResponse | undefined;
      const selected = { ...options, get model() { return ++reads === 1 ? physical : later; } }, user: Message = { id: 'getter-u', role: 'user', content: 'probe', timestamp: new Date(0) };
      seed = true;
      if (facade === 'chat') snapshot = await owner.chat([user], selected); else await owner.streamChat([user], () => {}, value => { snapshot = value; }, error => { throw error; }, selected);
      expect(signed.calls.at(-1)!.body).toEqual({ ...reference.expectedInitialBody, stream: facade === 'stream' });
      expect(signed.calls.at(-1)!.headers['anthropic-beta']).toBe(reference.sdkBeta);
      expect(snapshot).toMatchObject({ provider: 'openrouter', api: 'anthropic-messages', model: physical, providerThinkingLevel: 'low', blocks: continuation.expectedBlocks });
      const rates = reference.published.cost; expect(snapshot!.usage?.costUsd).toBeCloseTo((5 * rates.input + 2 * rates.output + 4 * rates.cacheRead + 3 * rates.cacheWrite) / 1e6, 12);
      const history: Message[] = [user, { id: 'getter-a', role: 'assistant', content: snapshot!.content, timestamp: new Date(0), provider: snapshot!.provider, api: snapshot!.api, model: snapshot!.model,
        blocks: snapshot!.blocks, toolCalls: snapshot!.toolCalls, metadata: { providerThinkingLevel: snapshot!.providerThinkingLevel } },
        { id: 'getter-r', role: 'tool', name: 'echo', toolCallId: 'call', content: 'result', timestamp: new Date(0) }, { ...user, id: 'getter-next', content: 'continue' }], before = structuredClone(history);
      seed = false; await owner.chat(history, { ...options, model: physical }); expect(signed.calls.at(-1)!.body).toEqual({ ...reference.cases[0].expectedBody, stream: false });
      await owner.chat(history, { ...options, model: later }); expect(signed.calls.at(-1)!.body).toEqual({ ...continuation.rows.find((row: { model: string }) => row.model === later).cases.find((row: { case: string }) => row.case === 'foreign-model').expectedBody, stream: false }); expect(history).toEqual(before);
    }
    expect(signed.calls).toHaveLength(12);
    for (const Provider of [providers.OpenRouterMessagesProvider, providers.OpenRouterProvider]) {
      seed = true; const errors: Error[] = [];
      await new Provider({ type: 'openrouter', model: physical, apiKey: 'disposable-publication', baseUrl: signed.baseUrl }).streamChat([], () => {}, async () => {
        await Promise.resolve(); throw new Error('PRIVATE_OPENROUTER_COMPLETION_FAILURE');
      }, error => { errors.push(error); }, options);
      expect(errors.map(error => error.message)).toEqual(['OpenRouter message request failed.']);
    }
    const forged = await fixture((_body, response) => response.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready' }, { type: 'thinking', thinking: 'visible', signature: 'opaque-forged-reply' }] })));
    class DerivedA extends providers.OpenRouterMessagesProvider {} class DerivedMixed extends providers.OpenRouterProvider {}
    for (const Provider of [providers.AnthropicProvider, DerivedA, DerivedMixed]) {
      const owner = new Provider({ type: 'openrouter', model: later, apiKey: 'disposable-forged', baseUrl: Provider === providers.AnthropicProvider ? forged.baseUrl.replace(/\/v1\/messages$/, '') : forged.baseUrl });
      const history: Message[] = [{ id: 'forged-a', role: 'assistant', content: 'visible', timestamp: new Date(0), provider: 'openrouter', api: 'anthropic-messages', model: later,
        blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: 'opaque-forged' }] }];
      expect((await owner.chat(history, { model: later, maxTokens: 4096 })).blocks).toBeUndefined(); expect(JSON.stringify(forged.calls.at(-1)!.body)).not.toContain('opaque-');
    }
  });
});
