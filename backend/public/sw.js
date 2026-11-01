// Saha Takip Servis Çalışanı (PWA Service Worker)
const CACHE_NAME = 'saha-takip-v1';
const ASSETS = [
  '/takip.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Canlı API ve socket isteklerini cacheleme
  if (
    event.request.url.includes('/socket.io/') ||
    event.request.url.includes('/update') ||
    event.request.url.includes('/sos') ||
    event.request.url.includes('/api/')
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
