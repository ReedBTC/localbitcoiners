/* Shared NIP-52 calendar-event helpers.
 *
 * Parsing, timezone-aware formatting, relay fetch, sort helpers, and card
 * rendering for kind 31922 (date-based) and 31923 (time-based) calendar
 * events. Used by the boost-thread renderer (boosts-thread.js — calendar
 * events embedded inside boost notes) and the Meetups page (meetups.js).
 *
 * Vendored nostr-tools — same bundle the rest of the site uses.
 */
import { SimplePool, verifyEvent, nip19 } from '/assets/widgets/nostr-tools.js'

export const KIND_DATE_EVENT = 31922
export const KIND_TIME_EVENT = 31923

// Time-based events with no explicit end stay "upcoming" for this long
// past their start, so a meetup in progress doesn't immediately drop
// into the past bucket.
const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000

// ── Tag access + parsing ─────────────────────────────────────────────
function calendarTagValue(ev, name) {
  if (!Array.isArray(ev?.tags)) return ''
  for (const t of ev.tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === 'string') return t[1]
  }
  return ''
}

function sanitizeTzid(raw) {
  const tz = String(raw || '').trim()
  if (!tz) return ''
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch { return '' }
}

export function parseCalendarEvent(ev) {
  if (!ev || (ev.kind !== KIND_DATE_EVENT && ev.kind !== KIND_TIME_EVENT)) return null
  const dTag = calendarTagValue(ev, 'd')
  if (!dTag) return null
  const title = calendarTagValue(ev, 'title')
  if (!title) return null
  const startRaw = calendarTagValue(ev, 'start')
  if (!startRaw) return null
  const isDateBased = ev.kind === KIND_DATE_EVENT
  const endRaw = calendarTagValue(ev, 'end')
  return {
    id: ev.id || '',
    pubkey: ev.pubkey || '',
    kind: ev.kind,
    dTag,
    title,
    summary:  calendarTagValue(ev, 'summary'),
    location: calendarTagValue(ev, 'location'),
    image:    calendarTagValue(ev, 'image'),
    isDateBased,
    start: startRaw,
    end:   endRaw,
    startTzid: isDateBased ? '' : sanitizeTzid(calendarTagValue(ev, 'start_tzid')),
  }
}

// ── Timezone-aware formatting ────────────────────────────────────────
export function formatEventWhen(parsed) {
  if (!parsed) return ''
  if (parsed.isDateBased) {
    const startMs = ymdToMs(parsed.start)
    if (!Number.isFinite(startMs)) return parsed.start || ''
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      year: yearOpt(startMs),
      timeZone: 'UTC',
    })
    const startStr = fmt.format(new Date(startMs))
    if (parsed.end) {
      const endMs = ymdToMs(parsed.end)
      if (Number.isFinite(endMs) && endMs > startMs) {
        return `${startStr} – ${fmt.format(new Date(endMs))}`
      }
    }
    return startStr
  }
  const startSec = parseInt(parsed.start, 10)
  if (!Number.isFinite(startSec)) return parsed.start || ''
  const tz = parsed.startTzid || undefined
  const dtOpts = {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: tz,
    timeZoneName: 'short',
    year: yearOpt(startSec * 1000),
  }
  const fmt = new Intl.DateTimeFormat(undefined, dtOpts)
  const startStr = fmt.format(new Date(startSec * 1000))
  if (parsed.end) {
    const endSec = parseInt(parsed.end, 10)
    if (Number.isFinite(endSec) && endSec > startSec) {
      const sameDay = sameYmdInTz(startSec * 1000, endSec * 1000, tz)
      const endFmt = sameDay
        ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' })
        : fmt
      return `${startStr} – ${endFmt.format(new Date(endSec * 1000))}`
    }
  }
  return startStr
}

function ymdToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

function yearOpt(ms) {
  return new Date(ms).getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric'
}

function sameYmdInTz(aMs, bMs, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    return fmt.format(new Date(aMs)) === fmt.format(new Date(bMs))
  } catch { return false }
}

// ── Sort + bucket helpers ────────────────────────────────────────────
// Epoch ms for a parsed event's start — NaN if the start can't be read.
export function eventStartMs(parsed) {
  if (!parsed) return NaN
  if (parsed.isDateBased) return ymdToMs(parsed.start)
  const sec = parseInt(parsed.start, 10)
  return Number.isFinite(sec) ? sec * 1000 : NaN
}

