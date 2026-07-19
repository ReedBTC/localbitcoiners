/* Articles feed — the "Articles" tab on /feeds.
 *
 * A list of NIP-23 long-form articles (kind 30023) from the Local Bitcoiners
 * community. The card is the ARTICLE (cover, title, author, date, summary);
 * clicking it opens a full-width in-panel reader that renders the markdown
 * body — the same read experience as MyNostr's article reader, reimplemented
 * in vanilla here (no React / Tailwind on this site).
 *
 * Like Events / Marketplace / Podcast Boosts this feed is NOT a live relay
 * subscription. It reads one pre-computed snapshot from /api/community-articles
 * (a Cloudflare Pages Function proxying the file bots/community-feeds pushes to
 * the VPS hourly, already scoped to the show's supporters). So there's no
 * follow-pack / relay resolution here — just a cached GET, then a single
 * batched profile lookup for author names/avatars (the JSON carries raw signed
 * events but no kind-0 metadata).
 *
 * The snapshot is our own bot's, but the transport is untrusted — every event
 * is verifyEvent()'d before it's rendered, and the markdown body is run through
 * marked → DOMPurify before it touches the DOM.
 *
 * Entry point: renderArticles({ panel, list }) — lazy-imported by feeds.js the
 * first time the tab is opened.
 */
import { nip19, verifyEvent } from '/assets/widgets/nostr-tools.js'
import { fetchProfilesFromPrimal, setCachedProfile } from '/assets/js/boosts-thread.js'
import { buildActionBar, configureBoostActions } from '/assets/js/boost-actions.js'
import { marked } from '/assets/widgets/marked.esm.js'
import DOMPurify from '/assets/widgets/dompurify.esm.js'
import { ensureLoginWidget } from '/assets/js/widget-loader.js'

// The reply/repost/like/zap actions publish via the login-widget bundle
// (window.LBLogin), lazy-loaded on first need. Mirrors feeds-podcasts.js.
const ensureWidgetLoaded = ensureLoginWidget

const API_URL = '/api/community-articles'
const KIND_ARTICLE = 30023
const INITIAL_CARDS = 20        // articles rendered per "load more" batch
const PROFILE_CHUNK = 80        // Primal user_infos drops results on large batches

// ── Tiny DOM helper (same contract as feeds-podcasts.js / feeds-market.js) ──
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

// ── URL / image safety ───────────────────────────────────────────────
function isSafeUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

// ── Formatting ───────────────────────────────────────────────────────
function fullDate(unixSec) {
  if (!unixSec) return ''
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

// ── Clipboard + toast ────────────────────────────────────────────────
// Same contract as feeds-podcasts.js: navigator.clipboard only exists in
// secure contexts (HTTPS / localhost), so fall back to execCommand for
// plain-HTTP LAN previews.
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
  let t = document.querySelector('.art-toast')
  if (!t) {
    t = h('div', { class: 'art-toast', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.toggle('is-error', !!isError)
  requestAnimationFrame(() => t.classList.add('is-visible'))
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2200)
}

async function copyNpub(pubkey) {
  let npub
  try { npub = nip19.npubEncode(pubkey) } catch { return }
  showToast(await copyText(npub) ? 'Copied npub' : 'Copy failed', false)
}

async function copyNaddr(naddr) {
  if (!naddr) return
  showToast(await copyText(naddr) ? 'Copied article naddr' : 'Copy failed', false)
}

// ── Tag helpers ──────────────────────────────────────────────────────
function tagVal(ev, name) {
  for (const t of ev.tags || []) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === 'string') return t[1]
  }
  return ''
}

