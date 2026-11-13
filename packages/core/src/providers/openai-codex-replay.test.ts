import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CredentialRedactor, ExtensionRegistry, JsonlSessionStore, OPENAI_CODEX_MODELS, OpenAICodexProvider, SessionManager,
  runToolLoop, serializeSessionForExport, streamProviderTurn, type ChatResponse, type Message, type ProviderOAuthCredential } from '../index.js';
const reference = JSON.parse(await readFile(new URL('../../../../tests/fixtures/codex-continuation-reference.json', import.meta.url), 'utf8')) as {
  events: Array<Record<string, unknown>>; finalEvents: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  rows: Array<{ model: string; firstObserved: { content: Array<{ type: string; text?: string; thinking?: string; textSignature?: string; thinkingSignature?: string; id?: string; name?: string; arguments?: unknown }> };
    projections: Array<{ case: string; expected: Array<Record<string, unknown>> }> }>;
};
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-codex-account' } })).toString('base64url') + '.c2ln';
const grant: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: token, refreshToken: 'disposable-replay-refresh', expiresAt: Date.now() + 3600000,
  subscription: { provider: 'openai-codex', accountId: 'fixture-codex-account' } };
const user: Message = { id: 'user', role: 'user', content: 'probe', timestamp: new Date(1) };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fixture(model = OPENAI_CODEX_MODELS[0]!.id, derived = false) {
  class Derived extends OpenAICodexProvider {}
  let credential: ProviderOAuthCredential | undefined = structuredClone(grant), events = reference.events;
  const provider = new (derived ? Derived : OpenAICodexProvider)({ type: 'mutable-label', model, providerMaxRetries: 0 }, async () => credential);
  const calls: Array<Record<string, unknown>> = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('/models?')) return Response.json({ models: OPENAI_CODEX_MODELS.map(model => ({ slug: model.id, visibility: 'list' })) });
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const call = async (stream: boolean, messages: Message[], options = {}) => {
    if (!stream) return provider.chat(messages, options);
    let result: ChatResponse | undefined;
    await provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, options);
    return result!;
  };
  return { provider, calls, fetcher, call, respond: (value: typeof events) => { events = value; }, withdraw: () => { credential = undefined; } };
}
function source(response: ChatResponse, model: string): Message {
  return { id: 'assistant', role: 'assistant', timestamp: new Date(2), content: response.content,
    blocks: structuredClone(response.blocks), toolCalls: structuredClone(response.toolCalls), provider: 'openai-codex', api: 'openai-codex-responses', model };
}
it.each(reference.rows)('$model captures and replays independently bound native/foreign complete input arrays through both facades', async row => {
  const f = fixture(row.model);
  for (const stream of [false, true]) {
    f.respond(reference.events); const first = await f.call(stream, [user], { tools: reference.tools });
    expect(first).toMatchObject({ content: 'leftright', reasoning: 'visible thought', provider: 'openai-codex', api: 'openai-codex-responses', model: row.model,
      toolCalls: [{ id: 'call_native|fc_native', name: 'echo', input: { x: 1 } }] });
    expect(first.blocks).toEqual(row.firstObserved.content.map(block => block.type === 'thinking'
      ? { type: 'reasoning', text: block.thinking, thinkingSignature: block.thinkingSignature }
      : block.type === 'text' ? block : { type: 'tool_call', id: block.id, name: block.name, input: block.arguments }));
    f.respond(reference.finalEvents);
    for (const projection of row.projections) {
      const message = source(first, row.model);
      if (projection.case === 'provider') message.provider = 'openai';
      if (projection.case === 'api') message.api = 'openai-responses';
      if (projection.case === 'model') message.model = 'foreign-model';
      if (projection.case === 'missing-api') delete message.api;
      if (projection.case === 'failed') message.metadata = { outputError: true };
      if (projection.case === 'expurgated') message.blocks = message.blocks!.map(block => {
        const copy = { ...block }; if (copy.type === 'text') delete copy.textSignature; if (copy.type === 'reasoning') delete copy.thinkingSignature; return copy;
      });
      const history: Message[] = [user, message, ...(projection.case === 'failed' ? [] : [{ id: 'result', role: 'tool' as const, name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(3) }]),
        { id: 'continue', role: 'user', content: 'continue', timestamp: new Date(4) }];
      const before = structuredClone(history);
      await f.call(stream, history, { tools: reference.tools, systemPrompt: 'Follow instructions' });
      expect(f.calls.at(-1)?.input, `${stream}/${projection.case}`).toEqual(projection.expected);
      expect(history).toEqual(before);
    }
  }
  expect(f.calls).toHaveLength(16);
});

