/**
 * Background boost orchestration.
 *
 * Send-and-forget: the modal closes when the user clicks Boost,
 * payAllLegs runs in the background here, and that's it. Outcomes
 * aren't persisted — the dropdown surfaces in-flight entries with a
 * "Sending…" indicator that vanishes once the boost settles.
 *
 * One exception to silence: when EVERY leg fails (likely a wallet-
 * side problem the user can act on), we fire a one-shot toast so
 * a first-time-with-this-wallet user isn't left wondering whether
 * anything happened. Partial failures stay quiet.
 *
 * Trade-offs accepted:
 *   - Page navigation mid-boost interrupts the JS context. Whatever
 *     legs already paid + their kind 30078s are settled; in-progress
 *     legs may not complete. The kind 30078 publishes happen BEFORE
 *     each leg's payment, so there's never metadata without payment;
 *     only ever a paid leg or none. The beforeunload guard below
 *     gives the user a chance to wait if they were about to navigate.
 */

import { payAllLegs } from './payAllLegs.js'
import { SITE_URL } from './boostagram.js'
import { pushToast } from './toast.js'

const MIN_TOTAL_SATS = 1   // floor; modals enforce a higher minimum
const inFlight = new Map()   // localSessionId → { sessionId, episode, totalSats, startedAt }
const listeners = new Set()
let nextLocalCounter = 0

function notify() {
  const list = Array.from(inFlight.values())
  for (const fn of listeners) {
    try { fn(list) } catch {}
  }
}

/** Subscribe to in-flight set changes. Returns an unsubscribe fn. */
export function onInFlightChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot of currently-running boosts. */
export function getInFlight() {
  return Array.from(inFlight.values())
}

// beforeunload guard — installed once at module load. Browser shows
// the standard "leave site?" dialog when an in-flight boost is
// running, giving the user a chance to wait for it to settle. The
// dialog only triggers when inFlight has entries; otherwise it's a
// no-op pass-through.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (inFlight.size === 0) return
    // Modern browsers ignore the message and show their own generic
    // dialog, but setting returnValue (and returning a value) is the
    // standard incantation that triggers it across Chrome/Safari/FF.
    e.preventDefault()
    e.returnValue = ''
    return ''
  })
}

/**
 * Fire a boost in the background. Returns immediately — caller closes
 * its modal right after, payAllLegs runs to completion regardless.
 *
 * Validation: rejects nonsense input synchronously rather than
 * silently dropping it on the floor. Modals already validate before
 * calling, so this is defense-in-depth for any other future caller.
 *
 * @returns {boolean} true if the boost was queued, false if input
 *   failed validation.
 */
export function submitBoost({
  episode,
  splits,
  totalSats,
  message,
  donorNpub,
  lnurlCache,
  nwcClient,
}) {
  // Defensive validation. The modal already checks these, but if a
  // future caller passes garbage we'd rather refuse than crash inside
  // payAllLegs or send a malformed boost.
  if (!episode || typeof episode !== 'object') {
    console.warn('[boostQueue] submitBoost: missing episode metadata')
    return false
  }
  if (!splits || !Array.isArray(splits.recipients) || splits.recipients.length === 0) {
    console.warn('[boostQueue] submitBoost: empty or invalid recipients list')
    return false
  }
  const sats = Number(totalSats) || 0
  if (sats < MIN_TOTAL_SATS) {
    console.warn('[boostQueue] submitBoost: totalSats below minimum')
    return false
  }
  if (!nwcClient || typeof nwcClient.payInvoice !== 'function') {
    console.warn('[boostQueue] submitBoost: NWC client unavailable')
    return false
  }

  const localId = `local-${++nextLocalCounter}-${Date.now()}`
  inFlight.set(localId, {
    sessionId: localId,
    episode,
    totalSats: sats,
    startedAt: Date.now(),
  })
  notify()

  ;(async () => {
    let result = null
    try {
      result = await payAllLegs({
        recipients: splits.recipients,
        totalWeight: splits.totalWeight,
        totalMsats: sats * 1000,
        message,
        donorNpub,
        pageUrl: SITE_URL,
        episodeMeta: episode,
        nwcClient,
        lnurlCache,
      })
    } catch (e) {
      // payAllLegs is documented as never-throws; this is belt-and-
      // braces. Treat as all-failed for the toast logic below.
      console.warn('[boostQueue] payAllLegs threw unexpectedly', e)
    } finally {
      inFlight.delete(localId)
      notify()
    }

    // All-failed signal. Partial failures stay silent (Podcasting 2.0
    // doesn't surface them either) but a fully-failed boost likely
    // means a wallet problem the user can act on, so we fire a
    // single transient toast.
    if (!result || !result.anySucceeded) {
      pushToast({
        kind: 'error',
        message: 'Couldn\'t deliver your boost. Check that your wallet is connected and has a balance.',
      })
    }
  })()

  return true
}
