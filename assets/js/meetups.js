/* Meetups page — listener-boosted Nostr meetups.
 *
 * Reads /data/meetups.json (the boost bot's log of NIP-52 calendar events
 * that listeners boosted), dedupes by event coordinate, fetches the live
 * calendar events + organizer profiles from relays, and renders them as
 * cards — upcoming soonest-first, past in a collapsed section.
 *
 * Always fetches live so edits/reschedules show current details. Cards
 * use the shared renderer from calendar-events.js (same look as the
 * calendar embeds on the boosts page).
 */
import { STATIC_RELAYS, fetchProfilesFromPrimal } from '/assets/js/boosts-thread.js'
import {
  fetchCalendarEventsFromRelays,
  renderCalendarCard,
  eventStartMs,
  eventEndMs,
} from '/assets/js/calendar-events.js'
import { nip19 } from '/assets/widgets/nostr-tools.js'

const MEETUPS_JSON = '/api/meetups'

function isWsUrl(u) {
  return typeof u === 'string' && (u.startsWith('wss://') || u.startsWith('ws://'))
}

// naddr strings carry relay hints — include them so we still find events
// published only to relays outside the static set.
function relayHintsFromNaddr(naddr) {
  try {
    const d = nip19.decode(naddr)
    if (d.type === 'naddr' && Array.isArray(d.data.relays)) {
      return d.data.relays.filter(isWsUrl)
    }
  } catch {}
  return []
}

function renderList(items) {
  const ul = document.createElement('ul')
  ul.className = 'meetup-list'
  for (const item of items) {
    const li = document.createElement('li')
    li.appendChild(renderCalendarCard(item.parsed, {
      bech32: item.naddr,
      profile: item.profile,
      actions: true,
    }))
    ul.appendChild(li)
  }
  return ul
}

function renderEmpty(container, msg) {
  const p = document.createElement('p')
  p.className = 'meetups-empty'
  p.textContent = msg
  container.appendChild(p)
}

;(async function init() {
  const loadingEl  = document.getElementById('meetups-loading')
  const errorEl    = document.getElementById('meetups-error')
  const upcomingEl = document.getElementById('meetups-upcoming')
  const pastWrap   = document.getElementById('past-meetups')
  const pastEl     = document.getElementById('meetups-past')
  if (!upcomingEl) return

  const hideLoading = () => { if (loadingEl) loadingEl.style.display = 'none' }
  const showError = () => {
    hideLoading()
    if (errorEl) errorEl.style.display = 'block'
  }

  // 1. Load the boost log.
  let rows = []
  try {
    const res = await fetch(MEETUPS_JSON, { cache: 'no-cache' })
    if (!res.ok) throw new Error('meetups.json ' + res.status)
    const data = await res.json()
    rows = Array.isArray(data?.rows) ? data.rows : []
  } catch (e) {
    console.warn('[meetups] failed to load meetups.json', e)
    showError()
    return
  }

  // 2. Dedupe by event coordinate; keep the first naddr seen for each.
  const naddrByCoord = new Map()
  const hints = new Set()
  for (const r of rows) {
    if (!r || typeof r.coordinate !== 'string' || typeof r.naddr !== 'string') continue
    if (!naddrByCoord.has(r.coordinate)) naddrByCoord.set(r.coordinate, r.naddr)
    for (const h of relayHintsFromNaddr(r.naddr)) hints.add(h)
  }
  const coords = [...naddrByCoord.keys()]
  if (!coords.length) {
    hideLoading()
    renderEmpty(upcomingEl, 'No boosted meetups right now — Boost your next meetup here!')
    return
  }

  // 3. Fetch the live calendar events.
  let events
  try {
    const relays = [...new Set([...STATIC_RELAYS, ...hints])]
    events = await fetchCalendarEventsFromRelays(coords, relays)
  } catch (e) {
    console.warn('[meetups] calendar fetch failed', e)
    showError()
    return
  }
  if (!events.size) {
    hideLoading()
    renderEmpty(upcomingEl, 'No meetups to show right now.')
    return
  }

  // 4. Organizer profiles (avatar + name for the cards).
  let profiles = new Map()
  try {
    const pubkeys = [...new Set([...events.values()].map((e) => e.pubkey).filter(Boolean))]
    profiles = await fetchProfilesFromPrimal(pubkeys)
  } catch (e) {
    console.warn('[meetups] profile fetch failed', e)
  }

  // 5. Split into upcoming (soonest first) and past (most recent first).
  const now = Date.now()
  const items = []
  for (const [coord, parsed] of events) {
    const startMs = eventStartMs(parsed)
    if (!Number.isFinite(startMs)) continue
    items.push({
      parsed,
      startMs,
      endMs: eventEndMs(parsed),
      naddr: naddrByCoord.get(coord),
      profile: profiles.get(parsed.pubkey) || null,
    })
  }
  const upcoming = items
    .filter((i) => i.endMs >= now)
    .sort((a, b) => a.startMs - b.startMs)
  const past = items
    .filter((i) => i.endMs < now)
    .sort((a, b) => b.startMs - a.startMs)

  // 6. Paint.
  hideLoading()
  if (upcoming.length) {
    upcomingEl.appendChild(renderList(upcoming))
  } else {
    renderEmpty(upcomingEl, 'No boosted meetups right now — Boost your next meetup here!')
  }
  if (past.length && pastEl && pastWrap) {
    pastEl.appendChild(renderList(past))
    pastWrap.hidden = false
  }
})().catch((err) => {
  console.error('[meetups] init failed', err)
  const loadingEl = document.getElementById('meetups-loading')
  const errorEl = document.getElementById('meetups-error')
  if (loadingEl) loadingEl.style.display = 'none'
  if (errorEl) errorEl.style.display = 'block'
})
