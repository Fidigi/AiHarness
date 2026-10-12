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
