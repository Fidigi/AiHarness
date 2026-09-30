import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthDeviceClient } from './oauth-device';

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
