/* Community Feeds page — per-tab Nostr feeds, scoped to the show's
 * supporters.
 *
 * "Supporters" = every pubkey listed in the show's own follow packs
 * (following.space kind-39089, published by bots/follow-packs from the
 * show account). We union the p-tags across all of the show's packs
 * (100k / 69k / 21k / other / guests / coders) into one membership set,
 * then each feed only shows content authored by those pubkeys.
 *
 * The EVENTS tab (NIP-52 calendar events, kinds 31922/31923) is rendered
 * with the same card as the Meetups page via the shared renderer in
 * calendar-events.js; Marketplace, Podcast Boosts, and Articles each lazy-
 * import their own module (feeds-market / feeds-podcasts / feeds-articles).
 *
 * Feeds load lazily: a tab's fetch only fires the first time that tab
 * becomes active (driven by the `lb:feed-activate` event dispatched from
 * the inline tab controller in feeds.html, plus a load of whichever feed
 * is active when this module first runs).
 */
import { STATIC_RELAYS, fetchProfilesFromPrimal } from '/assets/js/boosts-thread.js'
import {
  parseCalendarEvent,
  renderCalendarCard,
  eventStartMs,
  eventEndMs,
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
} from '/assets/js/calendar-events.js'
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'
// Supporter-set resolution lives in one shared module; re-exported below so
// home-feeds.js keeps importing resolveSupporters from feeds.js unchanged.
import { resolveSupporters } from '/assets/js/supporter-set.js'

// Hourly events snapshot (Cloudflare Pages Function proxying the file
// bots/community-feeds pushes to the VPS). It carries the same raw signed
// calendar events a live relay query would, but already scoped to the show's
// supporters with NIP-09 deletions + NIP-01 replacements resolved server-side
// — so a tab open is one cached GET instead of follow-pack resolution + a
// multi-relay subscription. The live path (resolveSupporters + streamEvents)
// stays as the fallback when the snapshot is unreachable.
const EVENTS_SNAPSHOT_URL = '/api/community-events'

// Chunk authors so a single relay filter never carries an unreasonable
// number of `authors`, which some relays cap or reject.
const AUTHOR_CHUNK = 50

// ── DOM state helpers ────────────────────────────────────────────────
function showSkeletons(list, n = 3) {
  list.className = 'feed-list'
  list.innerHTML = ''
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div')
    s.className = 'feed-skeleton'
    list.appendChild(s)
  }
}

function renderPlaceholder(list, title, body) {
  list.className = ''
  list.innerHTML = ''
  const ph = document.createElement('div')
  ph.className = 'feed-placeholder'
  const strong = document.createElement('strong')
  strong.textContent = title
  ph.appendChild(strong)
  ph.appendChild(document.createTextNode(body))
  list.appendChild(ph)
}

function setCount(panel, n) {
  const c = panel.querySelector('.feed-count')
  if (!c) return
  c.textContent = n === 1 ? '1 upcoming' : `${n} upcoming`
  c.hidden = false
}

const KIND_DELETION = 5

function chunkAuthors(authors) {
  const chunks = []
  for (let i = 0; i < authors.length; i += AUTHOR_CHUNK) {
    chunks.push(authors.slice(i, i + AUTHOR_CHUNK))
  }
  return chunks
}

// Apply one NIP-09 deletion (kind 5) into the running state: collect the
// deleted event ids (`e` tags) and deleted addressable coordinates (`a`
// tags → the deletion's created_at, so a later re-publish isn't wrongly
// hidden). A coordinate deletion is only honoured for a coordinate the
// deleter owns; the `e`-tag case is implicit since we only match against
// events from these same authors.
function applyDeletion(state, ev) {
  const at = ev.created_at || 0
  for (const t of ev.tags || []) {
    if (!Array.isArray(t)) continue
    if (t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || '')) {
      state.deletedIds.add(t[1].toLowerCase())
    } else if (t[0] === 'a' && typeof t[1] === 'string') {
      const coordPubkey = (t[1].split(':')[1] || '').toLowerCase()
      if (coordPubkey !== ev.pubkey.toLowerCase()) continue
      const prev = state.deletedCoords.get(t[1])
      if (prev == null || at > prev) state.deletedCoords.set(t[1], at)
    }
  }
}

