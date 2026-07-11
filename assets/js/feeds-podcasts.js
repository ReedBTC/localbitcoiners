/* Podcast Boosts feed — the "Podcast Boosts" tab on /feeds.
 *
 * A list of *other* podcasts' episodes that the Local Bitcoiners community
 * has boosted on Nostr — framed as "here's what the community is boosting,"
 * not a leaderboard. The card is the EPISODE; clicking it opens a modal with
 * the individual boosts (who, how many sats, their message, when) plus a
 * "listen" link out to the episode.
 *
 * Unlike Events / Marketplace this feed is NOT a live relay subscription. It
 * reads one pre-computed snapshot from /api/community-boosts (a Cloudflare
 * Pages Function proxying a file the bots/community-boosts collector pushes
 * hourly). So there's no follow-pack / relay resolution here — the collector
 * already scoped every boost to the show's supporters. The only relay-ish
 * call we make is a single batched profile lookup for booster names/avatars,
 * which the JSON doesn't carry.
 *
 * Ordering: episodes are sorted by their most-recent boost, so a freshly
 * boosted but otherwise old episode still surfaces at the top.
 *
 * Entry point: renderPodcasts({ panel, list }) — lazy-imported by feeds.js
 * the first time the tab is opened.
 */
import { nip19 } from '/assets/widgets/nostr-tools.js'
import {
  fetchProfilesFromPrimal,
  setCachedProfile,
  parseSegments,
  renderSegmentsInto,
} from '/assets/js/boosts-thread.js'
import { fromApiValue, applyExternalOverrides } from '/assets/js/value-block.js'
import { buildActionBar, configureBoostActions } from '/assets/js/boost-actions.js'

const API_URL = '/api/community-boosts'
const VALUE_API = '/api/value'   // Podcast Index value-block proxy (splits)
const INITIAL_CARDS = 30       // episodes rendered per "load more" batch
const MAX_AVATARS = 3          // booster faces shown on a card face

// ── Tiny DOM helper (same contract as feeds-market.js / merch.js's h) ──
function h(tag, attrs = {}, children = []) {
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

function renderPlaceholder(list, title, body) {
  list.className = ''
  list.innerHTML = ''
  list.appendChild(h('div', { class: 'feed-placeholder' }, [
    h('strong', { text: title }),
    document.createTextNode(body),
  ]))
}

// ── Formatting ───────────────────────────────────────────────────────
function fmtSats(n) {
  if (!n || n < 0) return '0'
  if (n < 1000) return String(n)
  const k = n / 1000
  return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)) + 'k'
}

// Compact relative time for the card meta row: 3d, 5h, 2w, then a date.
function relTime(unixSec) {
  if (!unixSec) return ''
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60);   if (m < 60) return m + 'm ago'
  const hr = Math.floor(m / 60);  if (hr < 24) return hr + 'h ago'
  const d = Math.floor(hr / 24);  if (d < 7) return d + 'd ago'
  const w = Math.floor(d / 7);    if (w < 5) return w + 'w ago'
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullDate(unixSec) {
  if (!unixSec) return ''
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

// ── Clipboard + toast ────────────────────────────────────────────────
// navigator.clipboard only exists in secure contexts (HTTPS / localhost);
// fall back to the legacy execCommand path for plain-HTTP LAN previews.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

let toastTimer = null
function showToast(msg, isError = false) {
  let t = document.querySelector('.pcast-toast')
  if (!t) {
    t = h('div', { class: 'pcast-toast', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.toggle('is-error', !!isError)
  t.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2200)
}

async function copyNpub(npub) {
  if (!npub) { showToast('No npub for this account', true); return }
  const ok = await copyText(npub)
  showToast(ok ? 'npub copied' : 'Copy failed — clipboard blocked', !ok)
}

async function copyNevent(eventId, author) {
  let nevent = ''
  try { nevent = nip19.neventEncode({ id: eventId, author: author || undefined }) } catch {}
  if (!nevent) { showToast('Could not build nevent', true); return }
  const ok = await copyText(nevent)
  showToast(ok ? 'nevent copied' : 'Copy failed — clipboard blocked', !ok)
}

// ── Avatars ──────────────────────────────────────────────────────────
function isSafeImg(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' }
  catch { return false }
}

function initials(profile, npub) {
  const name = profile?.name?.trim()
  if (name) return name.slice(0, 2).toUpperCase()
  return (npub || '').replace(/^npub1/, '').slice(0, 2).toUpperCase() || '👤'
}

// A booster avatar. `interactive` wires click/keyboard to copy the npub.
// Avatars load eagerly (they're tiny, and `loading=lazy` left off-screen
// ones perpetually unloaded → looked broken); a picture that fails to load
// (dead host, hotlink block) swaps to the initials chip via onerror.
function avatarEl(profile, npub, { size = 26, interactive = false, cls = '' } = {}) {
  const style = `--pcast-av:${size}px`
  const makeInitials = () => wire(h('span', { class: 'pcast-avatar pcast-avatar--none ' + cls, style }, initials(profile, npub)))

  function wire(n) {
    if (interactive && npub) {
      n.classList.add('is-interactive')
      n.setAttribute('role', 'button')
      n.setAttribute('tabindex', '0')
      n.setAttribute('title', 'Copy npub')
      n.addEventListener('click', (e) => { e.stopPropagation(); copyNpub(npub) })
      n.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); copyNpub(npub) }
      })
    }
    return n
  }

  const pic = profile?.picture
  if (pic && isSafeImg(pic)) {
    const img = h('img', { class: 'pcast-avatar ' + cls, style, src: pic, alt: '', referrerpolicy: 'no-referrer' })
    img.addEventListener('error', () => { img.replaceWith(makeInitials()) }, { once: true })
    return wire(img)
  }
  return makeInitials()
}

