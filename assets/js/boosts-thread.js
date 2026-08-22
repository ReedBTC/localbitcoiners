/* Shared boost-thread read renderer.
 *
 * Loads + renders the boost mega-thread (kind-1 root + descendants) for any
 * page that wants to display it: /boosts.html in full, or /ep### filtered to
 * a single episode's boosts. Only the boost notes (direct children of the
 * root) are rendered — replies to those boosts are never shown.
 *
 * This module is read-only on purpose. Mutation (reply, like, repost, zap) is
 * page-specific and stays in /boosts.html — it consumes this module's
 * `actionsBuilder` hook to inject per-card buttons.
 *
 * Vendored nostr-tools — same bundle the rest of the site uses. Module-level
 * caches (profile/embed/calendar/card) are intentionally process-global so a
 * follow-up reply on /boosts.html can rerender the tree without losing
 * already-fetched profile data, and so the same DOM nodes get reused across
 * mutating repaints.
 */
import { SimplePool, nip19, verifyEvent } from '/assets/widgets/nostr-tools.js'
import { resolveProfiles } from '/assets/js/profile-cache.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  fetchCalendarEventsFromRelays,
  renderCalendarCard,
} from '/assets/js/calendar-events.js'

// ── Config ───────────────────────────────────────────────────────────
export const ROOT_NEVENT = 'nevent1qvzqqqqqqypzpses3q0zsa5rs8wchh7jws6pmjsvtzpv9xuxgt4yhjp0w43jv3vjqyd8wumn8ghj7urewfsk66ty9enxjct5dfskvtnrdakj7qgwwaehxw309ahx7uewd3hkctcqyr3keved458q3n7x7839r86vj4dx0s4xh0p8j7fzvf4nq7824ulagy77tpj'

const PRIMAL_WS_URL = 'wss://cache1.primal.net/v1'
const PRIMAL_TIMEOUT_MS = 6000
// The site-wide READ set. Exported and imported by feeds.js, feeds-articles.js,
// feeds-market.js, featured-articles.js, supporter-set.js and stats-boosts.js,
// so it answers for every kind this site reads, not just the boost thread.
//
// Chosen by measurement rather than reputation, 2026-08-12, against the 399
// boost notes on the megathread and the 92 distinct booster pubkeys mentioned
// in them. Coverage per relay:
//
//   relay              kind 1  kind 0  kind 10002  kind 3
//   relay.fountain.fm     92%      0%          0%      9%
//   relay.ditto.pub       88%     89%         50%     90%
//   relay.damus.io        52%     71%         45%     78%
//   nos.lol               50%     92%         84%     97%
//   nostr.mom             38%     79%         62%     78%
//   relay.mostr.pub       29%     74%         49%     64%
//   relay.wavlake.com      0%     59%         41%     35%
//   purplepag.es           0%     41%         35%     59%
//   relay.primal.net       0%     12%          7%     22%
//   relay.nostr.band       0%      0%          0%      0%
//
// Marginal coverage is what picked the four, and they are not all here for the
// same reason. fountain answers 368 of the 399 notes and ditto takes that to
// 398; nos.lol adds ZERO kind-1 and earns its slot outright on the other three
// kinds, where it is the single best relay we have; nostr.mom holds the one
// note the first three miss and is a second source behind nos.lol for profiles
// and follow packs. That last slot is the weakest case in the list — one note
// and redundancy — and is worth re-examining before it is taken as settled.
//
// The set that shipped before this one covered 349 of 399, and that gap is
// exactly what a listener saw as boosts silently missing from the feed. The
// four below cover 399 of 399 from relays alone, which is what takes the page
// off depending on Primal's cache (a 4.8 MB response behind a 6s timeout) for
// completeness rather than for speed.
//
// ⚠️ relay.fountain.fm is a kind-1 relay ONLY. It answers a REQ for kinds
// 39089 or 30078 with `kinds not supported`, returns no kind 0 at all, and does
// not EOSE on an UNFILTERED kind-1 REQ. Every consumer here filters by id,
// author or #e, which it answers normally; keep it that way. It costs one
// socket on the addressable-kind queries and contributes nothing to them, which
// is the price of one list serving every reader rather than a per-kind seam
// someone eventually imports the wrong half of.
//
// ⚠️ Don't re-add a relay because it is famous or because it aggregates.
// purplepag.es was here as the dedicated profile aggregator and scored 41% with
// ZERO marginal contribution once nos.lol and ditto are present; relay.damus.io
// intermittently answers a WebSocket connect with HTTP 503 and holds none of
// the show's follow packs; relay.nostr.band answered 0% on every kind tested
// and burns the full connection budget failing on every load. Re-measure
// instead — the script that produced this table is in the lb-v50 commit.
const STATIC_RELAYS = [
  'wss://relay.fountain.fm',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://nostr.mom',
]
export { STATIC_RELAYS }

// ⚠️ STATIC_RELAYS is the NOTE list. Anything querying a kind other than 1 has
// to filter it, because relay.fountain.fm is kind-1 only and answers everything
// else with `kinds not supported`.
//
// That refusal is not free, and it is not cheap-because-it-is-fast. Measured on
// boosts.html, the calendar query spent 1158 ms connecting to fountain and got
// its rejection 30 ms later — the slowest connect in the whole trace, gating a
// Promise.all that waits on every relay in the list. Dropping it costs nothing:
// it can never hold a NIP-52 calendar event.
const KIND1_ONLY_RELAYS = new Set(['wss://relay.fountain.fm'])
export function relaysForAddressableKinds(relays) {
  return relays.filter((u) => !KIND1_ONLY_RELAYS.has(u))
}

