import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { OPENAI_CODEX_MODELS, OpenAICodexProvider, ProviderFactory, createProviderNetworkScope, closeProviderNetworkDispatchers, PROVIDER_NETWORK_SCOPE, type Message, type ProviderOAuthCredential, type OpenAICodexModel, type OpenAICodexChatOptions, type ChatResponse } from '../index.js';
import { OPENAI_CODEX_MODELS_URL, OPENAI_CODEX_RESPONSES_URL, openAICodexAccountModels } from './openai-codex.js';
const reference = JSON.parse(await readFile(new URL('../../../../tests/fixtures/openai-codex-reference.json', import.meta.url), 'utf8')) as {
  models: Array<OpenAICodexModel & { compat?: { supportsMidConvoSystemMessages?: boolean } }>;
  responseEvents: Array<Record<string, unknown>>;
  rows: Array<{ model: string; case: string; request: { url: string; body: Record<string, unknown> } }>;
};
const constrained = JSON.parse(await readFile(new URL('../../../../tests/fixtures/codex-constrained-reference.json', import.meta.url), 'utf8')) as {
  capabilities: Array<{ model: string; strict: boolean; grammar: boolean }>;
  events: Array<Record<string, unknown>>; raw: string;
  rows: Array<{ model: string; case: string; tool: NonNullable<OpenAICodexChatOptions['tools']>[number]; refused: boolean; body?: Record<string, unknown> }>;
  replays: Array<{ model: string; case: string; expected: Array<Record<string, unknown>> }>;
};
const accountId = 'fixture-codex-account';
const accessToken = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url') + '.fixture-signature';
const original: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken, refreshToken: 'disposable-codex-refresh', expiresAt: Date.now() + 3600000, subscription: { provider: 'openai-codex', accountId } };
const user: Message = { id: 'user', role: 'user', content: 'probe', timestamp: new Date(1) };
const catalogue = () => Response.json({ models: OPENAI_CODEX_MODELS.map(model => ({ slug: model.id, visibility: 'list' })) });
const sse = (events = reference.responseEvents) => new Response(events.map((event: unknown) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
function fixture() {
  let credential: ProviderOAuthCredential | undefined = structuredClone(original);
  const source = vi.fn(async () => credential);
  const provider = new OpenAICodexProvider({ type: 'operator-alias', model: OPENAI_CODEX_MODELS[0].id,
    apiKey: 'not-authority', baseUrl: 'https://unrelated.test', headers: { Authorization: 'wrong', 'chatgpt-account-id': 'wrong' } }, source);
  const calls: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (String(url) === OPENAI_CODEX_MODELS_URL) return catalogue();
    expect(String(url)).toBe(OPENAI_CODEX_RESPONSES_URL); return sse();
  });
  return { provider, source, calls, fetcher, replace: (value: ProviderOAuthCredential | undefined) => { credential = value; } };
}
afterEach(() => { vi.restoreAllMocks(); });

it('owns immutable nine-model CX metadata without API-key factory or subscription pricing authority', async () => {
  const f = fixture();
  expect(ProviderFactory.has('openai-codex')).toBe(false);
  expect(f.provider.getProviderType()).toBe('openai-codex');
  expect(f.provider.getModelApi()).toBe('openai-codex-responses');
  expect(OPENAI_CODEX_MODELS.map(model => [model.id, model.name, model.contextWindow, model.maxTokens, model.input, model.thinkingLevelMap]))
    .toEqual(reference.models.map(model => [model.id, model.name, model.contextWindow, model.maxTokens, model.input, model.thinkingLevelMap]));
  expect(OPENAI_CODEX_MODELS.map(model => model.supportsMidConvoSystemMessages === true))
    .toEqual(reference.models.map(model => model.compat?.supportsMidConvoSystemMessages === true));
  expect(Object.isFrozen(OPENAI_CODEX_MODELS)).toBe(true);
  expect(Object.isFrozen(OPENAI_CODEX_MODELS[0].thinkingLevelMap)).toBe(true);
  expect(f.provider.getPublishedModels().every(model => model.api === 'openai-codex-responses' && model.pricing === undefined)).toBe(true);
  expect(f.provider.isModelDiscoveryAuthoritative()).toBe(true);
  expect(await f.provider.getAvailableModels()).toEqual(OPENAI_CODEX_MODELS.map(model => model.id));
});

