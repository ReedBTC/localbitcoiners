/* Featured Episodes — the data side of the Podcast Boosts tab's Featured section.
 *
 * The Featured Articles pattern on other podcasts' episodes, with one
 * difference in the plumbing: an episode has no naddr. A Feature boost names
 * it by its OnlyBoosts page instead
 * (`https://onlyboosts.social/episode/<item guid>`), which is the shareable
 * link for an episode anyway, and the sats-log bot parses that URL out of the
 * boost message the way it parses naddrs. The log row's coordinate is
 * `podcast:item:guid:<item guid>`; this module keys everything on it.
 *
 * The Feature boost pays the podcast itself: the show's reassignable split
 * leg becomes the podcast's own value block, split proportionally, using the
 * same Podcast Index value proxy the tab's Boost button uses. A podcast with no
 * payable value block gets the standard show splits and the modal says so.
 *
 * Episodes in the community-boosts snapshot render straight from it. A
 * featured episode the snapshot doesn't hold (featured through the Find modal,
 * or by a non-supporter) is backfilled from OnlyBoosts' index, which holds every
 * episode boosted on Nostr by anyone; Podcast Index answers the rest.
 *
 * Rendering lives in feeds-podcasts.js — this module resolves data and owns
 * the Feature action itself.
 */
import { fromApiValue, applyExternalOverrides } from '/assets/js/value-block.js'
import {
  fetchFeaturedSet,
  makeConfirmedStore,
  setPendingPromote,
  readPendingPromote,
  clearPendingPromote,
  openFeatureBoost,
} from '/assets/js/featured-shared.js'

export { readPendingPromote, clearPendingPromote }

const OB_EPISODE_BASE = 'https://onlyboosts.social/episode/'
const COORD_PREFIX = 'podcast:item:guid:'
const VALUE_API = '/api/value'
const OB_EPISODE_API = '/api/onlyboosts-episode'
const PI_API = '/api/podcast-index'
const LOOKUP_TIMEOUT_MS = 6000

export function episodeCoord(guid) {
  return COORD_PREFIX + String(guid || '')
}

export function isEpisodeCoord(coordinate) {
  return typeof coordinate === 'string' && coordinate.startsWith(COORD_PREFIX) && coordinate.length > COORD_PREFIX.length
}

export function guidFromCoord(coordinate) {
  return isEpisodeCoord(coordinate) ? coordinate.slice(COORD_PREFIX.length) : ''
}

// ⚠️ ENCODED, NEVER PARSED. Item guids are opaque and 9% of them contain a
// slash (some are full URLs); OnlyBoosts binds the encoded form as one path
// segment and decodes it on its side. Mirror of the bot's parse.
export function onlyBoostsEpisodeUrl(guid) {
  return OB_EPISODE_BASE + encodeURIComponent(String(guid || ''))
}

export function fetchFeaturedEpisodeSet() {
  return fetchFeaturedSet((r) => isEpisodeCoord(r.coordinate), { tag: 'podcasts' })
}

// ── Optimistic featured set ──────────────────────────────────────────
// `extra` carries what the tab needs to render a just-featured episode before
// the log records it: the feed id (for the value block) and, for an episode
// found through the Find modal, the episode + show records themselves.
const confirmed = makeConfirmedStore('lb_featured_episodes_confirmed', isEpisodeCoord)
export const readConfirmedFeaturedEpisodes = confirmed.read
export function addConfirmedFeaturedEpisode(coord, extra = null) {
  return confirmed.add(coord, extra, '')
}

// ── Lookups ──────────────────────────────────────────────────────────
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

async function getJson(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error(url + ' ' + resp.status)
  const data = await resp.json()
  if (data && data.error) throw new Error(data.error)
  return data
}

/**
 * The podcast's payable value block for this episode (episode-level, else
 * feed-level), as the widget's recipients bundle, or null when there is none.
 * Same proxy + normalization as the tab's Boost button, so a Feature boost
 * pays exactly what a boost from here would.
 */
export async function resolveEpisodeSplit(feedId, guid) {
  if (!feedId) return null
  const url = `${VALUE_API}?feedId=${encodeURIComponent(feedId)}` + (guid ? `&guid=${encodeURIComponent(guid)}` : '')
  const data = await withTimeout(getJson(url), LOOKUP_TIMEOUT_MS, null)
  const parsed = fromApiValue(data)
  if (!parsed) return null
  const recipients = applyExternalOverrides(parsed.recipients)
  const totalWeight = recipients.reduce((a, r) => a + (r.splitWeight || 0), 0)
  if (!recipients.length || totalWeight <= 0) return null
  return { recipients, totalWeight }
}

/** OnlyBoosts' record for one episode → { episode, show } or null. */
export async function fetchEpisodeFromOnlyBoosts(guid) {
  const data = await withTimeout(getJson(`${OB_EPISODE_API}?guid=${encodeURIComponent(guid)}`), LOOKUP_TIMEOUT_MS, null)
  return data && data.episode ? { episode: data.episode, show: data.show || null } : null
}

/** Podcast Index feed record by podcast guid → the snapshot's show shape, or null. */
export async function fetchShowByPodcastGuid(podcastGuid) {
  if (!podcastGuid) return null
  const data = await withTimeout(getJson(`${PI_API}?op=show&podcastGuid=${encodeURIComponent(podcastGuid)}`), LOOKUP_TIMEOUT_MS, null)
  return data && data.show ? data.show : null
}

/** Podcast Index search: shows matching a term. */
export async function searchShows(term) {
  const data = await getJson(`${PI_API}?op=search&q=${encodeURIComponent(term)}`)
  return Array.isArray(data?.shows) ? data.shows : []
}

/** Podcast Index: a show's recent episodes, newest first. */
export async function listEpisodes(feedId) {
  const data = await getJson(`${PI_API}?op=episodes&feedId=${encodeURIComponent(feedId)}`)
  return Array.isArray(data?.episodes) ? data.episodes : []
}

// ── The Feature action ───────────────────────────────────────────────
// Same prose shape as the other tabs' Feature; the episode's OnlyBoosts URL
// stands where their naddr does, and the bot logs it the same way.
const FEATURE_TEMPLATE = 'Boosting this episode from https://localbitcoiners.com/feeds'

/**
 * Open the show-boost modal with the episode's OnlyBoosts URL prefilled and
 * the third split leg pointed at the podcast's value block.
 *   guid       the RSS item guid
 *   feedId     Podcast Index feed id (for the value block); may be null
 *   showTitle  for the modal's copy
 *   extra      stashed with the pending/confirmed record for the tab's
 *              optimistic render (episode + show records for a Find result)
 */
export async function featureEpisode({ guid, feedId = null, showTitle = '', extra = null }, onFail) {
  if (!guid) { onFail?.('This episode has no guid to feature'); return }
  const coord = episodeCoord(guid)
  try {
    const split = feedId ? await resolveEpisodeSplit(feedId, guid) : null
    setPendingPromote(coord, { guid, feedId, extra })
    const prefillMessage = `${FEATURE_TEMPLATE}\n\n${onlyBoostsEpisodeUrl(guid)}`
    await openFeatureBoost({
      prefillMessage,
      feature: {
        kind: 'episode',
        name: showTitle || '',
        recipients: split ? split.recipients : null,
      },
    }, onFail)
  } catch (e) {
    console.error('[podcasts] feature failed', e)
    onFail?.('Something went wrong — please try again')
  }
}
