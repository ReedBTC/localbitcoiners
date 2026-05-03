/**
 * Episode-related helpers used by the multi-leg boost flow.
 *
 * Note on parsing: there used to be a `parseSplits` / `parseEpisodeMeta`
 * pair here that mirrored the inline parser in `index.html`. They were
 * never wired (the home page does its own parsing because it runs
 * before the widget bundle loads, and `payAllLegs.js` only consumes
 * already-parsed splits via the LBLogin API). Removed to avoid
 * carrying two copies of the same logic that could drift over time.
 *
 * `formatEpisodeComment` lives here rather than in `payAllLegs.js`
 * because the format is part of the wire contract with the receiving
 * bot — keeping it in a small, named helper makes the contract easy
 * to find and update.
 */

/**
 * Format the episode tag we send in the LNURL comment. Bots can
 * match on a fixed regex:
 *   /^LocalBitcoiners(Show|Ep\d{3})$/
 *
 * Examples:
 *   8       -> "LocalBitcoinersEp008"
 *   42      -> "LocalBitcoinersEp042"
 *   null    -> "LocalBitcoinersShow"   (show-level boost from the
 *              site's "Boost the Show" button; no episode context)
 */
export function formatEpisodeComment(episodeNumber) {
  if (episodeNumber == null) return 'LocalBitcoinersShow'
  const n = parseInt(episodeNumber, 10)
  if (!Number.isFinite(n) || n <= 0) return 'LocalBitcoinersShow'
  return `LocalBitcoinersEp${String(n).padStart(3, '0')}`
}
