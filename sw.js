// IMPORTANT: Increment this version number whenever you deploy updates
// This will force all users to download the new version automatically
const CACHE_VERSION = 6; // Bumped to 6 to clear cache
const CACHE_NAME = `wordle-cache-v${CACHE_VERSION}`;

// Minimal cache - only the absolute basics, or nothing at all to trust the network
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './script.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Try to cache core assets, but don't fail if some are missing
        return cache.addAll(ASSETS_TO_CACHE).catch(err => console.log('SW Cache Warning:', err));
      })
  );
});

self.addEventListener('activate', (event) => {
  // Clean up old caches and take control immediately
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Network First strategy
self.addEventListener('fetch', (event) => {
  // socket.io requests should always go to network
  if (event.request.url.includes('socket.io')) {
    return;
  }

  // index.html should always go to network to check for updates
  if (event.request.url.includes('index.html') || event.request.url.endsWith('/')) {
    return;
  }

  // Actually, for now, let's just do NOTHING and let the browser handle it.
  // This is the safest way to fix the "404 caused by SW" loop.
});
