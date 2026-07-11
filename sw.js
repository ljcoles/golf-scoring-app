const CACHE_NAME = 'golf-tracker-v8';
const ASSETS = [
  './index.html',
  './players.html',
  './player-detail.html',
  './courses.html',
  './course-stats.html',
  './export.html',
  './round-summary.html',
  './styles.css',
  './db.js',
  './stats.js',
  './nav.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // cache each file individually so one failed fetch doesn't sink the whole batch
      return Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('Failed to precache', url, err);
          })
        )
      );
    })
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

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetchWithTimeout(event.request, 3000)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// lets pages ask the service worker which of its expected assets are actually cached
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CHECK_CACHE') {
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = {};
      for (const url of ASSETS) {
        const match = await cache.match(url);
        results[url] = !!match;
      }
      event.source.postMessage({ type: 'CACHE_STATUS', cacheName: CACHE_NAME, results });
    });
  }
});