// Build a render-ready article from a raw kind-30023 event.
function parseArticle(ev) {
  const dTag = tagVal(ev, 'd')
  if (!dTag) return null   // replaceable events need a d-tag to be addressable
  // published_at should be unix *seconds*, but some clients emit milliseconds
  // (→ absurd future years) or garbage. Only trust it when it lands in a sane
  // range (not more than a day ahead of now); otherwise use created_at.
  const nowSec = Math.floor(Date.now() / 1000)
  const publishedAt = parseInt(tagVal(ev, 'published_at'), 10)
  const validPub = Number.isFinite(publishedAt) && publishedAt > 0 && publishedAt <= nowSec + 86400
  let naddr = ''
  try {
    naddr = nip19.naddrEncode({ identifier: dTag, pubkey: ev.pubkey, kind: KIND_ARTICLE })
  } catch {}
  const image = tagVal(ev, 'image')
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    sig: ev.sig || '',
    tags: Array.isArray(ev.tags) ? ev.tags : [],
    dTag,
    naddr,
    kind: KIND_ARTICLE,
    title: (tagVal(ev, 'title') || 'Untitled').trim(),
    summary: (tagVal(ev, 'summary') || '').trim(),
    image: isSafeUrl(image) ? image : '',
    content: typeof ev.content === 'string' ? ev.content : '',
    createdAt: ev.created_at || 0,
    // Display date prefers a sane author-set published_at; sort uses created_at
    // (published_at is optional and often backdated — never trust it for order).
    date: validPub ? publishedAt : (ev.created_at || 0),
  }
}

// Dedupe replaceable events: newest created_at per (pubkey, d-tag) coord wins.
function buildArticles(data) {
  const events = Array.isArray(data?.events) ? data.events : []
  const byCoord = new Map()
  for (const ev of events) {
    if (!ev || ev.kind !== KIND_ARTICLE) continue
    let ok = false
    try { ok = verifyEvent(ev) } catch {}
    if (!ok) continue
    const dTag = tagVal(ev, 'd')
    if (!dTag) continue
    const coord = `${ev.pubkey}:${dTag}`
    const prev = byCoord.get(coord)
    if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) byCoord.set(coord, ev)
  }
  const out = []
  for (const ev of byCoord.values()) {
    const a = parseArticle(ev)
    if (a) out.push(a)
  }
  // Newest first by event timestamp.
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

// Data-only loader for the homepage teaser (home-feeds.js). Fetches the same
// snapshot renderArticles() uses, drops short (<SHORT_MAX) bodies to match the
// tab's default view, takes the newest `limit`, and resolves author profiles
// so the teaser card can show a name/avatar (attached as `.author`). Mirrors
// the loadMarketItems / renderMarket split in feeds-market.js.
export async function loadArticleItems({ limit = 12 } = {}) {
  const resp = await fetch(API_URL, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error('community-articles ' + resp.status)
  const data = await resp.json()
  const articles = buildArticles(data)
    .filter((a) => a.content.length >= SHORT_MAX)
    .slice(0, limit)
  await loadAuthorProfiles(articles)
  for (const a of articles) a.author = profileFor(a.pubkey)
  return articles
}

// Below this length (characters) an article is treated as "short" and hidden
// from the default view — most sub-420-char kind-30023s are threads/notes, not
// long-form. The "Include short articles" toggle disables this cut.
const SHORT_MAX = 420

// ── Profiles ─────────────────────────────────────────────────────────
// Author kind-0s aren't in the snapshot; fetch them once and stash in a module
// map the card/reader renderers read. Cards paint immediately with initials and
// repaint in place once these resolve.
const profiles = new Map()
function profileFor(pubkey) { return profiles.get(pubkey) || null }

async function loadAuthorProfiles(articles) {
  const pks = [...new Set(articles.map((a) => a.pubkey).filter(Boolean))]
  for (let i = 0; i < pks.length; i += PROFILE_CHUNK) {
    try {
      const got = await fetchProfilesFromPrimal(pks.slice(i, i + PROFILE_CHUNK))
      for (const [pk, prof] of got) {
        profiles.set(pk, prof)
        setCachedProfile(pk, prof)
      }
    } catch { /* leave unresolved — degrades to npub + initials */ }
  }
}

function npubShort(pubkey) {
  try { return nip19.npubEncode(pubkey).slice(0, 12) + '…' } catch { return pubkey.slice(0, 8) + '…' }
}

function authorName(pubkey) {
  const p = profileFor(pubkey)
  return (p && p.name && p.name.trim()) || npubShort(pubkey)
}

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '·'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

// When interactive, the avatar is a copy-npub affordance (matches the rest of
// the site: click a pfp/name → copy its npub).
function avatarEl(pubkey, size = 26, { interactive = false } = {}) {
  const p = profileFor(pubkey)
  const style = `--art-av:${size}px`
  const extra = interactive ? ' art-avatar--btn' : ''
  const common = interactive
    ? { style, title: 'Copy npub', role: 'button', tabindex: '0',
        onclick: (e) => { e.stopPropagation(); copyNpub(pubkey) },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyNpub(pubkey) } } }
    : { style }
  if (p && isSafeUrl(p.picture)) {
    return h('img', { class: 'art-avatar' + extra, src: p.picture, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', ...common })
  }
  return h('span', { class: 'art-avatar art-avatar--none' + extra, ...common }, initials(authorName(pubkey)))
}

// Author display name as a copy-npub button.
function nameButton(pubkey, cls) {
  return h('button', {
    class: cls, type: 'button', title: 'Copy npub',
    onclick: (e) => { e.stopPropagation(); copyNpub(pubkey) },
  }, authorName(pubkey))
}

// ── Cards ────────────────────────────────────────────────────────────
// Shared "open the reader" affordance for the cover + title.
function openAttrs(a, onOpen) {
  return {
    role: 'button', tabindex: '0', title: 'Read: ' + a.title,
    onclick: () => onOpen(a),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a) } },
  }
}

