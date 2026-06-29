// Local Bitcoiners service worker
// - HTML: network-first (always try fresh, fall back to cache offline)
// - RSS (/api/rss): stale-while-revalidate (returning visitors see cached
//   episodes instantly; fresh feed loads in background for next visit)
// - Widget bundles (/assets/widgets/*): stale-while-revalidate (serve
//   cached immediately, refresh in background, next page picks up new code)
// - Other same-origin static assets: stale-while-revalidate (serve cached
//   instantly, revalidate in background — deploys propagate within one
//   navigation without a VERSION bump, and a cached asset survives a
//   transient network blip instead of failing the whole resource load)
// - Cross-origin (fonts on first deploy, Nostr relays, third-party): pass through

// v13: merch storefront added. Bumped (not strictly needed for SWR
// assets) specifically to evict the old stale-while-revalidate copy of
// /assets/widgets/nostr-tools.js — merch.js imports the new nip59 +
// getEventHash exports, and a returning visitor's cached bundle predates
// them, which would fail the ES module link on first merch.html load.
// v14: hero/OG banner swapped from LocalBitcoiners_banner_YT.jpg to
// LocalBitcoiners_banner.png. Bump evicts the precached old .jpg.
// v15: homepage hub + unified Explore nav/footer. Bump evicts stale
// stale-while-revalidate copies of /assets/css/nav.css and the homepage
// JS (home-leaderboards.js etc.) so returning visitors get the new nav
// label, leaderboard tie-tiers, etc. without waiting for a 2nd revalidate.
// v16: clickable URLs/bare domains in the Biggest Boosts leaderboard +
// EP### episode links under guest names (home + supporters). Bump evicts
// stale home-leaderboards.js / home-people.js / supporters.js so returning
// visitors get the links without waiting for a 2nd revalidate.
// v17: Biggest Boosts becomes a fixed-height vertical auto-scrolling feed.
// v18: dead section CSS purged from index.html.
// v19: leaderboards become a swipeable, auto-rotating carousel (3 boards,
// one per view) — bump evicts the stale index.html + home-leaderboards.js.
const VERSION = 'lb-v19';
const STATIC_CACHE = `${VERSION}-static`;
const HTML_CACHE = `${VERSION}-html`;
const WIDGET_CACHE = `${VERSION}-widgets`;
const RSS_CACHE = `${VERSION}-rss`;

// What we precache on SW install. Widget bundle deliberately excluded —
// it's only needed when a user clicks Boost, not on every visit. Lazy
// loading the bundle on first interaction keeps cold-load lighter.
//
// The /ep### page assets are precached too: they're not referenced by
// the homepage, so without this they'd be uncached on a visitor's first
// episode-page hit — and an uncached asset that hits a transient network
// error has no fallback, which is what made episode pages intermittently
// render unstyled / without their chart. data/sats.json is excluded
// (large, changes daily — stale-while-revalidate handles it instead).
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/boosts.html',
  '/manifest.webmanifest',
  '/assets/LocalBitcoiners.png',
  '/assets/favicon.png',
  '/assets/LocalBitcoiners_banner.png',
  '/assets/css/nav.css',
  '/assets/css/footer.css',
  '/assets/css/episode.css',
  '/assets/css/boosts-thread.css',
  '/assets/css/boost-actions.css',
  '/assets/js/episode-enhance.js',
  '/assets/js/ep-sats.js',
  '/assets/js/ep-boosts.js',
  '/assets/js/boosts-thread.js',
  '/assets/js/calendar-events.js',
  '/assets/js/boost-actions.js',
  '/assets/js/nav.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Best-effort precache: don't fail install if one asset is missing
      Promise.all(
        // { cache: 'reload' } forces each precache fetch past the browser
        // HTTP cache, so a VERSION bump re-pulls genuinely fresh assets
        // (e.g. images replaced under the same filename) instead of
        // re-caching a stale copy the browser already had.
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
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
          // Only cache real successful same-origin responses. Without
          // this guard, a 5xx page or Cloudflare challenge HTML would
          // get cached and served as the offline fallback for that
          // URL until the next successful fetch — returning visitors
          // could land on a stuck error page. Mirrors the guard the
          // static-asset branch already has below.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(HTML_CACHE).then((cache) => cache.put(request, copy));
          }
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

  // Other same-origin static assets (CSS, JS, data, images): serve the
  // cached copy instantly and revalidate in the background. A cached
  // asset stays usable through a transient network failure, and a deploy
  // is picked up on the next navigation without needing a VERSION bump.
  event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
});
