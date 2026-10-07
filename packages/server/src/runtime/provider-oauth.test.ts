import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCredentialService } from '@ai-harness/core';
import { AiProxyServer } from '../api/proxy.js';
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

  it('normalizes malformed remote responses without reflecting secret response text', async () => {
    configure();
    const secret = 'remote-short-secret';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(`not-json:${secret}`, { status: 200 }));
    const service = new ProviderOAuthService(new AiProxyServer(), () => undefined, fetcher as typeof fetch);
    let failure: unknown;
    try { await service.start('openai'); } catch (error) { failure = error; }
    expect(String(failure)).toContain('OAuth response is invalid');
    expect(String(failure)).not.toContain(secret);
  });

  it('rejects unsafe endpoints and oversized responses without reflecting remote input', async () => {
    configure();
    vi.stubEnv('AI_HARNESS_OAUTH_OPENAI_DEVICE_URL', 'https://oauth.example/device#remote-secret');
    const service = new ProviderOAuthService(new AiProxyServer(), () => undefined, vi.fn() as never);
    await expect(service.start('openai')).rejects.toThrow('without embedded credentials or fragments');

    configure();
    const oversized = new Response('x'.repeat(256 * 1024 + 1), { status: 200 });
    const bounded = new ProviderOAuthService(
      new AiProxyServer(),
      () => undefined,
      vi.fn().mockResolvedValueOnce(oversized) as typeof fetch,
    );
    await expect(bounded.start('openai')).rejects.toThrow('OAuth response is invalid.');
  });

  it('does not reflect OAuth denial descriptions or remote status details', async () => {
    configure();
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'private-device-code', user_code: 'CODE', verification_uri: 'https://oauth.example/activate',
        expires_in: 600, interval: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'access_denied', error_description: 'remote-secret-description',
      }), { status: 418 }));
    const service = new ProviderOAuthService(new AiProxyServer(), () => undefined, fetcher as typeof fetch);
    const flow = await service.start('openai');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.get(flow.id)).toMatchObject({ state: 'failed', error: 'OAuth token exchange failed.' });
    expect(JSON.stringify(service.get(flow.id))).not.toContain('remote-secret-description');
    expect(JSON.stringify(service.get(flow.id))).not.toContain('418');
  });

  it('times out even when a custom fetcher ignores its abort signal', async () => {
    configure();
    const service = new ProviderOAuthService(
      new AiProxyServer(),
      () => undefined,
      (() => new Promise<Response>(() => {})) as typeof fetch,
      5,
    );
    await expect(service.start('openai')).rejects.toThrow('OAuth device authorization failed.');
  });

  it('times out a response reader that ignores cancellation', async () => {
    configure();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { cancelled = true; },
    });
    const service = new ProviderOAuthService(
      new AiProxyServer(),
      () => undefined,
      vi.fn().mockResolvedValueOnce(new Response(body, { status: 200 })) as typeof fetch,
      5,
    );
    await expect(service.start('openai')).rejects.toThrow('OAuth response is invalid.');
    expect(cancelled).toBe(true);
  });

  it('never activates a token that could not be persisted', async () => {
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
    const service = new ProviderOAuthService(proxy, () => undefined, fetcher as typeof fetch);
    const flow = await service.start('openai');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.get(flow.id)).toMatchObject({ state: 'failed', error: 'OAuth token exchange failed.' });
    expect(setApiKey).not.toHaveBeenCalled();
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
    const setOAuth = vi.fn().mockResolvedValue(undefined);
    const credentials = { hasPersistentStore: () => true, setOAuth } as unknown as ProviderCredentialService;
    const service = new ProviderOAuthService(proxy, () => credentials, fetcher as typeof fetch);
    const flow = await service.start('openai');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.get(flow.id)).toMatchObject({ state: 'connected' });
    expect(JSON.stringify(service.get(flow.id))).not.toContain('private-access-token');
    expect(setApiKey).toHaveBeenCalledWith('openai', 'private-access-token');
    expect(setOAuth).toHaveBeenCalledWith('openai', { accessToken: 'private-access-token' });
  });
});
