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
 * Ordering: episodes are ranked by how many distinct people boosted them,
 * with total sats as the tiebreaker, and scoped by default to episodes that
 * aired in the last week — so the feed reads as "what the community is
 * boosting right now." Both are user-switchable in the panel head.
 *
 * Entry point: renderPodcasts({ panel, list }) — lazy-imported by feeds.js
 * the first time the tab is opened.
 */
import { nip19 } from '/assets/widgets/nostr-tools.js'
import {
  ready as obReady, hasBoosterPage, boosterUrl, wrapWithDot,
} from '/assets/js/onlyboosts.js'
import {
  fetchProfilesFromPrimal,
  setCachedProfile,
  parseSegments,
  renderSegmentsInto,
} from '/assets/js/boosts-thread.js'
import { fromApiValue, applyExternalOverrides } from '/assets/js/value-block.js'
import { buildActionBar, configureBoostActions } from '/assets/js/boost-actions.js'
import { ensureLoginWidget } from '/assets/js/widget-loader.js'
import {
  episodeCoord,
  isEpisodeCoord,
  guidFromCoord,
  fetchFeaturedEpisodeSet,
  fetchEpisodeFromOnlyBoosts,
  fetchShowByPodcastGuid,
  searchShows,
  listEpisodes,
  readConfirmedFeaturedEpisodes,
  addConfirmedFeaturedEpisode,
  readPendingPromote,
  clearPendingPromote,
  featureEpisode,
} from '/assets/js/featured-podcasts.js'
import {
  FEATURED_DEFAULT_RANGE,
  inFeaturedRange,
  featuredHead,
  featuredEmptyEl,
  featuredMoreButton,
  featuredByEl,
  currentBooster,
  FEATURE_BOLT_SVG,
} from '/assets/js/featured-shared.js'

const API_URL = '/api/community-boosts'
const VALUE_API = '/api/value'   // Podcast Index value-block proxy (splits)
const INITIAL_CARDS = 30       // episodes rendered per "load more" batch

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

// A booster avatar. `interactive` wires click/keyboard to open the booster's
// OnlyBoosts page, or to copy their npub when they have no page there.
// Avatars load eagerly (they're tiny, and `loading=lazy` left off-screen
// ones perpetually unloaded → looked broken); a picture that fails to load
// (dead host, hotlink block) swaps to the initials chip via onerror.
//
// ⚠️ The avatar node here is often a bare <img>, which cannot hold the booster
// dot as a child, so a booster's avatar comes back wrapped in a span. Callers
// must treat the return value as opaque and not assume it carries .pcast-avatar
// — read the class off the inner node if you ever need it.
function avatarEl(profile, npub, { size = 26, interactive = false, cls = '' } = {}) {
  const style = `--pcast-av:${size}px`
  const makeInitials = () => wire(h('span', { class: 'pcast-avatar pcast-avatar--none ' + cls, style }, initials(profile, npub)))
  const linked = !!npub && hasBoosterPage(npub)

  function wire(n) {
    if (interactive && npub) {
      n.classList.add('is-interactive')
      n.setAttribute('role', 'button')
      n.setAttribute('tabindex', '0')
      if (linked) {
        const url = boosterUrl(npub)
        const who = profile?.name?.trim() || 'this booster'
        n.setAttribute('title', 'View ' + who + ' on OnlyBoosts')
        n.setAttribute('aria-label', 'View ' + who + ' on OnlyBoosts')
        const open = (e) => { e.stopPropagation(); window.open(url, '_blank', 'noopener') }
        n.addEventListener('click', open)
        n.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e) }
        })
      } else {
        n.setAttribute('title', 'Copy npub')
        n.addEventListener('click', (e) => { e.stopPropagation(); copyNpub(npub) })
        n.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); copyNpub(npub) }
        })
      }
    }
    return n
  }

  // The dot goes on whatever node ends up interactive, so it tracks the avatar
  // through the onerror swap below rather than being stranded on a dead <img>.
  const dotted = (n) => (interactive && linked ? wrapWithDot(n) : n)

  const pic = profile?.picture
  if (pic && isSafeImg(pic)) {
    const img = h('img', { class: 'pcast-avatar ' + cls, style, src: pic, alt: '', referrerpolicy: 'no-referrer' })
    img.addEventListener('error', () => { img.replaceWith(makeInitials()) }, { once: true })
    return dotted(wire(img))
  }
  return dotted(makeInitials())
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

