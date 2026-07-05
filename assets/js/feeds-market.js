/* Community marketplace feed — the Marketplace tab on /feeds.
 *
 * Surfaces NIP-99 (kind 30402) listings from the show's supporter follow
 * packs PLUS the Local Bitcoiners house merchant, in one badged list:
 *
 *   • "Buy Now"  — the listing is Gamma checkout-ready (structured shipping
 *     that resolves) AND the seller is payable over Lightning (their kind-0
 *     lud16, or — for the house store — the hardcoded merch address). These
 *     reuse the exact multi-merchant cart + checkout from /merch.
 *
 *   • "Classified" — everything else. We show what's missing to be
 *     checkout-ready (straight from the shared Gamma grader) and offer a
 *     "Contact Seller" NIP-17 DM instead of on-site payment.
 *
 * Grading uses assets/js/gamma-compliance.js — a verbatim port of MyNostr's
 * grader, so "checkout-ready" here means exactly what it means there. The
 * cart, checkout, catalog and gift-wrap send are all reused from merch.js
 * (import-safe: merch.js only boots its storefront where #merch-grid exists).
 *
 * Entry point: renderMarket({ panel, list, relays, members }) — feeds.js
 * resolves the supporter set + relays and hands them in, then lazy-imports
 * this module the first time the Marketplace tab is opened.
 */
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'
import { gradeListing } from '/assets/js/gamma-compliance.js'
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
const PROFILE_RELAY = 'wss://purplepag.es'

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
  list.appendChild(h('div', { class: 'feed-placeholder' }, [
    h('strong', { text: title }),
    document.createTextNode(body),
  ]))
}

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
  // House store is always Buy Now (its checkout is proven on /merch and it may
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

// Full listing view — reuses the /merch product modal (carousel + thumbnails +
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

function renderCard(item, rate, onContact) {
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

  const card = h('article', {
    class: 'market-card', role: 'button', tabindex: '0',
    onclick: () => openDetail(item, onContact),
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openDetail(item, onContact) } },
  }, [
    media,
    h('div', { class: 'market-card-body' }, [
      h('h3', { class: 'market-card-title', text: p.title }),
      sellerRow(item),
      priceEl(p, rate),
      p.summary ? h('p', { class: 'market-card-summary', text: p.summary }) : null,
      h('div', { class: 'market-card-actions' }, [actionButton(item, onContact, { stop: true })]),
    ]),
  ])
  return card
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
  const ciphertext = await encrypt(text)
  const signed = await window.LBLogin.signEvent({
    kind: 4,
    content: ciphertext,
    tags: [['p', sellerHex]],
    created_at: Math.floor(Date.now() / 1000),
  })
  const relays = await resolveDMRelays(sellerHex)
  const pool = new SimplePool()
  try {
    await Promise.allSettled(pool.publish(relays, signed))
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
// Shown in the panel head for logged-in users only, deep-linking to their own
// marketplace on MyNostr (where they can list/manage items). Re-rendered on
// login state changes. Replaces the old count pill.
function renderManageButton(panel) {
  const head = panel.querySelector('.feed-panel-head')
  if (!head) return
  const prev = head.querySelector('.market-manage-btn')
  if (prev) prev.remove()
  const count = head.querySelector('.feed-count')
  if (count) count.hidden = true

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

// ── Entry point ──────────────────────────────────────────────────────
export async function renderMarket({ panel, list, relays, members }) {
  showSkeletons(list)
  feedRelays = relays || []

  // Manage button shows immediately (independent of the fetch) and tracks
  // login changes — the loader runs once, so subscribe just once here.
  renderManageButton(panel)
  if (!renderMarket._manageWired) {
    renderMarket._manageWired = true
    window.LBLogin?.onChange?.(() => renderManageButton(panel))
  }

  // Let the shared nav cart icon open the cart IN PLACE on /feeds (merch.js
  // only wires this on /merch, via its init). Without it the icon would
  // navigate to /merch.html#cart, where the LB-only catalog can't resolve a
  // community seller's line and would silently drop it.
  window.openMerchCart = openCart

  const authors = [...new Set([...(members || []), MERCHANT_HEX].map((a) => a.toLowerCase()))]
  const events = await fetchMarketEvents(authors, relays)

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

  if (!products.length) {
    renderPlaceholder(list, 'No listings yet', 'No marketplace listings from supporters right now — check back soon.')
    return
  }

  // Merchant profiles (pfp / name / lud16) drive display AND the Lightning-
  // payability check. Fetched for EVERY seller incl. the house merchant (its
  // lud16 is hardcoded for payment, but we still want its pfp + name), in one
  // pooled kind-0 query — see fetchMerchantProfiles for why not per-merchant.
  const merchants = [...new Set(products.map((p) => p.merchant))]
  const profiles = await fetchMerchantProfiles(merchants, relays)

  const rate = await getBtcUsd().catch(() => null)
  const items = products
    .map((p) => classify(p, profiles.get(p.merchant)))
    .sort((a, b) => {
      // Buy Now first, then newest.
      if (a.buyNow !== b.buyNow) return a.buyNow ? -1 : 1
      return (b.product.created_at || 0) - (a.product.created_at || 0)
    })

  const onContact = (item) => openContactModal(item, relays)
  const grid = h('div', { class: 'feed-list market-grid' })
  for (const item of items) grid.appendChild(renderCard(item, rate, onContact))
  list.className = ''
  list.innerHTML = ''
  list.appendChild(grid)
}
