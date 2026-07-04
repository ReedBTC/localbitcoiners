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

// NIP-09 deletions (kind 5) from our author set. Returns the set of
// deleted event ids (`e` tags) plus a map of deleted addressable
// coordinates (`a` tags) → the created_at of the deletion, so a later
// re-publish of the same coordinate isn't wrongly hidden. A deletion is
// only honoured for targets authored by the same pubkey (which the
// coordinate encodes, and which is implicit for the `e`-tag case since
// we only ever match against events from these same authors).
async function fetchDeletions(authors, relays) {
  const deletedIds = new Set()
  const deletedCoords = new Map()
  if (!authors.length) return { deletedIds, deletedCoords }
  const pool = new SimplePool()
  try {
    const results = await Promise.all(
      chunkAuthors(authors).map((chunk) =>
        pool
          .querySync(relays, { kinds: [KIND_DELETION], authors: chunk, limit: 500 })
          .catch(() => [])
      )
    )
    for (const evs of results) {
      for (const ev of evs) {
        if (!ev || !verifyEvent(ev)) continue
        const at = ev.created_at || 0
        for (const t of ev.tags || []) {
          if (!Array.isArray(t)) continue
          if (t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] || '')) {
            deletedIds.add(t[1].toLowerCase())
          } else if (t[0] === 'a' && typeof t[1] === 'string') {
            // Only honour a coordinate deletion the deleter actually owns.
            const coordPubkey = t[1].split(':')[1] || ''
            if (coordPubkey.toLowerCase() !== ev.pubkey.toLowerCase()) continue
            const prev = deletedCoords.get(t[1])
            if (prev == null || at > prev) deletedCoords.set(t[1], at)
          }
        }
      }
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return { deletedIds, deletedCoords }
}

// ── Calendar events by author (untrusted source — verify everything) ──
async function fetchEventsByAuthors(authors, relays) {
  if (!authors.length) return []
  const out = new Map()
  const pool = new SimplePool()
  try {
    const results = await Promise.all(
      chunkAuthors(authors).map((authorsChunk) =>
        pool
          .querySync(relays, {
            kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT],
            authors: authorsChunk,
            limit: 500,
          })
          .catch(() => [])
      )
    )
    for (const evs of results) {
      for (const ev of evs) {
        if (!ev || !verifyEvent(ev)) continue
        const parsed = parseCalendarEvent(ev)
        if (!parsed) continue
        const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
        const prev = out.get(coord)
        // Addressable events: keep only the newest version per coordinate
        // (NIP-01 replacement). Track the winning event's id so deletions
        // that target a specific id can be applied afterwards.
        if (!prev || (ev.created_at || 0) > (prev.createdAt || -1)) {
          parsed.createdAt = ev.created_at || 0
          parsed.id = ev.id || ''
          out.set(coord, parsed)
        }
      }
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return [...out.values()]
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

function buildGrid(items) {
  const grid = document.createElement('div')
  grid.className = 'feed-list'
  for (const item of items) {
    grid.appendChild(renderCalendarCard(item.parsed, {
      bech32: item.naddr,
      profile: item.profile,
      actions: true,
    }))
  }
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

function renderMonth(panel, allItems, year, month) {
  const list = panel.querySelector('[data-feed-list]')
  list.className = ''
  list.innerHTML = ''

  const matches = allItems.filter((i) => {
    const ym = eventYearMonth(i)
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

function buildMonthNav(panel, allItems) {
  const nav = panel.querySelector('[data-month-nav]')
  if (!nav) return
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

  const update = () => renderMonth(panel, allItems, parseInt(yearSel.value, 10), parseInt(monthSel.value, 10))
  monthSel.addEventListener('change', update)
  yearSel.addEventListener('change', update)

  nav.appendChild(monthSel)
  nav.appendChild(yearSel)
  nav.hidden = false

  update()
}

// ── Events tab loader ────────────────────────────────────────────────
async function loadEvents() {
  const panel = document.getElementById('panel-events')
  if (!panel) return
  const list = panel.querySelector('[data-feed-list]')
  if (!list) return

  showSkeletons(list)
  try {
    // Start from the default set, then fold in the show's own outbox so we
    // reach packs/events published only to the show's write relays.
    const outbox = await fetchShowOutboxRelays(STATIC_RELAYS)
    const relays = [...new Set([...STATIC_RELAYS, ...outbox])]

    const members = await fetchPackMembers(relays)
    if (!members.size) {
      renderPlaceholder(list, 'No supporters found', 'Couldn’t reach the follow packs right now — please try again later.')
      return
    }

    const memberList = [...members]
    const [parsedEvents, deletions] = await Promise.all([
      fetchEventsByAuthors(memberList, relays),
      fetchDeletions(memberList, relays),
    ])
    const { deletedIds, deletedCoords } = deletions

    const items = []
    for (const parsed of parsedEvents) {
      // Honour NIP-09: skip an event whose id was deleted, or whose
      // coordinate was deleted at/after this version was published.
      if (parsed.id && deletedIds.has(parsed.id.toLowerCase())) continue
      const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
      const delAt = deletedCoords.get(coord)
      if (delAt != null && delAt >= (parsed.createdAt || 0)) continue

      const startMs = eventStartMs(parsed)
      if (!Number.isFinite(startMs)) continue
      items.push({
        parsed,
        startMs,
        endMs: eventEndMs(parsed),
        naddr: naddrFor(parsed, relays),
        profile: null,
      })
    }

    // Organizer profiles for the avatar + name on each card.
    try {
      const pubkeys = [...new Set(items.map((i) => i.parsed.pubkey).filter(Boolean))]
      const profiles = await fetchProfilesFromPrimal(pubkeys)
      items.forEach((i) => { i.profile = profiles.get(i.parsed.pubkey) || null })
    } catch (e) {
      console.warn('[feeds] event profile fetch failed', e)
    }

    // Build the month/year picker (defaults to the current month) and
    // paint that month's events; changing the dropdowns re-filters.
    buildMonthNav(panel, items)
  } catch (e) {
    console.error('[feeds] events load failed', e)
    renderPlaceholder(list, 'Couldn’t load events', 'Something went wrong reaching the relays — please try again later.')
  }
}

// ── Lazy per-feed dispatch ───────────────────────────────────────────
const LOADERS = { events: loadEvents }
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
loadFeed(document.body.dataset.activeFeed || 'notes')