// Merge one calendar event into state, keeping only the newest version
// per coordinate (NIP-01 replacement). Returns true if state changed.
function mergeCalendarEvent(state, ev) {
  const parsed = parseCalendarEvent(ev)
  if (!parsed) return false
  const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
  const prev = state.eventsByCoord.get(coord)
  if (prev && (ev.created_at || 0) <= (prev.createdAt || -1)) return false
  parsed.createdAt = ev.created_at || 0
  parsed.id = ev.id || ''
  state.eventsByCoord.set(coord, parsed)
  return true
}

// ── Progressive fetch — stream events + deletions, calling onUpdate as
// state changes so the view can repaint incrementally. Resolves once all
// relays have sent EOSE (or a safety timeout fires). Untrusted source —
// verify every event. ──
function streamEvents(authors, relays, state, onUpdate) {
  return new Promise((resolve) => {
    if (!authors.length) return resolve()
    const pool = new SimplePool()
    // NOTE: this vendored nostr-tools' subscribeMany takes a SINGLE filter
    // object (not an array), so we open one subscription per author chunk,
    // each combining the calendar + deletion kinds into one filter.
    const filters = chunkAuthors(authors).map((chunk) => ({
      kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT, KIND_DELETION],
      authors: chunk,
      limit: 500,
    }))

    const subs = []
    let done = false
    let eosed = 0
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(safety)
      for (const s of subs) { try { s.close() } catch {} }
      try { pool.close(relays) } catch {}
      resolve()
    }
    const safety = setTimeout(finish, 8000)

    const handlers = {
      onevent(ev) {
        if (!ev || !verifyEvent(ev)) return
        let changed = false
        if (ev.kind === KIND_DELETION) { applyDeletion(state, ev); changed = true }
        else changed = mergeCalendarEvent(state, ev)
        if (changed) onUpdate()
      },
      oneose() { if (++eosed >= filters.length) finish() },
    }

    for (const filter of filters) {
      subs.push(pool.subscribeMany(relays, filter, handlers))
    }
  })
}

// Pull the hourly events snapshot. Returns raw signed events (verified here —
// the transport is untrusted even if the source is our own bot); throws if the
// endpoint is unreachable or returns a non-array, so the caller can fall back
// to the live relay path.
async function fetchEventsSnapshot() {
  const res = await fetch(EVENTS_SNAPSHOT_URL, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`community-events ${res.status}`)
  const data = await res.json()
  const events = Array.isArray(data?.events) ? data.events : null
  if (!events) throw new Error('community-events: unexpected shape')
  return events.filter((ev) => ev && verifyEvent(ev))
}

// Fold a batch of raw events into state using the exact same merge + deletion
// rules streamEvents applies to live events. On a clean snapshot the deletion
// pass is a no-op (the bot strips deleted/superseded events), but running it
// keeps this path behaviourally identical to the relay fallback.
function ingestEvents(state, events) {
  for (const ev of events) {
    if (ev.kind === KIND_DELETION) applyDeletion(state, ev)
    else mergeCalendarEvent(state, ev)
  }
}

// Build the render-ready item list from the current state, honouring
// deletions and dropping events with no readable start.
function computeItems(state) {
  const items = []
  for (const parsed of state.eventsByCoord.values()) {
    if (parsed.id && state.deletedIds.has(parsed.id.toLowerCase())) continue
    const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
    const delAt = state.deletedCoords.get(coord)
    if (delAt != null && delAt >= (parsed.createdAt || 0)) continue
    const startMs = eventStartMs(parsed)
    if (!Number.isFinite(startMs)) continue
    items.push({
      parsed,
      startMs,
      endMs: eventEndMs(parsed),
      naddr: naddrFor(parsed, state.relays),
      profile: state.profiles.get(parsed.pubkey) || null,
    })
  }
  return items
}

// ── localStorage cache (stale-while-revalidate) ──────────────────────
const CACHE_KEY = 'lb_feeds_events_v2'
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000  // ignore cache older than a day

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    // Require a non-empty snapshot — an empty one is never worth painting.
    if (!data || !Array.isArray(data.events) || !data.events.length) return null
    if (Date.now() - (data.ts || 0) > CACHE_MAX_AGE) return null
    return data
  } catch { return null }
}

function hydrateStateFromCache(state, cached) {
  for (const parsed of cached.events) {
    if (!parsed || !parsed.kind || !parsed.pubkey || !parsed.dTag) continue
    state.eventsByCoord.set(`${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`, parsed)
  }
  for (const id of cached.deletedIds || []) state.deletedIds.add(id)
  for (const pair of cached.deletedCoords || []) {
    if (Array.isArray(pair)) state.deletedCoords.set(pair[0], pair[1])
  }
  for (const pair of cached.profiles || []) {
    if (Array.isArray(pair)) state.profiles.set(pair[0], pair[1])
  }
}

