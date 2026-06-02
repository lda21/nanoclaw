// Minimal service worker for PWA installability
const CACHE = 'voice-pwa-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  // Network-first for everything (this is a real-time app, no offline needed)
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