function articleCard(a, onOpen) {
  const open = openAttrs(a, onOpen)
  const media = a.image
    ? h('div', { class: 'art-card-media art-card-media--link', ...open }, h('img', { src: a.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))
    : h('div', { class: 'art-card-media art-card-media--none art-card-media--link', ...open }, '📄')

  const byline = h('div', { class: 'art-byline' }, [
    avatarEl(a.pubkey, 22, { interactive: true }),
    nameButton(a.pubkey, 'art-byline-name'),
    h('span', { class: 'art-dot', 'aria-hidden': 'true', text: '·' }),
    h('span', { class: 'art-byline-when', text: fullDate(a.date) }),
  ])

  const foot = h('div', { class: 'art-card-foot' }, [
    h('button', { class: 'art-read', type: 'button', onclick: () => onOpen(a) },
      ['Read Full Article', h('span', { 'aria-hidden': 'true', text: ' →' })]),
  ])

  const body = h('div', { class: 'art-card-body' }, [
    h('div', { class: 'art-title art-title-link', ...open, text: a.title }),
    byline,
    a.summary ? h('p', { class: 'art-summary', text: a.summary }) : null,
    foot,
  ])

  const card = h('article', { class: 'art-card' }, [media, body, moreMenu(a)])
  card._article = a
  return card
}

// ⋮ menu — its one item copies the article's naddr. Outside-click / Escape to
// close (same pattern as the podcasts feed's card menus). `wrapClass` lets the
// card (corner-absolute) and the reader (in the sticky bar) style it apart.
function moreMenu(a, wrapClass = 'art-more') {
  const wrap = h('div', { class: wrapClass })
  const btn = h('button', {
    class: 'art-more-btn', type: 'button', 'aria-label': 'More options',
    'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'More',
  }, '⋮')
  const menu = h('div', { class: 'art-more-menu', hidden: 'hidden' }, [
    h('button', {
      class: 'art-more-item', type: 'button',
      onclick: () => { close(); copyNaddr(a.naddr) },
    }, 'Copy article naddr'),
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
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close() })
  return wrap
}

// Swap decorative card avatars/names in place after profiles resolve, so we
// don't tear down and rebuild the list.
function repaintCards(cardsEl) {
  cardsEl.querySelectorAll('.art-card').forEach((cardEl) => {
    const a = cardEl._article
    if (!a) return
    const byline = cardEl.querySelector('.art-byline')
    if (!byline) return
    const oldAv = byline.querySelector('.art-avatar')
    if (oldAv) oldAv.replaceWith(avatarEl(a.pubkey, 22, { interactive: true }))
    const nameEl = byline.querySelector('.art-byline-name')
    if (nameEl) nameEl.textContent = authorName(a.pubkey)
  })
}

// ── Inline nostr mentions ────────────────────────────────────────────
// NIP-23 bodies embed people as `nostr:npub1…` / `nostr:nprofile1…` — both as
// bare text and inside markdown links. Left untouched they render as an ugly
// raw bech32 (or, for links, a dead `nostr:` href). We turn each into an
// @-mention chip pointing at njump, then repaint the label to @displayName once
// the author kind-0 resolves. (note/nevent/naddr quotes are intentionally left
// as-is here — the reader isn't a full note-tree renderer.)
const NOSTR_MENTION_RE = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)/gi