it.each(reference.rows)('matches the independently normalized SDK body for $model/$case', async row => {
  const f = fixture(), options = { model: row.model, systemPrompt: 'Follow instructions',
    ...(row.case === 'thinking' ? { thinking: 'high' as const, temperature: 0.3, maxTokens: 64 } : {}),
    ...(row.case === 'tools' ? { toolChoice: 'required' as const, tools: [{ name: 'echo', description: 'Echo input', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } }] } : {}) };
  const before = JSON.stringify({ user, options });
  const reply = await f.provider.chat([user], options);
  expect(f.calls.map(call => call.url)).toEqual([OPENAI_CODEX_MODELS_URL, row.request.url]);
  expect(f.calls[1].body).toEqual(row.request.body);
  for (const call of f.calls) {
    expect(call.headers.get('authorization')).toBe('Bearer ' + accessToken);
    expect(call.headers.get('chatgpt-account-id')).toBe(accountId);
    expect(call.headers.get('x-api-key')).toBeNull();
  }
  expect(f.calls[1].headers.get('openai-beta')).toBe('responses=experimental');
  expect(f.calls[1].headers.get('originator')).toBe('ai-harness');
  expect(reply).toMatchObject({ content: 'ok', provider: 'openai-codex', api: 'openai-codex-responses', model: row.model });
  expect(reply.usage?.costUsd).toBeUndefined();
  expect(JSON.stringify({ user, options })).toBe(before);
});

it('intersects discovery with account-listed pinned models, never static/custom fallback on failure', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(Response.json({ models: [{ slug: 'gpt-5.5', visibility: 'list' }, { slug: OPENAI_CODEX_MODELS[0].id, visibility: 'hide' }, { slug: 'unreviewed-new-model', visibility: 'list' }] }));
  expect(await f.provider.getAvailableModels()).toEqual(['gpt-5.5']);
  f.fetcher.mockResolvedValueOnce(Response.json({ models: [] }));
  await expect(f.provider.chat([user])).rejects.toThrow('OpenAI Codex request failed.');
  f.fetcher.mockResolvedValueOnce(new Response('private-response-text', { status: 403 }));
  await expect(f.provider.getAvailableModels()).rejects.toThrow('catalogue is unavailable');
});

it.each(['absent', 'generic', 'copilot', 'expired', 'wrong-account'] as const)('refuses %s credentials without API-key fallback or outbound requests', async kind => {
  const f = fixture();
  f.replace(kind === 'absent' ? undefined : kind === 'generic' ? { ...original, subscription: undefined }
    : kind === 'copilot' ? { ...original, subscription: { provider: 'github-copilot', availableModelIds: [OPENAI_CODEX_MODELS[0].id] } }
    : kind === 'expired' ? { ...original, expiresAt: 1 } : { ...original, subscription: { provider: 'openai-codex', accountId: 'other' } });
  await expect(f.provider.chat([user])).rejects.toThrow('OpenAI Codex request failed.');
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(['pre-aborted', 'pending-read'] as const)('cancels an owned catalogue body after %s without awaiting hostile cancellation', async stage => {
  const caller = new AbortController(), cancelled = vi.fn(() => new Promise<void>(() => undefined));
  let reached!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"models":[')); },
    pull() { reached(); return new Promise<void>(() => undefined); }, cancel: cancelled,
  }));
  if (stage === 'pre-aborted') caller.abort();
  const pending = openAICodexAccountModels(response, caller.signal);
  const failure = expect(pending).rejects.toThrow('Invalid OpenAI Codex catalogue.');
  if (stage === 'pending-read') { await reading; caller.abort(); }
  await failure; expect(cancelled).toHaveBeenCalledTimes(1);
});

it.each(['discovery', 'turn'] as const)('retires an owned catalogue body on network-scope shutdown during %s', async mode => {
  const f = fixture(), scope = createProviderNetworkScope(), cancelled = vi.fn(() => new Promise<void>(() => undefined));
  const provider = new OpenAICodexProvider(Object.assign({ type: 'openai-codex', model: OPENAI_CODEX_MODELS[0].id }, { [PROVIDER_NETWORK_SCOPE]: scope }), f.source);
  let reached!: () => void, finish!: () => void, upstream: AbortSignal | null | undefined;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  f.fetcher.mockImplementationOnce(async (url, init) => {
    expect(String(url)).toBe(OPENAI_CODEX_MODELS_URL); upstream = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"models":[')); finish = () => controller.close(); },
      pull() { reached(); return new Promise<void>(() => undefined); }, cancel: cancelled,
    }));
  });
  const pending = (mode === 'discovery' ? provider.getAvailableModels() : provider.chat([user])).catch((error: unknown) => error);
  try {
    await reading; await closeProviderNetworkDispatchers(scope, { permanent: true });
    expect(upstream?.aborted).toBe(true);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
    expect(await pending).toBeInstanceOf(Error); expect(f.fetcher).toHaveBeenCalledOnce();
  } finally {
    await closeProviderNetworkDispatchers(scope, { permanent: true });
    try { finish(); } catch { /* Already cancelled streams are closed. */ }
    await pending;
  }
});

