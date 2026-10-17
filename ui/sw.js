/* AirChat's service worker.
 *
 * Two jobs:
 *   1. Keep the app shell cached so an installed AirChat opens instantly, and
 *      still opens when the laptop running the server is briefly unreachable.
 *   2. Own notification display, which Android browsers require to come from a
 *      service worker rather than the page itself.
 *
 * It never caches /api/* or the live socket: messages must always be real or
 * explicitly unavailable, never a stale illusion.
 */

const CACHE = 'airchat-shell-v2';

const SHELL = [
  '/',
  '/styles.css',
  '/crypto.js',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch((err) => {
        // One missing shell file must not block a working install.
        console.warn('[sw] could not precache the whole shell:', err.message);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Same origin only, and never the API or the WebSocket.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Navigations: prefer the network so updates land, fall back to the shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then((cached) => cached || Response.error())
      )
    );
    return;
  }

  // Everything else: serve from cache immediately, refresh it in the background.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);

        return cached || network;
      })
    )
  );
});

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

self.addEventListener('push', (event) => {
  let payload = { title: 'AirChat', body: 'New message' };

  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch (err) {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'airchat',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
      return undefined;
    })
  );
});