// Hardcoded boost-note exclusions. kind-1 notes can't be deleted from
// relays, so when boost-publisher emits a note that's wrong (e.g. the
// Castamatic-message-dropping bug fixed in boost_formatter), we leave the
// bad note on relays but suppress it here and republish a corrected reply
// to the megathread. Keyed by event id (hex). This is the going-forward
// mitigation pattern for boost-publisher mistakes.
//   2026-06-17: 4 ChadF / Ep.016 Castamatic boosts published without their
//   💬 message line; corrected replies republished to the megathread.
//   2026-07-22: boost note published with the wrong sat total (the leg-retry
//   amount_total bug fixed in lb-v39); corrected note republished manually.
//   2026-07-22: additional bad boost note hidden at Reed's request.
const EXCLUDED_NOTE_IDS = new Set([
  '3d37e26095d46e844f4ad80ed00ce6bec94e9ba39b5b25278d3b1a8acfe20afc',
  '82d715867ce36bcf121eb8ef3b9844b42b6b9e9151b255328f98534bb30619ef',
  'bdf30ffae16bab70291733961931d95ca2bd73ed16341a236d9025bac26009a4',
  'a1e400e578c1cd78fecd5348a533c487ca57b85723968e66cb3567b93c6f8dfd',
  '44313741181237c5a833358f261f0e1bde53f5b3e2d3d54f6e95355965a5e82d',
  '0a9bae72c5f6327bc4dfb18d85f2bc38ab66bf868529da49e3a213f39b40f282',
  // 2026-08-19: Chad & Reed boosts misfiled as LB during a DNS outage
  '24f53bb20d243b27d5356fa7f40955006511f4abf3ceecb797d1114a9e5bbf12',
  '9b91a3bb306faae58873e08d86cf8cd11e04f58dee2ed44b7d1a10b12780c22a',
  // 2026-08-22: OnlyBoosts test boost on Chad & Reed misfiled as LB (its
  // Tardbox page carried no Show row, so the feed gate saw "absent")
  'edb91c5a52cbc1fee15cd1f931f3c129c4daac7ed44efef5dcb627ffa39f9451',
])

// ── Module state ─────────────────────────────────────────────────────
// Caches survive multiple `fetchBoostThread` calls so subsequent paints
// (e.g. after an optimistic reply insert) skip re-fetching profiles.
const profileCache  = new Map()  // pubkey hex → { pubkey, name, picture, nip05, lud16, lud06 }
const embedCache    = new Map()  // event id hex → kind-1 event (or null = not found)
const calendarCache = new Map()  // "<kind>:<pubkey>:<dTag>" → parsed event (or null = miss)
const cardCache     = new Map()  // event id (lowercased) → cached <article> node

// Page-supplied callback that returns a per-card action bar (Reply/Like/
// Repost/Zap on /boosts.html, null on /ep### read-only pages).
let actionsBuilder = null

export function configureBoostsThread({ actionsBuilder: builder = null } = {}) {
  actionsBuilder = typeof builder === 'function' ? builder : null
}

// ── Generic helpers ──────────────────────────────────────────────────
function isSafeUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

function relTime(ts) {
  const sec = Math.floor(Date.now() / 1000) - ts
  if (sec < 60)      return `${sec}s ago`
  if (sec < 3600)    return `${Math.floor(sec/60)}m ago`
  if (sec < 86400)   return `${Math.floor(sec/3600)}h ago`
  if (sec < 2592000) return `${Math.floor(sec/86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

// ── Profile cache management ─────────────────────────────────────────
// Bidi-control chars get stripped from displayable text so a hostile profile
// can't visually impersonate another user via RLO/LRI tricks.
const PROFILE_BIDI = /[‪-‮⁦-⁩]/g
function cleanProfileText(s) {
  if (typeof s !== 'string' || !s) return s || ''
  return s.replace(PROFILE_BIDI, '')
}

export function setCachedProfile(pubkey, raw) {
  if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) return
  const safe = {
    pubkey,
    name:    cleanProfileText(raw?.name)    || null,
    picture: isSafeUrl(raw?.picture) ? raw.picture : null,
    nip05:   cleanProfileText(raw?.nip05)   || null,
    lud16:   typeof raw?.lud16 === 'string' ? raw.lud16 : null,
    lud06:   typeof raw?.lud06 === 'string' ? raw.lud06 : null,
  }
  profileCache.set(pubkey, safe)
}

export function getCachedProfile(pubkey) {
  return profileCache.get(pubkey) || null
}

// ── Event + card cache management ────────────────────────────────────
export function registerEvent(ev) {
  if (ev && typeof ev.id === 'string') embedCache.set(ev.id, ev)
}

export function evictCard(id) {
  if (typeof id === 'string') cardCache.delete(id.toLowerCase())
}

// ── Content parsing ──────────────────────────────────────────────────
const NOSTR_URI_RE = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+|note1[a-z0-9]+|nevent1[a-z0-9]+|naddr1[a-z0-9]+)/gi
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

function parseSegments(content) {
  if (!content) return [{ type: 'text', value: '' }]
  const tokens = []

  // Nostr URIs first — npub/nprofile become 'mention', note/nevent/naddr
  // become 'note_embed'. Decoding failures degrade to a plain text token.
  for (const m of content.matchAll(NOSTR_URI_RE)) {
    const raw = m[1]
    const tok = { start: m.index, end: m.index + m[0].length, value: m[0], data: { bech32: raw } }
    try {
      const decoded = nip19.decode(raw)
      tok.data.decoded = decoded
      if (decoded.type === 'npub') {
        tok.type = 'mention'
        tok.data.pubkey = decoded.data
      } else if (decoded.type === 'nprofile') {
        tok.type = 'mention'
        tok.data.pubkey = decoded.data.pubkey
      } else if (decoded.type === 'note') {
        tok.type = 'note_embed'
        tok.data.eventId = decoded.data
      } else if (decoded.type === 'nevent') {
        tok.type = 'note_embed'
        tok.data.eventId = decoded.data.id
        tok.data.author  = decoded.data.author || null
      } else if (decoded.type === 'naddr') {
        tok.type = 'note_embed'
        tok.data.addressable = true
        tok.data.naddr = decoded.data
      } else {
        tok.type = 'text'
      }
    } catch {
      tok.type = 'text'
    }
    tokens.push(tok)
  }

  // URLs that don't overlap a nostr URI.
  for (const m of content.matchAll(URL_RE)) {
    if (tokens.some(t => m.index >= t.start && m.index < t.end)) continue
    tokens.push({
      type: 'link',
      start: m.index, end: m.index + m[0].length,
      value: m[0], data: { url: m[0] },
    })
  }

  tokens.sort((a, b) => a.start - b.start)

  const segments = []
  let cursor = 0
  for (const tok of tokens) {
    if (tok.start > cursor) segments.push({ type: 'text', value: content.slice(cursor, tok.start) })
    segments.push({ type: tok.type, value: tok.value, data: tok.data })
    cursor = tok.end
  }
  if (cursor < content.length) segments.push({ type: 'text', value: content.slice(cursor) })

  return segments.length ? segments : [{ type: 'text', value: content }]
}

function renderSegmentsInto(el, segments, opts = {}) {
  for (const seg of segments) {
    if (seg.type === 'text') {
      el.appendChild(document.createTextNode(seg.value))
    } else if (seg.type === 'link') {
      const url = seg.data?.url || seg.value
      if (isSafeUrl(url)) {
        const a = document.createElement('a')
        a.href = url
        a.textContent = url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        el.appendChild(a)
      } else {
        el.appendChild(document.createTextNode(url))
      }
    } else if (seg.type === 'mention') {
      el.appendChild(buildMentionEl(seg))
    } else if (seg.type === 'note_embed') {
      if (opts.inEmbed) {
        // No nested embeds — degrade to a chip that links to njump.
        el.appendChild(buildEmbedChip(seg))
      } else {
        el.appendChild(buildEmbedNoteEl(seg))
      }
    } else {
      el.appendChild(document.createTextNode(seg.value || ''))
    }
  }
}

// Exposed for other read-only renderers (e.g. the Podcast Boosts feed) that
// want to show verbatim community text with the same safe, tokenized
// treatment used here — nostr: mentions become chips, URLs become links,
// and everything else is a plain text node (never innerHTML). Callers that
// don't render a full note tree should pass { inEmbed: true } so a quoted
// note degrades to a chip instead of triggering an embed fetch.
export { parseSegments, renderSegmentsInto }

function buildMentionEl(seg) {
  const profile = seg.data.pubkey ? profileCache.get(seg.data.pubkey) : null

  // Link by a clean npub whenever we have the pubkey: njump resolves an
  // npub reliably, whereas a bulky nprofile (relay hints baked in) — or an
  // empty identifier — opens a blank page. That blank tab was the bug.
  let ident = seg.data.bech32 || (seg.value || '').replace(/^nostr:/i, '')
  if (seg.data.pubkey) {
    try { ident = nip19.npubEncode(seg.data.pubkey) } catch {}
  }
  const label = profile?.name ? '@' + profile.name : '@' + (ident ? ident.slice(0, 14) + '…' : 'user')

  // Nothing usable to point at → render the name as plain text, not a dead
  // link that opens an empty tab.
  if (!ident) {
    const span = document.createElement('span')
    span.className = 'nostr-mention'
    span.textContent = label
    return span
  }

  const a = document.createElement('a')
  a.className = 'nostr-mention'
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.href = `https://njump.me/${ident}`
  a.textContent = label
  if (profile?.name && profile.nip05) a.title = profile.nip05
  return a
}

