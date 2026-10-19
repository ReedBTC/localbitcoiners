/* Episode-page boost section.
 *
 * Fetches the show-wide boost mega-thread, filters its direct replies
 * to the ones whose content carries an episode marker matching this
 * page's data-ep-num, and renders each match as a card. Replies to those
 * boosts are not shown.
 *
 * Hooks the shared boost-actions module in so cards get the same
 * Reply/Repost/Like/Zap bar /boosts.html shows. The login widget is
 * eager-loaded (see middleware), so action buttons are responsive
 * without per-click spinners.
 */
import {
  fetchBoostThread,
  renderNoteCard,
  getBoostMeta,
} from '/assets/js/boosts-thread.js'
import { episodeNumMatches, boostTimeOf } from '/assets/js/boost-record.js'
import { configureBoostActions } from '/assets/js/boost-actions.js'

(async function init() {
  const section = document.querySelector('.ep-boosts[data-ep-num]')
  if (!section) return

  const status = section.querySelector('[data-ep-boosts-status]')
  const list   = section.querySelector('[data-ep-boosts-list]')
  if (!status || !list) return

  const epNum = parseInt(section.dataset.epNum, 10)
  if (!Number.isFinite(epNum) || epNum <= 0) {
    section.remove()
    return
  }

  // Paint as soon as the thread is built rather than waiting for quoted
  // notes and calendar cards to resolve — measured at ~1.3s against ~4.6s
  // on the full wall. This page filters to one episode, so it usually shows
  // a handful of cards, and they are all present at the partial stage.
  let painted = false
  const showPartial = ({ rootEvent, childrenOf }) => {
    configureBoostActions({
      rootEvent, childrenOf,
      rerender: () => repaint(rootEvent, childrenOf, epNum, status, list),
    })
    repaint(rootEvent, childrenOf, epNum, status, list)
    painted = true
  }

  let result
  try {
    result = await fetchBoostThread({ onPartial: showPartial })
  } catch (e) {
    console.warn('[ep-boosts] fetch failed', e)
    if (!painted) status.textContent = 'Couldn\'t load boosts right now — try again later.'
    return
  }

  if (result.error || !result.rootEvent) {
    // Only surface the error if nothing rendered; a partial paint means the
    // boosts are on screen and only enrichment failed.
    if (!painted) status.textContent = 'Couldn\'t load boosts right now — try again later.'
    return
  }

  // Hand state + repaint to boost-actions BEFORE rendering — that's
  // when actionsBuilder gets registered with the renderer, so every
  // card we paint below gets the Reply/Repost/Like/Zap bar.
  configureBoostActions({
    rootEvent: result.rootEvent,
    childrenOf: result.childrenOf,
    rerender: () => repaint(result.rootEvent, result.childrenOf, epNum, status, list),
  })

  repaint(result.rootEvent, result.childrenOf, epNum, status, list)
})().catch((err) => {
  console.error('[ep-boosts] init failed', err)
})

function repaint(rootEvent, childrenOf, epNum, statusEl, listEl) {
  // The episode comes from the wall record's episode_num (a zero-padded
  // string; episodeNumMatches normalises it). The card may show the
  // booster's own note, which names no episode, so the 🎙️-line regex that
  // used to do this is now only the fallback for events without a record
  // (relay fallback, hand-published corrections). Anchors are direct
  // replies under the root; replies to those boosts are intentionally
  // not rendered.
  const directReplies = childrenOf.get(rootEvent.id) || []
  const anchors = directReplies.filter((ev) => episodeNumMatches(ev, getBoostMeta(ev.id), epNum))

  listEl.innerHTML = ''

  if (!anchors.length) {
    if (statusEl && !statusEl.isConnected) {
      // status was removed on a prior paint — put it back so a fresh
      // login switch that wipes anchors still shows the empty message.
      listEl.parentNode.insertBefore(statusEl, listEl)
    }
    if (statusEl) {
      statusEl.textContent = 'No boosts on this episode yet — be the first.'
      statusEl.style.display = ''
    }
    return
  }

  if (statusEl && statusEl.isConnected) statusEl.remove()

  // Newest boost first by settled time (the show note's publish time for
  // events without a record), never by the shown note's created_at.
  anchors.sort((a, b) => boostTimeOf(b, getBoostMeta(b.id)) - boostTimeOf(a, getBoostMeta(a.id)))

  const ul = document.createElement('ul')
  ul.className = 'note-list ep-boosts-anchors'
  for (const ev of anchors) {
    const li = document.createElement('li')
    li.appendChild(renderNoteCard(ev))
    ul.appendChild(li)
  }
  listEl.appendChild(ul)
}
