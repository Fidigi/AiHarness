import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialRedactor, getGitHubCopilotOAuthConfig, getKimiCodingOAuthConfig } from '@ai-harness/core';
import { OAuthDeviceClient, type OAuthDeviceConfig } from './oauth-device';

afterEach(() => vi.restoreAllMocks());

describe('OAuthDeviceClient', () => {
  it('requests a device code and polls through authorization_pending', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'device', user_code: 'ABCD', verification_uri: 'https://login.test', expires_in: 30, interval: 0.001,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'oauth-token' }), { status: 200 }));
    const client = new OAuthDeviceClient({
      deviceAuthorizationUrl: 'https://oauth.test/device',
      tokenUrl: 'https://oauth.test/token',
      clientId: 'client',
      scope: 'models',
    });

    const prompt = await client.requestCode();
    await expect(client.pollToken(prompt)).resolves.toBe('oauth-token');
    expect(prompt.userCode).toBe('ABCD');
  });

  it('refuses a pre-aborted device request before transport', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      device_code: 'device', user_code: 'ABCD', verification_uri: 'https://login.test', expires_in: 30, interval: 0.001,
    }), { status: 200 }));
    const client = new OAuthDeviceClient({
      deviceAuthorizationUrl: 'https://oauth.test/device', tokenUrl: 'https://oauth.test/token', clientId: 'client',
    });
    const controller = new AbortController(); controller.abort();
    await expect(client.requestCode(controller.signal)).rejects.toThrow('annulée');
    expect(transport).not.toHaveBeenCalled();
  });

  it('links caller cancellation through a finite device response body', async () => {
    let observed: AbortSignal | null | undefined;
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
      cancel: cancelled,
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      observed = init?.signal;
      entered();
      return new Response(body, { status: 200 });
    });
    const client = new OAuthDeviceClient({
      deviceAuthorizationUrl: 'https://oauth.test/device', tokenUrl: 'https://oauth.test/token', clientId: 'client',
    });
    const controller = new AbortController();
    const operation = client.requestCode(controller.signal);
    void operation.catch(() => undefined);
    try {
      await started;
      controller.abort();
      expect(observed?.aborted).toBe(true);
      await expect(operation).rejects.toThrow();
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      try { bodyController.error(new Error('fixture cleanup')); } catch { /* Stream already cancelled. */ }
      await operation.catch(() => undefined);
    }
  });

  it('uses the explicitly selected Kimi device grant and requires refreshable expiring credentials', async () => {
    const transport = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'kimi-device', user_code: 'KIMI-123',
        verification_uri: 'https://issuer.test/verify', verification_uri_complete: 'https://issuer.test/verify?code=private',
        expires_in: 30, interval: 0.001 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_in: 3600 }), { status: 200 }));
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const client = new OAuthDeviceClient(getKimiCodingOAuthConfig('https://issuer.test'));
    const prompt = await client.requestCode();
    const credential = await client.pollCredential(prompt);
    expect(credential).toMatchObject({ accessToken: 'kimi-access', refreshToken: 'kimi-refresh', expiresAt: 3_700_000 });
    expect(transport.mock.calls.map(([url]) => url)).toEqual(['https://issuer.test/api/oauth/device_authorization', 'https://issuer.test/api/oauth/token']);
    expect(Object.fromEntries(new URLSearchParams(String(transport.mock.calls[0]![1]?.body)))).toEqual({ client_id: '17e5f671-d194-4dfb-9706-5516cb48c098' });
    expect(Object.fromEntries(new URLSearchParams(String(transport.mock.calls[1]![1]?.body)))).toEqual({
      client_id: '17e5f671-d194-4dfb-9706-5516cb48c098', device_code: 'kimi-device', grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(transport.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.signal instanceof AbortSignal)).toBe(true);
  });

  it('refuses incomplete Kimi authorization instructions instead of using a generic fallback', async () => {
    const transport = vi.spyOn(globalThis, 'fetch');
    for (const body of [
      { device_code: 'device', user_code: 'USER-123', verification_uri: 'https://issuer.test/verify', expires_in: 30, interval: 0.001 },
      { device_code: 'device', user_code: 'USER-123', verification_url: 'https://issuer.test/verify', verification_uri_complete: 'https://issuer.test/verify?code=private', expires_in: 30, interval: 0.001 },
    ]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(new OAuthDeviceClient(getKimiCodingOAuthConfig('https://issuer.test')).requestCode()).rejects.toThrow('La réponse OAuth est invalide.');
    }
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('refuses incomplete Kimi token responses rather than accepting generic nonexpiring tokens', async () => {
    const transport = vi.spyOn(globalThis, 'fetch');
    const client = new OAuthDeviceClient(getKimiCodingOAuthConfig('https://issuer.test'));
    for (const body of [{ access_token: 'kimi-access' }, { access_token: 'kimi-access', expires_in: 3600 },
      { access_token: 'kimi-access', refresh_token: 'kimi-refresh' }, { access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_in: 0 }]) {
      transport.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(client.pollCredential({ deviceCode: 'device', userCode: 'USER-123', verificationUri: 'https://issuer.test/verify', expiresIn: 30, interval: 0.001 }))
        .rejects.toThrow('La réponse OAuth est invalide.');
    }
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('refuses invalid explicit issuer selection and mismatched public-client endpoints before dispatch', () => {
    const transport = vi.spyOn(globalThis, 'fetch');
    for (const overrides of [{ responseProfile: null }, { responseProfile: 'unknown' }, { clientId: 'foreign-client' },
      { tokenUrl: 'https://issuer.test/token' }, { deviceAuthorizationUrl: 'https://foreign.test/api/oauth/device_authorization' }, { scope: 'foreign-scope' }]) {
      const config = { ...getKimiCodingOAuthConfig('https://issuer.test'), ...overrides } as unknown as OAuthDeviceConfig;
      expect(() => new OAuthDeviceClient(config)).toThrow(/OAuth/u);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('exchanges the Copilot device grant before returning a persistable subscription credential', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const transport = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ device_code: 'copilot-device', user_code: 'CODE-123',
        verification_uri: 'https://github.com/login/device', expires_in: 30, interval: 0.001 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'github-private-grant', token_type: 'bearer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'copilot-private-access', expires_at: 2000 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-4o', model_picker_enabled: true }] })));
    const redactor = new CredentialRedactor(), client = new OAuthDeviceClient(getGitHubCopilotOAuthConfig(), redactor);
    const result = await client.pollCredential(await client.requestCode());
    expect(result).toEqual({ accessToken: 'copilot-private-access', refreshToken: 'github-private-grant', expiresAt: 1_700_000,
      subscription: { provider: 'github-copilot', availableModelIds: ['gpt-4o'] } });
    expect(transport.mock.calls.map(([url]) => url)).toEqual(['https://github.com/login/device/code',
      'https://github.com/login/oauth/access_token', 'https://api.github.com/copilot_internal/v2/token', 'https://api.individual.githubcopilot.com/models']);
    expect(Object.fromEntries(new URLSearchParams(String(transport.mock.calls[0]![1]?.body)))).toEqual({ client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' });
    expect(Object.fromEntries(new URLSearchParams(String(transport.mock.calls[1]![1]?.body)))).toEqual({
      client_id: 'Iv1.b507a08c87ecfe98', device_code: 'copilot-device', grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(transport.mock.calls.slice(0, 2).map(([, init]) => new Headers(init?.headers).get('user-agent'))).toEqual(['GitHubCopilotChat/0.35.0', 'GitHubCopilotChat/0.35.0']);
    expect(transport.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
    expect(redactor.redact('github-private-grant copilot-private-access')).toBe('[REDACTED] [REDACTED]');
  });

  it('does not return a GitHub device token when Copilot subscription exchange is refused', async () => {
    const transport = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'github-private-grant' })))
      .mockResolvedValueOnce(new Response('subscription unavailable', { status: 403 }));
    const redactor = new CredentialRedactor(), client = new OAuthDeviceClient(getGitHubCopilotOAuthConfig(), redactor);
    await expect(client.pollCredential({ deviceCode: 'device', userCode: 'CODE-123', verificationUri: 'https://github.com/login/device', expiresIn: 30, interval: 0.001 }))
      .rejects.toThrow('GitHub Copilot authentication failed.');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(redactor.redact('github-private-grant')).toBe('[REDACTED]');
  });

  it('binds the Copilot device profile to its public client, scope and configured enterprise authority', () => {
    for (const override of [{ clientId: 'foreign' }, { scope: 'repo' }, { deviceAuthorizationUrl: 'https://foreign.example/device' },
      { tokenUrl: 'https://foreign.example/token' }, { enterpriseDomain: 'other.ghe.com' }]) {
      expect(() => new OAuthDeviceClient({ ...getGitHubCopilotOAuthConfig('company.ghe.com'), ...override })).toThrow(/OAuth/u);
    }
  });

  it('supports cancellation', async () => {
    const client = new OAuthDeviceClient({
      deviceAuthorizationUrl: 'https://oauth.test/device', tokenUrl: 'https://oauth.test/token', clientId: 'client',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.pollToken({
      deviceCode: 'd', userCode: 'u', verificationUri: 'url', expiresIn: 10, interval: 0.001,
    }, controller.signal)).rejects.toThrow('annulée');
  });
});
