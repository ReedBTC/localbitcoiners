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
const STATIC_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
]
export { STATIC_RELAYS }

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
const EXCLUDED_NOTE_IDS = new Set([
  '3d37e26095d46e844f4ad80ed00ce6bec94e9ba39b5b25278d3b1a8acfe20afc',
  '82d715867ce36bcf121eb8ef3b9844b42b6b9e9151b255328f98534bb30619ef',
  'bdf30ffae16bab70291733961931d95ca2bd73ed16341a236d9025bac26009a4',
  'a1e400e578c1cd78fecd5348a533c487ca57b85723968e66cb3567b93c6f8dfd',
  '44313741181237c5a833358f261f0e1bde53f5b3e2d3d54f6e95355965a5e82d',
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
      link.href = `https://njump.me/${seg.data.bech32}`
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

// ── Primal cache: low-level query ────────────────────────────────────
function primalQuery(op, params, timeoutMs = PRIMAL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false
    const events = []
    const finish = (val, err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      if (err) reject(err); else resolve(val)
    }
    const ws = new WebSocket(PRIMAL_WS_URL)
    const subId = `lb_${op}_${Date.now()}`
    const timer = setTimeout(
      () => finish(null, new Error(`Primal "${op}" timed out`)),
      timeoutMs,
    )
    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, { cache: [op, params] }]))
    }
    ws.onerror = () => finish(null, new Error(`Primal WS error (${op})`))
    // If close fires before EOSE, treat whatever we have as the result.
    ws.onclose = () => { if (!settled) finish(events) }
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data) } catch { return }
      const [type, , payload] = msg
      if (type === 'EVENT' && payload) events.push(payload)
      else if (type === 'EOSE') finish(events)
    }
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

async function fetchThreadNotesFromRelays(rootId, relays) {
  const pool = new SimplePool()
  try {
    const [root, replies] = await Promise.all([
      pool.get(relays, { kinds: [1], ids: [rootId] }).catch(() => null),
      pool.querySync(relays, { kinds: [1], '#e': [rootId], limit: 500 }).catch(() => []),
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
export async function fetchBoostThread({ rootNevent = ROOT_NEVENT } = {}) {
  let rootId, hintRelays = []
  try {
    const decoded = nip19.decode(rootNevent)
    if (decoded.type !== 'nevent') throw new Error('not an nevent')
    rootId     = decoded.data.id
    hintRelays = Array.isArray(decoded.data.relays) ? decoded.data.relays.filter(isWsUrl) : []
  } catch {
    return { rootEvent: null, childrenOf: new Map(), error: 'invalid-root' }
  }

  // Fetch from Primal and the relays in parallel, then union the note
  // sets by id. Primal's thread_view is fast and carries kind-0 profile
  // data, but a connection that closes mid-stream silently yields a
  // PARTIAL thread — and the old code accepted that as complete so long
  // as the root event was present. Relays are the completeness backstop;
  // merging both is what keeps low-frequency notes (e.g. the three ep-1
  // boosts among 120+) from intermittently vanishing.
  const relays = Array.from(new Set([...STATIC_RELAYS, ...hintRelays]))
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
  const notes = [...notesById.values()]
  let profiles = primal.profiles

  const { root, childrenOf } = buildThread(rootId, notes)
  if (!root) {
    return { rootEvent: null, childrenOf: new Map(), error: 'no-root' }
  }

  // If Primal was unreachable we have notes (from relays) but no author
  // profiles — back-fill them from relays so cards aren't all bare npubs.
  if (notes.length && profiles.size === 0) {
    profiles = await fetchProfilesFromRelays(
      [...new Set(notes.map((n) => n.pubkey))],
      relays,
    ).catch(() => new Map())
  }

  for (const [pk, p] of profiles) setCachedProfile(pk, p)
  for (const ev of notes) embedCache.set(ev.id, ev)

  // Resolve mention/quote/calendar cross-references so cards render rich.
  const wantedPubkeys     = new Set()
  const wantedEventIds    = new Set()
  const wantedCalendarCoords = new Set()
  for (const ev of notes) {
    for (const m of (ev.content || '').matchAll(NOSTR_URI_RE)) {
      try {
        const decoded = nip19.decode(m[1])
        if (decoded.type === 'npub') wantedPubkeys.add(decoded.data)
        else if (decoded.type === 'nprofile') wantedPubkeys.add(decoded.data.pubkey)
        else if (decoded.type === 'note') wantedEventIds.add(decoded.data)
        else if (decoded.type === 'nevent') wantedEventIds.add(decoded.data.id)
        else if (decoded.type === 'naddr') {
          const { kind, pubkey, identifier } = decoded.data
          if ((kind === KIND_DATE_EVENT || kind === KIND_TIME_EVENT) && pubkey && identifier) {
            wantedCalendarCoords.add(`${kind}:${pubkey}:${identifier}`)
          }
        }
      } catch {}
    }
  }
  const missingPubkeys     = [...wantedPubkeys].filter(pk => !profileCache.has(pk))
  const missingEventIds    = [...wantedEventIds].filter(id => !embedCache.has(id))
  const missingCalendar    = [...wantedCalendarCoords].filter(c => !calendarCache.has(c))
  const calendarFetchRelays = Array.from(new Set([...STATIC_RELAYS, ...hintRelays]))

  if (missingPubkeys.length || missingEventIds.length || missingCalendar.length) {
    const [extraProfiles, extraEvents, extraCalendar] = await Promise.all([
      fetchProfilesFromPrimal(missingPubkeys),
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
      const more = await fetchProfilesFromPrimal([...embedAuthorPubkeys])
      for (const [pk, p] of more) setCachedProfile(pk, p)
    }
  }

  return { rootEvent: root, childrenOf, error: null }
}
