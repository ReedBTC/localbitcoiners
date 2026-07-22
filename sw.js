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
// v20: Biggest Boosts feed no longer loops (stops at #5, auto jumps to top);
// touch-action:pan-y makes the card swipe sideways on mobile.
// v21: shared /assets/js/sw-register.js — forces SW update checks on load +
// focus and auto-reloads once when a new SW takes control, so mobile/PWA pick
// up deploys without a manual cache clear. Only VERSION needs bumping going
// forward (no per-asset query strings).
// v22: stale-while-revalidate now revalidates assets with the server
// (cache:'no-cache') so the SW can't re-cache a copy up to 4h stale from the
// browser HTTP cache — deploys propagate within a navigation, not hours.
// v25: /feeds bundle lands on main (Podcast Boosts + Articles tabs,
// snapshot-first Events/Market, external V4V boosting, supporters co-hosts +
// follow packs). Bump evicts stale stale-while-revalidate copies of the many
// changed /assets files (feeds*.js, merch.js, supporters.js, boosts-thread.js,
// boost-actions.js, value-block.js, login-widget.js) so returning visitors get
// the new code on first navigation instead of after a 2nd revalidate.
// v27: wallet pre-warm no longer calls WebLN enable() on page load (it wedged
// the extension's request pipe on /feeds and surfaced as a dead wallet dot +
// "extension didn't respond"), plus a single-flight guard on enable(). Every
// widget trigger sitewide now shares one loader promise (new widget-loader.js,
// precached below), so a second trigger can't re-inject a bundle already in
// flight. Evicts login-widget.js and the pages carrying inline loaders.
// v28: /feeds Podcast Boosts drawer counts distinct boosters instead of raw
// boosts ("1 local booster · 11 local boosts"), + "Most boosters"/"Most boosts"
// as separate sorts. Bump evicts the stale stale-while-revalidate copy of
// feeds-podcasts.js so returning visitors get the new wording on first
// navigation instead of after a 2nd revalidate.
// v29: page-load session restore no longer fires a no-gesture getPublicKey()
// through NDK's `set signer` side effect (it wedged the extension's request
// pipe and surfaced as a ~30s boost hang ending in a spurious connect modal),
// signer verify asks the extension fresh at tap time, remembered-wallet unlock
// timeouts toast a retry instead of the connect modal, and zap/legacy-DM
// extension calls are bounded. Evicts login-widget.js, boost-actions.js and
// feeds-market.js so the fix reaches returning visitors on first navigation.
// v30: window.webln.sendPayment is now bounded — a wedged extension can no
// longer freeze the boost modal on "Paying…" forever. Evicts login-widget.js.
// v31: merch checkout is settlement-verified (payInvoiceVerified + LUD-21) so
// an ambiguous NWC result no longer looks like a clean failure the buyer can
// blind-retry — the bug where one coffee order settled four times. Evicts
// login-widget.js, merch.js and merch.css so /merch + /feeds get it on first
// navigation.
// v32: payment-review sweep. Zaps are settlement-verified (no more manual-
// invoice fallback after an ambiguous wallet attempt — the double-pay path),
// merch LNURL fetches are bounded + callback-host-checked, webln.keysend is
// bounded like sendPayment, LUD-21 verify polls are bounded, user-rejected
// payments classify as clean declines instead of stalling into UNCERTAIN,
// and the login inputs no longer remount per keystroke. LNURL fetches also
// retry once on a short backoff before failing a leg — CDN-fronted
// providers (getalby, 2026-07-17) intermittently hard-fail browser fetches
// while staying healthy for server-side callers. Evicts login-widget.js,
// boost-actions.js, merch.js and feeds-market.js.
// v34: /feeds Events tab overhaul — Featured Events section (gold glow +
// "Featured by …" booster credit), forward 1W/1M/All range + In-Person/
// Virtual/All-Types filters (replacing month/year + virtual toggle), "Feature"
// button + "Find Event to Feature" in the Featured header, naddr copy, single
// Past Events drawer. New CSS rules (.promote-btn, .featured-by*, .feed-*) live
// in boost-actions.css / boosts-thread.css / feeds.html, so returning visitors
// on the old stale-while-revalidate copy saw the Feature button and booster
// avatars UNSTYLED (no orange fill, natural-size pfps) until a 2nd revalidate.
// Bump evicts the stale boost-actions.css, boosts-thread.css, calendar-events.js
// and feeds.js so mobile/PWA get the new styling on first navigation.
//
// lb-v41: stats page — drop the per-episode "Ep N" text labels across the top
// of the Podcast Value Details chart (tooltips already cover it, and the labels
// were crowding the top margin). Tightened the chart's top margin to reclaim the
// freed space; removed the now-dead .stats-chart-eplabel CSS. stats.js + stats.html
// both changed, so evict both together.
const VERSION = 'lb-v41';
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
  '/assets/js/widget-loader.js',
  '/assets/js/sw-register.js',
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
//
// The background fetch uses { cache: 'no-cache' } so it always REVALIDATES
// with the server (conditional request → 304 or fresh) instead of being
// satisfied by the browser's HTTP cache. Cloudflare Pages serves assets with
// `max-age=14400` (4h), so a plain fetch could re-populate the SW cache with a
// copy up to 4h stale — which made deploys look "stuck" for frequent reloaders
// even after a VERSION bump. Revalidating kills that window; the cached copy is
// still returned instantly, so first paint isn't slowed.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkP = fetch(request, { cache: 'no-cache' }).then((response) => {
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
