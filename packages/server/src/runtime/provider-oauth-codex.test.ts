import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { AiProxyServer } from '../api/proxy.js';
import { ProviderOAuthService } from './provider-oauth.js';
import { openAICodexCredentialSource, resolveOpenAICodexSubscription } from './openai-codex.js';
const roots: string[] = [], services: ProviderOAuthService[] = [];
const token = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'server-codex-account' } })).toString('base64url') + '.c2ln';
const refresh = 'private-server-codex-refresh';
const device = { device_auth_id: 'private-server-codex-device', user_code: 'CODEX-CODE', interval: 1 };
const tokens = () => Response.json({ access_token: token, refresh_token: refresh, expires_in: 3600 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(hold?: 'device' | 'poll' | 'token') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-server-codex-')); roots.push(root);
  const file = path.join(root, 'credentials.enc');
  const reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'disposable-server-codex-master') });
  const credentials = reopen(); await credentials.load();
  const reached = deferred<void>(), held = deferred<Response>();
  const calls: Array<{ url: string; body: string; method: string; authorization: string | null }> = [];
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, body: String(init?.body ?? ''), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
    const stage = target.endsWith('/usercode') ? 'device' : target.endsWith('/deviceauth/token') ? 'poll' : 'token';
    if (stage === hold) { reached.resolve(); return held.promise; }
    if (stage === 'device') return Response.json(device);
    if (stage === 'poll') return Response.json({ authorization_code: 'private-server-code', code_verifier: 'private-server-verifier' });
    expect(target).toBe('https://auth.openai.com/oauth/token'); return tokens();
  });
  const proxy = new AiProxyServer(), flatten = vi.spyOn(proxy, 'setApiKey'), mount = vi.spyOn(proxy, 'setOpenAICodexSubscription');
  const service = new ProviderOAuthService(proxy, () => credentials, fetcher); services.push(service);
  return { file, reopen, credentials, calls, reached, held, fetcher, proxy, flatten, mount, service };
}

it('uses fixed Codex device/account authority, encrypted guarded publication and a fresh native resolver', async () => {
  vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_CODEX_DEVICE_URL', 'https://unrelated.test/device');
  const f = await fixture();
  expect(f.service.isSupported('openai-codex')).toBe(true);
  const flow = await f.service.start('openai-codex');
  expect(flow).toMatchObject({ state: 'pending', provider: 'openai-codex', userCode: 'CODEX-CODE', verificationUri: 'https://auth.openai.com/codex/device' });
  await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('connected'));
  expect(f.calls.map(call => [call.url, call.method, call.authorization])).toEqual([
    ['https://auth.openai.com/api/accounts/deviceauth/usercode', 'POST', null],
    ['https://auth.openai.com/api/accounts/deviceauth/token', 'POST', null],
    ['https://auth.openai.com/oauth/token', 'POST', null],
  ]);
  expect(JSON.parse(f.calls[0]!.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  expect(JSON.parse(f.calls[1]!.body)).toEqual({ device_auth_id: device.device_auth_id, user_code: device.user_code });
  expect(Object.fromEntries(new URLSearchParams(f.calls[2]!.body))).toEqual({ grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    code: 'private-server-code', code_verifier: 'private-server-verifier', redirect_uri: 'https://auth.openai.com/deviceauth/callback' });
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ accessToken: token, refreshToken: refresh,
    subscription: { provider: 'openai-codex', accountId: 'server-codex-account' } });
  expect(await reader.resolve('openai-codex', { env: {} })).toBeUndefined();
  expect(f.flatten).not.toHaveBeenCalled(); expect(f.mount).toHaveBeenCalledOnce();
  const source = f.mount.mock.calls[0]![1]; expect(await source()).toMatchObject({ accessToken: token });
  await reader.delete('openai-codex'); expect(await source()).toBeUndefined();
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  for (const secret of [token, refresh, device.device_auth_id, 'private-server-code', 'private-server-verifier']) {
    expect(JSON.stringify([flow, f.service.get(flow.id)]) + await readFile(f.file, 'utf8')).not.toContain(secret);
  }
});

it('does not mount after shutdown wins the durable-publication return boundary', async () => {
  const f = await fixture(), committed = deferred<void>();
  const prepare = f.credentials.prepareOAuthLogin.bind(f.credentials);
  vi.spyOn(f.credentials, 'prepareOAuthLogin').mockImplementationOnce(async (...args) => {
    const publish = await prepare(...args);
    return async credential => {
      const result = await publish(credential); f.service.close(); committed.resolve(); return result;
    };
  });
  await f.service.start('openai-codex'); await committed.promise;
  // Drain the completion continuation before asserting absence of proxy admission.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.mount).not.toHaveBeenCalled();
  const reader = f.reopen(); await reader.load();
  // Shutdown is not revocation of a login already durably committed before it.
  expect((await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ accessToken: token });
});