function writeCache(state) {
  // Never persist an empty snapshot — a failed/empty fetch shouldn't
  // overwrite a good cache or seed a useless one.
  if (!state.eventsByCoord.size) return
  try {
    const data = {
      ts: Date.now(),
      events: [...state.eventsByCoord.values()],
      deletedIds: [...state.deletedIds],
      deletedCoords: [...state.deletedCoords.entries()],
      profiles: [...state.profiles.entries()].map(([pk, p]) => [pk, { name: p?.name || '', picture: p?.picture || '' }]),
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch {}
}

function naddrFor(parsed, relays) {
  try {
    return nip19.naddrEncode({
      identifier: parsed.dTag,
      pubkey: parsed.pubkey,
      kind: parsed.kind,
      relays: relays.slice(0, 2),
    })
  } catch {
    return ''
  }
}

function renderCard(item) {
  return renderCalendarCard(item.parsed, {
    bech32: item.naddr,
    profile: item.profile,
    actions: true,
  })
}

// A group renders as its primary card. When it has duplicates, a "See
// other versions" toggle sits at the left of the card's action row
// (Renote + Zap pushed right), and an in-card panel below the action bar
// holds the other versions as full cards.
function renderGroup(group) {
  if (!group.versions || !group.versions.length) return renderCard(group)

  const n = group.versions.length
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'versions-toggle'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.innerHTML =
    '<span class="versions-caret" aria-hidden="true">▸</span>' +
    `<span>Other Versions (${n})</span>`

  const card = renderCalendarCard(group.parsed, {
    bech32: group.naddr,
    profile: group.profile,
    actions: true,
    actionsLeft: toggle,
  })

  const panel = document.createElement('div')
  panel.className = 'event-versions-panel'
  panel.hidden = true
  for (const v of group.versions) panel.appendChild(renderCard(v))

  // Drop the panel in right after the action bar (both live in the card's
  // content column, thumbnail or not).
  const bar = card.querySelector('.note-actions')
  if (bar && bar.parentNode) bar.parentNode.insertBefore(panel, bar.nextSibling)
  else card.appendChild(panel)

  toggle.addEventListener('click', () => {
    const opening = panel.hidden
    panel.hidden = !opening
    toggle.classList.toggle('is-open', opening)
    toggle.setAttribute('aria-expanded', opening ? 'true' : 'false')
  })

  return card
}

function buildGrid(groups) {
  const grid = document.createElement('div')
  grid.className = 'feed-list'
  for (const g of groups) grid.appendChild(renderGroup(g))
  return grid
}

// ── Month/year browser ───────────────────────────────────────────────
// The events feed is browsed a month at a time: two dropdowns (month +
// year, default = the current month/year) filter the list to events whose
// start falls in that month. Going back through the picker surfaces past
// events, so there's no separate "past" section.
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MIN_YEAR = 2022      // oldest selectable year
const FUTURE_YEARS = 6     // how far ahead the picker goes

// The year+month an event's start falls in. Date-based events are
// UTC-anchored (their start is a bare Y-M-D); time-based use local time.
function eventYearMonth(item) {
  const d = new Date(item.startMs)
  return item.parsed.isDateBased
    ? { year: d.getUTCFullYear(), month: d.getUTCMonth() }
    : { year: d.getFullYear(), month: d.getMonth() }
}

// Content key for collapsing re-posted duplicates: same author + same
// (normalized) title + exact same start value. The raw `start` is used so
// the match is exact — an all-day event's YYYY-MM-DD or a timed event's
// epoch second; the two formats never collide across event types.
function versionKey(item) {
  const p = item.parsed
  const title = (p.title || '').trim().toLowerCase().replace(/\s+/g, ' ')
  return `${p.pubkey}|${title}|${p.start}`
}

// Collapse duplicate events into groups. Each group's primary is the
// version with the highest created_at; the rest ride along as `versions`
// (newest-first). The primary's fields are spread onto the group so it can
// be treated like an item for month bucketing / sorting.
function groupItems(items) {
  const groups = new Map()
  for (const item of items) {
    const key = versionKey(item)
    const arr = groups.get(key)
    if (arr) arr.push(item)
    else groups.set(key, [item])
  }
  const out = []
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.parsed.createdAt || 0) - (a.parsed.createdAt || 0))
    out.push({ ...arr[0], versions: arr.slice(1) })
  }
  return out
}

