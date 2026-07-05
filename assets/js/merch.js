/* Local Bitcoiners merch storefront — NIP-99 + Gamma-spec.
 *
 * READ-ONLY catalog: products (kind 30402), collections (30405) and
 * shipping options (30406) are fetched from the show's merchant npub.
 * Listings are created/edited elsewhere (plebeian.market, mynostr, …);
 * this page never writes them.
 *
 * CHECKOUT is a full Gamma-spec order flow, but the page never touches
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

// ── Constants ────────────────────────────────────────────────────────
const MERCHANT_NPUB = 'npub1cvcgs83gw6pcrhvtmlf8gdqaegx93qkznwry96jteqhh2cexgkfq45rtya'
// Decoded at module load; throws loudly if the npub is ever mistyped.
const MERCHANT_HEX = (() => {
  const { type, data } = nip19.decode(MERCHANT_NPUB)
  if (type !== 'npub') throw new Error('MERCHANT_NPUB is not an npub')
  return data
})()

// Same relay set the boost feed uses (boosts-thread.js).
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
]

// Where to drop NIP-17 gift-wraps when the merchant has published no
// kind-10050 DM-relay list (and no usable 10002). Write-friendly relays
// the merchant's DM client is likely to read.
const DEFAULT_DM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
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
// need a spot rate. Cached for the page session. Two independent sources
// so a single outage doesn't block checkout.
let _rate = null
let _ratePromise = null
async function getBtcUsd() {
  if (_rate) return _rate
  if (_ratePromise) return _ratePromise
  _ratePromise = (async () => {
    const sources = [
      async () => {
        const j = await fetch('https://mempool.space/api/v1/prices').then(r => r.json())
        return Number(j.USD)
      },
      async () => {
        const j = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(r => r.json())
        return Number(j?.data?.amount)
      },
    ]
    for (const src of sources) {
      try {
        const v = await src()
        if (Number.isFinite(v) && v > 0) { _rate = v; return v }
      } catch { /* try next */ }
    }
    return null
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

// ── Tag parsing ──────────────────────────────────────────────────────
const firstTag = (ev, name) => (ev.tags.find(t => t[0] === name) || [])[1]
const allTags  = (ev, name) => ev.tags.filter(t => t[0] === name)

