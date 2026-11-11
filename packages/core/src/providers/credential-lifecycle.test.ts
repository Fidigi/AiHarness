import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EncryptedCredentialStore } from '../security/credential-store.js';
import { ProviderCredentialService } from './credentials.js';

const roots: string[] = [];
const original = { accessToken: 'original-access', refreshToken: 'original-refresh', expiresAt: 100_000 };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(persistent = true, credential = original) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-credential-lifetime-')); roots.push(root);
  const file = path.join(root, 'credentials.enc');
  const reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'disposable-lifecycle-master') });
  const store = new EncryptedCredentialStore(file, 'disposable-lifecycle-master');
  const service = persistent ? new ProviderCredentialService({ store }) : new ProviderCredentialService();
  await service.load(); await service.setOAuth('openai', credential, persistent);
  return { service, reopen, store };
}
async function refreshing(service: ProviderCredentialService) {
  let ready!: () => void, release!: (response: Response) => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  const result = service.resolve('openai', { env: {}, now: 200_000,
    oauth: { tokenUrl: 'https://oauth.example.test/token', clientId: 'test-client' },
    fetcher: (async () => { ready(); return response; }) as typeof fetch,
  }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await started;
  return { result, finish: (prefix = 'withdrawn') => release(new Response(JSON.stringify({ access_token: `${prefix}-access`,
    refresh_token: `${prefix}-refresh`, expires_in: 3600 }), { headers: { 'content-type': 'application/json' } })) };
}

it('refuses requested persistence without a store but keeps explicit process-local credentials', async () => {
  const service = new ProviderCredentialService();
  await expect(service.setApiKey('openai', 'not-durable')).rejects.toMatchObject({ code: 'storage-unavailable' });
  await expect(service.setOAuth('openai', original)).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(service.list()).toEqual([]);
  await service.setApiKey('openai', 'explicit-memory', false);
  expect((await service.resolve('openai', { env: {} }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: 'explicit-memory' });
});

it('does not read unavailable storage when explicit memory credentials win', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-credential-memory-')); roots.push(root);
  const file = path.join(root, 'credentials.enc'); await writeFile(file, 'invalid encrypted document', { mode: 0o600 });
  const service = new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'disposable-lifecycle-master') });
  await service.setApiKey('openai', 'explicit-memory', false);
  expect((await service.resolve('openai', { env: {} }))?.credential).toMatchObject({ apiKey: 'explicit-memory' });
  await expect(service.resolve('anthropic', { env: {} })).rejects.toThrow();
});

for (const persistent of [false, true]) for (const mutation of ['logout', 'replace'] as const) {
  it(`${persistent ? 'encrypted' : 'memory'} refresh cannot undo ${mutation}`, async () => {
    const { service, reopen } = await fixture(persistent), pending = await refreshing(service);
    if (mutation === 'logout') await service.delete('openai');
    else await service.setApiKey('openai', 'replacement-key', persistent);
    pending.finish();
    expect((await pending.result).error).toMatchObject({ code: 'credential-changed' });
    const reader = persistent ? reopen() : service; await reader.load();
    expect((await reader.resolve('openai', { env: {} }))?.credential).toEqual(mutation === 'logout' ? undefined
      : { version: 1, type: 'api-key', apiKey: 'replacement-key' });
    expect(service.redactor.redact('withdrawn-access withdrawn-refresh')).toBe('[REDACTED] [REDACTED]');
  });
}

it('only one concurrent memory refresh publishes against an unchanged credential', async () => {
  const { service } = await fixture(false), older = await refreshing(service), winner = await refreshing(service);
  winner.finish('winner'); expect((await winner.result).value?.credential).toMatchObject({ accessToken: 'winner-access' });
  older.finish(); expect((await older.result).error).toMatchObject({ code: 'credential-changed' });
  expect((await service.resolve('openai', { env: {}, now: 0 }))?.credential).toMatchObject({ accessToken: 'winner-access' });
  expect(service.redactor.redact('withdrawn-access withdrawn-refresh')).toBe('[REDACTED] [REDACTED]');
});