// ── Episode link ladder ──────────────────────────────────────────────
// Prefer a per-boost Fountain episode URL (present on ~98% of episodes);
// otherwise fall back to a show-level smart link, and label the button so a
// show fallback never poses as an episode link.
function episodeLink(boosts, show) {
  const withUrl = boosts.find((b) => b.item_url)
  if (withUrl && isSafeImg(withUrl.item_url)) {
    // Every episode URL in the snapshot is a fountain.fm link, so name the
    // app; keep a generic label as a defensive fallback if that ever changes.
    let label = 'Listen to this episode'
    try {
      if (new URL(withUrl.item_url).hostname.replace(/^www\./, '') === 'fountain.fm') label = 'Listen on Fountain'
    } catch {}
    return { url: withUrl.item_url, label, episode: true }
  }
  const showName = show?.title ? show.title : 'the show'
  if (show?.itunes_id) {
    return { url: `https://pod.link/${show.itunes_id}`, label: `Find it on ${showName}`, episode: false }
  }
  if (show?.feed_id) {
    return { url: `https://podcastindex.org/podcast/${show.feed_id}`, label: 'Find it on Podcast Index', episode: false }
  }
  return null
}

// ── Data shaping ─────────────────────────────────────────────────────
// Group boosts by episode, resolve episode/show records, drop episodes we
// can't render (null Podcast Index episode record → no title/art), and sort
// by most-recent boost.
function buildEpisodes(data) {
  const { boosts = [], episodes = {}, shows = {} } = data || {}
  const byGuid = new Map()
  for (const b of boosts) {
    if (!b || !b.item_guid) continue
    const arr = byGuid.get(b.item_guid)
    if (arr) arr.push(b)
    else byGuid.set(b.item_guid, [b])
  }

  const out = []
  for (const [guid, list] of byGuid) {
    const ep = episodes[guid]
    if (!ep) continue                       // null episode record → can't render a card
    list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    const show = shows[ep.podcast_guid] || shows[list[0].podcast_guid] || null
    const distinct = []
    const seen = new Set()
    for (const b of list) {
      if (seen.has(b.booster_pubkey)) continue
      seen.add(b.booster_pubkey)
      distinct.push(b)
    }
    out.push({
      guid,
      ep,
      show,
      boosts: list,
      distinctBoosters: distinct,
      latest: list[0].created_at || 0,
      totalSats: list.reduce((s, b) => s + (b.sats || 0), 0),
    })
  }
  out.sort((a, b) => b.latest - a.latest)
  return out
}

