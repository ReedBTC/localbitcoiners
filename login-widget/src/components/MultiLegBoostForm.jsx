/**
 * Shared multi-leg boost form — the body that lives inside both the
 * show-boost (BoostModal) and per-episode boost (EpisodeBoostModal)
 * modals. Both flows are 80%+ identical: same amount + anon toggle +
 * message + share-to-feed checkbox + "What to expect" + Boost button,
 * routed through the same presign + submitBoost queue.
 *
 * The wrapper modals own the modal chrome (backdrop, transitions,
 * scroll lock, close X) and pass in the bits that differ:
 *   - episodeMeta — passed verbatim to submitBoost; show uses
 *     `{ number: null, title: '', guid: '', kind: 'show' }`,
 *     episodes use the real RSS metadata.
 *   - splitsBundle — { recipients, totalWeight }; show is hardcoded,
 *     episode is RSS-derived.
 *   - presets — optional [int]; show uses sat presets, episode uses
 *     just the custom-amount input.
 *   - shareTagline — copy for the share-to-feed checkbox subline.
 *   - buttonLabel — "Boost the Show" / "Boost Episode".
 *   - lnurlCache — passed to submitBoost so payAllLegs can skip its
 *     own LNURL meta fetch when the parent modal pre-warmed it.
 *   - subtitle — optional italic line above the form (episode title).
 *   - onCancelled — closes the parent modal; runs the parent's
 *     cancel-flag teardown so a slow signer prompt resolving after
 *     close doesn't queue a boost the user already aborted.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { isSafeUrl } from '../lib/utils.js'
import {
  SITE_URL,
  buildEpisodeBoostShareTemplate,
  signKindOneShareWithUser,
  confirmInvoiceSettled,
} from '../lib/boostagram.js'
import * as wallet from '../lib/wallet.js'
import { submitBoost } from '../lib/boostQueue.js'
import { setBoostModalProgressVisible } from '../lib/boostModalSignal.js'
import { detectBrowser, detectWalletProvider } from '../lib/clientInfo.js'
import { presignAllowlistedLegs, newBoostSession } from '../lib/payAllLegs.js'
import { shouldPublishMetadata } from '../lib/recipientOverrides.js'
import BoostExpectations from './BoostExpectations.jsx'
import BoostProgressView from './BoostProgressView.jsx'

const MIN_SATS = 100
const MAX_SATS = 5_000_000

export default function MultiLegBoostForm({
  user,
  splitsBundle,
  episodeMeta,
  presets = null,
  shareTagline,
  buttonLabel,
  lnurlCache = {},
  subtitle = null,
  defaultMessage = '',
  // Who the free-text message is addressed to. The default names the show
  // because the episode flow is this form's usual host; the site-tip wrapper
  // overrides it, where there is no show and the note goes to Local Bitcoiners.
  messagePlaceholder = 'Leave a note for the show + guests',
  onCancelled,
  // Reports the in-modal boost lifecycle up to the wrapper so it can
  // guard its close button: null when idle/settled, or
  // { active: true, paid, total } while legs are still in flight.
  onBoostState,
  // Fires once when the boost settles, with the payAllLegs summary
  // ({ anySucceeded, allSucceeded, anyUncertain, legs, ... }). Optional —
  // only the show-boost host wires it, to signal "this npub just boosted"
  // so the community-status chip can flip to its pending-member state.
  onSettled,
}) {
  // Cancellation flag for the presign step. Set true when the form's
  // parent begins to close so a slow signer prompt that resolves after
  // close doesn't queue a boost the user already aborted. Ref so async
  // closures see the latest value across awaits.
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])
  const cancelAndClose = useCallback(() => {
    cancelledRef.current = true
    onCancelled?.()
  }, [onCancelled])

  const donorNpub = user?.npub || ''
  const profile = user?.profile

  const [walletStatus, setWalletStatus] = useState(() => wallet.getStatus())
  useEffect(() => wallet.onChange(setWalletStatus), [])

  const [amount, setAmount] = useState(presets ? String(presets[1] ?? presets[0]) : '1000')
  // `defaultMessage` is used by the /newevent composer to prefill an
  // announcement boostagram. Re-seeded if the prop changes (e.g. the
  // host opens a new boost session with different prefill text).
  const [message, setMessage] = useState(defaultMessage || '')
  useEffect(() => {
    if (defaultMessage) setMessage(defaultMessage)
  }, [defaultMessage])
  const [anonymous, setAnonymous] = useState(false)
  const [error, setError] = useState('')

  const [shareToFeed, setShareToFeed] = useState(false)
  const canShareToFeed = !anonymous && !!donorNpub
  useEffect(() => {
    if (anonymous && shareToFeed) setShareToFeed(false)
  }, [anonymous, shareToFeed])

  const [prepareLabel, setPrepareLabel] = useState('')

  // Boost progress lifecycle. 'form' shows the inputs; after the user
  // hits Boost we flip to 'sending' (live per-leg progress) and then
  // 'done' (success/partial/failed summary). The boost itself runs in
  // boostQueue regardless of this state, so unmounting mid-send is safe.
  const [phase, setPhase] = useState('form')          // 'form' | 'sending' | 'done'
  const [legStates, setLegStates] = useState([])      // per-recipient onStatus payloads
  const [result, setResult] = useState(null)          // final payAllLegs result
  // Recipients + sats for the CURRENT run. Usually the full splitsBundle,
  // but a retry runs only the failed subset — so the progress view reads
  // these rather than splitsBundle/amount directly.
  const [progressRecipients, setProgressRecipients] = useState([])
  const [progressTotalSats, setProgressTotalSats] = useState(0)

  // Merge a per-leg status update from payAllLegs into legStates by index.
  // Guarded on cancelledRef so a status arriving after the modal closes
  // (background queue still running) doesn't setState on an unmounted tree.
  const handleLegStatus = useCallback((index, legState) => {
    if (cancelledRef.current) return
    setLegStates(prev => {
      const next = prev.slice()
      next[index] = legState
      return next
    })
  }, [])

  // Report active/settled state up to the wrapper for its close guard.
  // Deduped via a ref so we only push (→ re-render the wrapper) when the
  // active flag or paid count actually changes, not on every per-leg
  // status tick — that churn is what made the modal feel jittery.
  const lastReportedRef = useRef(null)
  useEffect(() => {
    if (!onBoostState) return
    let next = null
    if (phase === 'sending') {
      const paid = legStates.filter(l => l?.status === 'paid').length
      next = { active: true, paid, total: legStates.length }
    }
    const prev = lastReportedRef.current
    const unchanged = (!prev && !next) ||
      (prev && next && prev.active === next.active &&
        prev.paid === next.paid && prev.total === next.total)
    if (unchanged) return
    lastReportedRef.current = next
    onBoostState(next)
  }, [phase, legStates, onBoostState])

  // Tell the top-of-page banner to stand down while this progress view is
  // up (it's the primary surface now). progressVisible is a boolean so
  // the sending→done transition doesn't re-toggle it; cleanup on unmount
  // flips it back so the banner can take over if the user force-closes.
  const progressVisible = phase !== 'form'
  useEffect(() => {
    setBoostModalProgressVisible(progressVisible)
    return () => setBoostModalProgressVisible(false)
  }, [progressVisible])

  const allowlistedCount = (splitsBundle?.recipients || [])
    .filter(r => r?.address && shouldPublishMetadata(r.address))
    .length

  // Core boost runner, shared by the initial boost and the retry-failed
  // path. Presigns (signer prompts) for any allowlisted legs in THIS run's
  // recipient set, optionally signs the share-to-feed note, then hands off
  // to the background queue and flips the modal into its live progress
  // view. Caller is responsible for amount validation.
  async function runBoost({ recipients, totalWeight, totalSats, includeShare }) {
    if (!wallet.isReady()) {
      setError('Wallet not connected — connect a Lightning wallet from your account menu.')
      return
    }
    setError('')

    const trimmedMessage = message.trim()
    const senderNpub = anonymous ? '' : donorNpub
    const allowlisted = (recipients || [])
      .filter(r => r?.address && shouldPublishMetadata(r.address))
      .length
    // One session id for the whole boost, minted HERE rather than inside
    // payAllLegs: the donor's kind 1 share note is signed before any payment
    // runs, and it has to carry the same boost_session as the receipt for the
    // two to be recognizable as one boost.
    const boostSession = newBoostSession()
    // What the receipt reports when no note is published. The queue replaces
    // it with the real outcome whenever a signed note exists.
    const shareStatus = anonymous ? 'anon'
      : !donorNpub ? 'unavailable'
      : !(includeShare && shareToFeed) ? 'declined'
      : 'unavailable'   // opted in; 'unavailable' only survives a signer failure

    let presigned = null
    let signedKindOne = null
    try {
      if (senderNpub && allowlisted > 0) {
        setPrepareLabel(allowlisted === 1
          ? 'Approve the boost receipt in your signer…'
          : `Approve ${allowlisted} boost receipts in your signer…`)
        presigned = await presignAllowlistedLegs({
          recipients,
          totalWeight,
          totalMsats: totalSats * 1000,
          message: trimmedMessage,
          donorNpub: senderNpub,
          pageUrl: SITE_URL,
          episodeMeta,
          lnurlCache,
          boostSession,
        })
        if (cancelledRef.current) return
      }

      // Share-to-feed only on the initial boost, never on a retry — the
      // donor already (maybe) posted their note; a retry of a failed leg
      // shouldn't double-post to their feed.
      if (includeShare && shareToFeed && canShareToFeed) {
        setPrepareLabel('Approve the share post in your signer…')
        try {
          // buildEpisodeBoostShareTemplate handles missing episode
          // fields gracefully (no "Ep. N" suffix when number is null
          // / no title block when empty), so a single template
          // function works for both the show and per-episode flows.
          const template = buildEpisodeBoostShareTemplate({
            amountSats: totalSats,
            message: trimmedMessage,
            episode: episodeMeta,
            pageUrl: SITE_URL,
            boostSession,
          })
          signedKindOne = await signKindOneShareWithUser(template)
        } catch (e) {
          // Don't kill the boost — the user wanted to share, but if
          // their signer rejected/timed out we just skip the share
          // quietly. The boost itself still goes through.
          console.warn('[lb] boost share-to-feed sign failed', e?.message || e)
        }
        if (cancelledRef.current) return
      }
    } catch (e) {
      console.warn('[lb] boost presign threw unexpectedly', e?.message || e)
      setError('Something went wrong preparing your boost — try again in a moment.')
      return
    } finally {
      setPrepareLabel('')
    }

    // Seed this run's progress: one 'pending' row per recipient so the
    // view renders the full split immediately, before onStatus arrives.
    setResult(null)
    setProgressRecipients(recipients)
    setProgressTotalSats(totalSats)
    setLegStates((recipients || []).map(() => ({ status: 'pending', msats: null })))

    const handle = submitBoost({
      episode: episodeMeta,
      splits: { recipients, totalWeight },
      totalSats,
      boostSession,
      message: trimmedMessage,
      donorNpub: senderNpub,
      lnurlCache,
      wallet: wallet.getActiveWallet(),
      presigned,
      signedKindOne,
      shareStatus,
      onStatus: handleLegStatus,
      clientInfo: {
        walletProvider: detectWalletProvider({ kind: walletStatus.kind, alias: walletStatus.alias }),
        browser: detectBrowser(),
      },
    })

    // Null only on defensive validation failure inside the queue (the
    // checks above should already cover it) — stay where we are.
    if (!handle) {
      setError('Couldn\'t start your boost — please try again.')
      return
    }

    // Stay open and show live progress instead of closing. The boost runs
    // in the background queue, so even if the user force-closes the modal
    // it keeps paying (banner + dropdown take over).
    setPhase('sending')
    handle.settled.then((r) => {
      if (cancelledRef.current) return
      setResult(r)
      setPhase('done')
      try { onSettled?.(r) } catch {}
    })
  }

  async function handleBoost() {
    setError('')
    const sats = parseInt(amount, 10)
    if (!Number.isFinite(sats) || sats < MIN_SATS) {
      setError(`Minimum boost is ${MIN_SATS} sats (covers splits + fees).`)
      return
    }
    if (sats > MAX_SATS) {
      setError(`Max ${MAX_SATS.toLocaleString()} sats per boost — split a larger gift across multiple boosts.`)
      return
    }
    await runBoost({
      recipients: splitsBundle.recipients,
      totalWeight: splitsBundle.totalWeight,
      totalSats: sats,
      includeShare: true,
    })
  }

  // Retry a SINGLE leg, in place — the modal stays on the done view and only
  // that row re-runs. Handles both 'failed' (confirmed not paid) and
  // 'uncertain' (settlement unknown) legs.
  //
  // A retry pays ONLY the failed leg's own share (never re-charges the full
  // boost — that would re-trigger the double-spend guard below), but it must
  // still REPORT the parent boost's identity so the record isn't orphaned:
  //   - it reuses the original boost's session id (result.boostSession), so
  //     the retried leg's 30078 ties back to the parent boost, and
  //   - it stamps the parent's full total (progressTotalSats, the amount the
  //     donor actually boosted) as amount_total — not the leg's own share.
  // The bot keys reconciliation on the shared session and reports the true
  // total. See the boostQueue/payAllLegs `amountTotalSats`/`boostSession`
  // params for how the leg-share-paid vs parent-total-reported split flows.
  async function handleRetryLeg(index) {
    const recipient = progressRecipients[index]
    const current = legStates[index]
    if (!recipient || (current?.status !== 'failed' && current?.status !== 'uncertain')) return
    // Unpayable (skipped keysend-node) legs can never succeed from the
    // browser — retrying would just instantly re-fail. No-op.
    if (recipient.unpayable) return

    // Amount to actually PAY this run: the failed leg's own share.
    const legSats = Math.max(1, Math.round((current?.msats || 0) / 1000))
    // Parent boost identity to REPORT. progressTotalSats is the donor's full
    // boost total (set on the initial run and never overwritten by a retry);
    // result.boostSession is the session every original leg was tagged with.
    // Fall back gracefully if the initial result is somehow missing.
    const parentTotalSats = Math.max(legSats, Math.round(progressTotalSats || 0))
    const parentSession = result?.boostSession || null
    const totalWeight = recipient.splitWeight || 1
    // Route this single-leg run's status (leg index 0) back onto the
    // original row so the existing done view updates in place.
    const onStatus = (_i, ls) => handleLegStatus(index, ls)

    // Optimistic flip so the Retry button is replaced by a spinner instantly.
    handleLegStatus(index, { ...current, status: 'resolving', error: null })

    // SAFETY: never re-pay a leg that may have already settled — this is the
    // guard against the double-spend a blind retry would cause.
    //   - 'failed' legs are already confirmed not-paid, so re-pay is safe; we
    //     still verify when we can, as a bonus catch.
    //   - 'uncertain' legs MUST be confirmed unpaid before re-paying. If we
    //     can't confirm (no verify URL, or it stays unknown), we refuse to
    //     re-pay and tell the donor to check their wallet.
    const canVerify = !!(current.verifyUrl && current.paymentHash)
    if (canVerify) {
      const settlement = await confirmInvoiceSettled(current.verifyUrl, current.paymentHash)
      if (cancelledRef.current) return
      if (settlement === 'settled') {
        handleLegStatus(index, { ...current, status: 'paid', error: null })
        return
      }
      if (settlement !== 'unsettled' && current.status === 'uncertain') {
        handleLegStatus(index, {
          ...current,
          status: 'uncertain',
          error: 'Still couldn’t confirm this one. Check your wallet directly before retrying — it may have already paid.',
        })
        return
      }
      // 'unsettled', or unknown on a confirmed-failed leg → safe to re-pay.
    } else if (current.status === 'uncertain') {
      // No way to confirm an unconfirmed leg — never auto re-pay it.
      handleLegStatus(index, {
        ...current,
        status: 'uncertain',
        error: 'Can’t confirm this payment automatically. Check your wallet directly — it may have already gone through.',
      })
      return
    }

    if (!wallet.isReady()) {
      handleLegStatus(index, { ...current, status: 'failed', error: 'wallet not connected' })
      return
    }

    const senderNpub = anonymous ? '' : donorNpub
    let presigned = null
    try {
      if (senderNpub && shouldPublishMetadata(recipient.address)) {
        presigned = await presignAllowlistedLegs({
          recipients: [recipient],
          totalWeight,
          totalMsats: legSats * 1000,          // distribute = this leg's share
          amountTotalMsats: parentTotalSats * 1000,  // report = parent total
          boostSession: parentSession || undefined,  // reuse the parent session
          message: message.trim(),
          donorNpub: senderNpub,
          pageUrl: SITE_URL,
          episodeMeta,
          lnurlCache,
        })
        if (cancelledRef.current) return
      }
    } catch (e) {
      // Presign failed — payAllLegs will burner-sign the metadata instead.
      console.warn('[lb] retry presign failed', e?.message || e)
    }

    const handle = submitBoost({
      episode: episodeMeta,
      splits: { recipients: [recipient], totalWeight },
      totalSats: legSats,                 // pay only this leg's share
      amountTotalSats: parentTotalSats,   // but report the parent boost total
      boostSession: parentSession || undefined,   // under the parent session
      message: message.trim(),
      donorNpub: senderNpub,
      lnurlCache,
      wallet: wallet.getActiveWallet(),
      presigned,
      signedKindOne: null,
      onStatus,
      clientInfo: {
        walletProvider: detectWalletProvider({ kind: walletStatus.kind, alias: walletStatus.alias }),
        browser: detectBrowser(),
      },
    })
    // onStatus drives the row to its terminal state; no need to await.
    if (!handle) {
      handleLegStatus(index, { ...current, status: 'failed', error: 'could not start retry' })
    }
  }

  const splitsCount = splitsBundle?.recipients?.length || 0
  const walletGone = !walletStatus.connected

  // Once the boost is in flight, the form is replaced by the live
  // progress view (sending → done). Done closes the modal.
  if (phase !== 'form') {
    return (
      <BoostProgressView
        recipients={progressRecipients}
        totalSats={progressTotalSats}
        legStates={legStates}
        phase={phase}
        result={result}
        onDone={cancelAndClose}
        onRetryLeg={handleRetryLeg}
      />
    )
  }

  if (walletGone) {
    return (
      <div className="space-y-3 text-center py-2">
        <p className="text-xs text-[var(--muted,#5a7488)]">
          Lightning wallet isn't connected. Open your account menu in
          the top-right to connect one, then come back.
        </p>
        <button
          onClick={cancelAndClose}
          className="px-4 py-2 rounded-lg bg-[var(--modal-inset,#e6f1f9)] hover:bg-[var(--border,#cfe2ee)] text-sm text-[var(--ink,#0f2733)] transition-colors"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <>
      {subtitle && (
        <p className="text-xs text-[var(--muted,#5a7488)] italic leading-snug">
          "{subtitle}"
        </p>
      )}

      <div>
        <label className="block text-xs text-[var(--muted,#5a7488)] mb-1.5">Amount (sats)</label>
        {presets && presets.length > 0 && (
          <div className="flex gap-1.5 mb-2">
            {presets.map(p => (
              <button
                key={p}
                onClick={() => setAmount(String(p))}
                className={`flex-1 text-xs py-2 rounded-lg border transition-colors ${
                  amount === String(p)
                    ? 'border-[var(--brand,#00aff0)] text-[var(--brand-d,#068ace)] bg-[var(--brand-tint,rgba(0,175,240,0.12))]'
                    : 'border-[var(--modal-line,#b9d4e6)] text-[var(--muted,#5a7488)] hover:border-[var(--brand,#00aff0)] hover:text-[var(--ink,#0f2733)]'
                }`}
              >
                {p.toLocaleString()}
              </button>
            ))}
          </div>
        )}
        <input
          type="number"
          min={MIN_SATS}
          max={MAX_SATS}
          value={amount}
          onChange={e => setAmount(e.target.value)}
          className="w-full bg-[var(--modal-field,#ffffff)] border border-[var(--modal-line,#b9d4e6)] rounded-lg px-3 py-2 text-sm text-[var(--ink,#0f2733)] focus:outline-none focus:border-[var(--brand,#00aff0)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(0,175,240,0.32))]"
          placeholder={presets ? 'Custom amount' : `${MIN_SATS} minimum`}
        />
        <p className="mt-1 text-[10px] text-[var(--muted,#5a7488)]">
          {MIN_SATS} sat minimum (covers splits + fees).
          Splits across {splitsCount} {splitsCount === 1 ? 'recipient' : 'recipients'}.
        </p>
      </div>

      <div>
        <label className="block text-xs text-[var(--muted,#5a7488)] mb-1.5">Boost as</label>
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => setAnonymous(false)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-3 px-3 rounded-md border transition-colors ${
              !anonymous
                ? 'bg-[var(--brand-tint,rgba(0,175,240,0.12))] border-[var(--brand,#00aff0)] text-[var(--brand-dd,#0a6fa8)] font-semibold'
                : 'bg-[var(--modal-field,#ffffff)] border-[var(--modal-line,#b9d4e6)] text-[var(--muted,#5a7488)] hover:text-[var(--ink,#0f2733)] hover:border-[var(--brand,#00aff0)]'
            }`}
            aria-pressed={!anonymous}
          >
            {profile?.image && isSafeUrl(profile.image) && (
              <img src={profile.image} alt="" className="w-4 h-4 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
            )}
            <span className="truncate max-w-[140px]">
              {profile?.displayName || profile?.name || 'Your npub'}
            </span>
          </button>
          <button
            onClick={() => setAnonymous(true)}
            className={`flex-1 py-3 px-3 rounded-md border transition-colors ${
              anonymous
                ? 'bg-[var(--brand-tint,rgba(0,175,240,0.12))] border-[var(--brand,#00aff0)] text-[var(--brand-dd,#0a6fa8)] font-semibold'
                : 'bg-[var(--modal-field,#ffffff)] border-[var(--modal-line,#b9d4e6)] text-[var(--muted,#5a7488)] hover:text-[var(--ink,#0f2733)] hover:border-[var(--brand,#00aff0)]'
            }`}
            aria-pressed={anonymous}
          >
            Anon
          </button>
        </div>
        {/* M16 honest disclosure: anon hides the donor npub but the
            burner key signing every leg of one boost is the same key,
            so observers can correlate "all legs of this anonymous
            boost" by burner pubkey + boost_session UUID. Surfaced
            here so users aren't misled by the "Anon" label. */}
        {anonymous && (
          <p className="mt-1.5 text-[10px] text-[var(--muted,#5a7488)] leading-snug">
            Anon hides your npub from the boost record. Note that
            observers can still correlate the legs of one boost
            together (shared burner key + session ID).
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--muted,#5a7488)] mb-1.5">Message (optional)</label>
        <textarea
          value={message}
          onChange={(e) => {
            setMessage(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            // Cap auto-grow at MAX_PX so long messages (e.g. naddr-interpolated
            // boost-existing-meetup flow) scroll inside the textarea instead
            // of pushing the modal arbitrarily tall.
            const MAX_PX = 160
            el.style.height = Math.min(el.scrollHeight, MAX_PX) + 'px'
          }}
          rows={4}
          maxLength={10000}
          className="w-full bg-[var(--modal-field,#ffffff)] border border-[var(--modal-line,#b9d4e6)] rounded-lg px-3 py-2 text-sm text-[var(--ink,#0f2733)] focus:outline-none focus:border-[var(--brand,#00aff0)] focus:ring-2 focus:ring-[var(--brand-ring,rgba(0,175,240,0.32))] resize-none max-h-40 overflow-y-auto leading-relaxed"
          placeholder={messagePlaceholder}
        />
      </div>

      {canShareToFeed && (
        <label className="flex items-start gap-2 text-xs text-[var(--muted,#5a7488)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={shareToFeed}
            onChange={e => setShareToFeed(e.target.checked)}
            className="accent-[var(--brand,#00aff0)] mt-0.5"
          />
          <span className="leading-snug">
            Share to my feed
            <span className="block text-[10px] text-[var(--muted,#5a7488)] mt-0.5">
              {shareTagline}
            </span>
          </span>
        </label>
      )}

      <BoostExpectations
        walletKind={walletStatus.kind}
        anonymous={anonymous}
        allowlistedCount={allowlistedCount}
        shareToFeed={shareToFeed}
        canShareToFeed={canShareToFeed}
        splitsCount={splitsCount}
      />

      {error && <p className="text-xs text-[var(--danger,#b3261e)]">{error}</p>}

      {prepareLabel && (
        <p className="text-xs text-[var(--brand-d,#068ace)] flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--brand,#00aff0)] animate-pulse" aria-hidden="true" />
          {prepareLabel}
        </p>
      )}

      <button
        onClick={handleBoost}
        disabled={!!prepareLabel}
        className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-lg bg-[var(--brand-dd,#0a6fa8)] hover:bg-[var(--brand-ddd,#095e90)] disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
        </svg>
        {prepareLabel ? 'Preparing boost…' : buttonLabel}
      </button>
    </>
  )
}