function buildEmbedChip(seg) {
  const a = document.createElement('a')
  a.className = 'nostr-mention'
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.href = `https://njump.me/${seg.data.bech32 || seg.value.replace(/^nostr:/i, '')}`
  a.textContent = '@' + (seg.data.bech32 || seg.value).slice(0, 14) + '…'
  return a
}

function buildEmbedNoteEl(seg) {
  const card = document.createElement('div')
  card.className = 'embed-note'

  // naddr (long-form, calendar event, etc.) — NIP-52 calendar events
  // get a rich inline card; every other addressable kind falls back to
  // a chip linking out.
  if (seg.data.addressable) {
    const naddrKind = seg.data.naddr?.kind
    const isCalendar = naddrKind === KIND_DATE_EVENT || naddrKind === KIND_TIME_EVENT
    const coord = isCalendar
      ? `${naddrKind}:${seg.data.naddr.pubkey}:${seg.data.naddr.identifier}`
      : null
    const parsedEvent = coord ? calendarCache.get(coord) : null

    if (parsedEvent) {
      return renderCalendarCard(parsedEvent, {
        bech32: seg.data.bech32,
        profile: profileCache.get(parsedEvent.pubkey),
      })
    }

    card.classList.add('is-naddr')
    const link = document.createElement('a')
    if (isCalendar) {
      link.href = `https://mynostr.app/${seg.data.bech32}`
      link.textContent = '📅 Linked event on Nostr →'
    } else {
      // Articles read on mynostr.app, matching the link the boost publisher
      // now writes into the note itself for kind-30023 naddrs (the bot sends
      // calendar naddrs to plektos and articles to MyNostr).
      link.href = `https://mynostr.app/${seg.data.bech32}`
      link.textContent = '📄 Linked article on Nostr →'
    }
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    card.appendChild(link)
    return card
  }

  const ev = seg.data.eventId ? embedCache.get(seg.data.eventId) : null
  if (!ev) {
    card.classList.add('is-missing')
    card.appendChild(document.createTextNode('Quoted note not available'))
    const link = document.createElement('a')
    link.href = `https://njump.me/${seg.data.bech32}`
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = 'View on Nostr →'
    card.appendChild(link)
    return card
  }

  const authorRow = document.createElement('div')
  authorRow.className = 'embed-author'
  const profile = profileCache.get(ev.pubkey)

  const img = document.createElement('img')
  img.src = profile?.picture || '/assets/LocalBitcoiners.png'
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  img.onerror = () => { img.src = '/assets/LocalBitcoiners.png' }
  authorRow.appendChild(img)

  const nameEl = document.createElement('span')
  nameEl.className = 'author-name'
  nameEl.textContent = profile?.name || (ev.pubkey.slice(0, 8) + '…')
  authorRow.appendChild(nameEl)

  const time = document.createElement('time')
  time.dateTime = new Date(ev.created_at * 1000).toISOString()
  time.textContent = relTime(ev.created_at)
  time.title = new Date(ev.created_at * 1000).toLocaleString()
  authorRow.appendChild(time)

  card.appendChild(authorRow)

  const body = document.createElement('div')
  body.className = 'embed-body'
  const text = ev.content || ''
  const snippet = text.length > 600 ? text.slice(0, 600) + '…' : text
  renderSegmentsInto(body, parseSegments(snippet), { inEmbed: true })
  card.appendChild(body)

  const footer = document.createElement('div')
  footer.className = 'embed-footer'
  let nevent = ''
  try { nevent = nip19.neventEncode({ id: ev.id, author: ev.pubkey }) } catch {}
  if (nevent) {
    const link = document.createElement('a')
    link.href = `https://njump.me/${nevent}`
    link.textContent = 'View on Nostr →'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    footer.appendChild(link)
  }
  card.appendChild(footer)

  return card
}

