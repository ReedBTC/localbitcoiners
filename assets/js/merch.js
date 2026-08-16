/* Local Bitcoiners merch engine — NIP-99 + Gamma-spec.
 *
 * No page of its own: the storefront it used to render at /merch is now the
 * "Show Merch" section of the /feeds Marketplace tab (lb-v48). What lives here
 * is the catalog, the product modal, and the cart/checkout, imported by
 * feeds-market.js (both marketplace sections) and home-merch.js (the homepage
 * marquee). Nothing runs on import.
 *
 * READ-ONLY catalog: products (kind 30402), collections (30405) and
 * shipping options (30406) are fetched from the show's merchant npub.
 * Listings are created/edited elsewhere (plebeian.market, mynostr, …);
 * this module never writes them.
 *
 * CHECKOUT is a full Gamma-spec order flow, but it never touches
 * a private key directly. It leans entirely on the shared login widget:
 *   - window.LBLogin.signEvent / publishEvent  → sign + broadcast events
 *   - window.LBLogin.getNDK().signer.encrypt   → NIP-44 seal encryption
 *   - window.LBLogin.payInvoice                → pay via NWC or WebLN
 * The order/receipt messages are NIP-17 gift-wrapped (kind 1059) to the
 * merchant: we hand-build the kind-13 seal with the user's signer (so it
 * carries their real authorship) and let nip59.createWrap() generate the
 * ephemeral outer wrap.
 *
 * Security discipline matches boost-actions.js: every merchant-controlled
 * string is written via textContent (never innerHTML), image/URL fields
 * are scheme-checked before use, and the lud16 is validated before we
 * build an LNURL request out of it.
 */

import { SimplePool, nip19, nip59, getEventHash } from '/assets/widgets/nostr-tools.js'
import { ready as obReady, hasBoosterPage, boosterUrl } from '/assets/js/onlyboosts.js'

// ── Constants ────────────────────────────────────────────────────────
const MERCHANT_NPUB = 'npub1cvcgs83gw6pcrhvtmlf8gdqaegx93qkznwry96jteqhh2cexgkfq45rtya'
// Decoded at module load; throws loudly if the npub is ever mistyped.
const MERCHANT_HEX = (() => {
  const { type, data } = nip19.decode(MERCHANT_NPUB)
  if (type !== 'npub') throw new Error('MERCHANT_NPUB is not an npub')
  return data
})()

// The general-relay half of the boost feed's read set (boosts-thread.js), which
// is where the measurement behind that list lives. relay.fountain.fm is
// deliberately absent: it is the strongest relay we have for kind 1 and answers
// a REQ for the kinds this file reads (30402 listings, kind 0) with `kinds not
// supported`, so here it would be a socket that can only ever return nothing.
const RELAYS = [
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://nostr.mom',
]

// Where to drop NIP-17 gift-wraps when the merchant has published no
// kind-10050 DM-relay list (and no usable 10002). Write-friendly relays
// the merchant's DM client is likely to read.
// Reach, not coverage: this is a PUBLISH set, and the two questions have
// opposite shapes. Asking who HAS an event is measurable and a useless member
// costs latency on every query; asking who will SEE one is not, and a member
// too many costs a single socket on a rare action while one too few costs
// delivery nobody can observe. So this stays deliberately generous, and
// relay.primal.net keeps its slot on that asymmetry rather than on evidence.
// relay.damus.io is out because it intermittently answers a connect with HTTP
// 503, which is a delivery failure rather than a wasted socket.
const DEFAULT_DM_RELAYS = [
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://relay.primal.net',
  'wss://relay.0xchat.com',
]

// Lightning address that merch payments are sent to. Hardcoded on purpose
// so all merch revenue lands in one wallet regardless of the merchant's
// kind-0 lud16 (which is used for boosts/zaps, not store orders).
const MERCH_PAYMENT_LUD16 = 'localbitcoiners@getalby.com'

const ORDERS_KEY = 'lb_merch_orders'   // localStorage: sent orders (for a future "My Orders")
const CART_KEY   = 'lb_merch_cart'     // sessionStorage: { [coord]: qty }

// ── Tiny DOM helper ──────────────────────────────────────────────────
// h('div', { class:'x', onclick:fn }, [child|string, …]). Strings become
// text nodes — so nothing merchant-controlled is ever parsed as HTML.
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv
    else el.setAttribute(k, v)
  }
  for (const c of [].concat(children)) {
    if (c == null) continue
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return el
}

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' }
  catch { return false }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ])
}

// ── BTC/USD price oracle (for fiat-priced listings) ──────────────────
// Listings are commonly priced in USD; Lightning settles in sats, so we
// need a spot rate. Cached for the page session. Two independent sources,
// raced in parallel with a per-request timeout so a single slow/hung endpoint
// can never stall a caller (e.g. the /feeds Marketplace render) — the fastest
// healthy source wins, and if both fail/time out we resolve null.
const RATE_TIMEOUT_MS = 2500
let _rate = null
let _ratePromise = null

function fetchJsonWithTimeout(url, ms = RATE_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { signal: ctrl.signal })
    .then((r) => r.json())
    .finally(() => clearTimeout(timer))
}

async function getBtcUsd() {
  if (_rate) return _rate
  if (_ratePromise) return _ratePromise
  _ratePromise = (async () => {
    const validRate = (v) => {
      if (Number.isFinite(v) && v > 0) return v
      throw new Error('invalid rate')
    }
    // Both start immediately (array literal); Promise.any resolves with the
    // first that yields a valid rate, and rejects only if all do (→ null).
    const sources = [
      fetchJsonWithTimeout('https://mempool.space/api/v1/prices').then((j) => validRate(Number(j.USD))),
      fetchJsonWithTimeout('https://api.coinbase.com/v2/prices/BTC-USD/spot').then((j) => validRate(Number(j?.data?.amount))),
    ]
    try {
      _rate = await Promise.any(sources)
      return _rate
    } catch {
      return null
    }
  })()
  return _ratePromise
}

// ── Currency → sats ──────────────────────────────────────────────────
// Returns integer sats, or null if conversion isn't possible (unknown
// fiat, or no rate available yet for a fiat-priced item).
function toSats(amount, currency, rate) {
  const c = String(currency || '').toUpperCase()
  if (!Number.isFinite(amount)) return null
  if (c === 'SAT' || c === 'SATS') return Math.round(amount)
  if (c === 'MSAT' || c === 'MSATS') return Math.round(amount / 1000)
  if (c === 'BTC') return Math.round(amount * 1e8)
  if (c === 'USD' || c === '' /* default */) {
    if (!rate) return null
    return Math.round((amount / rate) * 1e8)
  }
  return null // other fiat not supported
}

function priceLabel(amount, currency) {
  const c = String(currency || 'USD').toUpperCase()
  if (c === 'USD' || c === '') return '$' + Number(amount).toFixed(2)
  if (c === 'SAT' || c === 'SATS') return Number(amount).toLocaleString() + ' sats'
  if (c === 'BTC') return amount + ' BTC'
  return amount + ' ' + c
}

function fmtSats(n) {
  return Number(n).toLocaleString() + ' sats'
}

// Short npub label (npub1abcd…wxyz) for a hex pubkey, used before/if a
// merchant's kind-0 display name resolves.
function shortNpub(hex) {
  try { const np = nip19.npubEncode(hex); return np.slice(0, 12) + '…' + np.slice(-4) }
  catch { return hex.slice(0, 8) + '…' }
}

// ── Tag parsing ──────────────────────────────────────────────────────
const firstTag = (ev, name) => (ev.tags.find(t => t[0] === name) || [])[1]
const allTags  = (ev, name) => ev.tags.filter(t => t[0] === name)

// Human description from the event content. Some marketplace clients (notably
// Conduit) stuff a machine-readable JSON product payload into the content
// instead of prose; rendering that verbatim dumps a wall of JSON into the
// detail modal (and it has no spaces, so it overflows). Treat a JSON
// object/array as "no description" — the human text lives in the summary tag.
function descriptionText(content) {
  if (typeof content !== 'string') return ''
  const t = content.trim()
  if (t && (t[0] === '{' || t[0] === '[')) {
    try { const v = JSON.parse(t); if (v && typeof v === 'object') return '' } catch {}
  }
  return content
}

function parseProduct(ev) {
  const d = firstTag(ev, 'd')
  if (!d) return null
  const priceTag = ev.tags.find(t => t[0] === 'price') || []
  const typeTag  = ev.tags.find(t => t[0] === 'type')  || []
  const images = allTags(ev, 'image')
    .map(t => t[1]).filter(isHttpUrl)
  return {
    d,
    id: ev.id,                                 // this version's event id (Plebeian routes by it)
    merchant: ev.pubkey,                       // seller pubkey (not always the LB house npub)
    coord: `30402:${ev.pubkey}:${d}`,
    title: firstTag(ev, 'title') || '(untitled)',
    summary: firstTag(ev, 'summary') || '',
    description: descriptionText(ev.content),
    priceRaw: priceTag[1] != null ? String(priceTag[1]) : '',   // original text, e.g. "30,000 - sold!"
    priceAmount: Number(priceTag[1]),
    priceCurrency: priceTag[2] || 'USD',
    priceFreq: priceTag[3] || '',
    goods: (typeTag[2] || 'digital').toLowerCase(),       // physical | digital
    visibility: (firstTag(ev, 'visibility') || 'on-sale').toLowerCase(),
    status: (firstTag(ev, 'status') || '').toLowerCase(),  // NIP-99: active | sold
    stock: firstTag(ev, 'stock') != null ? Number(firstTag(ev, 'stock')) : null,
    images,
    specs: allTags(ev, 'spec').map(t => [t[1], t[2]]).filter(s => s[0]),
    // Gamma: a product's shipping_option tag is ["shipping_option", <ref>,
    // <extra-cost>]. The optional third element is a per-product surcharge
    // (in the PRODUCT's currency) added to that method's base price. <ref>
    // is a 30406 option coord or a 30405 collection coord (extra then applies
    // to every option in that collection).
    shippingRefs: allTags(ev, 'shipping_option')
      .map(t => ({ coord: t[1], extra: Number(t[2]) || 0 }))
      .filter(s => s.coord),
    collectionRefs: allTags(ev, 'a').map(t => t[1]).filter(c => c.startsWith('30405:')),
    created_at: ev.created_at,
  }
}

