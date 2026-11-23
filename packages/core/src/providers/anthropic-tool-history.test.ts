import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, AnthropicOAuthProvider, type AiProvider, ExtensionRegistry, JsonlSessionStore, SessionManager, streamProviderTurn, type ChatResponse, type ChatToolDefinition, type Message } from '../../dist/index.js';
const roots: string[] = [], model = 'claude-opus-5', owner = 'native-tool-history';
const a: ChatToolDefinition[] = [{ name: 'lookup', description: 'old lookup', parameters: { type: 'object', properties: { old: { type: 'boolean' } } } }, { name: 'retired', description: 'retired tool', parameters: { type: 'object' } }];
const b: ChatToolDefinition[] = [{ name: 'lookup', description: 'new lookup', parameters: { type: 'object', properties: { next: { type: 'string' } } } }, { name: 'added', description: 'new tool', parameters: { type: 'object' } }];
const declaration = (tool: ChatToolDefinition) => ({ name: tool.name, description: tool.description, input_schema: { type: 'object', properties: tool.parameters.properties ?? {}, required: tool.parameters.required ?? [] }, eager_input_streaming: true });
function response() { const message = { type: 'message', role: 'assistant', model, usage: { input_tokens: 8, output_tokens: 2 } }; return new Response([{ type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'history-ready' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: message.usage }, { type: 'message_stop' }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } }); }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const provider = () => new AnthropicProvider({ type: owner, apiKey: 'synthetic-tool-history-key', model, baseUrl: 'https://anthropic.synthetic' });
const messages = (manager: SessionManager, id: string): Message[] => manager.getEffectiveContext(id).flatMap(entry => entry.type === 'message' ? [{ ...entry, timestamp: new Date(entry.timestamp) } as Message] : []);
async function turn(manager: SessionManager, id: string, value: AiProvider, tools: ChatToolDefinition[], registry = new ExtensionRegistry(), extra: Partial<Parameters<typeof streamProviderTurn>[0]> = {}) {
  return streamProviderTurn({ provider: value, providerName: owner, model, messages: messages(manager, id), tools, extensionRegistry: registry,
    sessionId: id, sessionManager: manager, thinking: 'high', maxTokens: 64, cacheRetention: 'none', cacheWarming: 'off', ...extra });
}
async function append(manager: SessionManager, id: string, result: ChatResponse) { return manager.addMessage(id, { role: 'assistant', content: result.content, blocks: result.blocks, toolCalls: result.toolCalls, provider: result.provider, model: result.model, api: result.api, metadata: { providerThinkingLevel: result.providerThinkingLevel ?? 'high' }, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }); }
it.each([false, true])('replays post-hook tool loadouts as native removals/redefinitions/additions, retaining root tools and current execution data (restart=%s)', async durable => {
  const root = durable ? await mkdtemp(path.join(os.tmpdir(), 'aih-tool-history-')) : undefined; if (root) roots.push(root); const store = root ? new JsonlSessionStore(root) : undefined;
  let manager = new SessionManager({ store }), value = provider(); const session = await manager.create(); await manager.addMessage(session.id, { role: 'user', content: 'first' }); const calls: Array<Record<string, any>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return response(); }));
  await append(manager, session.id, await turn(manager, session.id, value, a)); if (store) { manager = new SessionManager({ store }); await manager.loadFromStore(session.id); value = provider(); }
  await manager.addMessage(session.id, { role: 'user', content: 'next' }); const registry = new ExtensionRegistry(); await registry.load('post-hook-tools', api => api.before('before:provider', data => ({ ...data, options: { ...data.options, tools: b } })));
  try { await append(manager, session.id, await turn(manager, session.id, value, a, registry)); } finally { await registry.unloadAll(); }
  expect(calls[1].tools).toEqual(calls[0].tools); expect(calls[1].tools.slice(0, -1)).toEqual(a.map(declaration));
  const updates = calls[1].messages.filter((row: Record<string, any>) => row.role === 'system' && row.content.some((block: Record<string, any>) => block.type === 'tool_addition' || block.type === 'tool_removal'));
  expect(updates).toEqual([{ role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'retired' } }, ...b.map(tool => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition: declaration(tool) } }))] }]);
  expect(calls[1].messages.at(-2)).toEqual(updates[0]); expect(calls[1].messages.at(-1).output_config.effort).toBe('high'); expect(manager.getSessionLoadout(session.id)?.tools).toEqual(b); expect(manager.get(session.id)?.usage?.totalTokens).toBe(20);
});
it('keeps empty-initial-tool conversations on current flat declarations without enabling deferred native changes later', async () => {
  const manager = new SessionManager(), session = await manager.create(), value = provider(), calls: Array<{ body: Record<string, any>; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }); return response(); }));
  await manager.addMessage(session.id, { role: 'user', content: 'first' }); await append(manager, session.id, await turn(manager, session.id, value, [])); await manager.addMessage(session.id, { role: 'user', content: 'next' }); await turn(manager, session.id, value, b);
  expect(calls[1].body.tools).toEqual(b.map(declaration)); expect(calls[1].headers.get('anthropic-beta')?.split(',')).not.toContain('inline-tools-2026-09-15');
  expect(JSON.stringify(calls[1].body.messages)).not.toContain('tool_addition');
});
it('does not borrow abandoned branch or foreign-model loadouts for native history', async () => {
  const manager = new SessionManager(), session = await manager.create(), value = provider(), calls: Array<Record<string, any>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return response(); }));
  await manager.addMessage(session.id, { role: 'user', content: 'root' }); const user = session.messages.at(-1)!; await append(manager, session.id, await turn(manager, session.id, value, a)); expect(await manager.navigateTree(session.id, user.id)).toMatchObject({ status: 'navigated' });
  await turn(manager, session.id, value, b); expect(calls[1].tools.slice(0, -1)).toEqual(b.map(declaration)); expect(JSON.stringify(calls[1].messages)).not.toContain('retired');
  for (const foreign of [{ provider: 'foreign-owner', model }, { provider: owner, model: 'claude-haiku-5-5' }]) {
    await manager.recordSessionLoadout(session.id, { ...foreign, tools: a, systemPrompt: '', thinking: 'high' }); await manager.addMessage(session.id, { role: 'user', content: 'reset' });
    await turn(manager, session.id, value, b); expect(calls.at(-1)!.tools.slice(0, -1)).toEqual(b.map(declaration)); expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('retired');
  }
});
it('counts historical declaration payload against owned context admission instead of bypassing the budget with private data', async () => {
  const manager = new SessionManager(), session = await manager.create(), value = provider(), fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
  await manager.addMessage(session.id, { role: 'user', content: 'first' }); await append(manager, session.id, await turn(manager, session.id, value, [{ ...a[0], description: 'x'.repeat(8000) }])); await manager.addMessage(session.id, { role: 'user', content: 'next' });
  await expect(turn(manager, session.id, value, b, new ExtensionRegistry(), { contextBudget: { contextWindow: 1000, reserveTokens: 10 } })).rejects.toThrow('owned context budget'); expect(fetch).toHaveBeenCalledTimes(1);
});
function signedResponse(name: string) {
  const events = [{ type: 'message_start', message: { type: 'message', role: 'assistant', model, usage: { input_tokens: 8, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'prior thought' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-tool-history-signature' } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'history-call', name, input: {} } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"old":true}' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}
it.each([false, true])('preserves signed tool adjacency, all-removed eligibility and re-addition through the native owner (OAuth=%s)', async oauth => {
  const manager = new SessionManager(), session = await manager.create(), initial = [{ ...a[0], name: 'read' }, a[1]], latest = [{ ...b[0], name: 'read' }, b[1]], calls: Array<{ body: Record<string, any>; headers: Headers }> = [];
  let credential = { version: 1 as const, type: 'oauth' as const, accessToken: 'synthetic-history-token', refreshToken: 'synthetic-history-refresh', expiresAt: Date.now() + 3600000, subscription: { provider: 'anthropic' as const, grantId: '12345678-1234-4234-8234-123456789abc' } };
  const value = oauth ? new AnthropicOAuthProvider({ type: owner, model, baseUrl: 'https://anthropic.synthetic' }, async () => credential) : provider(), name = oauth ? 'Read' : 'read';
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { calls.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }); return calls.length === 1 ? signedResponse(name) : response(); }));
  await manager.addMessage(session.id, { role: 'user', content: 'first' }); await append(manager, session.id, await turn(manager, session.id, value, initial, undefined, { thinking: 'low' }));
  await manager.recordSessionLoadout(session.id, { provider: owner, model, tools: [], systemPrompt: '', thinking: 'low' }); await manager.addMessage(session.id, { role: 'tool', content: 'tool result', toolCallId: 'history-call', name: 'read' }); await manager.addMessage(session.id, { role: 'user', content: 'next' }); credential = { ...credential, accessToken: 'synthetic-history-rotated' };
  await append(manager, session.id, await turn(manager, session.id, value, [])); const wire = calls[1].body, index = wire.messages.findIndex((row: Record<string, any>) => row.role === 'assistant');
  expect(wire.messages[index].content).toContainEqual({ type: 'thinking', thinking: 'prior thought', signature: 'private-tool-history-signature' }); expect(wire.messages[index + 1].content).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'history-call' }));
  expect(wire.tools).toEqual(calls[0].body.tools); expect(calls[1].headers.get('anthropic-beta')).toContain('inline-tools-2026-09-15'); expect(wire.messages.at(-2).content).toEqual([{ type: 'tool_removal', tool: { type: 'tool_reference', name } }, { type: 'tool_removal', tool: { type: 'tool_reference', name: 'retired' } }]);
  await manager.addMessage(session.id, { role: 'user', content: 're-add' }); await turn(manager, session.id, value, latest); const updates = calls[2].body.messages.filter((row: Record<string, any>) => Array.isArray(row.content) && row.content.some((block: Record<string, any>) => ['tool_addition', 'tool_removal'].includes(block.type)));
  expect(updates).toHaveLength(2); expect(updates[1].content).toEqual(latest.map(tool => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition: { ...declaration(tool), name: tool.name === 'read' ? name : tool.name } } }))); expect(manager.getSessionLoadout(session.id)?.tools).toEqual(latest);
});
it('uses a compaction checkpoint as the new root instead of reviving compacted tool declarations', async () => {
  const manager = new SessionManager(), session = await manager.create(), value = provider(), calls: Array<Record<string, any>> = []; vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return response(); });
  await manager.addMessage(session.id, { role: 'user', content: 'first' }); await append(manager, session.id, await turn(manager, session.id, value, a)); const retained = session.messages.at(-1)!.id;
  await manager.recordSessionLoadout(session.id, { provider: owner, model, tools: b, systemPrompt: '', thinking: 'high' }); await manager.applyCompaction(session.id, 'Private tool checkpoint', retained); await manager.addMessage(session.id, { role: 'user', content: 'after checkpoint' }); await turn(manager, session.id, value, a);
  expect(calls[1].tools.slice(0, -1)).toEqual(b.map(declaration)); expect(calls[1].messages.at(-2).content[0]).toEqual({ type: 'tool_removal', tool: { type: 'tool_reference', name: 'added' } });
});
it('does not give superseded unobserved loadouts permanent initial-tool authority', async () => {
  const manager = new SessionManager(), session = await manager.create(), value = provider(), calls: Array<Record<string, any>> = []; vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return response(); }); await manager.addMessage(session.id, { role: 'user', content: 'recover' });
  await manager.recordSessionLoadout(session.id, { provider: owner, model, tools: [{ ...a[0], name: '__aih_deferred_placeholder__' }], systemPrompt: '', thinking: 'high' }); await turn(manager, session.id, value, b);
  expect(calls).toHaveLength(1); expect(calls[0].tools.slice(0, -1)).toEqual(b.map(declaration)); expect(JSON.stringify(calls[0].messages)).not.toContain('tool_addition');
});
it.each(['abort', 'branch'] as const)('retires the additional history read without publishing a late request or retrying on a new branch (%s)', async mode => {
  const manager = new SessionManager(), session = await manager.create(), value = provider(), controller = new AbortController(), fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch); await manager.addMessage(session.id, { role: 'user', content: 'pending' }); const user = session.messages.at(-1)!.id;
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), original = manager.getActiveBranchEntries.bind(manager); vi.spyOn(manager, 'getActiveBranchEntries').mockImplementation(async id => { enter(); await gate; return original(id); });
  const operation = turn(manager, session.id, value, a, undefined, { signal: controller.signal }).catch(error => error); await entered;
  try {
    if (mode === 'abort') { controller.abort(); expect(await Promise.race([operation.then(() => 'settled'), new Promise(resolve => setImmediate(() => resolve('pending')))])).toBe('settled'); }
    else { expect(await manager.navigateTree(session.id, user)).toMatchObject({ status: 'navigated' }); release(); }
    expect(await operation).toBeInstanceOf(Error); expect(fetch).not.toHaveBeenCalled();
  } finally { release(); await operation; }
});