function pubkeyFromBech32(bech32) {
  try {
    const d = nip19.decode(bech32)
    if (d.type === 'npub') return d.data
    if (d.type === 'nprofile') return d.data.pubkey
  } catch {}
  return ''
}

function mentionLabel(pubkey, ident) {
  const p = profileFor(pubkey)
  if (p && p.name && p.name.trim()) return '@' + p.name.trim()
  return '@' + (ident ? ident.slice(0, 12) + '…' : 'npub')
}

function mentionAnchor(pubkey, bech32) {
  let ident = bech32
  try { ident = nip19.npubEncode(pubkey) } catch {}
  return h('a', {
    class: 'nostr-mention', href: 'https://njump.me/' + ident,
    target: '_blank', rel: 'noopener noreferrer', 'data-mention-pk': pubkey,
  }, mentionLabel(pubkey, ident))
}

// Rewrite `nostr:` mentions in a sanitized tree into @-mention chips. Returns
// the set of referenced pubkeys so the caller can resolve their profiles.
function linkifyMentions(container) {
  const pks = new Set()

  // Markdown links written as [label](nostr:npub…): rewrite the dead nostr:
  // href to njump, and if the visible label is just the raw bech32, name it.
  container.querySelectorAll('a[href^="nostr:"], a[href^="NOSTR:"]').forEach((a) => {
    const bech32 = a.getAttribute('href').replace(/^nostr:/i, '')
    const pk = pubkeyFromBech32(bech32)
    if (!pk) { a.setAttribute('href', 'https://njump.me/' + bech32); return }
    let ident = bech32
    try { ident = nip19.npubEncode(pk) } catch {}
    a.setAttribute('href', 'https://njump.me/' + ident)
    a.classList.add('nostr-mention')
    a.setAttribute('data-mention-pk', pk)
    const txt = (a.textContent || '').trim()
    if (!txt || /^(nostr:)?n(pub|profile)1[a-z0-9]+…?$/i.test(txt)) {
      a.textContent = mentionLabel(pk, ident)
    }
    pks.add(pk)
  })

  // Bare mentions sitting in text nodes (not already inside a link/code block).
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.indexOf('nostr:') === -1) return NodeFilter.FILTER_REJECT
      if (node.parentElement && node.parentElement.closest('a, code, pre')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n)

  for (const node of textNodes) {
    const text = node.nodeValue
    NOSTR_MENTION_RE.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0, matched = false, m
    while ((m = NOSTR_MENTION_RE.exec(text))) {
      const pk = pubkeyFromBech32(m[1])
      if (!pk) continue
      matched = true
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
      frag.appendChild(mentionAnchor(pk, m[1]))
      pks.add(pk)
      last = m.index + m[0].length
    }
    if (!matched) continue
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode.replaceChild(frag, node)
  }

  return pks
}

// Once mention author profiles resolve, swap the truncated-npub labels for
// @displayName in place (chips carry data-mention-pk).
function repaintMentions(container) {
  container.querySelectorAll('a[data-mention-pk]').forEach((a) => {
    const pk = a.getAttribute('data-mention-pk')
    let ident = pk
    try { ident = nip19.npubEncode(pk) } catch {}
    a.textContent = mentionLabel(pk, ident)
  })
}