function parseShipping(ev) {
  const d = firstTag(ev, 'd')
  if (!d) return null
  const priceTag = ev.tags.find(t => t[0] === 'price') || []
  const duration = ev.tags.find(t => t[0] === 'duration')
  return {
    d,
    merchant: ev.pubkey,
    coord: `30406:${ev.pubkey}:${d}`,
    title: firstTag(ev, 'title') || 'Shipping',
    priceAmount: Number(priceTag[1] || 0),
    priceCurrency: priceTag[2] || 'USD',
    service: firstTag(ev, 'service') || '',
    carrier: firstTag(ev, 'carrier') || '',
    countries: allTags(ev, 'country').map(t => t[1]),
    region: firstTag(ev, 'region') || '',
    durationText: duration ? duration.slice(1).join(' ') : '',
  }
}

function parseCollection(ev) {
  const d = firstTag(ev, 'd')
  if (!d) return null
  return {
    d,
    merchant: ev.pubkey,
    coord: `30405:${ev.pubkey}:${d}`,
    title: firstTag(ev, 'title') || '',
    shippingRefs: allTags(ev, 'shipping_option').map(t => t[1]).filter(Boolean),
  }
}

// ── Catalog state ────────────────────────────────────────────────────
const catalog = {
  products: [],            // parsed, visible, newest-per-d
  shipping: new Map(),     // coord → shipping option
  collections: new Map(),  // coord → collection
}

// Resolve the shipping choices that apply to a product: its own
// shipping_option refs (each carrying an optional per-product extra cost),
// merged with any inherited from collections it references (Gamma: product +
// collection shipping MUST be merged). Returns [{ option, extra }] where
// `option` is a parsed 30406 shipping option and `extra` is the surcharge in
// the product's currency.
function shippingForProduct(p) {
  const extraByCoord = new Map()   // 30406 coord → extra cost (product currency)
  const add = (coord, extra) => {
    // If the same option is reachable by several paths, keep the largest
    // extra so a product-specific surcharge is never silently dropped.
    if (!extraByCoord.has(coord) || extra > extraByCoord.get(coord)) extraByCoord.set(coord, extra)
  }
  for (const { coord, extra } of p.shippingRefs) {
    if (coord.startsWith('30405:')) {
      // Collection reference: the extra applies to every option inside it.
      const col = catalog.collections.get(coord)
      if (col) col.shippingRefs.forEach(r => add(r, extra))
    } else {
      add(coord, extra)   // direct 30406 option
    }
  }
  // Collections the product belongs to via `a` tags contribute their options
  // too, with no product-specific surcharge.
  for (const cref of p.collectionRefs) {
    const col = catalog.collections.get(cref)
    if (col) col.shippingRefs.forEach(r => add(r, 0))
  }
  const out = []
  for (const [coord, extra] of extraByCoord) {
    const option = catalog.shipping.get(coord)
    if (option) out.push({ option, extra })
  }
  // Put local-pickup options last so a shipped method is the default choice
  // (buyers shouldn't accidentally default to "come pick it up"). Array.sort
  // is stable, so non-pickup order is otherwise preserved.
  out.sort((a, b) => (isPickupOption(a.option) ? 1 : 0) - (isPickupOption(b.option) ? 1 : 0))
  return out
}

// A shipping option is "pickup" if its Gamma service type says so, or the
// title reads like a pickup (some merchants omit the service tag).
function isPickupOption(option) {
  return String(option.service).toLowerCase() === 'pickup' || /pick\s*-?\s*up/i.test(option.title || '')
}

// Sats cost of a shipping choice for a given product: the option's base price
// (in the option's currency) plus the per-product extra (in the product's
// currency), each converted independently. null if either can't be converted.
function shipChoiceSats(product, choice, rate) {
  const base = toSats(choice.option.priceAmount, choice.option.priceCurrency, rate)
  const extra = choice.extra ? toSats(choice.extra, product.priceCurrency, rate) : 0
  if (base == null || extra == null) return null
  return base + extra
}

// Human label for a shipping choice, e.g. "Standard — $5.99" or, with a
// surcharge in the same currency, the combined "$7.99". If base and extra are
// in different currencies they're shown side by side ("$5.99 + 2000 sats").
function shipChoiceLabel(product, choice) {
  const o = choice.option
  if (!choice.extra) return `${o.title} — ${priceLabel(o.priceAmount, o.priceCurrency)}`
  const sameCcy = String(o.priceCurrency).toUpperCase() === String(product.priceCurrency).toUpperCase()
  if (sameCcy) return `${o.title} — ${priceLabel(o.priceAmount + choice.extra, o.priceCurrency)}`
  return `${o.title} — ${priceLabel(o.priceAmount, o.priceCurrency)} + ${priceLabel(choice.extra, product.priceCurrency)}`
}

async function fetchCatalog() {
  // npubChip() decides link-vs-copy synchronously when a product description
  // renders, so the booster index is resolved here first. In practice it is
  // already warm — descriptions render on modal open, long after this — but
  // this makes it deterministic. obReady() resolves either way.
  await obReady()
  // Query each relay INDEPENDENTLY and merge, rather than one pooled
  // querySync across all relays. A pooled query only resolves once every
  // relay has EOSE'd or timed out, and in that shared subscription a
  // thinly-replicated event (e.g. a product that only propagated to one
  // relay) can get dropped when a dead/slow relay gates the close — which
  // is why the store was intermittently missing items. Per-relay + merge is
  // reliable: the relay that has an event returns it on its own schedule,
  // and dedup-by-id folds the results together.
  const pool = new SimplePool()
  const byId = new Map()
  try {
    await Promise.allSettled(RELAYS.map(async (relay) => {
      const evs = await withTimeout(
        pool.querySync([relay], { authors: [MERCHANT_HEX], kinds: [30402, 30405, 30406] }, { maxWait: 4000 }),
        4500,
        [],
      )
      for (const ev of evs) if (!byId.has(ev.id)) byId.set(ev.id, ev)
    }))
  } finally {
    try { pool.close(RELAYS) } catch {}
  }
  const events = [...byId.values()]

  // Replaceable events: keep newest per (kind:pubkey:d). Pubkey is in the key
  // so two different merchants can publish the same `d` without colliding.
  const newest = new Map()
  for (const ev of events) {
    const d = firstTag(ev, 'd')
    if (!d) continue
    const key = `${ev.kind}:${ev.pubkey}:${d}`
    const prev = newest.get(key)
    if (!prev || ev.created_at > prev.created_at) newest.set(key, ev)
  }

  catalog.products = []
  catalog.shipping.clear()
  catalog.collections.clear()
  for (const ev of newest.values()) {
    if (ev.kind === 30406) { const s = parseShipping(ev); if (s) catalog.shipping.set(s.coord, s) }
    else if (ev.kind === 30405) { const c = parseCollection(ev); if (c) catalog.collections.set(c.coord, c) }
  }
  for (const ev of newest.values()) {
    if (ev.kind !== 30402) continue
    const p = parseProduct(ev)
    if (p && p.visibility !== 'hidden') catalog.products.push(p)
  }
  // Stable, pre-orders last, otherwise newest first.
  catalog.products.sort((a, b) => {
    if (a.visibility !== b.visibility) return a.visibility === 'pre-order' ? 1 : -1
    return b.created_at - a.created_at
  })
}

// Merge externally-sourced NIP-99 events (e.g. the /feeds community
// marketplace, which surfaces listings from OTHER merchants alongside the
// house store) into the in-memory catalog WITHOUT clearing what's already
// there, so the shared cart + checkout can resolve their products, shipping
// and collections. Same newest-per-(kind:pubkey:d) + skip-hidden rules as
// fetchCatalog. Returns the parsed products that were ingested (newest per
// coord) so the caller can grade/classify them.
function ingestListings(events) {
  const newest = new Map()
  for (const ev of events || []) {
    if (!ev || (ev.kind !== 30402 && ev.kind !== 30405 && ev.kind !== 30406)) continue
    const d = firstTag(ev, 'd')
    if (!d) continue
    const key = `${ev.kind}:${ev.pubkey}:${d}`
    const prev = newest.get(key)
    if (!prev || ev.created_at > prev.created_at) newest.set(key, ev)
  }
  // Shipping + collections first so a product can resolve its refs.
  for (const ev of newest.values()) {
    if (ev.kind === 30406) { const s = parseShipping(ev); if (s) catalog.shipping.set(s.coord, s) }
    else if (ev.kind === 30405) { const c = parseCollection(ev); if (c) catalog.collections.set(c.coord, c) }
  }
  const ingested = []
  for (const ev of newest.values()) {
    if (ev.kind !== 30402) continue
    const p = parseProduct(ev)
    if (!p || p.visibility === 'hidden') continue
    const idx = catalog.products.findIndex(x => x.coord === p.coord)
    if (idx === -1) catalog.products.push(p)
    else if (p.created_at >= catalog.products[idx].created_at) catalog.products[idx] = p
    else continue   // an older duplicate — keep the newer one already held
    ingested.push(p)
  }
  catalog.products.sort((a, b) => {
    if (a.visibility !== b.visibility) return a.visibility === 'pre-order' ? 1 : -1
    return b.created_at - a.created_at
  })
  return ingested
}

// ── Cart (sessionStorage) ────────────────────────────────────────────
function readCart() {
  try { return JSON.parse(sessionStorage.getItem(CART_KEY) || '{}') } catch { return {} }
}
function writeCart(cart) {
  try { sessionStorage.setItem(CART_KEY, JSON.stringify(cart)) } catch {}
  updateCartBadge()
}
function cartCount() {
  return Object.values(readCart()).reduce((a, b) => a + b, 0)
}
function addToCart(coord, qty = 1) {
  const cart = readCart()
  cart[coord] = (cart[coord] || 0) + qty
  const p = catalog.products.find(x => x.coord === coord)
  if (p && p.stock != null) cart[coord] = Math.min(cart[coord], Math.max(p.stock, 0))
  if (cart[coord] <= 0) delete cart[coord]
  writeCart(cart)
}
function setCartQty(coord, qty) {
  const cart = readCart()
  if (qty <= 0) delete cart[coord]
  else cart[coord] = qty
  writeCart(cart)
}
function cartLines() {
  const cart = readCart()
  return Object.entries(cart)
    .map(([coord, qty]) => ({ product: catalog.products.find(p => p.coord === coord), qty, coord }))
    .filter(l => l.product) // drop stale coords no longer in catalog
}

