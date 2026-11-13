import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { beginOpenAICodexDeviceLogin, beginOpenAICodexBrowserLogin, getOpenAICodexOAuthConfig, refreshOpenAICodexToken,
  CredentialRedactor, ProviderCredentialService, EncryptedCredentialStore } from '../index.js';
import { openAICodexAccountId } from './openai-codex-oauth.js';

const roots: string[] = [];
const accountId = 'acct-disposable-codex';
// Synthetic unsigned payloads: account routing tests, not token authenticity/entitlement evidence.
const jwt = (id = accountId, marker = 'initial') => ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ marker, 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url'), 'fixture-signature'].join('.');
const tokens = (id = accountId, marker = 'initial') => ({ access_token: jwt(id, marker), refresh_token: 'private-codex-refresh-' + marker, expires_in: 3600 });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const device = { device_auth_id: 'private-codex-device', user_code: 'VISIBLE-CODE', interval: '0' };
const code = { authorization_code: 'private-authorization-code', code_verifier: 'private-codex-verifier' };
const stored = { accessToken: jwt(), refreshToken: 'private-codex-refresh-initial', expiresAt: Date.now() - 1000,
  subscription: { provider: 'openai-codex' as const, accountId } };
const options = { env: {}, subscriptionProvider: 'openai-codex' as const };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-codex-auth-')); roots.push(root);
  const file = path.join(root, 'credentials.enc');
  const reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'disposable-codex-master-key') });
  const service = reopen(); await service.load();
  return { file, service, reopen };
}

it('uses an explicit frozen issuer, JSON device flow and distinct account-bound tokens without activation', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'not-subscription-authority');
  vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_CODEX_TOKEN_URL', 'https://unrelated.test/token');
  const f = await fixture(), publish = await f.service.prepareOAuthLogin('team-chatgpt');
  const responses = [json(device), json(code), json(tokens())], redactor = new CredentialRedactor();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => { calls.push({ url: String(url), init }); return responses.shift()!; });
  const login = await beginOpenAICodexDeviceLogin({ fetcher, redactor });
  expect(Object.isFrozen(getOpenAICodexOAuthConfig())).toBe(true);
  expect(JSON.parse(JSON.stringify(login))).toEqual({ userCode: device.user_code, verificationUri: 'https://auth.openai.com/codex/device', expiresAt: login.expiresAt });
  const credential = await login.complete();
  expect(credential).toMatchObject({ accessToken: jwt(), refreshToken: tokens().refresh_token, subscription: { provider: 'openai-codex', accountId } });
  await publish(credential);
  expect(await f.service.resolve('team-chatgpt', { env: {} })).toBeUndefined();
  expect((await f.service.resolve('team-chatgpt', options))?.credential).toMatchObject(credential);
  expect(credential.expiresAt).toBeGreaterThan(Date.now());
  expect(calls.map(call => call.url)).toEqual(['https://auth.openai.com/api/accounts/deviceauth/usercode', 'https://auth.openai.com/api/accounts/deviceauth/token', 'https://auth.openai.com/oauth/token']);
  expect(calls.every(call => call.init?.method === 'POST' && call.init.redirect === 'manual')).toBe(true);
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  expect(JSON.parse(String(calls[1].init?.body))).toEqual({ device_auth_id: device.device_auth_id, user_code: device.user_code });
  expect(Object.fromEntries(calls[2].init?.body as URLSearchParams)).toEqual({ grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code: code.authorization_code, code_verifier: code.code_verifier, redirect_uri: 'https://auth.openai.com/deviceauth/callback' });
  expect(redactor.redact([device.device_auth_id, code.authorization_code, code.code_verifier, credential.accessToken, credential.refreshToken].join(' '))).toBe(Array(5).fill('[REDACTED]').join(' '));
  await expect(login.complete()).rejects.toThrow('already consumed');
  expect(calls).toHaveLength(3);
});