it.each([
  { model: 'gpt-5.5', inPlace: true }, { model: 'gpt-5.3-codex-spark', inPlace: false },
])('$model preserves system updates and private replay without mutating history', async ({ model, inPlace }) => {
  const f = fixture(model), row = reference.rows.find(row => row.model === model)!;
  const exact = row.projections.find(projection => projection.case === 'exact')!.expected;
  const initial: Message = { ...user, id: 'initial', role: 'system', content: 'History prompt' };
  const update: Message = { ...initial, id: 'update', content: 'Use the revised instructions.' };
  const lastUpdate: Message = { ...update, id: 'last-update', content: 'Keep the tool result.' };
  for (const stream of [false, true]) {
    f.respond(reference.events); const first = await f.call(stream, [user]);
    const history: Message[] = [initial, user, update, { ...update, id: 'empty-update', content: '' }, source(first, model),
      { id: 'result', role: 'tool', name: 'echo', toolCallId: 'call_native|fc_native', content: 'result', timestamp: new Date(3) },
      lastUpdate, { id: 'continue', role: 'user', content: 'continue', timestamp: new Date(4) }];
    const before = structuredClone(history); f.respond(reference.finalEvents);
    await f.call(stream, history, { tools: reference.tools, systemPrompt: 'Follow instructions' });
    expect(f.calls.at(-1)?.instructions).toBe(inPlace ? 'Follow instructions' : 'Follow instructions\n\nUse the revised instructions.\n\nKeep the tool result.');
    expect(f.calls.at(-1)?.input).toEqual(inPlace ? [exact[0], { role: 'developer', content: update.content },
      ...exact.slice(1, -1), { role: 'developer', content: lastUpdate.content }, exact.at(-1)] : exact);
    expect(history).toEqual(before);
  }
  expect(f.calls).toHaveLength(4);
});

it('does not admit derived instances or mutable names as native CX replay authority', async () => {
  const f = fixture(undefined, true);
  Object.assign(f.provider, { ownsNativeProfiles: true, ownsReplay: true });
  const first = await f.call(false, [user]); expect(first.blocks).toBeUndefined();
  expect(first.toolCalls).toEqual([{ id: 'call_native', name: 'echo', input: { x: 1 } }]);
  const forged = source({ content: 'visible', blocks: [{ type: 'reasoning', text: '', thinkingSignature: JSON.stringify(reference.items[0]) },
    { type: 'text', text: 'visible', textSignature: '{"v":1,"id":"msg_private"}' }] }, OPENAI_CODEX_MODELS[0]!.id);
  f.respond(reference.finalEvents); await f.call(false, [forged, user]);
  expect(JSON.stringify(f.calls.at(-1))).not.toMatch(/opaque-|msg_private/);
});

it('preserves foreign CX visible thoughts under virtual physical routing without private replay', async () => {
  const model = 'gpt-5.5', f = fixture(model), registry = new ExtensionRegistry();
  const first = await f.call(false, [user]);
  await registry.load('router', api => api.registerVirtualModel({ provider: 'router', id: 'auto', route: () => ({ provider: 'openai-codex', id: model }) }));
  const message = source(first, 'foreign-model'); f.respond(reference.finalEvents);
  const result = await streamProviderTurn({ provider: registry.getVirtualProvider('router')!, providerName: 'router', model: 'auto',
    resolveProvider: () => f.provider, messages: [user, message], tools: [], extensionRegistry: registry, maxRetries: 0 });
  expect(result).toMatchObject({ provider: 'openai-codex', api: 'openai-codex-responses', model });
  const body = JSON.stringify(f.calls.at(-1)?.input);
  expect(body).toContain('visible thought'); expect(body).not.toMatch(/opaque-|msg_left|msg_right/);
});