function renderContentInto(el, text) {
  renderSegmentsInto(el, parseSegments(text))
}

// ── Profile parsing ──────────────────────────────────────────────────
function parseProfileEvent(ev) {
  try {
    const meta = JSON.parse(ev.content)
    return {
      pubkey:  ev.pubkey,
      name:    meta.display_name || meta.name || '',
      picture: isSafeUrl(meta.picture) ? meta.picture : null,
      nip05:   meta.nip05 || '',
      lud16:   typeof meta.lud16 === 'string' ? meta.lud16.trim() : '',
      lud06:   typeof meta.lud06 === 'string' ? meta.lud06.trim() : '',
    }
  } catch {
    return { pubkey: ev.pubkey }
  }
}

// ── Primal cache: one shared socket ──────────────────────────────────
// Every query used to open its own WebSocket and close it on EOSE. A single
// page load makes three (user_infos, events, user_infos again for embed
// authors), and measured on boosts.html those connects cost 478 + 396 + 398 ms
// — about 800 ms spent redialling a host already spoken to. Primal multiplexes
// on subscription id like any relay, so one socket serves them all.
//
// The socket closes on its own once nothing has used it for PRIMAL_IDLE_MS,
// so a page that queries once still ends up with no lingering connection; it
// just doesn't pay to reconnect for a query arriving moments later.
const PRIMAL_IDLE_MS = 5000
let primalSocket = null      // Promise<WebSocket> while connecting or open
let primalIdleTimer = null
const primalSubs = new Map() // subId → { onEvent, onDone }

function releasePrimalSocketWhenIdle() {
  clearTimeout(primalIdleTimer)
  if (primalSubs.size) return
  primalIdleTimer = setTimeout(() => {
    if (primalSubs.size) return
    const pending = primalSocket
    primalSocket = null
    Promise.resolve(pending).then((ws) => { try { ws?.close() } catch {} }).catch(() => {})
  }, PRIMAL_IDLE_MS)
}

function openPrimalSocket() {
  if (primalSocket) return primalSocket
  primalSocket = new Promise((resolve, reject) => {
    let ws
    try { ws = new WebSocket(PRIMAL_WS_URL) } catch (e) { return reject(e) }
    const failed = (err) => {
      // Drop the memoized promise so the NEXT caller redials rather than
      // inheriting a dead socket for the life of the page.
      if (primalSocket) primalSocket = null
      // Everything still waiting resolves with what it has; callers of this
      // module treat an empty result as "unavailable", never as "none exist".
      for (const [, sub] of primalSubs) sub.onDone()
      primalSubs.clear()
      reject(err)
    }
    ws.onopen = () => resolve(ws)
    ws.onerror = () => failed(new Error('Primal WS error'))
    ws.onclose = () => failed(new Error('Primal WS closed'))
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data) } catch { return }
      const [type, subId, payload] = msg
      const sub = primalSubs.get(subId)
      if (!sub) return
      if (type === 'EVENT' && payload) sub.onEvent(payload)
      else if (type === 'EOSE' || type === 'CLOSED') sub.onDone()
    }
  })
  return primalSocket
}

