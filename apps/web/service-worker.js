/**
 * Service worker.
 *
 * The API is a separate origin and is never cached — mail must always be
 * fetched live so a stale list can't be shown. Only the static app shell
 * (HTML/CSS/JS/icons) is pre-cached, and navigations fall back to the cached
 * shell when the network is unavailable.
 */

const VERSION = 're-el-mailer-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/store.js',
  './js/router.js',
  './js/ui.js',
  './js/auth-events.js',
  './js/views/auth.js',
  './js/views/mail-list.js',
  './js/views/message.js',
  './js/views/compose.js',
  './js/views/settings.js',
  './js/views/admin.js',
  './assets/favicon.svg',
  './assets/icon-192.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API traffic — it is authenticated and must stay live.
  if (url.pathname.startsWith('/api') || url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html').then((hit) => hit || Response.error())),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});