// Cart state changed — let the shared nav (nav.js) repaint its cart badge.
// The nav owns the badge so the count shows on every page, not just /feeds.
function updateCartBadge() {
  window.dispatchEvent(new Event('lb-cart-changed'))
}

// ── Rendering: shared pieces ─────────────────────────────────────────
function chevron(dir) {
  const span = h('span', { class: 'merch-chev', 'aria-hidden': 'true' })
  span.innerHTML = dir === 'left'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'
  return span
}

// Shared image carousel: a framed <img> with prev/next arrows that cycle
// through `images` (wrapping at the ends). Arrows render only for 2+ images
// and stopPropagation so they work inside a clickable card without also
// opening the modal. `onIndexChange` lets the detail modal keep its
// thumbnail tray in sync. Returns { wrap, show(i) }.
function imageCarousel(images, alt, { className = '', onIndexChange } = {}) {
  let idx = 0
  const img = h('img', { src: images[0], alt, loading: 'lazy' })
  const wrap = h('div', { class: ('merch-carousel ' + className).trim() }, [img])
  function show(i) {
    idx = (i + images.length) % images.length
    img.src = images[idx]
    if (onIndexChange) onIndexChange(idx)
  }
  if (images.length > 1) {
    wrap.appendChild(h('button', {
      type: 'button', class: 'merch-carousel-arrow merch-carousel-prev', 'aria-label': 'Previous image',
      onclick: (e) => { e.stopPropagation(); show(idx - 1) },
      onkeydown: (e) => e.stopPropagation(),
    }, chevron('left')))
    wrap.appendChild(h('button', {
      type: 'button', class: 'merch-carousel-arrow merch-carousel-next', 'aria-label': 'Next image',
      onclick: (e) => { e.stopPropagation(); show(idx + 1) },
      onkeydown: (e) => e.stopPropagation(),
    }, chevron('right')))
  }
  return { wrap, show }
}

// Append a "≈ N sats" hint to a price element for fiat-priced items.
async function applySatHint(el, p) {
  const c = String(p.priceCurrency || 'USD').toUpperCase()
  if (c === 'SAT' || c === 'SATS' || c === 'BTC') return
  const rate = await getBtcUsd()
  const sats = toSats(p.priceAmount, p.priceCurrency, rate)
  if (sats != null) el.appendChild(h('span', { class: 'merch-sat-hint', text: `  ≈ ${fmtSats(sats)}` }))
}

// ── Modal scaffolding ────────────────────────────────────────────────
// Boost-modal convention (repo memory): explicit X close, no backdrop /
// Esc dismissal, so an accidental click never discards an in-progress
// checkout.
let activeModal = null
function openModal(node, { onClose } = {}) {
  closeModal()
  const overlay = h('div', { class: 'merch-overlay' }, [node])
  const close = () => { try { onClose && onClose() } catch {} ; overlay.remove(); activeModal = null; document.body.style.overflow = '' }
  node.querySelectorAll('[data-merch-close]').forEach(b => b.addEventListener('click', close))
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'
  activeModal = { overlay, close }
  return { close }
}
function closeModal() {
  if (activeModal) activeModal.close()
}

function closeButton() {
  return h('button', { class: 'merch-close', 'aria-label': 'Close', 'data-merch-close': '' }, '✕')
}

// ── npub mentions in descriptions ────────────────────────────────────
// A merchant description may embed an npub (bare or nostr:-prefixed). We
// render it as a clickable chip showing the person's display name; the
// rest of the text stays plain text nodes, so nothing is parsed as HTML.
const NPUB_RE = /(?:nostr:)?(npub1[02-9ac-hj-np-z]{58})/g

function renderDescription(text) {
  const p = h('p', { class: 'merch-detail-desc' })
  let last = 0, m
  NPUB_RE.lastIndex = 0
  while ((m = NPUB_RE.exec(text))) {
    const npub = m[1]
    let hex = null
    try { const d = nip19.decode(npub); if (d.type === 'npub') hex = d.data } catch {}
    if (!hex) continue   // bad checksum — leave the run as plain text
    if (m.index > last) p.appendChild(document.createTextNode(text.slice(last, m.index)))
    p.appendChild(npubChip(npub, hex))
    last = m.index + m[0].length
  }
  if (last < text.length) p.appendChild(document.createTextNode(text.slice(last)))
  return p
}

// An @npub mention inside listing text. When that person has an OnlyBoosts
// page the chip becomes a link to it; otherwise it stays the copy-to-clipboard
// button it has always been. No booster dot here — this is a text chip with no
// avatar to hang one on, so the link treatment is the whole cue.
function npubChip(npub, hex) {
  let label = npub.slice(0, 10) + '…' + npub.slice(-4)   // until the name resolves

  if (hasBoosterPage(npub)) {
    const link = h('a', {
      class: 'merch-npub-chip',
      text: '@' + label,
      href: boosterUrl(npub),
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'View this booster on OnlyBoosts',
    })
    resolveProfileName(hex).then(name => {
      if (!name) return
      label = name
      link.textContent = '@' + label
      link.title = 'View ' + name + ' on OnlyBoosts'
    })
    return link
  }

  const chip = h('button', {
    type: 'button',
    class: 'merch-npub-chip',
    text: '@' + label,
    title: 'Click to copy ' + npub,
    onclick: async () => {
      try { await navigator.clipboard.writeText(npub) } catch {}
      clearTimeout(chip._t)
      chip.classList.add('copied')
      chip.textContent = 'Copied ✓'
      chip._t = setTimeout(() => { chip.classList.remove('copied'); chip.textContent = '@' + label }, 1400)
    },
  })
  resolveProfileName(hex).then(name => {
    if (!name) return
    label = name
    if (!chip.classList.contains('copied')) chip.textContent = '@' + label
  })
  return chip
}

// Resolve a hex pubkey → its kind-0 profile { name, picture, nip05, lud16 }.
// Cached per session (by hex) so repeat lookups (mentions, merchant headers,
// payment address) don't re-query the relays. Fields are null when absent.
const _profileCache = new Map()   // hex → Promise<{name,picture,nip05,lud16}>
function resolveMerchantProfile(hex) {
  if (_profileCache.has(hex)) return _profileCache.get(hex)
  const promise = (async () => {
    const pool = new SimplePool()
    try {
      const ev = await withTimeout(pool.get(RELAYS, { kinds: [0], authors: [hex] }), 6000, null)
      if (!ev) return { name: null, picture: null, nip05: null, lud16: null }
      const meta = JSON.parse(ev.content || '{}')
      const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null
      return {
        name: str(meta.display_name) || str(meta.displayName) || str(meta.name),
        picture: isHttpUrl(meta.picture) ? meta.picture : null,
        nip05: str(meta.nip05),
        lud16: str(meta.lud16),
      }
    } catch { return { name: null, picture: null, nip05: null, lud16: null } }
    finally { try { pool.close(RELAYS) } catch {} }
  })()
  _profileCache.set(hex, promise)
  return promise
}

// Back-compat helper for npub chips: just the display name.
async function resolveProfileName(hex) {
  return (await resolveMerchantProfile(hex)).name
}

// The Lightning address an order to `merchantHex` should be paid to. The LB
// house merchant routes ALL merch revenue to one wallet regardless of its
// kind-0 lud16; any other (community-feed) merchant is paid at their own
// profile lud16 (Gamma "automatic" mode). null → we can't auto-pay them.
function paymentLud16ForMerchant(merchantHex, profile) {
  if (merchantHex === MERCHANT_HEX) return MERCH_PAYMENT_LUD16
  return (profile && typeof profile.lud16 === 'string' && profile.lud16.trim()) ? profile.lud16.trim() : null
}

