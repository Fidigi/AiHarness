import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { beginRadiusBrowserLogin, beginRadiusDeviceLogin, refreshRadiusToken, getRadiusOAuthConfig,
  CredentialRedactor, ProviderCredentialService, EncryptedCredentialStore, type RadiusOAuthIdentity } from '../index.js';

const gateway = 'https://synthetic-radius.test', roots: string[] = [];
const subscription: RadiusOAuthIdentity = { provider: 'radius', gateway, grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' };
const device = { device_code: 'private-radius-device', user_code: 'VISIBLE CODE', verification_uri: 'https://synthetic-login.test/device', expires_in: 600, interval: 1 };
const tokens = { access_token: 'private-radius-access', refresh_token: 'private-radius-refresh', expires_in: 3600 };
const stored = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() - 1000, subscription };
const options = { env: {}, subscriptionProvider: 'radius' as const };
const json = (value: unknown, status = 200) => Response.json(value, { status });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-radius-oauth-')); roots.push(root);
  const file = path.join(root, 'credentials.enc'), reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'disposable-radius-master-key') });
  const service = reopen(); await service.load(); return { file, service, reopen };
}
it('uses the fixed public client and configured gateway for device login, without leaking private device/token data', async () => {
  vi.useFakeTimers(); const redactor = new CredentialRedactor();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json(tokens));
  const config = getRadiusOAuthConfig(gateway); expect(Object.isFrozen(config)).toBe(true);
  expect(getRadiusOAuthConfig().gateway).toBe('https://radius.pi.dev');
  const login = await beginRadiusDeviceLogin({ gateway, fetcher, redactor });
  expect(JSON.parse(JSON.stringify(login))).toEqual({ userCode: device.user_code, verificationUri: device.verification_uri, expiresAt: login.expiresAt });
  const pending = login.complete(); await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); const result = await pending;
  expect(result).toMatchObject({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + 3540000, subscription: { provider: 'radius', gateway } });
  expect(result.subscription.grantId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([gateway + '/v1/oauth/device', gateway + '/v1/oauth/token']);
  expect(Object.fromEntries(fetcher.mock.calls[0]![1]!.body as URLSearchParams)).toEqual({ client_id: 'pi-gateway', scope: 'gateway offline_access' });
  expect(Object.fromEntries(fetcher.mock.calls[1]![1]!.body as URLSearchParams)).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'pi-gateway', device_code: device.device_code });
  expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'manual')).toBe(true);
  expect(redactor.redact([device.device_code, result.accessToken, result.refreshToken].join(' '))).toBe('[REDACTED] [REDACTED] [REDACTED]');
  await expect(login.complete()).rejects.toThrow('already consumed');
});
it('keeps pending/slow_down polling intervals, consumes success once and distinguishes a new grant', async () => {
  vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json({ error: 'authorization_pending' }, 400))
    .mockResolvedValueOnce(json({ error: 'slow_down' }, 400)).mockResolvedValueOnce(json(tokens)).mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json(tokens));
  const login = await beginRadiusDeviceLogin({ gateway, fetcher }), result = login.complete();
  await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5999); expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); const first = await result;
  const next = await beginRadiusDeviceLogin({ gateway, fetcher }), pending = next.complete(); await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).subscription.grantId).not.toBe(first.subscription.grantId);
});
it('discovers browser navigation only and binds S256/state/full redirect exchange to the fixed loopback URI', async () => {
  const redactor = new CredentialRedactor(), fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ authorizationEndpoint: 'https://synthetic-login.test/authorize', tokenEndpoint: 'https://not-authority.test/token' })).mockResolvedValueOnce(json(tokens));
  const login = await beginRadiusBrowserLogin({ gateway, fetcher, redactor }), url = new URL(login.authorizationUrl), state = url.searchParams.get('state')!;
  expect(url.origin).toBe('https://synthetic-login.test'); expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1456/oauth/callback');
  expect(url.searchParams.get('client_id')).toBe('pi-gateway'); expect(url.searchParams.get('scope')).toBe('gateway offline_access'); expect(url.searchParams.get('handoff')).toBe('url');
  for (const candidate of ['http://localhost:1456/oauth/callback?state=' + state + '&code=private-code',
    'http://127.0.0.1:1456/oauth/callback?state=wrong&code=private-code',
    `http://127.0.0.1:1456/oauth/callback?state=${state}&code=one&code=two`,
    `http://127.0.0.1:1456/oauth/callback?state=${state}&code=private-code#fragment`]) await expect(login.complete(candidate)).rejects.toThrow('Invalid Radius OAuth redirect.');
  expect(fetcher).toHaveBeenCalledOnce();
  const credential = await login.complete(`http://127.0.0.1:1456/oauth/callback?state=${state}&code=private-code`);
  const body = Object.fromEntries(fetcher.mock.calls[1]![1]!.body as URLSearchParams);
  expect(body).toMatchObject({ grant_type: 'authorization_code', client_id: 'pi-gateway', redirect_uri: 'http://127.0.0.1:1456/oauth/callback', code: 'private-code' });
  expect(createHash('sha256').update(body.code_verifier!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(fetcher.mock.calls.map(call => call[0])).toEqual([gateway + '/v1/oauth', gateway + '/v1/oauth/token']);
  expect(credential.subscription.gateway).toBe(gateway); expect(redactor.redact('private-code ' + body.code_verifier)).toBe('[REDACTED] [REDACTED]');
  await expect(login.complete('ignored')).rejects.toThrow('already consumed');
});
it('rotates encrypted credentials under the selected issuer and stable local grant, independent of label and generic OAuth hints', async () => {
  const f = await fixture(); await f.service.setOAuth('team-radius', stored);
  expect(await f.service.resolve('team-radius', { env: {} })).toBeUndefined();
  expect(await f.service.resolve('team-radius', { env: {}, subscriptionProvider: 'openai-codex' })).toBeUndefined();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...tokens, access_token: 'private-radius-rotated', refresh_token: 'private-radius-rotated-refresh' }));
  const result = await f.service.resolve('team-radius', { ...options, fetcher, oauth: { tokenUrl: 'https://not-authority.test/token', clientId: 'unrelated' } });
  expect(result?.credential).toMatchObject({ accessToken: 'private-radius-rotated', refreshToken: 'private-radius-rotated-refresh', subscription });
  expect(fetcher.mock.calls[0]![0]).toBe(gateway + '/v1/oauth/token');
  expect(Object.fromEntries(fetcher.mock.calls[0]![1]!.body as URLSearchParams)).toEqual({ grant_type: 'refresh_token', client_id: 'pi-gateway', refresh_token: tokens.refresh_token });
  const reader = f.reopen(); await reader.load(); expect((await reader.resolve('team-radius', { ...options, allowRefresh: false }))?.credential).toEqual(result?.credential);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600); expect(await readFile(f.file, 'utf8')).not.toContain('private-radius');
  const refreshed = await refreshRadiusToken('private-old-refresh', subscription, { fetcher: vi.fn().mockResolvedValue(json({ access_token: 'private-new-access', expires_in: 3600 })) });
  expect(refreshed.refreshToken).toBe('private-old-refresh'); expect(refreshed.subscription).toEqual(subscription);
});
it('does not infer Radius authority from an API key, a generic credential, a label or an alternate gateway', async () => {
  const service = new ProviderCredentialService(); await service.setApiKey('radius', 'synthetic-key', false); expect(await service.resolve('radius', options)).toBeUndefined();
  await service.setOAuth('radius', { ...stored, subscription: undefined }, false); expect(await service.resolve('radius', options)).toBeUndefined();
  for (const mutation of [{ gateway: 'http://not-loopback.test' }, { gateway: gateway + '?key=private' }, { grantId: 'label-is-not-a-grant' }]) {
    await expect(service.setOAuth('radius', { ...stored, subscription: { ...subscription, ...mutation } }, false)).rejects.toThrow('invalid');
  }
  const fetcher = vi.fn<typeof fetch>(); await expect(refreshRadiusToken(tokens.refresh_token, subscription, { gateway: 'https://other-radius.test', fetcher })).rejects.toThrow('Radius token refresh failed.'); expect(fetcher).not.toHaveBeenCalled();
});
it.each([{ access_token: 'private\r\ninjected: yes' }, { refresh_token: 'private with whitespace' }, { expires_in: 0 }, { expires_in: null }])('refuses malformed token fields %j without exposing private response data', async mutation => {
  await expect(refreshRadiusToken('private-refresh', subscription, { fetcher: vi.fn().mockResolvedValue(json({ ...tokens, ...mutation })) })).rejects.toThrow('Radius token refresh failed.');
});
it.each(['access_denied', 'expired_token'])('refuses terminal device %s without leaking server diagnostics', async error => {
  vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(device)).mockResolvedValueOnce(json({ error, error_description: 'private-server-detail' }, 400));
  const login = await beginRadiusDeviceLogin({ gateway, fetcher }), pending = login.complete().catch(error => error);
  await vi.advanceTimersByTimeAsync(1000); expect((await pending).message).toBe('Radius device login failed.');
});
it.each(['oversize-header', 'oversize-body', 'utf8', 'private-error'])('bounds %s responses and emits fixed errors', async mode => {
  const response = mode === 'oversize-header' ? new Response('{}', { headers: { 'content-length': '262145' } }) : mode === 'oversize-body' ? new Response('x'.repeat(262145))
    : mode === 'utf8' ? new Response(new Uint8Array([255])) : json({ error: 'private-detail' }, 500);
  await expect(beginRadiusDeviceLogin({ gateway, fetcher: vi.fn().mockResolvedValue(response) })).rejects.toThrow('Radius device authorization failed.');
});
it.each(['pending-fetch', 'body', 'device-poll', 'browser-exchange'])('retires %s work and never publishes late credentials', async phase => {
  const caller = new AbortController(), held = deferred<Response>(), reached = deferred<void>(), cancelled = vi.fn();
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled }));
  if (phase === 'pending-fetch' || phase === 'body') {
    const fetcher = vi.fn<typeof fetch>(() => { reached.resolve(undefined); return phase === 'body' ? Promise.resolve(response) : held.promise; });
    const pending = beginRadiusDeviceLogin({ gateway, fetcher, signal: caller.signal }).catch(error => error); await reached.promise;
    if (phase === 'body') await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    caller.abort(); expect((await pending).message).toBe('Radius authentication cancelled.');
    if (phase === 'pending-fetch') held.resolve(response); await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce()); return;
  }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(phase === 'device-poll' ? device : { authorizationEndpoint: 'https://synthetic-login.test/auth' })).mockImplementation(() => { reached.resolve(undefined); return held.promise; });
  if (phase === 'device-poll') {
    const login = await beginRadiusDeviceLogin({ gateway, fetcher, signal: caller.signal }), pending = login.complete().catch(error => error); await reached.promise;
    caller.abort(); expect((await pending).message).toBe('Radius authentication cancelled.');
  } else {
    const login = await beginRadiusBrowserLogin({ gateway, fetcher, signal: caller.signal }), state = new URL(login.authorizationUrl).searchParams.get('state');
    const pending = login.complete(`http://127.0.0.1:1456/oauth/callback?state=${state}&code=private-code`).catch(error => error); await reached.promise;
    caller.abort(); expect((await pending).message).toBe('Radius authentication cancelled.');
  }
  held.resolve(response); await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});