// Epoch ms for when a parsed event is over — used to bucket upcoming vs
// past. Date-based events run through the end of their final day (UTC);
// time-based events without an end get a default duration.
export function eventEndMs(parsed) {
  if (!parsed) return NaN
  if (parsed.isDateBased) {
    const ms = ymdToMs(parsed.end || parsed.start)
    return Number.isFinite(ms) ? ms + 86400000 : NaN
  }
  const startSec = parseInt(parsed.start, 10)
  if (!Number.isFinite(startSec)) return NaN
  const endSec = parsed.end ? parseInt(parsed.end, 10) : NaN
  if (Number.isFinite(endSec) && endSec > startSec) return endSec * 1000
  return startSec * 1000 + DEFAULT_EVENT_DURATION_MS
}

// ── Relay fetch (untrusted source — verify everything) ───────────────
export async function fetchCalendarEventsFromRelays(coords, relays) {
  if (!coords.length) return new Map()
  const out = new Map()
  const byKind = new Map()
  for (const coord of coords) {
    const [k, pk, d] = String(coord).split(':')
    const kindNum = parseInt(k, 10)
    if ((kindNum !== KIND_DATE_EVENT && kindNum !== KIND_TIME_EVENT) || !/^[0-9a-f]{64}$/i.test(pk || '') || !d) continue
    if (!byKind.has(kindNum)) byKind.set(kindNum, { authors: new Set(), dTags: new Set() })
    const bucket = byKind.get(kindNum)
    bucket.authors.add(pk)
    bucket.dTags.add(d)
  }
  if (!byKind.size) return out

  const pool = new SimplePool()
  try {
    const queries = []
    for (const [kindNum, { authors, dTags }] of byKind) {
      queries.push(
        pool.querySync(relays, {
          kinds:   [kindNum],
          authors: [...authors],
          '#d':    [...dTags],
          limit:   200,
        }).catch(() => [])
      )
    }
    const results = await Promise.all(queries)
    const wanted = new Set(coords.map(String))
    for (const evs of results) {
      for (const ev of evs) {
        if (!ev || !verifyEvent(ev)) continue
        const parsed = parseCalendarEvent(ev)
        if (!parsed) continue
        const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
        if (!wanted.has(coord)) continue
        const prev = out.get(coord)
        if (!prev || (ev.created_at || 0) > (prev.createdAt || -1)) {
          parsed.createdAt = ev.created_at || 0
          out.set(coord, parsed)
        }
      }
    }
  } finally {
    try { pool.close(relays) } catch {}
  }
  return out
}