// A calendar event counts as "in-person" when its `location` tag is populated.
// Events with no location (virtual) are hidden from the Events tab by default;
// the "Include virtual events" toggle shows them.
function hasLocation(item) {
  const loc = item?.parsed?.location
  return typeof loc === 'string' && loc.trim() !== ''
}

function renderMonth(panel, allItems, year, month, includeVirtual = true) {
  const list = panel.querySelector('[data-feed-list]')
  list.className = ''
  list.innerHTML = ''

  const visible = includeVirtual ? allItems : allItems.filter(hasLocation)
  const matches = groupItems(visible).filter((g) => {
    const ym = eventYearMonth(g)
    return ym.year === year && ym.month === month
  })

  if (!matches.length) {
    renderPlaceholder(
      list,
      `No events in ${MONTH_NAMES[month]} ${year}`,
      'Try another month — or check back as supporters post new events.'
    )
    return
  }

  // Within the selected month: upcoming at the top (soonest first), the
  // rest tucked into a collapsed "Past Events" chip below (most recent
  // first).
  const now = Date.now()
  const upcoming = matches.filter((i) => i.endMs >= now).sort((a, b) => a.startMs - b.startMs)
  const past = matches.filter((i) => i.endMs < now).sort((a, b) => b.startMs - a.startMs)

  if (upcoming.length) {
    list.appendChild(buildGrid(upcoming))
  } else {
    const ph = document.createElement('div')
    ph.className = 'feed-placeholder'
    const strong = document.createElement('strong')
    strong.textContent = `No upcoming events in ${MONTH_NAMES[month]} ${year}`
    ph.appendChild(strong)
    ph.appendChild(document.createTextNode('These have already happened — see Past Events below.'))
    list.appendChild(ph)
  }

  if (past.length) {
    const details = document.createElement('details')
    details.className = 'feed-past'
    const summary = document.createElement('summary')
    summary.textContent = `Past Events (${past.length})`
    details.appendChild(summary)
    details.appendChild(buildGrid(past))
    list.appendChild(details)
  }
}

// Build the month + year dropdowns and wire changes to `onChange`. Does
// NOT paint on its own — returns the default { year, month } so the caller
// controls the first render (cache vs skeletons).
function buildMonthNav(panel, onChange) {
  const nav = panel.querySelector('[data-month-nav]')
  if (!nav) return { year: new Date().getFullYear(), month: new Date().getMonth() }
  nav.innerHTML = ''

  const now = new Date()
  const curYear = now.getFullYear()
  const maxYear = curYear + FUTURE_YEARS

  const monthSel = document.createElement('select')
  monthSel.className = 'feed-select'
  monthSel.setAttribute('aria-label', 'Month')
  MONTH_NAMES.forEach((name, idx) => {
    const opt = document.createElement('option')
    opt.value = String(idx)
    opt.textContent = name
    monthSel.appendChild(opt)
  })
  monthSel.value = String(now.getMonth())

  const yearSel = document.createElement('select')
  yearSel.className = 'feed-select'
  yearSel.setAttribute('aria-label', 'Year')
  for (let y = maxYear; y >= MIN_YEAR; y--) {
    const opt = document.createElement('option')
    opt.value = String(y)
    opt.textContent = String(y)
    yearSel.appendChild(opt)
  }
  yearSel.value = String(Math.min(Math.max(curYear, MIN_YEAR), maxYear))

  const fire = () => onChange(parseInt(yearSel.value, 10), parseInt(monthSel.value, 10))
  monthSel.addEventListener('change', fire)
  yearSel.addEventListener('change', fire)

  nav.appendChild(monthSel)
  nav.appendChild(yearSel)
  nav.hidden = false

  return { year: parseInt(yearSel.value, 10), month: parseInt(monthSel.value, 10) }
}

// "Include virtual events" toggle for the Events panel head (shared pill markup
// with the Articles tab's toggle). Off by default → events with no `location`
// tag are hidden. Calls onChange(checked) on flip.
function buildVirtualToggle(panel, onChange) {
  const mount = panel.querySelector('[data-virtual-toggle]')
  if (!mount) return
  mount.innerHTML = ''

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'feed-toggle-input'
  input.setAttribute('role', 'switch')
  input.addEventListener('change', () => onChange(input.checked))

  const thumb = document.createElement('span')
  thumb.className = 'feed-toggle-thumb'
  const track = document.createElement('span')
  track.className = 'feed-toggle-track'
  track.setAttribute('aria-hidden', 'true')
  track.appendChild(thumb)

  const label = document.createElement('span')
  label.className = 'feed-toggle-label'
  label.textContent = 'Include virtual events'

  const wrap = document.createElement('label')
  wrap.className = 'feed-toggle'
  wrap.append(input, track, label)
  mount.appendChild(wrap)
}

