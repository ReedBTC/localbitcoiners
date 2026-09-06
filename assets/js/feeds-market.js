/* Community marketplace feed — the Marketplace tab on /feeds.
 *
 * Surfaces NIP-99 (kind 30402) listings from the show's supporter follow
 * packs PLUS the Local Bitcoiners house merchant, in two labelled sections:
 *
 *   • "Show Merch" — the house store (MERCHANT_HEX), in its own bordered box.
 *     This is the whole of the retired /merch page: that page was folded in
 *     here (lb-v48) once the cart, checkout and product modal it owned were
 *     already shared with this tab. Sorted newest-first rather than
 *     Buy-Now-first, since every house listing is Buy Now by definition.
 *     Renders the sold-out notice when empty so an empty catalog still reads
 *     as "store, restocking" and not "no store".
 *
 *   • "Community Marketplace" — everything else, badged as below. Its header
 *     carries the /supporters link and the "Manage / List Items" button.
 *
 *   • "Buy Now"  — the listing is Gamma checkout-ready (structured shipping
 *     that resolves) AND the seller is payable over Lightning (their kind-0
 *     lud16, or — for the house store — the hardcoded merch address). These
 *     reuse the exact multi-merchant cart + checkout merch.js provides.
 *
 *   • "Classified" — everything else. We show what's missing to be
 *     checkout-ready (straight from the shared Gamma grader) and offer a
 *     "Contact Seller" NIP-17 DM instead of on-site payment.
 *
 * Grading uses assets/js/gamma-compliance.js — a verbatim port of MyNostr's
 * grader, so "checkout-ready" here means exactly what it means there. The
 * cart, checkout, catalog and gift-wrap send are all reused from merch.js,
 * which is now a pure module (no page of its own) that this tab drives.
 *
 * Entry point: renderMarket({ panel, list, relays, members }) — feeds.js
 * resolves the supporter set + relays and hands them in, then lazy-imports
 * this module the first time the Marketplace tab is opened.
 */
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'
import { STATIC_RELAYS, fetchProfilesFromPrimal } from '/assets/js/boosts-thread.js'
import { gradeListing } from '/assets/js/gamma-compliance.js'
import { ready as obReady, hasBoosterPage, boosterUrl } from '/assets/js/onlyboosts.js'
import {
  listingCoord,
  isListingCoord,
  fetchFeaturedListingSet,
  fetchListingsFromRelays,
  fetchListingByNaddr,
  naddrFromText,
  readConfirmedFeaturedListings,
  addConfirmedFeaturedListing,
  readPendingPromote,
  clearPendingPromote,
  featureListing,
} from '/assets/js/featured-market.js'
import {
  FEATURED_DEFAULT_RANGE,
  inFeaturedRange,
  isFeatureLive,
  featuredHead,
  featuredEmptyEl,
  featuredMoreButton,
  featuredByEl,
  currentBooster,
  FEATURE_BOLT_SVG,
} from '/assets/js/featured-shared.js'
import {
  MERCHANT_HEX,
  catalog,
  ingestListings,
  addToCart,
  openCart,
  openProductModal,
  imageCarousel,
  closeModal,
  paymentLud16ForMerchant,
  giftWrapAndPublish,
  resolveDMRelays,
  toSats,
  getBtcUsd,
  fmtSats,
  priceLabel,
} from '/assets/js/merch.js'

const MARKET_KINDS = [30402, 30405, 30406]
const KIND_DELETION = 5
const AUTHOR_CHUNK = 50
// Profile-heavy relay added to the query so kind-0s propagate widely.
// Unioned into the caller's relays for kind-0 lookups, so it matters most when
// a caller passes its own set. purplepag.es held this slot as the dedicated
// profile aggregator; measured over 92 booster pubkeys on 2026-08-12 it
// answered 41% of them and added ZERO once nos.lol and ditto were present,
// while nos.lol alone answered 92%. Don't restore an aggregator here on the
// reasoning that aggregating is its job — re-measure instead.
const PROFILE_RELAY = 'wss://nos.lol'

// Hourly marketplace snapshot (Cloudflare Pages Function proxying the file
// bots/community-feeds pushes to the VPS). Same raw signed NIP-99 listings a
// live query would return — supporters + the house store, deletions/replaced
// versions already resolved server-side — as one cached GET. See feeds.js for
// the fuller rationale; the live fetchMarketEvents path is the fallback.
const MARKET_SNAPSHOT_URL = '/api/community-market'

// Fetch the marketplace snapshot: raw signed events, verified here (untrusted
// transport) and deduped by id. Throws if unreachable / malformed so
// loadMarketItems can fall back to a live relay query.
async function fetchMarketSnapshot() {
  const res = await fetch(MARKET_SNAPSHOT_URL, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`community-market ${res.status}`)
  const data = await res.json()
  const events = Array.isArray(data?.events) ? data.events : null
  if (!events) throw new Error('community-market: unexpected shape')
  const byId = new Map()
  for (const ev of events) {
    if (!ev || byId.has(ev.id) || !verifyEvent(ev)) continue
    byId.set(ev.id, ev)
  }
  return [...byId.values()]
}

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' }
  catch { return false }
}

// Set once per load (in renderMarket) so the naddr we build for the ⋮ menu
// carries a couple of relay hints for other clients to resolve it.
let feedRelays = []

// ── Tiny DOM helper (same contract as merch.js's h) ──────────────────
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v)
  }
  for (const c of [].concat(children)) {
    if (c == null) continue
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return el
}

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

function showSkeletons(list, n = 4) {
  list.className = 'feed-list'
  list.innerHTML = ''
  for (let i = 0; i < n; i++) list.appendChild(h('div', { class: 'feed-skeleton' }))
}

function renderPlaceholder(list, title, body) {
  list.className = ''
  list.innerHTML = ''
  list.appendChild(placeholder(title, body))
}

// The placeholder box on its own, for callers appending it to a section rather
// than replacing the whole list.
function placeholder(title, body) {
  return h('div', { class: 'feed-placeholder' }, [
    h('strong', { text: title }),
    document.createTextNode(body),
  ])
}

