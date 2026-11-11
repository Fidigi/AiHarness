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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MistralProvider, ProviderFactory } from './index.js';
import type { ChatOptions, ChatResponse } from './index.js';
import type { Message } from '../types/index.js';
import { closeProviderNetworkDispatchers } from './provider-network.js';

const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/mistral-continuation-reference.json', import.meta.url), 'utf8'));
const models: string[] = reference.rows.map((row: { model: string }) => row.model);
afterEach(async () => { vi.unstubAllGlobals(); await closeProviderNetworkDispatchers(); });

function fixture(events: unknown[]) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
  const state = { events };
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(state.events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  return { state, calls };
}
const history = (values: Array<Record<string, unknown>>): Message[] => values.map(value => ({ ...structuredClone(value), timestamp: new Date(0) } as unknown as Message));

describe('independently bound native Mistral continuation', () => {
  it.each(models)('compares whole native Mistral bodies and ordered carriers for %s', async model => {
    const row = reference.rows.find((value: { model: string }) => value.model === model);
    const { state, calls } = fixture(row.seedResponseEvents);
    for (const facade of ['chat', 'stream']) {
      const provider = new MistralProvider({ type: 'mistral', apiKey: 'disposable-mistral', model, baseUrl: 'https://owned.example/owned/mistral' });
      const options: ChatOptions = { ...row.options, tools: reference.tools };
      const invoke = async (messages: Message[], selected = options): Promise<ChatResponse> => {
        if (facade === 'chat') return provider.chat(messages, selected);
        let complete: ChatResponse | undefined;
        await provider.streamChat(messages, () => {}, value => { complete = value; }, error => { throw error; }, selected);
        expect(complete).toBeDefined(); return complete!;
      };
      state.events = row.seedResponseEvents;
      const answer = await invoke([{ id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }], { ...options, systemPrompt: 'owned Mistral reference system' });
      expect(answer).toMatchObject({ provider: 'mistral', api: 'mistral-conversations', model, content: 'leftright!', reasoning: 'firstsecondtail' });
      expect(answer.blocks).toEqual(row.expectedBlocks); expect(answer.toolCalls).toEqual(row.expectedToolCalls);
      expect(answer.usage).toMatchObject({ promptTokens: 6, completionTokens: 2, cacheReadTokens: 4, totalTokens: 12 });
      expect(answer.usage?.costUsd).toBeCloseTo(row.expectedUsage.cost.total, 12); // Existing zero-table accounting is retained, not a free-service claim.
      expect(calls.at(-1)!.body).toEqual(row.expectedInitialBody);
      for (const projection of row.cases) {
        const messages = history(projection.messages), before = structuredClone(messages);
        state.events = projection.responseEvents;
        expect((await invoke(messages)).content).toBe('ok');
        expect(calls.at(-1)!.body).toEqual(projection.expectedBody); expect(messages).toEqual(before);
      }
      const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
      await invoke([{ ...user, role: 'system', content: 'Leading system' }, user]);
      expect(calls.at(-1)!.body).toEqual({ ...row.expectedInitialBody, messages: [{ role: 'system', content: 'Leading system' }, { role: 'user', content: 'probe' }] });
      await invoke([{ ...user, role: 'system', content: 'Leading system' }, user], { ...options, systemPrompt: 'Configured system' });
      expect(calls.at(-1)!.body).toEqual({ ...row.expectedInitialBody, messages: [{ role: 'system', content: 'Configured system\n\nLeading system' }, { role: 'user', content: 'probe' }] });
      const root = await mkdtemp(path.join(os.tmpdir(), 'aih-mistral-replay-')), redactor = new CredentialRedactor(['disposable-mistral', 'firstsecond']);
      const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
      const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
      const session = await manager.create({ title: 'Mistral native replay' }), registry = new ExtensionRegistry(); let effects = 0;
      const same = redactJson(row.cases[0].expectedBody.messages), finalItem = { role: 'assistant', prefix: false, content: [{ type: 'text', text: 'ok' }] };
      const nativeOptions = { ...options, systemPrompt: 'owned Mistral reference system' };
      await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; state.events = row.cases[0].responseEvents; return { content: 'result' }; } }));
      try {
        await manager.addMessage(session.id, { role: 'user', content: 'probe' }); state.events = row.seedResponseEvents;
        await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'mistral', tools: reference.tools,
          toolContext: { sessionManager: manager, notify: () => {} }, redactText, streamTurn: messages => invoke(messages, nativeOptions) });
        expect(effects).toBe(1); expect(calls.at(-1)!.body.messages).toEqual(same.slice(0, -1));
        const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8');
        expect(bytes).not.toContain('disposable-mistral'); expect(bytes).not.toContain('firstsecond'); expect(bytes).toContain('[REDACTED]'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson });
        const loaded = (await restarted.loadFromStore(session.id))!, assistants = loaded.messages.filter(message => message.role === 'assistant');
        expect(assistants.map(message => message.blocks)).toEqual([redactJson(row.expectedBlocks), [{ type: 'text', text: 'ok' }]]);
        const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
        expect(ordinary.warning).toBeUndefined(); expect(complete.warning).toBeUndefined(); // Native Mistral carries unsigned thinking, not invented opaque payloads.
        for (const exported of [ordinary, complete]) { expect(JSON.stringify(exported.session)).not.toContain('firstsecond'); expect(JSON.stringify(exported.session)).toContain('[REDACTED]'); }
        await invoke(loaded.messages, nativeOptions); expect(calls.at(-1)!.body.messages).toEqual([...same.slice(0, -1), finalItem]); expect(await readFile(file, 'utf8')).toBe(bytes);
        await restarted.appendContextEdit(session.id, { targetEntryId: assistants[0].id, replacement: 'edited answer' });
        const clone = (await restarted.cloneSession(session.id))!, canonical = getCompactionModelMessages(restarted, clone.id);
        const edited = { ...same[2], content: [{ type: 'text', text: 'edited answer' }] };
        await invoke(canonical, nativeOptions); expect(calls.at(-1)!.body.messages).toEqual([...same.slice(0, 2), edited, same[3], finalItem]);
        const target = canonical.find(message => message.content === 'edited answer')!;
        expect(target).toMatchObject({ provider: 'mistral', api: 'mistral-conversations', model }); expect(target.metadata).toBeUndefined(); expect(target.blocks?.some(block => block.type === 'reasoning')).toBe(false);
        for (const id of [session.id, clone.id]) {
          const raw = (await restarted.getRawEntries(id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant');
          expect(raw).toHaveLength(2); expect(raw.map(entry => entry.blocks)).toEqual(expect.arrayContaining(assistants.map(message => message.blocks)));
        }
        const before = structuredClone(canonical), summary = getSummaryModelMessages(canonical);
        expect(summary.flatMap(message => message.blocks ?? []).some(block => block.type === 'reasoning')).toBe(false); expect(canonical).toEqual(before);
        const kept = clone.messages.filter(message => message.role === 'assistant').at(-1)!, sourceBytes = await readFile(file, 'utf8');
        await restarted.applyCompaction(clone.id, 'PUBLIC_MISTRAL_PREFIX', kept.id);
        const compactedManager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }); await compactedManager.loadFromStore(clone.id);
        const compacted = getCompactionModelMessages(compactedManager, clone.id), cloneFile = path.join(root, clone.id + '.jsonl'), cloneBytes = await readFile(cloneFile, 'utf8');
        expect(compacted.map(message => ({ role: message.role, content: message.content }))).toEqual([{ role: 'system', content: '[Context Summary] PUBLIC_MISTRAL_PREFIX' }, { role: 'assistant', content: 'ok' }]);
        expect((await compactedManager.getActiveBranchEntries(clone.id)).filter(entry => entry.type === 'message').filter(entry => entry.role === 'assistant').map(entry => entry.blocks)).toEqual(assistants.map(message => message.blocks));
        await invoke(compacted, nativeOptions); expect(calls.at(-1)!.body.messages).toEqual([{ role: 'system', content: 'owned Mistral reference system\n\n[Context Summary] PUBLIC_MISTRAL_PREFIX' }, finalItem]);
        expect(await readFile(cloneFile, 'utf8')).toBe(cloneBytes); expect(await readFile(file, 'utf8')).toBe(sourceBytes); expect(effects).toBe(1);
      } finally { await registry.shutdown(); await rm(root, { recursive: true, force: true }); }
    }
    expect(calls).toHaveLength(56);
    for (const call of calls) {
      expect(call.url).toBe('https://owned.example/owned/mistral/v1/chat/completions');
      expect(call.headers.get('authorization')).toBe('Bearer disposable-mistral');
      expect(call.headers.get('x-affinity')).toBeNull();
    }
  });

  it('pins actual prepared identity across caller-state/getter changes and keeps derived and unknown requests legacy', async () => {
    const row = reference.rows.find((value: { model: string }) => value.model === 'magistral-medium-latest');
    const { calls } = fixture(row.seedResponseEvents), user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
    for (const facade of ['chat', 'stream']) for (const changing of [false, true]) {
      const provider = new MistralProvider({ type: 'operator-mistral', model: row.model, apiKey: 'disposable-mistral' });
      provider.getProviderType = () => 'forged-provider'; provider.getModelApi = () => 'forged-api';
      provider.getPublishedModels()[0]!.pricing!.inputPerMillion = 999999;
      let reads = 0, selected = row.model, result: ChatResponse | undefined;
      const options = { ...row.options, tools: reference.tools, systemPrompt: 'owned Mistral reference system', get model() { reads++; const value = selected; if (changing) selected = 'unknown-after-read'; return value; } };
      if (facade === 'chat') result = await provider.chat([user], options);
      else await provider.streamChat([user], async () => { await Promise.resolve(); provider.setConfiguredModel('unknown-after-send'); }, value => { result = value; }, error => { throw error; }, options);
      expect(reads).toBe(1); expect(selected).toBe(changing ? 'unknown-after-read' : row.model);
      expect(result).toMatchObject({ provider: 'operator-mistral', api: 'mistral-conversations', model: row.model, blocks: row.expectedBlocks });
      expect(result!.usage?.costUsd).toBeCloseTo(row.expectedUsage.cost.total, 12); expect(calls.at(-1)!.body).toEqual(row.expectedInitialBody);
      const source: Message = { ...user, role: 'assistant', content: result!.content, blocks: result!.blocks, toolCalls: result!.toolCalls, provider: result!.provider, api: result!.api, model: result!.model };
      await provider.chat([user, source, { ...user, role: 'tool', name: 'echo', toolCallId: row.expectedToolCalls[0].id, content: 'result' }, { ...user, content: 'continue' }], { ...row.options, model: row.model, tools: reference.tools, systemPrompt: 'owned Mistral reference system' });
      expect(calls.at(-1)!.body).toEqual(row.cases[0].expectedBody);
    }
    expect((await ProviderFactory.create({ type: 'mistral-conversations', apiKey: 'disposable-mistral', model: row.model }).chat([user], row.options))).toMatchObject({ provider: 'mistral-conversations', model: row.model, blocks: row.expectedBlocks });
    class Derived extends MistralProvider {}
    const derived = new Derived({ type: 'mistral', apiKey: 'disposable-mistral', model: row.model });
    (derived as unknown as { ownsReplay: boolean }).ownsReplay = true;
    for (const provider of [derived, new MistralProvider({ type: 'mistral', apiKey: 'disposable-mistral', model: 'unknown-model' })]) {
      const result = await provider.chat([user], row.options); expect(result.blocks).toBeUndefined(); expect(result.model).toBe('untrusted-response-alias');
    }
    expect(calls).toHaveLength(11);
  });

  it('withdraws pending tools on EOF/error/awaited abort and awaits native completion failures', async () => {
    const row = reference.rows.find((value: { model: string }) => value.model === 'magistral-medium-latest'), { state, calls } = fixture(row.seedResponseEvents);
    const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) };
    for (const mode of ['eof', 'error', 'abort', 'completion']) {
      state.events = mode === 'eof' ? row.seedResponseEvents.slice(0, -1) : mode === 'error' ? [...row.seedResponseEvents.slice(0, -1), { error: { message: 'PRIVATE_MISTRAL_FAILURE' }, choices: [] }] : row.seedResponseEvents;
      const controller = new AbortController(), complete = vi.fn(async () => { if (mode === 'completion') { await Promise.resolve(); throw new Error('The provider PRIVATE_MISTRAL_CALLBACK'); } });
      const errors: Error[] = [], seen: string[] = [], tools: unknown[] = [];
      await new MistralProvider({ type: 'mistral', apiKey: 'disposable-mistral', model: row.model }).streamChat([user], async (text, event) => {
        if (event?.type === 'tool_call') tools.push(event.data); else seen.push(text);
        if (mode === 'abort' && text) { await Promise.resolve(); controller.abort(); }
      }, complete, error => { errors.push(error); }, { ...row.options, signal: controller.signal });
      expect(errors).toHaveLength(1); expect(errors[0].message).not.toContain('PRIVATE_');
      if (mode === 'completion') { expect(complete).toHaveBeenCalledOnce(); expect(errors[0].message).toBe('Mistral request failed.'); }
      else { expect(complete).not.toHaveBeenCalled(); expect(tools).toEqual([]); }
      if (mode === 'abort') expect(seen).toEqual(['left']);
    }
    expect(calls).toHaveLength(4);
  });
});