it('requires durable encryption before contacting OpenAI', async () => {
  const fetcher = vi.fn(), service = new ProviderOAuthService(new AiProxyServer(), () => new ProviderCredentialService(), fetcher); services.push(service);
  await expect(service.start('openai-codex')).rejects.toMatchObject({ status: 409 }); expect(fetcher).not.toHaveBeenCalled();
});

it.each(['logout', 'replacement', 'cancel', 'close', 'new-login', 'expiry'] as const)('cannot publish a held Codex token after %s', async mutation => {
  const f = await fixture('token');
  if (mutation === 'expiry') vi.useFakeTimers();
  const flow = await f.service.start('openai-codex'); await f.reached.promise;
  if (mutation === 'logout') await f.reopen().delete('openai-codex');
  if (mutation === 'replacement') await f.reopen().setApiKey('openai-codex', 'newer-local-key');
  if (mutation === 'cancel') expect(f.service.cancel(flow.id)).toBe(true);
  if (mutation === 'close') f.service.close();
  if (mutation === 'new-login') { const next = await f.service.start('openai-codex'); f.service.cancel(next.id); }
  if (mutation === 'expiry') { await vi.advanceTimersByTimeAsync(15 * 60_000); vi.useRealTimers(); }
  f.held.resolve(tokens());
  if (mutation === 'logout' || mutation === 'replacement') await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('failed'));
  else if (mutation !== 'close') expect(f.service.get(flow.id)?.state).toBe(mutation === 'expiry' ? 'expired' : 'cancelled');
  const reader = f.reopen(); await reader.load();
  expect(await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
  expect((await reader.resolve('openai-codex', { env: {} }))?.credential).toEqual(mutation === 'replacement'
    ? { version: 1, type: 'api-key', apiKey: 'newer-local-key' } : undefined);
  expect(f.mount).not.toHaveBeenCalled(); expect(f.flatten).not.toHaveBeenCalled();
});

it.each(['device', 'poll', 'token'] as const)('retires held %s transport and abandons its late body', async stage => {
  const f = await fixture(stage), caller = new AbortController();
  const pending = f.service.start('openai-codex', caller.signal).catch(() => undefined);
  if (stage !== 'device') await pending;
  await f.reached.promise;
  if (stage === 'device') caller.abort(); else f.service.cancelProvider('openai-codex');
  await pending;
  const cancelled = vi.fn(); f.held.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  expect(f.mount).not.toHaveBeenCalled(); expect(f.flatten).not.toHaveBeenCalled();
});

it.each(['host', 'caller'] as const)('retires passive Codex refresh through the %s lifetime', async owner => {
  const f = await fixture('token'), host = new AbortController(), caller = new AbortController();
  const original = { accessToken: token, refreshToken: refresh, expiresAt: Date.now() - 1000, subscription: { provider: 'openai-codex' as const, accountId: 'server-codex-account' } };
  await f.credentials.setOAuth('openai-codex', original);
  vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetcher);
  const source = openAICodexCredentialSource(f.credentials, host.signal);
  const pending = source(caller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await f.reached.promise; (owner === 'host' ? host : caller).abort();
  expect((await pending).error).toMatchObject({ name: 'AbortError' }); f.held.resolve(tokens());
  expect((await f.credentials.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex', now: 0 }))?.credential).toEqual({ version: 1, type: 'oauth', ...original });
  expect(f.calls).toHaveLength(1);
});

it('does not compose native Codex from an ordinary key or reinterpret explicit WebSocket policy', async () => {
  const credentials = new ProviderCredentialService(), host = new AbortController();
  await credentials.setApiKey('openai-codex', 'not-subscription', false);
  expect(await resolveOpenAICodexSubscription(credentials, host.signal)).toBeUndefined();
  const proxy = new AiProxyServer({ enableMockProvider: true, network: { transport: 'websocket', httpIdleTimeoutMs: 12,
    websocketConnectTimeoutMs: 34, requestTimeoutMs: 56, maxRetries: 0, maxRetryDelayMs: 78 } });
  proxy.setOpenAICodexSubscription('gpt-6.1-sol', async () => undefined);
  expect(proxy.isConfigured('openai-codex')).toBe(false); expect(proxy.isConfigured('mock')).toBe(true);
});
