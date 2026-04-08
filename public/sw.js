// Dolk Agent Service Worker
const CACHE_V = 'dolk-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/robots.txt',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_V).then(cache => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(key => key !== CACHE_V && caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // API calls: network first, then cache
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          caches.open(CACHE_V).then(cache => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets: cache first, then network
  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request).then(res => {
        caches.open(CACHE_V).then(cache => cache.put(request, res.clone()));
        return res;
      }))
      .catch(() => new Response('Offline', { status: 503 }))
  );
});
