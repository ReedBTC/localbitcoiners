/* Featured Articles — the data side of the Articles tab's Featured section.
 *
 * Mirrors the Featured Events path in feeds.js, with one structural difference:
 * a calendar event expires on its own (it falls into Past Events once its end
 * time passes), but an article has no future date to age against. So a featured
 * article is scoped by WHEN IT WAS FEATURED, and the section carries its own
 * 1W / 1M / All range filter over that timestamp. Re-boosting an article moves
 * it back to the front, which is how a feature renews.
 *
 * Source of truth is the same boosted-naddr log the Events tab reads
 * (/api/meetups): the sats-log bot scans every boost message for naddrs and
 * writes one row per (naddr × boost) with the settlement timestamp and the
 * booster's npub. Rows are filtered here to kind 30023; the Events tab filters
 * the same file to 31922/31923, the Marketplace tab to 30402.
 *
 * The parts every tab shares (log reading, the optimistic store, the pending
 * slot, the maker's Lightning-address lookup) live in featured-shared.js;
 * rendering lives in feeds-articles.js. This module resolves article data and
 * owns the Feature action itself.
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

// The pending-promote slot is shared with every tab's Feature flow (one
// slot; boosts are sequential). Each settle listener claims only a coordinate
// of its own kind, so none can swallow another's.
export { readPendingPromote, clearPendingPromote }

export const KIND_ARTICLE = 30023

export function articleCoord(pubkey, dTag) {
  return `${KIND_ARTICLE}:${pubkey}:${dTag}`
}

export function isArticleCoord(coordinate) {
  return parseInt(String(coordinate).split(':')[0], 10) === KIND_ARTICLE
}

// Read the boosted-naddr log and keep the article rows. Returns a
// coord → { featuredAt, by, sats } map (newest boost per coordinate wins) plus
// any relay hints seen.
export function fetchFeaturedArticleSet() {
  return fetchFeaturedSet((r) => isArticleCoord(r.coordinate), { tag: 'articles' })
}

// ── Relay backfill ───────────────────────────────────────────────────
// The community-articles snapshot is scoped to supporter follow packs, so an
// article featured from outside that set won't be in it. Fetch those straight
// from relays by coordinate. Same shape as fetchCalendarEventsFromRelays().
export async function fetchArticlesFromRelays(coords, relays = STATIC_RELAYS) {
  const out = new Map()
  const authors = new Set()
  const dTags = new Set()
  const wanted = new Set()
  for (const coord of coords) {
    const parts = String(coord).split(':')
    const kind = parseInt(parts[0], 10)
    const pk = parts[1]
    // d-tags are author-chosen slugs and may themselves contain ':', so the
    // identifier is everything after the second separator, not parts[2].
    const d = parts.slice(2).join(':')
    if (kind !== KIND_ARTICLE || !/^[0-9a-f]{64}$/i.test(pk || '') || !d) continue
    authors.add(pk)
    dTags.add(d)
    wanted.add(`${kind}:${pk}:${d}`)
  }
  if (!wanted.size) return out

  const pool = new SimplePool()
  try {
    const evs = await pool.querySync(relays, {
      kinds: [KIND_ARTICLE],
      authors: [...authors],
      '#d': [...dTags],
      limit: 200,
    }).catch(() => [])
    for (const ev of evs || []) {
      if (!ev || ev.kind !== KIND_ARTICLE) continue
      let ok = false
      try { ok = verifyEvent(ev) } catch {}
      if (!ok) continue
      const d = (ev.tags || []).find((t) => Array.isArray(t) && t[0] === 'd')?.[1]
      if (!d) continue
      const coord = articleCoord(ev.pubkey, d)
      if (!wanted.has(coord)) continue
      const prev = out.get(coord)
      if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) out.set(coord, ev)
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return out
}

// Fetch one article by naddr, for the "Find an Article to Feature" paste flow.
// Returns { event, coord, relays } or null. The naddr's own relay hints are
// queried alongside the static set — a pasted article is exactly the case where
// the hint is the only place it lives.
export async function fetchArticleByNaddr(naddr) {
  let decoded = null
  try {
    const d = nip19.decode(naddr)
    if (d.type !== 'naddr') return null
    decoded = d.data
  } catch { return null }
  if (decoded.kind !== KIND_ARTICLE) return { wrongKind: decoded.kind }
  const coord = articleCoord(decoded.pubkey, decoded.identifier)
  const relays = [...new Set([...STATIC_RELAYS, ...(decoded.relays || []).filter(isWsUrl)])]
  const found = await fetchArticlesFromRelays([coord], relays)
  const event = found.get(coord)
  return event ? { event, coord } : null
}

// Pull an naddr out of pasted text: bare, nostr:-prefixed, or embedded in a
// mynostr.app / njump.me / any-client URL.
const NADDR_RE = /naddr1[02-9ac-hj-np-z]+/i
export function naddrFromText(text) {
  const m = NADDR_RE.exec(String(text || ''))
  return m ? m[0].toLowerCase() : ''
}

// ── Optimistic featured set ──────────────────────────────────────────
const confirmed = makeConfirmedStore('lb_featured_articles_confirmed', isArticleCoord)
export const readConfirmedFeaturedArticles = confirmed.read
export function addConfirmedFeaturedArticle(coord, naddr = '') {
  return confirmed.add(coord, null, naddr)
}

// ── Author split resolution ──────────────────────────────────────────
// Kept under its old name for callers; the lookup itself is shared.
export const resolveArticleAuthorSplit = resolveMakerSplit

// ── The Feature action ───────────────────────────────────────────────
// Same prose shape as the Events tab's Promote, so a Feature from a card and a
// Feature from the Find modal are indistinguishable to the boost bot (which
// only scans the message for naddrs). The bot appends the article's
// mynostr.app link when it publishes the note — plektos.app is a calendar
// client and has no article view.
const FEATURE_TEMPLATE = 'Boosting this article from https://localbitcoiners.com/feeds'

export function naddrForArticle(pubkey, dTag, relays = STATIC_RELAYS) {
  try {
    return nip19.naddrEncode({
      identifier: dTag,
      pubkey,
      kind: KIND_ARTICLE,
      relays: relays.slice(0, 2),
    })
  } catch { return '' }
}

// Open the show-boost modal with the article's naddr prefilled and the third
// split leg pointed at the article's author. `author` is the caller's cached
// kind-0 profile, if it has one. `onFail` gets a message to surface (the caller
// owns its own toast).
export async function featureArticle({ pubkey, dTag, naddr, author = null }, onFail) {
  const coord = articleCoord(pubkey, dTag)
  const bech32 = naddr || naddrForArticle(pubkey, dTag)
  if (!bech32) { onFail?.('Could not build this article’s address'); return }
  try {
    const split = await resolveMakerSplit(pubkey, author)
    // Record intent before handing off so the settle listener knows which
    // coordinate to light up.
    setPendingPromote(coord, { naddr: bech32 })
    const prefillMessage = `${FEATURE_TEMPLATE}\n\nnostr:${bech32}`
    await openFeatureBoost({
      prefillMessage,
      feature: { kind: 'article', pubkey, naddr: bech32, name: split.name, address: split.address },
    }, onFail)
  } catch (e) {
    console.error('[articles] feature failed', e)
    onFail?.('Something went wrong — please try again')
  }
}
