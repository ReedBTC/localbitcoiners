/* OnlyBoosts booster index — shared across every surface that renders a person.
 *
 * WHAT THIS CHANGES. Historically, clicking a person anywhere on this site
 * copied their npub. Now, if that person has a page on OnlyBoosts, the click
 * opens it in a new tab and their avatar carries a small blue dot; if they do
 * not, the click still copies the npub exactly as before. The dot is the only
 * way to tell the two apart before clicking, so it is load-bearing rather than
 * decorative.
 *
 * ⚠️ THE SET MUST BE KNOWN BEFORE A CARD RENDERS, which is why every consumer
 * awaits ready() rather than calling hasBoosterPage() straight away. Two
 * reasons, both of which cost real behavior if ignored:
 *
 *   1. A booster renders as <a href>, a non-booster as <button>. Deciding late
 *      means rebuilding nodes underneath the profile-upgrade registries the
 *      surfaces keep, or shipping a <button> that fakes a link and loses
 *      middle-click and open-in-new-tab.
 *   2. window.open() called after an await is a popup, not a navigation, and
 *      mobile Safari and Chrome both block it. Deciding up front keeps the
 *      click handler synchronous.
 *
 * ⚠️ ready() RESOLVES EVEN WHEN THE FETCH FAILS. It is not a gate on the
 * feature working, it is a gate on knowing the answer. An empty set means every
 * person falls back to copy-npub, which is precisely the old behavior, so a
 * dead upstream degrades instead of blanking the page. The timeout exists so a
 * slow upstream cannot hold up a supporters grid indefinitely.
 *
 * WHY THE PROXY. OnlyBoosts' /api/v1 CORS allowlist is shared by all of its
 * endpoints and deliberately excludes localbitcoiners.com, so the browser
 * cannot fetch it directly and this goes through functions/api/onlyboosts-boosters.js.
 * See the note in that file before "simplifying" the URL below.
 */

import { nip19 } from '/assets/widgets/nostr-tools.js'

const INDEX_URL = '/api/onlyboosts-boosters'
const BOOSTER_BASE = 'https://onlyboosts.social/booster/'

const CACHE_KEY = 'lb:onlyboosts-boosters'
// Six hours. The set only grows when someone boosts a podcast for the first
// time ever, and a stale miss costs a copy-npub click where a link was
// possible. Nothing here is worth a fetch per page view.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// Hard ceiling on how long a card render will wait. Past this the surfaces
// paint with whatever is known (usually nothing on a cold, slow load) and the
// page behaves the way it did before this feature existed.
const READY_TIMEOUT_MS = 2500

let boosterSet = null
let loadPromise = null

// ── identity normalization ───────────────────────────────────────────
// Surfaces are split on which form they hold: supporters.js and
// feeds-podcasts.js carry npubs, calendar-events.js and feeds-articles.js carry
// hex off the event, merch.js carries both. Everything here accepts either and
// memoizes, because a supporters grid asks about the same person from several
// tiers and 100+ bech32 round trips per paint is not free.
const hexCache = new Map()
const npubCache = new Map()

function toHex(id) {
  if (!id) return null
  if (/^[0-9a-f]{64}$/i.test(id)) return id.toLowerCase()
  const hit = hexCache.get(id)
  if (hit !== undefined) return hit
  let hex = null
  try {
    const d = nip19.decode(id)
    if (d?.type === 'npub' && typeof d.data === 'string') hex = d.data.toLowerCase()
  } catch {}
  hexCache.set(id, hex)
  return hex
}

function toNpub(id) {
  if (!id) return null
  if (typeof id === 'string' && id.startsWith('npub1')) return id
  const hex = toHex(id)
  if (!hex) return null
  const hit = npubCache.get(hex)
  if (hit !== undefined) return hit
  let npub = null
  try { npub = nip19.npubEncode(hex) } catch {}
  npubCache.set(hex, npub)
  return npub
}

// ── the set ──────────────────────────────────────────────────────────

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const rec = JSON.parse(raw)
    if (!rec || !Array.isArray(rec.pubkeys) || !Number.isFinite(rec.at)) return null
    return rec
  } catch { return null }
}

function writeCache(pubkeys) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), pubkeys }))
  } catch {
    // Quota or private-browsing. The in-memory set still works for this page
    // load; the next one just pays for the fetch again.
  }
}

