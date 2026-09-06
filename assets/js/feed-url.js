/* The feeds' share of the homepage URL.
 *
 * Since feeds-homepage (lb-v80) the community feeds live on `/`, and what a
 * reader is looking at is spelled out in the URL so it can be shared:
 *
 *   /?feed=podcasts&view=all&range=1m&sort=sats#feeds
 *
 * `#feeds` names the section (the inline controller in index.html scrolls to
 * it); `feed` and `view` (featured | all) are the tab and sub-tab; the rest
 * are whatever controls the active feed's All view carries — `range`, `sort`,
 * `type` (events), `short` (articles). A key that is absent means the feed's
 * own default, so a renderer never has to publish its opening state.
 *
 * The URL itself is written by the inline controller, which owns the tab and
 * sub-tab state and remembers each feed's params so switching tabs and back
 * restores them. A renderer only does two things with this module: read its
 * opening params once (initialFeedParams), and announce a change the reader
 * made (publishFeedParams). It never touches history itself.
 *
 * This is a NEW module on purpose rather than exports added to feeds.js: every
 * renderer imports it, assets are cached for hours per URL, and a named import
 * that an older cached copy of a shared module lacks is a link-time error that
 * takes every feed down at once. A new URL can only resolve or 404.
 */

export const FEED_PARAM_KEYS = ['range', 'sort', 'type', 'short']

/**
 * The params the URL carries for `feed`, or {} — including when the URL names
 * a different feed, since `range=1m` on the podcasts feed says nothing about
 * the events feed's range.
 */
export function initialFeedParams(feed) {
  let q
  try { q = new URLSearchParams(location.search) } catch { return {} }
  if ((q.get('feed') || '') !== feed) return {}
  const out = {}
  for (const k of FEED_PARAM_KEYS) {
    const v = q.get(k)
    if (v) out[k] = v
  }
  return out
}

/** `value` if it is one of `allowed`, else `fallback`. For reading a param. */
export function pickParam(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * Tell the controller the reader changed one of this feed's controls. An
 * empty-string value drops the key from the URL (back to the default).
 */
export function publishFeedParams(feed, params) {
  try {
    document.dispatchEvent(new CustomEvent('lb:feed-params', { detail: { feed, params: params || {} } }))
  } catch {}
}
