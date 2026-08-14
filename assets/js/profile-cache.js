/* Site-wide profile cache.
 *
 * Serves /api/profiles, a nightly file the bots build covering every npub this
 * site displays anywhere: sats.csv senders, the npubs mentioned in boost-wall
 * notes, RSS guests, and the hand-maintained co-host / contributor list. As of
 * 2026-08-14 that is 152 of the 153 npubs in the union, and the one it misses
 * has no kind-0 on any relay or in Primal's cache, so this file is complete
 * with respect to what exists rather than merely close to it.
 *
 * Completeness is the whole point. Profile resolution is ONE batched Primal
 * round trip, so the cost barely moves with the size of the set — measured at
 * 1659/1348 ms for 151 pubkeys against 1164/1205 ms for 61. A partial cache
 * therefore saves nothing, because the live call still has to run for the
 * remainder. Only a source that answers for everybody lets a caller skip that
 * call, which is why the ~5% of npubs relays alone could not resolve were
 * worth a second pass on the bots side rather than being left to the fallback.
 *
 * Callers must still keep their existing resolver for a miss: a supporter who
 * boosts today is not in the file until tonight's run.
 */
import { verifyEvent } from '/assets/widgets/nostr-tools.js'

const PROFILES_URL = '/api/profiles'
const PROFILES_TIMEOUT_MS = 8000

// ⚠️ Memoize the PROMISE, but never a rejected one. Caching a rejection makes
// one failed load permanent for the life of the page, so a single flaky fetch
// would strand every avatar on the truncated-npub fallback until reload. On
// failure this clears itself so the next caller retries.
let inflight = null

// hex pubkey → parsed kind-0 content, in the shape parseProfileEvent produces
// (name / picture / nip05 / lud16 / lud06). Consumers run it through their own
// sanitizer — setCachedProfile here, safeImageUrl + pickName in
// episode-enhance.js — so this module deliberately does not sanitize.
let byHex = null

function parseContent(ev) {
  try {
    const meta = JSON.parse(ev.content)
    return {
      pubkey:  ev.pubkey,
      name:    meta.display_name || meta.name || '',
      picture: typeof meta.picture === 'string' ? meta.picture : null,
      nip05:   meta.nip05 || '',
      lud16:   typeof meta.lud16 === 'string' ? meta.lud16.trim() : '',
      lud06:   typeof meta.lud06 === 'string' ? meta.lud06.trim() : '',
    }
  } catch {
    return null
  }
}

// Rendered fields are read back out of the SIGNED EVENT, not from the record's
// convenience fields. Verifying the event and then rendering the sibling
// fields would prove nothing about what actually reaches the screen. The
// record's own name/picture stay unread on purpose; they exist for consumers
// that never verify.
//
// ~1.34 ms per event, so ~200 ms for 152 — worth paying against the ~1.4 s
// round trip this replaces, but chunked anyway so it isn't one long task that
// blocks paint. Same rationale as verifyEventsChunked in boosts-thread.js.
async function buildIndex(records) {
  const out = new Map()
  const entries = Object.entries(records)
  for (let i = 0; i < entries.length; i += 40) {
    const end = Math.min(i + 40, entries.length)
    for (let j = i; j < end; j++) {
      const [hex, rec] = entries[j]
      const ev = rec?.event
      if (!ev || ev.kind !== 0 || ev.pubkey !== hex) continue
      if (!verifyEvent(ev)) continue
      const parsed = parseContent(ev)
      if (parsed) out.set(hex, parsed)
    }
    if (end < entries.length) await new Promise((r) => setTimeout(r, 0))
  }
  return out
}

// Resolves to a Map, or to an EMPTY map on any failure. Callers treat an empty
// map and a miss identically, so a dead endpoint degrades to the old live path
// rather than to a page of blank faces.
export function loadProfiles() {
  if (byHex) return Promise.resolve(byHex)
  if (inflight) return inflight

  inflight = (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROFILES_TIMEOUT_MS)
    try {
      const resp = await fetch(PROFILES_URL, { signal: ctrl.signal })
      if (!resp.ok) return new Map()
      const records = await resp.json()
      // An array is boost_wall.json's shape, not this one; treat a wrong shape
      // as a failed fetch rather than iterating it into an empty result.
      if (!records || typeof records !== 'object' || Array.isArray(records)) {
        return new Map()
      }
      const index = await buildIndex(records)
      byHex = index
      return index
    } catch {
      return new Map()
    } finally {
      clearTimeout(timer)
      inflight = null
    }
  })()

  return inflight
}

// Synchronous read for callers that have already awaited loadProfiles().
export function getProfile(hex) {
  return (byHex && byHex.get(hex)) || null
}

// Splits a pubkey list into what the cache answers and what still needs a live
// lookup, so callers express "cache first, network for the rest" in one line.
export async function resolveProfiles(hexes) {
  const index = await loadProfiles()
  const found = new Map()
  const missing = []
  for (const hex of hexes) {
    const p = index.get(hex)
    if (p) found.set(hex, p)
    else missing.push(hex)
  }
  return { found, missing }
}
