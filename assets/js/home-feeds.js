/* Homepage "Community Feeds" module — a compact four-tab teaser (Events +
 * Marketplace + Podcast Boosts + Articles) that mirrors /feeds, sitting
 * between Leaderboards and Recent Boosts. Each tab is a horizontal
 * auto-scrolling strip of real content scoped to the show's supporter follow
 * packs; a card (or the "See all" link) clicks through to the full /feeds
 * page for the real thing.
 *
 * All data + supporter resolution is reused from the /feeds modules so there
 * is ONE source of truth:
 *   • feeds.js          → resolveSupporters(), fetchUpcomingEvents()
 *   • feeds-market.js   → loadMarketItems()
 *   • feeds-podcasts.js → loadPodcastItems()  (community-boosts snapshot)
 *   • feeds-articles.js → loadArticleItems()  (community-articles snapshot)
 *   • calendar-events   → renderCalendarCard() (the same event card /meetups
 *                         and the Events tab render)
 *   • merch.js          → price helpers (toSats / getBtcUsd / …)
 *
 * Speed: every strip is stale-while-revalidate cached in localStorage —
 * paint instantly from a recent snapshot, then refetch and repaint. Because
 * every card just clicks through to /feeds (which re-fetches fresh), the
 * staleness window is harmless; Events additionally re-filters to upcoming
 * at paint time. Marketplace / Podcasts / Articles data is prefetched on idle
 * so the first tab-open is instant even with a cold cache.
 *
 * Importing feeds.js runs its self-boot, but that bails immediately off the
 * homepage (no #panel-events), so it's inert here beyond the exports we use
 * — the same import-safe contract merch.js / feeds-market.js follow.
 */
import { resolveSupporters, fetchUpcomingEvents } from '/assets/js/feeds.js'
import { renderCalendarCard } from '/assets/js/calendar-events.js'
import { loadMarketItems } from '/assets/js/feeds-market.js'
import { loadPodcastItems } from '/assets/js/feeds-podcasts.js'
import { loadArticleItems } from '/assets/js/feeds-articles.js'
import { toSats, fmtSats, priceLabel } from '/assets/js/merch.js'

const EVENTS_MAX = 12
const MARKET_MAX = 12
const PODCASTS_MAX = 12
const ARTICLES_MAX = 12
const SPEED_PX_S = 42;          // a touch calmer than the boosts/merch marquees

// Stale-while-revalidate caches (teasers → fresh data is always one click
// away on /feeds, so short TTLs are plenty).
const EVENTS_CACHE = 'lb_home_events_v1'
const MARKET_CACHE = 'lb_home_market_v1'
const PODCASTS_CACHE = 'lb_home_podcasts_v1'
const ARTICLES_CACHE = 'lb_home_articles_v1'
const EVENTS_TTL = 12 * 60 * 60 * 1000   // 12h
const MARKET_TTL = 2 * 60 * 60 * 1000    // 2h
const PODCASTS_TTL = 2 * 60 * 60 * 1000  // 2h
const ARTICLES_TTL = 2 * 60 * 60 * 1000  // 2h

// ── Supporter set (shared by both tabs, resolved once) ───────────────
let supportersPromise = null
function getSupporters() {
  if (!supportersPromise) supportersPromise = resolveSupporters()
  return supportersPromise
}

// ── localStorage cache helpers ───────────────────────────────────────
function readCache(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.items) || !data.items.length) return null
    if (Date.now() - (data.ts || 0) > maxAgeMs) return null
    return data
  } catch { return null }
}
function writeCache(key, items, extra = {}) {
  try {
    if (!items || !items.length) return
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), items, ...extra }))
  } catch {}
}
// Keep only the profile fields the teaser renders (name + pfp), so the cache
// stays small and JSON-safe.
function slimProfile(p) {
  return p ? { name: p.name || '', picture: p.picture || '' } : null
}

function emptyState(container, msg) {
  const p = document.createElement('p')
  p.className = 'cf-empty'
  p.textContent = msg
  container.replaceChildren(p)
}

// ── Card builders ────────────────────────────────────────────────────
// Events: the real NIP-52 calendar card, read-only (no Renote/Zap bar), the
// whole item clicking through to the Events tab.
function makeEventItem(group, isDupe) {
  const item = document.createElement('div')
  item.className = 'cf-item cf-item--event' + (isDupe ? ' is-dupe' : '')
  if (isDupe) item.setAttribute('aria-hidden', 'true')
  item.appendChild(renderCalendarCard(group.parsed, {
    bech32: group.naddr,
    profile: group.profile,
    actions: false,
  }))
  item.__href = '/feeds#events'
  return item
}