it('does not publish old catalogue IDs after scope reset during credential readback', async () => {
  const f = fixture(), scope = createProviderNetworkScope();
  const provider = new OpenAICodexProvider(Object.assign({ type: 'openai-codex', model: OPENAI_CODEX_MODELS[0].id }, { [PROVIDER_NETWORK_SCOPE]: scope }), f.source);
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.source.mockImplementationOnce(async () => original).mockImplementationOnce(async () => { reached(); await held; return original; });
  const pending = provider.getAvailableModels().catch((error: unknown) => error);
  try {
    await ready; await closeProviderNetworkDispatchers(scope); release();
    expect(await pending).toBeInstanceOf(Error); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(await provider.getAvailableModels()).toEqual(OPENAI_CODEX_MODELS.map(model => model.id));
  } finally { release(); await pending; await closeProviderNetworkDispatchers(scope, { permanent: true }); }
});

it.each(['discovery', 'turn'] as const)('retires %s held in initial credential resolution across a scope reset', async mode => {
  const f = fixture(), scope = createProviderNetworkScope();
  const provider = new OpenAICodexProvider(Object.assign({ type: 'openai-codex', model: OPENAI_CODEX_MODELS[0].id }, { [PROVIDER_NETWORK_SCOPE]: scope }), f.source);
  let reached!: () => void, release!: () => void, borrowed: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.source.mockImplementationOnce(async (signal?: AbortSignal) => { borrowed = signal; reached(); await held; return original; });
  const pending = (mode === 'discovery' ? provider.getAvailableModels() : provider.chat([user])).catch((error: unknown) => error);
  try {
    await ready; await closeProviderNetworkDispatchers(scope); release();
    expect(await pending).toBeInstanceOf(Error); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.source).toHaveBeenCalledOnce();
    if (mode === 'discovery') expect(borrowed?.aborted).toBe(true);
    expect(await provider.getAvailableModels()).toEqual(OPENAI_CODEX_MODELS.map(model => model.id)); expect(f.fetcher).toHaveBeenCalledOnce();
  } finally { release(); await pending; await closeProviderNetworkDispatchers(scope, { permanent: true }); }
});

it('retires publication held in a chunk consumer across a scope reset', async () => {
  const f = fixture(), scope = createProviderNetworkScope(), caller = new AbortController();
  const provider = new OpenAICodexProvider(Object.assign({ type: 'openai-codex', model: OPENAI_CODEX_MODELS[0].id }, { [PROVIDER_NETWORK_SCOPE]: scope }), f.source);
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const completed = vi.fn(), failed = vi.fn(), chunks: string[] = [];
  const pending = provider.streamChat([user], async text => { chunks.push(text); reached(); await held; }, completed, failed, { signal: caller.signal });
  try {
    await ready; await closeProviderNetworkDispatchers(scope); release(); await pending;
    expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0]).toMatchObject({ message: 'OpenAI Codex request cancelled.' });
    expect(chunks).toHaveLength(1); expect(caller.signal.aborted).toBe(false);
    expect((await provider.chat([user])).content).toBe('ok');
    expect(f.calls.map(call => call.url)).toEqual([OPENAI_CODEX_MODELS_URL, OPENAI_CODEX_RESPONSES_URL, OPENAI_CODEX_MODELS_URL, OPENAI_CODEX_RESPONSES_URL]);
  } finally { release(); await pending; await closeProviderNetworkDispatchers(scope, { permanent: true }); }
});