function primalQuery(op, params, timeoutMs = PRIMAL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false
    const events = []
    const subId = `lb_${op}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      primalSubs.delete(subId)
      // Tell Primal to stop streaming this sub; the socket stays up for the
      // next query. Best-effort — a closed socket makes this moot.
      Promise.resolve(primalSocket)
        .then((ws) => { try { ws?.send(JSON.stringify(['CLOSE', subId])) } catch {} })
        .catch(() => {})
      releasePrimalSocketWhenIdle()
      if (err) reject(err); else resolve(events)
    }
    const timer = setTimeout(
      () => finish(new Error(`Primal "${op}" timed out`)),
      timeoutMs,
    )
    primalSubs.set(subId, {
      onEvent: (ev) => events.push(ev),
      // As before, a close arriving before EOSE yields whatever arrived
      // rather than failing the query.
      onDone: () => finish(null),
    })
    openPrimalSocket().then(
      (ws) => {
        if (settled) return
        try { ws.send(JSON.stringify(['REQ', subId, { cache: [op, params] }])) }
        catch { finish(new Error(`Primal send failed (${op})`)) }
      },
      () => finish(new Error(`Primal WS error (${op})`)),
    )
  })
}

async function fetchThreadFromPrimal(rootId) {
  const events = await primalQuery('thread_view', { event_id: rootId, limit: 400 })
  const notes = []
  const profiles = new Map()
  for (const ev of events) {
    if (ev.kind === 1) notes.push(ev)
    else if (ev.kind === 0) profiles.set(ev.pubkey, parseProfileEvent(ev))
  }
  return { notes, profiles }
}

async function fetchProfilesFromPrimal(pubkeys) {
  if (!pubkeys.length) return new Map()
  try {
    const evs = await primalQuery('user_infos', { pubkeys })
    const out = new Map()
    for (const ev of evs) if (ev.kind === 0) out.set(ev.pubkey, parseProfileEvent(ev))
    return out
  } catch { return new Map() }
}

// Display-path profile resolution: the nightly cache first, Primal only for
// whoever it doesn't hold (someone who boosted since last night's sweep).
//
// ⚠️ Deliberately NOT wired into the exported fetchProfilesFromPrimal, which
// boost-actions.js calls to read a recipient's lud16 before paying them. A
// cache hit that predates a user adding or changing their Lightning address
// would satisfy that call and suppress the live lookup, which is the wrong
// trade on a payment path. Display names and avatars can be a night stale;
// a payout address cannot.
async function fetchProfilesForDisplay(pubkeys) {
  if (!pubkeys.length) return new Map()
  const { found, missing } = await resolveProfiles(pubkeys).catch(() => ({
    found: new Map(),
    missing: pubkeys,
  }))
  if (!missing.length) return found
  const live = await fetchProfilesFromPrimal(missing)
  for (const [pk, p] of live) found.set(pk, p)
  return found
}

async function fetchEventsFromPrimal(eventIds) {
  if (!eventIds.length) return { notes: new Map(), profiles: new Map() }
  try {
    const evs = await primalQuery('events', { event_ids: eventIds }, 8000)
    const notes = new Map()
    const profiles = new Map()
    for (const ev of evs) {
      if (ev.kind === 1) notes.set(ev.id, ev)
      else if (ev.kind === 0) profiles.set(ev.pubkey, parseProfileEvent(ev))
    }
    return { notes, profiles }
  } catch { return { notes: new Map(), profiles: new Map() } }
}

// Expose Primal lookups for page-level handlers (e.g. /boosts.html zap flow
// needs to fetch a recipient's lud16 on demand if not cached).
export { fetchProfilesFromPrimal }

// ── Direct-relay fetch (untrusted source — verify everything) ────────
// Runs alongside Primal, not just as a fallback: relays are the
// completeness backstop for the note set (see fetchBoostThread).
function eventReferencesRoot(ev, rootId) {
  if (!Array.isArray(ev?.tags)) return false
  for (const t of ev.tags) {
    if (Array.isArray(t) && t[0] === 'e' && t[1] === rootId) return true
  }
  return false
}

// ⚠️ maxWait is load-bearing, not a tuning knob. Left unset, the vendored pool
// applies its own baseEoseTimeout of 4400ms per relay, and that timer fires a
// SYNTHETIC eose — subscribeEose then closes the subscription while events are
// still streaming, so a slow link silently returns a truncated thread rather
// than an error. Measured from a wired desktop this query takes ~3.8s against
// that 4400ms default, which is no margin at all for a phone on cellular, and a
// truncated relay result is now the whole feed rather than a supplement.
//
// The cost is honest and worth stating: maxWait also raises the per-relay
// connection timeout (the pool derives it as maxWait - 1000 once maxWait clears
// its 3000ms default), so one dead relay now holds the query ~7s instead of
// ~3s, and fetchBoostThread paints only after Promise.all settles. A spinner
// for a few seconds longer beats a feed that is quietly missing notes, but the
// real answer is to paint from the relays as soon as they resolve and repaint
// when Primal lands; that changes this function's contract and its three
// callers, so it is deliberately not bundled in here.
const RELAY_MAX_WAIT_MS = 8000

async function fetchThreadNotesFromRelays(rootId, relays) {
  const pool = new SimplePool()
  try {
    const [root, replies] = await Promise.all([
      pool.get(relays, { kinds: [1], ids: [rootId] }, { maxWait: RELAY_MAX_WAIT_MS }).catch(() => null),
      pool.querySync(relays, { kinds: [1], '#e': [rootId], limit: 500 }, { maxWait: RELAY_MAX_WAIT_MS }).catch(() => []),
    ])
    const notes = []
    if (root && root.id === rootId && verifyEvent(root)) notes.push(root)
    for (const ev of replies) {
      if (!ev?.id || ev.id === rootId) continue
      if (!eventReferencesRoot(ev, rootId)) continue
      if (!verifyEvent(ev)) continue
      notes.push(ev)
    }
    return notes
  } finally {
    pool.close(relays)
  }
}

// Author profiles normally come from Primal's thread_view response; this
// only runs when Primal was unreachable, so cards still get display
// names + avatars instead of bare npubs.
async function fetchProfilesFromRelays(pubkeys, relays) {
  if (!pubkeys.length) return new Map()
  const pool = new SimplePool()
  try {
    const profiles = new Map()
    await Promise.all(pubkeys.map(async (pk) => {
      const ev = await pool.get(relays, { kinds: [0], authors: [pk] }).catch(() => null)
      if (ev && ev.pubkey === pk && verifyEvent(ev)) {
        profiles.set(pk, parseProfileEvent(ev))
      }
    }))
    return profiles
  } finally {
    pool.close(relays)
  }
}

// ── Pre-assembled wall (primary source) ──────────────────────────────
// /api/boost-wall proxies a file the bots build: every kind-1 in the thread
// as its raw signed event, plus the payment context that was in hand when the
// note was published. It replaces a ~5 MB Primal thread_view and four relay
// sockets with one ~660 KB cached fetch, on all four pages that call
// fetchBoostThread (boosts.html, index.html, stats.html, /ep###).
//
// Same-origin is NOT a reason to trust it. These are signed events and they
// stay verified here exactly as the relay path verifies them; the proxy is
// transport. What we do skip is `eventReferencesRoot` being the only filter —
// the file is scoped to one thread, so a record that doesn't reference the
// root is a bug in the writer and is dropped rather than rendered.
const BOOST_WALL_URL = '/api/boost-wall'
const BOOST_WALL_TIMEOUT_MS = 8000

// Payment context by event id, populated only when the wall file is the
// source. The thread's own notes carry no episode identifier — the publisher
// puts the NIP-73 GUID tags on the standalone twin, not on the boost-board
// reply, so a GUID-aware client doesn't surface every boost twice — which is
// why episode/sats/app live in the record and not in the event's tags.
// Absent for anything the relay fallback supplied, so callers must treat a
// miss as "unknown", never as zero.
const boostMetaById = new Map()
export function getBoostMeta(id) {
  return boostMetaById.get(id) || null
}

// ⚠️ episode_num is a zero-padded STRING ("019", "001") matching sats.csv's
// column, and is absent rather than 0 when unknown. Compare it as a string or
// normalize explicitly; `=== 19` will never match.
function parseWallRecord(rec) {
  const num = typeof rec.episode_num === 'string' ? rec.episode_num : null
  return {
    paymentHash:  rec.payment_hash  || null,
    sats:         Number.isFinite(rec.sats) ? rec.sats : null,
    senderNpub:   rec.sender_npub   || null,
    senderName:   rec.sender_name   || null,
    episodeId:    rec.episode_id    || null,
    episodeNum:   num,
    episodeTitle: rec.episode_title || null,
    showLevel:    rec.show_level === true,
    app:          rec.app           || null,
    source:       rec.source        || null,
    settledAt:    rec.settled_at    || null,
    standaloneId: rec.standalone_id || null,
  }
}

// Verifying the whole wall is ~1.3 ms per event, so ~550 ms for 400 notes on a
// wired desktop and several times that on a phone. As one loop that is a
// single long task that blocks paint and input for the duration, which would
// spend a good part of what the file just saved. Yielding between chunks keeps
// the total the same but lets the browser stay responsive through it.
async function verifyEventsChunked(events, chunkSize = 40) {
  const verified = []
  for (let i = 0; i < events.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, events.length)
    for (let j = i; j < end; j++) {
      if (verifyEvent(events[j])) verified.push(events[j])
    }
    if (end < events.length) await new Promise((r) => setTimeout(r, 0))
  }
  return verified
}

// Returns null on anything unexpected so the caller falls back to the live
// path. That deliberately includes a body that doesn't parse: the upstream
// relay answers a MISSING file with HTTP 200 and 37 bytes of English prose
// ("Please use a Nostr client to connect."), so a 200 is not on its own
// evidence that the file exists.
async function fetchThreadFromBoostWall(rootId) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), BOOST_WALL_TIMEOUT_MS)
  try {
    const resp = await fetch(BOOST_WALL_URL, { signal: ctrl.signal })
    if (!resp.ok) return null
    const records = await resp.json()
    if (!Array.isArray(records) || records.length === 0) return null

    const candidates = []
    const meta = new Map()
    for (const rec of records) {
      const ev = rec?.event
      if (!ev || typeof ev.id !== 'string' || ev.kind !== 1) continue
      if (ev.id !== rootId && !eventReferencesRoot(ev, rootId)) continue
      candidates.push(ev)
      meta.set(ev.id, parseWallRecord(rec))
    }

    const notes = await verifyEventsChunked(candidates)
    // No root means buildThread would return nothing renderable. Treat a
    // rootless file as a failed fetch rather than as an empty wall.
    if (!notes.some((ev) => ev.id === rootId)) return null
    return { notes, meta }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Card renderer ────────────────────────────────────────────────────
export function renderNoteCard(ev, { isRoot = false } = {}) {
  const profile = profileCache.get(ev.pubkey)
  const card = document.createElement('article')
  card.className = 'note-card' + (isRoot ? ' is-root' : '')

  const authorRow = document.createElement('div')
  authorRow.className = 'note-author'

  const img = document.createElement('img')
  img.src = profile?.picture || '/assets/LocalBitcoiners.png'
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  img.onerror = () => { img.src = '/assets/LocalBitcoiners.png' }
  authorRow.appendChild(img)

  const nameWrap = document.createElement('div')
  nameWrap.style.display = 'flex'
  nameWrap.style.flexDirection = 'column'
  nameWrap.style.minWidth = '0'

  const nameEl = document.createElement('span')
  nameEl.className = 'author-name'
  nameEl.textContent = profile?.name || (ev.pubkey.slice(0, 8) + '…')
  nameWrap.appendChild(nameEl)

  if (profile?.nip05) {
    const handle = document.createElement('span')
    handle.className = 'author-handle'
    handle.textContent = profile.nip05
    nameWrap.appendChild(handle)
  }
  authorRow.appendChild(nameWrap)

  const time = document.createElement('time')
  time.dateTime = new Date(ev.created_at * 1000).toISOString()
  time.textContent = relTime(ev.created_at)
  time.title = new Date(ev.created_at * 1000).toLocaleString()
  authorRow.appendChild(time)

  card.appendChild(authorRow)

  const body = document.createElement('div')
  body.className = 'note-body'
  renderContentInto(body, ev.content)
  card.appendChild(body)

  const footer = document.createElement('div')
  footer.className = 'note-footer'
  let nevent = ''
  try { nevent = nip19.neventEncode({ id: ev.id, author: ev.pubkey }) } catch {}
  if (nevent) {
    const link = document.createElement('a')
    link.href = `https://njump.me/${nevent}`
    link.textContent = 'View on Nostr →'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    footer.appendChild(link)
  }
  card.appendChild(footer)

  // Per-card actions (Reply/Like/Repost/Zap) injected by the host page.
  // Skipped on the root card and skipped entirely on read-only pages.
  if (!isRoot && typeof actionsBuilder === 'function') {
    const bar = actionsBuilder(ev, card)
    if (bar) card.appendChild(bar)
  }

  return card
}

