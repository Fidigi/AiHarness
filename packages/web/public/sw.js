const CACHE_PREFIX = 'aiharness-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const SHELL = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { payload = { body: event.data?.text() ?? '' }; }
    const visibleClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (visibleClients.some(client => client.visibilityState === 'visible')) return;
    const title = typeof payload.title === 'string' ? payload.title : 'AiHarness';
    const body = typeof payload.body === 'string' ? payload.body : 'Agent update';
    const tag = typeof payload.tag === 'string' ? payload.tag : 'aiharness-agent';
    const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: payload.category === 'attention',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const path = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/';
    const destination = new URL(path, self.location.origin).href;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      if ('navigate' in existing) await existing.navigate(destination);
      return;
    }
    await self.clients.openWindow(destination);
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request))
          || (await caches.match('/'))
          || (await caches.match('/offline.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
