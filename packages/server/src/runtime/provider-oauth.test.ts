import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProxyServer } from '../api/proxy.js';
import type { EncryptedCredentialStore } from '../security/credential-store.js';
import { ProviderOAuthService } from './provider-oauth.js';

function configure() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_DEVICE_URL', 'http://oauth.test/device');
  vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_TOKEN_URL', 'http://oauth.test/token');
  vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_CLIENT_ID', 'client-id');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ProviderOAuthService', () => {
  it('returns only public device metadata and supports explicit cancellation', async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://oauth.example/activate',
      expires_in: 600, interval: 5,
    }), { status: 200 }));
    const service = new ProviderOAuthService(new AiProxyServer(), () => undefined, fetcher as typeof fetch);
    const flow = await service.start('openai');
    expect(flow).toMatchObject({ provider: 'openai', state: 'pending', userCode: 'ABCD-EFGH' });
    expect(JSON.stringify(flow)).not.toContain('private-device-code');
    expect(service.cancel(flow.id)).toBe(true);
    expect(service.get(flow.id)?.state).toBe('cancelled');
  });

  it('polls a configured device grant and stores the token without returning it', async () => {
    configure();
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'private-device-code', user_code: 'CODE', verification_uri: 'https://oauth.example/activate',
        expires_in: 600, interval: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'private-access-token' }), { status: 200 }));
    const proxy = new AiProxyServer();
    const setApiKey = vi.spyOn(proxy, 'setApiKey');
    const set = vi.fn().mockResolvedValue(undefined);
    const credentials = { set } as unknown as EncryptedCredentialStore;
    const service = new ProviderOAuthService(proxy, () => credentials, fetcher as typeof fetch);
    const flow = await service.start('openai');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.get(flow.id)).toMatchObject({ state: 'connected' });
    expect(JSON.stringify(service.get(flow.id))).not.toContain('private-access-token');
    expect(setApiKey).toHaveBeenCalledWith('openai', 'private-access-token');
    expect(set).toHaveBeenCalledWith('openai', 'private-access-token');
  });
});
