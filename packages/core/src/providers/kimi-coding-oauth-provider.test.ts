import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as providers from './index.js';
import type { ProviderOAuthCredential } from './credentials.js';
import type { Message } from '../types/index.js';
import { JsonlSessionStore, SessionManager } from '../sessions/session-manager.js';
import { createProviderNetworkScope, closeProviderNetworkDispatchers, PROVIDER_NETWORK_SCOPE } from './provider-network.js';
const reference = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/kimi-coding-continuation-reference.json', import.meta.url), 'utf8'));
const user: Message = { id: 'u', role: 'user', content: 'probe', timestamp: new Date(0) }, host = 'https://issuer.kimi.test';
const grant = { provider: 'kimi-coding', oauthHost: host, grantId: '12345678-1234-4234-8234-123456789abc' } as const;
const credential = (token = 'synthetic-native-access'): ProviderOAuthCredential => ({ version: 1, type: 'oauth', accessToken: token, refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000, subscription: { ...grant } });
const config = { type: 'kimi-coding', model: 'k3', baseUrl: 'https://inference.kimi.test/coding', oauthHost: host, customHeaders: { 'x-tenant': 'synthetic-tenant' } };
const options = { maxTokens: 64, thinking: 'low' as const, cacheRetention: 'none' as const, tools: reference.tools };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function wire() {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init!.body)); calls.push({ url: String(url), headers: new Headers(init!.headers), body });
    return body.stream ? new Response(reference.seedEvents.map((event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ model: 'untrusted-alias', stop_reason: 'tool_use', content: reference.syntheticJsonContent, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } });
  }); return calls;
}
async function invoke(provider: providers.KimiCodingOAuthProvider, history: Message[], facade: 'chat' | 'stream', requestOptions: providers.ChatOptions = options) {
  if (facade === 'chat') return provider.chat(history, requestOptions);
  let result: providers.ChatResponse | undefined;
  await provider.streamChat(history, (_text, event) => { expect(JSON.stringify(event ?? {})).not.toContain('synthetic-native-access'); }, value => { result = value; }, error => { throw error; }, requestOptions);
  expect(result).toBeDefined(); return result!;
}
it.each(['chat', 'stream'] as const)('uses live native Kimi %s credentials and same-grant signed0600 restart/replay without mutating history', async facade => {
  expect(typeof providers.KimiCodingOAuthProvider).toBe('function'); const calls = wire(); let current = credential();
  const source = vi.fn(async () => current), provider = new providers.KimiCodingOAuthProvider(config, source), response = await invoke(provider, [user], facade);
  expect(response).toMatchObject({ provider: 'kimi-coding', model: 'k3', api: 'anthropic-messages', content: 'left!right?' });
  expect(calls[0].headers.get('authorization')).toBe('Bearer synthetic-native-access'); expect(calls[0].headers.get('x-api-key')).toBeNull();
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-live-')); roots.push(root); const manager = new SessionManager({ store: new JsonlSessionStore(root) }), session = await manager.create({ title: 'Native Kimi' });
  await manager.addMessage(session.id, { role: 'user', content: user.content });
  await manager.addMessage(session.id, { role: 'assistant', content: response.content, blocks: response.blocks, toolCalls: response.toolCalls, provider: response.provider, api: response.api, model: response.model });
  await manager.addMessage(session.id, { role: 'tool', content: 'result', name: 'echo', toolCallId: 'call' });
  const file = path.join(root, session.id + '.jsonl'); expect((await stat(file)).mode & 0o777).toBe(0o600); expect(await readFile(file, 'utf8')).not.toContain('synthetic-native-access');
  const reopened = new SessionManager({ store: new JsonlSessionStore(root) }), loaded = (await reopened.loadFromStore(session.id))!, before = structuredClone(loaded.messages);
  current = credential('synthetic-rotated-access'); await invoke(new providers.KimiCodingOAuthProvider(config, source), loaded.messages, facade, { ...options, model: '' });
  expect(calls[1].headers.get('authorization')).toBe('Bearer synthetic-rotated-access'); expect(JSON.stringify(calls[1].body.messages)).toContain('opaque-signature'); expect(JSON.stringify(calls[1].body.messages)).not.toContain('ai-harness:kimi-oauth'); expect(loaded.messages).toEqual(before);
});
it('isolates native Kimi private grants from changed grant/header/endpoint/model/derived receivers and the legacy API-key lane', async () => {
  const calls = wire(), source = async () => credential(), original = new providers.KimiCodingOAuthProvider(config, source), response = await original.chat([user], options);
  const history: Message[] = [user, { id: 'a', role: 'assistant', content: response.content, blocks: response.blocks, toolCalls: response.toolCalls, provider: response.provider, model: response.model, api: response.api, timestamp: new Date(0) }, { id: 'r', role: 'tool', toolCallId: 'call', name: 'echo', content: 'result', timestamp: new Date(0) }], before = structuredClone(history);
  class Derived extends providers.KimiCodingOAuthProvider {}
  const otherGrant = async () => ({ ...credential(), subscription: { ...grant, grantId: '87654321-4321-4321-8321-cba987654321' } });
  for (const receiver of [new providers.KimiCodingOAuthProvider(config, otherGrant), new providers.KimiCodingOAuthProvider({ ...config, customHeaders: { 'x-tenant': 'other' } }, source), new providers.KimiCodingOAuthProvider({ ...config, baseUrl: 'https://other.kimi.test/coding' }, source), new providers.KimiCodingOAuthProvider({ ...config, model: 'kimi-for-coding' }, source), new Derived(config, source), new providers.KimiCodingProvider({ ...config, apiKey: 'synthetic-key' })]) {
    await receiver.chat(history, options); expect(JSON.stringify(calls.at(-1)!.body.messages)).not.toContain('opaque-'); expect(history).toEqual(before);
  }
});
it('refuses invalid model/output/image inputs before live credential resolution or inference', async () => {
  const calls = wire(), source = vi.fn(async () => credential()), provider = new providers.KimiCodingOAuthProvider(config, source);
  await expect(provider.chat([user], { ...options, model: 'unknown' })).rejects.toThrow('Kimi');
  await expect(provider.chat([user], { ...options, maxTokens: 0 })).rejects.toThrow('Kimi');
  await expect(provider.chat([{ ...user, blocks: [{ type: 'image', mediaType: 'image/png', url: 'https://unrepresentable.test/image.png' }] }], options)).rejects.toThrow('Kimi');
  expect(source).not.toHaveBeenCalled(); expect(calls).toEqual([]);
});
it('refuses expired, generic, foreign-issuer and foreign-realm sources before inference without API-key fallback', async () => {
  const calls = wire();
  for (const value of [undefined, { ...credential(), expiresAt: 1 }, { ...credential(), subscription: undefined }, { ...credential(), subscription: { ...grant, oauthHost: 'https://other.kimi.test' } }]) {
    const provider = new providers.KimiCodingOAuthProvider({ ...config, apiKey: 'unselected-key' }, async () => value);
    await expect(provider.chat([user], options)).rejects.toThrow('Kimi');
  }
  expect(calls).toEqual([]);
});
it('retires an uncooperative native Kimi resolver on scope replacement before transport and recovers on the new generation', async () => {
  const calls = wire(), scope = createProviderNetworkScope(); let waiting = true, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const provider = new providers.KimiCodingOAuthProvider({ ...config, [PROVIDER_NETWORK_SCOPE]: scope }, async () => { if (waiting) { entered(); return new Promise(() => undefined); } return credential(); });
  const pending = provider.chat([user], options).catch(error => error); await ready; await closeProviderNetworkDispatchers(scope);
  expect(await pending).toBeInstanceOf(Error); expect(calls).toEqual([]); waiting = false;
  expect(await provider.chat([user], options)).toMatchObject({ model: 'k3' }); await closeProviderNetworkDispatchers(scope);
});
it('retires an owned native Kimi inference body promptly on caller cancellation without waiting for hostile cancellation', async () => {
  const caller = new AbortController(); let cancel = 0, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(reference.seedEvents[0])}\n\n`)); entered(); }, cancel() { cancel++; return new Promise(() => undefined); } }), { headers: { 'content-type': 'text/event-stream' } }));
  const provider = new providers.KimiCodingOAuthProvider(config, async () => credential()); let completed = false;
  const pending = provider.streamChat([user], () => {}, () => { completed = true; }, error => { throw error; }, { ...options, signal: caller.signal }).catch(error => error);
  await ready; await new Promise<void>(resolve => setImmediate(resolve)); caller.abort(); expect(await pending).toBeInstanceOf(Error); await new Promise<void>(resolve => setImmediate(resolve)); expect(cancel).toBe(1); expect(completed).toBe(false);
});
it('withdraws native Kimi completion after I/O while preserving observed usage and permits a fresh request to recover', async () => {
  const calls = wire(); let reads = 0;
  const provider = new providers.KimiCodingOAuthProvider(config, async () => ++reads === 2 ? undefined : credential());
  let completed = false, failure: unknown;
  await provider.streamChat([user], () => {}, () => { completed = true; }, error => { failure = error; }, options);
  expect(completed).toBe(false); expect(failure).toMatchObject({ usage: { totalTokens: 14 } }); expect(calls).toHaveLength(1);
  expect(await provider.chat([user], options)).toMatchObject({ model: 'k3' }); expect(calls).toHaveLength(2);
});
