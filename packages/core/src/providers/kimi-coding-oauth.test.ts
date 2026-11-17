import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as kimi from './kimi-coding-oauth.js';
import { CredentialRedactor, ProviderCredentialService, type ProviderOAuthCredential } from './credentials.js';
import { EncryptedCredentialStore } from '../security/credential-store.js';
const directories: string[] = [], host = 'https://issuer.kimi.test/prefix';
const identity = { provider: 'kimi-coding', oauthHost: host, grantId: '12345678-1234-4234-8234-123456789abc' } as const;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-kimi-issuer-')); directories.push(root);
  const file = path.join(root, 'credentials.enc'), store = new EncryptedCredentialStore(file, 'synthetic-kimi-issuer-master'), service = new ProviderCredentialService({ store }); await service.load();
  return { file, store, service };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const expired = () => ({ version: 1, type: 'oauth', accessToken: 'synthetic-old-access', refreshToken: 'synthetic-old-refresh', expiresAt: 1, subscription: identity }) satisfies ProviderOAuthCredential;
function transport(redactor: CredentialRedactor) {
  let polls = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), form = Object.fromEntries(init!.body as URLSearchParams);
    expect(init!.redirect).toBe('manual'); expect(new Headers(init!.headers).get('authorization')).toBeNull();
    expect(form.client_id).toBe(kimi.KIMI_CODING_OAUTH_CLIENT_ID); expect(form.client_secret).toBeUndefined();
    if (target.endsWith('/device_authorization')) { expect(form).toEqual({ client_id: kimi.KIMI_CODING_OAUTH_CLIENT_ID }); return json({ device_code: 'synthetic-private-device', user_code: 'PUBLIC-CODE', verification_uri: 'https://verify.kimi.test/device', verification_uri_complete: 'https://verify.kimi.test/device?code=PUBLIC-CODE', expires_in: 900, interval: 0.001 }); }
    expect(target).toBe(host + '/api/oauth/token'); expect(form).toMatchObject({ device_code: 'synthetic-private-device', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    expect(redactor.redact(form.device_code!)).not.toContain(form.device_code!);
    if (++polls === 1) return json({ error: 'authorization_pending' }, 400);
    return json({ access_token: 'synthetic-kimi-access', refresh_token: 'synthetic-kimi-refresh', expires_in: 3600 });
  });
}
it('offers a Core-owned native Kimi device login, guarded encrypted publication and an issuer-owned credential', async () => {
  expect(typeof kimi.beginKimiCodingDeviceLogin).toBe('function');
  const f = await fixture(), controller = new AbortController(), publish = await f.service.prepareOAuthLogin('foreign-label', controller.signal), fetcher = transport(f.service.redactor);
  const flow = await kimi.beginKimiCodingDeviceLogin({ oauthHost: host, signal: controller.signal, fetcher, redactor: f.service.redactor });
  expect(flow).toMatchObject({ userCode: 'PUBLIC-CODE', verificationUri: 'https://verify.kimi.test/device?code=PUBLIC-CODE' });
  const credential = await flow.complete(); expect(credential.subscription).toMatchObject({ provider: 'kimi-coding', oauthHost: host }); expect(credential.subscription.grantId).toMatch(/^[a-f0-9-]{36}$/u);
  await publish(credential); expect(fetcher).toHaveBeenCalledTimes(3); expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(await f.service.resolve('foreign-label', { env: {} })).toBeUndefined();
  expect((await f.service.resolve('foreign-label', { env: {}, subscriptionProvider: 'kimi-coding' }))?.credential).toMatchObject({ subscription: credential.subscription });
  await expect(flow.complete()).rejects.toThrow();
  const bytes = await readFile(f.file, 'utf8'); for (const secret of ['synthetic-kimi-access', 'synthetic-kimi-refresh', 'synthetic-private-device']) expect(bytes).not.toContain(secret);
});
it('refreshes native Kimi against its persisted issuer rather than generic OAuth hints, preserving the local grant on restart', async () => {
  const f = await fixture(); await f.service.setOAuth('foreign-label', expired());
  const restarted = new ProviderCredentialService({ store: new EncryptedCredentialStore(f.file, 'synthetic-kimi-issuer-master') }); await restarted.load();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => { expect(String(url)).toBe(host + '/api/oauth/token'); expect(init!.redirect).toBe('manual'); expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({ grant_type: 'refresh_token', refresh_token: 'synthetic-old-refresh', client_id: kimi.KIMI_CODING_OAUTH_CLIENT_ID }); return json({ access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', expires_in: 3600 }); });
  const result = await restarted.resolve('foreign-label', { env: {}, subscriptionProvider: 'kimi-coding', fetcher, oauth: { tokenUrl: 'https://unselected.test/token', clientId: 'wrong', clientSecret: 'unselected-secret' } });
  expect(result?.credential).toMatchObject({ accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh', subscription: identity }); expect(fetcher).toHaveBeenCalledOnce();
  await f.service.load(); expect((await f.service.resolve('foreign-label', { env: {}, subscriptionProvider: 'kimi-coding', allowRefresh: false }))?.credential).toEqual(result?.credential);
});
it('refuses foreign issuers, changed Kimi realms, offline expiry and generic/label/API-key substitution before refresh I/O', async () => {
  const f = await fixture(); await f.service.setOAuth('kimi-coding', expired()); const fetcher = vi.fn<typeof fetch>(), bytes = await readFile(f.file);
  for (const options of [{}, { subscriptionProvider: 'openai-codex' as const }, { subscriptionProvider: 'kimi-coding' as const, kimiOAuthHost: 'https://foreign.kimi.test' }, { subscriptionProvider: 'kimi-coding' as const, allowRefresh: false }]) expect(await f.service.resolve('kimi-coding', { ...options, env: {}, fetcher })).toBeUndefined();
  expect(await readFile(f.file)).toEqual(bytes);
  await f.service.setOAuth('generic', { accessToken: 'generic-access', refreshToken: 'generic-refresh', expiresAt: Date.now() + 3600000 });
  expect(await f.service.resolve('generic', { env: {}, subscriptionProvider: 'kimi-coding', fetcher })).toBeUndefined();
  expect(await f.service.resolve('kimi-coding', { env: { KIMI_CODING_API_KEY: 'synthetic-key' }, subscriptionProvider: 'kimi-coding', fetcher })).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not publish a native first login over a concurrent absent-slot logout', async () => {
  const f = await fixture(), controller = new AbortController(), publish = await f.service.prepareOAuthLogin('label', controller.signal);
  const flow = await kimi.beginKimiCodingDeviceLogin({ oauthHost: host, fetcher: transport(f.service.redactor), redactor: f.service.redactor }); await f.service.delete('label');
  const credential = await flow.complete(); await expect(publish(credential)).rejects.toThrow(); expect(await f.service.resolve('label', { env: {}, subscriptionProvider: 'kimi-coding' })).toBeUndefined();
});
it('cancels an owned Kimi device body without waiting for hostile cancellation or exposing provider text', async () => {
  const controller = new AbortController(); let cancel = 0, reached!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; });
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"private":"synthetic-secret"')); reached(); }, cancel() { cancel++; return new Promise(() => undefined); } }));
  const pending = kimi.beginKimiCodingDeviceLogin({ oauthHost: host, signal: controller.signal, fetcher }); const rejected = expect(pending).rejects.toThrow('Kimi Coding'); await ready; controller.abort(); await rejected; expect(cancel).toBe(1);
});
it('releases a late native Kimi refresh body after caller retirement without changing its credential', async () => {
  const service = new ProviderCredentialService(); await service.setOAuth('label', expired(), false); const controller = new AbortController(); let release!: (response: Response) => void, entered!: () => void, cancelled = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.fn<typeof fetch>(async () => { entered(); return held; });
  const pending = service.resolve('label', { env: {}, subscriptionProvider: 'kimi-coding', fetcher, signal: controller.signal }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await ready; controller.abort(); expect((await pending).error).toBeDefined(); release(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => undefined); } })));
  await new Promise<void>(resolve => setImmediate(resolve)); expect(cancelled).toBe(1); expect(service.readStoredCredential('label')).toEqual(expired());
});
it('retries native Kimi transient network/429 responses with bounded backoff and no generic issuer borrowing', async () => {
  const service = new ProviderCredentialService(); await service.setOAuth('label', expired(), false); vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('synthetic network failure')).mockResolvedValueOnce(json({ error: 'temporarily_unavailable' }, 429)).mockResolvedValueOnce(json({ access_token: 'synthetic-recovered', refresh_token: 'synthetic-recovered-refresh', expires_in: 3600 }));
  const pending = service.resolve('label', { env: {}, subscriptionProvider: 'kimi-coding', fetcher }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).value?.credential).toMatchObject({ accessToken: 'synthetic-recovered', subscription: identity }); expect(fetcher).toHaveBeenCalledTimes(3);
});
it.each([{ status: 401, error: 'unauthorized' }, { status: 403, error: 'forbidden' }, { status: 500, error: 'invalid_grant' }])('does not retry Kimi authorization refusal $status/$error', async response => {
  const service = new ProviderCredentialService(); await service.setOAuth('label', expired(), false);
  const fetcher = vi.fn<typeof fetch>(async () => json({ error: response.error }, response.status));
  await expect(service.resolve('label', { env: {}, subscriptionProvider: 'kimi-coding', fetcher })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce(); expect(service.readStoredCredential('label')).toEqual(expired());
});
it('bounds native Kimi refresh to the initial request plus three retries', async () => {
  const service = new ProviderCredentialService(); await service.setOAuth('label', expired(), false); vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>(async () => json({ error: 'temporarily_unavailable' }, 503));
  const pending = service.resolve('label', { env: {}, subscriptionProvider: 'kimi-coding', fetcher }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await vi.advanceTimersByTimeAsync(7000); expect((await pending).error).toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(4); expect(service.readStoredCredential('label')).toEqual(expired());
});
it('cancels native Kimi retry backoff without new requests or credential replacement', async () => {
  const service = new ProviderCredentialService(); await service.setOAuth('label', expired(), false); vi.useFakeTimers(); const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async () => json({ error: 'temporarily_unavailable' }, 503));
  const pending = service.resolve('label', { env: {}, subscriptionProvider: 'kimi-coding', fetcher, signal: controller.signal }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await vi.advanceTimersByTimeAsync(0); controller.abort(); expect((await pending).error).toBeDefined(); await vi.advanceTimersByTimeAsync(10000); expect(fetcher).toHaveBeenCalledOnce(); expect(service.readStoredCredential('label')).toEqual(expired());
});
it.each([{}, { ...identity, oauthHost: 'http://issuer.kimi.test' }, { ...identity, grantId: 'not-a-grant' }])('rejects malformed native Kimi identity %# without a credential mutation', async subscription => {
  const f = await fixture(); await expect(f.service.setOAuth('label', { ...expired(), subscription } as ProviderOAuthCredential)).rejects.toThrow(); expect(f.service.list()).toEqual([]);
});