it.each(['logout', 'identical-relogin'] as const)('independent store writers defeat stale refresh after %s', async mutation => {
  const { service, reopen } = await fixture(), pending = await refreshing(service), writer = reopen();
  await writer.load(); await writer.delete('openai');
  if (mutation === 'identical-relogin') await writer.setOAuth('openai', original);
  pending.finish();
  expect((await pending.result).error).toMatchObject({ code: 'credential-changed' });
  const reader = reopen(); await reader.load();
  expect((await reader.resolve('openai', { env: {}, now: 0 }))?.credential).toEqual(mutation === 'logout' ? undefined
    : { version: 1, type: 'oauth', ...original });
});

const copilotOriginal = { ...original, subscription: { provider: 'github-copilot' as const, availableModelIds: ['old-model'] } };
const copilotAccess = 'tid=refreshed-copilot;proxy-ep=proxy.business.githubcopilot.com';
const copilotResolve = { env: {}, subscriptionProvider: 'github-copilot' as const };

for (const persistent of [false, true]) {
  it(`preserves Copilot issuer/catalogue in ${persistent ? 'encrypted' : 'memory'} storage without exposing them in descriptors`, async () => {
    const { service, reopen } = await fixture(persistent, copilotOriginal);
    const reader = persistent ? reopen() : service; await reader.load();
    const result = await reader.resolve('openai', { ...copilotResolve, now: 0 });
    expect(result?.credential).toEqual({ version: 1, type: 'oauth', ...copilotOriginal });
    expect(result?.descriptor).toEqual({ provider: 'openai', type: 'oauth', source: persistent ? 'encrypted-store' : 'memory', expiresAt: 100_000, refreshable: true });
    expect(reader.list()).toEqual([result!.descriptor]);
    expect(await reader.resolve('openai', { ...copilotResolve, now: 200_000, allowRefresh: false })).toBeUndefined();
    expect((await reader.resolve('openai', { ...copilotResolve, now: 0 }))?.credential).toEqual(result?.credential);
    expect(await reader.resolve('openai', { env: {}, now: 0 })).toBeUndefined();
    expect(await reader.resolve('openai', { env: {}, now: 200_000 })).toBeUndefined();
  });

  it(`refreshes ${persistent ? 'encrypted' : 'memory'} Copilot via its stored issuer, not its label or an unrelated OAuth URL`, async () => {
    const { service, reopen } = await fixture(persistent, copilotOriginal);
    const calls: { url: string; method?: string; authorization: string | null }[] = [];
    const result = await service.resolve('openai', { ...copilotResolve, now: 200_000,
      oauth: { tokenUrl: 'https://unrelated.example/token', clientId: 'not-copilot' },
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method, authorization: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(calls.length === 1 ? { token: copilotAccess, expires_at: 2000 }
          : { data: [{ id: 'new-model', model_picker_enabled: true }] }));
      }) as typeof fetch,
    });
    const expected = { version: 1, type: 'oauth', accessToken: copilotAccess, refreshToken: original.refreshToken,
      expiresAt: 1_700_000, subscription: { provider: 'github-copilot', availableModelIds: ['new-model'] } };
    expect(result?.credential).toEqual(expected);
    expect(calls).toEqual([
      { url: 'https://api.github.com/copilot_internal/v2/token', method: 'GET', authorization: `Bearer ${original.refreshToken}` },
      { url: 'https://api.business.githubcopilot.com/models', method: 'GET', authorization: `Bearer ${copilotAccess}` },
    ]);
    const reader = persistent ? reopen() : service; await reader.load();
    expect((await reader.resolve('openai', { ...copilotResolve, now: 200_000 }))?.credential).toEqual(expected);
    expect(service.redactor.redact(copilotAccess)).toBe('[REDACTED]');
  });

  for (const mutation of ['logout', 'replace'] as const) {
    it(`${persistent ? 'encrypted' : 'memory'} Copilot exchange cannot undo ${mutation}`, async () => {
      const { service, reopen } = await fixture(persistent, copilotOriginal);
      let ready!: () => void, release!: (response: Response) => void, calls = 0;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const catalogue = new Promise<Response>(resolve => { release = resolve; });
      const pending = service.resolve('openai', { ...copilotResolve, now: 200_000, fetcher: (async () => {
        if (++calls === 1) return new Response(JSON.stringify({ token: copilotAccess, expires_at: 2000 }));
        ready(); return catalogue;
      }) as typeof fetch }).then(value => ({ value, error: undefined }), error => { ready(); return { value: undefined, error }; });
      await started;
      if (mutation === 'logout') await service.delete('openai');
      else await service.setApiKey('openai', 'replacement-key', persistent);
      release(new Response(JSON.stringify({ data: [] })));
      expect((await pending).error).toMatchObject({ code: 'credential-changed' });
      const reader = persistent ? reopen() : service; await reader.load();
      expect((await reader.resolve('openai', { env: {} }))?.credential).toEqual(mutation === 'logout' ? undefined
        : { version: 1, type: 'api-key', apiKey: 'replacement-key' });
      expect(service.redactor.redact(copilotAccess)).toBe('[REDACTED]');
    });
  }
}