// ── Card renderer ────────────────────────────────────────────────────
// Builds the `.embed-note.is-event` card: an optional square cover
// thumbnail on the left, then organizer avatar + name (clickable — copies
// the npub — with a ⋮ overflow menu), a title that links to the event on
// mynostr.app, 📅 when, 📍 where, and — when `actions` is set — a Renote +
// Zap bar for logged-in users. `profile` is the organizer's parsed kind-0
// ({ name, picture }) or null; `bech32` is the event's naddr; `actions`
// opts the card into the interactive Renote/Zap bar (Feeds + Meetups pass
// it; the boosts-page embeds don't).
export function renderCalendarCard(parsed, { bech32 = '', profile = null, actions = false } = {}) {
  const card = document.createElement('div')
  card.className = 'embed-note is-event'

  // Cover thumbnail (NIP-52 `image` tag) on the left. When present, the
  // top of the card is a [thumb | content-column] row; the action bar
  // (below) then breaks out to the full card width so its dashed divider
  // and buttons run under the image too. `col` is where the author/title/
  // meta go; `actionsParent` is where the action bar goes.
  let col = card
  let actionsParent = card
  if (parsed.image) {
    card.classList.add('has-thumb')
    const top = document.createElement('div')
    top.className = 'event-top'

    const thumb = document.createElement('div')
    thumb.className = 'event-thumb'
    const timg = document.createElement('img')
    timg.src = parsed.image
    timg.alt = ''
    timg.loading = 'lazy'
    timg.referrerPolicy = 'no-referrer'
    // A broken cover shouldn't leave an empty box — collapse back to the
    // no-thumbnail layout.
    timg.onerror = () => { thumb.remove(); card.classList.remove('has-thumb') }
    thumb.appendChild(timg)
    top.appendChild(thumb)

    col = document.createElement('div')
    col.className = 'event-col'
    top.appendChild(col)
    card.appendChild(top)
  }

  const authorRow = document.createElement('div')
  authorRow.className = 'embed-author'

  // Avatar + name = one click-to-copy-npub control (like the supporter
  // cards). Falls back to a plain span if we have no pubkey to copy.
  const hasPubkey = /^[0-9a-f]{64}$/i.test(parsed.pubkey || '')
  const idEl = document.createElement(hasPubkey ? 'button' : 'span')
  idEl.className = 'author-id'
  if (hasPubkey) {
    idEl.type = 'button'
    idEl.title = 'Copy npub'
    idEl.addEventListener('click', () => copyNpub(parsed.pubkey))
  }

  const img = document.createElement('img')
  img.src = profile?.picture || '/assets/LocalBitcoiners.png'
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  img.onerror = () => { img.src = '/assets/LocalBitcoiners.png' }
  idEl.appendChild(img)

  const nameEl = document.createElement('span')
  nameEl.className = 'author-name'
  nameEl.textContent = profile?.name || ((parsed.pubkey || '').slice(0, 8) + '…')
  idEl.appendChild(nameEl)
  authorRow.appendChild(idEl)

  // ⋮ overflow menu (top-right of the author row) — copies the event's
  // nevent, mirroring the note cards on the boosts page.
  const menu = buildEventMenu(parsed)
  if (menu) authorRow.appendChild(menu)

  col.appendChild(authorRow)

  // Title links to the event (replacing the old footer "View on Nostr"
  // link); a plain div when there's no naddr to link to.
  const titleEl = document.createElement(bech32 ? 'a' : 'div')
  titleEl.className = 'event-title'
  titleEl.textContent = parsed.title
  if (bech32) {
    titleEl.href = eventAppUrl(bech32)
    titleEl.target = '_blank'
    titleEl.rel = 'noopener noreferrer'
  }
  col.appendChild(titleEl)

  const whenStr = formatEventWhen(parsed)
  if (whenStr) {
    const whenEl = document.createElement('div')
    whenEl.className = 'event-meta'
    const icon = document.createElement('span')
    icon.className = 'event-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '📅'
    whenEl.appendChild(icon)
    whenEl.appendChild(document.createTextNode(whenStr))
    col.appendChild(whenEl)
  }

  if (parsed.location) {
    const whereEl = document.createElement('div')
    whereEl.className = 'event-meta'
    const icon = document.createElement('span')
    icon.className = 'event-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '📍'
    whereEl.appendChild(icon)
    whereEl.appendChild(document.createTextNode(parsed.location))
    col.appendChild(whereEl)
  }

  if (actions) {
    const bar = buildEventActions(parsed)
    if (bar) actionsParent.appendChild(bar)
  }

  return card
}

// Where an event title links to. Centralized so the target app is a
// one-line change.
function eventAppUrl(bech32) {
  return `https://plektos.app/event/${bech32}`
}

// ── Renote + Zap bar ─────────────────────────────────────────────────
// Reuses the boosts page's signing/payment code (boost-actions.js),
// loaded on demand: the login widget provides window.LBLogin, and
// boost-actions exposes openZapModal() + repostAnyEvent(). Kept out of
// the static import graph so the shared renderer stays lightweight for
// pages that only display events.
function buildEventActions(parsed) {
  if (!parsed || !parsed.id || !parsed.pubkey) return null

  const bar = document.createElement('div')
  bar.className = 'note-actions'

  const renoteBtn = document.createElement('button')
  renoteBtn.type = 'button'
  renoteBtn.className = 'repost-btn'
  renoteBtn.dataset.noteId = parsed.id.toLowerCase()
  renoteBtn.title = 'Renote'
  renoteBtn.innerHTML = '<span class="lb-icon" aria-hidden="true">🔁</span><span>Renote</span>'
  renoteBtn.addEventListener('click', () => runEventAction('repost', parsed, renoteBtn))
  bar.appendChild(renoteBtn)

  const zapBtn = document.createElement('button')
  zapBtn.type = 'button'
  zapBtn.title = 'Zap'
  zapBtn.innerHTML = '<span class="lb-icon" aria-hidden="true">⚡</span><span>Zap</span>'
  zapBtn.addEventListener('click', () => runEventAction('zap', parsed, zapBtn))
  bar.appendChild(zapBtn)

  return bar
}