function getOrRenderCard(ev, opts) {
  const key = ev.id.toLowerCase()
  let card = cardCache.get(key)
  if (!card) {
    card = renderNoteCard(ev, opts)
    cardCache.set(key, card)
  }
  return card
}

// ── Direct-child card list ───────────────────────────────────────────
// Renders the immediate child notes of `parentId` as a flat card list.
// Deliberately one level deep: replies to those notes are not shown
// anywhere on the site (spam mitigation).
export function renderChildCards(parentId, childrenOf, container) {
  const kids = childrenOf.get(parentId) || []
  if (!kids.length) return
  const ul = document.createElement('ul')
  ul.className = 'reply-children'
  for (const ev of kids) {
    const li = document.createElement('li')
    li.appendChild(getOrRenderCard(ev))
    ul.appendChild(li)
  }
  container.appendChild(ul)
}

// ── Thread building ──────────────────────────────────────────────────
export function buildThread(rootId, allNotes) {
  const root = allNotes.find(n => n.id === rootId)
  const childrenOf = new Map()
  for (const ev of allNotes) {
    if (!ev?.id || ev.id === rootId) continue
    if (EXCLUDED_NOTE_IDS.has(ev.id)) continue
    const eTags = (ev.tags || []).filter(t => t[0] === 'e')
    if (!eTags.length) continue
    const replyTag = eTags.find(t => t[3] === 'reply') || eTags[eTags.length - 1]
    const parentId = replyTag?.[1]
    if (!parentId) continue
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, [])
    childrenOf.get(parentId).push(ev)
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
  }
  return { root, childrenOf }
}