// ── Product detail modal ─────────────────────────────────────────────
// opts (all optional; the homepage marquee passes none):
//   sellerHeader — a node inserted under the title (e.g. seller pfp + name)
//   actions      — node(s) to render in place of the default Qty/Add/Buy row
//                  (the /feeds classifieds pass a "Contact seller" button)
//   menu         — a node pinned top-right (e.g. /feeds ⋮ copy-naddr / view-on)
function openProductModal(p, opts = {}) {
  // Featured image is a carousel (prev/next arrows cycle the images); the
  // thumbnail tray below stays in sync — clicking a thumb jumps the
  // carousel, and the arrows highlight the matching thumb.
  const thumbEls = []
  const syncThumbs = (i) => thumbEls.forEach((t, j) => t.classList.toggle('active', j === i))
  const featured = h('div', { class: 'merch-detail-featured' })
  let car = null
  if (p.images.length) {
    car = imageCarousel(p.images, p.title, { className: 'merch-detail-carousel', onIndexChange: syncThumbs })
    featured.appendChild(car.wrap)
  } else {
    featured.appendChild(h('div', { class: 'merch-card-noimg', text: '🛍️' }))
  }
  const thumbs = p.images.length > 1
    ? h('div', { class: 'merch-detail-thumbs' }, p.images.map((u, i) => {
        const t = h('img', {
          src: u, alt: `${p.title} thumbnail ${i + 1}`,
          class: 'merch-thumb' + (i === 0 ? ' active' : ''),
          onclick: () => car.show(i),
        })
        thumbEls.push(t)
        return t
      })) : null
  const gallery = h('div', { class: 'merch-detail-media' }, [featured, thumbs])

  const price = h('div', { class: 'merch-detail-price' }, priceLabel(p.priceAmount, p.priceCurrency))
  applySatHint(price, p)

  const ship = shippingForProduct(p)
  const shipInfo = (p.goods === 'physical' && ship.length)
    ? h('div', { class: 'merch-detail-ship' }, [
        h('strong', { text: 'Shipping:' }),
        ...ship.map(c => h('div', { class: 'merch-detail-ship-opt',
          text: shipChoiceLabel(p, c) })),
      ])
    : null

  const soldOut = p.stock === 0
  const qtyInput = h('input', { type: 'number', min: '1', value: '1', class: 'merch-qty',
    max: p.stock != null ? String(p.stock) : null })

  const addBtn = h('button', { class: 'merch-btn merch-btn-ghost', disabled: soldOut || null,
    onclick: () => { addToCart(p.coord, Math.max(1, parseInt(qtyInput.value, 10) || 1)); closeModal(); openCart() } },
    soldOut ? 'Sold out' : 'Add to cart')
  const buyBtn = h('button', { class: 'merch-btn merch-btn-primary', disabled: soldOut || null,
    onclick: () => { addToCart(p.coord, Math.max(1, parseInt(qtyInput.value, 10) || 1)); closeModal(); openCheckout() } },
    [boltIcon(), soldOut ? 'Sold out' : 'Buy now'])

  const specs = p.specs.length
    ? h('table', { class: 'merch-specs' }, p.specs.map(([k, v]) =>
        h('tr', {}, [h('th', { text: k }), h('td', { text: v })])))
    : null

  const actions = opts.actions
    ? h('div', { class: 'merch-detail-actions' }, [].concat(opts.actions))
    : h('div', { class: 'merch-detail-actions' }, [
        h('label', { class: 'merch-qty-label' }, ['Qty ', qtyInput]),
        addBtn, buyBtn,
      ])

  const card = h('div', { class: 'merch-modal merch-modal-detail' }, [
    closeButton(),
    opts.menu || null,   // optional ⋮ menu (e.g. /feeds: copy naddr + view elsewhere)
    gallery,
    h('div', { class: 'merch-detail-info' }, [
      h('h2', { class: 'merch-detail-title', text: p.title }),
      opts.sellerHeader || null,
      price,
      p.stock != null && p.stock > 0 ? h('div', { class: 'merch-stock', text: `${p.stock} in stock` }) : null,
      // Fall back to the summary when there's no body text (e.g. Conduit
      // listings, whose JSON content is suppressed) so the modal still reads.
      (p.description || p.summary) ? renderDescription(p.description || p.summary) : null,
      specs,
      shipInfo,
      actions,
    ]),
  ])

  openModal(card)
}

function boltIcon() {
  const span = h('span', { class: 'merch-bolt', 'aria-hidden': 'true' })
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clip-rule="evenodd"/></svg>'
  return span
}

function trashIcon() {
  const span = h('span', { class: 'merch-trash', 'aria-hidden': 'true' })
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'
  return span
}

// ── Cart modal ───────────────────────────────────────────────────────
async function openCart() {
  const lines = cartLines()
  const rate = await getBtcUsd()

  const body = h('div', { class: 'merch-cart-lines' })
  let totalSats = 0
  let convertible = true
  if (!lines.length) {
    body.appendChild(h('p', { class: 'merch-cart-empty', text: 'Your cart is empty.' }))
  }
  for (const line of lines) {
    const { product: p, qty } = line
    const sats = toSats(p.priceAmount, p.priceCurrency, rate)
    if (sats == null) convertible = false
    else totalSats += sats * qty

    const qtyInput = h('input', { type: 'number', min: '0', value: String(qty), class: 'merch-qty',
      max: p.stock != null ? String(p.stock) : null,
      onchange: (e) => { setCartQty(p.coord, parseInt(e.target.value, 10) || 0); openCart() } })

    body.appendChild(h('div', { class: 'merch-cart-line' }, [
      p.images[0] ? h('img', { src: p.images[0], alt: p.title, class: 'merch-cart-thumb' }) : h('div', { class: 'merch-cart-thumb merch-card-noimg', text: '🛍️' }),
      h('div', { class: 'merch-cart-line-info' }, [
        h('div', { class: 'merch-cart-line-title', text: p.title }),
        h('div', { class: 'merch-cart-line-price', text: priceLabel(p.priceAmount, p.priceCurrency) + (sats != null ? `  ·  ${fmtSats(sats)}` : '') }),
      ]),
      qtyInput,
      h('button', { class: 'merch-line-remove', 'aria-label': 'Remove', title: 'Remove', onclick: () => { setCartQty(p.coord, 0); openCart() } }, trashIcon()),
    ]))
  }

  const totalRow = lines.length ? h('div', { class: 'merch-cart-total' }, [
    h('span', { text: 'Subtotal' }),
    h('strong', { text: convertible ? fmtSats(totalSats) : 'price unavailable' }),
  ]) : null

  // Physical items pick a shipping method on the next (checkout) step, so
  // the button says so — buyers were missing the shipping selector because
  // a plain "Checkout" gave no hint it was coming.
  const needsShipping = lines.some(l => l.product.goods === 'physical')
  const checkoutBtn = h('button', {
    class: 'merch-btn merch-btn-primary merch-cart-checkout',
    disabled: (!lines.length || !convertible) || null,
    onclick: () => { closeModal(); openCheckout() },
  }, [boltIcon(), needsShipping ? 'Select shipping & checkout' : 'Checkout'])

  const card = h('div', { class: 'merch-modal merch-modal-cart' }, [
    closeButton(),
    h('h2', { class: 'merch-modal-title', text: 'Your cart' }),
    body,
    totalRow,
    lines.length ? checkoutBtn : null,
    !convertible && lines.length ? h('p', { class: 'merch-warn', text: 'Live BTC price unavailable — try again in a moment.' }) : null,
  ])
  openModal(card)
}

// ── Checkout ─────────────────────────────────────────────────────────
function uuid() {
  return (crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)))
}
function randomPastTs() {
  // NIP-59: randomize seal/wrap timestamps up to 2 days in the past.
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800)
}