function parseProduct(ev) {
  const d = firstTag(ev, 'd')
  if (!d) return null
  const priceTag = ev.tags.find(t => t[0] === 'price') || []
  const typeTag  = ev.tags.find(t => t[0] === 'type')  || []
  const images = allTags(ev, 'image')
    .map(t => t[1]).filter(isHttpUrl)
  return {
    d,
    coord: `30402:${MERCHANT_HEX}:${d}`,
    title: firstTag(ev, 'title') || '(untitled)',
    summary: firstTag(ev, 'summary') || '',
    description: typeof ev.content === 'string' ? ev.content : '',
    priceAmount: Number(priceTag[1]),
    priceCurrency: priceTag[2] || 'USD',
    priceFreq: priceTag[3] || '',
    goods: (typeTag[2] || 'digital').toLowerCase(),       // physical | digital
    visibility: (firstTag(ev, 'visibility') || 'on-sale').toLowerCase(),
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
    coord: `30406:${MERCHANT_HEX}:${d}`,
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
    coord: `30405:${MERCHANT_HEX}:${d}`,
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

  // Replaceable events: keep newest per (kind:d).
  const newest = new Map()
  for (const ev of events) {
    const d = firstTag(ev, 'd')
    if (!d) continue
    const key = `${ev.kind}:${d}`
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
// The nav owns the badge so the count shows on every page, not just /merch.
function updateCartBadge() {
  window.dispatchEvent(new Event('lb-cart-changed'))
}

// ── Rendering: storefront grid ───────────────────────────────────────
function badgeFor(p) {
  if (p.visibility === 'pre-order') return h('span', { class: 'merch-badge merch-badge-pre', text: 'Pre-order' })
  if (p.stock === 0) return h('span', { class: 'merch-badge merch-badge-out', text: 'Sold out' })
  return null
}

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

function productCard(p) {
  const media = h('div', { class: 'merch-card-media' },
    p.images.length
      ? imageCarousel(p.images, p.title, { className: 'merch-card-carousel' }).wrap
      : h('div', { class: 'merch-card-noimg', text: '🛍️' }))
  const badge = badgeFor(p)
  if (badge) media.appendChild(badge)

  const sub = h('div', { class: 'merch-card-sub' }, priceLabel(p.priceAmount, p.priceCurrency))
  applySatHint(sub, p) // appends "≈ N sats" once the rate resolves

  return h('div', {
    class: 'merch-card',
    role: 'button',
    tabindex: '0',
    onclick: () => openProductModal(p),
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openProductModal(p) } },
  }, [
    media,
    h('div', { class: 'merch-card-body' }, [
      h('h3', { class: 'merch-card-title', text: p.title }),
      p.summary ? h('p', { class: 'merch-card-summary', text: p.summary }) : null,
      sub,
    ]),
  ])
}

// Append a "≈ N sats" hint to a price element for fiat-priced items.
async function applySatHint(el, p) {
  const c = String(p.priceCurrency || 'USD').toUpperCase()
  if (c === 'SAT' || c === 'SATS' || c === 'BTC') return
  const rate = await getBtcUsd()
  const sats = toSats(p.priceAmount, p.priceCurrency, rate)
  if (sats != null) el.appendChild(h('span', { class: 'merch-sat-hint', text: `  ≈ ${fmtSats(sats)}` }))
}

function renderGrid() {
  const grid = document.getElementById('merch-grid')
  const loading = document.getElementById('merch-loading')
  const empty = document.getElementById('merch-empty')
  loading.style.display = 'none'
  grid.innerHTML = ''
  if (!catalog.products.length) {
    empty.style.display = 'block'
    return
  }
  empty.style.display = 'none'
  for (const p of catalog.products) grid.appendChild(productCard(p))
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

function npubChip(npub, hex) {
  let label = npub.slice(0, 10) + '…' + npub.slice(-4)   // until the name resolves
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

// Resolve a hex pubkey → display name from its kind-0. Cached per session
// (by hex) so repeat mentions don't re-query the relays.
const _profileNameCache = new Map()   // hex → Promise<string|null>
function resolveProfileName(hex) {
  if (_profileNameCache.has(hex)) return _profileNameCache.get(hex)
  const promise = (async () => {
    const pool = new SimplePool()
    try {
      const ev = await withTimeout(pool.get(RELAYS, { kinds: [0], authors: [hex] }), 6000, null)
      if (!ev) return null
      const meta = JSON.parse(ev.content || '{}')
      const name = meta.display_name || meta.displayName || meta.name
      return (typeof name === 'string' && name.trim()) ? name.trim() : null
    } catch { return null }
    finally { try { pool.close(RELAYS) } catch {} }
  })()
  _profileNameCache.set(hex, promise)
  return promise
}

// ── Product detail modal ─────────────────────────────────────────────
function openProductModal(p) {
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

  const card = h('div', { class: 'merch-modal merch-modal-detail' }, [
    closeButton(),
    gallery,
    h('div', { class: 'merch-detail-info' }, [
      h('h2', { class: 'merch-detail-title', text: p.title }),
      price,
      p.stock != null && p.stock > 0 ? h('div', { class: 'merch-stock', text: `${p.stock} in stock` }) : null,
      p.description ? renderDescription(p.description) : null,
      specs,
      shipInfo,
      h('div', { class: 'merch-detail-actions' }, [
        h('label', { class: 'merch-qty-label' }, ['Qty ', qtyInput]),
        addBtn, buyBtn,
      ]),
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

  function computeTotal() {
    let sats = 0, ok = true
    for (const l of lines) {
      const s = toSats(l.product.priceAmount, l.product.priceCurrency, rate)
      if (s == null) { ok = false } else sats += s * l.qty
    }
    // Shipping is charged once per physical line (not per unit), matching
    // the Gamma/Plebeian model.
    for (const l of lines) {
      if (l.product.goods !== 'physical') continue
      const choice = chosenShipFor(l.coord)
      if (!choice) continue
      const ss = shipChoiceSats(l.product, choice, rate)
      if (ss == null) ok = false; else sats += ss
    }
    return { sats, ok }
  }

  // The per-line shipping selections to hand to runCheckout / the order
  // message. One entry per physical line that has a chosen method.
  function collectShipments() {
    const out = []
    for (const l of lines) {
      if (l.product.goods !== 'physical') continue
      const choice = chosenShipFor(l.coord)
      if (choice) out.push({ productTitle: l.product.title, coord: choice.option.coord, optionTitle: choice.option.title })
    }
    return out
  }

  // ── Order lines (top) ──
  // Each cart line as an expressive card: thumbnail, name, price, and — for
  // physical goods — its own shipping selector inline. The address/details
  // form sits below these (see modal assembly).
  const cardEls = new Map()   // coord → card element, so removal can drop it
  const itemsWrap = h('div', { class: 'merch-checkout-items' })
  for (const l of lines) itemsWrap.appendChild(buildItemCard(l))

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
    lines.splice(idx, 1)
    setCartQty(l.coord, 0)
    shipState.delete(l.coord)
    cardEls.get(l.coord)?.remove()
    cardEls.delete(l.coord)
    if (!lines.length) { closeModal(); openCart(); return }
    renderTotals()
    syncShippingSection()
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
  const totals = h('div', { class: 'merch-checkout-summary' })
  function renderTotals() {
    totals.innerHTML = ''
    let subSats = 0, subOk = true
    for (const l of lines) {
      const s = toSats(l.product.priceAmount, l.product.priceCurrency, rate)
      if (s == null) subOk = false; else subSats += s * l.qty
    }
    totals.appendChild(h('div', { class: 'merch-sum-line' }, [
      h('span', { text: 'Subtotal' }),
      h('span', { text: subOk ? fmtSats(subSats) : '—' }),
    ]))
    if (hasPhysical()) {
      let shipSats = 0, shipOk = true
      for (const l of lines) {
        if (l.product.goods !== 'physical') continue
        const choice = chosenShipFor(l.coord)
        if (!choice) continue
        const ss = shipChoiceSats(l.product, choice, rate)
        if (ss == null) shipOk = false; else shipSats += ss
      }
      totals.appendChild(h('div', { class: 'merch-sum-line merch-sum-ship' }, [
        h('span', { text: 'Shipping' }),
        h('span', { text: shipOk ? fmtSats(shipSats) : '—' }),
      ]))
    }
    const { sats, ok } = computeTotal()
    totals.appendChild(h('div', { class: 'merch-sum-line merch-sum-total' }, [
      h('span', { text: 'Total' }),
      h('strong', { text: ok ? fmtSats(sats) : 'unavailable' }),
    ]))
  }
  renderTotals()

  const status = h('div', { class: 'merch-checkout-status' })
  const payBtn = h('button', { class: 'merch-btn merch-btn-primary' }, [boltIcon(), 'Place order & pay'])

  // Persists across pay retries (e.g. after a NO_WALLET prompt) so we
  // reuse one order id and never re-publish the order message twice.
  const session = { orderId: uuid(), orderPublished: false }

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
    runCheckout({
      lines, rate, user, needsShipping: shipping, session,
      shipments: collectShipments(),
      address: shipping ? composeAddress() : '',
      email: emailInput.value.trim(),
      note: noteInput.value.trim(),
      computeTotal, status, payBtn,
    })
  })

  const card = h('div', { class: 'merch-modal merch-modal-checkout' }, [
    closeButton(),
    h('h2', { class: 'merch-modal-title', text: 'Checkout' }),
    h('div', { class: 'merch-checkout-as', text: `Ordering as ${user.profile?.name || user.npub?.slice(0, 12) + '…' || 'you'}` }),
    itemsWrap,
    totals,
    shippingSection,
    noteWrap,
    status,
    payBtn,
    h('p', { class: 'merch-fineprint', text: 'Your order is sent as an encrypted Nostr message to the seller and paid over Lightning.' }),
  ])
  openModal(card)
}

function setStatus(statusEl, kind, msg) {
  statusEl.className = 'merch-checkout-status merch-status-' + kind
  statusEl.textContent = msg
}

async function runCheckout(ctx) {
  const { lines, user, needsShipping, shipments = [], address, email, note, computeTotal, status, payBtn, session } = ctx

  if (needsShipping && !address) {
    return setStatus(status, 'error', 'Please enter a shipping address.')
  }
  const { sats: totalSats, ok } = computeTotal()
  if (!ok || totalSats <= 0) {
    return setStatus(status, 'error', 'Could not compute a total — live BTC price unavailable. Try again shortly.')
  }

  payBtn.disabled = true
  const orderId = session.orderId
  // Per-message delivery diagnostics, surfaced in the success screen and
  // on window.LBMerchLastOrder for inspection. Answers "did it actually
  // send, and to which relays?" without guessing.
  const diag = []
  const logSend = (label, res) => {
    diag.push({ label, kind: res.kind, wrapId: res.wrapId, recipient: res.recipientHex,
      acked: res.acked, failed: res.failed, ndkOk: res.ndkOk })
    console.log(`[merch] sent ${label} (kind ${res.kind}) wrap=${res.wrapId.slice(0, 10)} → acked ${res.acked.length}/${res.relays.length}`,
      { acked: res.acked, failed: res.failed, ndkOutbox: res.ndkOk })
  }

  try {
    // 1. Publish the order (kind 16, type 1), gift-wrapped to merchant.
    //    Guarded so a pay retry (after connecting a wallet) doesn't send
    //    the merchant a second, duplicate order.
    if (!session.orderPublished) {
      setStatus(status, 'working', 'Encrypting your order… approve the request in your signer if it prompts.')
      const orderTags = [
        ['p', MERCHANT_HEX],
        ['subject', 'New order'],
        ['type', '1'],
        ['order', orderId],
        ['amount', String(totalSats)],
        ...lines.map(l => ['item', l.coord, String(l.qty)]),
      ]
      // Gamma's order schema defines a single `shipping` tag, but per-item
      // shipping means several methods may apply. Repeated `shipping` tags are
      // tolerated by clients and keep the machine-readable order complete; the
      // kind-14 summary (below) itemizes which item uses which method.
      for (const coord of [...new Set(shipments.map(s => s.coord))]) orderTags.push(['shipping', coord])
      if (address)  orderTags.push(['address', address])
      if (email)    orderTags.push(['email', email])
      logSend('Order → seller', await giftWrapAndPublish({ kind: 16, content: note || '', tags: orderTags }, user.pubkey))
      session.orderPublished = true
    }

    // 2. Fetch a Lightning invoice from the merchant lud16 (Gamma
    //    "automatic" mode) and pay it via the connected wallet.
    setStatus(status, 'working', 'Fetching Lightning invoice…')
    // Identifying comment so the order is recognizable in the wallet's
    // incoming-payment log: order id + items. fetchInvoice truncates to
    // whatever the LNURL endpoint allows.
    const itemList = lines.map(l => `${l.qty}× ${l.product.title}`).join(', ')
    const payComment = `LB merch order ${orderId.slice(0, 8)} — ${itemList}`
    const invoice = await fetchInvoice(MERCH_PAYMENT_LUD16, totalSats, payComment)

    setStatus(status, 'working', 'Approve the payment in your wallet…')
    let payRes
    try {
      payRes = await window.LBLogin.payInvoice(invoice)
    } catch (e) {
      if (e?.code === 'NO_WALLET') {
        setStatus(status, 'error', 'Connect a Lightning wallet in the popup, then press “Place order & pay” again.')
        payBtn.disabled = false
        return
      }
      throw e
    }

    // 3. Send the payment receipt (kind 17), gift-wrapped to merchant.
    setStatus(status, 'working', 'Confirming payment with the seller…')
    const receiptTags = [
      ['p', MERCHANT_HEX],
      ['subject', 'order-receipt'],
      ['order', orderId],
      ['amount', String(totalSats)],
      ['payment', 'lightning', invoice, payRes?.preimage || ''],
    ]
    logSend('Receipt → seller', await giftWrapAndPublish({ kind: 17, content: '', tags: receiptTags }, user.pubkey))

    // 4. Also send a plain NIP-17 chat message (kind 14) carrying a
    //    human-readable summary. The kind-16/17 above are only rendered by
    //    Gamma-aware merchant clients; a kind-14 shows up in the seller's
    //    everyday DM inbox (0xchat, Damus, mynostr, …) so they actually
    //    notice the order.
    const summaryText = buildOrderSummary({ orderId, lines, totalSats, shipments, address, note, buyer: user })
    const summaryRumor = {
      kind: 14,
      content: summaryText,
      tags: [['p', MERCHANT_HEX], ['subject', `New order ${orderId.slice(0, 8)}`]],
    }
    logSend('Summary → seller', await giftWrapAndPublish(summaryRumor, user.pubkey))   // → seller inbox
    // Self-copy so the buyer sees the order in their own DM client too
    // (NIP-17 sender copy). Best-effort — never block the success path.
    try { logSend('Summary → you (self-copy)', await giftWrapAndPublish(summaryRumor, user.pubkey, user.pubkey)) }
    catch (e) { console.warn('[merch] buyer self-copy failed', e) }

    window.LBMerchLastOrder = { orderId, totalSats, diag }

    recordOrder({ orderId, totalSats, lines, shipping: [...new Set(shipments.map(s => s.coord))], ts: Date.now() })
    sessionStorage.removeItem(CART_KEY)
    updateCartBadge()

    showOrderSuccess(orderId, totalSats, diag)
  } catch (e) {
    console.error('[merch] checkout failed', e)
    setStatus(status, 'error', friendlyError(e))
    payBtn.disabled = false
  }
}

// Human-readable order summary for the kind-14 chat DM the seller's
// everyday client will actually render.
function buildOrderSummary({ orderId, lines, totalSats, shipments = [], address, note, buyer }) {
  const who = buyer?.profile?.name || (buyer?.npub ? buyer.npub.slice(0, 12) + '…' : 'a customer')
  const items = lines.map(l => `• ${l.qty}× ${l.product.title}`).join('\n')
  const parts = [
    `🛒 New Local Bitcoiners order`,
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

async function fetchInvoice(lud16, amountSats, comment) {
  if (!LUD16_RE.test(lud16)) throw new Error('Seller Lightning address is invalid.')
  const [name, domain] = lud16.split('@')
  const meta = await fetch(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`).then(r => r.json())
  if (meta.tag !== 'payRequest' || !meta.callback) throw new Error('Seller Lightning address did not return a pay endpoint.')
  const amountMsat = amountSats * 1000
  if (amountMsat < (meta.minSendable || 0) || amountMsat > (meta.maxSendable || Infinity)) {
    throw new Error('Order total is outside the seller wallet’s accepted range.')
  }
  const cb = new URL(meta.callback)
  cb.searchParams.set('amount', String(amountMsat))
  // Attach the identifying comment, truncated to whatever the endpoint
  // allows (LUD-12). Default 0 means comments unsupported → omit.
  const maxComment = typeof meta.commentAllowed === 'number' ? meta.commentAllowed : 0
  if (comment && maxComment > 0) {
    cb.searchParams.set('comment', comment.slice(0, maxComment))
  }
  const res = await fetch(cb.toString()).then(r => r.json())
  if (!res.pr || !isBolt11(res.pr)) throw new Error('Seller wallet did not return a valid invoice.')
  return res.pr
}

// ── Order bookkeeping + success ──────────────────────────────────────
function recordOrder(o) {
  try {
    const list = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]')
    list.unshift({
      orderId: o.orderId, totalSats: o.totalSats, ts: o.ts, shipping: o.shipping,
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

function showOrderSuccess(orderId, totalSats, diag = []) {
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
    h('h2', { class: 'merch-modal-title', text: 'Order placed!' }),
    h('p', { text: `You paid ${fmtSats(totalSats)}. The seller has your order over an encrypted Nostr message and will follow up about fulfillment.` }),
    h('div', { class: 'merch-order-id' }, ['Order ID: ', h('code', { text: orderId })]),
    diagPanel,
    h('button', { class: 'merch-btn merch-btn-primary', 'data-merch-close': '' }, 'Done'),
  ])
  openModal(card)
  try { window.LBLogin?.confetti?.() } catch {}
}

// ── Init ─────────────────────────────────────────────────────────────
async function init() {
  // Expose the cart opener so the shared nav cart icon (nav.js) can open the
  // modal in place on this page; paint the initial badge count.
  window.openMerchCart = openCart
  updateCartBadge()

  try {
    await fetchCatalog()
    renderGrid()
  } catch (e) {
    console.error('[merch] catalog load failed', e)
    document.getElementById('merch-loading').style.display = 'none'
    document.getElementById('merch-error').style.display = 'block'
  }

  // Arriving from the nav cart icon on another page (/merch.html#cart) →
  // open the cart now that the catalog is loaded so lines resolve to products.
  if (location.hash === '#cart') openCart()
}

// Only auto-run the full storefront on the merch page. Other pages (e.g. the
// homepage merch marquee) import the reusable exports below instead, and drive
// their own fetch/render — running init() there would touch missing DOM.
if (document.getElementById('merch-grid')) init()

// Reusable pieces for the homepage merch marquee (home-merch.js): the shared
// catalog fetch/state, the price→sats helpers, and the exact product detail
// modal so a card click on the homepage opens the same modal as /merch.
export { fetchCatalog, catalog, openProductModal, toSats, getBtcUsd, fmtSats, priceLabel }
