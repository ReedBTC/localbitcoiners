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
} from '../lib/boostagram.js'
import * as wallet from '../lib/wallet.js'
import { submitBoost } from '../lib/boostQueue.js'
import { presignAllowlistedLegs } from '../lib/payAllLegs.js'
import { shouldPublishMetadata } from '../lib/recipientOverrides.js'
import BoostExpectations from './BoostExpectations.jsx'

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
  onCancelled,
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
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [error, setError] = useState('')

  const [shareToFeed, setShareToFeed] = useState(false)
  const canShareToFeed = !anonymous && !!donorNpub
  useEffect(() => {
    if (anonymous && shareToFeed) setShareToFeed(false)
  }, [anonymous, shareToFeed])

  const [prepareLabel, setPrepareLabel] = useState('')

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
    if (sats > MAX_SATS) {
      setError(`Max ${MAX_SATS.toLocaleString()} sats per boost — split a larger gift across multiple boosts.`)
      return
    }
    if (!wallet.isReady()) {
      setError('Wallet not connected — connect a Lightning wallet from your account menu.')
      return
    }

    const trimmedMessage = message.trim()
    const senderNpub = anonymous ? '' : donorNpub

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
          episodeMeta,
          lnurlCache,
        })
        if (cancelledRef.current) return
      }

      if (shareToFeed && canShareToFeed) {
        setPrepareLabel('Approve the share post in your signer…')
        try {
          // buildEpisodeBoostShareTemplate handles missing episode
          // fields gracefully (no "Ep. N" suffix when number is null
          // / no title block when empty), so a single template
          // function works for both the show and per-episode flows.
          const template = buildEpisodeBoostShareTemplate({
            amountSats: sats,
            message: trimmedMessage,
            episode: episodeMeta,
            pageUrl: SITE_URL,
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

    submitBoost({
      episode: episodeMeta,
      splits: splitsBundle,
      totalSats: sats,
      message: trimmedMessage,
      donorNpub: senderNpub,
      lnurlCache,
      wallet: wallet.getActiveWallet(),
      presigned,
      signedKindOne,
    })

    cancelAndClose()
  }

  const splitsCount = splitsBundle?.recipients?.length || 0
  const walletGone = !walletStatus.connected

  if (walletGone) {
    return (
      <div className="space-y-3 text-center py-2">
        <p className="text-xs text-neutral-400">
          Lightning wallet isn't connected. Open your account menu in
          the top-right to connect one, then come back.
        </p>
        <button
          onClick={cancelAndClose}
          className="px-4 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-sm text-neutral-200 transition-colors"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <>
      {subtitle && (
        <p className="text-xs text-neutral-400 italic leading-snug">
          "{subtitle}"
        </p>
      )}

      <div>
        <label className="block text-xs text-neutral-400 mb-1.5">Amount (sats)</label>
        {presets && presets.length > 0 && (
          <div className="flex gap-1.5 mb-2">
            {presets.map(p => (
              <button
                key={p}
                onClick={() => setAmount(String(p))}
                className={`flex-1 text-xs py-2 rounded border transition-colors ${
                  amount === String(p)
                    ? 'border-orange-600 text-orange-400 bg-orange-950/30'
                    : 'border-neutral-700 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
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
          className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
          placeholder={presets ? 'Custom amount' : `${MIN_SATS} minimum`}
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
        {/* M16 honest disclosure: anon hides the donor npub but the
            burner key signing every leg of one boost is the same key,
            so observers can correlate "all legs of this anonymous
            boost" by burner pubkey + boost_session UUID. Surfaced
            here so users aren't misled by the "Anon" label. */}
        {anonymous && (
          <p className="mt-1.5 text-[10px] text-neutral-500 leading-snug">
            Anon hides your npub from the boost record. Note that
            observers can still correlate the legs of one boost
            together (shared burner key + session ID).
          </p>
        )}
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
        {prepareLabel ? 'Preparing boost…' : buttonLabel}
      </button>
    </>
  )
}
