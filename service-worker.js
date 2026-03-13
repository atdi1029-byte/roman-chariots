const CACHE_NAME = 'chariots-v45';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './chariot-192.png',
  './chariot-512.png',
  './logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Skip Google Apps Script requests — always network
  if (e.request.url.includes('script.google.com')) return;

  if (e.request.mode === 'navigate') {
    // Network-first for navigation
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for assets
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