it('handles bodyless pending responses and slow_down without early polling', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(json(device)).mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(json({ error: 'slow_down' }, 429)).mockResolvedValueOnce(json(code)).mockResolvedValueOnce(json(tokens()));
  const login = await beginOpenAICodexDeviceLogin({ fetcher });
  const pending = login.complete();
  await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5999); expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect((await pending).subscription.accountId).toBe(accountId);
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it.each(['missing-account', 'malformed', 'header-injection', 'invalid-utf8'])('refuses %s token claims without leaking token response fields', async mode => {
  const access = mode === 'missing-account' ? 'e30.e30.signature' : mode === 'header-injection' ? jwt('account\r\nx-injected: yes')
    : mode === 'invalid-utf8' ? 'e30._w.signature' : 'not-a-jwt';
  const fetcher = vi.fn().mockResolvedValueOnce(json({ ...tokens(), access_token: access }));
  await expect(refreshOpenAICodexToken('private-refresh', accountId, { fetcher })).rejects.toThrow('OpenAI Codex token refresh failed.');
  expect(() => openAICodexAccountId(access)).toThrow('Invalid OpenAI Codex account credential.');
});

it.each([{ refresh_token: undefined }, { expires_in: 0 }, { expires_in: Infinity }])('requires rotating refresh credentials and finite expiry (%j)', async mutation => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ ...tokens(), ...mutation }));
  await expect(refreshOpenAICodexToken('private-refresh', accountId, { fetcher })).rejects.toThrow('OpenAI Codex token refresh failed.');
});

it.each(['pending-fetch', 'fetch-settlement'] as const)('settles cancellation during %s and releases the response body', async timing => {
  const held = deferred<Response>(), caller = new AbortController(), reached = deferred<void>();
  const fetcher = vi.fn(() => { reached.resolve(); return held.promise; });
  const pending = beginOpenAICodexDeviceLogin({ fetcher, signal: caller.signal }).catch(error => error);
  await reached.promise;
  if (timing === 'pending-fetch') caller.abort();
  else void held.promise.then(() => caller.abort());
  if (timing === 'pending-fetch') expect(await pending).toBeInstanceOf(Error);
  const cancelled = vi.fn(); held.resolve(new Response(new ReadableStream({ cancel: cancelled })));
  expect(await pending).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});

it.each(['oversize-header', 'oversize-body', 'invalid-utf8', 'private-error'] as const)('bounds %s issuer responses without exposing response text', async variant => {
  const response = variant === 'oversize-header' ? new Response('{}', { headers: { 'content-length': '262145' } })
    : variant === 'oversize-body' ? new Response('x'.repeat(262145))
    : variant === 'invalid-utf8' ? new Response(new Uint8Array([255]))
    : json({ error: 'private-codex-server-response' }, 500);
  const result = await beginOpenAICodexDeviceLogin({ fetcher: vi.fn().mockResolvedValue(response) }).catch(error => error);
  expect(result).toBeInstanceOf(Error);
  expect(result.message).toBe('OpenAI Codex device authorization failed.');
});

it('rejects altered user codes and cancelled sessions before polling', async () => {
  const redactor = new CredentialRedactor([device.user_code]);
  await expect(beginOpenAICodexDeviceLogin({ redactor, fetcher: vi.fn().mockResolvedValue(json(device)) })).rejects.toThrow('device authorization failed');
  const fetcher = vi.fn().mockResolvedValue(json(device)), login = await beginOpenAICodexDeviceLogin({ fetcher });
  login.cancel(); await expect(login.complete()).rejects.toThrow('cancelled');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps issuer and storage label separate, rotates encrypted tokens and ignores generic OAuth authority', async () => {
  const f = await fixture(); await f.service.setOAuth('team-chatgpt', stored);
  expect(await f.service.resolve('team-chatgpt', { env: {} })).toBeUndefined();
  expect(await f.service.resolve('team-chatgpt', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(tokens(accountId, 'rotated')));
  const resolved = await f.service.resolve('team-chatgpt', { ...options, fetcher, oauth: { tokenUrl: 'https://unrelated.test/token', clientId: 'not-authority' } });
  expect(resolved?.credential).toMatchObject({ accessToken: jwt(accountId, 'rotated'), refreshToken: 'private-codex-refresh-rotated', subscription: { provider: 'openai-codex', accountId } });
  expect(fetcher.mock.calls[0][0]).toBe('https://auth.openai.com/oauth/token');
  expect(String(fetcher.mock.calls[0][1]?.body)).toContain('grant_type=refresh_token');
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('team-chatgpt', { ...options, allowRefresh: false }))?.credential).toEqual(resolved?.credential);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(await readFile(f.file, 'utf8')).not.toContain('private-codex');
});

