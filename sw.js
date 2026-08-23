// Local Bitcoiners service worker
// - HTML: network-first (always try fresh, fall back to cache offline)
// - RSS (/api/rss): stale-while-revalidate (returning visitors see cached
//   episodes instantly; fresh feed loads in background for next visit)
// - Other /api/* live-data proxies: network-first, cache only as an offline
//   fallback — these are feeds, and SWR would serve them a visit behind
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
// lb-v43: stats supporter leaderboard (Total Sats view) now gets the same
// broken-axis "tear" as the episode board — but data-driven for the top N
// outliers: adminpacman + sovreign both dwarf the field, so both are torn and
// the rest scale against #3. buildBarSvg generalized from single-outlier to a
// cliff-detected break group. stats.js only.
// lb-v45: Featured Articles on /feeds. New gold-bordered featured section on
// the Articles tab with its own 1W/1M/All range filter, a per-card Feature
// button, and a "Find an Article to Feature" paste-an-naddr modal. Adds
// /assets/js/featured-articles.js and a block of new .art-featured* /
// .art-feature / .art-find* rules inside feeds.html's inline <style> — the
// classic stale-CSS case, so the bump is what makes returning mobile/PWA
// visitors see the section styled on first navigation instead of raw.
// lb-v46: boost attribution fix in the widget bundle. A logged-in donor could
// land as "Anon" when a transient LNURL hiccup skipped a leg's presign, even
// with a perfectly healthy signer; the payment path now re-signs with the real
// signer before conceding to the anonymous burner. The widget bundle is
// stale-while-revalidate cached, so without a bump a returning donor keeps
// boosting through the old bundle for one more session.
// lb-v47: a Feature boost from the Articles tab now pays the article's author.
// The show's third split leg (34%) is reassigned from aquafox30 to the author's
// kind-0 lud16 for that one boost; the two host legs are untouched, and an
// author with no Lightning address falls back to the standard splits. Touches
// the widget bundle plus featured-articles.js/feeds-articles.js, all
// stale-while-revalidate cached, so without a bump a returning donor would keep
// featuring articles through the old three-host split for one more session.
// lb-v48: /merch retired into the /feeds Marketplace tab. The store is now a
// "Show Merch" section above "Community Marketplace"; merch.js keeps the
// catalog/modal/cart but no longer boots a page. Every page's nav changed (the
// Merch link and the cart icon's href both point at /feeds now), and the nav is
// baked into each precached HTML, so without a bump a returning visitor would
// keep clicking through to a page that 301s. Also covers the cached
// feeds.html + feeds-market.js/merch.js/nav.js that carry the new cart routing.
// lb-v49: Show Merch gets a bordered box (the tab's orange, not the gold that
// means "boosted into a featured slot" elsewhere on /feeds), "Community" in the
// Community Marketplace header links to /supporters, and Manage / List Items
// moves from the panel head down to that header. New .market-house /
// .feed-section-link rules inside feeds.html's inline <style> — the classic
// stale-CSS case, so the bump is what makes returning mobile/PWA visitors see
// the box on first navigation instead of an unstyled section.
// lb-v50: relay lists re-derived by measurement instead of reputation, after a
// listener on mobile saw a boosts feed ~50 notes short of the same page on
// desktop. The read set had drifted to where two of its five relays carried the
// thread at all, leaving Primal's 4.8 MB cache response as the only source for
// the rest and a 6s timeout deciding how much of the feed a phone got. The new
// set covers 399 of 399 known boosts from relays alone. This is a JS + bundle
// change across boosts-thread.js, merch.js, home-people.js, episode-enhance.js,
// feeds-market.js, stats-boosts.js and login-widget.js, all of them
// stale-while-revalidate cached, so without a bump the returning mobile/PWA
// visitors who hit the bug in the first place would keep the old relay lists.
// lb-v51: the boost mega-thread is read from /api/boost-wall (a bot-written
// file) instead of a ~5 MB Primal thread_view plus four relay sockets, on
// boosts.html, index.html, stats.html and every /ep###.
// lb-v52: names and avatars come from /api/profiles, a nightly kind-0 sweep
// covering every npub the site displays, retiring the batched Primal
// user_infos round trip on /supporters, /stats, the homepage and the wall.
// Adds /assets/js/profile-cache.js (precached below).
// lb-v53: the wall paints when the thread is built (~1.6s) instead of when
// quoted notes and calendar cards finish resolving (~4.6s); fountain dropped
// from the calendar query (kind-1 only, 1158ms to connect before refusing);
// Primal queries share one socket instead of redialling per query.
// lb-v54: ⚠️ the /api/* live-data proxies are network-first, NOT
// stale-while-revalidate. SWR returns `cached || network` and never consults
// Cache-Control, so once the boost wall moved from a WebSocket the worker
// never saw to an ordinary HTTP GET, a returning visitor would have been
// served the wall as of their last visit and a new boost would have taken TWO
// page loads to appear. /api/rss keeps SWR on purpose. The bump also evicts
// any lb-v53 STATIC_CACHE entry already holding a wall response.
// lb-v56: the Events feed opens on All rather than the 1M forward window, so
// the full upcoming calendar is visible without a filter click.
// lb-v57: recipient overrides became episode-aware, and Ep015 routes the 2%
// Fountain leg to the Samourai defense address instead of aquafox30. This is a
// payment-routing change in login-widget.js that has to take effect in the same
// window as the RSS split edit and the bot's mirrored table; the widget bundle
// is stale-while-revalidate, so without a bump a returning visitor would boost
// Ep015 through the old routing on their first navigation after the deploy.
// lb-v58: clicking a person now opens their OnlyBoosts page when they have one
// instead of copying their npub, marked by a small blue dot on the avatar. Two
// reasons this needs a bump rather than riding the normal SWR refresh. The dot
// is a brand-new rule set in a brand-new sheet, and a returning visitor on the
// stale CSS would get the behavior change with no cue that anything is
// clickable-through. And calendar-events.js is precached, so its new import of
// onlyboosts.js would dangle on a cold load until that file was cached too —
// both are added to PRECACHE_URLS below.
// lb-v59: fixes the dot's own side effect. lb-v58 set overflow: visible on the
// avatar so the dot could sit outside it, which also released the <img> that
// .sup-avatar / .people-avatar were clipping into a circle, and every supporter
// with a picture rendered square. The image is re-clipped on its own box now.
// Needs its own bump rather than riding lb-v58: onlyboosts.css is precached, so
// anyone who loaded lb-v58 is holding the broken sheet in STATIC_CACHE.
// lb-v60: the booster dot moves inside the avatar's circle. It was pinned to
// the corner of the square box, which on a circle is diagonally outside it —
// unnoticeable at 26px, but visibly detached on a 104px supporter tile.
// Precached sheet again, so it needs its own bump.
// lb-v61: booster dot moves to bottom-right with its centre on the circle's
// edge, matching how shipped design systems place an identity marker. Precached
// sheet, so it needs its own bump.
// lb-v62: the boost widget now stamps the share-note outcome onto the kind
// 30078 receipt, tags the donor's kind 1 with the boost session, and publishes
// that note to the boost-dense core relays as well as the donor's outbox. The
// widget bundle is stale-while-revalidate, so a returning visitor would
// otherwise boost once on the old code; the receipt it writes is the record a
// bot reads to decide whether the boost still needs a note published on the
// donor's behalf, and that decision is worth getting right on the first boost
// rather than the second.
const VERSION = 'lb-v64';
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
  '/assets/css/onlyboosts.css',
  '/assets/js/episode-enhance.js',
  '/assets/js/ep-sats.js',
  '/assets/js/ep-boosts.js',
  '/assets/js/boosts-thread.js',
  '/assets/js/profile-cache.js',
  '/assets/js/calendar-events.js',
  '/assets/js/onlyboosts.js',
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