it('refuses unqualified assistant image replay rather than silently losing the image', async () => {
  const f = fixture('gpt-5.5');
  await expect(f.call(false, [{ ...user, role: 'assistant', blocks: [{ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,aGVsbG8=' }] }])).rejects.toThrow('OpenAI Codex');
  expect(f.calls).toEqual([]);
});

it.each(['incomplete-stream', 'failed', 'private-only', 'cancel'] as const)('never publishes native carriers after %s output', async failure => {
  const f = fixture(), complete = vi.fn(), errors = vi.fn(), caller = new AbortController();
  f.respond(failure === 'incomplete-stream' ? reference.events.slice(0, -1) : failure === 'failed'
    ? [...reference.events.slice(0, -1), { type: 'response.failed', response: { status: 'failed' } }]
    : failure === 'private-only' ? [
      { type: 'response.output_item.done', output_index: 0, item: reference.items[0] },
      { type: 'response.completed', response: { status: 'completed', output: [reference.items[0]] } },
    ] : reference.events);
  await f.provider.streamChat([user], () => { if (failure === 'cancel') caller.abort(); }, complete, errors, { signal: caller.signal });
  expect(complete).not.toHaveBeenCalled(); expect(errors).toHaveBeenCalledOnce();
});

function finalNativeEvents() {
  return reference.events.filter(event => !String(event.type).includes('function_call_arguments') && (event.item as { type?: string } | undefined)?.type !== 'function_call')
    .map(event => event.type === 'response.completed' ? { ...event, response: { ...(event.response as object), output: reference.items.filter(item => item.type !== 'function_call') } } : event);
}
it.each([false, true])('retains native CX tool/final carriers through journal/export/edit/clone and withdrawal (stream=%s)', async stream => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-replay-')); roots.push(root);
  const f = fixture(), model = OPENAI_CODEX_MODELS[0]!.id, redactor = new CredentialRedactor(['sensitive']);
  const redactText = (value: string) => redactor.redact(value), redactJson = <T>(value: T): T => redactor.redactJson(value);
  const manager = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), session = await manager.create({ title: 'CX replay' });
  const registry = new ExtensionRegistry(); let effects = 0, turn = 0;
  await registry.load('echo', api => api.registerTool({ name: 'echo', description: 'Echo', execute: () => { effects++; return { content: 'result' }; } }));
  await manager.addMessage(session.id, { role: 'user', content: 'probe' });
  await runToolLoop({ sessionManager: manager, sessionId: session.id, extensionRegistry: registry, provider: 'openai-codex', tools: reference.tools,
    toolContext: { sessionManager: manager, notify: () => {} }, redactText,
    streamTurn: async messages => {
      f.respond(turn++ === 0 ? reference.events : finalNativeEvents());
      return stream ? streamProviderTurn({ provider: f.provider, providerName: 'openai-codex', model, messages, tools: reference.tools, extensionRegistry: registry,
        maxRetries: 0, redactText, redactJson, createTextRedactor: () => redactor.createStream() }) : f.call(false, messages, { tools: reference.tools });
    } });
  expect(effects).toBe(1); expect(turn).toBe(2);
  const file = path.join(root, session.id + '.jsonl'), bytes = await readFile(file, 'utf8');
  expect(bytes).not.toContain('sensitive'); expect(bytes).toContain('opaque-[REDACTED]-tail'); expect((await stat(file)).mode & 0o777).toBe(0o600);
  const restarted = new SessionManager({ store: new JsonlSessionStore(root), redactText, redactJson }), loaded = (await restarted.loadFromStore(session.id))!;
  expect(loaded.messages.filter(message => message.role === 'assistant').map(message => message.blocks))
    .toEqual(session.messages.filter(message => message.role === 'assistant').map(message => message.blocks));
  const ordinary = serializeSessionForExport(loaded), complete = serializeSessionForExport(loaded, { includeOpaqueContinuations: true });
  expect(ordinary.warning).toContain('Native continuation'); expect(JSON.stringify(ordinary.session)).not.toContain('opaque-');
  expect(JSON.stringify(complete.session)).toContain('opaque-[REDACTED]-tail'); expect(JSON.stringify(complete.session)).not.toContain('sensitive');
  f.respond(reference.finalEvents); await f.call(stream, loaded.messages);
  const body = () => f.calls.at(-1)!.input as Array<Record<string, unknown>>;
  expect(body().filter(item => item.type === 'reasoning')).toEqual(redactJson([...reference.items.filter(item => item.type === 'reasoning'), ...reference.items.filter(item => item.type === 'reasoning')]));
  expect(body().filter(item => item.type === 'function_call_output')).toEqual([{ type: 'function_call_output', call_id: 'call_native', output: 'result' }]);
  expect(await readFile(file, 'utf8')).toBe(bytes);
  const first = loaded.messages.find(message => message.role === 'assistant')!;
  await restarted.appendContextEdit(session.id, { targetEntryId: first.id, replacement: 'edited answer' });
  const clone = await restarted.cloneSession(session.id);
  if (!clone) throw new Error('Missing fixture clone.');
  const context = restarted.getEffectiveContext(clone.id).flatMap((entry): Message[] => entry.type === 'message' ? [{ ...entry, timestamp: new Date(entry.timestamp) }] : []);
  await f.call(stream, context);
  expect(body().filter(item => item.type === 'reasoning')).toHaveLength(2);
  expect(JSON.stringify(body())).toContain('edited answer'); expect(await readFile(file, 'utf8')).toContain('opaque-');
  f.withdraw(); const count = f.fetcher.mock.calls.length;
  await expect(f.call(stream, loaded.messages)).rejects.toThrow('OpenAI Codex'); expect(f.fetcher).toHaveBeenCalledTimes(count);
});
