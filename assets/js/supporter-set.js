/* Shared supporter-set resolver.
 *
 * "Supporters" = every pubkey listed in the show's own follow packs
 * (following.space kind-39089, published by bots/follow-packs from the show
 * account). We union the p-tags across all of the show's packs
 * (100k / 69k / 21k / other / guests / coders) into one membership set.
 *
 * This is the ONE source of that set. feeds.js re-exports resolveSupporters
 * from here (so home-feeds.js keeps importing it from feeds.js unchanged),
 * and community-status.js imports it directly to decide whether the logged-in
 * npub is a community member.
 */
import { STATIC_RELAYS } from '/assets/js/boosts-thread.js'
import { SimplePool, verifyEvent } from '/assets/widgets/nostr-tools.js'

// The show account that owns the supporter follow packs (hex of the show
// npub — same constant supporters.js / bots/follow-packs use).
export const SHOW_PUBKEY_HEX = 'c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592'

const KIND_FOLLOW_PACK = 39089
const KIND_RELAY_LIST = 10002

// Sat-tier packs, by their kind-39089 `d`-tag slug. The bot sorts each
// supporter into the single tier they clear (see supporters.js TIERS), so a
// member's tier is which of these packs contains them. Rank breaks any overlap
// (highest wins). Guests/coders/all packs carry no tier — a member only in
// those reads as a plain "Community Member". Singular labels (one person).
const TIER_RANK = {
  'lb-supporters-100k': 4,
  'lb-supporters-69k': 3,
  'lb-supporters-21k': 2,
  'lb-supporters-other': 1,
}
export const TIER_META = {
  'lb-supporters-100k':  { label: 'Sovereign',    ring: 'gold' },
  'lb-supporters-69k':   { label: 'Frontiersman', ring: 'silver' },
  'lb-supporters-21k':   { label: 'Trailblazer',  ring: 'bronze' },
  'lb-supporters-other': { label: 'Pioneer',      ring: 'none' },
}

// The show's own NIP-65 outbox (write) relays — where bots/follow-packs
// publishes the kind-39089 packs. Merged into the query set so we find packs
// (and thus supporters) that live outside the default relays. We only resolve
// the SHOW account's list here, not every supporter's (that's the heavier
// "full outbox" upgrade).
async function fetchShowOutboxRelays(relays) {
  const out = new Set()
  const pool = new SimplePool()
  try {
    const evs = await pool
      .querySync(relays, { kinds: [KIND_RELAY_LIST], authors: [SHOW_PUBKEY_HEX] })
      .catch(() => [])
    let best = null
    for (const ev of evs) {
      if (!ev || ev.pubkey !== SHOW_PUBKEY_HEX || !verifyEvent(ev)) continue
      if (!best || (ev.created_at || 0) > (best.created_at || 0)) best = ev
    }
    if (best) {
      for (const t of best.tags || []) {
        if (!Array.isArray(t) || t[0] !== 'r' || typeof t[1] !== 'string') continue
        const url = t[1]
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) continue
        // NIP-65: unmarked = read+write; only 'read' means not a write relay.
        if (t[2] === 'read') continue
        out.add(url)
      }
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return [...out]
}

// Every p-tag across the show's own kind-39089 packs = the supporter set.
// Also buckets each member into their highest sat-tier pack (by the event's
// `d`-tag slug) so callers can show a tier. Returns { members: Set<hex>,
// tiers: { [hex]: packSlug } } — tiers only carries members in a TIER_RANK pack.
async function fetchPacks(relays) {
  const members = new Set()
  const bestRank = new Map()   // hex → highest tier rank seen
  const tiers = {}             // hex → pack slug at that highest rank
  const pool = new SimplePool()
  try {
    const evs = await pool
      .querySync(relays, { kinds: [KIND_FOLLOW_PACK], authors: [SHOW_PUBKEY_HEX] })
      .catch(() => [])
    for (const ev of evs) {
      if (!ev || ev.pubkey !== SHOW_PUBKEY_HEX || !verifyEvent(ev)) continue
      let slug = ''
      for (const t of ev.tags || []) {
        if (Array.isArray(t) && t[0] === 'd') { slug = typeof t[1] === 'string' ? t[1] : ''; break }
      }
      const rank = TIER_RANK[slug] || 0
      for (const t of ev.tags || []) {
        if (Array.isArray(t) && t[0] === 'p' && /^[0-9a-f]{64}$/i.test(t[1] || '')) {
          const pk = t[1].toLowerCase()
          members.add(pk)
          if (rank > 0 && rank > (bestRank.get(pk) || 0)) {
            bestRank.set(pk, rank)
            tiers[pk] = slug
          }
        }
      }
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return { members, tiers }
}

// ── Cache ────────────────────────────────────────────────────────────
// The member set changes at most ~daily (the bot adds supporters within 24h),
// so a resolution is worth caching. Lets callers paint from cache instantly
// and revalidate in the background instead of waiting on two relay round-trips
// every load. Any resolveSupporters() caller (feeds.js, home-feeds.js, the
// community-status chip) warms the same cache.
// v2: cache shape gained `tiers`. Bumped so a pre-tier v1 blob is ignored
// (forces one fresh resolve rather than rendering members with no tier).
const CACHE_KEY = 'lb_supporter_set_v2'
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000   // ignore absurdly stale blobs

// Last good resolution for this browser, or null. Synchronous — safe to call
// before the network path resolves, for an instant first paint.
export function getCachedSupporters() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!Array.isArray(p?.members) || !p.members.length) return null
    if (!Number.isFinite(p.savedAt) || Date.now() - p.savedAt > CACHE_MAX_AGE_MS) return null
    return {
      relays: Array.isArray(p.relays) ? p.relays : [],
      members: p.members,
      tiers: (p.tiers && typeof p.tiers === 'object') ? p.tiers : {},
    }
  } catch { return null }
}

function writeCache({ relays, members, tiers }) {
  // Never cache an empty set — a relay hiccup that returns 0 members would
  // otherwise poison the cache and wrongly tell real supporters to boost.
  if (!Array.isArray(members) || !members.length) return
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      relays: relays || [], members, tiers: tiers || {}, savedAt: Date.now(),
    }))
  } catch {}
}

// Resolve the show's write outbox, then the union of every follow-pack member
// into one { relays, members, tiers } set. members is an array (JSON-friendly,
// and what fetchUpcomingEvents/streamEvents already expect); tiers maps member
// hex → sat-tier pack slug. Writes the cache on a non-empty result.
export async function resolveSupporters() {
  const outbox = await fetchShowOutboxRelays(STATIC_RELAYS)
  const relays = [...new Set([...STATIC_RELAYS, ...outbox])]
  const { members, tiers } = await fetchPacks(relays)
  const result = { relays, members: [...members], tiers }
  writeCache(result)
  return result
}