// Live-data proxies: /api/boost-wall, /api/profiles, /api/sats, /api/zaps,
// /api/community-*, /api/meetups. NOT /api/rss, which has its own
// stale-while-revalidate branch below on purpose (the episode list is worth
// showing instantly and barely changes).
//
// ⚠️ These must NOT go through staleWhileRevalidate. It does
// `return cached || networkP`, so it hands back whatever is in the cache
// regardless of age and only updates for NEXT time — Cache-Control is never
// consulted. That is right for a hashed asset and wrong for a feed: a
// returning visitor would see the boost wall as of their last visit, and a new
// boost would take TWO page loads to appear. Before the wall moved to an HTTP
// GET it arrived over a WebSocket the worker never saw, so this staleness is
// new with that change rather than pre-existing behaviour for this data.
function isLiveDataRequest(url) {
  return url.pathname.startsWith('/api/') && url.pathname !== '/api/rss';
}

// ⚠️ THE MONEY ENDPOINTS GET NO CACHE IN EITHER DIRECTION: network or
// nothing. They would otherwise land in isLiveDataRequest's network-first
// bucket, which keeps a copy to serve when the network is down, and for these
// an offline answer is worse than no answer.
//
// /api/value resolves value blocks, and a stale one pays a split the show no
// longer publishes. /api/lnurl hands back a BOLT11 INVOICE, which is
// single-use and expires; a cached one offered again is the double-pay shape
// arriving through the cache instead of a button. /api/boostbox answers with
// the descriptor URL a podcaster's Helipad reads, so a previous response
// attaches the wrong message and amount to this leg. /api/keysend answers
// with the node pubkey an upgraded lnaddress leg is PAID TO, so a stale copy
// sends the sats to the wrong destination outright. (/api/sign-boost is POST
// and never reaches this handler.)
function isUncacheableMoneyRequest(url) {
  return url.pathname === '/api/value'
    || url.pathname.startsWith('/api/value/')
    || url.pathname === '/api/lnurl'
    || url.pathname === '/api/boostbox'
    || url.pathname === '/api/keysend';
}

// Network-first: fresh data normally, cached copy only when the network fails,
// which keeps the offline/flaky-link resilience the SW exists for. With no
// cached copy the fetch error propagates, so the page's own catch runs — for
// the boost wall that means falling back to the live relay path rather than
// rendering empty.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
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

  // Straight to the network, no cache in either direction.
  if (isUncacheableMoneyRequest(url)) return;

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

  if (isLiveDataRequest(url)) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
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
