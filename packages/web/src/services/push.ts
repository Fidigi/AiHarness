import { getPushPublicKey, registerPushSubscription, unregisterPushSubscription } from './api';

export type NotificationEvent = 'completion' | 'attention';

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  return new Uint8Array(bytes.buffer);
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Register, refresh or remove the browser push endpoint after an explicit user action. */
export async function syncPushSubscription(
  enabled: boolean,
  categories: NotificationEvent[],
): Promise<{ subscribed: boolean; persistent?: boolean; error?: string }> {
  if (!pushSupported()) return { subscribed: false, error: 'Web Push is not supported by this browser.' };
  try {
    const registration = await navigator.serviceWorker.getRegistration()
      ?? await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    let subscription = await registration.pushManager.getSubscription();
    if (!enabled || categories.length === 0) {
      if (subscription) {
        await unregisterPushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      return { subscribed: false };
    }
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission !== 'granted') return { subscribed: false, error: 'Notification permission was not granted.' };
    const key = await getPushPublicKey();
    if (!key.success || !key.data) return { subscribed: false, error: key.error || 'Push key is unavailable.' };
    const serverKey = applicationServerKey(key.data.publicKey);
    const subscribedKey = subscription?.options.applicationServerKey
      ? new Uint8Array(subscription.options.applicationServerKey) : undefined;
    if (subscription && (!subscribedKey || subscribedKey.length !== serverKey.length
      || subscribedKey.some((value, index) => value !== serverKey[index]))) {
      await unregisterPushSubscription(subscription.endpoint);
      await subscription.unsubscribe();
      subscription = null;
    }
    try {
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
    } catch {
      // A VAPID rotation requires replacing the endpoint rather than silently failing forever.
      await subscription?.unsubscribe();
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
    }
    const saved = await registerPushSubscription(subscription.toJSON(), categories);
    return saved.success
      ? { subscribed: true, persistent: key.data.persistent }
      : { subscribed: false, error: saved.error };
  } catch (error) {
    return { subscribed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