// A non-collapsible section label, mirroring the one the Events tab builds
// (sectionHead in feeds.js). Rebuilt here rather than imported: feeds.js
// lazy-imports this module, so importing it back would be a static cycle.
// `label` is anything h() accepts as children, so a heading can carry a link.
function sectionHead(label, className) {
  return h('div', { class: 'feed-section-head' + (className ? ' ' + className : '') }, [
    h('span', { class: 'feed-section-label' }, label),
  ])
}

// Shown in place of the Show Merch grid when the house catalog is empty.
// Same copy as the homepage merch marquee (home-merch.js).
const SOLD_OUT_MSG = 'Sold Out — Restocking Inventory'

// ── Fetch every marketplace event authored by the supporter set ──────
// Per-relay + merge (like merch.js's fetchCatalog) so a thinly-replicated
// listing on one slow relay isn't gated out by a pooled subscription.
// Authors are chunked because some relays cap the `authors` array.
async function fetchMarketEvents(authors, relays) {
  const byId = new Map()
  const pool = new SimplePool()
  try {
    await Promise.allSettled(
      relays.flatMap((relay) =>
        chunk(authors, AUTHOR_CHUNK).map(async (authorChunk) => {
          let evs = []
          try {
            // Include kind 5 (NIP-09) so we can drop listings the seller
            // deleted — many relays keep serving the 30402 after a deletion.
            evs = await pool.querySync([relay], { authors: authorChunk, kinds: [...MARKET_KINDS, KIND_DELETION] }, { maxWait: 4500 })
          } catch { evs = [] }
          for (const ev of evs) {
            if (!ev || byId.has(ev.id) || !verifyEvent(ev)) continue
            byId.set(ev.id, ev)
          }
        })
      )
    )
  } finally {
    try { pool.close(relays) } catch {}
  }
  return [...byId.values()]
}

// Fetch every seller's kind-0 profile in ONE pooled query (name / picture /
// lud16). This replaced a per-merchant resolveMerchantProfile fan-out that
// opened a separate relay pool per seller — under that load individual
// pool.get calls timed out and the null result got cached, so payable sellers
// (e.g. anyone whose lud16 lives on a slower relay) wrongly showed up as
// "no Lightning address". Here we keep the NEWEST kind-0 per author (pool.get
// returned whichever arrived first, which could be stale). Returns
// Map<hex, { name, picture, lud16 }>.
async function fetchMerchantProfiles(merchants, relays) {
  const out = new Map()
  if (!merchants.length) return out
  const queryRelays = [...new Set([...relays, PROFILE_RELAY])]
  const newest = new Map()   // hex → newest kind-0 event
  const pool = new SimplePool()
  try {
    await Promise.allSettled(
      chunk(merchants, AUTHOR_CHUNK).map(async (authorChunk) => {
        let evs = []
        try {
          evs = await pool.querySync(queryRelays, { kinds: [0], authors: authorChunk }, { maxWait: 4500 })
        } catch { evs = [] }
        for (const ev of evs) {
          if (!ev || ev.kind !== 0 || !verifyEvent(ev)) continue
          const prev = newest.get(ev.pubkey)
          if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) newest.set(ev.pubkey, ev)
        }
      })
    )
  } finally {
    try { pool.close(queryRelays) } catch {}
  }
  const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null
  for (const [hex, ev] of newest) {
    let meta = {}
    try { meta = JSON.parse(ev.content || '{}') } catch { meta = {} }
    out.set(hex, {
      name: str(meta.display_name) || str(meta.displayName) || str(meta.name),
      picture: isHttpUrl(meta.picture) ? meta.picture : null,
      lud16: str(meta.lud16),   // LUD-16 address only (lud06 lnurl isn't checkout-compatible)
    })
  }
  return out
}

// ── NIP-09 deletions ─────────────────────────────────────────────────
// Same approach the Events tab uses: collect deleted event ids (`e` tags) and
// deleted addressable coordinates (`a` tags, keyed to the deletion's
// created_at so a later re-publish of the same coord isn't wrongly hidden). A
// coordinate deletion is only honoured for a coord the deleter owns.
function collectDeletions(events) {
  const deletedIds = new Set()
  const deletedCoords = new Map()   // coord → newest deletion created_at
  for (const ev of events) {
    if (!ev || ev.kind !== KIND_DELETION) continue
    const at = ev.created_at || 0
    for (const t of ev.tags || []) {
      if (!Array.isArray(t)) continue
      if (t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || '')) {
        deletedIds.add(t[1].toLowerCase())
      } else if (t[0] === 'a' && typeof t[1] === 'string') {
        const coordPubkey = (t[1].split(':')[1] || '').toLowerCase()
        if (coordPubkey !== ev.pubkey.toLowerCase()) continue
        const prev = deletedCoords.get(t[1])
        if (prev == null || at > prev) deletedCoords.set(t[1], at)
      }
    }
  }
  return { deletedIds, deletedCoords }
}

// Is this listing event superseded by a deletion? By exact event id, or by a
// coordinate deletion dated at/after the event (an older version being removed
// doesn't kill a newer re-publish).
function isDeleted(ev, deletedIds, deletedCoords) {
  if (deletedIds.has((ev.id || '').toLowerCase())) return true
  const d = (ev.tags.find((t) => t[0] === 'd') || [])[1]
  if (!d) return false
  const delAt = deletedCoords.get(`${ev.kind}:${ev.pubkey}:${d}`)
  return delAt != null && delAt >= (ev.created_at || 0)
}

// ── Grading adapter ──────────────────────────────────────────────────
// The grader (ported from mynostr) expects its own product shape; map our
// merch.js parse onto it. It only reads `content` + `shippingOptionRefs[].ref`
// for the listing, and `dTag`/`pubkey` for the seller's shipping options.
function gradeMerchListing(product) {
  const sellerShipping = [...catalog.shipping.values()]
    .filter((s) => s.merchant === product.merchant)
    .map((s) => ({ dTag: s.d, pubkey: s.merchant }))
  return gradeListing(
    {
      content: product.description,
      shippingOptionRefs: product.shippingRefs.map((r) => ({ ref: r.coord })),
    },
    sellerShipping,
  )
}

