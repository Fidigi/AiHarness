import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicProvider, KimiCodingProvider, type AnthropicProviderConfig } from './index.js';
import { closeProviderNetworkDispatchers, createProviderNetworkScope, PROVIDER_NETWORK_SCOPE } from './provider-network.js';
import type { Message } from '../types/index.js';

const model = 'claude-sonnet-4-6', base = 'https://synthetic-wif.test/prefix';
const messages: Message[] = [{ id: 'user', role: 'user', content: 'Hello', timestamp: new Date(0) }];
const reply = () => new Response(JSON.stringify({ id: 'a', type: 'message', role: 'assistant', model,
  content: [{ type: 'thinking', thinking: 'private', signature: 'synthetic-signature' }, { type: 'text', text: 'WIF reply' }],
  stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
const minted = (token = 'synthetic-access', seconds = 3600) => new Response(JSON.stringify({ access_token: token, expires_in: seconds, token_type: 'Bearer' }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-wif-')); roots.push(root); const file = path.join(root, 'identity.jwt'); await writeFile(file, 'synthetic.jwt.assertion\n');
  const config: AnthropicProviderConfig = { type: 'anthropic', baseUrl: base, model, anthropicFederation: { federationRuleId: 'fdrl-synthetic', organizationId: 'org-synthetic', identityTokenFile: file, serviceAccountId: 'svac-synthetic', workspaceId: 'workspace-synthetic' } };
  return { file, config, provider: new AnthropicProvider(config) };
}

it('uses explicit frozen workload config, passive metadata, projected-token rotation and cached native A without Claude subscription identity', async () => {
  const f = await fixture(), target = f.file + '.target'; f.config.baseUrl = base + '/'; f.provider = new AnthropicProvider(f.config); await writeFile(target, 'synthetic.jwt.assertion\n'); await rm(f.file); await symlink(target, f.file);
  let now = Date.now(), serial = 0; vi.spyOn(Date, 'now').mockImplementation(() => now); vi.stubEnv('ANTHROPIC_PROFILE', '/not-a-personal-profile');
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []; vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers); requests.push({ url: String(url), body });
    if (String(url) === base + '/v1/oauth/token') {
      expect(init?.redirect).toBe('manual'); expect(headers.has('authorization')).toBe(false); expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20,oidc-federation-2026-04-01');
      expect(body).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serial ? 'rotated.jwt.assertion' : 'synthetic.jwt.assertion', federation_rule_id: 'fdrl-synthetic', organization_id: 'org-synthetic', service_account_id: 'svac-synthetic', workspace_id: 'workspace-synthetic' }); return minted('access-' + ++serial);
    }
    expect(String(url)).toBe(base + '/v1/messages'); expect(headers.get('authorization')).toBe('Bearer access-' + serial); expect(headers.has('x-api-key')).toBe(false); expect(headers.get('anthropic-beta')).toContain('oauth-2025-04-20'); expect(headers.get('anthropic-beta')).not.toContain('oidc-federation'); expect(headers.has('x-app')).toBe(false); expect(headers.get('user-agent') ?? '').not.toContain('claude-cli'); expect(body.system).toBeUndefined(); return reply();
  });
  expect(f.provider.validateConfig()).toBe(true); expect(f.provider.getPublishedModels()?.some(row => row.id === model)).toBe(true); expect(await f.provider.getAvailableModels({ allowNetwork: false })).toEqual([]); expect(requests).toEqual([]);
  f.config.anthropicFederation!.organizationId = 'changed'; f.config.baseUrl = 'https://unowned.test';
  const first = await f.provider.chat(messages, { thinking: 'off', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }] }); expect((requests[1].body.tools as Array<{ name: string }>)[0].name).toBe('read'); expect(first).toMatchObject({ content: 'WIF reply', api: 'anthropic-messages', usage: { totalTokens: 10, costUsd: 0.000054 } });
  const history: Message[] = [...messages, { id: 'assistant', role: 'assistant', content: first.content, blocks: first.blocks, model, provider: 'anthropic', api: first.api, timestamp: new Date(0) }];
  await f.provider.chat(history, { thinking: 'off' }); expect(requests).toHaveLength(3); expect(JSON.stringify(requests[2].body)).toContain('synthetic-signature');
  await writeFile(target, 'rotated.jwt.assertion'); now += 3_590_000; await f.provider.chat(messages, { thinking: 'off' }); expect(serial).toBe(2); expect(requests).toHaveLength(5);
});