it.each(['scope', 'caller'] as const)('cancels the owned CX inference body on %s retirement without awaiting hostile cancellation', async retirement => {
  const f = fixture(), scope = createProviderNetworkScope(), caller = new AbortController(), cancelled = vi.fn(() => new Promise<void>(() => undefined));
  const provider = new OpenAICodexProvider(Object.assign({ type: 'openai-codex', model: OPENAI_CODEX_MODELS[0].id }, { [PROVIDER_NETWORK_SCOPE]: scope }), f.source);
  let reached!: () => void, finish!: () => void, upstream: AbortSignal | null | undefined, hold = true;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  const sourceSignals: Array<AbortSignal | undefined> = [];
  f.source.mockImplementation(async (signal?: AbortSignal) => { sourceSignals.push(signal); return original; });
  f.fetcher.mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + accessToken);
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe(accountId);
    if (String(url) === OPENAI_CODEX_MODELS_URL) return catalogue();
    expect(String(url)).toBe(OPENAI_CODEX_RESPONSES_URL);
    if (!hold) return sse();
    upstream = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: ')); finish = () => controller.close(); },
      pull() { reached(); return new Promise<void>(() => undefined); }, cancel: cancelled,
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const chunk = vi.fn(), completed = vi.fn(), failed = vi.fn();
  const pending = provider.streamChat([user], chunk, completed, failed, { signal: caller.signal });
  try {
    await reading;
    if (retirement === 'scope') await closeProviderNetworkDispatchers(scope); else caller.abort();
    expect(upstream?.aborted).toBe(true); expect(caller.signal.aborted).toBe(retirement === 'caller');
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce()); await pending;
    expect(chunk).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0]).toMatchObject({ message: 'OpenAI Codex request cancelled.' }); expect(sourceSignals[0]).toBe(caller.signal);
    hold = false;
    const next = caller.signal.aborted ? new AbortController() : caller;
    expect((await provider.chat([user], { signal: next.signal })).content).toBe('ok');
    expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([OPENAI_CODEX_MODELS_URL, OPENAI_CODEX_RESPONSES_URL, OPENAI_CODEX_MODELS_URL, OPENAI_CODEX_RESPONSES_URL]);
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.source).toHaveBeenCalledTimes(4);
  } finally {
    try { finish(); } catch { /* Already cancelled streams are closed. */ }
    await pending; await closeProviderNetworkDispatchers(scope, { permanent: true });
  }
});

it('rechecks local credential withdrawal after a held account discovery before inference', async () => {
  const f = fixture(); let release!: (value: Response) => void, reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  f.fetcher.mockImplementationOnce(() => { reached(); return new Promise<Response>(resolve => { release = resolve; }); });
  const pending = f.provider.chat([user]).catch(error => error);
  await ready; f.replace(undefined); release(catalogue());
  expect(await pending).toBeInstanceOf(Error); expect(f.fetcher).toHaveBeenCalledOnce();
});

it('requires successful terminal authority and awaits completion/cancellation callbacks', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(catalogue()).mockResolvedValueOnce(sse(reference.responseEvents.slice(0, -1)));
  await expect(f.provider.chat([user])).rejects.toThrow('OpenAI Codex request failed.');
  const caller = new AbortController(), complete = vi.fn(), failure = vi.fn();
  await f.provider.streamChat([user], async () => { await Promise.resolve(); caller.abort(); }, complete, failure, { signal: caller.signal });
  expect(complete).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce();
});

it('retains native composite tool IDs and accepts paired text tool results', async () => {
  const f = fixture();
  const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'echo', arguments: '{"x":1}' };
  f.fetcher.mockResolvedValueOnce(catalogue()).mockResolvedValueOnce(sse([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
  ]));
  const reply = await f.provider.chat([user]);
  expect(reply.toolCalls).toEqual([{ id: 'call_fixture|fc_fixture', name: 'echo', input: { x: 1 } }]);
  await f.provider.chat([user, { id: 'assistant', role: 'assistant', content: '', timestamp: new Date(2), toolCalls: reply.toolCalls,
      provider: 'openai-codex', api: 'openai-codex-responses', model: OPENAI_CODEX_MODELS[0].id },
    { id: 'result', role: 'tool', toolCallId: 'call_fixture|fc_fixture', content: 'result', timestamp: new Date(3) }]);
  expect(f.calls.at(-1)?.body?.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'probe' }] },
    { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'echo', arguments: '{"x":1}' },
    { type: 'function_call_output', call_id: 'call_fixture', output: 'result' },
  ]);
});

it('does not finish before the asynchronous completion callback settles', async () => {
  const f = fixture(); let release!: () => void, reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  const pending = f.provider.streamChat([user], () => {}, async () => { reached(); await held; }).then(() => { finished = true; });
  await entered; expect(finished).toBe(false); release(); await pending; expect(finished).toBe(true);
});

it('does not grant generic OpenAI private replay and refuses unsupported explicit WebSocket transport', async () => {
  expect(() => new OpenAICodexProvider({ type: 'openai', model: OPENAI_CODEX_MODELS[0].id, transport: 'websocket' }, async () => original)).toThrow('WebSocket');
  const f = fixture();
  await f.provider.chat([{ ...user, role: 'assistant', provider: 'openai', api: 'openai-responses', model: OPENAI_CODEX_MODELS[0].id,
    blocks: [{ type: 'reasoning', text: 'visible', thinkingSignature: 'private-ciphertext' }] }, user]);
  expect(JSON.stringify(f.calls[1].body)).not.toContain('private-ciphertext');
});

