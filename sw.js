// Minimal app-shell service worker: makes the prototype installable and
// gives it basic offline resilience. Not doing anything clever with
// runtime caching yet — that's a later-stage concern.
const CACHE_NAME = 'the-hunt-v4';
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/geo.js',
  './js/characters.js',
  './js/spawner.js',
  './js/sensors.js',
  './js/storage.js',
  './js/ui.js',
  './js/icons.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/creatures/blue-men-1-thumb.webp',
  './assets/creatures/blue-men-1.webp',
  './assets/creatures/blue-men-2-thumb.webp',
  './assets/creatures/blue-men-2.webp',
  './assets/creatures/blue-men-3-thumb.webp',
  './assets/creatures/blue-men-3.webp',
  './assets/creatures/domovoy-1-thumb.webp',
  './assets/creatures/domovoy-1.webp',
  './assets/creatures/domovoy-2-thumb.webp',
  './assets/creatures/domovoy-2.webp',
  './assets/creatures/domovoy-3-thumb.webp',
  './assets/creatures/domovoy-3.webp',
  './assets/creatures/hollow-hart-1-thumb.webp',
  './assets/creatures/hollow-hart-1.webp',
  './assets/creatures/hollow-hart-2-thumb.webp',
  './assets/creatures/hollow-hart-2.webp',
  './assets/creatures/hollow-hart-3-thumb.webp',
  './assets/creatures/hollow-hart-3.webp',
  './assets/creatures/leprechaun-1-thumb.webp',
  './assets/creatures/leprechaun-1.webp',
  './assets/creatures/leprechaun-2-thumb.webp',
  './assets/creatures/leprechaun-2.webp',
  './assets/creatures/leprechaun-3-thumb.webp',
  './assets/creatures/leprechaun-3.webp',
  './assets/creatures/naga-1-thumb.webp',
  './assets/creatures/naga-1.webp',
  './assets/creatures/naga-2-thumb.webp',
  './assets/creatures/naga-2.webp',
  './assets/creatures/naga-3-thumb.webp',
  './assets/creatures/naga-3.webp',
  './assets/creatures/rusalka-1-thumb.webp',
  './assets/creatures/rusalka-1.webp',
  './assets/creatures/rusalka-2-thumb.webp',
  './assets/creatures/rusalka-2.webp',
  './assets/creatures/rusalka-3-thumb.webp',
  './assets/creatures/rusalka-3.webp',
  './assets/creatures/wulver-1-thumb.webp',
  './assets/creatures/wulver-1.webp',
  './assets/creatures/wulver-2-thumb.webp',
  './assets/creatures/wulver-2.webp',
  './assets/creatures/wulver-3-thumb.webp',
  './assets/creatures/wulver-3.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first for navigations so the player always gets fresh game
  // logic when online; cache fallback keeps it launchable offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
