import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as oauth from '../index.js';
import { CredentialRedactor, ProviderCredentialService } from './credentials.js';
import { EncryptedCredentialStore } from '../security/credential-store.js';
const callback = 'http://127.0.0.1:32123/oauth/callback/293da824-4f8b-4d80-84b9-e542c22215eb', key = 'synthetic-openrouter-permanent-key';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'aih-openrouter-oauth-')); roots.push(root); const file = path.join(root, 'credentials.enc'), service = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'synthetic-openrouter-master') }); await service.load(); return { file, service }; }
it('uses fixed OpenRouter PKCE to publish a permanent API key rather than an expiring refresh credential', async () => {
  const f = await fixture(), controller = new AbortController(), publish = await f.service.prepareApiKeyLogin('foreign-label', controller.signal); let authorization!: URL;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://openrouter.ai/api/v1/auth/keys'); expect(init!.redirect).toBe('manual'); expect(new Headers(init!.headers).get('authorization')).toBeNull();
    const body = JSON.parse(String(init!.body)); expect(body).toMatchObject({ code: 'private-authorization-code', code_challenge_method: 'S256' }); expect(Object.keys(body).sort()).toEqual(['code', 'code_challenge_method', 'code_verifier']);
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(authorization.searchParams.get('code_challenge')); return Response.json({ key });
  });
  const flow = oauth.beginOpenRouterLogin(callback, { signal: controller.signal, fetcher, redactor: f.service.redactor }); authorization = new URL(flow.authorizationUrl);
  expect(authorization.origin + authorization.pathname).toBe('https://openrouter.ai/auth'); expect(authorization.searchParams.get('callback_url')).toBe(callback); expect(authorization.searchParams.has('state')).toBe(false);
  await expect(flow.complete(callback.replace('293da824', '393da824') + '?code=private-authorization-code')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  const result = await flow.complete(callback + '?code=private-authorization-code'); expect(result).toEqual({ apiKey: key }); await publish(result.apiKey);
  expect((await f.service.resolve('foreign-label', { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: key }); expect(f.service.list()).toMatchObject([{ provider: 'foreign-label', type: 'api-key', refreshable: false }]);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600); expect(await readFile(f.file, 'utf8')).not.toContain(key); await expect(flow.complete(callback + '?code=again')).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
});
it('reserves API-key login before work and rejects concurrent absent-slot logout without resurrection', async () => {
  const f = await fixture(), publish = await f.service.prepareApiKeyLogin('openrouter'); await f.service.delete('openrouter'); await expect(publish(key)).rejects.toThrow(); expect(await f.service.resolve('openrouter', { env: {} })).toBeUndefined();
});
it('keeps existing OAuth publisher normalization asynchronous and leaves malformed input unconsumed', async () => {
  const f = await fixture(), publish = await f.service.prepareOAuthLogin('oauth-label');
  const invalid = Object.defineProperty({}, 'accessToken', { enumerable: true, get() { throw new Error('synthetic normalization failure'); } });
  await expect(publish(invalid as { accessToken: string })).rejects.toThrow('synthetic normalization failure');
  await expect(publish({ accessToken: 'synthetic-valid-access' })).resolves.toMatchObject({ type: 'oauth' });
});
it('does not consume the pending flow on malformed or duplicate callback input', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ key })), flow = oauth.beginOpenRouterLogin(callback, { fetcher });
  for (const value of [callback + '?code=x&code=y', callback + '?error=denied&code=x', callback.replace('127.0.0.1', 'localhost') + '?code=x', 'private-code-only']) await expect(flow.complete(value)).rejects.toThrow('redirect');
  expect(fetcher).not.toHaveBeenCalled(); expect(await flow.complete(callback + '?code=accepted')).toEqual({ apiKey: key });
});
it('rejects oversized/malformed/denied key responses without reflecting provider secrets', async () => {
  const redactor = new CredentialRedactor(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ key, error_description: 'private-provider-error' }, { status: 400 })), flow = oauth.beginOpenRouterLogin(callback, { fetcher, redactor });
  await expect(flow.complete(callback + '?code=private-code')).rejects.toThrow('OpenRouter'); expect(redactor.redact(key)).not.toContain(key);
  for (const body of [{}, { key: 'bad\nkey' }, { key: 'synthetic-\u2603' }, { key: 'x'.repeat(65537) }]) await expect(oauth.beginOpenRouterLogin(callback, { fetcher: async () => Response.json(body) }).complete(callback + '?code=private-code')).rejects.toThrow('OpenRouter');
});
it('retires owned and late OpenRouter exchange bodies without waiting for hostile cancellation', async () => {
  for (const stage of ['body', 'late'] as const) {
    const caller = new AbortController(); let cancel = 0, release!: (response: Response) => void, entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<Response>(resolve => { release = resolve; });
    const response = () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel() { cancel++; return new Promise(() => undefined); } }));
    const fetcher: typeof fetch = async () => { entered(); return stage === 'late' ? held : response(); };
    const flow = oauth.beginOpenRouterLogin(callback, { signal: caller.signal, fetcher }), pending = flow.complete(callback + '?code=private-code').catch(error => error); await ready; await new Promise<void>(resolve => setImmediate(resolve)); caller.abort(); expect(await pending).toBeInstanceOf(Error);
    if (stage === 'late') release(response()); await new Promise<void>(resolve => setImmediate(resolve)); expect(cancel).toBe(1);
  }
});
it('expires OpenRouter login and rejects unsafe callback endpoints before exchange', async () => {
  const fetcher = vi.fn<typeof fetch>(); for (const uri of ['https://foreign.test/oauth/callback/id', 'http://127.0.0.1:32123/callback', callback + '?wrong=1']) expect(() => oauth.beginOpenRouterLogin(uri, { fetcher })).toThrow();
  vi.useFakeTimers(); const flow = oauth.beginOpenRouterLogin(callback, { fetcher }); await vi.advanceTimersByTimeAsync(300000); await expect(flow.complete(callback + '?code=private-code')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
