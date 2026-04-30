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
 * Format the episode tag we send in the LNURL comment. Three-digit
 * zero-padded so bots can match on a fixed regex:
 *   /^LocalBitcoinersEp(\d{3})$/
 *
 * Examples:
 *   8   -> "LocalBitcoinersEp008"
 *   42  -> "LocalBitcoinersEp042"
 *   0/null -> "LocalBitcoinersEp000" (defensive default; payment still
 *   succeeds and the kind 30078 carries the real number, but the bot's
 *   fast filter won't fire — caller should always pass a real number).
 */
export function formatEpisodeComment(episodeNumber) {
  const n = parseInt(episodeNumber, 10)
  if (!Number.isFinite(n) || n <= 0) return 'LocalBitcoinersEp000'
  return `LocalBitcoinersEp${String(n).padStart(3, '0')}`
}