async function resolveMentionProfiles(container, pks) {
  const need = [...pks].filter((pk) => pk && !profileFor(pk))
  if (!need.length) return
  for (let i = 0; i < need.length; i += PROFILE_CHUNK) {
    try {
      const got = await fetchProfilesFromPrimal(need.slice(i, i + PROFILE_CHUNK))
      for (const [pk, prof] of got) { profiles.set(pk, prof); setCachedProfile(pk, prof) }
    } catch { /* leave as truncated npub */ }
  }
  repaintMentions(container)
}

// ── Reader (markdown body) ───────────────────────────────────────────
// marked → sanitized HTML. Kind-30023 content is Markdown by NIP-23; render it,
// but never trust the output — DOMPurify strips scripts/embeds/handlers, then we
// harden links (new tab) and images (no-referrer, lazy) on the sanitized tree.
// Returns the set of pubkeys mentioned inline (for async profile resolution).
function renderMarkdownInto(container, markdown, title) {
  let src = String(markdown || '')
  // Drop a leading H1 that just repeats the title — the reader already shows
  // the title above the body, so this avoids a duplicate heading.
  src = src.replace(/^\s*#\s+(.+?)\s*(?:\n|$)/, (m, heading) => {
    return heading.trim().toLowerCase() === (title || '').trim().toLowerCase() ? '' : m
  })
  // Auto-embed bare image URLs that sit on their own line as inline images.
  // MyNostr relies on markdown ![](); this also catches the plain image-URL
  // lines some clients emit so they render inline instead of as a raw link.
  // (Lines already starting with `!`/`[` — markdown images/links — won't match.)
  src = src.replace(
    /^[ \t]*(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:\?[^\s]*)?)[ \t]*$/gim,
    '![]($1)'
  )

  let html
  try {
    html = marked.parse(src, { gfm: true, breaks: false })
  } catch {
    // Fall back to plain text if the parser chokes on malformed input.
    container.appendChild(h('p', { class: 'art-prose-fallback', text: src }))
    return linkifyMentions(container)
  }

  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|nostr:|#)/i,
  })
  container.innerHTML = clean

  container.querySelectorAll('a[href]').forEach((a) => {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  })
  container.querySelectorAll('img').forEach((img) => {
    if (!isSafeUrl(img.getAttribute('src') || '')) { img.remove(); return }
    img.referrerPolicy = 'no-referrer'
    img.loading = 'lazy'
    img.removeAttribute('width')
    img.removeAttribute('height')
  })

  return linkifyMentions(container)
}

