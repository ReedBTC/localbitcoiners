/**
 * EpisodeBoostModal — per-episode multi-leg boost form.
 *
 * On Boost: collect any signer round-trips upfront (kind 30078s for
 * allowlisted recipients, optional kind 1 share-to-feed) so a
 * remote-signer user doesn't get prompts after the modal closes. Then
 * submit the boost queue and close. The actual payment fan-out runs
 * in the background via boostQueue; per-leg outcomes surface in the
 * identity dropdown's "In Progress" section. Reed's call: a casual
 * user shouldn't have to babysit a 5-20s payment fan-out.
 *
 * Signing model (see lib/recipientOverrides.js for the allowlist):
 *   - Anonymous mode → no presign at all. Recipients in the allowlist
 *     get a burner-signed kind 30078 with empty `sender`. Recipients
 *     outside the allowlist get no kind 30078 published.
 *   - Attributed mode → recipients in the allowlist are presigned
 *     with the donor's real key (cryptographic provenance the bot can
 *     verify). Signer rejection/timeout falls back to a burner with
 *     an empty `sender` so the boost still goes through. Other
 *     recipients still get no kind 30078.
 *
 * Cancellation: closing the modal mid-prompt sets a cancel flag the
 * presign awaits check after each step, so a long-running bunker
 * round-trip doesn't queue a boost the user already tried to abort.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { isSafeUrl } from '../lib/utils.js'
import {
  fetchLnurlMeta,
  SITE_URL,
  buildEpisodeBoostShareTemplate,
  signKindOneShareWithUser,
} from '../lib/boostagram.js'
import * as nwc from '../lib/nwc.js'
import { submitBoost } from '../lib/boostQueue.js'
import { presignAllowlistedLegs } from '../lib/payAllLegs.js'
import { shouldPublishMetadata } from '../lib/recipientOverrides.js'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'

const MIN_SATS = 100

export default function EpisodeBoostModal({
  user,
  onClose,
  episode,        // { number, title, guid }
  splitsBundle,   // { recipients, totalWeight, source }
}) {
  const { visible, requestClose } = useModalTransition(onClose)

  // Cancellation flag for the presign step. Set true when the modal
  // begins to close (X click, parent unmount). Each await in
  // handleBoost re-checks this so a slow signer prompt that resolves
  // after the user clicked X doesn't queue a boost they tried to
  // abort. Ref so async closures see the latest value across awaits.
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])
  const handleClose = useCallback(() => {
    cancelledRef.current = true
    requestClose()
  }, [requestClose])

  const donorNpub = user?.npub || ''
  const profile = user?.profile

  // Live NWC status — if the wallet drops between gate-pass and modal
  // open (rare race), we want to surface a notice instead of letting
  // a Boost click fail silently.
  const [nwcStatus, setNwcStatus] = useState(() => nwc.getStatus())
  useEffect(() => nwc.onChange(setNwcStatus), [])

  // Resolve every recipient's LNURL endpoint in parallel as soon as
  // the modal opens. By the time the user finishes typing the amount,
  // every leg's metadata is cached and the orchestrator can skip its
  // own resolve step. The cache is passed through to submitBoost.
  const [lnurlCache, setLnurlCache] = useState({})
  useEffect(() => {
    const recipients = splitsBundle?.recipients
    if (!Array.isArray(recipients) || recipients.length === 0) return
    let cancelled = false
    const next = {}
    Promise.all(recipients.map(async (r) => {
      if (!r?.address) return
      try {
        next[r.address] = await fetchLnurlMeta(r.address)
      } catch {
        next[r.address] = null
      }
    })).then(() => {
      if (!cancelled) setLnurlCache(next)
    })
    return () => { cancelled = true }
  }, [splitsBundle?.recipients])

  // Form state
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [error, setError] = useState('')

  // Optional kind 1 share-to-feed. Only available when the donor has a
  // real signer attached (signed in + not anon). A burner-signed kind 1
  // is useless to followers, so the toggle is hidden in anon mode.
  const [shareToFeed, setShareToFeed] = useState(false)
  const canShareToFeed = !anonymous && !!donorNpub
  // Force off when anon flips on — mutually exclusive.
  useEffect(() => {
    if (anonymous && shareToFeed) setShareToFeed(false)
  }, [anonymous, shareToFeed])

  // Pre-sign progress. While the user-signer round-trip is in flight
  // (potentially 1–2 prompts on Amber/bunker), the modal stays open
  // showing this label so the donor knows what's happening; once
  // submitBoost is queued, the modal closes.
  const [prepareLabel, setPrepareLabel] = useState('')

  // Count of allowlisted recipients in this episode's splits — used to
  // tell the user how many signer prompts to expect ("Sign 2 receipts…").
  // Only addresses in META_PUBLISH_ALLOWLIST trigger a prompt; everyone
  // else's leg gets no kind 30078 metadata at all.
  const allowlistedCount = (splitsBundle?.recipients || [])
    .filter(r => r?.address && shouldPublishMetadata(r.address))
    .length

  async function handleBoost() {
    setError('')
    const sats = parseInt(amount, 10)
    if (!Number.isFinite(sats) || sats < MIN_SATS) {
      setError(`Minimum boost is ${MIN_SATS} sats (covers splits + fees).`)
      return
    }
    if (!nwc.isReady()) {
      setError('Wallet not connected — connect a Lightning wallet from your account menu.')
      return
    }

    const trimmedMessage = message.trim()
    const senderNpub = anonymous ? '' : donorNpub

    // Pre-sign step: anything that needs a signer round-trip (kind
    // 30078s for allowlisted legs, optional kind 1 share-to-feed) is
    // collected here while the modal is still open, so a remote-signer
    // user (Amber/bunker) doesn't get a surprise prompt after the modal
    // has already closed. Anonymous boosts skip both branches.
    let presigned = null
    let signedKindOne = null
    try {
      if (senderNpub && allowlistedCount > 0) {
        setPrepareLabel(allowlistedCount === 1
          ? 'Approve the boost receipt in your signer…'
          : `Approve ${allowlistedCount} boost receipts in your signer…`)
        presigned = await presignAllowlistedLegs({
          recipients: splitsBundle.recipients,
          totalWeight: splitsBundle.totalWeight,
          totalMsats: sats * 1000,
          message: trimmedMessage,
          donorNpub: senderNpub,
          pageUrl: SITE_URL,
          episodeMeta: episode,
          lnurlCache,
        })
        // User clicked X (or otherwise unmounted) while the prompt
        // was open — bail before mutating state or queuing the boost.
        if (cancelledRef.current) return
      }

      if (shareToFeed && canShareToFeed) {
        setPrepareLabel('Approve the share post in your signer…')
        try {
          const template = buildEpisodeBoostShareTemplate({
            amountSats: sats,
            message: trimmedMessage,
            episode,
            pageUrl: SITE_URL,
          })
          signedKindOne = await signKindOneShareWithUser(template)
        } catch (e) {
          // Don't kill the boost — the user wanted to share, but if their
          // signer rejected/timed out we just skip the share quietly. The
          // boost itself goes through and the dropdown surfaces it.
          console.warn('[lb] share-to-feed sign failed', e?.message || e)
        }
        if (cancelledRef.current) return
      }
    } catch (e) {
      // Top-level catch for any unexpected throw from the presign
      // path. presignAllowlistedLegs is documented best-effort but
      // real-world surprises (a refactor regression, a sync error in
      // a helper, an environment-level crypto failure) shouldn't
      // leave the user staring at a half-progress modal with no
      // feedback. Surface a generic recoverable error.
      console.warn('[lb] episode-boost presign threw unexpectedly', e?.message || e)
      setError('Something went wrong preparing your boost — try again in a moment.')
      return
    } finally {
      setPrepareLabel('')
    }

    // Fire and forget. The boostQueue tracks in-flight + dropdown badge
    // surfaces the per-leg outcome. payAllLegs uses the presigned map
    // to skip LNURL+sign for allowlisted legs and skips the kind 30078
    // entirely for everyone else. The pre-signed kind 1 (if any)
    // publishes after the boost succeeds.
    submitBoost({
      episode,
      splits: splitsBundle,
      totalSats: sats,
      message: trimmedMessage,
      donorNpub: senderNpub,
      lnurlCache,
      nwcClient: nwc.getClient(),
      presigned,
      signedKindOne,
    })

    // Close immediately — user gets back to browsing.
    handleClose()
  }

  // Scroll lock + Esc-to-close intentionally NOT bound (X is the
  // only close path so a misclick doesn't lose typed input).
  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  const epLabel = episode?.number ? `Ep. ${String(episode.number).padStart(3, '0')}` : 'Episode'
  const headerTitle = `⚡ Boost ${epLabel}`
  const splitsCount = splitsBundle?.recipients?.length || 0
  const walletGone = !nwcStatus.connected

  return (
    <>
      {/* Backdrop is purely visual — no click-to-close so a misclick
          can't lose typed input or interrupt the flow. */}
      <div
        className={`fixed inset-0 bg-black/70 z-[70] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-[71] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label={headerTitle}
      >
        <div className={`bg-neutral-900 border border-neutral-700 rounded-lg w-full max-w-sm flex flex-col shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] my-4 sm:my-8 transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">{headerTitle}</h2>
            <button
              onClick={handleClose}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1">

            {episode?.title && (
              <p className="text-xs text-neutral-400 italic leading-snug">
                "{episode.title}"
              </p>
            )}

            {/* Wallet-disconnected fallback. Rare — the API gate
                checks NWC before opening this modal, but a wallet
                can drop between gate-pass and mount. */}
            {walletGone && (
              <div className="space-y-3 text-center py-2">
                <p className="text-xs text-neutral-400">
                  Lightning wallet isn't connected. Open your account
                  menu in the top-right to connect one, then come back.
                </p>
                <button
                  onClick={handleClose}
                  className="px-4 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-sm text-neutral-200 transition-colors"
                >
                  Close
                </button>
              </div>
            )}

            {!walletGone && (
              <>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Amount (sats)</label>
                  <input
                    type="number"
                    min={MIN_SATS}
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
                    placeholder={`${MIN_SATS} minimum`}
                  />
                  <p className="mt-1 text-[10px] text-neutral-600">
                    {MIN_SATS} sat minimum (covers splits + fees).
                    Splits across {splitsCount} {splitsCount === 1 ? 'recipient' : 'recipients'}.
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Boost as</label>
                  <div className="flex gap-2 text-xs">
                    <button
                      onClick={() => setAnonymous(false)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-3 px-3 rounded-md border transition-colors ${
                        !anonymous
                          ? 'bg-orange-500/15 border-orange-500 text-orange-200 font-semibold'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
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
                          ? 'bg-orange-500/15 border-orange-500 text-orange-200 font-semibold'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'
                      }`}
                      aria-pressed={anonymous}
                    >
                      Anon
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Message (optional)</label>
                  <textarea
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value)
                      const el = e.target
                      el.style.height = 'auto'
                      el.style.height = el.scrollHeight + 'px'
                    }}
                    rows={4}
                    maxLength={10000}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30 resize-none overflow-hidden leading-relaxed"
                    placeholder="Leave a note for the show + guests"
                  />
                </div>

                {/* Share-to-feed opt-in — only when the donor has a real
                    signer to publish a kind 1 with. Hidden in anon mode
                    since a burner-signed kind 1 isn't useful to followers. */}
                {canShareToFeed && (
                  <label className="flex items-start gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={shareToFeed}
                      onChange={e => setShareToFeed(e.target.checked)}
                      className="accent-orange-500 mt-0.5"
                    />
                    <span className="leading-snug">
                      Share to my feed
                      <span className="block text-[10px] text-neutral-600 mt-0.5">
                        Posts a kind 1 note to your followers — the
                        episode + your message + a link back here.
                      </span>
                    </span>
                  </label>
                )}

                {error && <p className="text-xs text-red-400">{error}</p>}

                {prepareLabel && (
                  <p className="text-xs text-orange-400 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" aria-hidden="true" />
                    {prepareLabel}
                  </p>
                )}

                <button
                  onClick={handleBoost}
                  disabled={!!prepareLabel}
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
                  </svg>
                  {prepareLabel ? 'Preparing boost…' : 'Boost Episode'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
