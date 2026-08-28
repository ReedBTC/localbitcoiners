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
import { ensureLoginWidget } from '/assets/js/widget-loader.js'
import {
  ready as obReady, hasBoosterPage, boosterUrl, wrapWithDot,
} from '/assets/js/onlyboosts.js'

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
  // The single gate for this module. renderCalendarCard() is a synchronous
  // builder called from feeds.js, home-feeds.js, boosts-thread.js and
  // featured-articles.js, and it decides link-vs-copy once per card, so the
  // booster index has to be resolved before any of them build one. Every
  // surface that renders event cards from relay data comes through here first.
  //
  // ⚠️ ONE SURFACE BYPASSES THIS: a calendar event embedded inside a boost note
  // is parsed straight off the note rather than fetched, so on a cold cache its
  // host may render as copy-npub even when they have an OnlyBoosts page. It
  // self-corrects on the next page load once the index is in localStorage.
  await obReady()
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
// mynostr.app, 📅 when, 📍 where, and — when `actions` is set — a Repost +
// Zap bar for logged-in users. `profile` is the organizer's parsed kind-0
// ({ name, picture }) or null; `bech32` is the event's naddr; `actions`
// opts the card into the interactive Repost/Zap bar (Feeds + Meetups pass
// it; the boosts-page embeds don't).
export function renderCalendarCard(parsed, { bech32 = '', profile = null, actions = false, actionsLeft = null, featured = false, featuredBy = null } = {}) {
  const card = document.createElement('div')
  card.className = 'embed-note is-event'
  // Boosted (= "promoted") events wear a gold glow, mirroring the top-tier
  // supporter avatars. Feeds passes this for cards whose coordinate is in the
  // boosted set; everywhere else it stays off.
  if (featured) card.classList.add('is-featured')

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

  // Avatar + name = one control. It opens the host's OnlyBoosts page when they
  // have one and copies their npub when they don't (like the supporter cards).
  // Falls back to a plain span if we have no pubkey at all.
  const hasPubkey = /^[0-9a-f]{64}$/i.test(parsed.pubkey || '')
  const linked = hasPubkey && hasBoosterPage(parsed.pubkey)
  const idEl = document.createElement(hasPubkey ? (linked ? 'a' : 'button') : 'span')
  idEl.className = 'author-id'
  if (linked) {
    idEl.href = boosterUrl(parsed.pubkey)
    idEl.target = '_blank'
    idEl.rel = 'noopener noreferrer'
    idEl.title = 'View ' + (profile?.name || 'this booster') + ' on OnlyBoosts'
  } else if (hasPubkey) {
    idEl.type = 'button'
    idEl.title = 'Copy npub'
    idEl.addEventListener('click', () => copyNpub(parsed.pubkey))
  }

  const img = document.createElement('img')
  img.src = profile?.picture || '/assets/LocalBitcoiners.png'
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  img.onerror = () => { img.src = '/assets/LocalBitcoiners.png' }
  // The dot belongs on the avatar, not on the control — the control spans the
  // avatar AND the name, so its top-right corner is out past the name text.
  idEl.appendChild(linked ? wrapWithDot(img) : img)

  const nameEl = document.createElement('span')
  nameEl.className = 'author-name'
  nameEl.textContent = profile?.name || ((parsed.pubkey || '').slice(0, 8) + '…')
  idEl.appendChild(nameEl)
  authorRow.appendChild(idEl)

  // ⋮ overflow menu (top-right of the author row) — copies the event's
  // naddr, mirroring the note cards on the boosts page.
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
    // Already-featured (boosted) cards drop the Promote button — it only makes
    // sense as "get this into Featured". In its place they credit whoever paid
    // to feature it ("Featured by …").
    const bar = buildEventActions(parsed, actionsLeft, bech32, {
      promote: !featured,
      featuredBy: featured ? featuredBy : null,
      profile,
    })
    if (bar) actionsParent.appendChild(bar)
  }

  return card
}

// Where an event title links to. Centralized so the target app is a
// one-line change.
function eventAppUrl(bech32) {
  return `https://plektos.app/event/${bech32}`
}