function isWsUrl(u) {
  if (typeof u !== 'string') return false
  return u.startsWith('wss://') || u.startsWith('ws://')
}

// ── Public: one-shot thread fetch ────────────────────────────────────
// Wraps Primal-first + relay-fallback fetch, resolves cross-references
// (mentioned npubs, quoted notes, NIP-52 calendar events), and populates
// the module-level caches. Returns the parsed thread structure for the
// caller to render.
export async function fetchBoostThread({ rootNevent = ROOT_NEVENT, onPartial = null } = {}) {
  let rootId, hintRelays = []
  try {
    const decoded = nip19.decode(rootNevent)
    if (decoded.type !== 'nevent') throw new Error('not an nevent')
    rootId     = decoded.data.id
    hintRelays = Array.isArray(decoded.data.relays) ? decoded.data.relays.filter(isWsUrl) : []
  } catch {
    return { rootEvent: null, childrenOf: new Map(), error: 'invalid-root' }
  }

  const relays = Array.from(new Set([...STATIC_RELAYS, ...hintRelays]))

  // ── Primary: the pre-assembled wall ────────────────────────────────
  // One cached same-origin fetch replaces both live sources below. When it
  // answers we skip them entirely rather than unioning, because the file is
  // rebuilt daily from a relay scan of the whole thread and appended to per
  // boost, so it already contains what the union would find — including the
  // root, the corrections published by hand, and the replies from other
  // pubkeys that the publisher never wrote.
  //
  // The honest cost is staleness. A note reaches the file when the publisher
  // next runs and reaches the browser after the proxy's 300s cache, so a brand
  // new boost can be ~5 minutes later here than it would have been off the
  // relays. The publisher's own cadence already meant a boost was not instant,
  // so this widens an existing window rather than opening a new one; if it ever
  // needs to be tighter, a post-boost relay top-up belongs at the call sites
  // that know a boost just settled, not in this function.
  const wall = await fetchThreadFromBoostWall(rootId)

  let notes, profiles
  boostMetaById.clear()

  if (wall) {
    notes = wall.notes
    for (const [id, m] of wall.meta) boostMetaById.set(id, m)
    // The file carries no kind-0. The thread has only a handful of distinct
    // authors (the show bot plus a couple of others), so this is one small
    // request, and the profiles.size === 0 relay fallback below still covers
    // it if Primal is unreachable.
    profiles = await fetchProfilesForDisplay([
      ...new Set(notes.map((n) => n.pubkey)),
    ]).catch(() => new Map())
  } else {
    ;({ notes, profiles } = await fetchThreadFromLiveSources(rootId, relays))
  }

  const { root, childrenOf } = buildThread(rootId, notes)
  if (!root) {
    return { rootEvent: null, childrenOf: new Map(), error: 'no-root' }
  }

  // If Primal was unreachable we have notes but no author profiles — back-fill
  // them from relays so cards aren't all bare npubs.
  if (notes.length && profiles.size === 0) {
    profiles = await fetchProfilesFromRelays(
      [...new Set(notes.map((n) => n.pubkey))],
      relays,
    ).catch(() => new Map())
  }

  for (const [pk, p] of profiles) setCachedProfile(pk, p)
  for (const ev of notes) embedCache.set(ev.id, ev)

  // Every note is in hand here, and with the profile cache the authors and
  // boosters already have names and avatars. What is left — quoted notes,
  // NIP-52 calendar cards, and profiles for anyone the nightly file missed —
  // is enrichment of a few cards, not the feed.
  //
  // Measured on boosts.html, this point is reached at ~1.3 s while the call
  // did not resolve until ~4.6 s, so a caller that waits for the return value
  // stares at a spinner for three seconds holding a complete thread. onPartial
  // lets it paint now and repaint when the rest lands; finishBoostThread
  // evicts exactly the cards whose content changed, so the repaint is cheap.
  //
  // Callers that don't pass onPartial behave exactly as before.
  if (typeof onPartial === 'function') {
    try { onPartial({ rootEvent: root, childrenOf }) }
    catch (e) { console.warn('[boosts-thread] onPartial threw', e) }
  }

  return finishBoostThread({ root, childrenOf, notes, hintRelays })
}

// ── Fallback: the live path ──────────────────────────────────────────
// Unchanged from before the wall file existed, and still the whole path
// whenever /api/boost-wall is unreachable, stale-empty, or rootless.
async function fetchThreadFromLiveSources(rootId, relays) {
  // Fetch from Primal and the relays in parallel, then union the note
  // sets by id.
  //
  // ⚠️ The relays are the PRIMARY source and Primal is the supplement, which
  // is the reverse of how this read until 2026-08-12. Primal's thread_view is
  // one 4.8 MB response carrying ~1,900 events of which we keep the kind 1 and
  // kind 0 — about 11% — and it delivers the notes at the very END of that
  // stream, so a connection that misses PRIMAL_TIMEOUT_MS loses nearly all of
  // them at once rather than a proportional slice. On a phone that is routine,
  // and it is why a listener on mobile saw a feed 50 boosts short of the same
  // page on desktop while every refresh returned a different subset.
  //
  // STATIC_RELAYS now covers 399 of 399 known boosts on its own (see the table
  // at the top of this file), so a slow or dropped Primal response costs speed
  // and some profile hydration, not notes. Keep the union: Primal still fills
  // kind-0 for authors the relays don't carry, and it is the faster of the two
  // when it lands. Note the onclose handler in primalQuery resolves with a
  // partial event list rather than rejecting, which is safe only because the
  // relay side no longer depends on it.
  const [primal, relayNotes] = await Promise.all([
    fetchThreadFromPrimal(rootId).catch((e) => {
      console.warn('[boosts-thread] Primal fetch failed', e)
      return { notes: [], profiles: new Map() }
    }),
    fetchThreadNotesFromRelays(rootId, relays).catch((e) => {
      console.warn('[boosts-thread] relay fetch failed', e)
      return []
    }),
  ])

  const notesById = new Map()
  for (const ev of relayNotes) if (ev?.id) notesById.set(ev.id, ev)
  for (const ev of primal.notes) if (ev?.id) notesById.set(ev.id, ev)
  return { notes: [...notesById.values()], profiles: primal.profiles }
}