async function openCheckout() {
  const lines = cartLines()
  if (!lines.length) return openCart()

  const user = window.LBLogin?.getUser?.()
  if (!user || !user.pubkey) {
    // Login is required: the order is an encrypted NIP-17 DM signed by
    // the buyer's key. Prompt, then reopen checkout on success.
    window.LBLogin?.requestLogin?.()
    const off = window.LBLogin?.onChange?.((u) => {
      if (u && u.pubkey) { off && off(); openCheckout() }
    })
    return
  }

  const rate = await getBtcUsd()
  // Whether any physical item is still in the cart. Dynamic because lines can
  // be removed on this page — dropping the last physical item hides the
  // shipping-details form.
  const hasPhysical = () => lines.some(l => l.product.goods === 'physical')

  // Per-item shipping (Gamma): each physical product line picks its OWN
  // method from its own options, and each line's cost is summed independently
  // into the order total. shipState is keyed by line coord.
  const shipState = new Map()   // coord → { line, choices, select }
  for (const line of lines.filter(l => l.product.goods === 'physical')) {
    const choices = shippingForProduct(line.product)
    const select = choices.length
      ? h('select', { class: 'merch-input' },
          choices.map((c, i) => h('option', { value: c.option.coord, selected: i === 0 ? '' : null },
            shipChoiceLabel(line.product, c))))
      : null
    if (select) select.addEventListener('change', renderTotals)
    shipState.set(line.coord, { line, choices, select })
  }
  // The chosen { option, extra } for a physical line, or null if it has no
  // shipping options published.
  function chosenShipFor(coord) {
    const st = shipState.get(coord)
    if (!st || !st.choices.length) return null
    return st.choices.find(c => c.option.coord === st.select.value) || st.choices[0]
  }

  // ── Form fields ──
  // Standard shipping form (no phone). Email is optional.
  const nameInput  = h('input', { class: 'merch-input', type: 'text', autocomplete: 'name', placeholder: 'Name' })
  const addr1Input = h('input', { class: 'merch-input', type: 'text', autocomplete: 'address-line1', placeholder: 'Address line 1' })
  const addr2Input = h('input', { class: 'merch-input', type: 'text', autocomplete: 'address-line2', placeholder: 'Address line 2 (optional)' })
  const cityInput  = h('input', { class: 'merch-input', type: 'text', autocomplete: 'address-level2', placeholder: 'Town / City' })
  const stateInput = h('input', { class: 'merch-input', type: 'text', autocomplete: 'address-level1', placeholder: 'State / Province' })
  const zipInput   = h('input', { class: 'merch-input', type: 'text', autocomplete: 'postal-code', placeholder: 'ZIP / Postal code' })
  const countryInput = h('input', { class: 'merch-input', type: 'text', autocomplete: 'country-name', placeholder: 'Country', value: 'United States' })
  const emailInput = h('input', { class: 'merch-input', type: 'email', autocomplete: 'email', placeholder: 'Email (optional, for updates)' })
  const noteInput = h('input', { class: 'merch-input', type: 'text', placeholder: 'Order note (optional)' })

  // Assemble the structured fields into a single, human-readable address
  // block for the Gamma order's ["address", …] tag + the summary DM.
  function composeAddress() {
    const out = []
    const v = (el) => el.value.trim()
    if (v(nameInput))  out.push(v(nameInput))
    if (v(addr1Input)) out.push(v(addr1Input))
    if (v(addr2Input)) out.push(v(addr2Input))
    const cityState = [v(cityInput), v(stateInput)].filter(Boolean).join(', ')
    const lastLine = [cityState, v(zipInput)].filter(Boolean).join(' ')
    if (lastLine) out.push(lastLine)
    if (v(countryInput)) out.push(v(countryInput))
    return out.join('\n')
  }
  // Returns the first missing required field's label, or null if complete.
  function missingShippingField() {
    const req = [[nameInput, 'name'], [addr1Input, 'address line 1'], [cityInput, 'town / city'], [stateInput, 'state'], [zipInput, 'ZIP / postal code']]
    const m = req.find(([el]) => !el.value.trim())
    return m ? m[1] : null
  }

  // Sats subtotal + shipping for a set of lines. Shipping is charged once per
  // physical line (not per unit), matching the Gamma/Plebeian model. Used for
  // both the per-merchant and grand totals.
  function totalsFor(subset) {
    let subSats = 0, shipSats = 0, ok = true
    for (const l of subset) {
      const s = toSats(l.product.priceAmount, l.product.priceCurrency, rate)
      if (s == null) ok = false; else subSats += s * l.qty
      if (l.product.goods === 'physical') {
        const choice = chosenShipFor(l.coord)
        if (choice) {
          const ss = shipChoiceSats(l.product, choice, rate)
          if (ss == null) ok = false; else shipSats += ss
        }
      }
    }
    return { subSats, shipSats, ok }
  }

  // The per-line shipping selections for a set of lines → the order message.
  function collectShipments(subset) {
    const out = []
    for (const l of subset) {
      if (l.product.goods !== 'physical') continue
      const choice = chosenShipFor(l.coord)
      if (choice) out.push({ productTitle: l.product.title, coord: choice.option.coord, optionTitle: choice.option.title })
    }
    return out
  }

  // Cart lines grouped by merchant pubkey (first-seen order preserved). A cart
  // can hold items from several NIP-99 merchants once the community feed lands;
  // each merchant is its own order + its own Lightning payment.
  function groupLines() {
    const map = new Map()   // merchantHex → lines[]
    for (const l of lines) {
      if (!map.has(l.product.merchant)) map.set(l.product.merchant, [])
      map.get(l.product.merchant).push(l)
    }
    return map
  }
  const linesForMerchant = (hex) => lines.filter(l => l.product.merchant === hex)

  // ── Order lines (top), grouped by merchant ──
  // Each merchant is its own bordered section: a header (avatar + name), that
  // seller's item cards (thumbnail, name, price, inline per-item shipping), and
  // the seller's own subtotal/shipping/total. A grand total (below) appears
  // only when the cart spans 2+ merchants.
  const cardEls = new Map()       // coord → card element (for removal)
  const sectionEls = new Map()    // merchantHex → { section, totalsEl }
  const itemsWrap = h('div', { class: 'merch-checkout-items' })

  // Heads-up banner shown only when the cart spans multiple sellers.
  const multiNote = h('div', { class: 'merch-multi-note' })
  function syncMultiNote() {
    const n = sectionEls.size
    multiNote.style.display = n > 1 ? '' : 'none'
    multiNote.textContent = n > 1
      ? `Your cart has items from ${n} sellers — you'll approve a separate Lightning payment for each.`
      : ''
  }

  for (const [merchantHex, gLines] of groupLines()) {
    const totalsEl = h('div', { class: 'merch-checkout-summary merch-mgroup-totals' })
    const section = h('div', { class: 'merch-mgroup' }, [
      buildMerchantHeader(merchantHex),
      ...gLines.map(buildItemCard),
      totalsEl,
    ])
    sectionEls.set(merchantHex, { section, totalsEl })
    itemsWrap.appendChild(section)
  }
  syncMultiNote()

  // Merchant header: avatar + display name + nip05/npub, filled from kind-0.
  // The LB house merchant gets a subtle "official" marker.
  function buildMerchantHeader(hex) {
    const avatar = h('div', { class: 'merch-mhead-avatar merch-card-noimg' }, '🛍️')
    const nameEl = h('div', { class: 'merch-mhead-name', text: shortNpub(hex) })
    const subEl  = h('div', { class: 'merch-mhead-sub', text: '' })
    if (hex === MERCHANT_HEX) nameEl.classList.add('merch-mhead-official')
    resolveMerchantProfile(hex).then((p) => {
      if (p.name) nameEl.textContent = p.name
      if (p.picture) { avatar.textContent = ''; avatar.classList.remove('merch-card-noimg')
        avatar.appendChild(h('img', { src: p.picture, alt: '', class: 'merch-mhead-img' })) }
      subEl.textContent = p.nip05 || shortNpub(hex)
    })
    return h('div', { class: 'merch-mhead' }, [avatar, h('div', { class: 'merch-mhead-id' }, [nameEl, subEl])])
  }

  // Build one line card, wiring its quantity stepper to update the cart and
  // totals in place (so the address form the buyer may have typed isn't
  // rebuilt). Shipping is per-line, not per-unit, so quantity only moves the
  // subtotal — the stepper just refreshes this line's price and the totals.
  function buildItemCard(l) {
    const p = l.product
    const thumb = p.images[0]
      ? h('img', { src: p.images[0], alt: p.title, class: 'merch-citem-thumb' })
      : h('div', { class: 'merch-citem-thumb merch-card-noimg', text: '🛍️' })

    const priceEl = h('div', { class: 'merch-citem-price' })
    const setPrice = () => {
      const s = toSats(p.priceAmount, p.priceCurrency, rate)
      priceEl.textContent = priceLabel(p.priceAmount, p.priceCurrency) + (s != null ? `  ·  ${fmtSats(s * l.qty)}` : '')
    }
    setPrice()

    const st = shipState.get(l.coord)   // physical lines only
    let shipRow = null
    if (p.goods === 'physical') {
      shipRow = st?.select
        ? h('div', { class: 'merch-citem-ship' }, st.select)
        : h('p', { class: 'merch-warn merch-citem-shipwarn', text: 'No shipping options published — the seller will follow up.' })
    }

    const stepper = qtyStepper(l, () => { setPrice(); renderTotals() })
    const removeBtn = h('button', { type: 'button', class: 'merch-citem-remove',
      'aria-label': `Remove ${p.title}`, title: 'Remove', onclick: () => removeLine(l) }, trashIcon())

    const card = h('div', { class: 'merch-citem' }, [
      thumb,
      h('div', { class: 'merch-citem-info' }, [
        h('div', { class: 'merch-citem-title', text: p.title }),
        priceEl,
        stepper,
        shipRow,
      ]),
      removeBtn,
    ])
    cardEls.set(l.coord, card)
    return card
  }

  // Remove a line from the cart on this page. Persists to the cart, drops the
  // card + its shipping state, then refreshes totals and the shipping section
  // (which hides once no physical items remain). Emptying the cart returns to
  // the cart view.
  function removeLine(l) {
    const idx = lines.indexOf(l)
    if (idx === -1) return
    const hex = l.product.merchant
    lines.splice(idx, 1)
    setCartQty(l.coord, 0)
    shipState.delete(l.coord)
    cardEls.get(l.coord)?.remove()
    cardEls.delete(l.coord)
    if (!lines.length) { closeModal(); openCart(); return }
    // Drop the merchant's whole section once its last item is gone.
    if (!linesForMerchant(hex).length) {
      sectionEls.get(hex)?.section.remove()
      sectionEls.delete(hex)
    }
    renderTotals()
    syncShippingSection()
    syncMultiNote()
  }

  // A − [n] + quantity control for a checkout line. Clamped to 1..stock;
  // removal is done from the cart, not here.
  function qtyStepper(l, onChange) {
    const maxStock = l.product.stock != null ? Math.max(l.product.stock, 0) : null
    const box = h('input', { type: 'number', class: 'merch-qty', min: '1',
      max: maxStock != null ? String(maxStock) : null, value: String(l.qty),
      'aria-label': `Quantity of ${l.product.title}` })
    const apply = (n) => {
      let q = Math.floor(n) || 1
      if (q < 1) q = 1
      if (maxStock != null && maxStock > 0) q = Math.min(q, maxStock)
      box.value = String(q)
      if (q === l.qty) return
      l.qty = q
      setCartQty(l.coord, q)
      onChange()
    }
    box.addEventListener('change', () => apply(parseInt(box.value, 10)))
    const dec = h('button', { type: 'button', class: 'merch-step', 'aria-label': 'Decrease quantity',
      onclick: () => apply(l.qty - 1) }, '−')
    const inc = h('button', { type: 'button', class: 'merch-step', 'aria-label': 'Increase quantity',
      onclick: () => apply(l.qty + 1) }, '+')
    return h('div', { class: 'merch-qty-stepper' }, [dec, box, inc])
  }

  // ── Totals ──
  // Grand total across all merchants — shown only when the cart spans 2+.
  const grandTotals = h('div', { class: 'merch-checkout-summary merch-grand-totals' })

  // Render Subtotal / Shipping / Total for a set of lines into `el`.
  function renderTotalsInto(el, subset, { grand = false } = {}) {
    el.innerHTML = ''
    const { subSats, shipSats, ok } = totalsFor(subset)
    const physical = subset.some(l => l.product.goods === 'physical')
    const line = (label, valEl, cls) => el.appendChild(h('div', { class: 'merch-sum-line' + (cls ? ' ' + cls : '') }, [h('span', { text: label }), valEl]))
    line(grand ? 'Subtotal (all sellers)' : 'Subtotal', h('span', { text: ok ? fmtSats(subSats) : '—' }))
    if (physical) line('Shipping', h('span', { text: ok ? fmtSats(shipSats) : '—' }), 'merch-sum-ship')
    line('Total', h('strong', { text: ok ? fmtSats(subSats + shipSats) : 'unavailable' }), 'merch-sum-total')
  }

  function renderTotals() {
    for (const [hex, { totalsEl }] of sectionEls) renderTotalsInto(totalsEl, linesForMerchant(hex))
    const multi = sectionEls.size > 1
    grandTotals.style.display = multi ? '' : 'none'
    if (multi) renderTotalsInto(grandTotals, lines, { grand: true })
    else grandTotals.innerHTML = ''
  }
  renderTotals()

  const status = h('div', { class: 'merch-checkout-status' })
  const payBtn = h('button', { class: 'merch-btn merch-btn-primary' }, [boltIcon(), 'Place order & pay'])

  // Per-merchant order state, persisted across pay retries (e.g. after a
  // NO_WALLET prompt, or one seller failing while another succeeded): each
  // merchant keeps its own order id + published/paid flags so a retry never
  // re-sends an order or double-charges a seller already paid.
  const session = { byMerchant: new Map() }

  // Shipping-details section (address the chosen methods ship to). Built once
  // and shown/hidden by syncShippingSection() as physical items come and go —
  // shipping selectors themselves live in the order-lines block above.
  const shippingSection = h('div', { class: 'merch-shipping-section' }, [
    h('div', { class: 'merch-checkout-divider' }),
    h('h3', { class: 'merch-checkout-subhead', text: 'Shipping details' }),
    h('div', { class: 'merch-checkout-fields' }, [
      h('label', { class: 'merch-field' }, ['Name', nameInput]),
      h('label', { class: 'merch-field' }, ['Address line 1', addr1Input]),
      h('label', { class: 'merch-field' }, ['Address line 2', addr2Input]),
      // City / State / ZIP on one row.
      h('div', { class: 'merch-field-row' }, [
        h('label', { class: 'merch-field' }, ['Town / City', cityInput]),
        h('label', { class: 'merch-field' }, ['State', stateInput]),
        h('label', { class: 'merch-field' }, ['ZIP', zipInput]),
      ]),
      h('label', { class: 'merch-field' }, ['Country', countryInput]),
      h('label', { class: 'merch-field' }, ['Email (optional)', emailInput]),
    ]),
  ])
  function syncShippingSection() { shippingSection.style.display = hasPhysical() ? '' : 'none' }
  syncShippingSection()

  const noteWrap = h('div', { class: 'merch-checkout-fields' }, [
    h('label', { class: 'merch-field' }, ['Note (optional)', noteInput]),
  ])

  payBtn.addEventListener('click', () => {
    const shipping = hasPhysical()
    if (shipping) {
      const missing = missingShippingField()
      if (missing) return setStatus(status, 'error', `Please enter your ${missing}.`)
    }
    // One order per merchant. Freeze each group's totals + shipments now (the
    // checkout closures own chosenShipFor/totalsFor); runCheckout just pays.
    const groups = [...sectionEls.keys()].map((hex) => {
      const gLines = linesForMerchant(hex)
      const { subSats, shipSats, ok } = totalsFor(gLines)
      return {
        merchant: hex,
        lines: gLines.map(l => ({ coord: l.coord, qty: l.qty, product: l.product })),
        shipments: collectShipments(gLines),
        totalSats: subSats + shipSats,
        ok,
      }
    })
    runCheckout({
      groups, user, needsShipping: shipping, session,
      address: shipping ? composeAddress() : '',
      email: emailInput.value.trim(),
      note: noteInput.value.trim(),
      status, payBtn,
    })
  })

  const card = h('div', { class: 'merch-modal merch-modal-checkout' }, [
    closeButton(),
    h('h2', { class: 'merch-modal-title', text: 'Checkout' }),
    h('div', { class: 'merch-checkout-as', text: `Ordering as ${user.profile?.name || user.npub?.slice(0, 12) + '…' || 'you'}` }),
    multiNote,
    itemsWrap,
    grandTotals,
    shippingSection,
    noteWrap,
    status,
    payBtn,
    h('p', { class: 'merch-fineprint', text: 'Each seller receives an encrypted Nostr order and is paid over Lightning.' }),
  ])
  openModal(card)
}