// ── Subscribe links ──────────────────────────────────────────────────
// Show-level (not episode) deep links into podcast apps, built purely from
// snapshot fields — no runtime lookups:
//   • Fountain    — the fountain.fm/show/<id> URL a booster's own event
//                   carried (show_url); present on ~98% of episodes.
//   • Podcast Guru— app.podcastguru.io/podcast/<itunesId> (id alone resolves;
//                   the slug in a canonical URL is cosmetic).
//   • CurioCaster — curiocaster.com/podcast/pi<podcastIndexFeedId>.
//   • Castamatic  — castamatic.com/guid/<podcastGuid>.
//   • Podverse    — Podverse uses opaque internal ids, but its API exposes a
//                   by-podcast-guid route that 302-redirects a browser to the
//                   real /podcast/<id> page, so we can link straight from guid.
// CurioCaster + Castamatic + Podverse work for every show (feed_id / guid
// always present); the others appear only when their id is available.
function subscribeLinks(item) {
  const { ep, show, boosts } = item
  const feedId = ep.feed_id || show?.feed_id || null
  const guid = ep.podcast_guid || null
  const itunes = show?.itunes_id || null
  const fountain = boosts.find((b) => typeof b.show_url === 'string' && /^https?:\/\/fountain\.fm\/show\//.test(b.show_url))?.show_url

  const out = []
  if (fountain) out.push({ label: 'Fountain', url: fountain })
  if (itunes)   out.push({ label: 'Podcast Guru', url: `https://app.podcastguru.io/podcast/${itunes}` })
  if (feedId)   out.push({ label: 'CurioCaster', url: `https://curiocaster.com/podcast/pi${feedId}` })
  if (guid)     out.push({ label: 'Castamatic', url: `https://castamatic.com/guid/${encodeURIComponent(guid)}` })
  if (guid)     out.push({ label: 'Podverse', url: `https://api.podverse.fm/api/v1/podcast/by-podcast-guid/${encodeURIComponent(guid)}` })
  return out
}

// ── "See all boosts" (Boost Me Bitch) link ───────────────────────────
// Boost Me Bitch (boostmebitch.com) restores a detail view from URL
// params: ?feed=<podcastIndexFeedId> (or ?podcast=<podcastGuid>) picks the
// show, +?episode=<episodeGuid> opens that episode — where episodeGuid is the
// RSS item guid, i.e. exactly our item_guid. So we can deep-link straight to
// the episode's page, which shows its full (whole-network) Nostr boost feed —
// a superset of the LB-community boosts in our own drawer. Prefer ?feed (a
// direct PI feed lookup) and fall back to the podcast guid. Episodes older
// than a show's latest ~50 aren't in BMB's feed list, so those gracefully
// land on the show instead of the exact episode.
function boostMeBitchLink(item) {
  const epGuid = item.guid
  if (!epGuid) return null
  const feedId = item.ep?.feed_id || item.show?.feed_id || null
  const guid = item.ep?.podcast_guid || item.show?.podcast_guid || null
  const p = new URLSearchParams()
  if (feedId) p.set('feed', String(feedId))
  else if (guid) p.set('podcast', guid)
  else return null
  p.set('episode', epGuid)
  return 'https://boostmebitch.com/?' + p.toString()
}

// ── Episode media helpers ────────────────────────────────────────────
// Podcast Index descriptions are HTML; strip to plain text for the 2-line
// teaser. DOMParser is inert (no script execution, no resource loading), so
// this is XSS-safe — unlike innerHTML.
function htmlToText(html) {
  if (!html) return ''
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html')
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  } catch { return '' }
}

function safeHttpUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null }
  catch { return null }
}

// Filled lightning bolt (Heroicons) — matches the boost buttons elsewhere on
// the site; renders white on the orange Boost button via fill:currentColor.
function boltSvg() {
  const s = h('span', { class: 'pcast-btn-bolt', 'aria-hidden': 'true' })
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clip-rule="evenodd"/></svg>'
  return s
}

// Download the episode audio. Same approach as our own episode pages: fetch
// the bytes and save via a Blob (a plain <a download> is ignored cross-origin
// when the CDN doesn't send Content-Disposition). External podcast CDNs often
// lack permissive CORS, so on any failure we fall back to opening the URL so
// the listener can still save it manually.
function downloadMp3Button(url, ep) {
  const base = (ep.title || 'episode').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'episode'
  const filename = base + '.mp3'
  const label = '↓ Download MP3'
  const dl = h('button', { class: 'pcast-btn pcast-btn-download', type: 'button' }, label)
  dl.addEventListener('click', async () => {
    dl.disabled = true; dl.textContent = 'Downloading…'
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('HTTP ' + resp.status)
      const blobUrl = URL.createObjectURL(await resp.blob())
      const a = document.createElement('a')
      a.href = blobUrl; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 200)
    } catch {
      window.open(url, '_blank', 'noopener')
    } finally {
      dl.textContent = label; dl.disabled = false
    }
  })
  return dl
}

// ── Boost wiring ─────────────────────────────────────────────────────
// The boost modal + payment live in the login-widget bundle (window.LBLogin).
// Lazy-load it on first boost click (mirrors episode-enhance.js's loader).
let widgetPromise = null
function ensureWidgetLoaded() {
  if (window.LBLogin) return Promise.resolve()
  if (widgetPromise) return widgetPromise
  widgetPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/assets/widgets/login-widget.js'
    s.async = true
    s.onload = () => Promise.resolve().then(resolve)
    s.onerror = () => { widgetPromise = null; reject(new Error('Failed to load boost widget')) }
    document.head.appendChild(s)
  })
  return widgetPromise
}