// Marketplace: a simplified card (image + title + price + seller identity),
// matching the homepage Merch marquee's look via the shared .merch-card,
// clicking through to the Marketplace tab (where the full buy/contact flow
// lives).
function sellerLabel(item) {
  if (item.profile && item.profile.name) return item.profile.name
  return item.isHouse ? 'Local Bitcoiners' : 'Nostr seller'
}

// Seller identity chip: pfp (or an initial fallback) + display name of
// whoever published the listing.
function sellerRow(item) {
  const row = document.createElement('div')
  row.className = 'cf-item-seller'
  const pic = item.profile && item.profile.picture
  if (pic) {
    const img = document.createElement('img')
    img.className = 'cf-seller-pfp'
    img.src = pic
    img.alt = ''
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    // A broken pfp collapses back to the initial fallback.
    img.addEventListener('error', () => {
      const ph = document.createElement('span')
      ph.className = 'cf-seller-pfp cf-seller-pfp--none'
      ph.textContent = (sellerLabel(item)[0] || '?').toUpperCase()
      img.replaceWith(ph)
    }, { once: true })
    row.appendChild(img)
  } else {
    const ph = document.createElement('span')
    ph.className = 'cf-seller-pfp cf-seller-pfp--none'
    ph.textContent = (sellerLabel(item)[0] || '?').toUpperCase()
    row.appendChild(ph)
  }
  const name = document.createElement('span')
  name.className = 'cf-seller-name'
  name.textContent = sellerLabel(item)
  row.appendChild(name)
  return row
}

function priceText(product, rate) {
  if (!Number.isFinite(product.priceAmount)) {
    return (product.priceRaw || '').trim() || 'Price on request'
  }
  const c = String(product.priceCurrency || 'USD').toUpperCase()
  if (c === 'SAT' || c === 'SATS' || c === 'BTC') {
    const sats = toSats(product.priceAmount, product.priceCurrency, null)
    return sats != null ? fmtSats(sats) : priceLabel(product.priceAmount, product.priceCurrency)
  }
  const sats = rate ? toSats(product.priceAmount, product.priceCurrency, rate) : null
  return sats != null ? fmtSats(sats) : priceLabel(product.priceAmount, product.priceCurrency)
}

function makeMarketItem(entry, isDupe) {
  const { item, rate } = entry
  const p = item.product
  const wrap = document.createElement('div')
  wrap.className = 'cf-item cf-item--market' + (isDupe ? ' is-dupe' : '')
  if (isDupe) wrap.setAttribute('aria-hidden', 'true')

  const media = document.createElement('div')
  media.className = 'merch-card-media'
  if (p.images.length) {
    const img = document.createElement('img')
    img.src = p.images[0]
    img.alt = p.title
    img.loading = 'lazy'
    media.appendChild(img)
  } else {
    const noimg = document.createElement('div')
    noimg.className = 'merch-card-noimg'
    noimg.textContent = '🛍️'
    media.appendChild(noimg)
  }

  const title = document.createElement('h3')
  title.className = 'merch-card-title'
  title.textContent = p.title

  const price = document.createElement('div')
  price.className = 'merch-card-sub'
  price.textContent = priceText(p, rate)

  const body = document.createElement('div')
  body.className = 'merch-card-body'
  body.append(title, price, sellerRow(item))

  const card = document.createElement('div')
  card.className = 'merch-card'
  card.append(media, body)

  wrap.appendChild(card)
  wrap.__href = '/feeds#market'
  return wrap
}

// Identity chip (pfp-or-initial + name), same markup/classes as the
// Marketplace seller chip — reused for the Articles author line.
function identityRow(profile, fallback) {
  const label = (profile && profile.name) || fallback || 'Nostr author'
  const row = document.createElement('div')
  row.className = 'cf-item-seller'
  const pic = profile && profile.picture
  if (pic) {
    const img = document.createElement('img')
    img.className = 'cf-seller-pfp'
    img.src = pic; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'
    img.addEventListener('error', () => {
      const ph = document.createElement('span')
      ph.className = 'cf-seller-pfp cf-seller-pfp--none'
      ph.textContent = (label[0] || '?').toUpperCase()
      img.replaceWith(ph)
    }, { once: true })
    row.appendChild(img)
  } else {
    const ph = document.createElement('span')
    ph.className = 'cf-seller-pfp cf-seller-pfp--none'
    ph.textContent = (label[0] || '?').toUpperCase()
    row.appendChild(ph)
  }
  const name = document.createElement('span')
  name.className = 'cf-seller-name'
  name.textContent = label
  row.appendChild(name)
  return row
}