// ── Cross-reference resolution ───────────────────────────────────────
// Shared by both sources: mentioned npubs, quoted notes and NIP-52 calendar
// events are referenced from note CONTENT, so they have to be resolved live
// no matter where the notes themselves came from.
async function finishBoostThread({ root, childrenOf, notes, hintRelays }) {
  const wantedPubkeys     = new Set()
  const wantedEventIds    = new Set()
  const wantedCalendarCoords = new Set()
  // note id → the refs it mentions, so that once resolution finishes we can
  // evict exactly the cards whose content changed. A caller that painted early
  // has already rendered these with a truncated npub or an embed skeleton, and
  // getOrRenderCard would otherwise hand back that same stale node forever.
  const refsByNote = new Map()
  for (const ev of notes) {
    const refs = { pubkeys: [], eventIds: [], coords: [] }
    for (const m of (ev.content || '').matchAll(NOSTR_URI_RE)) {
      try {
        const decoded = nip19.decode(m[1])
        if (decoded.type === 'npub') { wantedPubkeys.add(decoded.data); refs.pubkeys.push(decoded.data) }
        else if (decoded.type === 'nprofile') { wantedPubkeys.add(decoded.data.pubkey); refs.pubkeys.push(decoded.data.pubkey) }
        else if (decoded.type === 'note') { wantedEventIds.add(decoded.data); refs.eventIds.push(decoded.data) }
        else if (decoded.type === 'nevent') { wantedEventIds.add(decoded.data.id); refs.eventIds.push(decoded.data.id) }
        else if (decoded.type === 'naddr') {
          const { kind, pubkey, identifier } = decoded.data
          if ((kind === KIND_DATE_EVENT || kind === KIND_TIME_EVENT) && pubkey && identifier) {
            const coord = `${kind}:${pubkey}:${identifier}`
            wantedCalendarCoords.add(coord)
            refs.coords.push(coord)
          }
        }
      } catch {}
    }
    if (refs.pubkeys.length || refs.eventIds.length || refs.coords.length) {
      refsByNote.set(ev.id, refs)
    }
  }
  const missingPubkeys     = [...wantedPubkeys].filter(pk => !profileCache.has(pk))
  const missingEventIds    = [...wantedEventIds].filter(id => !embedCache.has(id))
  const missingCalendar    = [...wantedCalendarCoords].filter(c => !calendarCache.has(c))
  const calendarFetchRelays = relaysForAddressableKinds(
    Array.from(new Set([...STATIC_RELAYS, ...hintRelays])),
  )

  if (missingPubkeys.length || missingEventIds.length || missingCalendar.length) {
    const [extraProfiles, extraEvents, extraCalendar] = await Promise.all([
      fetchProfilesForDisplay(missingPubkeys),
      fetchEventsFromPrimal(missingEventIds),
      fetchCalendarEventsFromRelays(missingCalendar, calendarFetchRelays),
    ])
    for (const [pk, p] of extraProfiles) setCachedProfile(pk, p)
    for (const [id, ev] of extraEvents.notes) embedCache.set(id, ev)
    for (const [pk, p] of extraEvents.profiles) setCachedProfile(pk, p)
    for (const [coord, parsed] of extraCalendar) calendarCache.set(coord, parsed)
    // Mark unresolvable ids so the renderer shows the "not available"
    // fallback instead of a perpetual skeleton.
    for (const id of missingEventIds) {
      if (!embedCache.has(id)) embedCache.set(id, null)
    }
    for (const coord of missingCalendar) {
      if (!calendarCache.has(coord)) calendarCache.set(coord, null)
    }

    // Quoted-event authors + calendar-event organisers come back without
    // their kind-0; do a follow-up profile fetch so embed cards render
    // @displayName instead of a truncated npub.
    const embedAuthorPubkeys = new Set()
    for (const [, ev] of extraEvents.notes) {
      if (ev?.pubkey && !profileCache.has(ev.pubkey)) embedAuthorPubkeys.add(ev.pubkey)
    }
    for (const [, parsed] of extraCalendar) {
      if (parsed?.pubkey && !profileCache.has(parsed.pubkey)) embedAuthorPubkeys.add(parsed.pubkey)
    }
    if (embedAuthorPubkeys.size) {
      const more = await fetchProfilesForDisplay([...embedAuthorPubkeys])
      for (const [pk, p] of more) setCachedProfile(pk, p)
    }

    // Drop the cards that were painted before these resolved. Scoped to notes
    // that actually referenced something missing — a full cardCache clear would
    // rebuild all 400 nodes to fix the handful that changed.
    const wasMissing = {
      pubkeys: new Set(missingPubkeys),
      eventIds: new Set(missingEventIds),
      coords: new Set(missingCalendar),
    }
    for (const [noteId, refs] of refsByNote) {
      const touched =
        refs.pubkeys.some((pk) => wasMissing.pubkeys.has(pk)) ||
        refs.eventIds.some((id) => wasMissing.eventIds.has(id)) ||
        refs.coords.some((c) => wasMissing.coords.has(c))
      if (touched) evictCard(noteId)
    }
  }

  return { rootEvent: root, childrenOf, error: null }
}
