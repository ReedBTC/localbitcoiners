/* Stats page — "Biggest Boosts" feed.
 *
 * Fetches the show-wide boost mega-thread (same fetch + render path as
 * /boosts.html and the episode pages) and renders the biggest bot boost
 * notes largest-first: the top TOP_MONTH of the last 30 days, or the top
 * TOP_ALL of all time. Replies to those boosts are not shown. The sat
 * amount is parsed from the bot's "💰 N sats" line in the note content.
 *
 * Hooks the shared boost-actions module in so every card gets the same
 * Reply/Repost/Like/Zap bar /boosts.html shows.
 */
import {
  fetchBoostThread,
  renderNoteCard,
  setCachedProfile,
  registerEvent,
  fetchProfilesFromPrimal,
  STATIC_RELAYS,
} from '/assets/js/boosts-thread.js'
import { configureBoostActions } from '/assets/js/boost-actions.js'

// How many notes each range shows: five either way. No sat floor, so a
// quiet month still has a top five.
const TOP_MONTH = 5
const TOP_ALL = 5

// 1M / All. The show reads the last month's biggest boosts off the air, so
// that is the default; All is a click away. Applied on the note's
// created_at, which is when the bot published the boost.
//
// The 1M window is deliberately 33 days, not 30. It is an easter egg
// (33 sats, 33/33/34 split, 33-day feature life), and the page still says
// "last 30 days" on purpose: it is not a secret, it is just not advertised
// on the site. Do not "fix" it to 30, and do not change the visible copy.
// This applies only to this section; every other 1M on the site is 30 days.
const RANGES = [['1m', '1M', 'Last 30 days'], ['all', 'All', 'All time']]
const MONTH_WINDOW_DAYS = 33
let range = '1m'
function topN() { return range === '1m' ? TOP_MONTH : TOP_ALL }
function rangeStart() { return range === '1m' ? Date.now() / 1000 - MONTH_WINDOW_DAYS * 86400 : -Infinity }

