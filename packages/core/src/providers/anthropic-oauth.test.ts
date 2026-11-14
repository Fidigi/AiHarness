import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../index.js';
const client = '9d1c250a-e61b-44d9-88ed-5944d1962f5e', callback = 'http://localhost:53692/callback', access = 'synthetic-anthropic-access', refresh = 'synthetic-anthropic-refresh';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function credentials() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-anthropic-issuer-')); roots.push(root); const service = new core.ProviderCredentialService({ store: new core.EncryptedCredentialStore(path.join(root, 'credentials.enc'), 'synthetic-anthropic-master') }); await service.load(); return service; }
const tokens = () => Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 });
it('uses the native Anthropic browser PKCE issuer with independent public state and private verifier, typed encrypted publication and retryable redirect validation', async () => {
  const service = await credentials(), publish = await service.prepareOAuthLogin('foreign-claude'); let authorization!: URL;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => { expect(String(url)).toBe('https://platform.claude.com/v1/oauth/token'); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('authorization')).toBeNull();
    const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ client_id: client, grant_type: 'authorization_code', code: 'private-code', redirect_uri: callback, state: authorization.searchParams.get('state') }); expect(body.code_verifier).not.toBe(body.state); expect(authorization.href).not.toContain(body.code_verifier); expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(authorization.searchParams.get('code_challenge')); return tokens(); });
  const flow = core.beginAnthropicBrowserLogin({ fetcher, redactor: service.redactor }); authorization = new URL(flow.authorizationUrl); expect(authorization.origin + authorization.pathname).toBe('https://claude.ai/oauth/authorize'); expect(authorization.searchParams.get('client_id')).toBe(client); expect(authorization.searchParams.get('scope')).toContain('user:inference');
  await expect(flow.complete(callback + '?code=private-code&state=wrong')).rejects.toThrow('redirect'); expect(fetcher).not.toHaveBeenCalled(); const credential = await flow.complete(callback + '?code=private-code&state=' + authorization.searchParams.get('state')); await publish(credential);
  expect(credential).toMatchObject({ accessToken: access, refreshToken: refresh, tokenType: 'Bearer', subscription: { provider: 'anthropic' } }); expect(credential.subscription.grantId).toMatch(/^[a-f0-9-]{36}$/u); expect(credential.expiresAt).toBeGreaterThan(Date.now() + 3200000); expect(credential.expiresAt).toBeLessThan(Date.now() + 3400000);
  const file = path.join(roots[0], 'credentials.enc'); expect((await stat(file)).mode & 0o777).toBe(0o600); expect(await readFile(file, 'utf8')).not.toContain(access); expect(await readFile(file, 'utf8')).not.toContain(refresh);
  expect(await service.resolve('foreign-claude', { env: {} })).toBeUndefined(); expect((await service.resolve('foreign-claude', { env: {}, subscriptionProvider: 'anthropic' }))?.credential).toMatchObject({ subscription: credential.subscription }); const restored = new core.ProviderCredentialService({ store: new core.EncryptedCredentialStore(file, 'synthetic-anthropic-master') }); await restored.load(); expect((await restored.resolve('foreign-claude', { env: {}, subscriptionProvider: 'anthropic' }))?.credential).toMatchObject({ subscription: credential.subscription }); await expect(flow.complete(callback)).rejects.toThrow();
});
it('supports explicit Anthropic copy-code PKCE at the fixed remote callback and rejects a foreign state without consuming login', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => { expect(JSON.parse(String(init?.body)).redirect_uri).toBe('https://platform.claude.com/oauth/code/callback'); return tokens(); }), flow = core.beginAnthropicCopyCodeLogin({ fetcher }), authorization = new URL(flow.authorizationUrl), state = authorization.searchParams.get('state');
  await expect(flow.complete('private-code#foreign')).rejects.toThrow(); await expect(flow.complete('https://foreign.invalid/callback?code=private-code&state=' + state)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled(); expect(await flow.complete('private-code#' + state)).toMatchObject({ accessToken: access });
});
it('refreshes only through the explicit native Anthropic authority and keeps local grant stable, ignoring generic token hints', async () => {
  const service = await credentials(), flow = core.beginAnthropicCopyCodeLogin({ fetcher: async () => tokens() }), credential = await flow.complete('private-code'); await service.setOAuth('claude-slot', { ...credential, expiresAt: 1 });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => { expect(String(url)).toBe('https://platform.claude.com/v1/oauth/token'); expect(JSON.parse(String(init?.body))).toEqual({ grant_type: 'refresh_token', client_id: client, refresh_token: refresh }); return Response.json({ access_token: 'synthetic-anthropic-rotated', refresh_token: 'synthetic-rotated-refresh', expires_in: 3600 }); });
  expect(await service.resolve('claude-slot', { env: {}, fetcher })).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled(); const resolved = await service.resolve('claude-slot', { env: {}, subscriptionProvider: 'anthropic', fetcher, oauth: { tokenUrl: 'https://foreign.invalid/token', clientId: 'foreign', clientSecret: 'private-foreign' } }); expect(resolved?.credential).toMatchObject({ accessToken: 'synthetic-anthropic-rotated', subscription: credential.subscription }); expect(fetcher).toHaveBeenCalledOnce();
});
it('restricts browser callbacks and full redirects to the exact owned loopback path/port, rejecting ambiguous candidates before exchange', async () => {
  for (const callbackUrl of ['https://localhost:53692/callback', 'http://foreign.invalid:53692/callback', 'http://user@localhost:53692/callback', 'http://localhost/callback', 'http://localhost:53692/other', callback + '?code=x']) expect(() => core.beginAnthropicBrowserLogin({ callbackUrl })).toThrow();
  const fetcher = vi.fn<typeof fetch>(async () => tokens()), flow = core.beginAnthropicBrowserLogin({ callbackUrl: 'http://localhost:45213/callback', fetcher }), state = new URL(flow.authorizationUrl).searchParams.get('state'), valid = flow.callbackUrl + '?code=private-code&state=' + state;
  for (const invalid of [valid.replace('45213', '53692'), valid.replace('localhost', 'foreign.invalid'), valid + '&code=other', valid + '&state=' + state, valid + '#fragment', valid.replace('/callback?', '/callback/extra?')]) await expect(flow.complete(invalid)).rejects.toThrow('redirect');
  expect(fetcher).not.toHaveBeenCalled(); await expect(flow.complete(valid)).resolves.toMatchObject({ accessToken: access });
});
it('bounds native Anthropic token response/expiry and actual Bearer header admission, redacts secrets and consumes failed exchange', async () => {
  for (const data of [{ access_token: access, refresh_token: refresh, expires_in: 0 }, { access_token: access, expires_in: 3600 }, { access_token: access, refresh_token: refresh, expires_in: 1e30 }, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Basic' }, { access_token: 'private-\u2603', refresh_token: refresh, expires_in: 3600 }]) {
    const redactor = new core.CredentialRedactor(), fetcher = vi.fn<typeof fetch>(async () => Response.json(data)), flow = core.beginAnthropicCopyCodeLogin({ fetcher, redactor }); const error = await flow.complete('private-code').catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(access); expect(redactor.redact(data.access_token)).not.toContain(data.access_token); await expect(flow.complete('private-code')).rejects.toThrow('consumed'); expect(fetcher).toHaveBeenCalledOnce();
  }
});
it('clips caller/owner/expiry before work without consuming a pre-aborted caller and mints new local grants per login', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => tokens()), flow = core.beginAnthropicCopyCodeLogin({ fetcher }), abort = new AbortController(); abort.abort(); await expect(flow.complete('private-code', abort.signal)).rejects.toThrow('cancelled'); expect(fetcher).not.toHaveBeenCalled(); const first = await flow.complete('private-code');
  const second = await core.beginAnthropicCopyCodeLogin({ fetcher }).complete('private-code'); expect(first.subscription.grantId).not.toBe(second.subscription.grantId);
  const cancelled = core.beginAnthropicCopyCodeLogin({ fetcher }); cancelled.cancel(); await expect(cancelled.complete('private-code')).rejects.toThrow('cancelled'); vi.useFakeTimers(); const expired = core.beginAnthropicCopyCodeLogin({ fetcher }); vi.setSystemTime(Date.now() + 300001); await expect(expired.complete('private-code')).rejects.toThrow('expired'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('retires a native Anthropic held body without awaiting hostile cancellation or publishing late credentials', async () => {
  let enter!: () => void, finish!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), cancel = vi.fn(() => new Promise<void>(() => {}));
  const flow = core.beginAnthropicCopyCodeLogin({ fetcher: async () => new Response(new ReadableStream<Uint8Array>({ pull() { enter(); return new Promise<void>(resolve => { finish = resolve; }); }, cancel }, { highWaterMark: 0 })) });
  const caller = new AbortController(), outcome = flow.complete('private-code', caller.signal).then(() => 'unexpected-success', error => String(error)); await entered; caller.abort(); expect(await outcome).toContain('cancelled'); expect(cancel).toHaveBeenCalledOnce(); finish(); await expect(flow.complete('private-code')).rejects.toThrow('consumed');
});
it('refuses native refresh publication after logout and keeps offline/admin reads passive', async () => {
  const service = await credentials(), credential = await core.beginAnthropicCopyCodeLogin({ fetcher: async () => tokens() }).complete('private-code'); await service.setOAuth('retired-claude', { ...credential, expiresAt: 1 });
  let enter!: () => void, release!: (response: Response) => void; const entered = new Promise<void>(resolve => { enter = resolve; }), fetcher = vi.fn<typeof fetch>(() => { enter(); return new Promise<Response>(resolve => { release = resolve; }); });
  expect(await service.resolve('retired-claude', { env: {}, subscriptionProvider: 'anthropic', allowRefresh: false, fetcher })).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled(); expect(service.readStoredCredential('retired-claude')).toMatchObject({ expiresAt: 1 });
  const outcome = service.resolve('retired-claude', { env: {}, subscriptionProvider: 'anthropic', fetcher }).then(() => 'unexpected-success', error => String(error)); await entered; await service.delete('retired-claude'); release(tokens()); expect(await outcome).not.toBe('unexpected-success'); await Promise.resolve(); expect(service.readStoredCredential('retired-claude')).toBeUndefined();
});
