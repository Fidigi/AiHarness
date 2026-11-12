import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore, ProviderCredentialService } from '@ai-harness/core';
import { AiProxyServer } from '../api/proxy.js';
import { ProviderOAuthService } from './provider-oauth.js';
import { gitHubCopilotCredentialSource } from './github-copilot.js';

const roots: string[] = [], services: ProviderOAuthService[] = [];
const grant = 'disposable-server-github-grant';
const token = 'tid=disposable-server-inference;proxy-ep=proxy.business.githubcopilot.com';
const device = { device_code: 'private-server-device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1 };
const catalogue = { data: [{ id: 'gpt-5-mini', model_picker_enabled: true }, { id: 'claude-fable-5', model_picker_enabled: true, policy: { state: 'disabled' } }] };
const json = (value: unknown) => new Response(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(hold?: 'device' | 'catalogue', expiresIn = 600) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-server-copilot-login-')); roots.push(root);
  const file = path.join(root, 'credentials.enc'), master = 'disposable-server-login-master';
  const reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, master) });
  const credentials = reopen(); await credentials.load();
  const reached = deferred<void>(), held = deferred<Response>();
  const calls: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body ?? '') });
    if (target === 'https://github.com/login/device/code') {
      if (hold === 'device') { reached.resolve(); return held.promise; }
      return json({ ...device, expires_in: expiresIn });
    }
    if (target === 'https://github.com/login/oauth/access_token') return json({ access_token: grant });
    if (target === 'https://api.github.com/copilot_internal/v2/token') return json({ token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (target === 'https://api.business.githubcopilot.com/models') {
      reached.resolve();
      return hold === 'catalogue' ? held.promise : json(catalogue);
    }
    throw new Error('Unexpected outbound request.');
  });
  const proxy = new AiProxyServer(), flatten = vi.spyOn(proxy, 'setApiKey');
  const mount = vi.spyOn(proxy, 'setGitHubCopilotSubscription');
  const service = new ProviderOAuthService(proxy, () => credentials, fetcher); services.push(service);
  return { file, credentials, reopen, reached, held, calls, fetcher, proxy, flatten, mount, service };
}

it('uses the explicit Copilot issuer, persists grant/catalogue separately and composes a fresh native resolver', async () => {
  vi.stubEnv('AI_HARNESS_OAUTH_GITHUB_COPILOT_DEVICE_URL', 'https://unrelated.test/device');
  vi.stubEnv('AI_HARNESS_OAUTH_GITHUB_COPILOT_TOKEN_URL', 'https://unrelated.test/token');
  vi.stubEnv('AI_HARNESS_OAUTH_GITHUB_COPILOT_CLIENT_ID', 'not-authority');
  const f = await fixture();
  expect(f.service.isSupported('github-copilot')).toBe(true);
  const flow = await f.service.start('github-copilot');
  expect(flow).toMatchObject({ provider: 'github-copilot', state: 'pending', userCode: device.user_code, verificationUri: device.verification_uri });
  expect(JSON.stringify(flow)).not.toContain(device.device_code);
  await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('connected'), { timeout: 2500 });
  expect(f.calls).toEqual([
    { url: 'https://github.com/login/device/code', method: 'POST', authorization: null, body: 'client_id=Iv1.b507a08c87ecfe98&scope=read%3Auser' },
    { url: 'https://github.com/login/oauth/access_token', method: 'POST', authorization: null, body: `client_id=Iv1.b507a08c87ecfe98&device_code=${device.device_code}&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code` },
    { url: 'https://api.github.com/copilot_internal/v2/token', method: 'GET', authorization: `Bearer ${grant}`, body: '' },
    { url: 'https://api.business.githubcopilot.com/models', method: 'GET', authorization: `Bearer ${token}`, body: '' },
  ]);
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' }))?.credential).toMatchObject({
    accessToken: token, refreshToken: grant, subscription: { provider: 'github-copilot', availableModelIds: ['gpt-5-mini'] },
  });
  expect(await reader.resolve('github-copilot', { env: {} })).toBeUndefined();
  expect(f.flatten).not.toHaveBeenCalled(); expect(f.mount).toHaveBeenCalledOnce();
  const source = f.mount.mock.calls[0]![1];
  expect(await source()).toMatchObject({ accessToken: token });
  await reader.delete('github-copilot');
  expect(await source()).toBeUndefined();
  expect(JSON.stringify(f.service.get(flow.id))).not.toMatch(/private-server-device|disposable-server/);
  expect(f.credentials.redactor.redact(`${grant} ${token}`)).toBe('[REDACTED] [REDACTED]');
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(await readFile(f.file, 'utf8')).not.toContain(grant);
});

