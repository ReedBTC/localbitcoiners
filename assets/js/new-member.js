/**
 * New-member detection for the boost wall (boosts.html).
 *
 * Reed and Rev read the week's boosts off on the show and want to welcome a
 * supporter the first time they boost. This module answers one question per
 * card: is this payment the FIRST boost the sats ledger holds for whoever sent
 * it? The page then stamps a "New Member!" line on that card.
 *
 * Data: /api/sats, the same ledger the stats, supporters and episode pages
 * read. Every boost-wall record joins to a ledger row by payment_hash (checked
 * 2026-10-08: 466 of 466, with identical settled_at), so the card → ledger
 * join is by hash, and the ledger is refreshed on the same cadence as the
 * wall. A card whose hash the ledger has not seen gets no badge (unknown is
 * never "new").
 *
 * The rule, and the calls behind it:
 *
 *   - Identity is the sender's npub when the row has one, else the name they
 *     typed (Fountain usernames, keysend boostagram names), case-folded.
 *     Placeholder names ("A Local Bitcoiner", "anon", "ChadF and 33 others")
 *     are not an identity: a card with no identity never gets the badge,
 *     because the next anonymous booster would otherwise look like the same
 *     person, or every one of them would look new. A supporter who boosts
 *     once from Fountain by name and later with an npub is two identities;
 *     the ledger cannot link them, and neither can this.
 *   - Only `kind: "boost"` rows count. Stream rows are per-(episode,
 *     supporter) aggregates stamped with LAST activity (see CLAUDE.md), so
 *     "did they stream before this boost" cannot be answered from their
 *     timestamp; zaps are Nostr interactions, not listening. Someone who
 *     streamed for months and then sends their first boost is therefore
 *     flagged, which is what "first boost" means on the show.
 *   - The hosts are never new. Their name-only boosts from other apps
 *     ("Reed" over keysend, "rev.hodl" from Fountain) would otherwise be
 *     flagged as fresh identities.
 *   - One badge per identity: the earliest boost by settled_at, and on a tie
 *     the first in ledger order.
 *
 * Kept as a NEW module on purpose: boosts-thread.js is shared by four pages
 * and cached stale-while-revalidate, and a named export added to a cached
 * shared module is a link-time error until the cache turns over.
 */

export const SATS_URL = '/api/sats'
const FETCH_TIMEOUT_MS = 10000

// Co-host npubs (the same two supporters.js and stats.js exclude) plus the
// names their non-Nostr boosts arrive under.
export const HOST_NPUBS = new Set([
  'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s', // Reed
  'npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z', // Rev Hodl
])
const HOST_NAMES = new Set(['reed', 'rev hodl', 'rev.hodl', 'revhodl'])

// Names the apps stamp when the booster typed nothing. "A Local Bitcoiner" is
// the site's own blank-name default (ANON_BOOSTER_NAME in calendar-events.js).
const PLACEHOLDER_NAMES = new Set([
  'a local bitcoiner',
  'anon',
  'anonymous',
  'onlyboosts.social user',
  'boostmebitch.com user',
  'fountain user',
])
const GROUP_NAME_RE = /\band \d+ others?$/i

/** Identity key for a ledger row or wall record, or null when it has none. */
export function identityOf(row) {
  if (!row) return null
  if (typeof row.sender_npub === 'string' && row.sender_npub) {
    return HOST_NPUBS.has(row.sender_npub) ? null : row.sender_npub
  }
  const name = typeof row.sender_name === 'string' ? row.sender_name.trim() : ''
  if (!name) return null
  const key = name.toLowerCase()
  if (PLACEHOLDER_NAMES.has(key) || HOST_NAMES.has(key) || GROUP_NAME_RE.test(name)) return null
  return 'name:' + key
}

/**
 * The payment hashes of every identity's first boost, from ledger rows.
 * Rows without a kind of "boost", a payment hash, a parseable settled_at or
 * an identity are ignored.
 */
export function firstBoostHashes(rows) {
  const earliest = new Map() // identity → { hash, at }
  if (!Array.isArray(rows)) return new Set()
  for (const row of rows) {
    if (!row || row.kind !== 'boost') continue
    if (typeof row.payment_hash !== 'string' || !row.payment_hash) continue
    const at = Date.parse(row.settled_at || '')
    if (!Number.isFinite(at)) continue
    const id = identityOf(row)
    if (!id) continue
    const cur = earliest.get(id)
    if (!cur || at < cur.at) earliest.set(id, { hash: row.payment_hash, at })
  }
  return new Set([...earliest.values()].map((v) => v.hash))
}

/**
 * Fetch the ledger and return `{ isFirstBoost(paymentHash) }`, or null when
 * the ledger is unreachable or malformed. Null means "no badges", never an
 * error screen: the wall is complete without this.
 */
export async function loadFirstBoosts({ url = SATS_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) return null
    const data = await resp.json()
    const rows = Array.isArray(data) ? data : data?.rows
    if (!Array.isArray(rows)) return null
    const hashes = firstBoostHashes(rows)
    return {
      count: hashes.size,
      isFirstBoost: (hash) => typeof hash === 'string' && hashes.has(hash),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The badge line the boosts page inserts above a first boost's body. */
export function newMemberBadge() {
  const line = document.createElement('div')
  line.className = 'new-member'
  line.title = 'First boost from this supporter in the sats ledger'
  const pill = document.createElement('span')
  pill.className = 'new-member-pill'
  pill.textContent = '🎉 New Member!'
  const sub = document.createElement('span')
  sub.className = 'new-member-sub'
  sub.textContent = 'First boost from this supporter'
  line.append(pill, sub)
  return line
}
