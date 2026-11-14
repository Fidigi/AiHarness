import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderCredentialService, type ProviderOAuthCredential } from '@ai-harness/core';
import { createConfiguredProviders, resolveStartupProvider } from './configured-providers.js';
import { createCliProviderRuntime } from './provider-runtime.js';

const roots: string[] = [];
const codexToken = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'runtime-account' } })).toString('base64url') + '.c2ln';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('CLI provider runtime', () => {
  it('composes native Kimi OAuth as a live issuer-owned resolver rather than an API-key snapshot', async () => {
    const credentials = new ProviderCredentialService(), original = { accessToken: 'private-kimi-original', refreshToken: 'private-kimi-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'kimi-coding' as const, oauthHost: 'https://synthetic-runtime-kimi.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    await credentials.setOAuth('kimi-coding', original, false); const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
    expect(runtime.values.has('kimi-coding')).toBe(false); expect(runtime.kimiOAuth).toBeDefined();
    const provider = createConfiguredProviders({}, { credentials: runtime.values, kimiOAuth: runtime.kimiOAuth }).get('kimi-coding')!;
    const calls: Array<{ url: string; auth: string | null }> = [], transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return String(url).endsWith('/oauth/token') ? Response.json({ access_token: 'private-kimi-rotated', refresh_token: 'private-kimi-new-refresh', expires_in: 3600 }) : Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } });
    });
    await credentials.setOAuth('kimi-coding', { ...original, expiresAt: 1 }, false);
    expect(await provider.chat([{ id: 'user', role: 'user', content: 'probe', timestamp: new Date(0) }])).toMatchObject({ content: 'ok', provider: 'kimi-coding', model: 'k3', api: 'anthropic-messages' });
    expect(calls).toEqual([{ url: original.subscription.oauthHost + '/api/oauth/token', auth: null }, { url: 'https://api.kimi.com/coding/v1/messages', auth: 'Bearer private-kimi-rotated' }]);
    await credentials.delete('kimi-coding'); await expect(provider.chat([])).rejects.toThrow('Kimi'); expect(transport).toHaveBeenCalledTimes(2); runtime.close();
  });
  it.each(['key', 'command-offline', 'expired-offline', 'issuer-mismatch'] as const)('does not substitute Kimi OAuth for %s policy', async mode => {
    const credentials = new ProviderCredentialService(); await credentials.setOAuth('kimi-coding', { accessToken: 'private-kimi', refreshToken: 'private-kimi-refresh', expiresAt: mode === 'expired-offline' || mode === 'issuer-mismatch' ? 1 : Date.now() + 120000,
      subscription: { provider: 'kimi-coding', oauthHost: 'https://synthetic-runtime-kimi.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const runtime = await createCliProviderRuntime('/unused', mode === 'command-offline' ? { providerApiKeyCommands: { 'kimi-coding': 'must-not-execute' } } : {},
      mode === 'key' ? { KIMI_CODING_API_KEY: 'private-key' } : mode === 'issuer-mismatch' ? { KIMI_CODE_OAUTH_HOST: 'https://other.kimi.test' } : {}, credentials, false, [], undefined, mode === 'command-offline' || mode === 'expired-offline');
    expect(runtime.kimiOAuth).toBeUndefined(); expect(runtime.values.get('kimi-coding')).toBe(mode === 'key' ? 'private-key' : undefined); expect(fetch).not.toHaveBeenCalled(); runtime.close();
  });
  it('bootstraps expired native Kimi administratively without refresh before an explicit invocation-key override', async () => {
    const credentials = new ProviderCredentialService(); await credentials.setOAuth('kimi-coding', { accessToken: 'private-expired-kimi', refreshToken: 'private-kimi-refresh', expiresAt: 1,
      subscription: { provider: 'kimi-coding', oauthHost: 'https://synthetic-runtime-kimi.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected issuer request'));
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false); expect(runtime.kimiOAuth).toBeDefined(); expect(fetch).not.toHaveBeenCalled();
    const native = createConfiguredProviders({}, { credentials: runtime.values, kimiOAuth: runtime.kimiOAuth });
    const selected = await resolveStartupProvider(native, { provider: 'kimi-coding', model: 'k3', apiKey: 'private-invocation', offline: true }, {});
    expect((selected.provider as unknown as { config: object }).config).toMatchObject({ apiKey: 'private-invocation', kimiAuthMode: 'api-key' }); expect(fetch).not.toHaveBeenCalled(); runtime.close();
  });
  it('clips native Kimi refresh to the CLI runtime and per-operation offline lifetime', async () => {
    const credentials = new ProviderCredentialService(), original = { accessToken: 'private-kimi', refreshToken: 'private-kimi-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'kimi-coding' as const, oauthHost: 'https://synthetic-runtime-kimi.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    await credentials.setOAuth('kimi-coding', original, false); const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false); await credentials.setOAuth('kimi-coding', { ...original, expiresAt: 1 }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network')); expect(await runtime.kimiOAuth!.credentialSource(undefined, false)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }); fetch.mockImplementationOnce(() => { entered(); return new Promise(() => undefined); });
    const pending = runtime.kimiOAuth!.credentialSource().catch(error => error); await ready; runtime.close(); expect(await pending).toBeInstanceOf(Error); await expect(runtime.kimiOAuth!.credentialSource()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('composes native Radius OAuth with a live gateway-owned resolver rather than an API-key snapshot', async () => {
    const credentials = new ProviderCredentialService(), gateway = 'https://synthetic-runtime-radius.test';
    const original = { accessToken: 'private-radius-original', refreshToken: 'private-radius-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'radius' as const, gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    await credentials.setOAuth('radius', original, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
    expect(runtime.values.has('radius')).toBe(false); expect(runtime.radiusOAuth).toBeDefined();
    const providers = createConfiguredProviders({}, { credentials: runtime.values, radiusOAuth: runtime.radiusOAuth });
    expect(providers.get('radius')?.getPublishedModels?.()).toEqual([]);
    const calls: Array<{ url: string; auth: string | null }> = [];
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'private-radius-rotated', refresh_token: 'private-radius-new-refresh', expires_in: 3600 });
      if (String(url).endsWith('/config')) return Response.json({ baseUrl: gateway + '/v1', models: [{ id: 'account-only', name: 'Owned', reasoning: false, input: ['text'], contextWindow: 1000000, maxTokens: 65536, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
      return new Response([{ type: 'start' }, { type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'ok' }, { type: 'text_end', contentIndex: 0, content: 'ok' }, { type: 'done', reason: 'stop' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    });
    await credentials.setOAuth('radius', { ...original, expiresAt: Date.now() - 1000 }, false);
    const selected = await resolveStartupProvider(providers, { model: 'radius/account-only' }, {});
    expect(await selected.provider.chat([{ id: 'user', role: 'user', content: 'probe', timestamp: new Date(0) }])).toMatchObject({ content: 'ok', provider: 'radius', model: 'account-only', api: 'pi-messages' });
    expect(calls).toEqual([{ url: gateway + '/v1/oauth/token', auth: null }, { url: gateway + '/v1/config', auth: 'Bearer private-radius-rotated' }, { url: gateway + '/v1/messages', auth: 'Bearer private-radius-rotated' }]);
    await credentials.delete('radius'); await expect(selected.provider.chat([])).rejects.toThrow('Radius'); expect(transport).toHaveBeenCalledTimes(3); runtime.close();
  });

  it.each(['key', 'command-offline', 'expired-offline', 'gateway-mismatch'] as const)('does not substitute Radius OAuth for %s policy', async mode => {
    const credentials = new ProviderCredentialService(), gateway = 'https://synthetic-runtime-radius.test';
    await credentials.setOAuth('radius', { accessToken: 'private-radius', refreshToken: 'private-radius-refresh', expiresAt: mode === 'expired-offline' || mode === 'gateway-mismatch' ? 1 : Date.now() + 120000,
      subscription: { provider: 'radius', gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const runtime = await createCliProviderRuntime('/unused', mode === 'command-offline' ? { providerApiKeyCommands: { radius: 'must-not-execute' } } : {},
      mode === 'key' ? { RADIUS_API_KEY: 'private-api-key' } : mode === 'gateway-mismatch' ? { RADIUS_GATEWAY: 'https://other-radius.test' } : {}, credentials, false, [], undefined, mode === 'command-offline' || mode === 'expired-offline');
    expect(runtime.radiusOAuth).toBeUndefined(); expect(runtime.values.get('radius')).toBe(mode === 'key' ? 'private-api-key' : undefined); expect(fetch).not.toHaveBeenCalled(); runtime.close();
  });

  it('clips Radius refresh to the native runtime and offline operation lifetimes', async () => {
    const credentials = new ProviderCredentialService(), original = { accessToken: 'private-radius', refreshToken: 'private-radius-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'radius' as const, gateway: 'https://synthetic-runtime-radius.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } };
    await credentials.setOAuth('radius', original, false); const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
    await credentials.setOAuth('radius', { ...original, expiresAt: 1 }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    expect(await runtime.radiusOAuth!.credentialSource(undefined, false)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
    let ready!: () => void; const reached = new Promise<void>(resolve => { ready = resolve; });
    fetch.mockImplementationOnce(() => { ready(); return new Promise(() => undefined); });
    const pending = runtime.radiusOAuth!.credentialSource().catch(error => error); await reached; runtime.close(); expect(await pending).toBeInstanceOf(Error);
    await expect(runtime.radiusOAuth!.credentialSource()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('composes Copilot subscription routing without flattening tokens and observes logout on the next turn', async () => {
    const credentials = new ProviderCredentialService();
    const models = ['claude-fable-5', 'gemini-3.5-flash', 'gpt-5-mini'];
    const access: ProviderOAuthCredential = { version: 1, type: 'oauth', accessToken: 'disposable-cli-copilot', refreshToken: 'disposable-github-grant', expiresAt: Date.now() + 120000,
      subscription: { provider: 'github-copilot', availableModelIds: models } };
    await credentials.setOAuth('github-copilot', access, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
    expect(runtime.values.has('github-copilot')).toBe(false);
    expect(runtime.githubCopilot).toBeDefined();
    const providers = createConfiguredProviders({}, { credentials: runtime.values, githubCopilot: runtime.githubCopilot });
    expect(providers.has('github-copilot')).toBe(true);
    const fixture = JSON.parse(await readFile(new URL('../../../../tests/fixtures/github-copilot-routing-reference.json', import.meta.url), 'utf8')) as {
      rows: Array<{ model: string; case: string; expectedPath: string; expectedBody: unknown; responseEvents: Array<{ type?: string }> }>;
    };
    const transport = vi.spyOn(globalThis, 'fetch');
    for (const model of models) {
      const selected = await resolveStartupProvider(providers, { provider: 'github-copilot', model }, {});
      const row = fixture.rows.find(row => row.model === model && row.case === 'user')!;
      let posted: { url: string; body: unknown; authorization: string | null } | undefined;
      transport.mockImplementationOnce(async (url, init) => {
        posted = { url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') };
        return new Response(row.responseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (row.responseEvents[0].type ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
      });
      const result = await selected.provider.chat([{ id: 'probe', role: 'user', content: 'probe', timestamp: new Date(0) }], {
        systemPrompt: 'Follow instructions', maxTokens: 64, cacheRetention: 'none',
        tools: [{ name: 'echo', description: 'Echo input', parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } }],
      });
      const expected = structuredClone(row.expectedBody) as Record<string, unknown>; delete expected.tool_choice;
      expect(posted).toEqual({ url: 'https://api.individual.githubcopilot.com' + row.expectedPath, body: expected, authorization: 'Bearer disposable-cli-copilot' });
      expect(result).toMatchObject({ provider: 'github-copilot', model, content: 'ok' });
    }
    await credentials.delete('github-copilot');
    await expect(providers.get('github-copilot')!.chat([])).rejects.toThrow('GitHub Copilot');
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each(['runtime', 'parent', 'caller'] as const)('retires Copilot refresh and future resolution through the %s lifetime', async owner => {
    const credentials = new ProviderCredentialService(), parent = new AbortController(), caller = new AbortController();
    const original = { accessToken: 'runtime-original-token', refreshToken: 'runtime-github-grant', expiresAt: Date.now() + 120000,
      subscription: { provider: 'github-copilot' as const, availableModelIds: ['gpt-5-mini'] } };
    await credentials.setOAuth('github-copilot', original, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false, [], undefined, false, parent.signal);
    const expired = { ...original, expiresAt: Date.now() - 1000 };
    await credentials.setOAuth('github-copilot', expired, false);
    let ready!: () => void, release!: (response: Response) => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<Response>(resolve => { release = resolve; });
    let calls = 0;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (++calls === 1) return Response.json({ token: 'new-runtime-token', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      ready(); return held;
    });
    const pending = runtime.githubCopilot!.credentialSource(caller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered;
    if (owner === 'runtime') runtime.close();
    else if (owner === 'parent') parent.abort();
    else caller.abort();
    expect((await pending).error).toMatchObject({ name: 'AbortError' });
    release(Response.json({ data: [{ id: 'gpt-5-mini', model_picker_enabled: true }] }));
    expect((await credentials.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot', now: 0 }))?.credential)
      .toEqual({ version: 1, type: 'oauth', ...expired });
    if (owner !== 'caller') await expect(runtime.githubCopilot!.credentialSource()).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(2);
    runtime.close();
  });

  it('does not infer subscription consumers from API keys, generic OAuth, or a foreign storage label', async () => {
    for (const kind of ['api-key', 'oauth', 'foreign-label']) {
      const credentials = new ProviderCredentialService();
      if (kind === 'api-key') await credentials.setApiKey('github-copilot', 'disposable-api-key', false);
      else await credentials.setOAuth(kind === 'foreign-label' ? 'openai' : 'github-copilot', {
        accessToken: 'disposable-oauth', refreshToken: 'disposable-github-grant', expiresAt: Date.now() + 120000,
        ...(kind === 'foreign-label' ? { subscription: { provider: 'github-copilot' as const, availableModelIds: ['gpt-5-mini'] } } : {}),
      }, false);
      const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
      expect(runtime.githubCopilot).toBeUndefined();
      expect(createConfiguredProviders({}, { credentials: runtime.values, githubCopilot: runtime.githubCopilot }).has('github-copilot')).toBe(false);
      if (kind === 'foreign-label') expect(runtime.values.has('openai')).toBe(false);
    }
  });

  it('composes Codex independently of API-key OpenAI, without startup discovery or automatic selection', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('openai-codex', { accessToken: codexToken, refreshToken: 'runtime-codex-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'openai-codex', accountId: 'runtime-account' } }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const runtime = await createCliProviderRuntime('/unused', {}, { OPENAI_API_KEY: 'ordinary-openai-key' }, credentials, false);
    const providers = createConfiguredProviders({}, { credentials: runtime.values, openaiCodex: runtime.openaiCodex });
    expect(runtime.values.get('openai')).toBe('ordinary-openai-key');
    expect(runtime.values.has('openai-codex')).toBe(false); expect(runtime.githubCopilot).toBeUndefined();
    expect(providers.get('openai-codex')?.getModelApi?.()).toBe('openai-codex-responses');
    expect((await resolveStartupProvider(providers, {}, {})).providerName).toBe('mock');
    expect(fetch).not.toHaveBeenCalled();
    runtime.close(); await expect(runtime.openaiCodex!.credentialSource()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['runtime', 'parent', 'caller'] as const)('retires held Codex refresh through the %s lifetime', async owner => {
    const credentials = new ProviderCredentialService(), parent = new AbortController(), caller = new AbortController();
    const original = { accessToken: codexToken, refreshToken: 'runtime-codex-refresh', expiresAt: Date.now() + 120000,
      subscription: { provider: 'openai-codex' as const, accountId: 'runtime-account' } };
    await credentials.setOAuth('openai-codex', original, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false, [], undefined, false, parent.signal);
    const expired = { ...original, expiresAt: Date.now() - 1000 };
    await credentials.setOAuth('openai-codex', expired, false);
    let ready!: () => void, release!: (response: Response) => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<Response>(resolve => { release = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      expect(String(url)).toBe('https://auth.openai.com/oauth/token'); ready(); return held;
    });
    const pending = runtime.openaiCodex!.credentialSource(caller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered;
    if (owner === 'runtime') runtime.close(); else if (owner === 'parent') parent.abort(); else caller.abort();
    expect((await pending).error).toMatchObject({ name: 'AbortError' });
    release(Response.json({ access_token: codexToken, refresh_token: 'rotated-codex-refresh', expires_in: 3600 }));
    expect((await credentials.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex', now: 0 }))?.credential)
      .toEqual({ version: 1, type: 'oauth', ...expired });
    if (owner !== 'caller') await expect(runtime.openaiCodex!.credentialSource()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1); runtime.close();
  });

  it.each(['api-key', 'generic-oauth', 'foreign-label', 'copilot', 'offline-expired'] as const)('does not compose Codex from %s authority', async kind => {
    const credentials = new ProviderCredentialService();
    if (kind === 'api-key') await credentials.setApiKey('openai-codex', 'disposable-api-key', false);
    else await credentials.setOAuth(kind === 'foreign-label' ? 'openai' : 'openai-codex', {
      accessToken: codexToken, refreshToken: 'disposable-refresh', expiresAt: kind === 'offline-expired' ? 1 : Date.now() + 120000,
      ...(kind === 'generic-oauth' ? {} : { subscription: kind === 'copilot'
        ? { provider: 'github-copilot' as const, availableModelIds: ['gpt-5-mini'] }
        : { provider: 'openai-codex' as const, accountId: 'runtime-account' } }),
    }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false, [], undefined, kind === 'offline-expired');
    expect(runtime.openaiCodex).toBeUndefined(); expect(runtime.values.has('openai-codex')).toBe(false);
    if (kind === 'foreign-label') expect(runtime.values.has('openai')).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); runtime.close();
  });

  it('does not refresh expired Copilot credentials when the CLI is offline', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('github-copilot', { accessToken: 'disposable-expired', refreshToken: 'disposable-github', expiresAt: 1,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini'] } }, false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false, [], undefined, true);
    expect(runtime.githubCopilot).toBeUndefined();
    expect(runtime.values.has('github-copilot')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([['cerebras', 'CEREBRAS_API_KEY', 'AI_HARNESS_CEREBRAS_API_KEY'],
    ['mistral-conversations', 'MISTRAL_API_KEY', 'AI_HARNESS_MISTRAL_CONVERSATIONS_API_KEY'],
    ['deepseek', 'DEEPSEEK_API_KEY', 'AI_HARNESS_DEEPSEEK_API_KEY'],
    ['groq', 'GROQ_API_KEY', 'AI_HARNESS_GROQ_API_KEY'],
    ['zai', 'ZAI_API_KEY', 'AI_HARNESS_ZAI_API_KEY'],
    ['nvidia', 'NVIDIA_API_KEY', 'AI_HARNESS_NVIDIA_API_KEY'],
    ['minimax', 'MINIMAX_API_KEY', 'AI_HARNESS_MINIMAX_API_KEY'],
    ['minimax-cn', 'MINIMAX_CN_API_KEY', 'AI_HARNESS_MINIMAX_CN_API_KEY'],
    ['kimi-coding', 'KIMI_CODING_API_KEY', 'AI_HARNESS_KIMI_CODING_API_KEY'],
    ['moonshotai', 'MOONSHOTAI_API_KEY', 'AI_HARNESS_MOONSHOTAI_API_KEY'],
    ['moonshotai-cn', 'MOONSHOTAI_CN_API_KEY', 'AI_HARNESS_MOONSHOTAI_CN_API_KEY'],
    ['ant-ling', 'ANT_LING_API_KEY', 'AI_HARNESS_ANT_LING_API_KEY'],
    ['baseten', 'BASETEN_API_KEY', 'AI_HARNESS_BASETEN_API_KEY'],
    ['together', 'TOGETHER_API_KEY', 'AI_HARNESS_TOGETHER_API_KEY'],
    ['huggingface', 'HUGGINGFACE_API_KEY', 'AI_HARNESS_HUGGINGFACE_API_KEY'],
    ['xiaomi', 'XIAOMI_API_KEY', 'AI_HARNESS_XIAOMI_API_KEY'],
    ['meta', 'META_API_KEY', 'AI_HARNESS_META_API_KEY'],
    ['xai', 'XAI_API_KEY', 'AI_HARNESS_XAI_API_KEY'],
    ['fireworks', 'FIREWORKS_API_KEY', 'AI_HARNESS_FIREWORKS_API_KEY'],
    ['opencode', 'OPENCODE_API_KEY', 'AI_HARNESS_OPENCODE_API_KEY'],
    ['opencode-go', 'OPENCODE_GO_API_KEY', 'AI_HARNESS_OPENCODE_GO_API_KEY'],
    ['openrouter', 'OPENROUTER_API_KEY', 'AI_HARNESS_OPENROUTER_API_KEY'],
    ['cloudflare-workers-ai', 'CLOUDFLARE_WORKERS_AI_API_KEY', 'AI_HARNESS_CLOUDFLARE_WORKERS_AI_API_KEY'],
    ['qwen-token-plan', 'QWEN_TOKEN_PLAN_API_KEY', 'AI_HARNESS_QWEN_TOKEN_PLAN_API_KEY'],
    ['qwen-token-plan-cn', 'QWEN_TOKEN_PLAN_CN_API_KEY', 'AI_HARNESS_QWEN_TOKEN_PLAN_CN_API_KEY'],
    ['qwen-token-plan-individual', 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY', 'AI_HARNESS_QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY'],
    ['xiaomi-token-plan-ams', 'XIAOMI_TOKEN_PLAN_AMS_API_KEY', 'AI_HARNESS_XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
    ['xiaomi-token-plan-cn', 'XIAOMI_TOKEN_PLAN_CN_API_KEY', 'AI_HARNESS_XIAOMI_TOKEN_PLAN_CN_API_KEY'],
    ['xiaomi-token-plan-sgp', 'XIAOMI_TOKEN_PLAN_SGP_API_KEY', 'AI_HARNESS_XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
    ['zai-coding-cn', 'ZAI_CODING_CN_API_KEY', 'AI_HARNESS_ZAI_CODING_CN_API_KEY'],
    ['typesafe', 'TYPESAFE_API_KEY', 'AI_HARNESS_TYPESAFE_API_KEY'],
    ['radius', 'RADIUS_API_KEY', 'AI_HARNESS_RADIUS_API_KEY'],
    ['cloudflare-ai-gateway', 'CLOUDFLARE_API_KEY', 'AI_HARNESS_CLOUDFLARE_AI_GATEWAY_API_KEY'],
    ['vercel-ai-gateway', 'AI_GATEWAY_API_KEY', 'AI_HARNESS_VERCEL_AI_GATEWAY_API_KEY'],
    ['openai-native', 'OPENAI_NATIVE_API_KEY', 'AI_HARNESS_OPENAI_NATIVE_API_KEY']] as const)(
    'resolves native %s environment, command and encrypted credentials without registration', async (provider, variable, firstVariable) => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-cerebras-credentials-'));
    roots.push(agentDir);
    const key = 'synthetic-cerebras-env';
    const environment = await createCliProviderRuntime(agentDir, {}, { [variable]: key });
    expect(environment.values.get(provider)).toBe(key);
    expect(environment.redactor.redact(key)).toBe('[REDACTED]');
    const env = { AI_HARNESS_MASTER_KEY: 'sufficiently long synthetic Cerebras master key' };
    const first = await createCliProviderRuntime(agentDir, {}, env);
    await first.credentials.setApiKey(provider, 'synthetic-cerebras-stored');
    const settings = { providerApiKeyCommands: { [provider]: `${JSON.stringify(process.execPath)} -e "process.stdout.write('synthetic-cerebras-command')"` } };
    const command = await createCliProviderRuntime(agentDir, settings, env);
    expect(command.values.get(provider)).toBe('synthetic-cerebras-command');
    const override = await createCliProviderRuntime(agentDir, settings, { ...env, [variable]: key, [firstVariable]: 'synthetic-cerebras-first' });
    expect(override.values.get(provider)).toBe('synthetic-cerebras-first');
    const offline = await createCliProviderRuntime(agentDir, settings, env, undefined, true, [], undefined, true);
    expect(offline.values.has(provider)).toBe(false);
    const restored = await createCliProviderRuntime(agentDir, {}, env);
    expect(restored.values.get(provider)).toBe('synthetic-cerebras-stored');
    expect(restored.redactor.redact('synthetic-cerebras-stored')).toBe('[REDACTED]');
    const bytes = await readFile(path.join(agentDir, 'credentials.enc'), 'utf8');
    for (const secret of [key, 'synthetic-cerebras-stored', 'synthetic-cerebras-command', 'synthetic-cerebras-first']) expect(bytes).not.toContain(secret);
  });

  it('does not resolve absent credential sources while preserving fresh external reload admission', async () => {
    const absent = new ProviderCredentialService();
    const resolve = vi.spyOn(absent, 'resolve');
    const empty = await createCliProviderRuntime('/unused', {}, { GROQ_API_KEY: 'synthetic-selected-key' }, absent, false);
    expect(resolve.mock.calls.map(([provider]) => provider).sort()).toEqual(['github-copilot', 'groq', 'openai-codex']);
    empty.close();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-fresh-source-')); roots.push(agentDir);
    const env = { AI_HARNESS_MASTER_KEY: 'synthetic-reload-only-master-key-long-enough' };
    const first = await createCliProviderRuntime(agentDir, {}, env);
    const writer = await createCliProviderRuntime(agentDir, {}, env);
    await writer.credentials.setApiKey('moonshotai-cn', 'synthetic-later-key');
    const added = await createCliProviderRuntime(agentDir, {}, env, first.credentials);
    expect(added.values.get('moonshotai-cn')).toBe('synthetic-later-key');
    expect(added.values.has('moonshotai')).toBe(false);
    await writer.credentials.delete('moonshotai-cn');
    const removed = await createCliProviderRuntime(agentDir, {}, env, first.credentials);
    expect(removed.values.has('moonshotai-cn')).toBe(false);
    for (const runtime of [first, writer, added, removed]) runtime.close();
  });

  it('retains Kimi OAuth auth mode without guessing its issuer and keeps environment keys independent', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('kimi-coding', { accessToken: 'synthetic-kimi-access', expiresAt: Date.now() + 120000 }, false);
    const runtime = await createCliProviderRuntime('/unused', {}, {}, credentials, false);
    expect(runtime.kimiCodingAuthMode).toBe('oauth');
    const providers = createConfiguredProviders({}, { credentials: runtime.values, kimiCodingAuthMode: runtime.kimiCodingAuthMode });
    expect((providers.get('kimi-coding') as unknown as { config: object }).config).toMatchObject({ apiKey: 'synthetic-kimi-access', kimiAuthMode: 'oauth' });
    const keyRuntime = await createCliProviderRuntime('/unused', {}, { KIMI_CODING_API_KEY: 'synthetic-kimi-key' }, credentials, false);
    expect(keyRuntime.kimiCodingAuthMode).toBe('api-key');
    expect(keyRuntime.values.get('kimi-coding')).toBe('synthetic-kimi-key');
    runtime.close(); keyRuntime.close();
  });

  it('redacts extension default API keys before use and on reload without changing credential precedence', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-extension-credentials-'));
    roots.push(agentDir);
    const definition = (apiKey: string) => ({ type: 'extension', definition: {
      defaultConfig: { apiKey, model: 'public-model' }, create: () => { throw new Error('Must not construct providers while collecting secrets'); },
    } });
    const first = await createCliProviderRuntime(agentDir, {}, {}, undefined, false, [definition('extension-default-private-key')]);
    expect(first.values.has('extension')).toBe(false);
    expect(first.credentials.list()).toEqual([]);
    expect(first.redactor.redactJson({ thinkingSignature: 'opaque-extension-default-private-key-tail', model: 'public-model' }))
      .toEqual({ thinkingSignature: 'opaque-[REDACTED]-tail', model: 'public-model' });
    const reloaded = await createCliProviderRuntime(agentDir, {}, { AI_HARNESS_EXTENSION_API_KEY: 'extension-resolved-private-key' },
      first.credentials, false, [definition('extension-reloaded-private-key')]);
    expect(reloaded.values.get('extension')).toBe('extension-resolved-private-key');
    expect(reloaded.redactor).toBe(first.redactor);
    for (const secret of ['extension-default-private-key', 'extension-reloaded-private-key', 'extension-resolved-private-key'])
      expect(reloaded.redactor.redact(`opaque-${secret}-tail`)).toBe('opaque-[REDACTED]-tail');
    expect(reloaded.credentials.list()).toEqual([]);
  });

  it('persists credentials encrypted and resolves only their process-local value', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-credentials-'));
    roots.push(agentDir);
    const env = { AI_HARNESS_MASTER_KEY: 'a sufficiently long test master key' };
    const first = await createCliProviderRuntime(agentDir, {}, env);
    const descriptor = await first.credentials.setApiKey('openai', 'private-cli-secret');
    expect(descriptor).toMatchObject({ provider: 'openai', source: 'encrypted-store' });
    expect(JSON.stringify(descriptor)).not.toContain('private-cli-secret');
    await first.credentials.setApiKey('bedrock', JSON.stringify({ bearerToken: 'private:bedrock:bearer' }));

    const restored = await createCliProviderRuntime(agentDir, {}, env);
    expect(restored.values.get('openai')).toBe('private-cli-secret');
    expect(await readFile(path.join(agentDir, 'credentials.enc'), 'utf8')).not.toContain('private-cli-secret');
    expect(restored.values.get('bedrock')).toBe(JSON.stringify({ bearerToken: 'private:bedrock:bearer' }));
    expect(restored.redactor.redact('private:bedrock:bearer')).toBe('[REDACTED]');
    expect(await readFile(path.join(agentDir, 'credentials.enc'), 'utf8')).not.toContain('private:bedrock:bearer');
  });

  it('resolves trusted configured commands and bounded network settings', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'aih-cli-command-'));
    roots.push(agentDir);
    const runtime = await createCliProviderRuntime(agentDir, {
      providerApiKeyCommands: {
        openai: `${JSON.stringify(process.execPath)} -e "process.stdout.write('command-secret')"`,
        extension: `${JSON.stringify(process.execPath)} -e "process.stdout.write('extension-secret')"`,
      },
      transport: 'websocket',
      httpIdleTimeoutMs: 123,
      websocketConnectTimeoutMs: 456,
      retry: { provider: { timeoutMs: 789, maxRetries: 2, maxRetryDelayMs: 321 } },
    }, {});

    expect(runtime.values.get('openai')).toBe('command-secret');
    expect(runtime.values.get('extension')).toBe('extension-secret');
    expect(runtime.network).toEqual({
      transport: 'websocket', httpIdleTimeoutMs: 123, websocketConnectTimeoutMs: 456,
      requestTimeoutMs: 789, maxRetries: 2, maxRetryDelayMs: 321,
    });
  });
});
