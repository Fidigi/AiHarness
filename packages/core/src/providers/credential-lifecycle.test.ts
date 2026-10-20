import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EncryptedCredentialStore } from '../security/credential-store.js';
import { ProviderCredentialService } from './credentials.js';

const roots: string[] = [];
const original = { accessToken: 'original-access', refreshToken: 'original-refresh', expiresAt: 100_000 };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(persistent = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-credential-lifetime-')); roots.push(root);
  const file = path.join(root, 'credentials.enc');
  const reopen = () => new ProviderCredentialService({ store: new EncryptedCredentialStore(file, 'disposable-lifecycle-master') });
  const service = persistent ? reopen() : new ProviderCredentialService();
  await service.load(); await service.setOAuth('openai', original, persistent);
  return { service, reopen };
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

it('refreshes encrypted reads instead of reusing a valid externally revoked snapshot', async () => {
  const { service, reopen } = await fixture();
  expect((await service.resolve('openai', { env: {}, now: 0 }))?.credential).toMatchObject(original);
  const writer = reopen(); await writer.load(); await writer.delete('openai');
  expect(await service.resolve('openai', { env: {}, now: 0 })).toBeUndefined();
});