async function runEventAction(action, parsed, btn) {
  try {
    if (btn) btn.disabled = true
    await ensureLoginWidget()
    const actions = await import('/assets/js/boost-actions.js')
    if (action === 'zap') actions.openZapModal(parsed)
    else await actions.repostAnyEvent(parsed, btn)
  } catch (e) {
    console.error('[calendar] action failed', e)
    showCopyToast('Something went wrong — please try again')
  } finally {
    if (btn) btn.disabled = false
  }
}

// Load the Nostr login widget bundle if it isn't already present; it sets
// window.LBLogin synchronously on evaluation, so wait one microtask after
// onload before resolving. Idempotent across cards + pages.
let widgetPromise = null
function ensureLoginWidget() {
  if (window.LBLogin) return Promise.resolve()
  if (widgetPromise) return widgetPromise
  widgetPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/assets/widgets/login-widget.js'
    s.async = true
    s.onload = () => { Promise.resolve().then(resolve) }
    s.onerror = () => { widgetPromise = null; reject(new Error('login widget failed to load')) }
    document.head.appendChild(s)
  })
  return widgetPromise
}

function copyNpub(pubkeyHex) {
  let npub = ''
  try { npub = nip19.npubEncode(pubkeyHex) } catch {}
  if (!npub) { showCopyToast('Could not build npub'); return }
  copyText(npub).then((ok) => showCopyToast(ok ? 'npub copied' : 'Copy failed — clipboard blocked'))
}

// ── Per-card overflow (⋮) menu ───────────────────────────────────────
// Self-contained so the shared renderer carries no dependency on the
// boosts-page action bar. Mirrors buildMoreMenu() in boost-actions.js
// (same .note-more markup + "Copy nevent" behavior).
function buildEventMenu(parsed) {
  if (!parsed || !parsed.id || !parsed.pubkey) return null

  const wrap = document.createElement('div')
  wrap.className = 'note-more'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'note-more-btn'
  btn.title = 'More'
  btn.setAttribute('aria-label', 'More options')
  btn.setAttribute('aria-haspopup', 'true')
  btn.setAttribute('aria-expanded', 'false')
  btn.innerHTML = '<span class="lb-icon" aria-hidden="true">⋮</span>'
  wrap.appendChild(btn)

  const menu = document.createElement('div')
  menu.className = 'note-more-menu'
  menu.hidden = true

  const copyItem = document.createElement('button')
  copyItem.type = 'button'
  copyItem.className = 'note-more-item'
  copyItem.textContent = 'Copy nevent'
  copyItem.addEventListener('click', () => {
    closeMenu()
    copyEventNevent(parsed)
  })
  menu.appendChild(copyItem)
  wrap.appendChild(menu)

  function onDocPointer(e) { if (!wrap.contains(e.target)) closeMenu() }
  function onKey(e) { if (e.key === 'Escape') closeMenu() }
  function openMenu() {
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onDocPointer, true)
    document.addEventListener('keydown', onKey)
  }
  function closeMenu() {
    menu.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDocPointer, true)
    document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.hidden) openMenu()
    else closeMenu()
  })

  return wrap
}

async function copyEventNevent(parsed) {
  let nevent = ''
  try { nevent = nip19.neventEncode({ id: parsed.id, author: parsed.pubkey }) } catch {}
  if (!nevent) { showCopyToast('Could not build nevent'); return }
  showCopyToast(await copyText(nevent) ? 'nevent copied' : 'Copy failed — clipboard blocked')
}

// navigator.clipboard only exists in secure contexts (HTTPS / localhost),
// so it's unavailable on plain-HTTP LAN previews. Try it first, then fall
// back to the legacy execCommand path (runs inside the click gesture).
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true } catch {}
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

let toastEl = null
let toastTimer = null
function showCopyToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.setAttribute('role', 'status')
    toastEl.setAttribute('aria-live', 'polite')
    toastEl.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(8px);' +
      'background:#2d2010;color:#f5eedc;padding:0.6rem 1rem;border-radius:8px;' +
      'font-size:0.85rem;box-shadow:0 6px 20px rgba(0,0,0,0.3);opacity:0;' +
      'transition:opacity .18s ease,transform .18s ease;z-index:9999;pointer-events:none;'
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = msg
  void toastEl.offsetWidth
  toastEl.style.opacity = '1'
  toastEl.style.transform = 'translateX(-50%) translateY(0)'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0'
    toastEl.style.transform = 'translateX(-50%) translateY(8px)'
  }, 1600)
}