// After openExternalBoost, the widget's gate chain (session restore / wallet
// unlock) can run for several seconds on a cold widget before any modal shows.
// Wait for a modal to appear so the boost button can stay in its loading state
// until then, instead of reverting and looking like nothing happened.
function waitForModal(timeoutMs = 40000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (document.querySelector('[role="dialog"]')) return resolve('modal')
      if (Date.now() - t0 > timeoutMs) return resolve('timeout')
      setTimeout(tick, 200)
    }
    tick()
  })
}

// Boost click: resolve the episode's value block live from Podcast Index (via
// /api/value), apply the external overrides, then hand off to the widget's
// external-boost modal. No value block → a toast, no modal.
async function onBoostClick(item, btn) {
  const { ep, show } = item
  const feedId = ep.feed_id || show?.feed_id
  const guid = ep.item_guid || item.guid
  if (!feedId) { showToast('No feed id for this episode', true); return }

  const label = btn.querySelector('.pcast-boost-label')
  const prevLabel = label ? label.textContent : ''
  if (label) label.textContent = 'Loading…'
  btn.disabled = true
  try {
    const url = `${VALUE_API}?feedId=${encodeURIComponent(feedId)}` + (guid ? `&guid=${encodeURIComponent(guid)}` : '')
    let data = null
    try {
      const resp = await fetch(url, { headers: { Accept: 'application/json' } })
      // Distinguish a server/config error (e.g. the value proxy is down or the
      // PI keys aren't set) from a genuine "this episode has no value block" —
      // otherwise an outage looks like every episode is un-boostable.
      if (!resp.ok) { showToast('Couldn’t load boost splits — please try again in a moment.', true); return }
      data = await resp.json()
    } catch { showToast('Couldn’t load boost splits — please try again in a moment.', true); return }
    if (data && data.error) { showToast('Boost splits are unavailable right now.', true); return }
    const parsed = fromApiValue(data)
    if (!parsed) { showToast('This episode has no value block to boost.', true); return }

    const recipients = applyExternalOverrides(parsed.recipients)
    const totalWeight = recipients.reduce((a, r) => a + (r.splitWeight || 0), 0)
    if (!recipients.length || totalWeight <= 0) { showToast('This episode has no payable recipients.', true); return }

    await ensureWidgetLoaded()
    if (!window.LBLogin?.openExternalBoost) { showToast('Boost is unavailable right now.', true); return }
    window.LBLogin.openExternalBoost({
      episode: {
        showTitle: show?.title || '',
        episodeTitle: ep.title || '',
        podcastGuid: ep.podcast_guid || show?.podcast_guid || '',
        itemGuid: guid || '',
        bmbUrl: boostMeBitchLink(item) || '',
      },
      recipientsBundle: { recipients, totalWeight },
    })
    // Hold the loading state until a modal (boost / login / wallet) opens.
    if (label) label.textContent = 'Opening…'
    await waitForModal()
  } catch (e) {
    console.warn('[podcasts] boost failed', e)
    showToast('Couldn’t start the boost — try again.', true)
  } finally {
    btn.disabled = false
    if (label) label.textContent = prevLabel
  }
}

