/**
 * Background boost orchestration.
 *
 * The boost ALWAYS runs here, independent of the React tree — submitBoost
 * kicks off payAllLegs in a detached async task and returns immediately.
 * That independence is the safety net: even if the modal unmounts or the
 * user navigates, the legs already queued keep paying.
 *
 * The modal now stays open and watches the run live: submitBoost takes an
 * `onStatus` callback (forwarded straight into payAllLegs's per-leg status
 * stream) and returns a `{ localId, settled }` handle whose `settled`
 * promise resolves with the final payAllLegs result. The in-flight Map +
 * BoostProgressBanner + IdentityDropdown remain as the FALLBACK surface
 * for the (now rare) case where the user escapes the modal mid-boost.
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
import { SITE_URL, publishSignedKindOne, publishBoostReceipt } from './boostagram.js'
import { pushToast } from './toast.js'
import { withTimeout } from './utils.js'

const MIN_TOTAL_SATS = 1   // floor; modals enforce a higher minimum
// How long a settled entry hangs around in the dropdown after payAllLegs
// resolves, showing its final paid/partial/failed badge. Gives a user
// who opened the dropdown to watch the boost a beat to register the
// outcome before the row disappears.
const SETTLED_DISPLAY_MS = 7000
// How long to wait on the share-note publish before giving up on knowing its
// outcome. The receipt waits on this, so it's a bound on how late the receipt
// can be, not on the publish itself (which runs to completion regardless).
const SHARE_PUBLISH_TIMEOUT_MS = 10000
// Share outcome per boost session, so a RETRY's receipt repeats the parent
// boost's share result instead of contradicting it — a retry carries no share
// note of its own, and a receipt claiming the donor never posted would invite
// a second note published on their behalf. Bounded; entries are only ever read
// by a retry of the same boost, minutes later at most.
const shareOutcomes = new Map()   // boostSession → { noteId, status }
const MAX_SHARE_OUTCOMES = 50
const inFlight = new Map()   // localSessionId → { sessionId, episode, totalSats, startedAt, status, settledAt? }
const listeners = new Set()
let nextLocalCounter = 0

function rememberShareOutcome(session, outcome) {
  if (!session) return
  shareOutcomes.set(session, outcome)
  while (shareOutcomes.size > MAX_SHARE_OUTCOMES) {
    shareOutcomes.delete(shareOutcomes.keys().next().value)
  }
}

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

/** Snapshot of all visible boost entries — both still-processing and
 *  recently-settled (held for SETTLED_DISPLAY_MS so the dropdown can
 *  display a paid/partial/failed badge). Each entry has a `status`
 *  field consumers can read. */
export function getInFlight() {
  return Array.from(inFlight.values())
}

/** True if any entry is still actively processing (not just
 *  lingering after settle). Used by the navigation guard so settled
 *  entries don't keep holding nav clicks. */
export function hasActive() {
  return countActive() > 0
}

/** Count of entries still actively processing (status === 'in-flight'). */
function countActive() {
  let n = 0
  for (const entry of inFlight.values()) {
    if (entry.status === 'in-flight') n++
  }
  return n
}

// beforeunload guard — installed once at module load. Browser shows
// the standard "leave site?" dialog when an active boost is running,
// giving the user a chance to wait for it to settle. Settled entries
// (already paid/partial/failed, just lingering for the dropdown badge)
// don't trigger the prompt — there's nothing left to interrupt.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (countActive() === 0) return
    // Modern browsers ignore the message and show their own generic
    // dialog, but setting returnValue (and returning a value) is the
    // standard incantation that triggers it across Chrome/Safari/FF.
    e.preventDefault()
    e.returnValue = ''
    return ''
  })
}

/**
 * Fire a boost in the background. Returns immediately with a handle —
 * payAllLegs runs to completion regardless of what the caller does next.
 *
 * The caller (the boost modal) keeps itself open and renders live
 * progress by passing `onStatus` and awaiting the returned `settled`
 * promise. A caller that doesn't care can ignore both and let the
 * fallback banner/dropdown surface the outcome.
 *
 * Validation: rejects nonsense input synchronously rather than
 * silently dropping it on the floor. Modals already validate before
 * calling, so this is defense-in-depth for any other future caller.
 *
 * @param {function} [onStatus] (legIndex, legState) — forwarded into
 *   payAllLegs; fires on every per-leg state transition.
 * @returns {{ localId: string, settled: Promise<object|null> } | null}
 *   A handle whose `settled` resolves to the payAllLegs result (or null
 *   if it threw); or null if input failed validation.
 */
