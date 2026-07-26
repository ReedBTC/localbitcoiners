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
 * the same file to 31922/31923. Until the bot's kind gate widens to include
 * 30023 (see featured-articles-data-contract.md) this returns an empty set and
 * the section renders its empty hint, which is the intended pre-launch state.
 *
 * Rendering lives in feeds-articles.js — this module only resolves data and
 * owns the Feature action itself.
 */
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'
import { STATIC_RELAYS } from '/assets/js/boosts-thread.js'
import { ensureLoginWidget } from '/assets/js/widget-loader.js'
import { PENDING_PROMOTE_KEY, readPendingPromote, clearPendingPromote } from '/assets/js/calendar-events.js'

// The pending-promote slot is shared with the Events tab's Promote flow (one
// slot; boosts are sequential). Both settle listeners read it and each claims
// only a coordinate of its own kind, so neither can swallow the other's.
export { readPendingPromote, clearPendingPromote }

export const KIND_ARTICLE = 30023
const MEETUPS_JSON = '/api/meetups'

export function articleCoord(pubkey, dTag) {
  return `${KIND_ARTICLE}:${pubkey}:${dTag}`
}

export function isArticleCoord(coordinate) {
  return parseInt(String(coordinate).split(':')[0], 10) === KIND_ARTICLE
}

function isWsUrl(u) {
  return typeof u === 'string' && (u.startsWith('wss://') || u.startsWith('ws://'))
}

// naddrs carry relay hints — an article featured from outside the community
// snapshot may only live on relays we don't otherwise query.
function relayHintsFromNaddr(naddr) {
  try {
    const d = nip19.decode(naddr)
    if (d.type === 'naddr' && Array.isArray(d.data.relays)) return d.data.relays.filter(isWsUrl)
  } catch {}
  return []
}

function npubToHex(npub) {
  try {
    const d = nip19.decode(npub)
    return d.type === 'npub' ? d.data : ''
  } catch { return '' }
}

// settled_at is an ISO-8601 UTC string ("2026-07-21T23:30:46Z"). A row with an
// unparseable timestamp still counts as featured; it just sorts last and only
// shows in the All view (0 is older than any window).
function parseSettledAt(s) {
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : 0
}

// Read the boosted-naddr log and keep the article rows. Returns a
// coord → { featuredAt, by, sats } map (newest boost per coordinate wins) plus
// any relay hints seen. Best-effort: an unreachable log means "nothing
// featured", never a hard error on the Articles tab.
export async function fetchFeaturedArticleSet() {
  const featured = new Map()
  const hints = new Set()
  try {
    const res = await fetch(MEETUPS_JSON, { cache: 'no-cache' })
    if (!res.ok) throw new Error('meetups.json ' + res.status)
    const data = await res.json()
    const rows = Array.isArray(data?.rows) ? data.rows : []
    for (const r of rows) {
      if (!r || typeof r.coordinate !== 'string') continue
      if (!isArticleCoord(r.coordinate)) continue
      const featuredAt = parseSettledAt(r.settled_at)
      const prev = featured.get(r.coordinate)
      // Rows arrive newest-first, but don't rely on it: the most recent boost
      // is the one that sets the article's place in the range filter.
      if (prev && prev.featuredAt >= featuredAt) continue
      const pubkey = npubToHex(r.sender_npub)
      featured.set(r.coordinate, {
        featuredAt,
        by: pubkey ? { pubkey, name: r.sender_name || '', picture: '' } : null,
        sats: parseInt(r.total_sats, 10) || 0,
        naddr: typeof r.naddr === 'string' ? r.naddr : '',
      })
      if (typeof r.naddr === 'string') {
        for (const h of relayHintsFromNaddr(r.naddr)) hints.add(h)
      }
    }
  } catch (e) {
    console.warn('[articles] featured set load failed', e)
  }
  return { featured, hints }
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
// A just-boosted article lights up immediately, before the log refresh records
// it. The stored timestamp doubles as the featured-at time for the range
// filter, so a fresh feature lands in the 1W bucket as it should. TTL'd so the
// local copy self-heals once the authoritative log catches up.
const CONFIRMED_KEY = 'lb_featured_articles_confirmed'
const CONFIRMED_TTL = 48 * 60 * 60 * 1000

export function readConfirmedFeaturedArticles() {
  const out = new Map()
  try {
    const map = JSON.parse(localStorage.getItem(CONFIRMED_KEY) || '{}')
    const now = Date.now()
    for (const [coord, ts] of Object.entries(map)) {
      if (isArticleCoord(coord) && now - (ts || 0) <= CONFIRMED_TTL) {
        out.set(coord, { featuredAt: ts, by: null, sats: 0, naddr: '' })
      }
    }
  } catch {}
  return out
}

export function addConfirmedFeaturedArticle(coord) {
  try {
    const map = JSON.parse(localStorage.getItem(CONFIRMED_KEY) || '{}')
    const now = Date.now()
    for (const [c, ts] of Object.entries(map)) {
      if (now - (ts || 0) > CONFIRMED_TTL) delete map[c]
    }
    map[coord] = now
    localStorage.setItem(CONFIRMED_KEY, JSON.stringify(map))
  } catch {}
  return Date.now()
}

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

// Open the show-boost modal with the article's naddr prefilled. `onFail` gets a
// message to surface (the caller owns its own toast).
export async function featureArticle({ pubkey, dTag, naddr }, onFail) {
  const coord = articleCoord(pubkey, dTag)
  const bech32 = naddr || naddrForArticle(pubkey, dTag)
  if (!bech32) { onFail?.('Could not build this article’s address'); return }
  try {
    // Record intent before handing off so the settle listener knows which
    // coordinate to light up. A cancelled boost is harmless: the TTL and the
    // "any leg succeeded" gate keep it from featuring anything.
    try {
      localStorage.setItem(PENDING_PROMOTE_KEY, JSON.stringify({ coord, naddr: bech32, ts: Date.now() }))
    } catch {}
    await ensureLoginWidget()
    const prefillMessage = `${FEATURE_TEMPLATE}\n\nnostr:${bech32}`
    if (window.LBLogin?.openShowBoost) window.LBLogin.openShowBoost({ prefillMessage })
    else onFail?.('Boost unavailable right now — please try again')
  } catch (e) {
    console.error('[articles] feature failed', e)
    onFail?.('Something went wrong — please try again')
  }
}