it('does not infer a Codex subscription from a label, API key, generic OAuth or mismatched account claim', async () => {
  const service = new ProviderCredentialService();
  await service.setApiKey('openai-codex', 'private-key', false);
  expect(await service.resolve('openai-codex', options)).toBeUndefined();
  await service.setOAuth('openai-codex', { accessToken: jwt(), refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000 }, false);
  expect(await service.resolve('openai-codex', options)).toBeUndefined();
  await expect(service.setOAuth('other', { ...stored, subscription: { provider: 'openai-codex', accountId: 'wrong-account' } }, false)).rejects.toMatchObject({ code: 'invalid-credential' });
});

it('refuses a refreshed account switch without changing encrypted credentials', async () => {
  const f = await fixture(); await f.service.setOAuth('openai-codex', stored);
  await expect(f.service.resolve('openai-codex', { ...options, fetcher: vi.fn().mockResolvedValue(json(tokens('other-account'))) })).rejects.toMatchObject({ code: 'refresh-failed' });
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('openai-codex', { ...options, now: 0 }))?.credential).toEqual({ version: 1, type: 'oauth', ...stored });
});

it.each(['logout', 'replacement', 'cancel'] as const)('cannot publish a held Codex refresh after %s', async mutation => {
  const f = await fixture(); await f.service.setOAuth('openai-codex', stored);
  const held = deferred<Response>(), reached = deferred<void>(), caller = new AbortController();
  const pending = f.service.resolve('openai-codex', { ...options, signal: caller.signal, fetcher: vi.fn(() => { reached.resolve(); return held.promise; }) }).catch(error => error);
  await reached.promise;
  if (mutation === 'logout') await f.reopen().delete('openai-codex');
  if (mutation === 'replacement') await f.reopen().setApiKey('openai-codex', 'newer-key');
  if (mutation === 'cancel') caller.abort();
  held.resolve(json(tokens(accountId, 'late')));
  expect(await pending).toBeInstanceOf(Error);
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('openai-codex', { ...options, now: 0 }))?.credential).toEqual(mutation === 'cancel' ? { version: 1, type: 'oauth', ...stored } : undefined);
  if (mutation === 'replacement') expect((await reader.resolve('openai-codex', { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: 'newer-key' });
});

function browserRedirect(authorizationUrl: string) {
  const url = new URL(getOpenAICodexOAuthConfig().browserRedirectUri);
  url.searchParams.set('code', 'private-browser-code');
  url.searchParams.set('state', new URL(authorizationUrl).searchParams.get('state')!); return url;
}