function setStatus(statusEl, kind, msg) {
  statusEl.className = 'merch-checkout-status merch-status-' + kind
  statusEl.textContent = msg
}

async function runCheckout(ctx) {
  const { groups, user, needsShipping, address, email, note, status, payBtn, session } = ctx

  if (needsShipping && !address) {
    return setStatus(status, 'error', 'Please enter a shipping address.')
  }
  if (groups.some(g => !g.ok || g.totalSats <= 0)) {
    return setStatus(status, 'error', 'Could not compute a total — live BTC price unavailable. Try again shortly.')
  }

  payBtn.disabled = true
  // Per-message delivery diagnostics, surfaced (in debug) on the success screen
  // and on window.LBMerchLastOrder. Answers "did it actually send, and where?"
  const diag = []
  const logSend = (label, res) => {
    diag.push({ label, kind: res.kind, wrapId: res.wrapId, recipient: res.recipientHex,
      acked: res.acked, failed: res.failed, ndkOk: res.ndkOk })
    console.log(`[merch] sent ${label} (kind ${res.kind}) wrap=${res.wrapId.slice(0, 10)} → acked ${res.acked.length}/${res.relays.length}`,
      { acked: res.acked, failed: res.failed, ndkOutbox: res.ndkOk })
  }

  // Process each merchant as its own order + payment, sequentially (one wallet
  // approval per seller). Already-paid sellers are skipped on a retry, so a
  // partial failure never re-charges a seller who already went through.
  const results = []
  let anyFailure = false
  let anyUncertain = false
  for (const group of groups) {
    const hex = group.merchant
    let st = session.byMerchant.get(hex)
    if (!st) { st = { orderId: uuid(), orderPublished: false, paid: false, uncertain: false, totalSats: 0 }; session.byMerchant.set(hex, st) }
    if (st.paid) { results.push({ merchant: hex, orderId: st.orderId, totalSats: st.totalSats, ok: true }); continue }
    // A seller whose payment we couldn't confirm is NOT auto-retried — re-paying
    // a possibly-settled invoice is the double-charge we're preventing. Surface
    // it again as uncertain so the buyer resolves it out-of-band, but never send
    // another payment for it in this session.
    if (st.uncertain) {
      anyUncertain = true
      results.push({ merchant: hex, orderId: st.orderId, ok: false, uncertain: true,
        error: `Payment to ${st.sellerName || 'this seller'} couldn't be confirmed — check your wallet or with the seller before paying again.` })
      continue
    }

    try {
      await processMerchantOrder(group, st, { user, address, email, note, status, logSend })
      st.paid = true
      st.totalSats = group.totalSats
      results.push({ merchant: hex, orderId: st.orderId, totalSats: group.totalSats, ok: true })
    } catch (e) {
      if (e?.code === 'NO_WALLET') {
        setStatus(status, 'error', 'Connect a Lightning wallet in the popup, then press “Place order & pay” again.')
        payBtn.disabled = false
        return
      }
      if (e?.code === 'PAYMENT_UNCERTAIN') {
        // Latch it so subsequent passes skip (never re-pay) this seller.
        st.uncertain = true
        anyUncertain = true
        results.push({ merchant: hex, orderId: st.orderId, ok: false, uncertain: true, error: e.message })
        continue
      }
      console.error('[merch] merchant order failed', hex, e)
      anyFailure = true
      results.push({ merchant: hex, ok: false, error: friendlyError(e) })
      // Keep going: other sellers can still be paid; retry re-attempts this one.
    }
  }

  if (anyFailure || anyUncertain) {
    const failed = results.filter(r => !r.ok && !r.uncertain)
    const uncertain = results.filter(r => r.uncertain)
    const paid = results.filter(r => r.ok)
    if (uncertain.length) {
      // At least one payment we can't confirm. Lead with the don't-double-pay
      // warning. Only re-enable the button when there's a clean failure that's
      // genuinely safe to retry — a pure-uncertain result has nothing to retry.
      const parts = [
        `${uncertain.length} payment${uncertain.length > 1 ? 's' : ''} couldn't be confirmed — your wallet may already have been charged, so ${uncertain.length > 1 ? 'they' : 'it'} won't be retried automatically. Check your wallet (or with the seller) before paying again.`,
      ]
      if (paid.length) parts.unshift(`${paid.length} seller${paid.length > 1 ? 's' : ''} paid.`)
      if (failed.length) parts.push(`${failed.length} other seller${failed.length > 1 ? 's' : ''} failed and can be retried — press “Place order & pay”.`)
      setStatus(status, 'warn', parts.join(' '))
      payBtn.disabled = failed.length === 0
      return
    }
    setStatus(status, 'error', results.length === 1
      ? failed[0].error
      : `Paid ${paid.length} of ${results.length} sellers. Couldn't complete: ${failed.map(f => f.error).join('; ')}. Press “Place order & pay” to retry the rest.`)
    payBtn.disabled = false
    return
  }

  const grandTotal = results.reduce((a, r) => a + (r.totalSats || 0), 0)
  window.LBMerchLastOrder = { orders: results, grandTotal, diag }
  sessionStorage.removeItem(CART_KEY)
  updateCartBadge()
  showOrderSuccess(results, grandTotal, diag)
}