it.each(['logout', 'replace', 'identical-relogin', 'absent-logout', 'absent-aba', 'other-provider'] as const)(
  'a prepared initial OAuth publication cannot overwrite an independent %s', async mutation => {
    const { service, reopen } = await fixture(true, copilotOriginal);
    if (mutation.startsWith('absent')) await service.delete('openai');
    const publish = await service.prepareOAuthLogin('openai'), writer = reopen();
    await writer.load();
    if (mutation === 'replace') await writer.setApiKey('openai', 'newer-key');
    else if (mutation === 'identical-relogin') { await writer.delete('openai'); await writer.setOAuth('openai', copilotOriginal); }
    else if (mutation === 'other-provider') await writer.setApiKey('anthropic', 'unrelated-key');
    else {
      if (mutation === 'absent-aba') await writer.setOAuth('openai', copilotOriginal);
      await writer.delete('openai');
    }
    await expect(publish({ ...copilotOriginal, accessToken: copilotAccess })).rejects.toMatchObject({ code: 'credential-changed' });
    const reader = reopen(); await reader.load();
    const actual = (await reader.resolve('openai', { env: {}, now: 0, ...(mutation === 'replace' ? {} : { subscriptionProvider: 'github-copilot' as const }) }))?.credential;
    expect(actual).toEqual(mutation === 'replace' ? { version: 1, type: 'api-key', apiKey: 'newer-key' }
      : mutation === 'identical-relogin' || mutation === 'other-provider' ? { version: 1, type: 'oauth', ...copilotOriginal } : undefined);
    expect(service.redactor.redact(copilotAccess)).toBe('[REDACTED]');
  });

it('allows exactly one current initial OAuth publication and never exposes its subscription in descriptors', async () => {
  const { service, reopen } = await fixture(true, copilotOriginal);
  const retired = await service.prepareOAuthLogin('openai'), current = await service.prepareOAuthLogin('openai');
  await expect(retired(copilotOriginal)).rejects.toMatchObject({ code: 'credential-changed' });
  const result = await current({ ...copilotOriginal, accessToken: copilotAccess });
  expect(result).toEqual({ provider: 'openai', type: 'oauth', source: 'encrypted-store', expiresAt: 100000, refreshable: true });
  await expect(current(copilotOriginal)).rejects.toMatchObject({ code: 'credential-changed' });
  const reader = reopen(); await reader.load();
  expect((await reader.resolve('openai', { ...copilotResolve, now: 0 }))?.credential).toMatchObject({ accessToken: copilotAccess });
  await expect(new ProviderCredentialService().prepareOAuthLogin('openai')).rejects.toMatchObject({ code: 'storage-unavailable' });
});

