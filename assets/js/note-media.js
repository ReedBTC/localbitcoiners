/* What a bare URL inside a note is, before anything is painted.
 *
 * A NEW module on purpose: boosts-thread.js is shared and cached, and these
 * are pure string functions the Node tests (scripts/test-note-media.mjs) run
 * without a DOM. The renderer asks three things of a link token:
 *
 *   mediaKindOf(url, imeta)   'image' | 'video' | null — paint it inline?
 *   splitTrailingPunct(raw)   the URL without the sentence's full stop
 *   linkLabel(url)            the short text the anchor shows
 *
 * The decision is by file extension first and by the note's NIP-92 `imeta`
 * tags second (a client that attaches an image says `m image/png` beside the
 * url, which is how an extension-less upload is still known to be a picture).
 * Anything else stays a link, and the link-preview module decides whether a
 * card can be fetched for it.
 */

const IMAGE_EXT_RE = /\.(?:gif|png|jpe?g|webp|avif)$/i
const VIDEO_EXT_RE = /\.(?:mp4|webm|m4v|mov)$/i

// Sentence punctuation glued to the end of a URL is not part of it:
// "see https://example.com/page." should link to /page, and the full stop
// stays in the text after the anchor. A closing paren is already excluded by
// the tokenizer's URL pattern, so this is the trailing-dot family only.
const TRAILING_PUNCT_RE = /[.,;:!?'"]+$/

export function splitTrailingPunct(raw) {
  const s = String(raw || '')
  const m = s.match(TRAILING_PUNCT_RE)
  if (!m) return { url: s, tail: '' }
  return { url: s.slice(0, m.index), tail: m[0] }
}

function pathnameOf(url) {
  try { return new URL(url).pathname } catch { return '' }
}

// The note's imeta tags as a Map of url → { mime, dim }. Tags are
// `['imeta', 'url https://…', 'm image/png', 'dim 1200x300', …]`, one tag per
// attachment; a tag without a url is skipped.
export function imetaMapOf(tags) {
  const map = new Map()
  if (!Array.isArray(tags)) return map
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'imeta') continue
    let url = ''
    const info = {}
    for (const field of tag.slice(1)) {
      if (typeof field !== 'string') continue
      const sp = field.indexOf(' ')
      if (sp < 1) continue
      const key = field.slice(0, sp)
      const val = field.slice(sp + 1).trim()
      if (key === 'url') url = val
      else if (key === 'm') info.mime = val.toLowerCase()
      else if (key === 'dim') info.dim = val
    }
    if (url) map.set(url, info)
  }
  return map
}

export function mediaKindOf(url, imeta = null) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  const path = pathnameOf(url)
  if (IMAGE_EXT_RE.test(path)) return 'image'
  if (VIDEO_EXT_RE.test(path)) return 'video'
  const info = imeta && typeof imeta.get === 'function' ? imeta.get(url) : null
  const mime = info?.mime || ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return null
}

// The anchor's text: host and path without the scheme or a leading www.,
// cut to `max` characters. The href keeps the whole URL; this is only what
// the reader sees in place of a 200-character query string.
export function linkLabel(url, max = 48) {
  let s = String(url || '')
  try {
    const u = new URL(s)
    const bare = u.pathname === '/' && !u.search && !u.hash
    s = u.host.replace(/^www\./i, '') + (bare ? '' : u.pathname) + u.search + u.hash
  } catch {
    s = s.replace(/^https?:\/\/(?:www\.)?/i, '')
  }
  s = s.replace(/\/$/, '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