function fmtDate(unixSec) {
  if (!unixSec) return ''
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

// Podcast Boosts: a simplified card (episode art + title + show + a boost
// tally), reusing the shared .merch-card look, clicking through to the
// Podcast Boosts tab. Every field comes straight from the community-boosts
// snapshot — no profile lookup needed for the teaser.
function makePodcastItem(item, isDupe) {
  const wrap = document.createElement('div')
  wrap.className = 'cf-item cf-item--podcast' + (isDupe ? ' is-dupe' : '')
  if (isDupe) wrap.setAttribute('aria-hidden', 'true')

  const media = document.createElement('div')
  media.className = 'merch-card-media'
  if (item.image) {
    const img = document.createElement('img')
    img.src = item.image; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'
    media.appendChild(img)
  } else {
    const noimg = document.createElement('div')
    noimg.className = 'merch-card-noimg'
    noimg.textContent = '🎙️'
    media.appendChild(noimg)
  }

  const title = document.createElement('h3')
  title.className = 'merch-card-title'
  title.textContent = item.title

  const show = document.createElement('div')
  show.className = 'merch-card-sub'
  show.textContent = item.show || ''

  const meta = document.createElement('div')
  meta.className = 'cf-item-meta'
  const n = item.boosters
  meta.textContent = `⚡ ${fmtSats(item.sats)} · ${n} booster${n === 1 ? '' : 's'}`

  const body = document.createElement('div')
  body.className = 'merch-card-body'
  body.append(title, show, meta)

  const card = document.createElement('div')
  card.className = 'merch-card'
  card.append(media, body)

  wrap.appendChild(card)
  wrap.__href = '/feeds#podcasts'
  return wrap
}

// Articles: a simplified card (cover + title + date + author identity),
// reusing the shared .merch-card look + the seller-chip styles, clicking
// through to the Articles tab.
function makeArticleItem(item, isDupe) {
  const wrap = document.createElement('div')
  wrap.className = 'cf-item cf-item--article' + (isDupe ? ' is-dupe' : '')
  if (isDupe) wrap.setAttribute('aria-hidden', 'true')

  const media = document.createElement('div')
  media.className = 'merch-card-media'
  if (item.image) {
    const img = document.createElement('img')
    img.src = item.image; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'
    media.appendChild(img)
  } else {
    const noimg = document.createElement('div')
    noimg.className = 'merch-card-noimg'
    noimg.textContent = '📄'
    media.appendChild(noimg)
  }

  const title = document.createElement('h3')
  title.className = 'merch-card-title'
  title.textContent = item.title

  const date = document.createElement('div')
  date.className = 'merch-card-sub'
  date.textContent = item.date || ''

  const body = document.createElement('div')
  body.className = 'merch-card-body'
  body.append(title, date, identityRow(item.author))

  const card = document.createElement('div')
  card.className = 'merch-card'
  card.append(media, body)

  wrap.appendChild(card)
  wrap.__href = '/feeds#articles'
  return wrap
}

// ── Strip fill (probe → two sets so ONE set overflows the strip) ─────
// Mirrors home-merch's measure: with only a few cards a single copy can be
// narrower than the strip, leaving nothing to scroll. Repeat the set until
// it overflows, then lay two identical sets (A + dupe B) so wrapping
// scrollLeft by one set width loops seamlessly.
function fillStrip(container, data, makeFn) {
  const probe = document.createDocumentFragment()
  for (const d of data) probe.appendChild(makeFn(d, false))
  container.replaceChildren(probe)
  const oneCopyW = container.scrollWidth
  const viewW = container.clientWidth || 1
  const reps = Math.max(1, Math.ceil((viewW + 1) / Math.max(oneCopyW, 1)))

  const frag = document.createDocumentFragment()
  for (let set = 0; set < 2; set++)
    for (let r = 0; r < reps; r++)
      for (const d of data) frag.appendChild(makeFn(d, set === 1))
  container.replaceChildren(frag)
}

// Paint a strip's content, starting the marquee engine the FIRST time only.
// A stale-while-revalidate repaint (cache → fresh) just refills + re-measures
// so we never stack a second marquee loop / listener set on the container.
function paintStrip(container, data, makeFn, dir) {
  fillStrip(container, data, makeFn)
  if (!container.__marqueeStarted) {
    container.__marqueeStarted = true
    requestAnimationFrame(() => startMarquee(container, dir))
  } else {
    requestAnimationFrame(() => container.__measure && container.__measure())
  }
}

// ── Marquee engine ───────────────────────────────────────────────────
// Same drag/auto-scroll engine as home-merch/home-boosts, generalized: a
// genuine (non-drag) click on an item navigates to its __href. Leftward or
// rightward per `dir` (-1/+1); normalize-then-assign so leftward never
// clamps at the left edge. Stashes measure() on the element so a later
// refill can re-measure without restarting the loop.
function startMarquee(el, dir) {
  const reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let setWidth = 0
  const measure = () => { setWidth = el.scrollWidth / 2 }
  el.__measure = measure
  measure()
  el.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', measure, { once: true })
  })
  window.addEventListener('resize', measure)
  window.addEventListener('load', measure, { once: true })

  const norm = (x) => {
    if (setWidth <= 0) return x < 0 ? 0 : x
    x %= setWidth
    return x < 0 ? x + setWidth : x
  }

  let hovering = false, focused = false, dragging = false, dragMoved = false
  let idle = true, idleTimer = null
  const markActive = () => {
    idle = false
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idle = true }, 1800)
  }

  el.addEventListener('mouseenter', () => { hovering = true })
  el.addEventListener('mouseleave', () => { hovering = false })
  el.addEventListener('focusin', () => { focused = true })
  el.addEventListener('focusout', () => { focused = false })
  el.addEventListener('wheel', markActive, { passive: true })
  el.addEventListener('touchstart', markActive, { passive: true })
  el.addEventListener('touchmove', markActive, { passive: true })

  let startX = 0, lastX = 0, armed = false, dragPointerId = null
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return
    if (e.target.closest('a, button')) return
    armed = true; dragging = false; dragMoved = false
    startX = e.clientX; lastX = e.clientX; dragPointerId = e.pointerId
  })
  el.addEventListener('pointermove', (e) => {
    if (!armed) return
    if (!dragging && Math.abs(e.clientX - startX) > 3) {
      dragging = true; dragMoved = true
      try { el.setPointerCapture(dragPointerId) } catch (err) {}
      el.classList.add('is-grabbing')
    }
    if (dragging) el.scrollLeft = norm(el.scrollLeft - (e.clientX - lastX))
    lastX = e.clientX
  })
  const endDrag = (e) => {
    armed = false
    if (!dragging) return
    dragging = false
    el.classList.remove('is-grabbing')
    try { el.releasePointerCapture(e.pointerId) } catch (err) {}
  }
  el.addEventListener('pointerup', endDrag)
  el.addEventListener('pointercancel', endDrag)
  // Swallow the click that ends a real drag so it doesn't navigate.
  el.addEventListener('click', (e) => {
    if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false }
  }, true)

  // A genuine click (no drag) on a card follows it through to /feeds. Let
  // real links/buttons inside a card behave normally.
  el.addEventListener('click', (e) => {
    if (dragMoved) return
    if (e.target.closest('a, button')) return
    const item = e.target.closest('.cf-item')
    if (item && item.__href) window.location.href = item.__href
  })

  if (reduce) return // manual scroll only; no auto motion

  const SPEED = SPEED_PX_S * (dir < 0 ? -1 : 1)
  let last = performance.now()
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!(hovering || focused || dragging || !idle)) {
      el.scrollLeft = norm(el.scrollLeft + SPEED * dt)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── Data fetchers (memoized so prefetch + tab-open share one network hit) ──
let marketDataPromise = null
function fetchMarketData() {
  if (!marketDataPromise) {
    marketDataPromise = (async () => {
      const supporters = await getSupporters()
      return loadMarketItems(supporters)   // { items, rate }
    })().catch((e) => { marketDataPromise = null; throw e })  // don't cache a transient failure
  }
  return marketDataPromise
}

// Warm the Marketplace cache in the background (no rendering — the panel is
// hidden and can't be measured) so the first tab-open is instant.
async function prefetchMarket() {
  try {
    const { items, rate } = await fetchMarketData()
    const slim = items.slice(0, MARKET_MAX).map((it) => ({
      product: it.product, profile: slimProfile(it.profile), isHouse: it.isHouse,
    }))
    writeCache(MARKET_CACHE, slim, { rate: rate ?? null })
  } catch (e) {
    console.warn('[home-feeds] market prefetch failed', e)
  }
}

// Slim shapes kept in the SWR cache (JSON-safe, only the fields the teaser
// card renders) — the snapshot's full item is heavier than the card needs.
function slimPodcast(it) {
  return {
    image: (it.ep && it.ep.image) || '',
    title: (it.ep && it.ep.title) || 'Untitled episode',
    show: (it.show && it.show.title) || '',
    sats: it.totalSats || 0,
    boosters: (it.distinctBoosters && it.distinctBoosters.length) || 0,
  }
}
function slimArticle(a) {
  return {
    image: a.image || '',
    title: a.title || 'Untitled',
    date: fmtDate(a.date),
    author: slimProfile(a.author),
  }
}

let podcastDataPromise = null
function fetchPodcastData() {
  if (!podcastDataPromise) {
    podcastDataPromise = loadPodcastItems()
      .catch((e) => { podcastDataPromise = null; throw e })  // don't cache a transient failure
  }
  return podcastDataPromise
}
async function prefetchPodcasts() {
  try {
    const items = await fetchPodcastData()
    writeCache(PODCASTS_CACHE, items.slice(0, PODCASTS_MAX).map(slimPodcast))
  } catch (e) {
    console.warn('[home-feeds] podcasts prefetch failed', e)
  }
}

let articleDataPromise = null
function fetchArticleData() {
  if (!articleDataPromise) {
    articleDataPromise = loadArticleItems({ limit: ARTICLES_MAX })
      .catch((e) => { articleDataPromise = null; throw e })  // don't cache a transient failure
  }
  return articleDataPromise
}
async function prefetchArticles() {
  try {
    const items = await fetchArticleData()
    writeCache(ARTICLES_CACHE, items.slice(0, ARTICLES_MAX).map(slimArticle))
  } catch (e) {
    console.warn('[home-feeds] articles prefetch failed', e)
  }
}

// ── Per-tab strip renderers (only run when the panel is visible) ─────
async function renderEventsStrip(container) {
  // 1. Instant paint from cache (re-filtered to still-upcoming).
  const cached = readCache(EVENTS_CACHE, EVENTS_TTL)
  const paintedFromCache = (() => {
    if (!cached) return false
    const now = Date.now()
    const groups = cached.items.filter((g) => g.endMs >= now)
    if (!groups.length) return false
    paintStrip(container, groups, makeEventItem, +1)
    return true
  })()

  // 2. Revalidate.
  let supporters
  try {
    supporters = await getSupporters()
  } catch (e) {
    console.warn('[home-feeds] supporter resolve failed', e)
    if (!paintedFromCache) emptyState(container, 'Couldn’t load community events — see them all on /feeds.')
    return
  }
  let groups = []
  try {
    groups = await fetchUpcomingEvents(supporters, { limit: EVENTS_MAX })
  } catch (e) {
    console.warn('[home-feeds] events fetch failed', e)
  }
  if (!groups.length) {
    if (!paintedFromCache) emptyState(container, 'No upcoming community events right now — check back soon.')
    return
  }
  const slim = groups.map((g) => ({
    parsed: g.parsed, naddr: g.naddr, profile: slimProfile(g.profile),
    startMs: g.startMs, endMs: g.endMs,
  }))
  writeCache(EVENTS_CACHE, slim)
  paintStrip(container, slim, makeEventItem, +1)
}

async function renderMarketStrip(container) {
  // 1. Instant paint from cache (possibly warmed by the idle prefetch).
  const cached = readCache(MARKET_CACHE, MARKET_TTL)
  let paintedFromCache = false
  if (cached) {
    const entries = cached.items.map((item) => ({ item, rate: cached.rate }))
    paintStrip(container, entries, makeMarketItem, -1)
    paintedFromCache = true
  }

  // 2. Revalidate.
  let data
  try {
    data = await fetchMarketData()
  } catch (e) {
    console.warn('[home-feeds] market fetch failed', e)
    if (!paintedFromCache) emptyState(container, 'Couldn’t load community listings — see them all on /feeds.')
    return
  }
  const items = (data.items || []).slice(0, MARKET_MAX)
  if (!items.length) {
    if (!paintedFromCache) emptyState(container, 'No community listings right now — check back soon.')
    return
  }
  const slim = items.map((it) => ({
    product: it.product, profile: slimProfile(it.profile), isHouse: it.isHouse,
  }))
  writeCache(MARKET_CACHE, slim, { rate: data.rate ?? null })
  const entries = slim.map((item) => ({ item, rate: data.rate }))
  // Scroll the OPPOSITE direction to Events, echoing boosts↔merch below.
  paintStrip(container, entries, makeMarketItem, -1)
}

async function renderPodcastsStrip(container) {
  // 1. Instant paint from cache (possibly warmed by the idle prefetch).
  const cached = readCache(PODCASTS_CACHE, PODCASTS_TTL)
  let paintedFromCache = false
  if (cached) {
    paintStrip(container, cached.items, makePodcastItem, +1)
    paintedFromCache = true
  }

  // 2. Revalidate.
  let items
  try {
    items = await fetchPodcastData()
  } catch (e) {
    console.warn('[home-feeds] podcasts fetch failed', e)
    if (!paintedFromCache) emptyState(container, 'Couldn’t load podcast boosts — see them all on /feeds.')
    return
  }
  const slim = items.slice(0, PODCASTS_MAX).map(slimPodcast)
  if (!slim.length) {
    if (!paintedFromCache) emptyState(container, 'No boosted episodes yet — check back soon.')
    return
  }
  writeCache(PODCASTS_CACHE, slim)
  paintStrip(container, slim, makePodcastItem, +1)
}

async function renderArticlesStrip(container) {
  // 1. Instant paint from cache (possibly warmed by the idle prefetch).
  const cached = readCache(ARTICLES_CACHE, ARTICLES_TTL)
  let paintedFromCache = false
  if (cached) {
    paintStrip(container, cached.items, makeArticleItem, -1)
    paintedFromCache = true
  }

  // 2. Revalidate.
  let items
  try {
    items = await fetchArticleData()
  } catch (e) {
    console.warn('[home-feeds] articles fetch failed', e)
    if (!paintedFromCache) emptyState(container, 'Couldn’t load community articles — see them all on /feeds.')
    return
  }
  const slim = items.slice(0, ARTICLES_MAX).map(slimArticle)
  if (!slim.length) {
    if (!paintedFromCache) emptyState(container, 'No community articles right now — check back soon.')
    return
  }
  writeCache(ARTICLES_CACHE, slim)
  // Scroll the OPPOSITE direction to Podcasts, echoing the events↔market pair.
  paintStrip(container, slim, makeArticleItem, -1)
}

// ── Tab controller ───────────────────────────────────────────────────
function init() {
  const section = document.getElementById('community-feeds')
  if (!section) return
  const tabs = Array.from(section.querySelectorAll('[data-cf-tab]'))
  const seeAll = section.querySelector('[data-cf-seeall]')

  const LOADERS = {
    events: () => renderEventsStrip(section.querySelector('[data-cf-strip="events"]')),
    market: () => renderMarketStrip(section.querySelector('[data-cf-strip="market"]')),
    podcasts: () => renderPodcastsStrip(section.querySelector('[data-cf-strip="podcasts"]')),
    articles: () => renderArticlesStrip(section.querySelector('[data-cf-strip="articles"]')),
  }
  // Per-tab "See all" label + deep link into the matching /feeds tab.
  const SEE_ALL = {
    events: 'See all Community Events →',
    market: 'See all Community Listings →',
    podcasts: 'See all Podcast Boosts →',
    articles: 'See all Community Articles →',
  }
  const loaded = new Set()
  function load(feed) {
    if (loaded.has(feed) || !LOADERS[feed]) return
    loaded.add(feed)
    LOADERS[feed]()
  }

  function activate(feed) {
    tabs.forEach((tab) => {
      const on = tab.dataset.cfTab === feed
      tab.classList.toggle('is-active', on)
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    section.querySelectorAll('[data-cf-panel]').forEach((panel) => {
      const on = panel.dataset.cfPanel === feed
      panel.classList.toggle('is-active', on)
      panel.hidden = !on
    })
    if (seeAll) {
      seeAll.setAttribute('href', '/feeds#' + feed)
      if (SEE_ALL[feed]) seeAll.textContent = SEE_ALL[feed]
    }
    load(feed)
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activate(tab.dataset.cfTab))
  })

  // Events is the default tab — resolve supporters + load it right away so
  // the strip is usually populated by the time the section scrolls into view.
  activate('events')

  // Warm the other tabs' data in the background so their first tab-open is
  // instant, without competing with the Events paint. Staggered so three
  // snapshot fetches don't fire in one idle slice.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200))
  idle(() => prefetchMarket())
  idle(() => prefetchPodcasts())
  idle(() => prefetchArticles())
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