// Open the full-width in-panel reader: hide the list + panel head, render the
// article, and wire a back control that restores the list. Mirrors MyNostr's
// mobile flow (list → full-width reader → back) on every screen size.
function openReader(ctx, a) {
  const { panel, list } = ctx
  const head = panel.querySelector('.feed-panel-head')

  // Remember the feed's scroll position so Back returns you to where you were,
  // not the top of the list.
  ctx.savedScrollY = window.scrollY || window.pageYOffset || 0

  const back = h('button', {
    class: 'art-reader-back', type: 'button',
    onclick: () => closeReader(ctx),
  }, [h('span', { 'aria-hidden': 'true', text: '←' }), 'Back to articles'])

  // Back pill + ⋮ menu are floating controls (position:fixed, set by
  // positionFloatingControls) — kept beside the article column and always
  // reachable while scrolling.
  const more = moreMenu(a, 'art-reader-more')

  const cover = a.image
    ? h('div', { class: 'art-reader-cover' }, h('img', { src: a.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }))
    : null

  const byline = h('div', { class: 'art-reader-byline' }, [
    avatarEl(a.pubkey, 34, { interactive: true }),
    h('div', { class: 'art-reader-who' }, [
      nameButton(a.pubkey, 'art-reader-name'),
      h('span', { class: 'art-reader-when', text: fullDate(a.date) }),
    ]),
  ])

  const proseEl = h('div', { class: 'art-prose' })
  const mentionPks = renderMarkdownInto(proseEl, a.content, a.title)
  // Inline @-mentions paint immediately as truncated npubs; resolve their
  // profiles in the background and repaint to @displayName in place.
  if (mentionPks && mentionPks.size) resolveMentionProfiles(proseEl, mentionPks)

  // Nostr interaction bar (reply / repost / like / zap) on the article itself,
  // same builder the boost notes use. The event carries kind 30023 + d-tag so
  // reactions/reposts reference the article's addressable coordinate.
  const foot = h('div', { class: 'art-reader-foot' })
  try {
    const actionsEv = {
      id: a.id, pubkey: a.pubkey, sig: a.sig, kind: a.kind, dTag: a.dTag,
      content: a.content, created_at: a.createdAt, tags: a.tags,
    }
    foot.appendChild(buildActionBar(actionsEv, foot))
  } catch (e) {
    console.warn('[articles] action bar failed', e)
  }

  const reader = h('article', { class: 'art-reader' }, [
    cover,
    h('h1', { class: 'art-reader-title', text: a.title }),
    byline,
    a.summary ? h('p', { class: 'art-reader-summary', text: a.summary }) : null,
    proseEl,
    foot,
  ])
  // The floating controls sit OUTSIDE the article flow (they're position:fixed),
  // but live inside the reader element so they're removed on close and hidden
  // when the tab switches.
  reader.append(back, more)

  // Use style.display, not the `hidden` attribute: .feed-panel-head sets
  // `display:flex`, which overrides `[hidden]`'s UA display:none.
  if (head) head.style.display = 'none'
  list.style.display = 'none'
  // Mount the reader as a sibling so closing simply removes it and restores
  // the list + head.
  ctx.readerEl = reader
  list.after(reader)

  // Keep the back pill beside the article column and visible while scrolling
  // (never above the article top). The ⋮ menu is NOT floating — it's pinned
  // absolutely at the article's top-right (see CSS) and scrolls away with it.
  const reposition = () => positionFloatingControls(reader, back)
  window.addEventListener('scroll', reposition, { passive: true })
  window.addEventListener('resize', reposition)
  ctx.floatCleanup = () => {
    window.removeEventListener('scroll', reposition)
    window.removeEventListener('resize', reposition)
  }

  try { panel.scrollIntoView({ block: 'start' }) } catch {}
  reposition()
  try { back.focus({ preventScroll: true }) } catch {}
}

// Constants for the floating controls.
const FLOAT_TOP = 14   // px it sticks to below the viewport top once scrolled
const FLOAT_GAP = 12   // gap between the article column and a gutter control
const FLOAT_EDGE = 12  // min margin from the screen edge (overlay fallback)

// Position the floating back pill each frame. Vertical: track the article top
// but stick at FLOAT_TOP once scrolled, and never rise above the article's own
// top (so it doesn't float over content above it). Horizontal: sit in the
// article's left gutter on wide screens; when the gutter is too narrow (small
// window / mobile) overlay just inside the article's left edge — never shoved
// to the far screen edge. Always kept visible so you're never trapped.
function positionFloatingControls(reader, back) {
  const r = reader.getBoundingClientRect()
  const backW = back.offsetWidth || 130
  const top = Math.max(FLOAT_TOP, r.top)

  let backLeft = r.left - FLOAT_GAP - backW
  if (backLeft < FLOAT_EDGE) backLeft = Math.max(FLOAT_EDGE, r.left + FLOAT_EDGE)  // overlay inside

  back.style.top = top + 'px'
  back.style.left = backLeft + 'px'
}

function closeReader(ctx) {
  const { panel, list } = ctx
  const head = panel.querySelector('.feed-panel-head')
  if (ctx.floatCleanup) { ctx.floatCleanup(); ctx.floatCleanup = null }
  if (ctx.readerEl) { ctx.readerEl.remove(); ctx.readerEl = null }
  if (head) head.style.display = ''
  list.style.display = ''
  // Return to where the reader was opened from (#1) — the list still holds all
  // its cards (it was only display:none'd), so the scroll height is restored.
  try { window.scrollTo(0, ctx.savedScrollY || 0) } catch {}
}