export function submitBoost({
  episode,
  splits,
  totalSats,
  amountTotalSats,  // optional parent boost total to REPORT (sats). Defaults to
                    // totalSats; set only on a retry, where totalSats is the
                    // failed leg's share but the reported total must stay the
                    // donor's full boost total.
  boostSession,     // optional session id to reuse (retry threads the parent's in)
  message,
  donorNpub,
  lnurlCache,
  wallet,           // { kind, payInvoice } — NWC client or WebLN adapter
  presigned,        // optional { boostSession, byAddress } from presignAllowlistedLegs
  signedKindOne,    // optional pre-signed kind 1 share-to-feed event
  signNoteAfterSettle, // optional async (result) => signed kind 1 | null. The
                    // SITE-SIGNED route: the show key signs a note for a booster
                    // with no npub on the boost, and it cannot be pre-signed
                    // because its figure is what settled. Called only when at
                    // least one leg paid; a throw or null reads as 'failed'.
  shareStatus = '', // share outcome to report when no note gets published:
                    // 'declined' | 'unavailable' | 'anon' | 'failed'. Overwritten
                    // with the real result whenever a signed note exists.
  senderName = '',  // typed display name for the receipt when no npub rides it
  wireSenderName = '', // display name for a keysend leg's TLV boostagram
  onStatus,         // optional (legIndex, legState) — live per-leg progress
  clientInfo,       // optional { walletProvider, browser } for the receipt
}) {
  // Defensive validation. The modal already checks these, but if a
  // future caller passes garbage we'd rather refuse than crash inside
  // payAllLegs or send a malformed boost.
  if (!episode || typeof episode !== 'object') {
    console.warn('[boostQueue] submitBoost: missing episode metadata')
    return null
  }
  if (!splits || !Array.isArray(splits.recipients) || splits.recipients.length === 0) {
    console.warn('[boostQueue] submitBoost: empty or invalid recipients list')
    return null
  }
  // A zero/NaN total weight would divide through distributeMsats and turn
  // every leg's msats into NaN — refuse it here with the other input checks.
  if (!(Number(splits.totalWeight) > 0)) {
    console.warn('[boostQueue] submitBoost: totalWeight must be > 0')
    return null
  }
  const sats = Number(totalSats) || 0
  if (sats < MIN_TOTAL_SATS) {
    console.warn('[boostQueue] submitBoost: totalSats below minimum')
    return null
  }
  // What we REPORT as the boost total (per-leg amount_total + receipt amount).
  // Equals `sats` for a normal boost; on a retry it's the donor's full parent
  // total while `sats` is only the failed leg's share being re-paid. Never let
  // it fall below `sats` (a report smaller than what we're actually moving
  // would be nonsensical).
  const reportSats = Math.max(sats, Number(amountTotalSats) > 0 ? Number(amountTotalSats) : 0)
  if (!wallet || typeof wallet.payInvoice !== 'function') {
    console.warn('[boostQueue] submitBoost: wallet adapter unavailable')
    return null
  }

  const localId = `local-${++nextLocalCounter}-${Date.now()}`
  inFlight.set(localId, {
    sessionId: localId,
    episode,
    totalSats: sats,
    startedAt: Date.now(),
    status: 'in-flight',
  })
  notify()

  // Resolved when payAllLegs settles, so the modal can await the final
  // outcome and flip to its success/partial/failed summary.
  let resolveSettled
  const settled = new Promise((resolve) => { resolveSettled = resolve })

  ;(async () => {
    let result = null
    try {
      result = await payAllLegs({
        recipients: splits.recipients,
        totalWeight: splits.totalWeight,
        totalMsats: sats * 1000,
        amountTotalMsats: reportSats * 1000,
        message,
        donorNpub,
        pageUrl: SITE_URL,
        episodeMeta: episode,
        wallet,
        lnurlCache,
        presigned,
        onStatus,
        boostSession,
        wireSenderName,
      })
    } catch (e) {
      // payAllLegs is documented as never-throws; this is belt-and-
      // braces. Treat as all-failed for the toast logic below.
      console.warn('[boostQueue] payAllLegs threw unexpectedly', e)
    }

    // Derive the terminal status. allSucceeded → paid; some succeeded
    // → partial; none → failed (or threw). The entry stays in the Map
    // for SETTLED_DISPLAY_MS so the dropdown can show the badge.
    const status = !result ? 'failed'
                 : result.allSucceeded ? 'paid'
                 : result.anySucceeded ? 'partial'
                 : 'failed'
    const entry = inFlight.get(localId)
    if (entry) {
      inFlight.set(localId, { ...entry, status, settledAt: Date.now() })
      notify()
    }
    setTimeout(() => {
      inFlight.delete(localId)
      notify()
    }, SETTLED_DISPLAY_MS)

    // All-failed signal. Partial failures stay silent (Podcasting 2.0
    // doesn't surface them either) but a fully-failed boost likely
    // means a wallet problem the user can act on, so we fire a
    // single transient toast.
    if (status === 'failed') {
      pushToast({
        kind: 'error',
        message: 'Couldn\'t deliver your boost. Check that your wallet is connected and has a balance.',
      })
    }

    // Hand the final result back to whoever's awaiting (the modal's progress
    // view) before the share + receipt publishing below. Those are awaited
    // now, and the donor should see their outcome the moment the legs settle
    // rather than watching a spinner through a relay round-trip. Null when
    // payAllLegs threw — caller treats that as all-failed, same as the toast
    // logic above.
    resolveSettled(result)

    // Publish the donor's optional kind 1 share-to-feed only if at
    // least one leg actually paid. A "Just boosted!" feed note for a
    // boost that didn't go through would be misleading. Failures here
    // are silent — the donor opted in but their relays may be flaky;
    // the boost itself already succeeded and the share is best-effort.
    //
    // Awaited rather than fired-and-forgotten because the receipt below
    // carries the outcome: a bot reads share_status to decide whether the
    // boost still needs a note published on the donor's behalf. A publish
    // that outlives the timeout leaves the status off the receipt, which
    // reads downstream as "unknown" — that costs a delayed note, where a
    // wrong value would cost a duplicate one.
    const sessionId = result?.boostSession || boostSession || ''
    let share
    if (!signedKindOne && signNoteAfterSettle && (status === 'paid' || status === 'partial')) {
      // Site-signed route. The note reports what settled, so it is built and
      // signed now rather than at the press. A failure here is a failure to
      // POST A NOTE and never a failure to boost: the sats are gone, the
      // receipt says 'failed', and the bots' claim path covers the boost on
      // a later tick (onlyboosts_coverage.decide reads anything but
      // 'published' as "no donor note is coming").
      try {
        signedKindOne = await withTimeout(signNoteAfterSettle(result), SHARE_PUBLISH_TIMEOUT_MS)
      } catch (e) {
        console.warn('[boostQueue] site-signed note failed', e?.message || e)
        signedKindOne = null
      }
      if (!signedKindOne) shareStatus = 'failed'
    }
    if (signedKindOne) {
      share = { noteId: signedKindOne.id, status: '' }
      if (status === 'paid' || status === 'partial') {
        try {
          const r = await withTimeout(publishSignedKindOne(signedKindOne), SHARE_PUBLISH_TIMEOUT_MS)
          share.status = r?.published ? 'published' : 'failed'
        } catch (e) {
          // Timed out with no ack yet: leave the status unknown. The publish
          // itself is still running and may well land.
          console.warn('[boostQueue] kind 1 share publish failed', e?.message || e)
        }
      } else {
        // Nothing landed, so the note was deliberately never posted.
        share.status = 'failed'
      }
      rememberShareOutcome(sessionId, share)
    } else if (shareOutcomes.has(sessionId)) {
      // Retry of a single failed leg — repeat the parent boost's share
      // outcome rather than reporting a note that was never in play.
      share = shareOutcomes.get(sessionId)
    } else {
      // No note this run (anon / declined / no signer), or a retry whose
      // parent ran in an earlier page load — in which case shareStatus is
      // '' and the receipt says nothing.
      share = { noteId: '', status: shareStatus }
      rememberShareOutcome(sessionId, share)
    }

    // Always publish the boost receipt — even on full failure. It's the
    // superset telemetry record (actual-vs-intended sats, per-leg outcome,
    // wallet/browser); its mere presence/absence also tells the bots
    // "completed" vs "user closed mid-boost". Fire-and-forget; needs the
    // per-leg results, so only when payAllLegs actually returned.
    if (result) {
      publishBoostReceipt({
        boostSession: result.boostSession,
        donorNpub,
        message,
        episodeMeta: episode,
        pageUrl: SITE_URL,
        walletKind: wallet?.kind || '',
        walletProvider: clientInfo?.walletProvider || 'unknown',
        browser: clientInfo?.browser || 'unknown',
        totalMsatsRequested: reportSats * 1000,
        legs: result.legs,
        shareNoteId: share.noteId,
        shareStatus: share.status,
        senderName,
      }).catch((e) => {
        console.warn('[boostQueue] boost receipt publish failed', e?.message || e)
      })
    }
  })()

  return { localId, settled }
}