// Build the classified item model for one product: is it Buy-Now-able, and
// if not, what's the headline reason?
function classify(product, profile) {
  const isHouse = product.merchant === MERCHANT_HEX
  const payLud16 = paymentLud16ForMerchant(product.merchant, profile)
  const grade = gradeMerchListing(product)
  // House store is always Buy Now (its checkout is the proven path, and it may
  // use collection-scoped shipping the strict grader flags). Other sellers must
  // be graded checkout-ready AND payable over Lightning.
  const buyNow = !!payLud16 && (isHouse || grade.ready)

  let reason = ''
  if (!buyNow) {
    if (!payLud16) reason = 'Seller has no Lightning address set'
    else reason = (grade.gaps[0] && grade.gaps[0].label) || 'Not checkout-ready'
  }
  return { product, profile, isHouse, payLud16, grade, buyNow, reason }
}

// ── Card rendering ───────────────────────────────────────────────────
function sellerName(item) {
  if (item.profile && item.profile.name) return item.profile.name
  return item.isHouse ? 'Local Bitcoiners' : 'Nostr seller'
}

// Seller identity chip: pfp + display name of whoever published the listing.
// Fresh nodes each call so it can appear on both the card and the modal.
function sellerRow(item) {
  const pic = item.profile && item.profile.picture
  const avatar = pic
    ? h('img', { class: 'market-seller-pfp', src: pic, alt: '', loading: 'lazy' })
    : h('div', { class: 'market-seller-pfp market-seller-pfp--none', text: (sellerName(item)[0] || '?').toUpperCase() })
  return h('div', { class: 'market-seller' }, [avatar, h('span', { class: 'market-seller-name', text: sellerName(item) })])
}

function priceEl(product, rate) {
  // Some sellers put free text in the price amount ("Best offer", or — on
  // westernmassbitcoin — "30,000 - sold!"). Number() → NaN there, so render the
  // raw string verbatim (mirrors that site's own getPrice) instead of "NaN
  // sats", and skip the fiat→sats hint since there's nothing to convert.
  if (!Number.isFinite(product.priceAmount)) {
    const raw = (product.priceRaw || '').trim() || 'Price on request'
    const c = String(product.priceCurrency || '').toUpperCase()
    const label = (c && c !== 'USD' && !/trade/i.test(c)) ? `${raw} ${product.priceCurrency}` : raw
    return h('div', { class: 'market-card-price', text: label })
  }
  const el = h('div', { class: 'market-card-price', text: priceLabel(product.priceAmount, product.priceCurrency) })
  const c = String(product.priceCurrency || 'USD').toUpperCase()
  if (c !== 'SAT' && c !== 'SATS' && c !== 'BTC' && rate) {
    const sats = toSats(product.priceAmount, product.priceCurrency, rate)
    if (Number.isFinite(sats)) el.appendChild(h('span', { class: 'market-card-sats', text: `  ·  ${fmtSats(sats)}` }))
  }
  return el
}

// The card's primary action, reused on the card and (for classifieds) in the
// detail modal. Buy-Now → add to cart; classified → open the DM composer.
function actionButton(item, onContact, { stop = false } = {}) {
  if (item.buyNow) {
    return h('button', {
      class: 'market-btn market-btn--buy', type: 'button',
      onclick: (e) => { if (stop) e.stopPropagation(); addToCart(item.product.coord, 1); openCart() },
    }, 'Add to cart')
  }
  return h('button', {
    class: 'market-btn market-btn--contact', type: 'button',
    onclick: (e) => { if (stop) e.stopPropagation(); onContact(item) },
  }, 'Contact seller')
}

// NIP-19 naddr for a listing (kind 30402), with a couple of relay hints.
function naddrForProduct(p) {
  try {
    return nip19.naddrEncode({ identifier: p.d, pubkey: p.merchant, kind: 30402, relays: feedRelays.slice(0, 2) })
  } catch { return '' }
}

// ⋮ menu pinned to the modal's top-right: copy the listing's naddr, plus
// deep-links to view it on other NIP-99 marketplaces (URL templates taken from
// each platform's own NIP-89 handler). Closes on outside click / Esc.
function shareMenu(product) {
  const naddr = naddrForProduct(product)
  const btn = h('button', { class: 'market-menu-btn', type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'true' }, '⋮')
  const menu = h('div', { class: 'market-menu', role: 'menu' })
  const wrap = h('div', { class: 'market-menu-wrap' }, [btn, menu])

  const close = () => wrap.classList.remove('open')
  const onDocClick = () => close()
  const onEsc = (e) => { if (e.key === 'Escape') close() }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const opening = !wrap.classList.contains('open')
    wrap.classList.toggle('open', opening)
    if (opening) { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onEsc) }
    else { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onEsc) }
  })
  menu.addEventListener('click', (e) => e.stopPropagation())

  const copy = h('button', { class: 'market-menu-item', type: 'button', role: 'menuitem' }, 'Copy address (naddr)')
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(naddr); copy.textContent = 'Copied ✓' }
    catch { copy.textContent = 'Copy failed' }
    setTimeout(() => { copy.textContent = 'Copy address (naddr)'; close() }, 1200)
  })
  menu.appendChild(copy)
  menu.appendChild(h('div', { class: 'market-menu-label' }, 'View on'))
  // Shopstr + Conduit resolve an naddr; Plebeian routes by raw event id
  // (/products/<id>), so it's only offered when we have this version's id.
  const links = [
    ['Shopstr', `https://shopstr.store/listing/${naddr}`],
    ['Conduit', `https://shop.conduit.market/products/${naddr}`],
  ]
  if (product.id) links.push(['Plebeian', `https://plebeian.market/products/${product.id}`])
  for (const [name, url] of links) {
    menu.appendChild(h('a', { class: 'market-menu-item', href: url, target: '_blank', rel: 'noopener' }, name))
  }
  return wrap
}