// One merchant's order: gift-wrapped kind-16 order → pay their Lightning
// address → kind-17 receipt + kind-14 human summary (+ buyer self-copy).
// Throws on failure (NO_WALLET propagates up to abort the whole run).
async function processMerchantOrder(group, st, shared) {
  const { user, address, email, note, status, logSend } = shared
  const hex = group.merchant
  const orderId = st.orderId
  const totalSats = group.totalSats

  const profile = await resolveMerchantProfile(hex)
  const sellerName = profile.name || 'the seller'
  st.sellerName = sellerName   // remembered for an uncertain re-surface message
  const payLud16 = paymentLud16ForMerchant(hex, profile)
  if (!payLud16) {
    throw new Error(`${profile.name || 'A seller'} in your cart hasn't published a Lightning address, so their payment can't be collected automatically yet.`)
  }

  // 1. Order (kind 16, type 1), gift-wrapped to this merchant. Guarded so a
  //    retry after a failed payment doesn't re-send the order.
  if (!st.orderPublished) {
    setStatus(status, 'working', `Encrypting your order to ${sellerName}… approve in your signer if it prompts.`)
    const orderTags = [
      ['p', hex],
      ['subject', 'New order'],
      ['type', '1'],
      ['order', orderId],
      ['amount', String(totalSats)],
      ...group.lines.map(l => ['item', l.coord, String(l.qty)]),
    ]
    // Gamma's order schema defines a single `shipping` tag, but per-item
    // shipping means several may apply. Repeated tags are tolerated; the
    // kind-14 summary itemizes which item ships with which method.
    for (const coord of [...new Set(group.shipments.map(s => s.coord))]) orderTags.push(['shipping', coord])
    if (address) orderTags.push(['address', address])
    if (email)   orderTags.push(['email', email])
    logSend(`Order → ${sellerName}`, await giftWrapAndPublish({ kind: 16, content: note || '', tags: orderTags }, user.pubkey, hex))
    st.orderPublished = true
  }

  // 2. Fetch this merchant's Lightning invoice and pay it — settlement-verified
  //    so an ambiguous NWC result (the payment settled on Lightning but the
  //    wallet's reply carrying the preimage was lost over a flaky relay) is
  //    NEVER mistaken for a clean failure the buyer can safely retry. That
  //    mistake re-pays a fresh invoice and double-charges the seller — it's the
  //    bug where one coffee order settled four times.
  setStatus(status, 'working', `Fetching Lightning invoice from ${sellerName}…`)
  const itemList = group.lines.map(l => `${l.qty}× ${l.product.title}`).join(', ')
  const { pr: invoice, verify } = await fetchInvoice(payLud16, totalSats, `LB merch order ${orderId.slice(0, 8)} — ${itemList}`)

  setStatus(status, 'working', `Approve the payment to ${sellerName} in your wallet…`)
  // NO_WALLET / WALLET_UNRESPONSIVE still throw (handled up in runCheckout);
  // genuine pay outcomes come back as a status instead of an exception.
  const payRes = await window.LBLogin.payInvoiceVerified(invoice, { verify })

  if (payRes.status === 'unsettled') {
    // Definitively not paid — the wallet wasn't charged, so a retry is safe.
    throw new Error(payRes.error && /insufficient|not enough|no funds|balance/i.test(payRes.error)
      ? 'Payment failed: insufficient balance.'
      : `Payment to ${sellerName} didn't go through — your wallet wasn't charged. You can retry.`)
  }
  if (payRes.status === 'uncertain') {
    // Payment may have settled but we couldn't confirm. Do NOT let the buyer
    // blind-retry this seller (that's the double-charge). Flag it so runCheckout
    // surfaces a warning and skips auto-retry for this merchant.
    const err = new Error(`Payment to ${sellerName} couldn't be confirmed — it may have already gone through, so it won't be retried automatically. Check your wallet (or with ${sellerName}) before paying again.`)
    err.code = 'PAYMENT_UNCERTAIN'
    throw err
  }
  // status === 'paid' — fall through to the receipt.

  // 3. Receipt (kind 17), gift-wrapped to this merchant.
  setStatus(status, 'working', `Confirming payment with ${sellerName}…`)
  const receiptTags = [
    ['p', hex],
    ['subject', 'order-receipt'],
    ['order', orderId],
    ['amount', String(totalSats)],
    ['payment', 'lightning', invoice, payRes?.preimage || ''],
  ]
  logSend(`Receipt → ${sellerName}`, await giftWrapAndPublish({ kind: 17, content: '', tags: receiptTags }, user.pubkey, hex))

  // 4. Human-readable kind-14 summary (what everyday DM clients render) to the
  //    seller, plus a buyer self-copy.
  const summaryText = buildOrderSummary({ orderId, lines: group.lines, totalSats, shipments: group.shipments, address, note, buyer: user, sellerName })
  const summaryRumor = {
    kind: 14,
    content: summaryText,
    tags: [['p', hex], ['subject', `New order ${orderId.slice(0, 8)}`]],
  }
  logSend(`Summary → ${sellerName}`, await giftWrapAndPublish(summaryRumor, user.pubkey, hex))
  try { logSend('Summary → you (self-copy)', await giftWrapAndPublish(summaryRumor, user.pubkey, user.pubkey)) }
  catch (e) { console.warn('[merch] buyer self-copy failed', e) }

  recordOrder({ orderId, totalSats, lines: group.lines, merchant: hex, shipping: [...new Set(group.shipments.map(s => s.coord))], ts: Date.now() })
}

// Human-readable order summary for the kind-14 chat DM the seller's
// everyday client will actually render.
function buildOrderSummary({ orderId, lines, totalSats, shipments = [], address, note, buyer, sellerName }) {
  const who = buyer?.profile?.name || (buyer?.npub ? buyer.npub.slice(0, 12) + '…' : 'a customer')
  const items = lines.map(l => `• ${l.qty}× ${l.product.title}`).join('\n')
  const parts = [
    `🛒 New order via Local Bitcoiners`,
    ...(sellerName && sellerName !== 'the seller' ? [`Seller: ${sellerName}`] : []),
    `From: ${who}`,
    ``,
    items,
    ``,
    `Total paid: ${fmtSats(totalSats)} ⚡`,
  ]
  // Per-item shipping: itemize which method each product ships with so the
  // seller can fulfill without guessing.
  if (shipments.length) {
    parts.push(`Shipping:`)
    for (const s of shipments) parts.push(`• ${s.productTitle}: ${s.optionTitle}`)
  }
  if (address)  parts.push(`Ship to:\n${address}`)
  if (note)     parts.push(`Note: ${note}`)
  parts.push(``, `Order ID: ${orderId}`)
  return parts.join('\n')
}

function friendlyError(e) {
  const m = String(e?.message || e || 'Something went wrong')
  if (/insufficient|balance/i.test(m)) return 'Payment failed: insufficient balance.'
  if (/sign in/i.test(m)) return 'Please sign in with Nostr first.'
  return 'Checkout failed: ' + m
}

// NIP-44 encrypt a string to `recipientHex`. Prefers the browser
// extension's nip44 directly: NDK's NIP-07 signer routes encryption
// through an internal queue with "call already executing" retries that can
// stall, which surfaced as checkout hanging on the seal. The direct call
// removes that queue from the path. Falls back to the NDK signer for
// nsec / NIP-46 logins that don't expose window.nostr.nip44.
async function encryptNip44(ndk, recipientHex, plaintext) {
  if (typeof window !== 'undefined' && window.nostr?.nip44?.encrypt) {
    try {
      console.log('[merch] encrypting seal via window.nostr.nip44 →', recipientHex.slice(0, 8) + '…')
      return await window.nostr.nip44.encrypt(recipientHex, plaintext)
    } catch (e) {
      console.warn('[merch] window.nostr.nip44.encrypt failed; falling back to NDK signer', e)
    }
  }
  const kind = ndk.signer?.constructor?.name || 'unknown'
  console.log(`[merch] encrypting seal via ${kind} →`, recipientHex.slice(0, 8) + '…')
  return await ndk.signer.encrypt(ndk.getUser({ pubkey: recipientHex }), plaintext, 'nip44')
}

// ── Gift-wrap (NIP-17 / NIP-59) ──────────────────────────────────────
// Hand-build the kind-13 seal with the user's real signer (so the
// merchant sees who ordered), then let nip59.createWrap generate the
// ephemeral kind-1059 outer wrap. Publishes the wrap to relays.
async function giftWrapAndPublish(rumorTemplate, buyerHex, recipientHex = MERCHANT_HEX) {
  const ndk = window.LBLogin.getNDK()
  if (!ndk?.signer) throw new Error('No signer available — please sign in again.')

  const rumor = {
    kind: rumorTemplate.kind,
    content: rumorTemplate.content || '',
    tags: rumorTemplate.tags || [],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: buyerHex,
  }
  rumor.id = getEventHash(rumor) // rumor stays unsigned per NIP-59

  // Seal is encrypted to *this copy's* recipient (merchant, or the buyer
  // themselves for the self-copy) and signed by the buyer. Bounded so a
  // stalled signer can't hang the "Encrypting your order…" step forever.
  const t0 = Date.now()
  const sealContent = await withTimeout(encryptNip44(ndk, recipientHex, JSON.stringify(rumor)), 30000, null)
  if (sealContent == null) {
    const usingExtension = typeof window !== 'undefined' && !!window.nostr
    const who = usingExtension ? 'your Nostr browser extension' : (ndk.signer?.constructor?.name || 'your signer')
    throw new Error(`${who} didn't respond when encrypting your order. Make sure it's unlocked${usingExtension ? ' (click the extension icon and unlock it)' : ''}, then try again.`)
  }
  console.log(`[merch] seal encrypted in ${Date.now() - t0}ms`)
  const signedSeal = await window.LBLogin.signEvent({
    kind: 13,
    content: sealContent,
    created_at: randomPastTs(),
    tags: [],
  })
  const wrap = nip59.createWrap(signedSeal, recipientHex)
  const pub = await publishWrap(wrap, recipientHex)
  return { wrap, rumorId: rumor.id, kind: rumor.kind, recipientHex, ...pub }
}