// ── Repost + Zap bar ─────────────────────────────────────────────────
// Reuses the boosts page's signing/payment code (boost-actions.js),
// loaded on demand: the login widget provides window.LBLogin, and
// boost-actions exposes openZapModal() + repostAnyEvent(). Kept out of
// the static import graph so the shared renderer stays lightweight for
// pages that only display events.
function buildEventActions(parsed, actionsLeft = null, bech32 = '', { promote = true, featuredBy = null, profile = null } = {}) {
  if (!parsed || !parsed.id || !parsed.pubkey) return null

  const bar = document.createElement('div')
  bar.className = 'note-actions'

  // Left cluster — the "Featured by …" credit (on featured cards, where the
  // Promote button would be) and/or the "See other versions" toggle. The
  // cluster's margin-right:auto pushes the action buttons to the right edge.
  const leftItems = []
  if (featuredBy) leftItems.push(buildFeaturedBy(featuredBy))
  if (actionsLeft) leftItems.push(actionsLeft)
  if (leftItems.length) {
    const cluster = document.createElement('div')
    cluster.className = 'note-actions-left'
    for (const el of leftItems) cluster.appendChild(el)
    bar.appendChild(cluster)
  }

  // ⚡ Promote — really a boost. Opens the show-boost modal prefilled with a
  // reference to this event (same handoff the /meetups "boost an existing
  // meetup" flows use), so paying it promotes the event into the Featured
  // section. Only offered when we have an naddr to reference. Orange fill +
  // white bolt so it reads as the boost CTA even though it says "Promote".
  if (bech32 && promote) {
    const promoteBtn = document.createElement('button')
    promoteBtn.type = 'button'
    promoteBtn.className = 'promote-btn'
    promoteBtn.title = 'Feature — boost this event into the Featured section'
    promoteBtn.innerHTML =
      '<svg class="promote-bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg><span>Feature</span>'
    promoteBtn.addEventListener('click', () => promoteEvent(parsed, bech32, promoteBtn, profile))
    bar.appendChild(promoteBtn)
  }

  const renoteBtn = document.createElement('button')
  renoteBtn.type = 'button'
  renoteBtn.className = 'repost-btn'
  renoteBtn.dataset.noteId = parsed.id.toLowerCase()
  renoteBtn.title = 'Repost'
  renoteBtn.innerHTML = '<span class="lb-icon" aria-hidden="true">🔁</span><span>Repost</span>'
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

// "Featured by (pfp) Name" credit for a featured card, shown where the Promote
// button sits on non-featured cards. `info` is { pubkey (hex), name, picture }
// for whoever boosted the event into the Featured section. Click-to-copy-npub,
// mirroring the author-id control.
function buildFeaturedBy(info) {
  if (!info) return document.createElement('span')
  // No booster known (an anonymous feature): just "Featured · 3d ago".
  if (!info.pubkey) {
    const anon = document.createElement('span')
    anon.className = 'featured-by featured-by--anon'
    if (!info.when) return anon
    const lbl = document.createElement('span')
    lbl.className = 'featured-by-label'
    lbl.textContent = 'Featured'
    anon.appendChild(lbl)
    const when = document.createElement('span')
    when.className = 'featured-by-when'
    when.textContent = '· ' + info.when
    anon.appendChild(when)
    return anon
  }
  const hasPubkey = /^[0-9a-f]{64}$/i.test(info.pubkey)
  const linked = hasPubkey && hasBoosterPage(info.pubkey)
  // The credit is plain text; only the person (pfp + name) is clickable —
  // their OnlyBoosts page when they have one, else copy-npub.
  const el = document.createElement('span')
  el.className = 'featured-by'
  const who = document.createElement(hasPubkey ? (linked ? 'a' : 'button') : 'span')
  who.className = 'featured-by-who'
  if (linked) {
    who.href = boosterUrl(info.pubkey)
    who.target = '_blank'
    who.rel = 'noopener noreferrer'
    who.title = 'View ' + (info.name || 'this booster') + ' on OnlyBoosts'
  } else if (hasPubkey) {
    who.type = 'button'
    who.title = 'Copy npub'
    who.addEventListener('click', () => copyNpub(info.pubkey))
  }

  const label = document.createElement('span')
  label.className = 'featured-by-label'
  label.textContent = 'Featured by'
  el.appendChild(label)
  el.appendChild(who)

  const img = document.createElement('img')
  img.className = 'featured-by-pfp'
  // Intrinsic width/height attributes so the avatar renders at 18px even if the
  // stylesheet is momentarily uncached — without them an unstyled profile image
  // paints at its natural (huge) size.
  img.width = 18
  img.height = 18
  img.src = info.picture || '/assets/LocalBitcoiners.png'
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  img.onerror = () => { img.src = '/assets/LocalBitcoiners.png' }
  who.appendChild(linked ? wrapWithDot(img) : img)

  const name = document.createElement('span')
  name.className = 'featured-by-name'
  name.textContent = info.name || (info.pubkey.slice(0, 8) + '…')
  who.appendChild(name)

  // Relative age of the feature, which is what makes the box's 1W/1M/All
  // range legible without a label explaining it.
  if (info.when) {
    const when = document.createElement('span')
    when.className = 'featured-by-when'
    when.textContent = '· ' + info.when
    el.appendChild(when)
  }

  return el
}

// The same prose the /meetups "boost an existing meetup" flows send, so a
// promote from a card is indistinguishable to the boost bot (which logs the
// referenced event into meetups.json → the boosted set).
const PROMOTE_TEMPLATE = 'Boosting my meetup from https://localbitcoiners.com/feeds'

// The most-recent promote click is stashed here so feeds.js can optimistically
// light up the card the moment the boost settles — before the daily meetups.json
// refresh catches up. One slot (boosts are sequential) with a short TTL.
export const PENDING_PROMOTE_KEY = 'lb_pending_promote'
const PENDING_PROMOTE_TTL = 10 * 60 * 1000

export function readPendingPromote() {
  try {
    const raw = localStorage.getItem(PENDING_PROMOTE_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!d || !d.coord || Date.now() - (d.ts || 0) > PENDING_PROMOTE_TTL) return null
    return d
  } catch { return null }
}

export function clearPendingPromote() {
  try { localStorage.removeItem(PENDING_PROMOTE_KEY) } catch {}
}

// `profile` is the organizer's cached kind-0 ({ name, picture, lud16 }) when
// the caller has it. The Feature boost pays the organizer the show's
// reassignable split leg (see login-widget/src/lib/featureSplit.js); a profile
// without a lud16 is resolved again inside the widget, from the relays, before
// the modal opens, and a miss falls back to the standard splits.
async function promoteEvent(parsed, bech32, btn, profile = null) {
  const coord = `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
  try {
    if (btn) btn.disabled = true
    // Record intent before we hand off, so the settle listener knows which
    // coordinate to light up. Stored even if the user later cancels — the TTL
    // and the "any leg succeeded" gate in feeds.js keep a cancelled boost from
    // wrongly promoting anything.
    try {
      localStorage.setItem(PENDING_PROMOTE_KEY, JSON.stringify({ coord, naddr: bech32, ts: Date.now() }))
    } catch {}
    await ensureLoginWidget()
    const prefillMessage = `${PROMOTE_TEMPLATE}\n\nnostr:${bech32}`
    const lud16 = typeof profile?.lud16 === 'string' ? profile.lud16.trim() : ''
    const feature = {
      kind: 'event',
      pubkey: parsed.pubkey,
      naddr: bech32,
      name: profile?.name || '',
      address: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lud16) ? lud16 : '',
    }
    if (window.LBLogin?.openShowBoost) {
      window.LBLogin.openShowBoost({ prefillMessage, feature })
    } else {
      showCopyToast('Boost unavailable right now — please try again')
    }
  } catch (e) {
    console.error('[calendar] promote failed', e)
    showCopyToast('Something went wrong — please try again')
  } finally {
    if (btn) btn.disabled = false
  }
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

function copyNpub(pubkeyHex) {
  let npub = ''
  try { npub = nip19.npubEncode(pubkeyHex) } catch {}
  if (!npub) { showCopyToast('Could not build npub'); return }
  copyText(npub).then((ok) => showCopyToast(ok ? 'npub copied' : 'Copy failed — clipboard blocked'))
}

// ── Per-card overflow (⋮) menu ───────────────────────────────────────
// Self-contained so the shared renderer carries no dependency on the
// boosts-page action bar. Mirrors buildMoreMenu() in boost-actions.js
// (same .note-more markup) but copies the event's naddr — calendar events
// are addressable (kind:pubkey:d), so naddr is the canonical reference.
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
  copyItem.textContent = 'Copy naddr'
  copyItem.addEventListener('click', () => {
    closeMenu()
    copyEventNaddr(parsed)
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

async function copyEventNaddr(parsed) {
  let naddr = ''
  try {
    naddr = nip19.naddrEncode({ identifier: parsed.dTag, pubkey: parsed.pubkey, kind: parsed.kind })
  } catch {}
  if (!naddr) { showCopyToast('Could not build naddr'); return }
  showCopyToast(await copyText(naddr) ? 'naddr copied' : 'Copy failed — clipboard blocked')
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