// Data-only loader for the homepage teaser (home-feeds.js). Fetches the same
// snapshot renderPodcasts() uses and returns the built, most-recent-first
// episode list — no rendering, no profile lookup. Mirrors the
// loadMarketItems / renderMarket split in feeds-market.js so the teaser and
// the full tab share one source of truth. Each item:
//   { guid, ep, show, boosts, distinctBoosters, latest, totalSats }
export async function loadPodcastItems() {
  const resp = await fetch(API_URL, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error('community-boosts ' + resp.status)
  const data = await resp.json()
  return buildEpisodes(data)
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
// The boost modal + payment live in the login-widget bundle (window.LBLogin),
// lazy-loaded on first boost click. The loader is shared with every other
// trigger on the page — this one awaits /api/value first, so a nav Boost
// click can easily land mid-flight and would otherwise pull the 1MB bundle
// a second time. See widget-loader.js.
const ensureWidgetLoaded = ensureLoginWidget

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
// A backfilled featured episode (from OnlyBoosts' index) knows its podcast
// guid but not its Podcast Index feed id, which the value-block proxy needs.
// Resolve it once, on demand, and remember it on the item.
async function ensureFeedId(item) {
  const { ep, show } = item
  let feedId = ep.feed_id || show?.feed_id || null
  if (feedId) return feedId
  const pguid = ep.podcast_guid || show?.podcast_guid || null
  if (!pguid) return null
  const found = await fetchShowByPodcastGuid(pguid)
  if (found && found.feed_id) {
    feedId = found.feed_id
    ep.feed_id = feedId
    if (show) { show.feed_id = feedId; if (!show.itunes_id) show.itunes_id = found.itunes_id || null }
  }
  return feedId
}

async function onBoostClick(item, btn) {
  const { ep, show } = item
  const guid = ep.item_guid || item.guid
  const feedId = await ensureFeedId(item)
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
// ── Featured affordances ─────────────────────────────────────────────
// Featured Episodes: an episode is featured when someone boosts the show with
// its OnlyBoosts URL in the message (see featured-podcasts.js). The Feature
// button opens that boost prefilled; the boost also pays the podcast's own
// value block the show's reassignable split leg.
const FEATURED_INITIAL = 5

async function onFeatureClick(item, btn) {
  const { ep, show } = item
  const guid = ep.item_guid || item.guid
  btn.disabled = true
  try {
    const feedId = await ensureFeedId(item)
    await featureEpisode(
      { guid, feedId, showTitle: show?.title || '', extra: item.backfilled ? { episode: ep, show } : null },
      (msg) => showToast(msg, true),
    )
  } catch (e) {
    console.warn('[podcasts] feature failed', e)
    showToast('Couldn’t start the boost — try again.', true)
  } finally {
    btn.disabled = false
  }
}

function featureButton(item) {
  const btn = h('button', {
    class: 'pcast-btn pcast-btn-feature', type: 'button',
    title: 'Feature — boost this episode into the Featured section',
    onclick: (e) => onFeatureClick(item, e.currentTarget),
  })
  btn.innerHTML = FEATURE_BOLT_SVG + '<span>Feature</span>'
  return btn
}

function npubOf(pk) {
  try { return nip19.npubEncode(pk) } catch { return '' }
}

function boosterName(pk) {
  const p = profileFor(pk)
  if (p && p.name && p.name.trim()) return p.name.trim()
  const npub = npubOf(pk)
  return npub ? npub.slice(0, 12) + '…' : 'someone'
}

function featuredCredit(info) {
  return featuredByEl(info, {
    avatar: (pk) => avatarEl(profileFor(pk), npubOf(pk), { size: 18 }),
    name: boosterName,
    link: (pk) => (hasBoosterPage(pk) ? boosterUrl(pk) : null),
    onCopy: (pk) => copyNpub(npubOf(pk)),
  })
}

// An episode the snapshot doesn't hold (featured from outside the community's
// boosts) as a feed item with no local boosts: the card renders its head,
// player and buttons, and skips the boost drawer.
function itemFromRecords(ep, show) {
  if (!ep || !ep.item_guid) return null
  return {
    guid: ep.item_guid,
    ep,
    show: show || null,
    boosts: [],
    distinctBoosters: [],
    latest: 0,
    totalSats: 0,
    backfilled: true,
  }
}

let cardUid = 0
function episodeCard(item, { featured = false, info = null } = {}) {
  const { ep, show, boosts, distinctBoosters, totalSats, latest } = item
  const detailsId = 'pcast-d-' + (++cardUid)

  const bmbUrl = boostMeBitchLink(item)

  // Episode art — links to the episode's Boost Me Bitch page (its full boost
  // feed), the same target as the episode title and show name below.
  const mediaImg = isSafeImg(ep.image)
    ? h('img', { src: ep.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : null
  const mediaClass = 'pcast-card-media' + (mediaImg ? '' : ' pcast-card-media--none')
  const media = bmbUrl
    ? h('a', { class: mediaClass, href: bmbUrl, target: '_blank', rel: 'noopener noreferrer', title: 'See all boosts on Boost Me Bitch' }, mediaImg || '🎙')
    : h('div', { class: mediaClass }, mediaImg || '🎙')

  // Booster faces on the drawer bar — every distinct booster, stacked.
  const avatars = h('span', { class: 'pcast-avatars' },
    distinctBoosters.map((b) =>
      avatarEl(profileFor(b.booster_pubkey), b.booster_npub, { size: 22 })))

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

  // A compact "Listen on Fountain" link under the description. (The old "See
  // full description →" link was dropped — the art, show name, and title all
  // link to the Boost Me Bitch page now.)
  const linksRow = fountainUrl
    ? h('div', { class: 'pcast-links' }, [
        h('a', { class: 'pcast-fountain-link', href: fountainUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Listen on Fountain' }, 'Listen on Fountain ↗'),
      ])
    : null

  // Show name — links to the Boost Me Bitch page like the art + title.
  const showEl = show?.title
    ? (bmbUrl
        ? h('a', { class: 'pcast-show pcast-show-link', href: bmbUrl, target: '_blank', rel: 'noopener noreferrer', title: 'See all boosts on Boost Me Bitch' }, show.title)
        : h('div', { class: 'pcast-show', text: show.title }))
    : null

  const body = h('div', { class: 'pcast-card-body' }, [
    showEl,
    titleEl,
    descP,
    linksRow,
  ])

  // Media column: episode art with the air date tucked directly beneath it —
  // keeps the date off the body's right edge so the ⋮ menu can hug the corner
  // and the body reclaims the width.
  const mediaCol = h('div', { class: 'pcast-media-col' }, [
    media,
    ep.published ? h('div', { class: 'pcast-card-aired', title: 'Episode aired' }, fullDate(ep.published)) : null,
  ])
  const head = h('div', { class: 'pcast-card-head' }, [mediaCol, body, subscribeMenu(item)])

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
  // An already-featured card drops the Feature button — it only means "get
  // this into Featured" — and credits whoever paid for it in the same row.
  const buttons = h('div', { class: 'pcast-card-buttons' }, [
    boostBtn,
    audioUrl ? downloadMp3Button(audioUrl, ep) : null,
    featured ? featuredCredit(info) : featureButton(item),
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

  // Label the drawer by distinct boosters (matching the faces beside it), and
  // append the raw boost total only when it differs — on ~84% of episodes the
  // two are equal, so always showing it would just echo the same number.
  // Both halves say "local": these counts cover only the LB community's boosts,
  // not the episode's total, and the card links out to Boost Me Bitch's full
  // feed — so an unqualified "11 boosts" here would read as that superset.
  const nBoosters = distinctBoosters.length
  const nBoosts = boosts.length
  const drawerLabel = `${nBoosters} local booster${nBoosters === 1 ? '' : 's'}`
    + (nBoosts !== nBoosters ? ` · ${nBoosts} local boosts` : '')
  const drawerMeta = h('span', { class: 'pcast-drawer-meta' }, [
    avatars,
    totalSats > 0 ? h('span', { class: 'pcast-sats' }, [`${fmtSats(totalSats)} `, h('span', { class: 'pcast-bolt', 'aria-hidden': 'true', text: '⚡' })]) : null,
  ])
  const drawer = h('button', {
    class: 'pcast-drawer', type: 'button',
    'aria-expanded': 'false', 'aria-controls': detailsId, onclick: toggle,
  }, [
    h('span', { class: 'pcast-drawer-caret', 'aria-hidden': 'true', text: '▾' }),
    h('span', { class: 'pcast-drawer-label', text: drawerLabel }),
    drawerMeta,
  ])

  // A backfilled episode has no local boosts to open, so no drawer.
  const hasBoosts = boosts.length > 0
  const card = h('div', { class: 'pcast-card' + (featured ? ' pcast-card--featured' : '') },
    hasBoosts ? [head, player, buttons, drawer, details] : [head, player, buttons])
  card._pcastItem = item
  return card
}

// ── Featured section ─────────────────────────────────────────────────
// The gold box, same chrome as Featured Articles: 1W/1M/All over when an
// episode was featured, inside the border. `visible` is filled with the guids
// rendered so the feed can drop them; an episode in the box must never also
// appear below it.
function featuredEntries(state, byGuid) {
  const out = []
  for (const [coord, info] of state.featured) {
    const item = byGuid.get(guidFromCoord(coord))
    if (item) out.push({ item, info })
  }
  out.sort((x, y) => (y.info.featuredAt || 0) - (x.info.featuredAt || 0))
  return out
}

function buildFeaturedSection(state, byGuid, visible, onChange) {
  const entries = featuredEntries(state, byGuid)
  const inRange = entries.filter((e) => inFeaturedRange(e.info, state.range))
  for (const e of inRange) visible.add(e.item.guid)

  const head = featuredHead({
    title: 'Featured Episodes',
    count: inRange.length,
    range: state.range,
    noun: 'episodes',
    onRange: (key) => { state.range = key; state.featShown = FEATURED_INITIAL; onChange() },
    findLabel: 'Find an Episode to Feature',
    onFind: () => openFindModal(onChange),
  })

  const section = h('section', { class: 'feat-box', 'aria-label': 'Featured episodes' }, [head])
  const shown = inRange.slice(0, state.featShown)
  if (shown.length) {
    const body = h('div', { class: 'feat-list' })
    for (const { item, info } of shown) body.appendChild(episodeCard(item, { featured: true, info }))
    section.appendChild(body)
    const rest = inRange.length - shown.length
    if (rest > 0) {
      section.appendChild(featuredMoreButton(rest, FEATURED_INITIAL, () => { state.featShown += FEATURED_INITIAL; onChange() }))
    }
  } else if (state.featuredLoading) {
    section.appendChild(h('div', { class: 'feat-list' }, h('div', { class: 'feed-skeleton' })))
  } else {
    section.appendChild(featuredEmptyEl(state.range, entries.length > 0, { noun: 'episodes', verb: 'boost an episode to feature it here' }))
  }
  return section
}

// ── "Find an Episode to Feature" modal ───────────────────────────────
// A Podcast Index search: type a show, pick it, pick one of its recent
// episodes. Every episode PI knows is featurable, not only ones the community
// has already boosted. Same modal chrome as the other tabs' Find modals.
let findModal = null

function buildFindModal() {
  const input = h('input', {
    class: 'ffind-input', type: 'search', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Search podcasts by name',
    'aria-label': 'Podcast name',
  })
  const status = h('p', { class: 'ffind-status', role: 'status', 'aria-live': 'polite' })
  const result = h('div', { class: 'ffind-result' })
  const lookup = h('button', { class: 'ffind-go', type: 'button' }, 'Search')
  const card = h('div', { class: 'event-composer-card', role: 'document' }, [
    h('button', { class: 'event-composer-close', type: 'button', 'aria-label': 'Close' }, '×'),
    h('h2', { class: 'event-composer-title', id: 'pfm-title', text: 'Find an Episode to Feature' }),
    h('p', { class: 'ffind-help' },
      'Search Podcast Index for a show, then pick the episode. Featuring it boosts Local Bitcoiners and sends a share to that podcast’s own value splits.'),
    h('div', { class: 'ffind-row' }, [input, lookup]),
    status,
    result,
  ])
  const backdrop = h('div', {
    class: 'event-composer-backdrop ffind-backdrop', role: 'dialog',
    'aria-modal': 'true', 'aria-labelledby': 'pfm-title', hidden: 'hidden',
  }, card)
  return { backdrop, card, input, status, result, lookup, close: card.firstChild }
}

function openFindModal(onFeatured) {
  if (!findModal) {
    findModal = buildFindModal()
    document.body.appendChild(findModal.backdrop)
    const close = () => {
      findModal.backdrop.hidden = true
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    findModal.onKey = onKey
    findModal.closeFn = close
    findModal.close.addEventListener('click', close)
    findModal.backdrop.addEventListener('click', (e) => { if (e.target === findModal.backdrop) close() })
    findModal.lookup.addEventListener('click', () => runSearch(findModal))
    findModal.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(findModal) }
    })
  }
  findModal.onFeatured = onFeatured
  findModal.status.textContent = ''
  findModal.result.innerHTML = ''
  findModal.input.value = ''
  findModal.backdrop.hidden = false
  document.addEventListener('keydown', findModal.onKey)
  findModal.input.focus()
}

function artEl(url, fallback) {
  return h('div', { class: 'ffind-row-media' },
    isSafeImg(url) ? h('img', { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : fallback)
}

async function runSearch(m) {
  const q = m.input.value.trim()
  m.result.innerHTML = ''
  if (q.length < 2) { m.status.textContent = 'Type at least two characters of the show’s name.'; return }
  m.status.textContent = 'Searching Podcast Index…'
  m.lookup.disabled = true
  let shows = []
  try {
    shows = await searchShows(q)
  } catch (e) {
    console.warn('[podcasts] search failed', e)
    m.status.textContent = 'Podcast Index didn’t answer — please try again in a moment.'
    return
  } finally {
    m.lookup.disabled = false
  }
  if (!shows.length) { m.status.textContent = `No podcasts found for “${q}”.`; return }
  m.status.textContent = ''
  const list = h('div', { class: 'ffind-list' })
  for (const show of shows) {
    list.appendChild(h('button', {
      class: 'ffind-row-item', type: 'button',
      onclick: () => showEpisodes(m, show),
    }, [
      artEl(show.image, '🎙'),
      h('div', { class: 'ffind-row-body' }, [
        h('div', { class: 'ffind-row-title', text: show.title || 'Untitled show' }),
        h('div', { class: 'ffind-row-meta', text: [show.author, show.episode_count ? `${show.episode_count} episodes` : ''].filter(Boolean).join(' · ') }),
      ]),
      h('span', { class: 'ffind-row-meta', 'aria-hidden': 'true', text: '›' }),
    ]))
  }
  m.result.appendChild(list)
}

async function showEpisodes(m, show) {
  m.result.innerHTML = ''
  m.status.textContent = `Loading episodes of ${show.title || 'this show'}…`
  let episodes = []
  try {
    episodes = await listEpisodes(show.feed_id)
  } catch (e) {
    console.warn('[podcasts] episodes failed', e)
    m.status.textContent = 'Couldn’t load that show’s episodes — please try again.'
    return
  }
  m.status.textContent = ''
  const back = h('button', { class: 'ffind-back', type: 'button', onclick: () => runSearch(m) },
    [h('span', { 'aria-hidden': 'true', text: '‹' }), h('span', { text: 'Back to shows' })])
  if (!episodes.length) {
    m.result.append(h('p', { class: 'ffind-status', text: 'Podcast Index lists no episodes for this show yet.' }), back)
    return
  }
  const list = h('div', { class: 'ffind-list' })
  for (const ep of episodes) {
    const feature = h('button', { class: 'pcast-btn pcast-btn-feature ffind-row-action', type: 'button' })
    feature.innerHTML = FEATURE_BOLT_SVG + '<span>Feature</span>'
    feature.addEventListener('click', async () => {
      feature.disabled = true
      try {
        const showRec = {
          podcast_guid: show.podcast_guid || ep.podcast_guid || null,
          title: show.title || '',
          image: show.image || null,
          feed_id: show.feed_id || ep.feed_id || null,
          itunes_id: show.itunes_id || null,
        }
        const epRec = { ...ep, feed_id: ep.feed_id || show.feed_id || null, podcast_guid: ep.podcast_guid || show.podcast_guid || null }
        await featureEpisode(
          { guid: ep.item_guid, feedId: epRec.feed_id, showTitle: show.title || '', extra: { episode: epRec, show: showRec } },
          (msg) => showToast(msg, true),
        )
        m.closeFn()
        m.onFeatured?.()
      } finally {
        feature.disabled = false
      }
    })
    list.appendChild(h('div', { class: 'ffind-row-item ffind-row-item--static' }, [
      artEl(ep.image || show.image, '🎧'),
      h('div', { class: 'ffind-row-body' }, [
        h('div', { class: 'ffind-row-title', text: ep.title || 'Untitled episode' }),
        h('div', { class: 'ffind-row-meta', text: ep.published ? fullDate(ep.published) : '' }),
      ]),
      feature,
    ]))
  }
  m.result.append(list, back)
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

  // A booster with an OnlyBoosts page gets a real link here; everyone else
  // keeps the copy-npub button. The avatar beside it carries the blue dot.
  const nameEl = hasBoosterPage(b.booster_npub)
    ? h('a', {
        class: 'pcast-boost-name',
        href: boosterUrl(b.booster_npub),
        target: '_blank', rel: 'noopener noreferrer',
        title: 'View ' + name + ' on OnlyBoosts',
      }, name)
    : h('button', {
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
  ['count', 'Most boosters'],
  ['boosts', 'Most boosts'],
  ['sats', 'Most sats'],
]
// Every comparator breaks ties on total sats, then on most-recent-boost so the
// order stays stable. 'count' ranks by distinct people, 'boosts' by raw boost
// volume — they differ on the ~16% of episodes where someone boosted the same
// episode repeatedly.
const bySats = (a, b) => b.totalSats - a.totalSats || b.latest - a.latest
const SORTERS = {
  recent: (a, b) => b.latest - a.latest || b.totalSats - a.totalSats,
  episode: (a, b) => (b.ep.published || 0) - (a.ep.published || 0) || bySats(a, b),
  count: (a, b) => b.distinctBoosters.length - a.distinctBoosters.length || bySats(a, b),
  boosts: (a, b) => b.boosts.length - a.boosts.length || bySats(a, b),
  sats: bySats,
}
function sortItems(items, key) {
  return [...items].sort(SORTERS[key] || SORTERS.recent)
}

// ── Air-date range filter ────────────────────────────────────────────
// Scopes the feed to episodes that *aired* recently (ep.published), which is
// independent of when they were boosted — an old episode boosted today is in
// the feed's data but out of the 1W view.
const RANGE_OPTIONS = [
  ['1w', '1W', 7],
  ['1m', '1M', 30],
  ['all', 'All', null],
]
function filterItems(items, key) {
  const days = (RANGE_OPTIONS.find((o) => o[0] === key) || [])[2]
  if (!days) return items
  const cutoff = Date.now() / 1000 - days * 86400
  return items.filter((it) => (it.ep.published || 0) >= cutoff)
}
// Pick the opening range: 1W unless it's empty (a quiet week would leave the
// feed blank), then widen until something's there.
function defaultRange(items) {
  for (const [key] of RANGE_OPTIONS) {
    if (filterItems(items, key).length) return key
  }
  return 'all'
}

// Borderless 1W/1M/All segmented control — the selected segment's faint tint
// is the only chrome, which is what gives the group its shape.
function rangeControl(initialKey, onPick) {
  const wrap = h('div', { class: 'pcast-range', role: 'group', 'aria-label': 'Filter by episode air date' })
  const btns = RANGE_OPTIONS.map(([key, label]) =>
    h('button', {
      class: 'pcast-range-btn', type: 'button',
      title: label === 'All' ? 'All episodes' : `Episodes aired in the last ${label === '1W' ? '7 days' : '30 days'}`,
      onclick: () => { setActive(key); onPick(key) },
    }, label))
  function setActive(key) {
    btns.forEach((el, i) => {
      const on = RANGE_OPTIONS[i][0] === key
      el.classList.toggle('is-active', on)
      el.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
  }
  setActive(initialKey)
  wrap.append(...btns)
  return wrap
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

// Put the range buttons + sort dropdown in the panel head (replacing the
// episode-count pill), as one right-aligned group.
function mountControls(panel, { sortKey, rangeKey, onSort, onRange }) {
  const head = panel.querySelector('.feed-panel-head')
  if (!head) return
  const count = head.querySelector('.feed-count')
  if (count) count.hidden = true
  const existing = head.querySelector('.pcast-controls')
  if (existing) existing.remove()
  head.appendChild(h('div', { class: 'pcast-controls' }, [
    rangeControl(rangeKey, onRange),
    sortControl(sortKey, onSort),
  ]))
}

// ── Entry point ──────────────────────────────────────────────────────
export async function renderPodcasts({ panel, list }) {
  let data
  try {
    // The booster index rides along with the feed fetch: boostRow() and
    // avatarEl() both decide link-vs-copy synchronously and are never revised,
    // so the answer has to be in hand before the first row is built. obReady()
    // resolves either way, so a dead index costs the links, not the feed.
    const [resp] = await Promise.all([
      fetch(API_URL, { headers: { Accept: 'application/json' } }),
      obReady(),
    ])
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

  // Every episode we can render, snapshot or backfilled. The feed only ever
  // draws from `items`; `byGuid` also holds episodes pulled in by a feature,
  // which belong in the gold box but not in the community feed.
  const byGuid = new Map()
  for (const it of items) byGuid.set(it.guid, it)

  const state = {
    range: FEATURED_DEFAULT_RANGE,
    // coord -> { featuredAt, by, sats, extra }. Seeded with anything featured
    // from this browser recently, so a fresh boost stays lit across a reload
    // until the authoritative log catches up.
    featured: readConfirmedFeaturedEpisodes(),
    featuredLoading: true,
    featShown: FEATURED_INITIAL,
  }
  // Episodes stashed with a confirmed feature (a Find-modal result) render
  // straight away, before the log or OnlyBoosts know about them.
  for (const info of state.featured.values()) {
    const rec = info.extra
    const it = rec && rec.episode ? itemFromRecords(rec.episode, rec.show) : null
    if (it && !byGuid.has(it.guid)) byGuid.set(it.guid, it)
  }

  let sortKey = 'count'
  let rangeKey = defaultRange(items)
  let visibleFeatured = new Set()
  let sorted = []
  let shown = 0
  const featuredMount = h('div', { class: 'pcast-featured-mount' })
  const cards = h('div', { class: 'pcast-list' })
  const moreWrap = h('div', { class: 'pcast-more-wrap' })

  function renderMore() {
    if (!sorted.length) {
      cards.appendChild(h('div', { class: 'feed-placeholder' }, [
        h('strong', { text: 'No episodes in this window' }),
        'Nothing the community boosted aired in this time range — try a wider one.',
      ]))
      return
    }
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

  // The feed is "everything not in the gold box right now": an episode that
  // drops out of the featured window rejoins the feed in its sorted place,
  // Feature button restored, so a lapsed feature can be renewed.
  function rebuild() {
    sorted = sortItems(filterItems(items, rangeKey), sortKey).filter((it) => !visibleFeatured.has(it.guid))
    shown = 0
    cards.innerHTML = ''
    moreWrap.innerHTML = ''
    renderMore()
    repaintProfiles(cards)
  }

  function rerender() {
    visibleFeatured = new Set()
    featuredMount.innerHTML = ''
    featuredMount.appendChild(buildFeaturedSection(state, byGuid, visibleFeatured, rerender))
    rebuild()
  }

  function applySort(key) {
    if (key === sortKey) return
    sortKey = key
    rebuild()
  }

  function applyRange(key) {
    if (key === rangeKey) return
    rangeKey = key
    rebuild()
  }

  mountControls(panel, { sortKey, rangeKey, onSort: applySort, onRange: applyRange })

  list.className = ''
  list.innerHTML = ''
  list.append(featuredMount, cards, moreWrap)
  rerender()

  // Repaint avatars/names in place once profiles land. repaintProfiles reads
  // each card's _pcastItem, so it's correct even after a re-sort rebuilds the
  // list into a different order.
  profilesReady.then(() => { repaintProfiles(cards); repaintProfiles(featuredMount) })

  // Optimistic feature: when a boost settles and a Feature click is pending for
  // an EPISODE coordinate, light it up now rather than waiting for the log. The
  // pending slot is shared with the other tabs; a foreign coordinate is left
  // for its own listener to claim.
  window.addEventListener('lb:show-boost-settled', (ev) => {
    const d = ev && ev.detail
    if (!d || !(d.anySucceeded || d.anyUncertain)) return
    const pending = readPendingPromote()
    if (!pending || !pending.coord || !isEpisodeCoord(pending.coord)) return
    clearPendingPromote()
    const extra = pending.extra || null
    const ts = addConfirmedFeaturedEpisode(pending.coord, extra)
    const by = currentBooster()
    const prev = state.featured.get(pending.coord)
    state.featured.set(pending.coord, {
      featuredAt: ts,
      by: by || prev?.by || null,
      sats: prev?.sats || 0,
      naddr: '',
      extra: extra || prev?.extra || null,
    })
    const guid = guidFromCoord(pending.coord)
    if (!byGuid.has(guid) && extra && extra.episode) {
      const it = itemFromRecords(extra.episode, extra.show)
      if (it) byGuid.set(guid, it)
    }
    if (by) profiles.set(by.pubkey, { name: by.name, picture: by.picture })
    rerender()
  })

  // The authoritative featured set, then any featured episode missing from the
  // snapshot from OnlyBoosts' index. Best-effort throughout: a failure here
  // leaves the section showing whatever the optimistic set knows about.
  try {
    const { featured } = await fetchFeaturedEpisodeSet()
    for (const [coord, info] of featured) {
      const prev = state.featured.get(coord)
      state.featured.set(coord, {
        ...info,
        featuredAt: Math.max(info.featuredAt || 0, prev?.featuredAt || 0),
        by: info.by || prev?.by || null,
        extra: prev?.extra || null,
      })
    }
    const missing = [...state.featured.keys()].map(guidFromCoord).filter((g) => g && !byGuid.has(g))
    await Promise.all(missing.map(async (guid) => {
      const rec = await fetchEpisodeFromOnlyBoosts(guid)
      const it = rec ? itemFromRecords(rec.episode, rec.show) : null
      if (it) byGuid.set(guid, it)
    }))
    const boosters = [...new Set([...state.featured.values()].map((i) => i.by?.pubkey).filter(Boolean))]
    if (boosters.length) await fetchProfilesInto(boosters.filter((pk) => !profiles.has(pk)))
  } catch (e) {
    console.warn('[podcasts] featured load failed', e)
  }
  try {
    state.featuredLoading = false
    rerender()
  } catch (e) {
    console.warn('[podcasts] featured repaint failed', e)
  }
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
    for (const b of it.distinctBoosters) {
      holder.appendChild(avatarEl(profileFor(b.booster_pubkey), b.booster_npub, { size: 22 }))
    }
  })
}
