/* The homepage's feed rails (rails-homepage, 2026-11).
 *
 * Under the Community row, the four community feeds each paint one sideways
 * row of square tiles: Events, Marketplace, Podcast Boosts, Articles, the
 * OnlyBoosts discovery homepage's shape (Reed, 2026-11-07, after the
 * feedback on the tabs: "nobody likes the tabs"). A tile is the item's
 * picture, its title and one line (the date, the price, the show, the
 * author); featured items come first with a gold ring and the feature bolt;
 * a click opens the feed page's own card in a modal (an event card, an
 * episode card, the article reader; a listing opens merch.js's product
 * modal). Each rail's heading and "See all" link its page, where the whole
 * feed is a list.
 *
 * The data is the pages' own: feeds.js's loadEventRail, feeds-market.js's
 * loadMarketItems, feeds-podcasts.js's loadPodcastItems and railEpisodes,
 * feeds-articles.js's loadArticleItems, and the featured sets from the
 * featured-* modules, so a rail and its page agree on what is featured and
 * in what order. A rail loads when it scrolls near the viewport, so the
 * four do not all hit the snapshots and relays at once on a phone.
 *
 * The Community rail is supporters.js's (its rail mode), not this module's;
 * the tile and modal CSS is assets/css/home-rails.css.
 */
import { ready as obReady } from '/assets/js/onlyboosts.js'
import { STATIC_RELAYS } from '/assets/js/boosts-thread.js'
import { FEATURE_BOLT_SVG, isFeatureLive } from '/assets/js/featured-shared.js'

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return el
}

function isHttpUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' } catch { return false }
}

// "Sat, Nov 14", with the year once the event is not this year's.
function dateLabel(ms) {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  const opts = { weekday: 'short', month: 'short', day: 'numeric' }
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  try { return d.toLocaleDateString(undefined, opts) } catch { return d.toDateString() }
}

// The newest feature first among the featured, the feed's own order after.
function featuredFirst(list, isFeat, featAt) {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => {
      const fa = isFeat(a.x), fb = isFeat(b.x)
      if (fa !== fb) return fa ? -1 : 1
      if (fa) { const d = (featAt(b.x) || 0) - (featAt(a.x) || 0); if (d) return d }
      return a.i - b.i
    })
    .map((e) => e.x)
}

// Merge the authoritative featured set over the optimistic one (the pages'
// rule: the log's credit wins, the newer timestamp wins).
function mergeFeatured(into, from) {
  for (const [coord, info] of from) {
    const prev = into.get(coord)
    into.set(coord, {
      ...info,
      featuredAt: Math.max(info.featuredAt || 0, prev?.featuredAt || 0),
      by: info.by || prev?.by || null,
      extra: prev?.extra || info.extra || null,
    })
  }
}

// ── The modal ────────────────────────────────────────────────────────
let modalEl = null
let lastTrigger = null

function onModalKey(e) {
  if (e.key === 'Escape') closeModal()
}
function closeModal() {
  if (!modalEl) return
  modalEl.remove()
  modalEl = null
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onModalKey)
  if (lastTrigger && document.contains(lastTrigger)) { try { lastTrigger.focus() } catch {} }
}
export function openCardModal(card, { label = '', wide = false } = {}) {
  closeModal()
  const close = h('button', { class: 'rail-modal-close', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '×')
  const body = h('div', { class: 'rail-modal-body' }, [card])
  const dialog = h('div', {
    class: 'rail-modal' + (wide ? ' rail-modal--wide' : ''),
    role: 'dialog', 'aria-modal': 'true', 'aria-label': label || 'Details',
  }, [close, body])
  const backdrop = h('div', { class: 'rail-modal-backdrop' }, [dialog])
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal() })
  document.body.appendChild(backdrop)
  modalEl = backdrop
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onModalKey)
  try { close.focus({ preventScroll: true }) } catch {}
  return closeModal
}

