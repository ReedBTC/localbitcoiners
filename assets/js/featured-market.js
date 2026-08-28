/* Featured Listings — the data side of the Marketplace tab's Featured section.
 *
 * The Featured Articles pattern on NIP-99 listings (kind 30402): a listing is
 * featured when someone boosts the show with its naddr in the message, and the
 * section is scoped by WHEN IT WAS FEATURED with its own 1W / 1M / All range.
 * The Feature boost pays the seller the show's reassignable split leg, from
 * the seller's kind-0 lud16, which the Marketplace tab already resolves for
 * its Buy Now grading.
 *
 * Source of truth is the boosted-naddr log every tab reads (/api/meetups),
 * filtered here to kind 30402. Until the sats-log bot's kind gate includes
 * 30402 the log carries no listing rows and the section shows its empty hint;
 * the site filters defensively on both sides so the change can land in either
 * order.
 *
 * Rendering lives in feeds-market.js — this module resolves data and owns the
 * Feature action itself.
 */
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'
import { STATIC_RELAYS } from '/assets/js/boosts-thread.js'
import {
  fetchFeaturedSet,
  makeConfirmedStore,
  setPendingPromote,
  readPendingPromote,
  clearPendingPromote,
  resolveMakerSplit,
  openFeatureBoost,
  isWsUrl,
} from '/assets/js/featured-shared.js'

export { readPendingPromote, clearPendingPromote }

export const KIND_LISTING = 30402

export function listingCoord(pubkey, dTag) {
  return `${KIND_LISTING}:${pubkey}:${dTag}`
}

export function isListingCoord(coordinate) {
  return parseInt(String(coordinate).split(':')[0], 10) === KIND_LISTING
}

export function fetchFeaturedListingSet() {
  return fetchFeaturedSet((r) => isListingCoord(r.coordinate), { tag: 'market' })
}

// ── Relay backfill ───────────────────────────────────────────────────
// The community-market snapshot is scoped to supporter follow packs plus the
// house store, so a listing featured from outside that set won't be in it.
// Fetch those straight from relays by coordinate. Returns coord → raw event
// (the newest per coordinate, signature-verified); feeds-market.js runs them
// through merch.js's ingestListings like any other listing event.
export async function fetchListingsFromRelays(coords, relays = STATIC_RELAYS) {
  const out = new Map()
  const authors = new Set()
  const dTags = new Set()
  const wanted = new Set()
  for (const coord of coords) {
    const parts = String(coord).split(':')
    const kind = parseInt(parts[0], 10)
    const pk = parts[1]
    // d-tags are seller-chosen and may contain ':', so the identifier is
    // everything after the second separator.
    const d = parts.slice(2).join(':')
    if (kind !== KIND_LISTING || !/^[0-9a-f]{64}$/i.test(pk || '') || !d) continue
    authors.add(pk)
    dTags.add(d)
    wanted.add(`${kind}:${pk}:${d}`)
  }
  if (!wanted.size) return out

  const pool = new SimplePool()
  try {
    const evs = await pool.querySync(relays, {
      kinds: [KIND_LISTING],
      authors: [...authors],
      '#d': [...dTags],
      limit: 200,
    }).catch(() => [])
    for (const ev of evs || []) {
      if (!ev || ev.kind !== KIND_LISTING) continue
      let ok = false
      try { ok = verifyEvent(ev) } catch {}
      if (!ok) continue
      const d = (ev.tags || []).find((t) => Array.isArray(t) && t[0] === 'd')?.[1]
      if (!d) continue
      const coord = listingCoord(ev.pubkey, d)
      if (!wanted.has(coord)) continue
      const prev = out.get(coord)
      if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) out.set(coord, ev)
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return out
}

// Fetch one listing by naddr, for the "Find a Listing to Feature" paste flow.
// Returns { event, coord }, { wrongKind }, or null. The naddr's own relay hints
// are queried alongside the static set.
export async function fetchListingByNaddr(naddr) {
  let decoded = null
  try {
    const d = nip19.decode(naddr)
    if (d.type !== 'naddr') return null
    decoded = d.data
  } catch { return null }
  if (decoded.kind !== KIND_LISTING) return { wrongKind: decoded.kind }
  const coord = listingCoord(decoded.pubkey, decoded.identifier)
  const relays = [...new Set([...STATIC_RELAYS, ...(decoded.relays || []).filter(isWsUrl)])]
  const found = await fetchListingsFromRelays([coord], relays)
  const event = found.get(coord)
  return event ? { event, coord } : null
}

// Pull an naddr out of pasted text: bare, nostr:-prefixed, or embedded in a
// Shopstr / Conduit / njump / any-client URL.
const NADDR_RE = /naddr1[02-9ac-hj-np-z]+/i
export function naddrFromText(text) {
  const m = NADDR_RE.exec(String(text || ''))
  return m ? m[0].toLowerCase() : ''
}

// ── Optimistic featured set ──────────────────────────────────────────
const confirmed = makeConfirmedStore('lb_featured_listings_confirmed', isListingCoord)
export const readConfirmedFeaturedListings = confirmed.read
export function addConfirmedFeaturedListing(coord, naddr = '') {
  return confirmed.add(coord, null, naddr)
}

// ── The Feature action ───────────────────────────────────────────────
// Same prose shape as the other tabs' Feature, so the boost bot (which only
// scans the message for naddrs) treats them alike. The bot appends a Shopstr
// link for the listing when it publishes the note.
const FEATURE_TEMPLATE = 'Boosting this listing from https://localbitcoiners.com/feeds'

export function naddrForListing(pubkey, dTag, relays = STATIC_RELAYS) {
  try {
    return nip19.naddrEncode({
      identifier: dTag,
      pubkey,
      kind: KIND_LISTING,
      relays: relays.slice(0, 2),
    })
  } catch { return '' }
}

// Open the show-boost modal with the listing's naddr prefilled and the third
// split leg pointed at the seller. `seller` is the caller's cached kind-0
// profile ({ name, picture, lud16 }), if it has one.
export async function featureListing({ pubkey, dTag, naddr, seller = null }, onFail) {
  const coord = listingCoord(pubkey, dTag)
  const bech32 = naddr || naddrForListing(pubkey, dTag)
  if (!bech32) { onFail?.('Could not build this listing’s address'); return }
  try {
    const split = await resolveMakerSplit(pubkey, seller)
    setPendingPromote(coord, { naddr: bech32 })
    const prefillMessage = `${FEATURE_TEMPLATE}\n\nnostr:${bech32}`
    await openFeatureBoost({
      prefillMessage,
      feature: { kind: 'listing', pubkey, naddr: bech32, name: split.name, address: split.address },
    }, onFail)
  } catch (e) {
    console.error('[market] feature failed', e)
    onFail?.('Something went wrong — please try again')
  }
}
