// Map tile service worker — caches CartoDB tiles so zooming/panning
// to previously visited areas loads instantly.
const CACHE_NAME = 'map-tiles-v1';
const MAX_ENTRIES = 3000; // ~45 MB at ~15 KB per tile

const isTile = (url) =>
  url.includes('basemaps.cartocdn.com');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (!isTile(event.request.url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;

      const response = await fetch(event.request);
      if (response.ok) {
        cache.put(event.request, response.clone());
        // Prune oldest entries if cache is too large
        cache.keys().then((keys) => {
          if (keys.length > MAX_ENTRIES) {
            keys.slice(0, keys.length - MAX_ENTRIES).forEach((k) => cache.delete(k));
          }
        });
      }
      return response;
    })
  );
});