// ── Card ─────────────────────────────────────────────────────────────
// Card head: episode art, show name, the episode TITLE as a link out to the
// Fountain episode, a booster/when/sats meta row, and a ⋮ menu (top-right)
// of show-level subscribe links. A low-profile drawer bar under the head
// toggles the inline boost thread, which is built lazily on first open and
// carries its own "hide" control so a long thread is easy to close without
// scrolling back up.
let cardUid = 0
function episodeCard(item) {
  const { ep, show, boosts, distinctBoosters, totalSats, latest } = item
  const detailsId = 'pcast-d-' + (++cardUid)

  const media = isSafeImg(ep.image)
    ? h('div', { class: 'pcast-card-media' }, h('img', { src: ep.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))
    : h('div', { class: 'pcast-card-media pcast-card-media--none' }, '🎙')

  // Booster faces, total sats, and recency of the latest boost all live on the
  // drawer bar (next to "N community boosts"), so the head stays clean.
  const avatars = h('span', { class: 'pcast-avatars' },
    distinctBoosters.slice(0, MAX_AVATARS).map((b) =>
      avatarEl(profileFor(b.booster_pubkey), b.booster_npub, { size: 22 })))

  const bmbUrl = boostMeBitchLink(item)

  // A Fountain episode URL, when we have one (present on ~98% of episodes).
  const link = episodeLink(boosts, show)
  const fountainUrl = link && link.episode ? link.url : null

  // Title links to the episode's Boost Me Bitch page (its full boost feed);
  // plain text if we can't build that link.
  const titleText = ep.title || 'Untitled episode'
  const titleEl = bmbUrl
    ? h('a', { class: 'pcast-title pcast-title-link', href: bmbUrl, target: '_blank', rel: 'noopener noreferrer', title: 'See all boosts on Boost Me Bitch' }, titleText)
    : h('div', { class: 'pcast-title', text: titleText })

  // Shownotes teaser: first ~2 lines of the description, with a link out to the
  // full description on the episode's Boost Me Bitch page.
  const descText = htmlToText(ep.description)
  const descP = descText ? h('p', { class: 'pcast-desc', text: descText }) : null

  // Links row under the description: "See full description →" (BMB page) and a
  // compact "Listen on Fountain" link, tucked together instead of a big pill in
  // the corner.
  const linksRow = (bmbUrl || fountainUrl)
    ? h('div', { class: 'pcast-links' }, [
        bmbUrl
          ? h('a', { class: 'pcast-desc-more', href: bmbUrl, target: '_blank', rel: 'noopener noreferrer' }, 'See full description →')
          : null,
        fountainUrl
          ? h('a', { class: 'pcast-fountain-link', href: fountainUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Listen on Fountain' }, 'Listen on Fountain ↗')
          : null,
      ])
    : null

  const body = h('div', { class: 'pcast-card-body' }, [
    show?.title ? h('div', { class: 'pcast-show', text: show.title }) : null,
    titleEl,
    descP,
    linksRow,
  ])

  // Top-right cluster: just the ⋮ subscribe menu with the episode air date beneath.
  const actionsCol = h('div', { class: 'pcast-card-actions-col' }, [
    subscribeMenu(item),
    ep.published ? h('div', { class: 'pcast-card-aired', title: 'Episode aired' }, fullDate(ep.published)) : null,
  ])
  const head = h('div', { class: 'pcast-card-head' }, [media, body, actionsCol])

  // Inline audio player (native controls, no preload until played).
  const audioUrl = safeHttpUrl(ep.enclosure_url)
  let player = null
  if (audioUrl) {
    const a = h('audio', { class: 'pcast-player', controls: 'controls', preload: 'none' })
    if (ep.enclosure_type) a.appendChild(h('source', { src: audioUrl, type: ep.enclosure_type }))
    else a.src = audioUrl
    player = h('div', { class: 'pcast-player-row' }, a)
  }

  // Action buttons: Boost (opens the external-boost modal) + Download MP3.
  const boostBtn = h('button', {
    class: 'pcast-btn pcast-btn-boost', type: 'button',
    onclick: (e) => onBoostClick(item, e.currentTarget),
  }, [boltSvg(), h('span', { class: 'pcast-boost-label' }, 'Boost episode')])
  const buttons = h('div', { class: 'pcast-card-buttons' }, [
    boostBtn,
    audioUrl ? downloadMp3Button(audioUrl, ep) : null,
  ])

  const details = h('div', { class: 'pcast-details', id: detailsId, hidden: 'hidden' })
  let built = false
  function toggle() {
    const open = drawer.getAttribute('aria-expanded') === 'true'
    if (open) {
      drawer.setAttribute('aria-expanded', 'false')
      details.hidden = true
      card.classList.remove('is-open')
    } else {
      if (!built) { built = true; buildDetails(details, boosts, toggle, () => card, bmbUrl) }
      drawer.setAttribute('aria-expanded', 'true')
      details.hidden = false
      card.classList.add('is-open')
    }
  }

  const nBoosts = boosts.length
  const drawerMeta = h('span', { class: 'pcast-drawer-meta' }, [
    avatars,
    totalSats > 0 ? h('span', { class: 'pcast-sats' }, [`${fmtSats(totalSats)} `, h('span', { class: 'pcast-bolt', 'aria-hidden': 'true', text: '⚡' })]) : null,
    h('span', { class: 'pcast-when', title: 'Most recent community boost', text: relTime(latest) }),
  ])
  const drawer = h('button', {
    class: 'pcast-drawer', type: 'button',
    'aria-expanded': 'false', 'aria-controls': detailsId, onclick: toggle,
  }, [
    h('span', { class: 'pcast-drawer-caret', 'aria-hidden': 'true', text: '▾' }),
    h('span', { class: 'pcast-drawer-label', text: `${nBoosts} community boost${nBoosts === 1 ? '' : 's'}` }),
    drawerMeta,
  ])

  const card = h('div', { class: 'pcast-card' }, [head, player, buttons, drawer, details])
  return card
}

// Populate a card's boost thread: every boost (no truncation — hiding
// comments implied some weren't worth showing), then a bottom "hide" that
// collapses the drawer and brings the card head back into view so a long
// thread is easy to close without scrolling all the way back up.
function buildDetails(details, boosts, toggle, getCard, bmbUrl) {
  for (const b of boosts) details.appendChild(boostRow(b))
  const hide = h('button', {
    class: 'pcast-drawer-close', type: 'button',
    onclick: () => { toggle(); try { getCard().scrollIntoView({ block: 'nearest' }) } catch {} },
  }, [h('span', { class: 'pcast-drawer-caret', 'aria-hidden': 'true', text: '▴' }), 'Hide boosts'])
  const seeAll = bmbUrl
    ? h('a', {
        class: 'pcast-seeall', href: bmbUrl, target: '_blank', rel: 'noopener noreferrer',
        title: 'Open this episode on Boost Me Bitch',
      }, ['See all boosts', h('span', { 'aria-hidden': 'true', text: ' ↗' })])
    : null
  details.appendChild(h('div', { class: 'pcast-details-foot' }, [seeAll, hide]))
}

// Subscribe (⋮) menu on the card head — show-level app links.
function subscribeMenu(item) {
  const links = subscribeLinks(item)
  if (!links.length) return null

  const wrap = h('div', { class: 'pcast-cardmenu' })
  const btn = h('button', {
    class: 'pcast-cardmenu-btn', type: 'button',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
    'aria-label': 'Subscribe to this show', title: 'Subscribe',
  }, '⋮')

  const menu = h('div', { class: 'pcast-cardmenu-menu', hidden: 'hidden' }, [
    h('div', { class: 'pcast-cardmenu-label', text: 'Follow this show on' }),
    ...links.map((l) => h('a', {
      class: 'pcast-cardmenu-item', href: l.url, target: '_blank', rel: 'noopener noreferrer',
      onclick: () => close(),
    }, l.label)),
  ])
  wrap.append(btn, menu)

  function onDoc(e) { if (!wrap.contains(e.target)) close() }
  function onKey(e) { if (e.key === 'Escape') close() }
  function open() {
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onDoc, true)
    document.addEventListener('keydown', onKey)
  }
  function close() {
    menu.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDoc, true)
    document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', () => { menu.hidden ? open() : close() })
  return wrap
}

function boostRow(b) {
  const profile = profileFor(b.booster_pubkey)
  const name = profile?.name?.trim() || (b.booster_npub ? b.booster_npub.slice(0, 12) + '…' : 'anon')

  const nameEl = h('button', {
    class: 'pcast-boost-name', type: 'button', title: 'Copy npub',
    onclick: () => copyNpub(b.booster_npub),
  }, name)

  const satsEl = (b.sats != null)
    ? h('span', { class: 'pcast-boost-sats' }, [`${fmtSats(b.sats)} `, h('span', { class: 'pcast-bolt', 'aria-hidden': 'true', text: '⚡' })])
    : null

  const head = h('div', { class: 'pcast-boost-head' }, [
    avatarEl(profile, b.booster_npub, { size: 34, interactive: true }),
    h('div', { class: 'pcast-boost-who' }, [
      nameEl,
      h('span', { class: 'pcast-boost-when', text: fullDate(b.created_at) }),
    ]),
    satsEl,
    moreMenu(b),
  ])

  const parts = [head]
  const msg = (b.message || '').trim()
  if (msg) {
    const msgEl = h('div', { class: 'pcast-boost-msg' })
    // Reuse the boost-thread tokenizer: nostr: mentions → chips, URLs →
    // links, everything else plain text nodes. inEmbed keeps a quoted note
    // as a chip instead of triggering an embed fetch.
    renderSegmentsInto(msgEl, parseSegments(msg), { inEmbed: true })
    parts.push(msgEl)
  }
  const row = h('div', { class: 'pcast-boost' }, parts)

  // Reuse the shared boosts-page action bar (Reply / Repost / Like / Zap). The
  // boost IS a kind-1 note, so id + pubkey is all these actions need.
  if (b.event_id && b.booster_pubkey) {
    const ev = { id: b.event_id, pubkey: b.booster_pubkey, kind: 1, content: b.message || '', created_at: b.created_at, tags: [] }
    try { row.appendChild(buildActionBar(ev, row)) } catch (e) { console.warn('[podcasts] action bar failed', e) }
  }
  return row
}

// Per-boost overflow (⋮) menu — its one item copies the boost note's nevent.
function moreMenu(b) {
  const wrap = h('div', { class: 'pcast-more' })
  const btn = h('button', {
    class: 'pcast-more-btn', type: 'button', 'aria-label': 'More options',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
  }, '⋮')
  const menu = h('div', { class: 'pcast-more-menu', hidden: 'hidden' }, [
    h('button', {
      class: 'pcast-more-item', type: 'button',
      onclick: () => { close(); copyNevent(b.event_id, b.booster_pubkey) },
    }, 'Copy nevent'),
  ])
  wrap.append(btn, menu)

  function onDoc(e) { if (!wrap.contains(e.target)) close() }
  function onKey(e) { if (e.key === 'Escape') close() }
  function open() {
    menu.hidden = false
    btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onDoc, true)
    document.addEventListener('keydown', onKey)
  }
  function close() {
    menu.hidden = true
    btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDoc, true)
    document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    menu.hidden ? open() : close()
  })
  return wrap
}

