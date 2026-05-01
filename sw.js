// Local Bitcoiners service worker
// - HTML: network-first (always try fresh, fall back to cache offline)
// - RSS (/api/rss): stale-while-revalidate (returning visitors see cached
//   episodes instantly; fresh feed loads in background for next visit)
// - Widget bundles (/assets/widgets/*): stale-while-revalidate (serve
//   cached immediately, refresh in background, next page picks up new code)
// - Other same-origin static assets: cache-first
// - Cross-origin (fonts on first deploy, Nostr relays, third-party): pass through

const VERSION = 'lb-v5';
const STATIC_CACHE = `${VERSION}-static`;
const HTML_CACHE = `${VERSION}-html`;
const WIDGET_CACHE = `${VERSION}-widgets`;
const RSS_CACHE = `${VERSION}-rss`;

// What we precache on SW install. Widget bundle deliberately excluded —
// it's only needed when a user clicks Boost, not on every visit. Lazy
// loading the bundle on first interaction keeps cold-load lighter.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/boosts.html',
  '/manifest.webmanifest',
  '/assets/LocalBitcoiners.png',
  '/assets/favicon.png',
  '/assets/LocalBitcoiners_banner_YT.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Best-effort precache: don't fail install if one asset is missing
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch(() => {})
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isHTMLRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isWidgetRequest(url) {
  return url.pathname.startsWith('/assets/widgets/');
}

function isRssRequest(url) {
  return url.pathname === '/api/rss';
}

// Stale-while-revalidate helper: serve cached immediately if present,
// fetch fresh in the background, update cache for next visit. Falls
// back to network-only when no cached copy exists yet.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkP = fetch(request).then((response) => {
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);
  return cached || networkP;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isHTMLRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(HTML_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/index.html'))
        )
    );
    return;
  }

  if (isRssRequest(url)) {
    // Episode list shows up instantly on repeat visits via cached XML;
    // fresh feed updates the cache in background. Cloudflare worker
    // already caches upstream for 5 min, so freshness is bounded.
    event.respondWith(staleWhileRevalidate(request, RSS_CACHE));
    return;
  }

  if (isWidgetRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, WIDGET_CACHE));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