// ── A tile ───────────────────────────────────────────────────────────
// `open` is what a click does (opens the modal, or merch's product modal).
function tileEl({ title, sub = '', img = null, glyph = '•', featured = false, open }) {
  const media = h('span', { class: 'rt-media' + (isHttpUrl(img) ? '' : ' rt-media--none') })
  if (isHttpUrl(img)) {
    const im = h('img', { src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    // A broken picture falls back to the glyph rather than an empty box.
    im.onerror = () => { im.remove(); media.classList.add('rt-media--none'); media.appendChild(h('span', { class: 'rt-glyph', 'aria-hidden': 'true', text: glyph })) }
    media.appendChild(im)
  } else {
    media.appendChild(h('span', { class: 'rt-glyph', 'aria-hidden': 'true', text: glyph }))
  }
  if (featured) {
    const badge = h('span', { class: 'rt-feat', title: 'Featured' })
    badge.innerHTML = FEATURE_BOLT_SVG
    media.appendChild(badge)
  }
  const btn = h('button', { class: 'rt', type: 'button' }, [
    media,
    h('span', { class: 'rt-title', text: title || 'Untitled' }),
    sub ? h('span', { class: 'rt-sub', text: sub, title: sub }) : null,
  ])
  let busy = false
  btn.addEventListener('click', async () => {
    if (busy) return
    busy = true
    lastTrigger = btn
    btn.setAttribute('aria-busy', 'true')
    try {
      await open()
    } catch (e) {
      console.warn('[rails] open failed', e)
    } finally {
      busy = false
      btn.removeAttribute('aria-busy')
    }
  })
  return h('li', { class: 'rail-tile' + (featured ? ' rail-tile--featured' : '') }, [btn])
}

function paintRail(section, tiles, emptyText) {
  const track = section.querySelector('.rail-track')
  if (!track) return
  track.innerHTML = ''
  if (!tiles.length) {
    track.appendChild(h('p', { class: 'rail-empty', text: emptyText }))
    return
  }
  track.appendChild(h('ol', { class: 'rail-list' }, tiles.map(tileEl)))
}

function paintError(section, text) {
  const track = section.querySelector('.rail-track')
  if (!track) return
  track.innerHTML = ''
  track.appendChild(h('p', { class: 'rail-error', text }))
}

// ── The four rails ───────────────────────────────────────────────────
const RAILS = {
  // Events still to come, featured first then soonest first (feeds.js
  // decides); the picture is the event's, else the organizer's avatar
  // (Reed, 2026-11-07), and the line is the date alone. The modal is the
  // whole event: the page's card plus the description (Reed, 2026-11-08).
  events: {
    empty: 'No upcoming events. Post one from the Events page.',
    error: 'Couldn’t load events right now.',
    async load() {
      const feeds = await import('/assets/js/feeds.js')
      const { items, credits } = await feeds.loadEventRail()
      return items.map(({ group, featured }) => ({
        title: group.parsed.title || 'Untitled event',
        sub: dateLabel(group.startMs),
        img: group.parsed.image || group.profile?.picture || null,
        glyph: '📅',
        featured,
        open: async () => {
          await obReady()
          const card = feeds.renderEventCard(group, featured, credits, { description: true })
          openCardModal(card, { label: group.parsed.title || 'Event', wide: true })
        },
      }))
    },
  },

  // Listings: the paid features and the house store's own (standing
  // features) first, then the page's Buy-Now-first order; the line is the
  // price. A tile opens merch.js's product modal, the card's own target.
  market: {
    empty: 'No listings right now.',
    error: 'Couldn’t load the marketplace right now.',
    async load() {
      const [mod, fm] = await Promise.all([
        import('/assets/js/feeds-market.js'),
        import('/assets/js/featured-market.js'),
      ])
      const { items, rate } = await mod.loadMarketItems()
      const featured = fm.readConfirmedFeaturedListings()
      try {
        const { featured: log } = await fm.fetchFeaturedListingSet()
        mergeFeatured(featured, log)
      } catch (e) {
        console.warn('[rails] featured listings unavailable', e)
      }
      const paid = (it) => { const i = featured.get(it.product.coord); return i && isFeatureLive(i) ? i : null }
      const isFeat = (it) => it.isHouse || !!paid(it)
      const featAt = (it) => paid(it)?.featuredAt || (it.isHouse ? (it.product.created_at || 0) * 1000 : 0)
      return featuredFirst(items, isFeat, featAt).map((it) => ({
        title: it.product.title,
        sub: mod.priceText(it.product, rate),
        img: (it.product.images || [])[0] || null,
        glyph: '🛍️',
        featured: isFeat(it),
        open: async () => { await obReady(); mod.openListing(it) },
      }))
    },
  },

  // Boosted episodes: the features first, then the page's own order (most
  // boosters over the narrowest air-date window with something in it); the
  // line is the show. A featured episode the community snapshot lacks is
  // fetched from OnlyBoosts like the page's box does.
  podcasts: {
    empty: 'No boosted episodes yet.',
    error: 'Couldn’t load podcast boosts right now.',
    async load() {
      const [mod, fp] = await Promise.all([
        import('/assets/js/feeds-podcasts.js'),
        import('/assets/js/featured-podcasts.js'),
      ])
      const items = await mod.loadPodcastItems()
      const byGuid = new Map(items.map((it) => [it.guid, it]))
      const featured = fp.readConfirmedFeaturedEpisodes()
      for (const info of featured.values()) {
        const rec = info.extra
        const it = rec && rec.episode ? mod.itemFromRecords(rec.episode, rec.show) : null
        if (it && !byGuid.has(it.guid)) byGuid.set(it.guid, it)
      }
      try {
        const { featured: log } = await fp.fetchFeaturedEpisodeSet()
        mergeFeatured(featured, log)
        const missing = [...featured.keys()].map(fp.guidFromCoord).filter((g) => g && !byGuid.has(g))
        await Promise.all(missing.map(async (guid) => {
          const rec = await fp.fetchEpisodeFromOnlyBoosts(guid)
          const it = rec ? mod.itemFromRecords(rec.episode, rec.show) : null
          if (it) byGuid.set(guid, it)
        }))
        const boosters = [...new Set([...featured.values()].map((i) => i.by?.pubkey).filter(Boolean))]
        if (boosters.length) await mod.fetchProfilesInto(boosters)
      } catch (e) {
        console.warn('[rails] featured episodes unavailable', e)
      }
      const infoOf = (it) => { const i = featured.get(fp.episodeCoord(it.guid)); return i && isFeatureLive(i) ? i : null }
      const feat = [...byGuid.values()].filter(infoOf)
      const rest = mod.railEpisodes(items).filter((it) => !infoOf(it))
      return featuredFirst([...feat, ...rest], (it) => !!infoOf(it), (it) => infoOf(it)?.featuredAt).map((it) => ({
        title: it.ep.title || 'Untitled episode',
        sub: it.show?.title || '',
        img: it.ep.image || it.show?.image || null,
        glyph: '🎙',
        featured: !!infoOf(it),
        open: async () => {
          const info = infoOf(it)
          const card = await mod.openEpisodeCard(it, info ? { featured: true, info } : {})
          openCardModal(card, { label: it.ep.title || 'Episode', wide: true })
        },
      }))
    },
  },

  // Articles WITH A COVER, the features first, then the page's order; the
  // line is the author. Reed, 2026-11-08: no cover, not on the homepage
  // (the avatar fallback made a row of faces); the page lists them all. A
  // featured article outside the community snapshot is fetched from relays
  // like the page's box does, and the cover rule applies to it too.
  articles: {
    empty: 'No articles yet.',
    error: 'Couldn’t load articles right now.',
    async load() {
      const [mod, fa] = await Promise.all([
        import('/assets/js/feeds-articles.js'),
        import('/assets/js/featured-articles.js'),
      ])
      const hasCover = (a) => isHttpUrl(a.image)
      const articles = (await mod.loadArticleItems({ limit: 80 })).filter(hasCover).slice(0, 20)
      const coordOf = (a) => fa.articleCoord(a.pubkey, a.dTag)
      const byCoord = new Map(articles.map((a) => [coordOf(a), a]))
      const featured = fa.readConfirmedFeaturedArticles()
      try {
        const { featured: log, hints } = await fa.fetchFeaturedArticleSet()
        mergeFeatured(featured, log)
        const missing = [...featured.keys()].filter((c) => !byCoord.has(c))
        const added = []
        if (missing.length) {
          const found = await fa.fetchArticlesFromRelays(missing, [...new Set([...STATIC_RELAYS, ...(hints || [])])])
          for (const [coord, ev] of found) {
            const a = mod.parseArticle(ev)
            if (a) { byCoord.set(coord, a); added.push(a) }
          }
        }
        const boosters = [...new Set([...featured.values()].map((i) => i.by?.pubkey).filter(Boolean))]
        if (added.length || boosters.length) await mod.loadArticleProfiles(added, boosters)
      } catch (e) {
        console.warn('[rails] featured articles unavailable', e)
      }
      const infoOf = (a) => { const i = featured.get(coordOf(a)); return i && isFeatureLive(i) ? i : null }
      const feat = [...byCoord.values()].filter((a) => infoOf(a) && hasCover(a))
      const rest = articles.filter((a) => !infoOf(a))
      return featuredFirst([...feat, ...rest], (a) => !!infoOf(a), (a) => infoOf(a)?.featuredAt).map((a) => ({
        title: a.title,
        sub: mod.articleAuthorName(a.pubkey),
        img: a.image,
        glyph: '📄',
        featured: !!infoOf(a),
        open: async () => {
          const reader = await mod.openArticleReader(a)
          openCardModal(reader, { label: a.title || 'Article', wide: true })
        },
      }))
    },
  },
}

// ── Boot: each rail loads as it nears the viewport ───────────────────
const loaded = new Set()
async function loadRail(section) {
  const key = section.dataset.rail
  const rail = RAILS[key]
  if (!rail || loaded.has(key)) return
  loaded.add(key)
  try {
    const tiles = await rail.load()
    paintRail(section, tiles, rail.empty)
  } catch (e) {
    console.error(`[rails] ${key} failed`, e)
    paintError(section, rail.error)
  }
}

const sections = Array.from(document.querySelectorAll('.rail[data-rail]'))
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      io.unobserve(en.target)
      loadRail(en.target)
    }
  }, { rootMargin: '600px 0px' })
  sections.forEach((s) => io.observe(s))
} else {
  sections.forEach(loadRail)
}
