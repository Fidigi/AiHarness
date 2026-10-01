import { afterEach, describe, expect, it, vi } from 'vitest';

const { getPushPublicKey, registerPushSubscription, unregisterPushSubscription } = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(), registerPushSubscription: vi.fn(), unregisterPushSubscription: vi.fn(),
}));
vi.mock('./api', () => ({ getPushPublicKey, registerPushSubscription, unregisterPushSubscription }));

import { pushSupported, syncPushSubscription } from './push';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function browser(existing: Record<string, any> | null = null) {
  const next = {
    endpoint: 'https://push.example/new',
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const subscribe = vi.fn().mockResolvedValue(next);
  const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(existing), subscribe } };
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration), register: vi.fn() } });
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
  return { registration, subscribe, next };
}

describe('Web Push preferences', () => {
  it('detects support and replaces a subscription after VAPID key rotation', async () => {
    const previous = {
      endpoint: 'https://push.example/old',
      options: { applicationServerKey: new Uint8Array([9]).buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const { subscribe, next } = browser(previous);
    getPushPublicKey.mockResolvedValue({ success: true, data: { publicKey: 'AQID', persistent: true } });
    unregisterPushSubscription.mockResolvedValue({ success: true });
    registerPushSubscription.mockResolvedValue({ success: true, data: { subscribed: true } });

    expect(pushSupported()).toBe(true);
    await expect(syncPushSubscription(true, ['completion', 'attention']))
      .resolves.toEqual({ subscribed: true, persistent: true });
    expect(unregisterPushSubscription).toHaveBeenCalledWith(previous.endpoint);
    expect(previous.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(registerPushSubscription).toHaveBeenCalledWith(next.toJSON(), ['completion', 'attention']);
  });

  it('unregisters locally and remotely when disabled', async () => {
    const existing = {
      endpoint: 'https://push.example/existing', options: { applicationServerKey: new ArrayBuffer(0) },
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    browser(existing);
    unregisterPushSubscription.mockResolvedValue({ success: true });
    await expect(syncPushSubscription(false, ['completion'])).resolves.toEqual({ subscribed: false });
    expect(unregisterPushSubscription).toHaveBeenCalledWith(existing.endpoint);
    expect(existing.unsubscribe).toHaveBeenCalled();
  });
});