// ── Profiles ─────────────────────────────────────────────────────────
// Booster kind-0s aren't in the snapshot; fetch them once (only ~50 distinct
// boosters) and stash in a module map the card/modal renderers read.
const profiles = new Map()
function profileFor(pubkey) { return profiles.get(pubkey) || null }

// nostr: mentions inside a boost message (npub / nprofile). Matches how
// boosts-thread parses them — bare npubs without the scheme aren't linked
// there either, so we keep parity.
const MENTION_RE = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)/gi

function mentionPubkeys(text) {
  const out = []
  for (const m of (text || '').matchAll(MENTION_RE)) {
    try {
      const d = nip19.decode(m[1])
      if (d.type === 'npub') out.push(d.data)
      else if (d.type === 'nprofile') out.push(d.data.pubkey)
    } catch {}
  }
  return out
}

const PROFILE_CHUNK = 80  // Primal user_infos drops results on large batches

async function fetchProfilesInto(pubkeys) {
  for (let i = 0; i < pubkeys.length; i += PROFILE_CHUNK) {
    try {
      const got = await fetchProfilesFromPrimal(pubkeys.slice(i, i + PROFILE_CHUNK))
      for (const [pk, prof] of got) {
        profiles.set(pk, prof)
        setCachedProfile(pk, prof)  // also feed the tokenizer's mention cache
      }
    } catch { /* leave this chunk unresolved; it degrades to npub + initials */ }
  }
}

