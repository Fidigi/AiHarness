import { createHash } from 'node:crypto';
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

it.each(['device', 'browser'] as const)('does not mount after shutdown wins the %s durable-publication return boundary', async method => {
  const f = await fixture(), committed = deferred<void>();
  const prepare = f.credentials.prepareOAuthLogin.bind(f.credentials);
  vi.spyOn(f.credentials, 'prepareOAuthLogin').mockImplementationOnce(async (...args) => {
    const publish = await prepare(...args);
    return async credential => {
      const result = await publish(credential); f.service.close(); committed.resolve(); return result;
    };
  });
  const flow = await f.service.start('openai-codex', undefined, method);
  const completion = method === 'browser' ? f.service.redirect(flow.id, browserRedirect(flow)).catch(() => undefined) : Promise.resolve();
  await committed.promise; await completion;
  // Drain the completion continuation before asserting absence of proxy admission.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.mount).not.toHaveBeenCalled();
  const reader = f.reopen(); await reader.load();
  // Shutdown is not revocation of a login already durably committed before it.
  expect((await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ accessToken: token });
});

it.each(['device', 'browser'] as const)('requires durable encryption before exposing %s login', async method => {
  const fetcher = vi.fn(), service = new ProviderOAuthService(new AiProxyServer(), () => new ProviderCredentialService(), fetcher); services.push(service);
  await expect(service.start('openai-codex', undefined, method)).rejects.toMatchObject({ status: 409 }); expect(fetcher).not.toHaveBeenCalled();
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

it.each(['caller', 'close', 'new-login'] as const)('does not expose browser metadata after %s retires a reserved start', async owner => {
  const f = await fixture(), caller = new AbortController(), ready = deferred<void>(), released = deferred<void>();
  const prepare = f.credentials.prepareOAuthLogin.bind(f.credentials);
  vi.spyOn(f.credentials, 'prepareOAuthLogin').mockImplementationOnce(async (...args) => {
    const publish = await prepare(...args); ready.resolve(); await released.promise; return publish;
  });
  const pending = f.service.start('openai-codex', caller.signal, 'browser').catch(error => error);
  await ready.promise;
  if (owner === 'caller') caller.abort();
  if (owner === 'close') f.service.close();
  if (owner === 'new-login') { const next = await f.service.start('openai-codex', undefined, 'browser'); f.service.cancel(next.id); }
  released.resolve(); expect(await pending).toMatchObject({ name: 'AbortError' });
  expect(f.calls).toEqual([]); expect(f.mount).not.toHaveBeenCalled();
});

function browserRedirect(flow: { authorizationUrl?: string }): string {
  return 'http://localhost:1455/auth/callback?code=private-server-browser-code&state=' + new URL(flow.authorizationUrl!).searchParams.get('state');
}

it('uses fixed Codex browser authority, retryable invalid redirects and exactly one guarded S256 exchange', async () => {
  const f = await fixture();
  await expect(f.service.start('github-copilot', undefined, 'browser')).rejects.toMatchObject({ status: 400 });
  const flow = await f.service.start('openai-codex', undefined, 'browser');
  expect(f.calls).toEqual([]);
  expect(flow).toMatchObject({ provider: 'openai-codex', state: 'pending', authorizationUrl: expect.any(String) });
  expect(flow).not.toHaveProperty('userCode'); expect(flow).not.toHaveProperty('verificationUri');
  const authorization = new URL(flow.authorizationUrl!);
  expect(authorization.origin + authorization.pathname).toBe('https://auth.openai.com/oauth/authorize');
  expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  for (const value of ['bare-code', browserRedirect(flow).replace('state=', 'state=wrong'), browserRedirect(flow).replace('localhost:1455', 'unrelated.test')]) {
    await expect(f.service.redirect(flow.id, value)).rejects.toMatchObject({ status: 400, message: 'Invalid OAuth redirect.' });
    expect(f.service.get(flow.id)?.state).toBe('pending'); expect(f.calls).toEqual([]);
  }
  expect(await f.service.redirect(flow.id, browserRedirect(flow))).toMatchObject({ state: 'connected' });
  await expect(f.service.redirect(flow.id, browserRedirect(flow))).rejects.toMatchObject({ status: 409 });
  expect(f.calls).toHaveLength(1);
  const form = Object.fromEntries(new URLSearchParams(f.calls[0]!.body));
  expect(form).toEqual({ grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code: 'private-server-browser-code',
    code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), redirect_uri: 'http://localhost:1455/auth/callback' });
  expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
  expect(f.calls[0]).toMatchObject({ url: 'https://auth.openai.com/oauth/token', method: 'POST', authorization: null });
  expect(f.mount).toHaveBeenCalledOnce(); expect(f.flatten).not.toHaveBeenCalled();
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' }))?.credential).toMatchObject({ accessToken: token, refreshToken: refresh });
  for (const secret of [token, refresh, form.code!, form.code_verifier!]) {
    expect(JSON.stringify([flow, f.service.get(flow.id)]) + await readFile(f.file, 'utf8')).not.toContain(secret);
  }
});

it.each(['logout', 'replacement', 'cancel', 'close', 'new-login', 'expiry', 'caller'] as const)('cannot publish a held browser token after %s', async mutation => {
  const f = await fixture('token'), caller = new AbortController();
  if (mutation === 'expiry') vi.useFakeTimers();
  const flow = await f.service.start('openai-codex', undefined, 'browser');
  const pending = f.service.redirect(flow.id, browserRedirect(flow), caller.signal).catch(error => error as Error & { status: number });
  await f.reached.promise;
  await expect(f.service.redirect(flow.id, browserRedirect(flow))).rejects.toMatchObject({ status: 409 });
  expect(f.calls).toHaveLength(1);
  if (mutation === 'logout') await f.reopen().delete('openai-codex');
  if (mutation === 'replacement') await f.reopen().setApiKey('openai-codex', 'newer-local-key');
  if (mutation === 'cancel') f.service.cancel(flow.id);
  if (mutation === 'caller') caller.abort();
  if (mutation === 'close') f.service.close();
  if (mutation === 'new-login') { const next = await f.service.start('openai-codex', undefined, 'browser'); f.service.cancel(next.id); }
  if (mutation === 'expiry') { await vi.advanceTimersByTimeAsync(15 * 60_000); vi.useRealTimers(); }
  if (mutation !== 'logout' && mutation !== 'replacement') expect(await pending).toMatchObject({ status: 409 });
  f.held.resolve(tokens()); expect(await pending).toMatchObject({ status: mutation === 'logout' || mutation === 'replacement' ? 502 : 409 });
  const reader = f.reopen(); await reader.load();
  expect(await reader.resolve('openai-codex', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
  expect((await reader.resolve('openai-codex', { env: {} }))?.credential).toEqual(mutation === 'replacement'
    ? { version: 1, type: 'api-key', apiKey: 'newer-local-key' } : undefined);
  expect(f.mount).not.toHaveBeenCalled(); expect(f.flatten).not.toHaveBeenCalled();
});

it('refuses ordinary Codex keys and composes the explicit WebSocket policy independently', async () => {
  const credentials = new ProviderCredentialService(), host = new AbortController();
  await credentials.setApiKey('openai-codex', 'not-subscription', false);
  expect(await resolveOpenAICodexSubscription(credentials, host.signal)).toBeUndefined();
  const proxy = new AiProxyServer({ enableMockProvider: true, network: { transport: 'websocket', httpIdleTimeoutMs: 12,
    websocketConnectTimeoutMs: 34, requestTimeoutMs: 56, maxRetries: 0, maxRetryDelayMs: 78 } });
  proxy.setOpenAICodexSubscription('gpt-6.1-sol', async () => undefined);
  expect(proxy.isConfigured('openai-codex')).toBe(true); expect(proxy.isConfigured('mock')).toBe(true);
});