// Full listing view — reuses the shared merch.js product modal (carousel + thumbnails +
// description + specs + shipping), swapping in the seller header and, for
// classifieds, a "Contact seller" action in place of Qty/Add/Buy.
function openDetail(item, onContact) {
  const opts = { sellerHeader: sellerRow(item), menu: shareMenu(item.product) }
  if (!item.buyNow) {
    // Close this detail modal before opening the DM composer so they don't
    // stack. (Buy-Now items keep the merch default Qty/Add/Buy actions.)
    opts.actions = h('button', {
      class: 'market-btn market-btn--contact', type: 'button',
      onclick: () => { closeModal(); onContact(item) },
    }, 'Contact seller')
  }
  openProductModal(item.product, opts)
}

// ── Featured affordances ─────────────────────────────────────────────
// Featured Listings: a listing is featured when someone boosts the show with
// its naddr in the message (see featured-market.js). The Feature button opens
// that boost prefilled; the boost also pays the seller the show's reassignable
// split leg. House-store listings carry no Feature button — the seller would
// be the show.
const FEATURED_INITIAL = 8

let toastTimer = null
function showToast(msg, isError = false) {
  let t = document.querySelector('.market-toast')
  if (!t) {
    t = h('div', { class: 'market-toast', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.toggle('is-error', !!isError)
  requestAnimationFrame(() => t.classList.add('is-visible'))
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2200)
}

async function copyNpub(pubkey) {
  let npub = ''
  try { npub = nip19.npubEncode(pubkey) } catch {}
  if (!npub) return
  try { await navigator.clipboard.writeText(npub); showToast('npub copied') }
  catch { showToast('Copy failed — clipboard blocked', true) }
}

function featureButton(item) {
  const p = item.product
  const btn = h('button', {
    class: 'market-btn market-btn--feature', type: 'button',
    title: 'Feature — boost this listing into the Featured section',
  })
  btn.innerHTML = FEATURE_BOLT_SVG + '<span>Feature</span>'
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    btn.disabled = true
    try {
      await featureListing(
        { pubkey: p.merchant, dTag: p.d, naddr: naddrForProduct(p), seller: item.profile },
        (msg) => showToast(msg, true),
      )
    } finally {
      btn.disabled = false
    }
  })
  return btn
}

// Booster profiles for the "Featured by …" credit (the seller profiles live on
// the items themselves).
const boosterProfiles = new Map()
function boosterName(pk) {
  const p = boosterProfiles.get(pk)
  if (p && p.name && p.name.trim()) return p.name.trim()
  try { return nip19.npubEncode(pk).slice(0, 12) + '…' } catch { return 'someone' }
}
function boosterAvatar(pk) {
  const p = boosterProfiles.get(pk)
  const pic = p && isHttpUrl(p.picture) ? p.picture : ''
  return pic
    ? h('img', { class: 'market-seller-pfp', src: pic, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'market-seller-pfp market-seller-pfp--none', text: (boosterName(pk)[0] || '?').toUpperCase() })
}
function featuredCredit(info) {
  return featuredByEl(info, {
    avatar: boosterAvatar,
    name: boosterName,
    link: (pk) => (hasBoosterPage(pk) ? boosterUrl(pk) : null),
    onCopy: copyNpub,
  })
}

function renderCard(item, rate, onContact, { featured = false, info = null } = {}) {
  const p = item.product
  const media = h('div', { class: 'market-card-media' },
    p.images.length
      ? imageCarousel(p.images, p.title, { className: 'market-card-carousel' }).wrap
      : h('div', { class: 'market-card-noimg', text: '🛍️' }))
  // Only classifieds get a badge (naming what's missing to be checkout-ready);
  // Buy-Now items need none — the "Add to cart" button speaks for itself.
  if (!item.buyNow) {
    media.appendChild(h('span', { class: 'market-badge market-badge--classified', title: item.reason, text: item.reason }))
  }

  // An already-featured card drops the Feature button — it only means "get
  // this into Featured" — and credits whoever paid for it in the same slot.
  const foot = featured
    ? featuredCredit(info)
    : (item.isHouse ? null : featureButton(item))

  const card = h('article', {
    class: 'market-card' + (featured ? ' market-card--featured' : ''), role: 'button', tabindex: '0',
    onclick: () => openDetail(item, onContact),
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openDetail(item, onContact) } },
  }, [
    media,
    h('div', { class: 'market-card-body' }, [
      h('h3', { class: 'market-card-title', text: p.title }),
      sellerRow(item),
      priceEl(p, rate),
      p.summary ? h('p', { class: 'market-card-summary', text: p.summary }) : null,
      h('div', { class: 'market-card-actions' }, [actionButton(item, onContact, { stop: true }), foot]),
    ]),
  ])
  return card
}

// ── Featured section ─────────────────────────────────────────────────
// The gold box, same chrome as Featured Articles: 1W/1M/All over when a
// listing was featured, inside the border. `visible` is filled with the
// coordinates rendered so the community grid can drop them; a listing shown
// in the box must never also appear below it.
function featuredEntries(state, byCoord) {
  const out = []
  for (const [coord, info] of state.featured) {
    const item = byCoord.get(coord)
    if (item) out.push({ item, info })
  }
  out.sort((x, y) => (y.info.featuredAt || 0) - (x.info.featuredAt || 0))
  return out
}

function buildFeaturedSection(state, byCoord, rate, onContact, visible, onChange) {
  const entries = featuredEntries(state, byCoord)
  const inRange = entries.filter((e) => inFeaturedRange(e.info, state.range))
  for (const e of inRange) visible.add(e.item.product.coord)

  const head = featuredHead({
    title: 'Featured Listings',
    count: inRange.length,
    range: state.range,
    noun: 'listings',
    onRange: (key) => { state.range = key; state.featShown = FEATURED_INITIAL; onChange() },
    findLabel: 'Find a Listing to Feature',
    onFind: () => openFindModal(onChange),
  })

  const section = h('section', { class: 'feat-box', 'aria-label': 'Featured listings' }, [head])
  const shown = inRange.slice(0, state.featShown)
  if (shown.length) {
    const grid = h('div', { class: 'feed-list market-grid' })
    for (const { item, info } of shown) grid.appendChild(renderCard(item, rate, onContact, { featured: true, info }))
    section.appendChild(grid)
    const rest = inRange.length - shown.length
    if (rest > 0) {
      section.appendChild(featuredMoreButton(rest, FEATURED_INITIAL, () => { state.featShown += FEATURED_INITIAL; onChange() }))
    }
  } else if (state.featuredLoading) {
    section.appendChild(h('div', { class: 'feed-list market-grid' }, h('div', { class: 'feed-skeleton' })))
  } else {
    section.appendChild(featuredEmptyEl(state.range, entries.some((e) => isFeatureLive(e.info)), { noun: 'listings', verb: 'boost a listing to feature it here' }))
  }
  return section
}