// Two phases, deliberately separate: boosters drive the visible card avatars
// and row names, so resolve them first and let the caller repaint on that.
// Message-mention profiles (for @DisplayName inside boost text) are a larger,
// lower-priority set fetched after — kept in their own requests so they can't
// crowd boosters out of a single response.
async function loadBoosterProfiles(items) {
  const pks = new Set()
  for (const it of items) for (const b of it.boosts) if (b.booster_pubkey) pks.add(b.booster_pubkey)
  await fetchProfilesInto([...pks])
}

async function loadMentionProfiles(items) {
  const pks = new Set()
  for (const it of items) for (const b of it.boosts) for (const pk of mentionPubkeys(b.message)) pks.add(pk)
  await fetchProfilesInto([...pks].filter((pk) => !profiles.has(pk)))
}

// ── Sorting ──────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  ['recent', 'Latest boost'],
  ['episode', 'Latest episode'],
  ['count', 'Most boosts'],
  ['sats', 'Most sats'],
]
// Every comparator falls back to most-recent-boost so ties are stable.
const SORTERS = {
  recent: (a, b) => b.latest - a.latest,
  episode: (a, b) => (b.ep.published || 0) - (a.ep.published || 0) || b.latest - a.latest,
  count: (a, b) => b.boosts.length - a.boosts.length || b.latest - a.latest,
  sats: (a, b) => b.totalSats - a.totalSats || b.latest - a.latest,
}
function sortItems(items, key) {
  return [...items].sort(SORTERS[key] || SORTERS.recent)
}

// "Sort: X ▾" dropdown for the panel head — matches the card ⋮ menus
// (outside-click / Escape to close). Calls onPick(key) on selection.
function sortControl(initialKey, onPick) {
  const labelFor = (k) => (SORT_OPTIONS.find((o) => o[0] === k) || SORT_OPTIONS[0])[1]
  const wrap = h('div', { class: 'pcast-sort' })
  const curEl = h('span', { class: 'pcast-sort-cur', text: labelFor(initialKey) })
  const btn = h('button', {
    class: 'pcast-sort-btn', type: 'button',
    'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'Sort episodes',
  }, [h('span', { class: 'pcast-sort-tag', text: 'Sort: ' }), curEl, h('span', { class: 'pcast-sort-caret', 'aria-hidden': 'true', text: '▾' })])

  let activeKey = initialKey
  const items = SORT_OPTIONS.map(([k, label]) =>
    h('button', {
      class: 'pcast-sort-item', type: 'button',
      onclick: () => { activeKey = k; curEl.textContent = label; close(); onPick(k) },
    }, label))
  const menu = h('div', { class: 'pcast-sort-menu', hidden: 'hidden' }, items)
  wrap.append(btn, menu)

  function refreshActive() {
    items.forEach((el, i) => el.classList.toggle('is-active', SORT_OPTIONS[i][0] === activeKey))
  }
  function onDoc(e) { if (!wrap.contains(e.target)) close() }
  function onKey(e) { if (e.key === 'Escape') close() }
  function open() {
    refreshActive()
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true')
    document.addEventListener('click', onDoc, true); document.addEventListener('keydown', onKey)
  }
  function close() {
    menu.hidden = true; btn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', onDoc, true); document.removeEventListener('keydown', onKey)
  }
  btn.addEventListener('click', () => { menu.hidden ? open() : close() })
  return wrap
}

