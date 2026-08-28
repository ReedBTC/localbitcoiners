/* Featured sections — what the four /feeds tabs share.
 *
 * Every tab can carry a gold "Featured" box: an item lands in it when someone
 * boosts the show with a reference to that item in the message (an naddr for
 * a calendar event, article or listing; the OnlyBoosts episode URL for another
 * podcast's episode). The sats-log bot scans every boost message for those
 * references and writes one row per (item × boost) to the boosted-item log the
 * site reads at /api/meetups; each tab filters that one file to its own kind.
 * The Feature boost also pays the item's maker the show's reassignable split
 * leg (see login-widget/src/lib/featureSplit.js).
 *
 * This module holds the parts that are identical across tabs: reading the log,
 * the optimistic "just featured" store, the pending-feature slot the settle
 * listener pairs with, the maker's Lightning-address lookup, the range control
 * over when something was featured, and the "Featured by … · 3d ago" credit.
 * Rendering stays per tab, since each tab's card is its own thing.
 *
 * ⚠️ THE PENDING SLOT IS ONE SLOT, shared by every tab (boosts are sequential).
 * Each tab's settle listener reads it and claims only a coordinate of its own
 * kind, so no listener can swallow another's.
 */
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'
import { STATIC_RELAYS, fetchProfilesFromPrimal } from '/assets/js/boosts-thread.js'
import { ensureLoginWidget } from '/assets/js/widget-loader.js'
import { PENDING_PROMOTE_KEY, readPendingPromote, clearPendingPromote } from '/assets/js/calendar-events.js'

export { PENDING_PROMOTE_KEY, readPendingPromote, clearPendingPromote }

const FEATURED_LOG = '/api/meetups'

// Record the intent to feature `coord` before handing off to the boost modal.
// A cancelled boost is harmless: the TTL and the "any leg succeeded" gate in
// the settle listeners keep it from featuring anything. `extra` is whatever the
// tab needs back when the boost settles (naddr, guid, feed id, …).
export function setPendingPromote(coord, extra = {}) {
  try {
    localStorage.setItem(PENDING_PROMOTE_KEY, JSON.stringify({ ...extra, coord, ts: Date.now() }))
  } catch {}
}

export function npubToHex(npub) {
  try {
    const d = nip19.decode(npub)
    return d.type === 'npub' ? d.data : ''
  } catch { return '' }
}

export function isWsUrl(u) {
  return typeof u === 'string' && (u.startsWith('wss://') || u.startsWith('ws://'))
}

// settled_at is an ISO-8601 UTC string ("2026-07-21T23:30:46Z"). A row with an
// unparseable timestamp still counts as featured; it just sorts last and only
// shows in the All view (0 is older than any window).
export function parseSettledAt(s) {
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : 0
}

// naddrs carry relay hints — an item featured from outside the community
// snapshot may only live on relays we don't otherwise query.
export function relayHintsFromNaddr(naddr) {
  try {
    const d = nip19.decode(naddr)
    if (d.type === 'naddr' && Array.isArray(d.data.relays)) return d.data.relays.filter(isWsUrl)
  } catch {}
  return []
}

/**
 * Read the boosted-item log and keep the rows `keep(row)` accepts. Returns a
 * coord → { featuredAt, by, sats, naddr } map (newest boost per coordinate
 * wins) plus any relay hints seen on the rows' naddrs. Best-effort: an
 * unreachable log means "nothing featured", never a hard error on a tab.
 */