// Turn raw 30402 events fetched outside the snapshot (a featured listing from
// a non-supporter, or a pasted one) into classified items. Runs them through
// merch.js's catalog so the cart and product modal resolve them like any other.
async function itemsFromEvents(events, relays) {
  const products = ingestListings(events)
    .filter((p) => p.visibility !== 'hidden' && p.status !== 'sold' && p.visibility !== 'sold' && p.stock !== 0)
  if (!products.length) return []
  const merchants = [...new Set(products.map((p) => p.merchant))]
  let profiles = await fetchProfilesFromPrimal(merchants).catch(() => new Map())
  if (!profiles.size) profiles = await fetchMerchantProfiles(merchants, relays).catch(() => new Map())
  return products.map((p) => classify(p, profiles.get(p.merchant)))
}

// ── "Find a Listing to Feature" modal ────────────────────────────────
// Same single paste box as the Articles tab's Find modal: a listing is always
// addressable by naddr (Shopstr, Conduit and MyNostr links all carry one).
let findModal = null
const pastedItems = new Map()   // coord -> classified item

function buildFindModal() {
  const input = h('input', {
    class: 'ffind-input', type: 'text', spellcheck: 'false',
    placeholder: 'naddr1… or a link containing one',
    'aria-label': 'Listing address',
  })
  const status = h('p', { class: 'ffind-status', role: 'status', 'aria-live': 'polite' })
  const result = h('div', { class: 'ffind-result' })
  const lookup = h('button', { class: 'ffind-go', type: 'button' }, 'Look Up')
  const card = h('div', { class: 'event-composer-card', role: 'document' }, [
    h('button', { class: 'event-composer-close', type: 'button', 'aria-label': 'Close' }, '×'),
    h('h2', { class: 'event-composer-title', id: 'mfm-title', text: 'Find a Listing to Feature' }),
    h('p', { class: 'ffind-help' },
      'Paste a NIP-99 listing’s address. A Shopstr, Conduit, or MyNostr link works too — anything with an naddr1 in it.'),
    h('div', { class: 'ffind-row' }, [input, lookup]),
    status,
    result,
  ])
  const backdrop = h('div', {
    class: 'event-composer-backdrop ffind-backdrop', role: 'dialog',
    'aria-modal': 'true', 'aria-labelledby': 'mfm-title', hidden: 'hidden',
  }, card)
  return { backdrop, card, input, status, result, lookup, close: card.firstChild }
}

function openFindModal(onFeatured) {
  if (!findModal) {
    findModal = buildFindModal()
    document.body.appendChild(findModal.backdrop)
    const close = () => {
      findModal.backdrop.hidden = true
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    findModal.onKey = onKey
    findModal.closeFn = close
    findModal.close.addEventListener('click', close)
    findModal.backdrop.addEventListener('click', (e) => { if (e.target === findModal.backdrop) close() })
    findModal.lookup.addEventListener('click', () => runLookup(findModal, onFeatured))
    findModal.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runLookup(findModal, onFeatured) }
    })
  }
  findModal.onFeatured = onFeatured
  findModal.status.textContent = ''
  findModal.result.innerHTML = ''
  findModal.input.value = ''
  findModal.backdrop.hidden = false
  document.addEventListener('keydown', findModal.onKey)
  findModal.input.focus()
}

async function runLookup(m, onFeatured) {
  const naddr = naddrFromText(m.input.value)
  m.result.innerHTML = ''
  if (!naddr) {
    m.status.textContent = 'That doesn’t contain a listing address. Paste an naddr1… or a link with one in it.'
    return
  }
  m.status.textContent = 'Looking up…'
  m.lookup.disabled = true
  let found = null
  try {
    found = await fetchListingByNaddr(naddr)
  } catch (e) {
    console.warn('[market] lookup failed', e)
  } finally {
    m.lookup.disabled = false
  }
  if (found && found.wrongKind) {
    m.status.textContent = `That address points to a kind-${found.wrongKind} event, not a marketplace listing.`
    return
  }
  if (!found) {
    m.status.textContent = 'Couldn’t find that listing on the relays we query. Check the address, or try a link from the client it was published in.'
    return
  }
  const [item] = await itemsFromEvents([found.event], feedRelays)
  if (!item) {
    m.status.textContent = 'That listing is hidden, sold, or out of stock, so it can’t be featured.'
    return
  }
  pastedItems.set(item.product.coord, item)
  m.status.textContent = ''

  const feature = h('button', { class: 'market-btn market-btn--feature ffind-feature', type: 'button' })
  feature.innerHTML = FEATURE_BOLT_SVG + '<span>Feature This Listing</span>'
  feature.addEventListener('click', async () => {
    feature.disabled = true
    try {
      const p = item.product
      await featureListing(
        { pubkey: p.merchant, dTag: p.d, naddr, seller: item.profile },
        (msg) => showToast(msg, true),
      )
      m.closeFn()
      onFeatured?.()
    } finally {
      feature.disabled = false
    }
  })

  const p = item.product
  const img = p.images.find(isHttpUrl)
  m.result.append(
    h('div', { class: 'ffind-preview' }, [
      img
        ? h('div', { class: 'ffind-preview-media' }, h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))
        : h('div', { class: 'ffind-preview-media ffind-preview-media--none' }, '🛍️'),
      h('div', { class: 'ffind-preview-body' }, [
        h('div', { class: 'ffind-preview-title', text: p.title }),
        h('div', { class: 'ffind-preview-meta' }, [sellerRow(item)]),
        p.summary ? h('p', { class: 'ffind-preview-summary', text: p.summary }) : null,
      ]),
    ]),
    feature,
  )
}

// ── Contact-seller DM modal (NIP-17, NIP-04 legacy fallback) ─────────
function closeOverlay(overlay) { try { overlay.remove() } catch {} }