it('uses isolated browser state/S256, a fixed authorization contract and the browser redirect in one token exchange', async () => {
  const redactor = new CredentialRedactor(), fetcher = vi.fn().mockResolvedValue(json(tokens()));
  const login = beginOpenAICodexBrowserLogin({ fetcher, redactor }), other = beginOpenAICodexBrowserLogin();
  const auth = new URL(login.authorizationUrl), otherAuth = new URL(other.authorizationUrl); other.cancel();
  expect(auth.origin + auth.pathname).toBe('https://auth.openai.com/oauth/authorize');
  expect(auth.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(auth.searchParams.get('state')).not.toBe(otherAuth.searchParams.get('state'));
  expect(auth.searchParams.get('code_challenge')).not.toBe(otherAuth.searchParams.get('code_challenge'));
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.parse(JSON.stringify(login))).toEqual({ authorizationUrl: login.authorizationUrl, expiresAt: login.expiresAt });
  expect((await login.complete(browserRedirect(login.authorizationUrl).href)).subscription).toEqual({ provider: 'openai-codex', accountId });
  const [target, init] = fetcher.mock.calls[0] as [string, RequestInit];
  const form = init.body as URLSearchParams, verifier = form.get('code_verifier')!;
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(Object.fromEntries(auth.searchParams)).toEqual({ response_type: 'code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: auth.searchParams.get('state'),
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'ai-harness' });
  expect(target).toBe('https://auth.openai.com/oauth/token'); expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
  expect(Object.fromEntries(form)).toEqual({ grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    code: 'private-browser-code', code_verifier: verifier, redirect_uri: 'http://localhost:1455/auth/callback' });
  expect(redactor.redact(['private-browser-code', verifier, jwt(), tokens().refresh_token].join(' '))).toBe(Array(4).fill('[REDACTED]').join(' '));
  await expect(login.complete(browserRedirect(login.authorizationUrl).href)).rejects.toThrow('already consumed');
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['origin', 'path', 'userinfo', 'fragment', 'missing-state', 'wrong-state', 'duplicate-state', 'duplicate-code', 'missing-code', 'oversize-code', 'denied'])('rejects browser %s without consuming state or contacting an issuer', async variant => {
  const fetcher = vi.fn().mockResolvedValue(json(tokens())), login = beginOpenAICodexBrowserLogin({ fetcher });
  const url = browserRedirect(login.authorizationUrl);
  if (variant === 'origin') url.hostname = 'remote.test';
  if (variant === 'path') url.pathname = '/other';
  if (variant === 'userinfo') url.username = 'injected';
  if (variant === 'fragment') url.hash = 'code=hidden';
  if (variant === 'missing-state') url.searchParams.delete('state');
  if (variant === 'wrong-state') url.searchParams.set('state', 'other-flow');
  if (variant === 'duplicate-state') url.searchParams.append('state', 'other-flow');
  if (variant === 'duplicate-code') url.searchParams.append('code', 'other-code');
  if (variant === 'missing-code') url.searchParams.delete('code');
  if (variant === 'oversize-code') url.searchParams.set('code', 'x'.repeat(4001));
  if (variant === 'denied') url.searchParams.set('error', 'private-denial-text');
  await expect(login.complete(url.href)).rejects.toThrow('Invalid OpenAI Codex OAuth redirect.');
  expect(fetcher).not.toHaveBeenCalled();
  expect((await login.complete(browserRedirect(login.authorizationUrl).href)).subscription.accountId).toBe(accountId);
});

it('cancels a held browser exchange and releases its late response without exposing caller abort reasons', async () => {
  const caller = new AbortController(), held = deferred<Response>(), reached = deferred<void>();
  const login = beginOpenAICodexBrowserLogin({ signal: caller.signal, fetcher: vi.fn(() => { reached.resolve(); return held.promise; }) });
  const pending = login.complete(browserRedirect(login.authorizationUrl).href).catch(error => error);
  await reached.promise; caller.abort(new Error('private-caller-reason'));
  expect((await pending).message).toBe('OpenAI Codex authentication cancelled.');
  const cancelled = vi.fn(); held.resolve(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});

it('bounds browser login lifetime before exchange and supports explicit cancellation', async () => {
  vi.useFakeTimers(); const fetcher = vi.fn(), login = beginOpenAICodexBrowserLogin({ fetcher });
  vi.setSystemTime(login.expiresAt);
  await expect(login.complete(browserRedirect(login.authorizationUrl).href)).rejects.toThrow('unavailable'); login.cancel();
  const cancelled = beginOpenAICodexBrowserLogin({ fetcher }); cancelled.cancel();
  await expect(cancelled.complete(browserRedirect(cancelled.authorizationUrl).href)).rejects.toThrow('authentication cancelled');
  const caller = new AbortController(); caller.abort(new Error('private-caller-reason'));
  expect(() => beginOpenAICodexBrowserLogin({ signal: caller.signal, fetcher })).toThrow('OpenAI Codex authentication cancelled.');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['private-error', 'missing-account'])('refuses browser %s without exposing issuer credential/error bodies', async variant => {
  const login = beginOpenAICodexBrowserLogin({ fetcher: vi.fn().mockResolvedValue(variant === 'private-error'
    ? json({ error: 'private-issuer-error', access_token: 'private-token' }, 400) : json({ ...tokens(), access_token: 'e30.e30.signature' })) });
  await expect(login.complete(browserRedirect(login.authorizationUrl).href)).rejects.toThrow('OpenAI Codex login failed.');
});