export async function fetchFeaturedSet(keep, { tag = 'featured' } = {}) {
  const featured = new Map()
  const hints = new Set()
  try {
    const res = await fetch(FEATURED_LOG, { cache: 'no-cache' })
    if (!res.ok) throw new Error('featured log ' + res.status)
    const data = await res.json()
    const rows = Array.isArray(data?.rows) ? data.rows : []
    for (const r of rows) {
      if (!r || typeof r.coordinate !== 'string') continue
      if (!keep(r)) continue
      const featuredAt = parseSettledAt(r.settled_at)
      const prev = featured.get(r.coordinate)
      // Rows arrive newest-first, but don't rely on it: the most recent boost
      // is the one that sets the item's place in the range filter.
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
    console.warn(`[${tag}] featured set load failed`, e)
  }
  return { featured, hints }
}

// ── Optimistic featured set ──────────────────────────────────────────
// A just-boosted item lights up immediately, before the log refresh records
// it. The stored timestamp doubles as the featured-at time for the range
// filter, so a fresh feature lands in the 1W bucket as it should. TTL'd so the
// local copy self-heals once the authoritative log catches up.
const CONFIRMED_TTL = 48 * 60 * 60 * 1000

export function makeConfirmedStore(storageKey, isOurs) {
  function read() {
    const out = new Map()
    try {
      const map = JSON.parse(localStorage.getItem(storageKey) || '{}')
      const now = Date.now()
      for (const [coord, rec] of Object.entries(map)) {
        const ts = typeof rec === 'number' ? rec : (rec && rec.ts) || 0
        if (isOurs(coord) && now - ts <= CONFIRMED_TTL) {
          out.set(coord, { featuredAt: ts, by: null, sats: 0, naddr: (rec && rec.naddr) || '', extra: (rec && rec.extra) || null })
        }
      }
    } catch {}
    return out
  }
  function add(coord, extra = null, naddr = '') {
    const now = Date.now()
    try {
      const map = JSON.parse(localStorage.getItem(storageKey) || '{}')
      for (const [c, rec] of Object.entries(map)) {
        const ts = typeof rec === 'number' ? rec : (rec && rec.ts) || 0
        if (now - ts > CONFIRMED_TTL) delete map[c]
      }
      map[coord] = { ts: now, naddr, extra }
      localStorage.setItem(storageKey, JSON.stringify(map))
    } catch {}
    return now
  }
  return { read, add }
}

// ── Maker's Lightning address ────────────────────────────────────────
// A Feature boost reassigns the show's third split leg (34%) to whoever made
// the thing being featured, so the sats follow the thing being promoted. The
// address comes from their kind-0 profile: lud16 only, since the boost path
// speaks Lightning Addresses and cannot pay a bare lud06 LNURL. When no
// address resolves the boost falls back to the standard show splits, and the
// modal tells the donor why.
//
// Best-effort and time-boxed: the Feature button is already disabled while this
// runs, so the lookup must not be able to hang the flow. A miss costs the
// maker their share of one boost, never the boost itself.
const LOOKUP_TIMEOUT_MS = 2500

export function isLightningAddress(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

// kind-0 straight off the relays, for makers Primal's cache doesn't hold.
async function fetchProfileFromRelays(pubkey, relays = STATIC_RELAYS) {
  const pool = new SimplePool()
  try {
    const ev = await pool.get(relays, { kinds: [0], authors: [pubkey] }).catch(() => null)
    if (!ev || ev.pubkey !== pubkey) return null
    let ok = false
    try { ok = verifyEvent(ev) } catch {}
    if (!ok) return null
    const meta = JSON.parse(ev.content)
    return {
      name: meta.display_name || meta.name || '',
      lud16: typeof meta.lud16 === 'string' ? meta.lud16.trim() : '',
    }
  } catch {
    return null
  } finally {
    try { pool.close(relays) } catch {}
  }
}

/**
 * Resolve the { name, address } the boost modal needs for a maker. `hint` is
 * the caller's already-loaded profile (each tab resolves profiles for its
 * cards), which skips the network entirely. Always returns an object;
 * `address` is '' when the maker has no lud16.
 */
export async function resolveMakerSplit(pubkey, hint = null) {
  const out = { name: hint?.name || '', address: '' }
  if (isLightningAddress(hint?.lud16)) {
    out.address = hint.lud16.trim()
    return out
  }
  if (!/^[0-9a-f]{64}$/i.test(pubkey || '')) return out

  // A hint that resolved but carried no lud16 came from the same Primal cache
  // this would query, so skip straight to the relays; that keeps the worst case
  // at one timeout for the common "maker simply has no address" outcome.
  const primalHint = hint && typeof hint === 'object'
  const fromPrimal = primalHint ? null : await withTimeout(
    fetchProfilesFromPrimal([pubkey]).then((m) => m.get(pubkey) || null),
    LOOKUP_TIMEOUT_MS,
    null,
  )
  const profile = isLightningAddress(fromPrimal?.lud16)
    ? fromPrimal
    : await withTimeout(fetchProfileFromRelays(pubkey), LOOKUP_TIMEOUT_MS, null)

  if (profile?.name && !out.name) out.name = profile.name
  if (isLightningAddress(profile?.lud16)) out.address = profile.lud16.trim()
  return out
}

/**
 * Hand off to the show-boost modal. `feature` is the widget's feature shape
 * ({ kind, pubkey, name, address, recipients, naddr }); the widget resolves a
 * missing address itself. `onFail` gets a message to surface (the caller owns
 * its own toast).
 */
export async function openFeatureBoost({ prefillMessage, feature }, onFail) {
  await ensureLoginWidget()
  if (window.LBLogin?.openShowBoost) window.LBLogin.openShowBoost({ prefillMessage, feature })
  else onFail?.('Boost unavailable right now — please try again')
}

// The signed-in booster, for the immediate "Featured by …" credit a settle
// listener paints before the log catches up. Null when signed out (the log
// will still credit an anonymous feature as "Featured · just now").
export function currentBooster() {
  try {
    const u = window.LBLogin?.getUser?.()
    if (u && u.pubkey) return { pubkey: u.pubkey, name: u.name || '', picture: u.picture || u.image || '' }
  } catch {}
  return null
}

// ── Range over when something was featured ───────────────────────────
// Scoped to the Featured box alone and runs on when an item was FEATURED,
// never on when it was published.
export const FEATURED_RANGES = [['1w', '1W', 7], ['1m', '1M', 30], ['all', 'All', 0]]
export const FEATURED_DEFAULT_RANGE = 'all'

export function rangeDays(key) {
  const row = FEATURED_RANGES.find(([k]) => k === key)
  return row ? row[2] : 0
}

export function rangeLabel(key) {
  const days = rangeDays(key)
  return days === 7 ? 'the last 7 days' : days === 30 ? 'the last 30 days' : ''
}

// How long a feature lasts. An article, listing or episode stays in its box
// for 33 days after its most recent Feature boost, then rejoins the feed with
// its Feature button restored (re-boosting renews it). Events are the
// exception: a featured event stays featured until it happens, so the Events
// tab passes `ttlDays: 0`. Reed's call, 2026-08-27.
export const FEATURE_TTL_DAYS = 33

export function isFeatureLive(info, ttlDays = FEATURE_TTL_DAYS) {
  if (!ttlDays) return true
  return (info?.featuredAt || 0) >= Date.now() - ttlDays * 86400000
}

// Whether an item belongs in the box under `range`: live (see above) AND
// featured within the range's window. `All` therefore means "featured in the
// last 33 days", not "ever".
export function inFeaturedRange(info, range, { ttlDays = FEATURE_TTL_DAYS } = {}) {
  if (!isFeatureLive(info, ttlDays)) return false
  const days = rangeDays(range)
  if (!days) return true
  return (info.featuredAt || 0) >= Date.now() - days * 86400000
}

// Gold-on-gold 1W/1M/All pills that sit INSIDE the box's border, so the
// filter's scope is stated by the layout: every other range control on /feeds
// is page-level.
export function featuredRangeControl(current, onPick, { noun = 'items' } = {}) {
  const wrap = h('div', {
    class: 'feat-range', role: 'group',
    'aria-label': `Filter featured ${noun} by when they were featured`,
  })
  const btns = FEATURED_RANGES.map(([key, label, days]) => {
    const b = h('button', {
      class: 'feat-range-btn', type: 'button', text: label,
      title: days ? `Featured in the last ${days} days` : `Every featured ${noun.replace(/s$/, '')}`,
    })
    b.addEventListener('click', () => { setActive(key); onPick(key) })
    return b
  })
  function setActive(key) {
    btns.forEach((el, i) => {
      const on = FEATURED_RANGES[i][0] === key
      el.classList.toggle('is-active', on)
      el.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
  }
  setActive(current)
  wrap.append(...btns)
  return wrap
}

/** The gold box's header: ⭐ title, range pills, and a Find button. (No
 *  count beside the title — Reed's call, 2026-08-27; callers may still pass
 *  one and it is ignored.) */
export function featuredHead({ title, range, onRange, noun, findLabel, onFind }) {
  return h('div', { class: 'feat-head' }, [
    h('div', { class: 'feat-title' }, [
      h('span', { class: 'feat-star', 'aria-hidden': 'true', text: '⭐' }),
      h('span', { text: title }),
    ]),
    h('div', { class: 'feat-actions' }, [
      featuredRangeControl(range, onRange, { noun }),
      onFind ? h('button', {
        class: 'feat-find', type: 'button', 'aria-haspopup': 'dialog', onclick: onFind,
      }, [h('span', { 'aria-hidden': 'true', text: '🔍' }), h('span', { text: findLabel })]) : null,
    ]),
  ])
}

export function featuredEmptyEl(range, anyFeatured, { noun, verb }) {
  const label = rangeLabel(range)
  // `anyFeatured` means a LIVE feature exists outside the narrower window;
  // expired ones read as "none yet" so the hint stays an invitation.
  const text = anyFeatured && label
    ? `No ${noun} featured in ${label}.`
    : `No featured ${noun} yet — ${verb}.`
  return h('p', { class: 'feat-empty', text })
}

export function featuredMoreButton(rest, batch, onMore) {
  return h('button', { class: 'feat-more', type: 'button', onclick: onMore },
    `Show ${Math.min(batch, rest)} more featured`)
}

// Compact relative age ("4h ago", "3d ago", "6w ago"). This sits on every
// featured card next to the booster's name, which is what makes the section's
// 1W / 1M / All filter legible without a label explaining it.
export function relAge(ms) {
  if (!ms) return ''
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  const wks = Math.round(days / 7)
  if (wks < 6) return `${wks}w ago`
  const mos = Math.round(days / 30)
  if (mos < 12) return `${mos}mo ago`
  return `${Math.round(days / 365)}y ago`
}

// The Feature button's bolt: orange fill + white SVG bolt is the house
// convention for orange-background buttons (never the ⚡ emoji).
export const FEATURE_BOLT_SVG =
  '<svg class="feat-bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>'

/**
 * "Featured by (pfp) Name · 3d ago" — who paid to feature this item, sitting
 * where the Feature button is on an unfeatured card. Muted, so it reads as a
 * credit rather than another action. `avatar(pubkey)` and `name(pubkey)` come
 * from the tab (each keeps its own profile cache); `link(pubkey)` returns an
 * OnlyBoosts URL or null, and `onCopy(pubkey)` is the copy-npub fallback.
 */
export function featuredByEl(info, { avatar, name, link, onCopy, cls = 'feat-by' }) {
  const when = relAge(info?.featuredAt)
  if (!info || !info.by || !info.by.pubkey) {
    return when ? h('span', { class: `${cls} ${cls}--anon` }, [
      h('span', { class: `${cls}-label`, text: 'Featured' }),
      h('span', { class: `${cls}-when`, text: when }),
    ]) : null
  }
  const pk = info.by.pubkey
  const who = name(pk)
  const url = link ? link(pk) : null
  // Only the person is clickable: "Featured by" and the age are plain text,
  // the pfp + name open their OnlyBoosts page (or copy their npub).
  const person = [avatar(pk), h('span', { class: `${cls}-name`, text: who })]
  const target = url
    ? h('a', {
        class: `${cls}-who`, href: url, target: '_blank', rel: 'noopener noreferrer',
        title: 'View ' + who + ' on OnlyBoosts',
        onclick: (e) => e.stopPropagation(),
      }, person)
    : h('button', {
        class: `${cls}-who`, type: 'button', title: 'Copy npub',
        onclick: (e) => { e.stopPropagation(); onCopy?.(pk) },
      }, person)
  const el = h('span', { class: cls }, [
    h('span', { class: `${cls}-label`, text: 'Featured by' }),
    target,
  ])
  if (when) el.appendChild(h('span', { class: `${cls}-when`, text: '· ' + when }))
  return el
}

// ── Tiny DOM helper (same contract as the tab modules' h) ────────────
export function h(tag, attrs = {}, children = []) {
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