// ── Shared supporter resolution ──────────────────────────────────────
// resolveSupporters now lives in supporter-set.js (the one source shared
// with community-status.js). Re-exported here so home-feeds.js — which
// imports it from feeds.js — keeps working unchanged.
export { resolveSupporters }

// One-shot fetch of the soonest upcoming events from the supporter set,
// grouped (duplicates collapsed) and sorted soonest-first, with organizer
// profiles attached to the returned slice. Powers the homepage teaser; the
// full Events tab (loadEvents) keeps its own streaming/month-browser path.
export async function fetchUpcomingEvents(supporters, { limit = 12 } = {}) {
  const { relays, members } = supporters || {}
  if (!members || !members.length) return []
  const state = {
    eventsByCoord: new Map(),
    deletedIds: new Set(),
    deletedCoords: new Map(),
    profiles: new Map(),
    relays,
  }
  await streamEvents(members, relays, state, () => {})

  const now = Date.now()
  const upcoming = groupItems(computeItems(state))
    .filter((g) => g.endMs >= now)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, limit)

  try {
    const pubkeys = [...new Set(upcoming.map((g) => g.parsed.pubkey).filter(Boolean))]
    if (pubkeys.length) {
      const profiles = await fetchProfilesFromPrimal(pubkeys)
      for (const g of upcoming) g.profile = profiles.get(g.parsed.pubkey) || g.profile
    }
  } catch (e) {
    console.warn('[feeds] upcoming-events profile fetch failed', e)
  }
  return upcoming
}

// ── Events tab loader ────────────────────────────────────────────────
// Cache-first: paint instantly from localStorage if we have a recent
// snapshot, then refresh from the hourly /api/community-events snapshot (one
// cached GET). If that endpoint is unreachable, fall back to the live path —
// resolve supporters and stream events in from relays, repainting (debounced)
// as they arrive. Switching months never re-fetches — it re-filters the
// in-memory state.
async function loadEvents() {
  const panel = document.getElementById('panel-events')
  if (!panel) return
  const list = panel.querySelector('[data-feed-list]')
  if (!list) return

  const state = {
    eventsByCoord: new Map(),
    deletedIds: new Set(),
    deletedCoords: new Map(),
    profiles: new Map(),
    relays: STATIC_RELAYS,
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    includeVirtual: false,  // hide no-location (virtual) events until toggled on
  }

  const paint = () => renderMonth(panel, computeItems(state), state.year, state.month, state.includeVirtual)

  // Debounced repaint so a burst of streamed events doesn't thrash the DOM.
  let paintTimer = null
  const schedulePaint = () => {
    clearTimeout(paintTimer)
    paintTimer = setTimeout(paint, 200)
  }

  // "Include virtual events" toggle (off by default) — repaints from state.
  buildVirtualToggle(panel, (on) => { state.includeVirtual = on; paint() })

  // Dropdowns render immediately; changing them repaints from state.
  const sel = buildMonthNav(panel, (year, month) => {
    state.year = year
    state.month = month
    paint()
  })
  state.year = sel.year
  state.month = sel.month

  // 1. Instant paint from cache (stale-while-revalidate).
  const cached = readCache()
  if (cached) {
    hydrateStateFromCache(state, cached)
    paint()
  } else {
    showSkeletons(list)
  }

  // 2. Refresh — prefer the hourly snapshot, fall back to a live relay query.
  try {
    let snapshot = null
    try {
      snapshot = await fetchEventsSnapshot()
      state.relays = STATIC_RELAYS
    } catch (snapErr) {
      console.warn('[feeds] events snapshot unavailable — querying relays', snapErr)
    }

    if (snapshot) {
      ingestEvents(state, snapshot)
    } else {
      // Fallback: resolve supporters, then stream events + deletions from
      // relays, repainting as they land.
      const { relays, members: memberList } = await resolveSupporters()
      state.relays = relays
      if (!memberList.length) {
        if (!state.eventsByCoord.size) {
          renderPlaceholder(list, 'No supporters found', 'Couldn’t reach the follow packs right now — please try again later.')
        }
        return
      }
      await streamEvents(memberList, state.relays, state, schedulePaint)
    }

    // Organizer profiles (avatar + name) once the author set is known.
    try {
      const pubkeys = [...new Set([...state.eventsByCoord.values()].map((p) => p.pubkey).filter(Boolean))]
      if (pubkeys.length) {
        const profiles = await fetchProfilesFromPrimal(pubkeys)
        profiles.forEach((prof, pk) => state.profiles.set(pk, prof))
      }
    } catch (e) {
      console.warn('[feeds] event profile fetch failed', e)
    }

    clearTimeout(paintTimer)
    paint()
    writeCache(state)
  } catch (e) {
    console.error('[feeds] events load failed', e)
    if (!state.eventsByCoord.size) {
      renderPlaceholder(list, 'Couldn’t load events', 'Something went wrong reaching the relays — please try again later.')
    }
  }
}