it('keeps cancellation and replacement ahead of initial login/refresh publication, including another store owner', async () => {
  const f = await fixture(), publisher = await f.service.prepareOAuthLogin('team-radius');
  const other = f.reopen(); await other.load(); await other.delete('team-radius');
  await expect(publisher({ ...stored, expiresAt: Date.now() + 3600000 })).rejects.toThrow('changed');
  await f.service.setOAuth('team-radius', stored); const before = await readFile(f.file), held = deferred<Response>(), reached = deferred<void>(), caller = new AbortController();
  const pending = f.service.resolve('team-radius', { ...options, signal: caller.signal, fetcher: vi.fn(() => { reached.resolve(undefined); return held.promise; }) }).catch(error => error);
  await reached.promise; caller.abort(); expect(await pending).toBeInstanceOf(Error); expect(await readFile(f.file)).toEqual(before);
  const cancel = vi.fn(); held.resolve(new Response(new ReadableStream({ cancel }))); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  const held2 = deferred<Response>(), reached2 = deferred<void>();
  const replaced = f.service.resolve('team-radius', { ...options, fetcher: vi.fn(() => { reached2.resolve(undefined); return held2.promise; }) }).catch(error => error);
  await reached2.promise; await other.setApiKey('team-radius', 'private-replacement'); held2.resolve(json(tokens)); expect(await replaced).toBeInstanceOf(Error);
  const latest = f.reopen(); await latest.load(); expect((await latest.resolve('team-radius', { env: {} }))?.credential).toMatchObject({ apiKey: 'private-replacement' });
});
