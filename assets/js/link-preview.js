/* Inline media and link-preview cards under the links in a note.
 *
 * A NEW module on purpose (boosts-thread.js is shared and cached; the pure
 * decisions live in note-media.js). Two builders and one lazy fetcher:
 *
 *   buildMediaEl(url, kind)      an <img> or <video> for a picture or clip
 *                                the note links to (a GIF, a screenshot, an
 *                                mp4), bounded by CSS, linking to the file
 *   attachLinkPreview(host, url) a placeholder that becomes a card (thumbnail,
 *                                site, title, description) once the card is
 *                                near the viewport and /api/link-preview has
 *                                answered; removed on a miss, so a link whose
 *                                page has no title costs nothing visible
 *
 * The fetch is one GET per distinct URL per page load, deferred by an
 * IntersectionObserver (400 px ahead) so a wall of 400 cards does not fire
 * 400 requests at once; answers are memoised in memory and in sessionStorage
 * for the day. An answer of kind "image" (the URL serves a picture but has no
 * extension) turns the placeholder into media instead of a card.
 *
 * Everything from the endpoint is untrusted: text goes through textContent,
 * the image URL through isSafeUrl before <img>, and nothing near innerHTML.
 */

const ENDPOINT = '/api/link-preview'
const STORE_PREFIX = 'lb:lp:'
const STORE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

const memo = new Map()

function isSafeUrl(url) {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

export function buildMediaEl(url, kind) {
  const fig = document.createElement('span')
  fig.className = 'note-media is-' + kind
  if (kind === 'video') {
    const v = document.createElement('video')
    v.src = url
    v.controls = true
    v.preload = 'metadata'
    v.playsInline = true
    v.setAttribute('playsinline', '')
    fig.appendChild(v)
    return fig
  }
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  const img = document.createElement('img')
  img.src = url
  img.alt = ''
  img.loading = 'lazy'
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  // A dead image (hotlink block, deleted upload) falls back to the plain
  // link, which is what the note showed before this module existed.
  img.onerror = () => {
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = url
    fig.replaceWith(link)
  }
  a.appendChild(img)
  fig.appendChild(a)
  return fig
}

function readStore(url) {
  try {
    const raw = sessionStorage.getItem(STORE_PREFIX + url)
    if (!raw) return null
    const rec = JSON.parse(raw)
    if (!rec || typeof rec !== 'object' || (Date.now() - (rec.at || 0)) > STORE_TTL_MS) return null
    return rec.data || null
  } catch { return null }
}

function writeStore(url, data) {
  try { sessionStorage.setItem(STORE_PREFIX + url, JSON.stringify({ at: Date.now(), data })) } catch {}
}

async function fetchPreview(url) {
  const stored = readStore(url)
  if (stored) return stored
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT + '?url=' + encodeURIComponent(url), { signal: ctrl.signal })
    if (!res.ok) return { kind: 'none' }
    const data = await res.json()
    const out = (data && typeof data === 'object' && typeof data.kind === 'string') ? data : { kind: 'none' }
    writeStore(url, out)
    return out
  } catch {
    return { kind: 'none' }
  } finally {
    clearTimeout(timer)
  }
}

export function previewFor(url) {
  if (!memo.has(url)) memo.set(url, fetchPreview(url))
  return memo.get(url)
}

function buildCard(data) {
  const a = document.createElement('a')
  a.className = 'link-preview'
  a.href = data.url && isSafeUrl(data.url) ? data.url : '#'
  a.target = '_blank'
  a.rel = 'noopener noreferrer'

  if (data.image && isSafeUrl(data.image)) {
    const img = document.createElement('img')
    img.className = 'lp-thumb'
    img.src = data.image
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    img.onerror = () => { img.remove(); a.classList.add('no-thumb') }
    a.appendChild(img)
  } else {
    a.classList.add('no-thumb')
  }

  const text = document.createElement('span')
  text.className = 'lp-text'
  const site = document.createElement('span')
  site.className = 'lp-site'
  site.textContent = String(data.siteName || data.host || '')
  text.appendChild(site)
  const title = document.createElement('span')
  title.className = 'lp-title'
  title.textContent = String(data.title || '')
  text.appendChild(title)
  if (data.description) {
    const desc = document.createElement('span')
    desc.className = 'lp-desc'
    desc.textContent = String(data.description)
    text.appendChild(desc)
  }
  a.appendChild(text)
  return a
}

let observer = null
function observe(el, onVisible) {
  if (typeof IntersectionObserver !== 'function') { onVisible(); return }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        const fn = entry.target.__lbOnVisible
        delete entry.target.__lbOnVisible
        if (typeof fn === 'function') fn()
      }
    }, { rootMargin: '400px 0px' })
  }
  el.__lbOnVisible = onVisible
  observer.observe(el)
}

// Appends a hidden placeholder to `host` and fills it in later. Returns the
// placeholder so a caller can style around it; the card replaces it in place.
export function attachLinkPreview(host, url) {
  if (!isSafeUrl(url)) return null
  const slot = document.createElement('span')
  slot.className = 'link-preview-slot'
  slot.hidden = true
  host.appendChild(slot)
  observe(slot, async () => {
    const data = await previewFor(url)
    if (!slot.isConnected) return
    if (data.kind === 'image' && isSafeUrl(data.url)) {
      slot.replaceWith(buildMediaEl(data.url, 'image'))
    } else if (data.kind === 'page' && data.title) {
      slot.replaceWith(buildCard(data))
    } else {
      slot.remove()
    }
  })
  return slot
}