async function sellerHasNip17Inbox(pubkey, relays) {
  // Presence of a kind-10050 DM-relay list = the seller runs a NIP-17-aware
  // client. Absence → we also fire a legacy NIP-04 DM so older clients see it.
  const pool = new SimplePool()
  try {
    const evs = await pool.querySync(relays, { kinds: [10050], authors: [pubkey] }).catch(() => [])
    return evs.some((e) => e && e.pubkey === pubkey && (e.tags || []).some((t) => t[0] === 'relay'))
  } catch {
    return false
  } finally {
    try { pool.close(relays) } catch {}
  }
}

// Legacy NIP-04 (kind 4) fallback: encrypt with the buyer's signer and drop
// on the seller's inbox/write relays so pre-NIP-17 clients still receive it.
async function sendLegacyDM(sellerHex, text) {
  const encrypt = async (plaintext) => {
    if (typeof window !== 'undefined' && window.nostr?.nip04?.encrypt) {
      return await window.nostr.nip04.encrypt(sellerHex, plaintext)
    }
    const ndk = window.LBLogin?.getNDK?.()
    if (ndk?.signer?.encrypt) return await ndk.signer.encrypt(ndk.getUser({ pubkey: sellerHex }), plaintext, 'nip04')
    throw new Error('No NIP-04 encryption available')
  }
  // Bounded like the NIP-17 seal in merch.js — a wedged extension pipe
  // otherwise hangs the order flow on this encrypt forever. Sentinel
  // (not rejection) so a legitimate encrypt error still surfaces as-is.
  const TIMED_OUT = Symbol('nip04-timeout')
  const ciphertext = await Promise.race([
    encrypt(text),
    new Promise((res) => setTimeout(() => res(TIMED_OUT), 30000)),
  ])
  if (ciphertext === TIMED_OUT) {
    throw new Error('Your signer didn\'t respond while encrypting the order message. Make sure it\'s unlocked, then try again.')
  }
  const signed = await window.LBLogin.signEvent({
    kind: 4,
    content: ciphertext,
    tags: [['p', sellerHex]],
    created_at: Math.floor(Date.now() / 1000),
  })
  const relays = await resolveDMRelays(sellerHex)
  const pool = new SimplePool()
  try {
    // Bound each relay publish — a hung relay socket otherwise stalls
    // the order flow here even after every other relay has acked.
    await Promise.allSettled(pool.publish(relays, signed).map((p) =>
      Promise.race([p, new Promise((res) => setTimeout(res, 8000))])
    ))
  } finally {
    try { pool.close(relays) } catch {}
  }
  // Buyer outbox too, for redundancy.
  try { await window.LBLogin.publishEvent(signed) } catch {}
}

function openContactModal(item, relays) {
  const user = window.LBLogin?.getUser?.()
  if (!user || !user.pubkey) {
    // Login gates contact (the DM is signed by the buyer's key). Prompt, then
    // reopen on success — same pattern as merch checkout.
    window.LBLogin?.requestLogin?.()
    const off = window.LBLogin?.onChange?.((u) => {
      if (u && u.pubkey) { off && off(); openContactModal(item, relays) }
    })
    return
  }

  const sellerHex = item.product.merchant
  const textarea = h('textarea', {
    class: 'market-dm-input', rows: '4',
    placeholder: `Ask ${sellerName(item)} about "${item.product.title}"…`,
  })
  const status = h('div', { class: 'market-dm-status', 'aria-live': 'polite' })
  const sendBtn = h('button', { class: 'market-btn market-btn--buy', type: 'button' }, 'Send message')

  const overlay = h('div', { class: 'market-modal-overlay' })
  const closeBtn = h('button', { class: 'market-modal-close', type: 'button', 'aria-label': 'Close' }, '✕')
  closeBtn.addEventListener('click', () => closeOverlay(overlay))
  const modal = h('div', { class: 'market-modal', role: 'dialog', 'aria-modal': 'true' }, [
    closeBtn,
    h('h3', { class: 'market-modal-title', text: `Message ${sellerName(item)}` }),
    h('p', { class: 'market-modal-sub', text: 'Sent as an encrypted Nostr DM. Watch for their reply in your Nostr DM app.' }),
    textarea,
    status,
    h('div', { class: 'market-modal-actions' }, [sendBtn]),
  ])
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  textarea.focus()

  sendBtn.addEventListener('click', async () => {
    const text = textarea.value.trim()
    if (!text) { status.textContent = 'Type a message first.'; return }
    sendBtn.disabled = true
    status.textContent = 'Encrypting and sending… approve in your signer if prompted.'
    try {
      // Primary: NIP-17 gift-wrapped kind-14 chat message to the seller.
      const rumor = {
        kind: 14,
        content: text,
        tags: [['p', sellerHex], ['subject', `Re: ${item.product.title}`]],
      }
      await giftWrapAndPublish(rumor, user.pubkey, sellerHex)
      // Self-copy so the message also lands in the BUYER's own NIP-17 DM
      // client (NIP-17 senders gift-wrap a copy to themselves); best-effort.
      try { await giftWrapAndPublish(rumor, user.pubkey, user.pubkey) } catch (e) { console.warn('[market] DM self-copy failed', e) }
      // Legacy fallback only when the seller has no NIP-17 inbox published.
      const hasInbox = await sellerHasNip17Inbox(sellerHex, relays)
      if (!hasInbox) {
        try { await sendLegacyDM(sellerHex, text) } catch (e) { console.warn('[market] legacy DM failed', e) }
      }
      status.textContent = 'Sent! Keep an eye on your Nostr DM app for a reply.'
      sendBtn.textContent = 'Sent ✓'
    } catch (e) {
      console.error('[market] contact send failed', e)
      status.textContent = 'Could not send — please try again, or reach the seller in your Nostr app.'
      sendBtn.disabled = false
    }
  })
}

