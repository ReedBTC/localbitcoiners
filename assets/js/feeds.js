/* Community Feeds page — per-tab Nostr feeds, scoped to the show's
 * supporters.
 *
 * "Supporters" = every pubkey listed in the show's own follow packs
 * (following.space kind-39089, published by bots/follow-packs from the
 * show account). We union the p-tags across all of the show's packs
 * (100k / 69k / 21k / other / guests / coders) into one membership set,
 * then each feed only shows content authored by those pubkeys.
 *
 * Phase 1 wires up the EVENTS tab (NIP-52 calendar events, kinds
 * 31922/31923), rendered with the same card as the Meetups page via the
 * shared renderer in calendar-events.js. The Notes / Marketplace /
 * Articles tabs keep their static placeholder until later phases.
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

// The show account that owns the supporter follow packs (hex of the
// show npub — same constant supporters.js / bots/follow-packs use).
const SHOW_PUBKEY_HEX = 'c330881e28768381dd8bdfd274341dca0c5882c29b8642ea4bc82f7563264592'
const KIND_FOLLOW_PACK = 39089

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

const KIND_RELAY_LIST = 10002

// The show's own NIP-65 outbox (write) relays — where bots/follow-packs
// publishes the kind-39089 packs. Merged into the query set so we find
// packs (and thus supporters) that live outside the default relays. We
// only resolve the SHOW account's list here, not every supporter's
// (that's the heavier "full outbox" upgrade).
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

// ── Follow-pack membership ───────────────────────────────────────────
// Every p-tag across the show's own kind-39089 packs = the supporter set.
async function fetchPackMembers(relays) {
  const members = new Set()
  const pool = new SimplePool()
  try {
    const evs = await pool
      .querySync(relays, { kinds: [KIND_FOLLOW_PACK], authors: [SHOW_PUBKEY_HEX] })
      .catch(() => [])
    for (const ev of evs) {
      if (!ev || ev.pubkey !== SHOW_PUBKEY_HEX || !verifyEvent(ev)) continue
      for (const t of ev.tags || []) {
        if (Array.isArray(t) && t[0] === 'p' && /^[0-9a-f]{64}$/i.test(t[1] || '')) {
          members.add(t[1].toLowerCase())
        }
      }
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return members
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

function renderMonth(panel, allItems, year, month) {
  const list = panel.querySelector('[data-feed-list]')
  list.className = ''
  list.innerHTML = ''

  const matches = groupItems(allItems).filter((g) => {
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

// ── Events tab loader ────────────────────────────────────────────────
// Cache-first + progressive: paint instantly from localStorage if we have
// a recent snapshot, then open a live subscription that streams events in
// and repaints (debounced) as they arrive. Switching months never
// re-fetches — it re-filters the in-memory state.
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
  }

  const paint = () => renderMonth(panel, computeItems(state), state.year, state.month)

  // Debounced repaint so a burst of streamed events doesn't thrash the DOM.
  let paintTimer = null
  const schedulePaint = () => {
    clearTimeout(paintTimer)
    paintTimer = setTimeout(paint, 200)
  }

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

  // 2. Live refresh.
  try {
    const outbox = await fetchShowOutboxRelays(STATIC_RELAYS)
    state.relays = [...new Set([...STATIC_RELAYS, ...outbox])]

    const members = await fetchPackMembers(state.relays)
    if (!members.size) {
      if (!state.eventsByCoord.size) {
        renderPlaceholder(list, 'No supporters found', 'Couldn’t reach the follow packs right now — please try again later.')
      }
      return
    }
    const memberList = [...members]

    // Stream events + deletions, repainting as they land.
    await streamEvents(memberList, state.relays, state, schedulePaint)

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
// Resolves the same supporter set + outbox relays the Events tab uses, then
// lazy-imports the heavier marketplace module (which pulls in merch.js's cart
// / checkout / gift-wrap send) only when the tab is actually opened.
async function loadMarket() {
  const panel = document.getElementById('panel-market')
  if (!panel) return
  const list = panel.querySelector('[data-feed-list]')
  if (!list) return

  // Replace the static placeholder with skeletons up front — resolving the
  // supporter set + lazy-importing the market module (which pulls in merch.js)
  // takes a moment, and renderMarket only paints its own skeletons afterwards.
  showSkeletons(list)

  try {
    const outbox = await fetchShowOutboxRelays(STATIC_RELAYS)
    const relays = [...new Set([...STATIC_RELAYS, ...outbox])]
    const members = await fetchPackMembers(relays)
    if (!members.size) {
      renderPlaceholder(list, 'No supporters found', 'Couldn’t reach the follow packs right now — please try again later.')
      return
    }
    const mod = await import('/assets/js/feeds-market.js')
    await mod.renderMarket({ panel, list, relays, members: [...members] })
  } catch (e) {
    console.error('[feeds] market load failed', e)
    renderPlaceholder(list, 'Couldn’t load the marketplace', 'Something went wrong reaching the relays — please try again later.')
  }
}

// ── Lazy per-feed dispatch ───────────────────────────────────────────
const LOADERS = { events: loadEvents, market: loadMarket }
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