// "Include short articles" switch for the panel head. Off by default: the feed
// hides sub-SHORT_MAX bodies (mostly threads/notes); on shows everything.
function shortToggle(state, onChange) {
  const input = h('input', { type: 'checkbox', class: 'feed-toggle-input', role: 'switch' })
  input.checked = state.includeShort
  input.addEventListener('change', () => { state.includeShort = input.checked; onChange() })
  return h('label', { class: 'feed-toggle' }, [
    input,
    h('span', { class: 'feed-toggle-track', 'aria-hidden': 'true' }, h('span', { class: 'feed-toggle-thumb' })),
    h('span', { class: 'feed-toggle-label', text: 'Include short articles' }),
  ])
}

// Drop the toggle into the panel head (hiding the unused count pill).
function mountToolbar(panel, els) {
  const head = panel.querySelector('.feed-panel-head')
  if (!head) return
  const count = head.querySelector('.feed-count')
  if (count) count.hidden = true
  head.querySelector('.art-toolbar')?.remove()
  head.appendChild(h('div', { class: 'art-toolbar' }, els))
}

// ── Entry point ──────────────────────────────────────────────────────
export async function renderArticles({ panel, list }) {
  let data
  try {
    const resp = await fetch(API_URL, { headers: { Accept: 'application/json' } })
    if (!resp.ok) throw new Error('HTTP ' + resp.status)
    data = await resp.json()
  } catch (e) {
    console.error('[articles] fetch failed', e)
    renderPlaceholder(list, 'Couldn’t load articles', 'The community articles feed is unavailable right now — please try again later.')
    return
  }

  const articles = buildArticles(data)
  if (!articles.length) {
    renderPlaceholder(list, 'No articles yet', 'When the community publishes a long-form article on Nostr, it’ll show up here.')
    return
  }

  const ctx = { panel, list, readerEl: null }
  const onOpen = (a) => openReader(ctx, a)

  // Pre-warm the login widget in the background so the first reply/like/repost/
  // zap in a reader doesn't pay the cold-start cost, and wire the shared action
  // handlers (which also hydrate the user's existing likes/reposts). Deferred so
  // it doesn't compete with first paint.
  setTimeout(() => {
    ensureWidgetLoaded()
      .then(() => { try { configureBoostActions({}) } catch {} })
      .catch(() => {})
  }, 1200)

  // Names/avatars enrich the cards but shouldn't gate first paint — render with
  // initials now, repaint once author profiles resolve.
  const profilesReady = loadAuthorProfiles(articles)

  // Default view hides short (<SHORT_MAX) bodies; the toggle shows everything.
  const state = { includeShort: false }
  const matches = (a) => state.includeShort || a.content.length >= SHORT_MAX

  let view = articles
  let shown = 0
  const cards = h('div', { class: 'art-list' })
  const moreWrap = h('div', { class: 'art-more-wrap' })

  function renderMore() {
    const next = view.slice(shown, shown + INITIAL_CARDS)
    for (const a of next) cards.appendChild(articleCard(a, onOpen))
    shown += next.length
    moreWrap.innerHTML = ''
    const remaining = view.length - shown
    const hidden = articles.length - view.length
    if (remaining > 0) {
      const batch = Math.min(INITIAL_CARDS, remaining)
      moreWrap.appendChild(h('div', { class: 'art-more-group' }, [
        h('button', { class: 'art-showmore', type: 'button', onclick: renderMore }, `Load ${batch} more article${batch === 1 ? '' : 's'}`),
        h('div', { class: 'art-more-count', text: `Showing ${shown} of ${view.length}${hidden ? ` (${hidden} short hidden)` : ''}` }),
      ]))
    } else if (hidden) {
      moreWrap.appendChild(h('div', { class: 'art-more-count', text: `${view.length} shown · ${hidden} short hidden` }))
    }
  }

  function rerender() {
    view = articles.filter(matches)
    shown = 0
    cards.innerHTML = ''
    renderMore()
  }

  mountToolbar(panel, [shortToggle(state, rerender)])

  list.className = ''
  list.style.display = ''
  list.innerHTML = ''
  list.append(cards, moreWrap)
  rerender()

  // Author names/avatars resolve async — repaint cards in place once resolved.
  profilesReady.then(() => repaintCards(cards))
}
