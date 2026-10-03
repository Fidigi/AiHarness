import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public-vapid-key', privateKey: 'private-vapid-key' })),
    setVapidDetails: vi.fn(),
    sendNotification,
  },
}));

import { PushService } from './push-service.js';

const roots: string[] = [];
async function service(masterKey = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aih-push-'));
  roots.push(root);
  const push = new PushService(path.join(root, 'push.enc'), masterKey);
  await push.load();
  return { root, push };
}

beforeEach(() => sendNotification.mockReset().mockResolvedValue({ statusCode: 201 }));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const subscription = {
  endpoint: 'https://push.example.test/subscription/one',
  expirationTime: null,
  keys: { p256dh: 'public-client-key', auth: 'auth-client-key' },
};

describe('PushService', () => {
  it('registers categories, sends bounded payloads, and removes expired endpoints', async () => {
    const { push } = await service();
    expect(push.getPublicKey()).toBe('public-vapid-key');
    expect(push.getStatus().persistent).toBe(false);
    await push.subscribe(subscription, ['completion']);
    expect(push.getStatus(subscription.endpoint)).toMatchObject({ subscribed: true, categories: ['completion'] });

    await push.notify('attention', { title: 'Ignored', body: 'No category', tag: 'run:1', url: '/chat/1' });
    expect(sendNotification).not.toHaveBeenCalled();
    await push.notify('completion', { title: 'Done', body: 'Agent completed', tag: 'run:1', url: '/chat/1' });
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ endpoint: subscription.endpoint }),
      expect.stringContaining('Agent completed'), expect.objectContaining({ TTL: 3600 }));

    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await push.notify('completion', { title: 'Done', body: 'Again', tag: 'run:2', url: '/chat/1' });
    expect(push.getStatus(subscription.endpoint).subscribed).toBe(false);
  });

  it('rejects private push endpoints outside tests', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { push } = await service();
    await expect(push.subscribe({ ...subscription, endpoint: 'https://127.0.0.1/push' }, ['completion']))
      .rejects.toMatchObject({ status: 400 });
    await expect(push.subscribe({ ...subscription, endpoint: 'https://[::1]/push' }, ['completion']))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects malformed endpoints/keys and persists subscriptions only with a master key', async () => {
    const { root, push } = await service('test-master-key-with-32-characters');
    expect(push.getStatus().persistent).toBe(true);
    await expect(push.subscribe({ ...subscription, endpoint: 'http://push.example.test/sub' }, ['completion']))
      .rejects.toMatchObject({ status: 400 });
    await expect(push.subscribe({ ...subscription, keys: { p256dh: 'x' } }, ['completion']))
      .rejects.toMatchObject({ status: 400 });
    await expect(push.subscribe(subscription, ['unknown']))
      .rejects.toMatchObject({ status: 400 });
    await push.subscribe(subscription, ['attention']);

    const restored = new PushService(path.join(root, 'push.enc'), 'test-master-key-with-32-characters');
    await restored.load();
    expect(restored.getStatus(subscription.endpoint)).toMatchObject({ subscribed: true, categories: ['attention'], persistent: true });
  });
});