it('keeps keys/header-owned auth and other actual constructors out of the workload chain and rejects invalid native preflight before file I/O', async () => {
  const f = await fixture(), invalid = { ...f.config, anthropicFederation: { ...f.config.anthropicFederation!, identityTokenFile: '/does-not-exist' } };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-ant-oat01-actually-an-api-key'); return reply(); });
  await new AnthropicProvider({ ...invalid, apiKey: 'sk-ant-oat01-actually-an-api-key' }).chat(messages, { thinking: 'off' }); expect(fetcher).toHaveBeenCalledTimes(1);
  const headerOwned = new AnthropicProvider({ ...invalid, customHeaders: { Authorization: 'Bearer synthetic-owned' } }); expect(headerOwned.validateConfig()).toBe(false); await expect(headerOwned.chat(messages)).rejects.toThrow('API key');
  const derived = new KimiCodingProvider({ ...invalid, model: 'kimi-for-coding' }); expect(derived.validateConfig()).toBe(false); await expect(derived.chat(messages)).rejects.toThrow('API key');
  await expect(new AnthropicProvider(invalid).chat(messages, { maxTokens: 1_000_000, thinking: 'off' })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(() => new AnthropicProvider({ ...invalid, baseUrl: 'http://remote.invalid' })).toThrow('workload authentication'); expect(() => new AnthropicProvider({ ...invalid, anthropicFederation: { ...invalid.anthropicFederation, organizationId: '' } })).toThrow('workload authentication');
});

it('re-exchanges once after authenticated 401 and keeps SSE native usage without a refresh token', async () => {
  const f = await fixture(); let exchanges = 0, calls = 0; vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/oauth/token')) { expect(JSON.parse(String(init?.body)).grant_type).not.toBe('refresh_token'); return minted('access-' + ++exchanges); }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-' + exchanges); if (++calls === 1) return new Response('unauthorized', { status: 401 });
    if (!JSON.parse(String(init?.body)).stream) return reply();
    return new Response([{ type: 'message_start', message: { id: 's', model, content: [], usage: { input_tokens: 8, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'stream' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  await f.provider.chat(messages, { thinking: 'off' }); let content = '', usage: unknown; await f.provider.streamChat(messages, chunk => { content += chunk; }, result => { usage = result?.usage; }, undefined, { thinking: 'off' }); expect(content).toBe('stream'); expect(usage).toMatchObject({ totalTokens: 10, costUsd: 0.000054 }); expect(exchanges).toBe(2); expect(calls).toBe(3);
});

it('uses advisory stale tokens only outside the mandatory window, retries foreground with rotated file and redacts exchange errors', async () => {
  const f = await fixture(); let now = Date.now(), exchanged = false, calls = 0; vi.spyOn(Date, 'now').mockImplementation(() => now); vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).endsWith('/oauth/token')) { if (!exchanged) { exchanged = true; return minted('access', 1000); } return new Response('echo synthetic.jwt.assertion access', { status: 503 }); }
    calls++; return reply();
  });
  await f.provider.chat(messages, { thinking: 'off' }); now += 910_000; await f.provider.chat(messages, { thinking: 'off' }); expect(calls).toBe(2); now += 80_000; await expect(f.provider.chat(messages, { thinking: 'off' })).rejects.toThrow(/^Anthropic workload authentication failed\.$/); expect(calls).toBe(2);
});

it('isolates configs and caller cancellation without an older completion overwriting a newer successful token', async () => {
  const f = await fixture(), controller = new AbortController(); const held: Array<(response: Response) => void> = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { if (String(url).endsWith('/oauth/token')) return new Promise<Response>(resolve => held.push(resolve)); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer valid-other-caller'); return reply(); });
  const first = f.provider.chat(messages, { signal: controller.signal, thinking: 'off' }); const firstResult = expect(first).rejects.toThrow('workload authentication'); const second = f.provider.chat(messages, { thinking: 'off' }); await vi.waitFor(() => expect(held).toHaveLength(2)); controller.abort(); await firstResult; held[1](minted('valid-other-caller')); await second; held[0](minted('late-canceled')); await f.provider.chat(messages, { thinking: 'off' }); expect(held).toHaveLength(2);
  const other = new AnthropicProvider({ ...f.config, anthropicFederation: { ...f.config.anthropicFederation!, workspaceId: 'other-workspace' } }); const pending = other.chat(messages, { thinking: 'off' }); await vi.waitFor(() => expect(held).toHaveLength(3)); held[2](minted('valid-other-caller')); await pending; expect(fetcher).toHaveBeenCalledTimes(6);
});

it('clips hostile exchange bodies to caller/scope lifetimes and never publishes or infers after retirement', async () => {
  const f = await fixture(), scope = createProviderNetworkScope(), controller = new AbortController(); const provider = new AnthropicProvider({ ...f.config, [PROVIDER_NETWORK_SCOPE]: scope }); let cancel = 0, calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { calls++; return new Response(new ReadableStream({ cancel() { cancel++; return new Promise(() => {}); } })); });
  const run = provider.chat(messages, { signal: controller.signal, thinking: 'off' }), result = expect(run).rejects.toThrow('workload authentication'); await vi.waitFor(() => expect(calls).toBe(1)); await closeProviderNetworkDispatchers(scope, { permanent: true }); await result; expect(cancel).toBe(1); await expect(provider.chat(messages, { thinking: 'off' })).rejects.toThrow('closed'); expect(calls).toBe(1);
});

it('bounds identity files and token responses, rejects redirects/invalid UTF-8/header tokens without exposing assertions', async () => {
  const f = await fixture(); const fetcher = vi.spyOn(globalThis, 'fetch');
  for (const value of ['x'.repeat(16 * 1024 + 3), Buffer.from([0xff]), '']) { await writeFile(f.file, value); await expect(new AnthropicProvider(f.config).chat(messages, { thinking: 'off' })).rejects.toThrow(/^Anthropic workload authentication failed\.$/); } expect(fetcher).not.toHaveBeenCalled(); await writeFile(f.file, 'synthetic.jwt.assertion');
  for (const response of [new Response('', { status: 307, headers: { location: 'https://unowned.test' } }), new Response(Buffer.from([0xff])), new Response('x'.repeat(256 * 1024 + 1)), minted('snowman-☃'), new Response(JSON.stringify({ access_token: 'secret', expires_in: 0 })), new Response(JSON.stringify({ access_token: 'secret', expires_in: 3600, token_type: 'MAC' }))]) { fetcher.mockResolvedValueOnce(response); await expect(new AnthropicProvider(f.config).chat(messages, { thinking: 'off' })).rejects.toThrow(/^Anthropic workload authentication failed\.$/); } expect(fetcher).toHaveBeenCalledTimes(6);
});
