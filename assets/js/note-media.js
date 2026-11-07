/* What a bare URL inside a note is, before anything is painted.
 *
 * A NEW module on purpose: boosts-thread.js is shared and cached, and these
 * are pure string functions the Node tests (scripts/test-note-media.mjs) run
 * without a DOM. The renderer asks three things of a link token:
 *
 *   stripBoilerplate(text)    the note minus what the boosting app appended
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

/* App boilerplate comes off a note before it is tokenized (2026-11-07,
 * OnlyBoosts' rule carried over at Reed's ask: a boost card should look the
 * same on both sites). Measured on the 616 wall records that day, 597 carried
 * a URL and nearly every one was something an app appends to every note,
 * restating what the card already shows in its meta row:
 *
 *   - a SHARE-CARD IMAGE, a picture of the boost itself (`/og/boost.png` on
 *     BoostMeBuddy, BoostMeBitch and tardbox; imeta-tagged, so without this
 *     it would paint as a 1200x300 banner under the message);
 *   - an APP BANNER, the brand image a publisher opens its notes with
 *     (OnlyBoosts' two, this show's bot);
 *   - a LISTEN LINK to the boosted show or episode in some app: the bot's
 *     `🔗 https://fountain.fm/episode/…` line on every show note, the same
 *     link Fountain's donor notes end with, BoostMeBuddy's `?podcast=`,
 *     Podcast Index, pod.link, Castamatic, Podcast Guru, Podhome, Wavlake,
 *     OnlyBoosts, and this site's own bare `https://localbitcoiners.com`
 *     footer and `/ep###` pages. The meta row links the episode already.
 *
 * A share card or banner goes wherever it sits. A listen link goes only
 * when it is ALONE ON ITS LINE (a symbol or emoji in front allowed), which
 * is how every template writes it; one inside the booster's own sentence
 * ("Boosting this episode from https://localbitcoiners.com/feeds") is their
 * prose and stays. The "Find it on <app>" line some relay bots write above
 * their link goes with it. The 📅 / 📄 / 🛒 feature lines stay: they point
 * at the featured item, which the card does not otherwise link. The note
 * itself is untouched; this is only how it reads here, and the display text
 * the thread scanner reads for quoted notes is the unstripped one. */
const URL_SCAN_RE = /https?:\/\/[^\s<>"')\]]+/g
const SHARE_CARD_PATH_RE = /\/og\/boost\.png$/i
const APP_BANNERS = new Set([
  'https://i.nostr.build/iQ4vHJ88xTrGZ36eey9lWJ.png', // OnlyBoosts, a boost
  'https://i.nostr.build/QoXlTuDurz3b4EqNefAzoC.png', // OnlyBoosts, a donation
  'https://i.nostr.build/a6G5FkkfTlSyfJ7z.png',       // this show's bot
])
const LISTEN_LINK_RE = new RegExp('^https?://(?:www\\.)?(?:' + [
  'podcastindex\\.org/podcast/',
  'fountain\\.fm/(?:show|episode|track|album|artist)/',
  'boostmebuddy\\.com/\\?podcast=',
  'boostmebitch\\.com/\\?podcast=',
  'tardbox\\.com/boost/',
  'pod\\.link/',
  'castamatic\\.com/guid/',
  'app\\.podcastguru\\.io/podcast/',
  'serve\\.podhome\\.fm/episodepage/',
  'wavlake\\.com/(?:track|album)/',
  'onlyboosts\\.social/(?:episode|show)/',
  'localbitcoiners\\.com/?(?:ep\\d+/?)?$',
].join('|') + ')', 'i')
// A line that is nothing but a URL, with at most a symbol or emoji before it.
const LINK_LINE_RE = /^[^\p{L}\p{N}\s]*\s*(https?:\/\/\S+)\s*$/u
const FIND_IT_RE = /^\s*\S*\s*Find it on\b/i

function isBoilerplateImage(url) {
  if (APP_BANNERS.has(url)) return true
  try { return SHARE_CARD_PATH_RE.test(new URL(url).pathname) } catch { return false }
}

export function stripBoilerplate(text) {
  const src = String(text == null ? '' : text)
  if (!/https?:\/\//i.test(src)) return src
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const keep = []
  let changed = false
  for (const line of lines) {
    const m = line.match(LINK_LINE_RE)
    if (m && (LISTEN_LINK_RE.test(m[1]) || isBoilerplateImage(m[1]))) {
      if (keep.length && FIND_IT_RE.test(keep[keep.length - 1])) keep.pop()
      changed = true
      continue
    }
    keep.push(line)
  }
  let out = keep.join('\n')
  // A share card or banner mid-line (rare) goes too.
  out = out.replace(URL_SCAN_RE, (u) => (isBoilerplateImage(u) ? ((changed = true), '') : u))
  return changed ? out.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n').trim() : src
}