async function fetchIndex() {
  const resp = await fetch(INDEX_URL, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error('onlyboosts index ' + resp.status)
  const data = await resp.json()
  if (!data || !Array.isArray(data.pubkeys)) throw new Error('onlyboosts index malformed')
  return data.pubkeys
}

function load() {
  if (loadPromise) return loadPromise

  // Stale-while-revalidate. A cached set — even an expired one — is applied
  // immediately so a returning visitor gets correct dots on first paint, and
  // the network only decides what the NEXT paint looks like.
  const cached = readCache()
  if (cached) boosterSet = new Set(cached.pubkeys)
  const fresh = cached && (Date.now() - cached.at) < CACHE_TTL_MS

  if (fresh) {
    loadPromise = Promise.resolve(boosterSet)
    return loadPromise
  }

  loadPromise = fetchIndex()
    .then((pubkeys) => {
      boosterSet = new Set(pubkeys)
      writeCache(pubkeys)
      return boosterSet
    })
    .catch(() => {
      // Keep whatever the cache gave us. Only a cold cache plus a failed fetch
      // lands on an empty set, and that is the pre-feature behavior.
      if (!boosterSet) boosterSet = new Set()
      return boosterSet
    })

  return loadPromise
}

/** Resolves once the answer is known, or once waiting stops being worth it. */
export function ready() {
  return Promise.race([
    load(),
    new Promise((res) => setTimeout(() => res(boosterSet), READY_TIMEOUT_MS)),
  ]).then(() => undefined)
}

/** Synchronous. False until ready() has resolved — call it after, not before. */
export function hasBoosterPage(id) {
  if (!boosterSet) return false
  const hex = toHex(id)
  return !!hex && boosterSet.has(hex)
}

/** The person's OnlyBoosts page, or null if their id will not encode. */
export function boosterUrl(id) {
  const npub = toNpub(id)
  return npub ? BOOSTER_BASE + npub : null
}

// ── the dot ──────────────────────────────────────────────────────────

/**
 * Marks an avatar as belonging to someone with an OnlyBoosts page. Sizing and
 * color live in assets/css/onlyboosts.css; this only attaches the node.
 * aria-hidden because the meaning is already carried by the link's own label —
 * a screen reader announcing "blue dot" would be noise.
 */
export function addBoosterDot(avatarEl) {
  if (!avatarEl || avatarEl.querySelector(':scope > .ob-dot')) return
  avatarEl.classList.add('ob-has-dot')
  avatarEl.appendChild(makeDot())
}

/**
 * Same mark, for an avatar that cannot hold a child. The podcast-boosts feed
 * renders its avatars as a bare <img> (it swaps to an initials chip on load
 * error), and appending a span to an <img> does nothing at all, so that node
 * gets a wrapper instead. Returns the node to insert in the avatar's place.
 *
 * Only for elements not yet in the DOM — it does not re-parent anything.
 */
export function wrapWithDot(node) {
  const wrap = document.createElement('span')
  wrap.className = 'ob-dot-wrap'
  wrap.appendChild(node)
  wrap.appendChild(makeDot())
  return wrap
}

function makeDot() {
  const dot = document.createElement('span')
  dot.className = 'ob-dot'
  dot.setAttribute('aria-hidden', 'true')
  return dot
}

// ── the shared decision ──────────────────────────────────────────────

/**
 * The one place the link-or-copy choice is made, so all six surfaces stay in
 * step. Call it AFTER awaiting ready().
 *
 *   el      the clickable element. An <a> gets href/target/rel; anything else
 *           gets a synchronous click handler that opens the same URL.
 *   id      npub or hex pubkey.
 *   name    display name, for the title and aria-label.
 *   avatar  optional; gets the dot.
 *   onCopy  the surface's existing copy behavior, used when there is no page.
 *
 * Returns true if it wired a link, false if it left the copy path in place —
 * callers use that to pick their element type.
 */
export function wireBoosterAction(el, { id, name, avatar, onCopy } = {}) {
  const url = hasBoosterPage(id) ? boosterUrl(id) : null

  if (!url) {
    if (onCopy) el.addEventListener('click', onCopy)
    return false
  }

  const who = name || 'this booster'
  el.title = 'View ' + who + ' on OnlyBoosts'
  el.setAttribute('aria-label', 'View ' + who + ' on OnlyBoosts')

  if (el.tagName === 'A') {
    el.href = url
    el.target = '_blank'
    el.rel = 'noopener noreferrer'
  } else {
    // Synchronous by construction — see the popup-blocker note at the top.
    el.addEventListener('click', () => { window.open(url, '_blank', 'noopener') })
  }

  if (avatar) addBoosterDot(avatar)
  return true
}

// Kick the fetch off at import so it overlaps with the relay and JSON work
// every consuming surface is already doing, rather than starting when the
// first card wants an answer.
load()

// supporters.js is a classic deferred script and cannot import. It reads the
// module off the global instead; see the wiring note there.
window.LBOnlyBoosts = { ready, hasBoosterPage, boosterUrl, addBoosterDot, wrapWithDot, wireBoosterAction }