// ── Marketplace tab loader ───────────────────────────────────────────
// Lazy-imports the heavier marketplace module (which pulls in merch.js's cart
// / checkout / gift-wrap send) only when the tab is actually opened, then hands
// off to renderMarket. Like the Events tab, the listings now come from the
// hourly snapshot (renderMarket → loadMarketItems fetches it), so there's no
// supporter/outbox resolution here — that only runs inside the relay fallback.
async function loadMarket() {
  const panel = document.getElementById('panel-market')
  if (!panel) return
  const list = panel.querySelector('[data-feed-list]')
  if (!list) return

  // Replace the static placeholder with skeletons up front — lazy-importing the
  // market module (which pulls in merch.js) takes a moment, and renderMarket
  // only paints its own skeletons afterwards.
  showSkeletons(list)

  try {
    const mod = await import('/assets/js/feeds-market.js')
    await mod.renderMarket({ panel, list })
  } catch (e) {
    console.error('[feeds] market load failed', e)
    renderPlaceholder(list, 'Couldn’t load the marketplace', 'Something went wrong reaching the community marketplace — please try again later.')
  }
}

// Podcast Boosts — episodes the community has boosted on Nostr. Unlike the
// other tabs this isn't a live relay subscription: it reads the pre-computed
// /api/community-boosts snapshot (built hourly by bots/community-boosts), so
// there's no supporter/relay resolution here — just hand the panel to the
// module and let it fetch. Lazy-imported on first view like the market feed.
async function loadPodcasts() {
  const panel = document.getElementById('panel-podcasts')
  if (!panel) return
  const list = panel.querySelector('[data-feed-list]')
  showSkeletons(list)
  try {
    const mod = await import('/assets/js/feeds-podcasts.js')
    await mod.renderPodcasts({ panel, list })
  } catch (e) {
    console.error('[feeds] podcast boosts load failed', e)
    renderPlaceholder(list, 'Couldn’t load podcast boosts', 'Something went wrong reaching the community boosts feed — please try again later.')
  }
}

// Articles — NIP-23 long-form (kind 30023) from the community. Like the market
// and podcast feeds this reads a pre-computed snapshot (/api/community-articles,
// built hourly by bots/community-feeds) rather than a live subscription, so
// there's no supporter/relay resolution here — the module fetches, verifies, and
// renders the list plus its in-panel reader. Lazy-imported on first view (it
// pulls in the vendored marked + DOMPurify for the reader body).
async function loadArticles() {
  const panel = document.getElementById('panel-articles')
  if (!panel) return
  const list = panel.querySelector('[data-feed-list]')
  if (!list) return
  showSkeletons(list)
  try {
    const mod = await import('/assets/js/feeds-articles.js')
    await mod.renderArticles({ panel, list })
  } catch (e) {
    console.error('[feeds] articles load failed', e)
    renderPlaceholder(list, 'Couldn’t load articles', 'Something went wrong reaching the community articles feed — please try again later.')
  }
}

// ── Lazy per-feed dispatch ───────────────────────────────────────────
const LOADERS = { events: loadEvents, market: loadMarket, podcasts: loadPodcasts, articles: loadArticles }
const loaded = new Set()

function loadFeed(feed) {
  const loader = LOADERS[feed]
  if (!loader || loaded.has(feed)) return
  loaded.add(feed)
  loader()
}

document.addEventListener('lb:feed-activate', (e) => {
  const feed = e?.detail?.feed
  if (feed) loadFeed(feed)
})

// Load whichever feed is active when this module first runs (the inline
// tab controller has already set body[data-active-feed] and may have
// dispatched its activation event before this listener attached).
loadFeed(document.body.dataset.activeFeed || 'events')