// Put the sort dropdown in the panel head (replacing the episode-count pill).
function mountSortControl(panel, initialKey, onPick) {
  const head = panel.querySelector('.feed-panel-head')
  if (!head) return
  const count = head.querySelector('.feed-count')
  if (count) count.hidden = true
  const existing = head.querySelector('.pcast-sort')
  if (existing) existing.remove()
  head.appendChild(sortControl(initialKey, onPick))
}

// ── Entry point ──────────────────────────────────────────────────────
export async function renderPodcasts({ panel, list }) {
  let data
  try {
    const resp = await fetch(API_URL, { headers: { Accept: 'application/json' } })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    data = await resp.json()
  } catch (e) {
    console.error('[podcasts] fetch failed', e)
    renderPlaceholder(list, 'Couldn’t load podcast boosts', 'The community boosts feed is unavailable right now — please try again later.')
    return
  }

  const items = buildEpisodes(data)
  if (!items.length) {
    renderPlaceholder(list, 'No boosted episodes yet', 'When the community boosts a podcast episode on Nostr, it’ll show up here.')
    return
  }

  // Pre-warm the boost widget in the background once the feed is up, so the
  // first Boost click doesn't pay the cold-start cost (bundle load + session /
  // wallet restore). Deferred so it doesn't compete with first paint.
  setTimeout(() => {
    ensureWidgetLoaded()
      // Wire the shared reply/repost/like/zap actions once the widget (window.
      // LBLogin) is up, so boost-comment action bars work and hydrate the
      // user's existing likes/reposts.
      .then(() => { try { configureBoostActions({}) } catch {} })
      .catch(() => {})
  }, 1200)

  // Names/avatars enrich the cards but shouldn't gate first paint — render
  // immediately with initials, repaint once booster profiles resolve, and
  // resolve message-mention profiles in the background for opened threads.
  const profilesReady = loadBoosterProfiles(items)
  loadMentionProfiles(items)

  let sortKey = 'recent'
  let sorted = sortItems(items, sortKey)
  let shown = 0
  const cards = h('div', { class: 'pcast-list' })
  const moreWrap = h('div', { class: 'pcast-more-wrap' })

  function renderMore() {
    const next = sorted.slice(shown, shown + INITIAL_CARDS)
    for (const it of next) {
      const el = episodeCard(it)
      el._pcastItem = it   // lets repaintProfiles map avatars regardless of sort order
      cards.appendChild(el)
    }
    shown += next.length
    moreWrap.innerHTML = ''
    const remaining = sorted.length - shown
    if (remaining > 0) {
      const batch = Math.min(INITIAL_CARDS, remaining)
      moreWrap.appendChild(h('div', { class: 'pcast-more-group' }, [
        h('button', {
          class: 'pcast-showmore', type: 'button', onclick: renderMore,
        }, `Load ${batch} more episode${batch === 1 ? '' : 's'}`),
        h('div', { class: 'pcast-more-count', text: `Showing ${shown} of ${sorted.length}` }),
      ]))
    }
  }

  function applySort(key) {
    if (key === sortKey) return
    sortKey = key
    sorted = sortItems(items, key)
    shown = 0
    cards.innerHTML = ''
    renderMore()
  }

  mountSortControl(panel, sortKey, applySort)

  list.className = ''
  list.innerHTML = ''
  list.append(cards, moreWrap)
  renderMore()

  // Repaint avatars/names in place once profiles land. repaintProfiles reads
  // each card's _pcastItem, so it's correct even after a re-sort rebuilds the
  // list into a different order.
  profilesReady.then(() => repaintProfiles(cards))
}

// Swap decorative card avatars in place after profiles resolve, so we don't
// tear down and rebuild the whole list. Modal rows read profileFor() live, so
// they're already correct whenever a card is opened after this runs.
function repaintProfiles(cards) {
  cards.querySelectorAll('.pcast-card').forEach((cardEl) => {
    const it = cardEl._pcastItem
    if (!it) return
    const holder = cardEl.querySelector('.pcast-avatars')
    if (!holder) return
    holder.innerHTML = ''
    for (const b of it.distinctBoosters.slice(0, MAX_AVATARS)) {
      holder.appendChild(avatarEl(profileFor(b.booster_pubkey), b.booster_npub, { size: 22 }))
    }
  })
}
