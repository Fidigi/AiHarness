import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EncryptedCredentialStore } from '../security/credential-store.js';
import { getKimiCodingOAuthConfig } from './kimi-coding-oauth.js';
import type {
  ProviderCredentialError} from './credentials.js';
import {
  CredentialRedactor,
  ProviderCredentialService,
  redactCredentialText,
} from './credentials.js';

const temporaryDirectories: string[] = [];

async function service(): Promise<{ service: ProviderCredentialService; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aih-provider-credentials-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'credentials.enc');
  const store = new EncryptedCredentialStore(filePath, 'correct horse battery staple');
  const result = new ProviderCredentialService({ store });
  await result.load();
  return { service: result, filePath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('ProviderCredentialService', () => {
  it('persists explicit Vertex Cloud-key provenance without migrating legacy secrets or lending mode to higher-priority sources', async () => {
    const { service: credentials, filePath } = await service();
    await credentials.setApiKey('vertex', 'same-opaque-secret', true, 'api-key');
    const reloaded = new ProviderCredentialService({ store: new EncryptedCredentialStore(filePath, 'correct horse battery staple') }); await reloaded.load();
    expect(reloaded.readStoredCredential('vertex')).toEqual({ version: 1, type: 'api-key', apiKey: 'same-opaque-secret', vertexAuthMode: 'api-key' });
    expect((await reloaded.resolve('vertex', { env: { GOOGLE_VERTEX_ACCESS_TOKEN: 'override-token' } }))?.credential).toEqual({ version: 1, type: 'api-key', apiKey: 'override-token' });
    const before = await readFile(filePath); await expect(credentials.setApiKey('openai', 'must-not-save', true, 'api-key')).rejects.toThrow(); await expect(credentials.setApiKey('vertex', 'must-not-save', true, 'invalid' as never)).rejects.toThrow(); expect(await readFile(filePath)).toEqual(before);
    await credentials.setApiKey('vertex', 'same-opaque-secret'); await reloaded.load(); expect(reloaded.readStoredCredential('vertex')).toEqual({ version: 1, type: 'api-key', apiKey: 'same-opaque-secret' }); expect(JSON.stringify(reloaded.list())).not.toContain('same-opaque-secret'); expect((await readFile(filePath)).includes(Buffer.from('same-opaque-secret'))).toBe(false);
  });
  it('copies expired stored administration snapshots without environment, commands, refresh or availability authority', async () => {
    const { service: credentials, filePath } = await service();
    await credentials.setOAuth('radius-admin', { accessToken: 'private-expired-radius', refreshToken: 'private-radius-refresh', expiresAt: 1,
      subscription: { provider: 'radius', gateway: 'https://synthetic-radius.test', grantId: '293da824-4f8b-4d80-84b9-e542c22215eb' } });
    const before = await readFile(filePath), fetch = vi.spyOn(globalThis, 'fetch');
    const snapshot = credentials.readStoredCredential('radius-admin'); expect(snapshot).toMatchObject({ type: 'oauth', expiresAt: 1 });
    if (snapshot?.type !== 'oauth') throw new Error('Expected synthetic snapshot'); snapshot.accessToken = 'caller-mutated';
    expect(credentials.readStoredCredential('radius-admin')).toMatchObject({ accessToken: 'private-expired-radius' });
    expect(await credentials.resolve('radius-admin', { env: {}, subscriptionProvider: 'radius', allowRefresh: false })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled(); expect(await readFile(filePath)).toEqual(before);
    expect(JSON.stringify(credentials.list())).not.toContain('private-expired-radius');
  });
  it('reports whether successful writes can be made durable', async () => {
    expect(new ProviderCredentialService().hasPersistentStore()).toBe(false);
    const { service: credentials } = await service();
    expect(credentials.hasPersistentStore()).toBe(true);
  });

  it('resolves environment before encrypted storage while exposing descriptors only', async () => {
    const { service: credentials } = await service();
    await credentials.setApiKey('openai', 'stored-secret');

    const resolved = await credentials.resolve('openai', { env: { OPENAI_API_KEY: 'environment-secret' } });
    expect(resolved).toMatchObject({
      descriptor: { provider: 'openai', source: 'environment', type: 'api-key', refreshable: false },
      credential: { apiKey: 'environment-secret' },
    });
    expect(credentials.list()).toEqual([{
      provider: 'openai', source: 'encrypted-store', type: 'api-key', refreshable: false,
    }]);
    expect(JSON.stringify(credentials.list())).not.toContain('stored-secret');

    const custom = await credentials.resolve('extension-provider', {
      env: { AI_HARNESS_EXTENSION_PROVIDER_API_KEY: 'extension-secret' },
    });
    expect(custom).toMatchObject({
      descriptor: { provider: 'extension-provider', source: 'environment' },
      credential: { apiKey: 'extension-secret' },
    });
  });

  it('runs a bounded, filtered command once and never includes its output in failures', async () => {
    const credentials = new ProviderCredentialService();
    const command = `"${process.execPath}" -e "process.stdout.write('cmd-secret')"`;
    const env = { AI_HARNESS_OPENAI_API_KEY_COMMAND: command };

    const first = await credentials.resolve('openai', { env, commandTimeoutMs: 2_000 });
    const second = await credentials.resolve('openai', {
      env: { AI_HARNESS_OPENAI_API_KEY_COMMAND: 'exit 7' },
      commandTimeoutMs: 2_000,
    });
    expect(first?.credential).toMatchObject({ apiKey: 'cmd-secret' });
    expect(second?.credential).toMatchObject({ apiKey: 'cmd-secret' });

    await expect(new ProviderCredentialService().resolve('openai', {
      env: { AI_HARNESS_OPENAI_API_KEY_COMMAND: `"${process.execPath}" -e "process.stderr.write('leaked');process.exit(2)"` },
      commandTimeoutMs: 2_000,
    })).rejects.toMatchObject({ code: 'command-failed', message: 'The provider credential command failed.' });
  });

  it('refreshes an expired OAuth token and persists the replacement without leaking it', async () => {
    const { service: credentials } = await service();
    await credentials.setOAuth('openai', {
      accessToken: 'expired-access', refreshToken: 'refresh-secret', expiresAt: 1,
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain('refresh_token=refresh-secret');
      return new Response(JSON.stringify({
        access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const resolved = await credentials.resolve('openai', {
      env: {}, now: 100_000, fetcher,
      oauth: { tokenUrl: 'https://oauth.example.test/token', clientId: 'client' },
    });
    expect(resolved?.credential).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
    expect(resolved?.descriptor).toMatchObject({ source: 'encrypted-store', refreshable: true });
    expect(JSON.stringify(resolved?.descriptor)).not.toContain('fresh-access');

    const again = await credentials.resolve('openai', { env: {}, now: 101_000 });
    expect(again?.credential).toMatchObject({ accessToken: 'fresh-access' });
  });

  it('exposes explicit Kimi issuer endpoints and refuses unsafe host configuration', () => {
    expect(getKimiCodingOAuthConfig()).toEqual({ deviceAuthorizationUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
      tokenUrl: 'https://auth.kimi.com/api/oauth/token', clientId: '17e5f671-d194-4dfb-9706-5516cb48c098', responseProfile: 'kimi-coding' });
    expect(Object.isFrozen(getKimiCodingOAuthConfig())).toBe(true);
    expect(getKimiCodingOAuthConfig('https://operator.example/prefix/').tokenUrl).toBe('https://operator.example/prefix/api/oauth/token');
    expect(getKimiCodingOAuthConfig('https://operator.example/%3F%23/').tokenUrl).toBe('https://operator.example/%3F%23/api/oauth/token');
    for (const host of ['http://operator.example', 'https://secret@operator.example', 'https://operator.example?secret=value',
      'https://operator.example?', 'https://operator.example#', 'https://operator.example#secret', 'https://operator.example\n', 'x'.repeat(4097)]) {
      expect(() => getKimiCodingOAuthConfig(host)).toThrow('Kimi Coding OAuth host is invalid.');
    }
  });

  it('refreshes an explicitly selected Kimi issuer under an operator-owned label', async () => {
    const { service: credentials, filePath } = await service();
    await credentials.setOAuth('team-code', { accessToken: 'old-kimi-access', refreshToken: 'old-kimi-refresh', expiresAt: 1 });
    const config = getKimiCodingOAuthConfig();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://auth.kimi.com/api/oauth/token');
      expect(init?.redirect).toBe('manual');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        client_id: '17e5f671-d194-4dfb-9706-5516cb48c098', grant_type: 'refresh_token', refresh_token: 'old-kimi-refresh',
      });
      return new Response(JSON.stringify({ access_token: 'new-kimi-access', refresh_token: 'new-kimi-refresh', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await credentials.resolve('team-code', { env: {}, now: 100_000, oauth: config, fetcher });
    expect(result).toMatchObject({ descriptor: { provider: 'team-code', source: 'encrypted-store', type: 'oauth' },
      credential: { accessToken: 'new-kimi-access', refreshToken: 'new-kimi-refresh', expiresAt: 3_700_000 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await credentials.resolve('team-code', { env: {}, now: 101_000 }))?.credential).toMatchObject({ accessToken: 'new-kimi-access' });
    const bytes = await readFile(filePath, 'utf8');
    for (const value of ['old-kimi-access', 'old-kimi-refresh', 'new-kimi-access', 'new-kimi-refresh']) expect(bytes).not.toContain(value);
    expect(credentials.list().map(item => item.provider)).toEqual(['team-code']);
  });

  it('refuses incomplete Kimi refresh responses without changing encrypted credentials', async () => {
    const { service: credentials, filePath } = await service();
    await credentials.setOAuth('team-code', { accessToken: 'old-kimi-access', refreshToken: 'old-kimi-refresh', expiresAt: 1 });
    const before = await readFile(filePath);
    for (const body of [
      { refresh_token: 'missing-access-refresh', expires_in: 3600 },
      { access_token: 'rejected-kimi-access', expires_in: 3600 },
      { access_token: 'rejected-kimi-access', refresh_token: 'rejected-kimi-refresh' },
      { access_token: 'rejected-kimi-access', refresh_token: 'rejected-kimi-refresh', expires_in: 0 },
      { access_token: 'rejected-kimi-access', refresh_token: 'rejected-kimi-refresh', expires_in: -1 },
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      await expect(credentials.resolve('team-code', { env: {}, now: 100_000, oauth: getKimiCodingOAuthConfig(), fetcher }))
        .rejects.toMatchObject({ code: 'refresh-failed', message: 'The provider credential could not be refreshed.' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await readFile(filePath)).toEqual(before);
      for (const value of [body.access_token, body.refresh_token]) {
        if (typeof value === 'string') expect(credentials.redactor.redact(value)).toBe('[REDACTED]');
      }
    }
  });

  it('redacts returned Kimi tokens on an HTTP refusal without changing encrypted credentials', async () => {
    const { service: credentials, filePath } = await service();
    await credentials.setOAuth('team-code', { accessToken: 'old-kimi-access', refreshToken: 'old-kimi-refresh', expiresAt: 1 });
    const before = await readFile(filePath);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'refused-kimi-access', refresh_token: 'refused-kimi-refresh', expires_in: 3600,
    }), { status: 400 })) as unknown as typeof fetch;
    await expect(credentials.resolve('team-code', { env: {}, now: 100_000, oauth: getKimiCodingOAuthConfig(), fetcher }))
      .rejects.toMatchObject({ code: 'refresh-failed', message: 'The provider credential could not be refreshed.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(filePath)).toEqual(before);
    for (const value of ['refused-kimi-access', 'refused-kimi-refresh']) expect(credentials.redactor.redact(value)).toBe('[REDACTED]');
  });

  it('refuses Kimi refresh publication when bounded token registration is exhausted', async () => {
    const { service: credentials, filePath } = await service();
    await credentials.setOAuth('team-code', { accessToken: 'budget-old-access', refreshToken: 'budget-old-refresh', expiresAt: 1 });
    const before = await readFile(filePath);
    // The two stored OAuth values already occupy two of the existing 2,048 slots.
    for (let index = 0; index < 2_046; index++) credentials.redactor.add(`active-credential-${index}`);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'budget-refused-access', refresh_token: 'budget-refused-refresh', expires_in: 3600,
    }), { status: 400 })) as unknown as typeof fetch;
    await expect(credentials.resolve('team-code', { env: {}, now: 100_000, oauth: getKimiCodingOAuthConfig(), fetcher }))
      .rejects.toMatchObject({ code: 'invalid-credential', message: 'Too many provider credentials are active.' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(filePath)).toEqual(before);
  });

  it('refuses invalid explicit Kimi refresh configuration before dispatch', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('team-code', { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }, false);
    for (const overrides of [{ responseProfile: 'unknown' }, { responseProfile: null }, { clientId: 'foreign-client' },
      { clientSecret: 'must-not-dispatch' }, { tokenUrl: 'https://auth.kimi.com/token' },
      { tokenUrl: 'https://auth.kimi.com/api/oauth/token?secret=must-not-dispatch' },
      { tokenUrl: 'https://auth.kimi.com/api/oauth/token?' }, { tokenUrl: 'https://auth.kimi.com/api/oauth/token#' }]) {
      const config = { ...getKimiCodingOAuthConfig(), ...overrides } as unknown as ReturnType<typeof getKimiCodingOAuthConfig>;
      const fetcher = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
      await expect(credentials.resolve('team-code', { env: {}, now: 100_000, oauth: config, fetcher }))
        .rejects.toMatchObject({ code: 'refresh-unavailable', message: 'OAuth refresh is not configured safely.' });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('refuses an accessor-backed issuer selection without invoking it or dispatching', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('team-code', { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }, false);
    const getter = vi.fn(() => 'kimi-coding');
    const config = { ...getKimiCodingOAuthConfig() };
    Object.defineProperty(config, 'responseProfile', { get: getter });
    const fetcher = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    await expect(credentials.resolve('team-code', { env: {}, now: 100_000, oauth: config, fetcher }))
      .rejects.toMatchObject({ code: 'refresh-unavailable', message: 'OAuth refresh is not configured safely.' });
    expect(getter).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains generic refresh fallback without inferring a Kimi issuer from the label', async () => {
    const credentials = new ProviderCredentialService();
    await credentials.setOAuth('kimi-coding', { accessToken: 'old-access', refreshToken: 'retained-refresh', expiresAt: 1 }, false);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'generic-access' }), { status: 200 })) as unknown as typeof fetch;
    const result = await credentials.resolve('kimi-coding', { env: {}, now: 100_000,
      oauth: { tokenUrl: 'https://operator.example/token', clientId: 'operator-client' }, fetcher });
    expect(result?.credential).toEqual({ version: 1, type: 'oauth', accessToken: 'generic-access', refreshToken: 'retained-refresh' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds OAuth refresh even when a custom fetcher or response body ignores its signal', async () => {
    const stalledFetch = new ProviderCredentialService();
    await stalledFetch.setOAuth('openai', {
      accessToken: 'expired-access', refreshToken: 'refresh-secret', expiresAt: 1,
    }, false);
    await expect(stalledFetch.resolve('openai', {
      env: {}, now: 100_000, refreshTimeoutMs: 10,
      oauth: { tokenUrl: 'https://oauth.example.test/token', clientId: 'client' },
      fetcher: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'refresh-failed', message: 'The provider credential could not be refreshed.',
    });

    const stalledBody = new ProviderCredentialService();
    await stalledBody.setOAuth('openai', {
      accessToken: 'expired-access', refreshToken: 'refresh-secret', expiresAt: 1,
    }, false);
    await expect(stalledBody.resolve('openai', {
      env: {}, now: 100_000, refreshTimeoutMs: 10,
      oauth: { tokenUrl: 'https://oauth.example.test/token', clientId: 'client' },
      fetcher: (async () => new Response(new ReadableStream({ pull: () => undefined }))) as unknown as typeof fetch,
    })).rejects.toMatchObject({
      code: 'refresh-failed', message: 'The provider credential could not be refreshed.',
    });
  });

  it('redacts credential-like environment and nested JSON values without exposing its inventory', () => {
    const redactor = new CredentialRedactor(['runtime-secret']);
    redactor.addEnvironment({
      OPENAI_API_KEY: 'environment-secret',
      HTTPS_PROXY: 'http://proxy-user:proxy-password@proxy.example/',
      DATABASE_URL: 'postgres://database-user:database-password@database.example/app?token=query-secret',
      SAFE_SETTING: 'public-value',
    });
    const value = redactor.redactJson({
      message: 'runtime-secret environment-secret proxy-password database-password query-secret public-value',
      nested: [`${Buffer.from('runtime-secret').toString('base64')}`],
    });
    expect(value).toEqual({
      message: '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] public-value',
      nested: ['[REDACTED]'],
    });
    expect(JSON.stringify(redactor)).not.toContain('runtime-secret');
  });

  it('redacts credentials split across streaming chunks and bounds hostile JSON shapes', () => {
    const secret = 'split+credential';
    const redactor = new CredentialRedactor([secret]);
    const variants = [
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex'),
      JSON.stringify(secret).slice(1, -1),
    ];
    for (const variant of variants) {
      const stream = redactor.createStream();
      const split = Math.max(1, Math.floor(variant.length / 2));
      const output = stream.push(`before:${variant.slice(0, split)}`)
        + stream.push(`${variant.slice(split)}:after`)
        + stream.flush();
      expect(output).toBe('before:[REDACTED]:after');
      expect(output).not.toContain(variant);
      expect(stream.redacted).toBe(true);
    }

    const circular: Record<string, unknown> = { value: secret };
    circular.self = circular;
    Object.defineProperty(circular, 'hostile', { enumerable: true, get: () => { throw new Error(secret); } });
    let deep: Record<string, unknown> = circular;
    for (let index = 0; index < 40; index++) deep = { nested: deep };
    const result = redactor.redactJson(deep);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('safe redaction limit');
  });

  it('does not invoke accessors or allow special keys to mutate clone prototypes', () => {
    const secret = 'hostile-accessor-secret';
    const redactor = new CredentialRedactor([secret]);
    let getterCalls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'hostile', {
      enumerable: true,
      get: () => { getterCalls++; return secret; },
    });
    Object.defineProperty(input, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: secret,
    });

    const result = redactor.redactJson(input);
    expect(getterCalls).toBe(0);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(result.__proto__).toBe('[REDACTED]');
    expect(result.hostile).toContain('safe redaction limit');

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => redactor.redactJson(revoked.proxy)).not.toThrow();
  });

  it('preserves safe operational values and blocks secret-bearing opaque serialization', () => {
    const secret = 'opaque-secret';
    const redactor = new CredentialRedactor([secret]);
    const signal = new AbortController().signal;
    const safeUrl = new URL('https://example.test/path');
    const safeBytes = new Uint8Array([1, 2, 3]);
    const safe = redactor.redactJson({ signal, safeUrl, safeBytes });

    expect(safe.signal).toBe(signal);
    expect(safe.safeUrl).toBe(safeUrl);
    expect(safe.safeBytes).toBe(safeBytes);

    const unsafe = redactor.redactJson({
      url: new URL(`https://example.test/?token=${secret}`),
      bytes: Buffer.from(secret),
    });
    expect(JSON.stringify(unsafe)).not.toContain(secret);
    expect(unsafe.bytes).toBe('[REDACTED]');
  });

  it('keeps maximum-cardinality matching bounded and covers overlapping occurrences', () => {
    const values = Array.from({ length: 2_048 }, (_, index) =>
      `credential-${String(index).padStart(4, '0')}-abcdefghijklmnopqrstuvwxyz`,
    );
    const redactor = new CredentialRedactor(values);
    const target = values.at(-1)!;
    const input = `${'public '.repeat(120_000)}${target}`;
    const startedAt = performance.now();
    const output = redactor.redact(input);
    const elapsed = performance.now() - startedAt;

    expect(output).not.toContain(target);
    expect(output.endsWith('[REDACTED]')).toBe(true);
    expect(elapsed).toBeLessThan(5_000);

    const streamStartedAt = performance.now();
    const stream = redactor.createStream();
    const split = Math.floor(target.length / 2);
    const streamed = stream.push(`ordinary output ${target.slice(0, split)}`)
      + stream.push(`${target.slice(split)} done`)
      + stream.flush();
    expect(streamed).toBe('ordinary output [REDACTED] done');
    expect(performance.now() - streamStartedAt).toBeLessThan(5_000);

    const overlap = new CredentialRedactor(['aaa']).redact('aaaa');
    expect(overlap).toBe('[REDACTED]');
  });

  it('uses stable value-free errors and redacts short and encoded secret variants', async () => {
    const expired = new ProviderCredentialService();
    await expired.setOAuth('openai', { accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 }, false);
    await expect(expired.resolve('openai', { env: {}, now: 100_000 }))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderCredentialError>>({
        code: 'refresh-unavailable',
        message: 'The provider credential has expired and cannot be refreshed.',
      }));

    const secret = 'a+b';
    expect(redactCredentialText([
      `raw=${secret}`,
      `uri=${encodeURIComponent(secret)}`,
      `b64=${Buffer.from(secret).toString('base64')}`,
      `b64url=${Buffer.from(secret).toString('base64url')}`,
      `hex=${Buffer.from(secret).toString('hex')}`,
    ].join(' '), [secret])).toBe([
      'raw=[REDACTED]', 'uri=[REDACTED]', 'b64=[REDACTED]',
      'b64url=[REDACTED]', 'hex=[REDACTED]',
    ].join(' '));
  });
});