// ── "Manage / List Items" button ─────────────────────────────────────
// Shown for logged-in users only, deep-linking to their own marketplace on
// MyNostr (where they can list/manage items). It sits in the Community
// Marketplace header rather than the panel head: listing an item puts you in
// that section, not in Show Merch. Re-rendered on login state changes, so it
// re-queries the header each time instead of capturing the node.
function renderManageButton(list) {
  const head = list.querySelector('.market-community-head')
  if (!head) return
  const prev = head.querySelector('.market-manage-btn')
  if (prev) prev.remove()

  const user = window.LBLogin?.getUser?.()
  if (!user || !user.pubkey) return
  let npub
  try { npub = nip19.npubEncode(user.pubkey) } catch { return }
  head.appendChild(h('a', {
    class: 'market-manage-btn',
    href: `https://mynostr.app/${npub}/marketplace`,
    target: '_blank', rel: 'noopener',
  }, 'Manage / List Items'))
}

// ── Data pipeline ────────────────────────────────────────────────────
// Resolve the supporter set's marketplace into a render-ready, classified,
// sorted item list (Buy Now first, then newest) + the current BTC/USD rate.
// Exported so the homepage teaser (home-feeds.js) surfaces the same listings
// the Marketplace tab does without duplicating the fetch/grade/sort logic.
export async function loadMarketItems({ relays, members } = {}) {
  // Relays used for the seller kind-0 / lud16 lookup below (and the fallback
  // listing query). Falls back to the shared static set when the caller hasn't
  // resolved supporter outbox relays — the snapshot path no longer needs them.
  let queryRelays = (relays && relays.length) ? relays : STATIC_RELAYS

  // Primary: the hourly community-market snapshot (pre-scoped to supporters +
  // the house store). Fall back to a live relay query only if it's unreachable.
  let events
  try {
    events = await fetchMarketSnapshot()
  } catch (e) {
    console.warn('[market] snapshot unavailable — querying relays', e)
    let fbMembers = members || []
    if (!fbMembers.length) {
      // Tab path passes no members; resolve the supporter set on demand so the
      // fallback still covers community sellers, not just the house store.
      // Dynamic import avoids a static cycle with feeds.js (which lazy-imports
      // this module).
      try {
        const feeds = await import('/assets/js/feeds.js')
        const sup = await feeds.resolveSupporters()
        fbMembers = sup.members || []
        if (sup.relays && sup.relays.length) queryRelays = sup.relays
      } catch (e2) {
        console.warn('[market] supporter resolution failed', e2)
      }
    }
    const authors = [...new Set([...fbMembers, MERCHANT_HEX].map((a) => a.toLowerCase()))]
    events = await fetchMarketEvents(authors, queryRelays)
  }

  // Drop listings the seller deleted (NIP-09) BEFORE ingesting — many relays
  // keep serving the 30402 after a kind-5, so this is how a "removed by seller"
  // listing (which other clients like Plebeian already hide) disappears here.
  const { deletedIds, deletedCoords } = collectDeletions(events)
  const liveEvents = events.filter((e) => e.kind !== KIND_DELETION && !isDeleted(e, deletedIds, deletedCoords))

  // Then hide anything unavailable: hidden listings, explicit NIP-99 status
  // "sold" (or a seller using visibility for it), zero-inventory listings, and
  // sellers who signal "sold" as free text in the price ("… - sold!" on
  // westernmassbitcoin, which has no structured status tag). stock null/absent =
  // unknown quantity, so keep it; only an explicit 0 is out of stock.
  // (ingestListings already drops `hidden`, but assert it here too so the feed's
  // availability rules live in one visible place.)
  const soldInPrice = (p) => /\bsold\b/i.test(p.priceRaw || '')
  const products = ingestListings(liveEvents).filter(
    (p) => p.visibility !== 'hidden' && p.status !== 'sold' && p.visibility !== 'sold' && p.stock !== 0 && !soldInPrice(p),
  )

  if (!products.length) return { items: [], rate: null }

  // Merchant profiles (pfp / name / lud16) drive display AND the Lightning-
  // payability check, for EVERY seller incl. the house merchant (its lud16 is
  // hardcoded for payment, but we still want its pfp + name). Primal's cache
  // resolves them in one fast batch — the same source the Events tab uses. The
  // old per-relay kind-0 query waited maxWait ~4.5s and was the dominant cost of
  // opening this tab (snapshot fetch is ~100ms); fall back to it only if Primal
  // comes back empty (both return { name, picture, lud16 }).
  const merchants = [...new Set(products.map((p) => p.merchant))]
  // Kick off the BTC/USD rate in parallel with profile resolution — it's
  // independent of the merchants, and getBtcUsd is timeout-bounded, so it can
  // overlap the profile fetch and never extend the render.
  const ratePromise = getBtcUsd().catch(() => null)
  let profiles = await fetchProfilesFromPrimal(merchants).catch(() => new Map())
  if (!profiles.size) profiles = await fetchMerchantProfiles(merchants, queryRelays)

  const rate = await ratePromise
  const items = products
    .map((p) => classify(p, profiles.get(p.merchant)))
    .sort((a, b) => {
      // Buy Now first, then newest.
      if (a.buyNow !== b.buyNow) return a.buyNow ? -1 : 1
      return (b.product.created_at || 0) - (a.product.created_at || 0)
    })

  return { items, rate }
}

