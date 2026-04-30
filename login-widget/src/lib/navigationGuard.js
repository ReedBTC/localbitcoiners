/**
 * Same-origin anchor click interceptor for in-flight boosts.
 *
 * Most browsers ignore the boostQueue's beforeunload guard for ordinary
 * same-origin link clicks (the guard fires on tab close / back / typed
 * URL but is treated as no-op for normal anchor navigation). Without
 * this module, a user who clicks Boost and then immediately clicks a
 * nav link reloads the page mid-publish, killing the WebSocket before
 * the relay acks.
 *
 * Behavior: when an in-flight boost exists, hold the navigation up to
 * 2s waiting for the queue to drain, then navigate. The
 * BoostProgressBanner is already glowing at the top of the page during
 * this window, so the brief delay reads as "page is finishing
 * something" rather than a broken link.
 *
 * The hold is bypassed entirely (no preventDefault) for:
 *   - cross-origin / non-http(s) links
 *   - target="_blank" / target outside [_self, ""]
 *   - download attribute set
 *   - modifier-key clicks (cmd/ctrl/shift/alt) and non-left-button clicks
 *   - same-page hash anchors (no reload, nothing to guard)
 *   - clicks where another handler already called preventDefault
 *
 * Impatient-second-click escape hatch: if a hold is already in
 * progress and the user clicks again, we abort the hold and let the
 * new click navigate normally — they're telling us they want to leave.
 */

import { onInFlightChange, hasActive } from './boostQueue.js'

const HOLD_MS = 2000

let activeHold = null

function releaseHold() {
  if (!activeHold) return
  if (activeHold.unsub) { try { activeHold.unsub() } catch {} }
  if (activeHold.timer) clearTimeout(activeHold.timer)
  activeHold = null
}

function findAnchor(target) {
  if (!target || !target.closest) return null
  return target.closest('a[href]')
}

function isInterceptable(a) {
  // target other than self
  const t = a.getAttribute('target')
  if (t && t !== '' && t !== '_self') return false
  if (a.hasAttribute('download')) return false

  let url
  try {
    url = new URL(a.href, window.location.href)
  } catch {
    return false
  }
  if (!/^https?:$/.test(url.protocol)) return false
  if (url.origin !== window.location.origin) return false

  // Same-page hash anchor — browser scrolls without unloading, so the
  // boost JS context survives. Don't intercept.
  const sameDoc = url.pathname === window.location.pathname
                && url.search === window.location.search
  if (sameDoc && url.hash) return false

  return true
}

function onClick(e) {
  if (e.defaultPrevented) return
  if (e.button !== 0) return
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

  const a = findAnchor(e.target)
  if (!a) return
  if (!isInterceptable(a)) return

  if (activeHold) {
    // Second click while we're already holding — user wants to leave.
    // Drop our hold so the browser navigates without a stale timer
    // racing the new navigation.
    releaseHold()
    return
  }

  if (!hasActive()) return

  e.preventDefault()
  const targetHref = a.href
  const hold = {}

  const finish = () => {
    if (activeHold !== hold) return
    releaseHold()
    window.location.href = targetHref
  }

  hold.unsub = onInFlightChange(() => {
    // Drain on "no still-processing entries" — settled-but-lingering
    // entries shouldn't keep holding navigation.
    if (!hasActive()) finish()
  })
  hold.timer = setTimeout(finish, HOLD_MS)
  activeHold = hold

  // Queue may have drained between hasActive() and onInFlightChange.
  if (!hasActive()) finish()
}

export function installNavigationGuard() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__lbBoostNavGuardInstalled) return
  window.__lbBoostNavGuardInstalled = true
  // Capture phase so we run before any in-page handlers; for this static
  // site there aren't any router-style click interceptors to coordinate
  // with, so capture is purely a "be early" choice.
  document.addEventListener('click', onClick, true)
}

installNavigationGuard()