it.each(['before-start', 'after-reservation'] as const)('does not contact GitHub when cancellation wins %s', async moment => {
  const f = await fixture(), caller = new AbortController();
  if (moment === 'before-start') caller.abort();
  else {
    const prepare = f.credentials.prepareOAuthLogin.bind(f.credentials);
    vi.spyOn(f.credentials, 'prepareOAuthLogin').mockImplementationOnce(async (...args) => {
      const publish = await prepare(...args); caller.abort(); return publish;
    });
  }
  await expect(f.service.start('github-copilot', caller.signal)).rejects.toBeInstanceOf(Error);
  expect(f.calls).toEqual([]);
  expect(f.mount).not.toHaveBeenCalled();
});

it('refuses Copilot login without durable storage before contacting the issuer', async () => {
  const fetcher = vi.fn(), service = new ProviderOAuthService(new AiProxyServer(), () => new ProviderCredentialService(), fetcher);
  services.push(service);
  await expect(service.start('github-copilot')).rejects.toMatchObject({ status: 409 });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['logout', 'replacement', 'cancel', 'close', 'new-login', 'expiry'] as const)(
  'a held first-login catalogue cannot resurrect credentials after %s', async mutation => {
    const f = await fixture('catalogue', mutation === 'expiry' ? 2 : 600), flow = await f.service.start('github-copilot');
    await f.reached.promise;
    if (mutation === 'logout') await f.reopen().delete('github-copilot');
    if (mutation === 'replacement') await f.reopen().setApiKey('github-copilot', 'newer-local-key');
    if (mutation === 'cancel') expect(f.service.cancel(flow.id)).toBe(true);
    if (mutation === 'close') f.service.close();
    if (mutation === 'new-login') {
      const next = await f.service.start('github-copilot');
      expect(f.service.get(flow.id)?.state).toBe('cancelled');
      f.service.cancel(next.id);
    }
    if (mutation === 'expiry') await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('expired'), { timeout: 2000 });
    f.held.resolve(json(catalogue));
    if (mutation === 'logout' || mutation === 'replacement') {
      await vi.waitFor(() => expect(f.service.get(flow.id)?.state).toBe('failed'));
    } else if (mutation !== 'close') expect(f.service.get(flow.id)?.state).toBe(mutation === 'expiry' ? 'expired' : 'cancelled');
    const reader = f.reopen(); await reader.load();
    expect((await reader.resolve('github-copilot', { env: {} }))?.credential).toEqual(mutation === 'replacement'
      ? { version: 1, type: 'api-key', apiKey: 'newer-local-key' } : undefined);
    expect(await reader.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot' })).toBeUndefined();
    expect(f.mount).not.toHaveBeenCalled(); expect(f.flatten).not.toHaveBeenCalled();
  });

it.each(['host', 'caller'] as const)('retires a passive Copilot refresh through its %s lifetime', async lifetime => {
  const f = await fixture('catalogue'), host = new AbortController(), caller = new AbortController();
  const original = { accessToken: 'expired-server-inference', refreshToken: grant, expiresAt: Date.now() - 1000,
    subscription: { provider: 'github-copilot' as const, availableModelIds: ['gpt-5-mini'] } };
  await f.credentials.setOAuth('github-copilot', original);
  vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetcher);
  const source = gitHubCopilotCredentialSource(f.credentials, host.signal);
  const pending = source(caller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await f.reached.promise;
  (lifetime === 'host' ? host : caller).abort();
  expect((await pending).error).toMatchObject({ name: 'AbortError' });
  f.held.resolve(json(catalogue));
  const reader = f.reopen(); await reader.load();
  expect((await reader.resolve('github-copilot', { env: {}, subscriptionProvider: 'github-copilot', now: 0 }))?.credential)
    .toEqual({ version: 1, type: 'oauth', ...original });
  expect(f.calls.map(call => call.url)).toEqual(['https://api.github.com/copilot_internal/v2/token', 'https://api.business.githubcopilot.com/models']);
});

it.each(['logout', 'close', 'new-login', 'caller-cancel'] as const)('retires an unpublished device request on %s', async mutation => {
  const f = await fixture('device'), caller = new AbortController();
  const pending = f.service.start('github-copilot', caller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await f.reached.promise;
  if (mutation === 'logout') { f.service.cancelProvider('github-copilot'); await f.credentials.delete('github-copilot'); }
  if (mutation === 'close') f.service.close();
  if (mutation === 'caller-cancel') caller.abort();
  if (mutation === 'new-login') {
    const next = f.service.start('github-copilot').catch(() => undefined);
    f.held.resolve(json(device));
    const flow = await next; if (flow) f.service.cancel(flow.id);
  } else f.held.resolve(json(device));
  expect((await pending).error).toBeInstanceOf(Error);
  expect(f.calls.every(call => call.url.endsWith('/login/device/code'))).toBe(true);
  expect(f.mount).not.toHaveBeenCalled();
  if (mutation === 'close') await expect(f.service.start('github-copilot')).rejects.toMatchObject({ status: 409 });
});