it('binds pinned Codex strict/grammar capabilities without trusting account catalogue metadata', () => {
  expect(constrained.capabilities).toEqual(OPENAI_CODEX_MODELS.map(model => ({ model: model.id, strict: true, grammar: true })));
  expect(reference.models.every(model => (model.compat as Record<string, unknown>)?.supportsOpenAIGrammarTools === true)).toBe(true);
});

it.each(constrained.rows)('projects or refuses constrained $model/$case against the independent SDK capture', async row => {
  const f = fixture(), options: OpenAICodexChatOptions = { model: row.model, tools: [row.tool] };
  const before = structuredClone(options);
  for (const stream of [false, true]) {
    f.calls.length = 0;
    const call = async () => {
      if (!stream) return f.provider.chat([user], options);
      await f.provider.streamChat([user], () => {}, undefined, error => { throw error; }, options);
      return undefined;
    };
    if (row.refused) {
      await expect(call()).rejects.toThrow('OpenAI Codex request failed.');
      expect(f.calls.map(call => call.url)).toEqual([OPENAI_CODEX_MODELS_URL]);
    } else {
      await call(); expect(f.calls.at(-1)?.body).toEqual(row.body);
    }
    expect(options).toEqual(before);
  }
});

it('refuses constrained tools on derived facades and malformed grammar input before publication', async () => {
  const f = fixture(), row = constrained.rows.find(row => row.case === 'lark')!;
  class Derived extends OpenAICodexProvider {}
  const derived = new Derived({ type: 'openai-codex', model: row.model }, f.source);
  Object.assign(derived, { ownsNativeProfiles: true });
  await expect(derived.chat([user], { tools: [row.tool] })).rejects.toThrow('OpenAI Codex request failed.');
  expect(f.calls.every(call => call.url === OPENAI_CODEX_MODELS_URL)).toBe(true);
  const complete = vi.fn(), failed = vi.fn();
  const malformed = constrained.events.map(event => event.type === 'response.output_item.done'
    ? { ...event, item: { ...(event.item as Record<string, unknown>), input: 42 } } : event);
  f.fetcher.mockResolvedValueOnce(catalogue()).mockResolvedValueOnce(sse(malformed));
  await f.provider.streamChat([user], () => {}, complete, failed, { model: row.model, tools: [row.tool] });
  expect(complete).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
});

it.each(['gpt-5.3-codex-spark', 'gpt-6.1-sol'])('%s maps raw grammar input and paired native/foreign/function replay on both facades', async model => {
  const f = fixture(), grammarTool = constrained.rows.find(row => row.model === model && row.case === 'lark')!.tool;
  for (const stream of [false, true]) {
    const call = async (messages: Message[], tools = [grammarTool]) => {
      if (!stream) return f.provider.chat(messages, { model, tools });
      let result: ChatResponse | undefined;
      await f.provider.streamChat(messages, () => {}, value => { result = value; }, error => { throw error; }, { model, tools });
      return result!;
    };
    f.fetcher.mockResolvedValueOnce(catalogue()).mockResolvedValueOnce(sse(constrained.events));
    const first = await call([user]);
    expect(first.toolCalls).toEqual([{ id: 'call_native|ctc_native', name: 'echo', input: { source: constrained.raw } }]);
    expect(first.blocks).toEqual([{ type: 'tool_call', ...first.toolCalls![0] }]);
    for (const vector of constrained.replays.filter(row => row.model === model)) {
      const assistant: Message = { id: 'assistant', role: 'assistant', content: first.content, blocks: structuredClone(first.blocks),
        toolCalls: structuredClone(first.toolCalls), provider: 'openai-codex', api: 'openai-codex-responses', model, timestamp: new Date(2) };
      if (vector.case === 'foreign-provider') assistant.provider = 'openai';
      if (vector.case === 'foreign-model') assistant.model = 'other';
      const history: Message[] = [user, assistant, { id: 'result', role: 'tool', name: 'echo', toolCallId: 'call_native|ctc_native', content: 'result', timestamp: new Date(3) }];
      const before = structuredClone(history);
      await call(history, vector.case === 'function' ? [{ ...grammarTool, constrainedSampling: false }] : [grammarTool]);
      expect(f.calls.at(-1)?.body?.input, vector.case).toEqual(vector.expected); expect(history).toEqual(before);
    }
  }
});
