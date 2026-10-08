/**
 * New-member detection for the boost wall (boosts.html).
 *
 * Reed and Rev read the week's boosts off on the show and want to welcome a
 * supporter the first time they boost. This module answers one question per
 * card: is this payment the FIRST boost the sats ledger holds for the npub
 * that sent it? The page then stamps a "New Member!" line on that card.
 *
 * Data: /api/sats, the same ledger the stats, supporters and episode pages
 * read, and /api/guests, the npubs from the [guests: …] shownotes markers.
 * Every boost-wall record joins to a ledger row by payment_hash (checked
 * 2026-10-08: 466 of 466, with identical settled_at), so the card → ledger
 * join is by hash, and the ledger is refreshed on the same cadence as the
 * wall. A card whose hash the ledger has not seen gets no badge (unknown is
 * never "new").
 *
 * The rule, and the calls behind it (Reed, 2026-10-08):
 *
 *   - Identity is the sender's npub, full stop. A boost that arrives with
 *     only a typed name (a Fountain username, a keysend boostagram name, the
 *     site's "A Local Bitcoiner" default) never gets the badge: names vary
 *     by app and by day, so a regular who boosts from an app that did not
 *     attach their npub looked like a newcomer.
 *   - Past guests are already part of the community, so a guest's npub
 *     never gets the badge, whichever came first, the episode or the boost.
 *     The guest list is required: if /api/guests cannot be read, no card
 *     gets a badge, rather than a guest being welcomed by mistake.
 *   - The hosts are never new.
 *   - Only `kind: "boost"` rows count. Stream rows are per-(episode,
 *     supporter) aggregates stamped with LAST activity (see CLAUDE.md), so
 *     "did they stream before this boost" cannot be answered from their
 *     timestamp; zaps are Nostr interactions, not listening. Someone who
 *     streamed for months and then sends their first boost is therefore
 *     flagged, which is what "first boost" means on the show.
 *   - One badge per npub: the earliest boost by settled_at, and on a tie the
 *     first in ledger order.
 *
 * Kept as a NEW module on purpose: boosts-thread.js is shared by four pages
 * and cached stale-while-revalidate, and a named export added to a cached
 * shared module is a link-time error until the cache turns over.
 */

export const SATS_URL = '/api/sats'
export const GUESTS_URL = '/api/guests'
const FETCH_TIMEOUT_MS = 10000

// Co-host npubs (the same two supporters.js and stats.js exclude).
export const HOST_NPUBS = new Set([
  'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s', // Reed
  'npub1f5pre6wl6ad87vr4hr5wppqq30sh58m4p33mthnjreh03qadcajs7gwt3z', // Rev Hodl
])

/** The sender's npub for a ledger row or wall record, or null when it has none. */
export function identityOf(row) {
  const npub = row && typeof row.sender_npub === 'string' ? row.sender_npub.trim() : ''
  return npub ? npub : null
}

/**
 * The payment hashes of every npub's first boost, from ledger rows. Rows
 * without a kind of "boost", a payment hash, a parseable settled_at or an
 * npub are ignored, and so is every npub in `exclude` (hosts and guests).
 */
export function firstBoostHashes(rows, { exclude = HOST_NPUBS } = {}) {
  const earliest = new Map() // npub → { hash, at }
  if (!Array.isArray(rows)) return new Set()
  for (const row of rows) {
    if (!row || row.kind !== 'boost') continue
    if (typeof row.payment_hash !== 'string' || !row.payment_hash) continue
    const at = Date.parse(row.settled_at || '')
    if (!Number.isFinite(at)) continue
    const id = identityOf(row)
    if (!id || exclude.has(id)) continue
    const cur = earliest.get(id)
    if (!cur || at < cur.at) earliest.set(id, { hash: row.payment_hash, at })
  }
  return new Set([...earliest.values()].map((v) => v.hash))
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the ledger and the guest list and return `{ isFirstBoost(paymentHash) }`,
 * or null when either is unreachable or malformed. Null means "no badges",
 * never an error screen: the wall is complete without this.
 */
export async function loadFirstBoosts({ satsUrl = SATS_URL, guestsUrl = GUESTS_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const [sats, guests] = await Promise.all([fetchJson(satsUrl, timeoutMs), fetchJson(guestsUrl, timeoutMs)])
  const rows = Array.isArray(sats) ? sats : sats?.rows
  if (!Array.isArray(rows)) return null
  // /api/guests answers a feed failure with `{ guests: [], error }` and a 502,
  // which fetchJson already turns into null; a 200 with no array is treated
  // the same way, so a guest is never welcomed because the list was missing.
  if (!Array.isArray(guests?.guests)) return null
  const exclude = new Set([...HOST_NPUBS, ...guests.guests.filter((g) => typeof g === 'string')])
  const hashes = firstBoostHashes(rows, { exclude })
  return {
    count: hashes.size,
    isFirstBoost: (hash) => typeof hash === 'string' && hashes.has(hash),
  }
}

/** The badge line the boosts page inserts above a first boost's body. */
export function newMemberBadge() {
  const line = document.createElement('div')
  line.className = 'new-member'
  line.title = 'First boost from this npub in the sats ledger'
  const pill = document.createElement('span')
  pill.className = 'new-member-pill'
  pill.textContent = '🎉 New Member!'
  const sub = document.createElement('span')
  sub.className = 'new-member-sub'
  sub.textContent = 'First boost from this supporter'
  line.append(pill, sub)
  return line
}
