import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, Session } from '../types/index.js';
import { deserializeSession, redactProviderConfig, serializeSession } from './serialization.js';
import { SessionManager } from './session-manager.js';

function session(providerConfig: ProviderConfig): Session {
  return { id: 'redaction', messages: [], createdAt: new Date(0), updatedAt: new Date(0), providerConfig };
}

const secretNames = ['openaiApiKey', 'clientSecret', 'private_key', 'refreshToken', 'auth_token',
  'Cookie', 'credentials', 'token', 'SECRET_ACCESS_KEY'];

describe('shared provider configuration redaction', () => {
  it.each(secretNames)('removes %s recursively at the public JSON boundary', key => {
    const config: ProviderConfig = { type: 'custom', model: 'model', [key]: 'private-value',
      options: { [key]: 'nested-private-value', region: 'eu', list: [{ [key]: 'array-private-value', label: 'safe' }] } };
    const original = structuredClone(config);
    const expected = { type: 'custom', model: 'model', options: { region: 'eu', list: [{ label: 'safe' }] } };
    expect(redactProviderConfig(config)).toEqual(expected);
    const wire = serializeSession(session(config));
    expect(wire.providerConfig).toEqual(expected);
    expect(deserializeSession({ ...wire, providerConfig: config }).providerConfig).toEqual(expected);
    expect(JSON.stringify(wire)).not.toContain('private-value');
    expect(config).toEqual(original);
  });

  it('preserves non-secret network/catalogue fields and detaches every nested container', () => {
    const options = { region: 'eu', capabilities: ['text'], records: [{ label: 'safe' }] };
    const config: ProviderConfig = { type: 'custom', model: 'model', baseUrl: 'https://provider.invalid',
      transport: 'sse', requestTimeoutMs: 1000, headers: { Authorization: 'hidden', 'X-Region': 'eu' },
      options, alias: options };
    const safe = redactProviderConfig(config)!;
    expect(safe).toEqual({ ...config, headers: { 'X-Region': 'eu' } });
    expect(safe).not.toBe(config);
    expect(safe.options).not.toBe(options);
    expect(safe.alias).not.toBe(safe.options);
    (safe.options as typeof options).records[0]!.label = 'changed';
    expect(options.records[0]!.label).toBe('safe');
  });

  it('does not evaluate getters or retain executable toJSON methods', () => {
    const getter = vi.fn(() => 'getter-secret');
    const toJSON = vi.fn(() => ({ apiKey: 'callback-secret' }));
    const config: ProviderConfig = { type: 'custom', nested: { toJSON, label: 'safe' } };
    Object.defineProperty(config, 'opaque', { enumerable: true, get: getter });
    const safe = redactProviderConfig(config);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(safe).toEqual({ type: 'custom', nested: { label: 'safe' } });
    expect(JSON.stringify(safe)).toBe('{"type":"custom","nested":{"label":"safe"}}');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('omits cycles and non-JSON values without dropping valid siblings', () => {
    const config: ProviderConfig = { type: 'custom', model: 'model', missing: undefined,
      bigint: 1n, callback: () => 'hidden', symbol: Symbol('hidden'), invalidNumber: Infinity };
    config.cycle = config;
    expect(redactProviderConfig(config)).toEqual({ type: 'custom', model: 'model' });
  });

  it('omits oversized collections, keys and excessive depth while preserving bounded siblings', () => {
    let deep: Record<string, unknown> = { label: 'too deep' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const config: ProviderConfig = { type: 'custom', array: Array.from({ length: 1025 }, () => 'item'),
      object: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`field-${i}`, 'value'])),
      ['é'.repeat(129)]: 'too long', deep, model: 'safe' };
    const safe = redactProviderConfig(config)!;
    expect(safe.array).toBeUndefined();
    expect(safe.object).toBeUndefined();
    expect(safe['é'.repeat(129)]).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('too deep');
    expect(safe.model).toBe('safe');
  });

  it('fails closed for arrays and opaque revoked proxies', () => {
    expect(redactProviderConfig([] as unknown as ProviderConfig)).toBeUndefined();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => redactProviderConfig(proxy as ProviderConfig)).not.toThrow();
    expect(redactProviderConfig(proxy as ProviderConfig)).toBeUndefined();
  });

  it('omits opaque nested proxies and accessor arrays without invoking element getters', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const getter = vi.fn(() => 'hidden');
    const array: unknown[] = [];
    Object.defineProperty(array, '0', { enumerable: true, get: getter });
    const safe = redactProviderConfig({ type: 'custom', proxy, array, model: 'safe' });
    expect(safe).toEqual({ type: 'custom', model: 'safe' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds the total visited nodes across individually bounded collections', () => {
    const config: ProviderConfig = { type: 'custom', chunks: Array.from({ length: 20 },
      () => Array.from({ length: 1000 }, () => ({ label: 'safe', apiKey: 'hidden' }))) };
    const safe = redactProviderConfig(config)!;
    expect(JSON.stringify(safe)).not.toContain('hidden');
    expect((safe.chunks as unknown[][]).flat().length).toBeLessThan(10_000);
  });

  it('preserves prototype-named data fields without changing the output prototype', () => {
    const config = JSON.parse('{"type":"custom","__proto__":{"apiKey":"hidden","region":"eu"},"constructor":{"password":"hidden","label":"safe"}}') as ProviderConfig;
    const safe = redactProviderConfig(config)!;
    expect(Object.getPrototypeOf(safe)).toBe(Object.prototype);
    expect(Object.hasOwn(safe, '__proto__')).toBe(true);
    expect(safe.__proto__).toEqual({ region: 'eu' });
    expect(safe.constructor).toEqual({ label: 'safe' });
  });

  it('uses the same policy for manager state and wire hydration', async () => {
    const config: ProviderConfig = { type: 'custom', refreshToken: 'hidden',
      headers: { Cookie: 'hidden', 'X-Region': 'eu' } };
    const manager = new SessionManager();
    const stored = await manager.create({ providerConfig: config });
    expect(serializeSession(session(config)).providerConfig).toEqual(stored.providerConfig);
    expect(deserializeSession({ ...serializeSession(session(config)), providerConfig: config }).providerConfig)
      .toEqual(stored.providerConfig);
  });
});
