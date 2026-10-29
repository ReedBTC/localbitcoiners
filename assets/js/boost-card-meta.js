/* The boost card's meta row: sats, the app, the episode. Pure, no DOM.
 *
 * The OnlyBoosts card (Reed's call, 2026-10-29): under the booster's name a
 * second row says how much, from which app, and WHICH EPISODE BY TITLE, the
 * title linking to the episode's page; the message is the third row. A
 * Fountain donor note says none of that itself (its text is the comment, its
 * only episode reference the NIP-73 guid), so every part of this row comes
 * off the wall record's payment meta (boost-record.js#parseWallRecord).
 *
 * A NEW module rather than a new export on boost-record.js, for the reason
 * feed-url.js and boost-record.js exist: a named export added to a cached
 * shared module is a link-time error on every page that imports it. The
 * older `metaStripParts` stays on boost-record.js for any stale importer and
 * is no longer what the renderer reads.
 *
 * ⚠️ The episode title in the record is the feed's own, which on this show is
 * `Local Bitcoiners • <name> | Ep. NNN` (episode 1: `Local Bitcoiners • 001.
 * <name>`). The show name is the page's subject on every surface these cards
 * render on, so it is cut from the front; the rest is the episode's name as
 * published, number and all, the way OnlyBoosts leaves a publisher's title
 * to speak for itself.
 */

const SHOW_PREFIX_RE = /^\s*Local Bitcoiners\s*(?:(?:[•·|:\-–—]\s*)+|$)/i

/** The episode title as the card prints it: the show-name prefix cut, else verbatim. */
export function episodeDisplayTitle(title) {
  if (typeof title !== 'string') return ''
  return title.replace(SHOW_PREFIX_RE, '').trim()
}

/** `/ep034` for a record on episode 34, or null without an episode number. */
export function episodeHrefOf(meta) {
  const n = parseInt(meta?.episodeNum, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return `/ep${String(n).padStart(3, '0')}`
}

/**
 * The row's parts, or null when the record carries no sats (a card without
 * payment meta prints no row at all, as before).
 *
 *   sats       "2,100 sats"
 *   via        "via Fountain" or null when the app is unknown
 *   episode    { label, href, num } or null; `withEpisode: false` leaves it
 *              out on the episode's own page, where the title would restate
 *              the page heading (the OnlyBoosts /episode rule)
 *   showBoost  true on a show-level boost (no episode to name)
 */
export function metaRowOf(meta, { withEpisode = true } = {}) {
  if (!meta || !Number.isFinite(meta.sats)) return null
  const row = {
    sats: `${meta.sats.toLocaleString('en-US')} sats`,
    via: meta.app ? `via ${meta.app}` : null,
    episode: null,
    showBoost: false,
  }
  if (meta.episodeNum) {
    if (withEpisode) {
      const n = parseInt(meta.episodeNum, 10)
      const num = Number.isFinite(n) ? n : null
      const numLabel = num !== null ? `Ep. ${num}` : `Ep. ${meta.episodeNum}`
      // A record with a number but no usable title falls back to the number,
      // which is what the row printed before titles were shown.
      const title = episodeDisplayTitle(meta.episodeTitle)
      row.episode = { label: title || numLabel, href: episodeHrefOf(meta), num }
    }
  } else if (meta.showLevel) {
    row.showBoost = true
  }
  return row
}
