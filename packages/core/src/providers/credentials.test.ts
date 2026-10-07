import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EncryptedCredentialStore } from '../security/credential-store.js';
import {
  CredentialRedactor,
  ProviderCredentialError,
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
