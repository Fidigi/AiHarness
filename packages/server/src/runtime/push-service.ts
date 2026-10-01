import webPush from 'web-push';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { EncryptedCredentialStore } from '../security/credential-store.js';

export type PushEventCategory = 'completion' | 'attention';

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  categories: PushEventCategory[];
  createdAt: string;
  updatedAt: string;
}

interface PushDocument {
  keys: { publicKey: string; privateKey: string };
  subscriptions: StoredPushSubscription[];
}

function validateSubscription(value: unknown, categories: unknown): Omit<StoredPushSubscription, 'createdAt' | 'updatedAt' | 'categories'> {
  if (!value || typeof value !== 'object') throw Object.assign(new Error('Push subscription is invalid.'), { status: 400 });
  const input = value as Record<string, unknown>;
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || endpoint.length > 4_096 || url.username || url.password) {
    throw Object.assign(new Error('Push endpoint is invalid.'), { status: 400 });
  }
  const keys = input.keys && typeof input.keys === 'object' ? input.keys as Record<string, unknown> : {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
    || keys.p256dh.length > 500 || keys.auth.length > 500) {
    throw Object.assign(new Error('Push subscription keys are invalid.'), { status: 400 });
  }
  if (!Array.isArray(categories) || !categories.every(item => item === 'completion' || item === 'attention')) {
    throw Object.assign(new Error('Push categories are invalid.'), { status: 400 });
  }
  return {
    endpoint,
    ...(typeof input.expirationTime === 'number' || input.expirationTime === null ? { expirationTime: input.expirationTime } : {}),
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized);
}

async function assertPublicEndpoint(endpoint: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  const hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || privateAddress(hostname)) {
    throw Object.assign(new Error('Private push endpoints are forbidden.'), { status: 400 });
  }
  let addresses: Array<{ address: string }>;
  try { addresses = await lookup(hostname, { all: true }); }
  catch { throw Object.assign(new Error('Push endpoint hostname cannot be resolved.'), { status: 400 }); }
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) {
    throw Object.assign(new Error('Private push endpoints are forbidden.'), { status: 400 });
  }
}

/** VAPID Web Push subscriptions persisted only inside the encrypted credential store. */
export class PushService {
  private document?: PushDocument;
  private readonly store?: EncryptedCredentialStore;

  constructor(filePath: string, masterKey = process.env.AI_HARNESS_MASTER_KEY) {
    if (masterKey) this.store = new EncryptedCredentialStore(filePath, masterKey);
  }

  async load(): Promise<void> {
    await this.store?.load();
    const stored = this.store?.get('web-push');
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as PushDocument;
        if (parsed.keys?.publicKey && parsed.keys?.privateKey && Array.isArray(parsed.subscriptions)) this.document = parsed;
      } catch {
        // Regenerate invalid encrypted state rather than exposing it.
      }
    }
    if (!this.document) this.document = { keys: webPush.generateVAPIDKeys(), subscriptions: [] };
    webPush.setVapidDetails(
      process.env.AI_HARNESS_VAPID_SUBJECT ?? 'mailto:aiharness@localhost',
      this.document.keys.publicKey,
      this.document.keys.privateKey,
    );
    await this.persist();
  }

  getPublicKey(): string { return this.required().keys.publicKey; }

  getStatus(endpoint?: string): { supported: true; subscribed: boolean; categories: PushEventCategory[]; persistent: boolean } {
    const subscription = endpoint ? this.required().subscriptions.find(item => item.endpoint === endpoint) : undefined;
    return {
      supported: true,
      subscribed: Boolean(subscription),
      categories: subscription?.categories ?? [],
      persistent: Boolean(this.store),
    };
  }

  async subscribe(value: unknown, categories: unknown): Promise<{ subscribed: true; categories: PushEventCategory[] }> {
    const normalized = validateSubscription(value, categories);
    await assertPublicEndpoint(normalized.endpoint);
    const selected = [...new Set(categories as PushEventCategory[])];
    const document = this.required();
    const previous = document.subscriptions.find(item => item.endpoint === normalized.endpoint);
    const now = new Date().toISOString();
    const subscription: StoredPushSubscription = {
      ...normalized,
      categories: selected,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    document.subscriptions = [...document.subscriptions.filter(item => item.endpoint !== normalized.endpoint), subscription]
      .slice(-1_000);
    await this.persist();
    return { subscribed: true, categories: selected };
  }

  async unsubscribe(endpoint: unknown): Promise<boolean> {
    if (typeof endpoint !== 'string' || endpoint.length > 4_096) return false;
    const document = this.required();
    const before = document.subscriptions.length;
    document.subscriptions = document.subscriptions.filter(item => item.endpoint !== endpoint);
    if (before !== document.subscriptions.length) await this.persist();
    return before !== document.subscriptions.length;
  }

  async notify(category: PushEventCategory, payload: {
    title: string;
    body: string;
    tag: string;
    url: string;
  }): Promise<void> {
    const document = this.required();
    const stale: string[] = [];
    const body = JSON.stringify({
      category,
      title: payload.title.slice(0, 200),
      body: payload.body.slice(0, 1_000),
      tag: payload.tag.slice(0, 300),
      url: payload.url.startsWith('/') ? payload.url.slice(0, 2_000) : '/',
    });
    await Promise.allSettled(document.subscriptions
      .filter(subscription => subscription.categories.includes(category))
      .map(async subscription => {
        try {
          await webPush.sendNotification({
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime ?? null,
            keys: subscription.keys,
          }, body, { TTL: 60 * 60, urgency: category === 'attention' ? 'high' : 'normal', topic: payload.tag.slice(0, 32) });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) stale.push(subscription.endpoint);
        }
      }));
    if (stale.length) {
      const remove = new Set(stale);
      document.subscriptions = document.subscriptions.filter(subscription => !remove.has(subscription.endpoint));
      await this.persist();
    }
  }

  private required(): PushDocument {
    if (!this.document) throw new Error('PushService.load() must be awaited before use.');
    return this.document;
  }

  private async persist(): Promise<void> {
    if (this.store && this.document) await this.store.set('web-push', JSON.stringify(this.document));
  }
}