it.each(['before', 'after-write', 'after-newer-write'] as const)('cancels prepared OAuth publication %s without restoring over a newer writer', async moment => {
  const { service, reopen, store } = await fixture(true, copilotOriginal), controller = new AbortController();
  const publish = await service.prepareOAuthLogin('openai', controller.signal);
  const compareAndSet = store.compareAndSet.bind(store);
  const spy = vi.spyOn(store, 'compareAndSet').mockImplementationOnce(async (...args) => {
    const result = await compareAndSet(...args);
    if (moment === 'after-newer-write') await reopen().setApiKey('openai', 'newer-key');
    controller.abort();
    return result;
  });
  if (moment === 'before') controller.abort();
  await expect(publish({ ...copilotOriginal, accessToken: copilotAccess })).rejects.toMatchObject({ name: 'AbortError' });
  if (moment === 'before') expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
  const reader = reopen(); await reader.load();
  expect((await reader.resolve('openai', { env: {}, now: 0, ...(moment === 'after-newer-write' ? {} : { subscriptionProvider: 'github-copilot' as const }) }))?.credential)
    .toEqual(moment === 'after-newer-write' ? { version: 1, type: 'api-key', apiKey: 'newer-key' } : { version: 1, type: 'oauth', ...copilotOriginal });
});

it('keeps the previous Copilot credential and redacts the exchanged token when catalogue retrieval fails', async () => {
  const { service, reopen } = await fixture(true, copilotOriginal);
  let calls = 0;
  await expect(service.resolve('openai', { ...copilotResolve, now: 200_000, fetcher: (async () => {
    return ++calls === 1 ? new Response(JSON.stringify({ token: copilotAccess, expires_at: 2000 }))
      : new Response(copilotAccess, { status: 403 });
  }) as typeof fetch })).rejects.toMatchObject({ code: 'refresh-failed' });
  const reader = reopen(); await reader.load();
  expect((await reader.resolve('openai', { ...copilotResolve, now: 0 }))?.credential).toEqual({ version: 1, type: 'oauth', ...copilotOriginal });
  expect(service.redactor.redact(copilotAccess)).toBe('[REDACTED]');
});

it('does not resolve ordinary OAuth, API keys, environment or command credentials as Copilot subscriptions', async () => {
  const { service } = await fixture(false);
  expect(await service.resolve('openai', { ...copilotResolve, now: 0 })).toBeUndefined();
  await service.setApiKey('openai', 'ordinary-key', false);
  expect(await service.resolve('openai', copilotResolve)).toBeUndefined();
  await service.setOAuth('openai', copilotOriginal, false);
  expect(await service.resolve('openai', { ...copilotResolve, now: 0, env: { OPENAI_API_KEY: 'override-key' } })).toBeUndefined();
  expect(await service.resolve('openai', { ...copilotResolve, now: 0, env: { AI_HARNESS_OPENAI_API_KEY_COMMAND: 'exit 91' } })).toBeUndefined();
});

it.each([null, { provider: 'other', availableModelIds: [] }, { provider: 'github-copilot', availableModelIds: [null] },
  { provider: 'github-copilot', availableModelIds: [], enterpriseDomain: 'https://evil.example/path' },
])('rejects malformed stored subscription metadata (%j)', async subscription => {
  const service = new ProviderCredentialService();
  const value = { ...original, subscription } as Parameters<ProviderCredentialService['setOAuth']>[1];
  await expect(service.setOAuth('label', value, false)).rejects.toMatchObject({ code: 'invalid-credential' });
  expect(service.list()).toEqual([]);
});

it('refreshes encrypted reads instead of reusing a valid externally revoked snapshot', async () => {
  const { service, reopen } = await fixture();
  expect((await service.resolve('openai', { env: {}, now: 0 }))?.credential).toMatchObject(original);
  const writer = reopen(); await writer.load(); await writer.delete('openai');
  expect(await service.resolve('openai', { env: {}, now: 0 })).toBeUndefined();
});