// ── Entry point (Marketplace tab) ────────────────────────────────────
export async function renderMarket({ panel, list, relays, members } = {}) {
  showSkeletons(list)
  // Relay hints for the ⋮ share naddr and the NIP-17 inbox check. On the tab
  // path no supporter relays are resolved, so fall back to the static set.
  feedRelays = (relays && relays.length) ? relays : STATIC_RELAYS

  // Let the shared nav cart icon open the cart IN PLACE once this tab has
  // hydrated. Until then the icon is a plain link to /feeds#market-cart, which
  // routes here and opens the cart at the end of this function.
  window.openMerchCart = openCart

  // The manage button replaced the panel head's count pill, which stays hidden
  // whether or not anyone is logged in.
  const count = panel.querySelector('.feed-panel-head .feed-count')
  if (count) count.hidden = true

  // The button itself lives in the Community Marketplace header, so it can only
  // render once the sections exist; it tracks login changes from there. The
  // loader runs once, so subscribe just once here.
  if (!renderMarket._manageWired) {
    renderMarket._manageWired = true
    window.LBLogin?.onChange?.(() => renderManageButton(list))
  }

  // The booster index decides link-vs-copy for the "Featured by …" credit
  // synchronously; obReady() resolves either way.
  const [{ items, rate }] = await Promise.all([loadMarketItems({ relays, members }), obReady()])
  const onContact = (item) => openContactModal(item, feedRelays)

  // Split the one classified list into the two rendered sections. Inside Show
  // Merch the shared Buy-Now-first sort carries no information (the house store
  // is always Buy Now), so order it newest-first instead.
  const house = items.filter((it) => it.isHouse)
    .sort((a, b) => (b.product.created_at || 0) - (a.product.created_at || 0))
  const community = items.filter((it) => !it.isHouse)

  // Every listing we can render, snapshot or backfilled. The community grid
  // only ever draws from `community`; `byCoord` also holds listings pulled in
  // by a feature, which belong in the gold box but not in the community grid.
  const byCoord = new Map()
  for (const it of items) byCoord.set(it.product.coord, it)

  const state = {
    range: FEATURED_DEFAULT_RANGE,
    // coord -> { featuredAt, by, sats, naddr }. Seeded with anything featured
    // from this browser recently, so a fresh boost stays lit across a reload
    // until the authoritative log catches up.
    featured: readConfirmedFeaturedListings(),
    featuredLoading: true,
    featShown: FEATURED_INITIAL,
  }

  const grid = (section) => {
    const g = h('div', { class: 'feed-list market-grid' })
    for (const item of section) g.appendChild(renderCard(item, rate, onContact))
    return g
  }

  const featuredMount = h('div', { class: 'market-featured-mount' })
  const communityMount = h('div', { class: 'market-community-mount' })

  // Repaints the gold box and the community grid together. The grid is every
  // community listing, featured ones included: the box and the grid became
  // the Featured and All sub-tabs of the tab (2026-09-06), and "All" has to
  // mean all. A featured listing's card in the grid keeps its Feature button;
  // boosting it again renews the feature.
  function rerender() {
    const visible = new Set()
    featuredMount.innerHTML = ''
    featuredMount.appendChild(buildFeaturedSection(state, byCoord, rate, onContact, visible, rerender))
    communityMount.innerHTML = ''
    communityMount.appendChild(community.length
      ? grid(community)
      : placeholder('No listings yet', ' No marketplace listings from supporters right now — check back soon.'))
  }

  list.className = ''
  list.innerHTML = ''

  // Featured first: it is the paid-for slot, so it leads the tab.
  list.appendChild(featuredMount)

  // Show Merch is boxed so the house store reads as its own storefront rather
  // than the first few cards of the community list.
  list.appendChild(h('section', { class: 'market-house' }, [
    sectionHead('Show Merch'),
    house.length
      ? grid(house)
      : placeholder(SOLD_OUT_MSG, ' New show gear is on the way — check back soon.'),
  ]))

  // "Community" links to /supporters: the section is scoped to the supporter
  // follow packs, so that page is the answer to "whose listings are these?".
  list.appendChild(sectionHead([
    h('a', { class: 'feed-section-link', href: '/supporters' }, 'Community'),
    ' Marketplace',
  ], 'market-community-head'))
  list.appendChild(communityMount)
  rerender()

  renderManageButton(list)

  // Arriving from the nav cart icon (/feeds#market-cart) → open the cart now
  // that the catalog is merged, so every line (house AND community seller)
  // resolves to a product.
  if (window.__lbOpenCartOnMarket) {
    window.__lbOpenCartOnMarket = false
    openCart()
  }

  // Optimistic feature: when a boost settles and a Feature click is pending for
  // a LISTING coordinate, light it up now rather than waiting for the log. The
  // pending slot is shared with the other tabs; a foreign coordinate is left
  // for its own listener to claim.
  window.addEventListener('lb:show-boost-settled', (ev) => {
    const d = ev && ev.detail
    if (!d || !(d.anySucceeded || d.anyUncertain)) return
    const pending = readPendingPromote()
    if (!pending || !pending.coord || !isListingCoord(pending.coord)) return
    clearPendingPromote()
    const ts = addConfirmedFeaturedListing(pending.coord, pending.naddr || '')
    const by = currentBooster()
    const prev = state.featured.get(pending.coord)
    state.featured.set(pending.coord, {
      featuredAt: ts,
      by: by || prev?.by || null,
      sats: prev?.sats || 0,
      naddr: pending.naddr || prev?.naddr || '',
    })
    if (!byCoord.has(pending.coord) && pastedItems.has(pending.coord)) {
      byCoord.set(pending.coord, pastedItems.get(pending.coord))
    }
    if (by) boosterProfiles.set(by.pubkey, { name: by.name, picture: by.picture })
    rerender()
  })

  // The authoritative featured set, then any featured listing missing from the
  // snapshot straight from relays. Best-effort throughout: a failure here
  // leaves the section showing whatever the optimistic set knows about.
  try {
    const { featured, hints } = await fetchFeaturedListingSet()
    for (const [coord, info] of featured) {
      const prev = state.featured.get(coord)
      state.featured.set(coord, {
        ...info,
        featuredAt: Math.max(info.featuredAt || 0, prev?.featuredAt || 0),
        by: info.by || prev?.by || null,
      })
    }
    const missing = [...state.featured.keys()].filter((c) => !byCoord.has(c))
    if (missing.length) {
      const relaysPlus = [...new Set([...feedRelays, ...hints])]
      const found = await fetchListingsFromRelays(missing, relaysPlus)
      const added = await itemsFromEvents([...found.values()], relaysPlus)
      for (const it of added) byCoord.set(it.product.coord, it)
    }
    const boosters = [...new Set([...state.featured.values()].map((i) => i.by?.pubkey).filter(Boolean))]
    if (boosters.length) {
      const got = await fetchProfilesFromPrimal(boosters).catch(() => new Map())
      for (const [pk, prof] of got) boosterProfiles.set(pk, prof)
    }
  } catch (e) {
    console.warn('[market] featured load failed', e)
  }
  try {
    state.featuredLoading = false
    rerender()
  } catch (e) {
    console.warn('[market] featured repaint failed', e)
  }
}