function mountRangeControl(onPick) {
  const host = document.querySelector('[data-boosts-controls]')
  if (!host) return
  host.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'pcast-range'
  wrap.setAttribute('role', 'group')
  wrap.setAttribute('aria-label', 'Time range')
  const btns = RANGES.map(([key, label, title]) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pcast-range-btn'
    btn.textContent = label
    btn.title = title
    btn.addEventListener('click', () => { setActive(key); onPick(key) })
    wrap.appendChild(btn)
    return btn
  })
  function setActive(key) {
    btns.forEach((el, i) => {
      const on = RANGES[i][0] === key
      el.classList.toggle('is-active', on)
      el.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
  }
  setActive(range)
  host.appendChild(wrap)
}

function updateSub() {
  const sub = document.querySelector('[data-boosts-sub]')
  if (!sub) return
  sub.textContent = range === '1m'
    ? 'The ' + TOP_MONTH + ' biggest Nostr Boost Bot Notes of the last 30 days'
    : 'The ' + TOP_ALL + ' biggest Nostr Boost Bot Notes of all time'
}

// Bot boost notes that were published un-threaded — no `e` tag links
// them to the mega-thread, so fetchBoostThread can't see them. Hardcoded
// here so they still show in this feed. The bot threads notes correctly
// now, so this list shouldn't need to grow.
const EXTRA_BOOST_IDS = [
  // npub1vpx9596… 10,420 sats, Ep 1 — a top-5 all-time boost, published
  // un-threaded on 2026-04-22 (nevent1qqsrg23qx…).
  '342a2036d29d57622d15338b10bc36e5f4055e178640e2e06b2e781cfd6f00f3',
]

;(async function init() {
  const container = document.querySelector('[data-stats-boosts]')
  if (!container) return

  // The thread fetch and the un-threaded extras are independent —
  // run them together.
  const [result, extras] = await Promise.all([
    fetchBoostThread().catch((e) => {
      console.warn('[stats-boosts] thread fetch failed', e)
      return null
    }),
    fetchEventsById(EXTRA_BOOST_IDS, STATIC_RELAYS).catch(() => []),
  ])

  if (!result || result.error || !result.rootEvent) {
    container.innerHTML =
      '<p class="stats-error">Couldn\'t load boosts right now — try again later.</p>'
    return
  }

  // Seed the extras into the shared caches so renderNoteCard resolves
  // them — and their authors — the same way it does thread notes.
  for (const ev of extras) registerEvent(ev)
  const extraPubkeys = [...new Set(extras.map((e) => e.pubkey).filter(Boolean))]
  if (extraPubkeys.length) {
    const profiles = await fetchProfilesFromPrimal(extraPubkeys).catch(() => new Map())
    for (const [pk, p] of profiles) setCachedProfile(pk, p)
  }

  // Register the action bar BEFORE the first paint so every card we
  // render below picks it up (same ordering ep-boosts.js relies on).
  configureBoostActions({
    rootEvent: result.rootEvent,
    childrenOf: result.childrenOf,
    rerender: () => repaint(result.rootEvent, result.childrenOf, container, extras),
  })
  mountRangeControl((key) => {
    range = key
    repaint(result.rootEvent, result.childrenOf, container, extras)
  })
  repaint(result.rootEvent, result.childrenOf, container, extras)
})().catch((err) => {
  console.error('[stats-boosts] init failed', err)
})

// Parse the sat amount out of a bot boost note's "💰 N sats" line.
// Non-boost notes (human replies posted straight to the root) have no
// such line and resolve to 0, so they fall below the threshold.
function boostSats(content) {
  const m = (content || '').match(/💰\s*([\d,]+)\s*sats/i)
  return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0
}

// Minimal direct-relay fetch for specific event ids — used only for the
// hardcoded un-threaded extras above (boosts-thread.js has no exported
// fetch-by-id, and these notes aren't reachable through the thread).
function fetchEventsById(ids, relays) {
  if (!ids.length) return Promise.resolve([])
  const queryOne = (url) => new Promise((resolve) => {
    let ws
    const timer = setTimeout(() => { try { ws.close() } catch {} ; resolve([]) }, 6000)
    try { ws = new WebSocket(url) } catch (e) { clearTimeout(timer); return resolve([]) }
    const sub = 'sx' + Math.random().toString(36).slice(2, 8)
    const got = []
    // kinds is not optional in practice: several relays reject a filter that
    // carries only ids (purplepag.es answers `blocked: filters must specify at
    // least one kind`), and these extras are all kind 1 anyway.
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, { kinds: [1], ids }]))
    ws.onmessage = (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { return }
      if (m[0] === 'EVENT' && m[1] === sub && m[2]) got.push(m[2])
      else if (m[0] === 'EOSE') { clearTimeout(timer); try { ws.close() } catch {} ; resolve(got) }
    }
    ws.onerror = () => { clearTimeout(timer); resolve([]) }
  })
  return Promise.all(relays.map(queryOne)).then((lists) => {
    const byId = new Map()
    for (const list of lists) for (const ev of list) if (ev && ev.id) byId.set(ev.id, ev)
    return [...byId.values()]
  })
}

function repaint(rootEvent, childrenOf, container, extras) {
  updateSub()
  const start = rangeStart()
  const directReplies = childrenOf.get(rootEvent.id) || []
  const seen = new Set()
  const anchors = directReplies
    .concat(extras || [])
    .filter((ev) => {
      // De-dupe in case an "extra" id also turns up in the thread.
      if (!ev || !ev.id || seen.has(ev.id)) return false
      seen.add(ev.id)
      if ((ev.created_at || 0) < start) return false
      return boostSats(ev.content) > 0   // bot boost notes only; human replies carry no 💰 line
    })
    .sort((a, b) => boostSats(b.content) - boostSats(a.content))
    .slice(0, topN())

  container.innerHTML = ''
  if (!anchors.length) {
    container.innerHTML = '<p class="stats-error">' + (range === '1m'
      ? 'No boosts in the last 30 days.'
      : 'No boosts yet.') + '</p>'
    return
  }

  // Anchors render largest-first as cards.
  const ul = document.createElement('ul')
  ul.className = 'note-list'
  for (const ev of anchors) {
    const li = document.createElement('li')
    li.appendChild(renderNoteCard(ev))
    ul.appendChild(li)
  }
  container.appendChild(ul)
}