// Resolve the relays a NIP-17 gift-wrap should be delivered to: the
// merchant's kind-10050 DM-relay list if published, else their kind-10002
// write relays, else a sensible default. Cached for the page session.
//
// This matters: NDK's publishEvent targets the *buyer's* relays, but
// NIP-17 says a DM must land on the *recipient's* inbox relays — that's
// where the merchant's client reads. Publishing only to buyer relays is
// why an order can settle yet never appear in the seller's DMs.
const _dmRelaysCache = new Map()
async function resolveDMRelays(pubkey) {
  if (_dmRelaysCache.has(pubkey)) return _dmRelaysCache.get(pubkey)
  const pool = new SimplePool()
  let dm = [], write = []
  try {
    const evs = await withTimeout(
      pool.querySync(RELAYS, { kinds: [10050, 10002], authors: [pubkey] }),
      6000, [],
    )
    // newest of each kind
    const newest = {}
    for (const ev of evs) {
      if (!newest[ev.kind] || ev.created_at > newest[ev.kind].created_at) newest[ev.kind] = ev
    }
    if (newest[10050]) {
      dm = newest[10050].tags.filter(t => t[0] === 'relay' && /^wss:\/\//i.test(t[1] || '')).map(t => t[1])
    }
    if (newest[10002]) {
      write = newest[10002].tags
        .filter(t => t[0] === 'r' && /^wss:\/\//i.test(t[1] || '') && (!t[2] || t[2] === 'write' || t[2] === 'read'))
        .map(t => t[1])
    }
  } catch { /* fall through to defaults */ }
  finally { try { pool.close(RELAYS) } catch {} }

  const chosen = (dm.length ? dm : (write.length ? write : DEFAULT_DM_RELAYS)).slice(0, 8)
  // Always include the defaults too — redundancy costs nothing and keeps
  // delivery working while a relay list settles.
  const relays = [...new Set([...chosen, ...DEFAULT_DM_RELAYS])]
  _dmRelaysCache.set(pubkey, relays)
  return relays
}

// Publish a (fully signed) gift-wrap to the merchant's inbox relays, plus
// the buyer's outbox via NDK for redundancy. Best-effort: resolves once at
// least one relay accepts; throws only if nothing accepted anywhere, so a
// silent zero-delivery can't masquerade as success.
async function publishWrap(wrap, recipientHex = MERCHANT_HEX) {
  const relays = await resolveDMRelays(recipientHex)
  const pool = new SimplePool()
  const acked = [], failed = []
  try {
    // Bound each relay publish: a relay that accepts the socket but never
    // returns an OK would otherwise leave the promise pending forever and
    // hang checkout on "Sending your order…". Treat a timeout as a failure.
    const proms = pool.publish(relays, wrap).map((p, i) =>
      withTimeout(p.then(() => 'ok').catch(() => 'err'), 8000, 'timeout'))
    const results = await Promise.all(proms)
    results.forEach((r, i) => { (r === 'ok' ? acked : failed).push(relays[i]) })
  } catch (e) {
    console.warn('[merch] gift-wrap relay publish error', e)
  } finally { try { pool.close(relays) } catch {} }

  // NDK outbox too (buyer's own relays) — harmless redundancy. Also bounded
  // so a stalled NDK publish can't hang the flow.
  let ndkOk = false
  try {
    ndkOk = !!(await withTimeout(window.LBLogin.publishEvent(wrap).then(() => true).catch(() => false), 8000, false))
  } catch (e) { console.warn('[merch] NDK publish failed', e) }

  if (acked.length === 0 && !ndkOk) {
    throw new Error('Could not reach any relay to deliver your order to the seller.')
  }
  return { wrapId: wrap.id, relays, acked, failed, ndkOk }
}

// ── Lightning (LNURL-pay against MERCH_PAYMENT_LUD16) ────────────────
const LUD16_RE = /^[a-zA-Z0-9_.+-]+@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/

function isBolt11(s) {
  return typeof s === 'string' && /^ln(bc|tb|bcrt)[0-9]/i.test(s.trim())
}

// Cross-domain LNURL callbacks we explicitly trust, keyed by lud16 domain.
// Mirrors the widget's boostagram.js allowlist: LUD-06 treats `callback` as
// opaque, but constraining it to the lud16 host stops a compromised seller
// endpoint redirecting the invoice request to an arbitrary origin. Each
// entry gives up that protection for one provider — verify before adding.
const LNURL_CALLBACK_HOST_ALLOWLIST = {
  // Wallet of Satoshi serves lud16 from walletofsatoshi.com, invoices from
  // livingroomofsatoshi.com (its long-standing API domain).
  'walletofsatoshi.com': ['livingroomofsatoshi.com'],
}

const LNURL_TIMEOUT = Symbol('lnurl-timeout')

// Bounded fetch → parsed JSON. Seller lud16s come from merchant kind-0
// profiles (third-party data), so a stalling or dead endpoint must fail
// the checkout step cleanly instead of hanging it forever.
//
// One automatic retry with a short backoff: LNURL providers behind CDNs
// intermittently fail browser requests (challenge/5xx without CORS looks
// like a hard fetch error) while healthy for everyone else — the
// 2026-07-17 getalby wobble. A served LNURL ERROR is NOT retried (it's a
// definitive answer, thrown from the parse step below).
async function fetchLnurlJson(url, what) {
  let res = await withTimeout(fetch(url).catch(() => null), 10000, LNURL_TIMEOUT)
  if (res === LNURL_TIMEOUT || !res || !res.ok) {
    await new Promise((r) => setTimeout(r, 1200))
    res = await withTimeout(fetch(url).catch(() => null), 10000, LNURL_TIMEOUT)
  }
  if (res === LNURL_TIMEOUT) throw new Error(`${what} timed out — the seller's Lightning provider isn't responding.`)
  if (!res || !res.ok) throw new Error(`${what} failed — the seller's Lightning provider couldn't be reached.`)
  const data = await res.json().catch(() => null)
  if (!data || typeof data !== 'object') throw new Error(`${what} returned an invalid response.`)
  if (data.status === 'ERROR') throw new Error(data.reason || `${what} was rejected by the seller's Lightning provider.`)
  return data
}

async function fetchInvoice(lud16, amountSats, comment) {
  if (!LUD16_RE.test(lud16)) throw new Error('Seller Lightning address is invalid.')
  const [name, domain] = lud16.split('@')
  const meta = await fetchLnurlJson(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`, 'Pay-endpoint lookup')
  if (meta.tag !== 'payRequest' || typeof meta.callback !== 'string' || !meta.callback.startsWith('https://')) {
    throw new Error('Seller Lightning address did not return a pay endpoint.')
  }
  // Constrain the callback host to the lud16 domain (or a subdomain), plus
  // the explicit exceptions above — same rule as the boost path.
  const lud16Host = domain.toLowerCase()
  let cb
  try {
    cb = new URL(meta.callback)
  } catch {
    throw new Error('Seller Lightning address returned an invalid callback URL.')
  }
  const cbHost = cb.hostname.toLowerCase()
  const allowedHosts = LNURL_CALLBACK_HOST_ALLOWLIST[lud16Host] || []
  if (cbHost !== lud16Host && !cbHost.endsWith('.' + lud16Host) && !allowedHosts.includes(cbHost)) {
    throw new Error('Seller Lightning address callback points at an unexpected host.')
  }
  const amountMsat = amountSats * 1000
  if (amountMsat < (meta.minSendable || 0) || amountMsat > (meta.maxSendable || Infinity)) {
    throw new Error('Order total is outside the seller wallet’s accepted range.')
  }
  cb.searchParams.set('amount', String(amountMsat))
  // Attach the identifying comment, truncated to whatever the endpoint
  // allows (LUD-12). Default 0 means comments unsupported → omit.
  const maxComment = typeof meta.commentAllowed === 'number' ? meta.commentAllowed : 0
  if (comment && maxComment > 0) {
    cb.searchParams.set('comment', comment.slice(0, maxComment))
  }
  const res = await fetchLnurlJson(cb.toString(), 'Invoice request')
  if (!res.pr || !isBolt11(res.pr)) throw new Error('Seller wallet did not return a valid invoice.')
  // LUD-21 verify URL, when the endpoint provides one. Kept so the pay
  // step can confirm settlement out-of-band after an ambiguous NWC
  // attempt — the difference between a safe retry and a double-charge.
  const verify = (typeof res.verify === 'string' && res.verify.startsWith('https://')) ? res.verify : null
  return { pr: res.pr, verify }
}

// ── Order bookkeeping + success ──────────────────────────────────────
function recordOrder(o) {
  try {
    const list = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]')
    list.unshift({
      orderId: o.orderId, totalSats: o.totalSats, ts: o.ts, shipping: o.shipping, merchant: o.merchant || null,
      items: o.lines.map(l => ({ coord: l.coord, title: l.product.title, qty: l.qty })),
    })
    localStorage.setItem(ORDERS_KEY, JSON.stringify(list.slice(0, 50)))
  } catch {}
}

function merchDebugOn() {
  try {
    return /[?&]debug\b/.test(location.search) || localStorage.getItem('lb_merch_debug') === '1'
  } catch { return false }
}

function showOrderSuccess(orders, grandTotal, diag = []) {
  const multi = orders.length > 1
  // Collapsible delivery diagnostics: every message we sent, its kind, the
  // gift-wrap id, and which relays accepted it. Lets the seller confirm
  // (e.g. on njump.me / a relay explorer) that the events really landed.
  const diagBody = h('div', { class: 'merch-diag-body' },
    diag.map(d => h('div', { class: 'merch-diag-row' }, [
      h('div', { class: 'merch-diag-label', text: `${d.label} · kind ${d.kind}` }),
      h('div', { class: 'merch-diag-meta', text:
        `wrap ${d.wrapId.slice(0, 12)}… → ${d.acked.length} relay${d.acked.length === 1 ? '' : 's'}${d.ndkOk ? ' (+outbox)' : ''}` }),
      h('div', { class: 'merch-diag-relays', text: d.acked.join(', ') || '(no direct relay ack)' }),
      d.failed.length ? h('div', { class: 'merch-diag-fail', text: `failed: ${d.failed.join(', ')}` }) : null,
    ])))

  // Visible only in debug mode (?debug in the URL or lb_merch_debug in
  // localStorage). Normal buyers never see relay/wrap internals; the data
  // still lands on window.LBMerchLastOrder + the console for support.
  const diagPanel = (diag.length && merchDebugOn()) ? h('details', { class: 'merch-diag' }, [
    h('summary', { text: 'Delivery details' }),
    diagBody,
    h('p', { class: 'merch-fineprint', text: 'Tip: paste a wrap id into a relay explorer to confirm it’s live. Order details also on window.LBMerchLastOrder.' }),
  ]) : null

  const card = h('div', { class: 'merch-modal merch-modal-success' }, [
    closeButton(),
    h('div', { class: 'merch-success-check', text: '✓' }),
    h('h2', { class: 'merch-modal-title', text: multi ? 'Orders placed!' : 'Order placed!' }),
    h('p', { text: `You paid ${fmtSats(grandTotal)}${multi ? ` across ${orders.length} sellers` : ''}. ${multi ? 'Each seller has' : 'The seller has'} your order over an encrypted Nostr message and will follow up about fulfillment.` }),
    h('div', { class: 'merch-order-ids' }, orders.map(o =>
      h('div', { class: 'merch-order-id' }, ['Order ID: ', h('code', { text: o.orderId })]))),
    diagPanel,
    h('button', { class: 'merch-btn merch-btn-primary', 'data-merch-close': '' }, 'Done'),
  ])
  openModal(card)
  try { window.LBLogin?.confetti?.() } catch {}
}

// ── Exports ──────────────────────────────────────────────────────────
// This module has no page of its own and boots nothing on import: the Show
// Merch section of the /feeds Marketplace tab replaced the /merch storefront
// (lb-v48), so every consumer drives its own fetch and render through the
// exports below.

// Reusable pieces for the homepage merch marquee (home-merch.js): the shared
// catalog fetch/state, the price→sats helpers, and the exact product detail
// modal so a card click on the homepage opens the same modal as /feeds.
export { fetchCatalog, catalog, openProductModal, toSats, getBtcUsd, fmtSats, priceLabel }

// Additional reusable pieces for the /feeds community marketplace
// (feeds-market.js): the house-merchant identity + payment routing, the
// catalog-merge entry point, the shared cart/checkout, and the NIP-17
// gift-wrap send used for buyer↔seller DMs.
export {
  MERCHANT_HEX,
  ingestListings,
  addToCart,
  openCart,
  openCheckout,
  imageCarousel,
  closeModal,
  shippingForProduct,
  paymentLud16ForMerchant,
  resolveMerchantProfile,
  giftWrapAndPublish,
  resolveDMRelays,
}
