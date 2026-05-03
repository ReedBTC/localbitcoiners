/**
 * BoostModal — site-wide "Boost the Show" form.
 *
 * Mirrors EpisodeBoostModal in flow: collect signer round-trips upfront
 * (kind 30078s for allowlisted recipients + optional kind 1 share-to-
 * feed), then submit the boost to the queue and close. The actual
 * payment fan-out runs in the background via boostQueue; per-leg
 * outcomes surface in the identity dropdown's "In Progress" section.
 *
 * Splits: hardcoded show-level value block — same three recipients
 * the channel-level RSS value block declares (reed/revhodl/aquafox30
 * at 33/33/34). Per-recipient kind 30078 publishing is gated by
 * META_PUBLISH_ALLOWLIST in lib/recipientOverrides.js, same as the
 * episode flow.
 *
 * No QR fallback, no single-recipient bolt11, no inline pollVerify
 * — boost goes through whichever wallet the user has connected (NWC
 * or WebLN); api.openShowBoost gates on a wallet being ready before
 * this modal mounts, so a user without one is funneled through the
 * connect modal first.
 *
 * Anonymous toggle behaves the same as on the episode modal — flips
 * the kind 30078 sender attribution, doesn't bypass login (login is
 * required to even open the modal because some address in the splits
 * is allowlisted and the donor's signer prompt happens upfront).
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
import { shouldPublishMetadata, applyRecipientOverrides } from '../lib/recipientOverrides.js'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import BoostExpectations from './BoostExpectations.jsx'

const MIN_SATS = 100
// 5M sats hard ceiling so a clipboard accident (or fat-fingered extra
// digit) doesn't queue a multi-leg boost the wallet has to silently
// refuse after the user has already approved the receipt prompts.
const MAX_SATS = 5_000_000
const PRESETS = [100, 210, 2100, 21000]

// Channel-level value block hardcoded into the bundle. Mirrors the
// `<podcast:value>` block the RSS feed publishes at the channel level
// (reed 33 / revhodl 33 / aquafox30 34) so that boosting "the show"
// pays the same recipients in the same proportions an episode boost
// would when no per-item override is set.
//
// Source of truth in the bundle rather than refetched from the RSS
// because (a) the home page boost button has no episode context to
// query against, and (b) the RSS feed is a 1MB+ payload we don't want
// to fetch just to extract three lines of split data.
//
// applyRecipientOverrides is run at module init for symmetry with the
// episode flow (see api.openEpisodeBoost in index.jsx). The current
// override map only redirects boostbot@fountain.fm, which isn't in
// SHOW_SPLITS, so this is a no-op today — but pre-applying means a
// future override that targets one of these addresses won't silently
// skip the show-boost path.
const _SHOW_RECIPIENTS = applyRecipientOverrides([
  { name: 'Reed',      address: 'reed@getalby.com',      splitWeight: 33, type: 'lnaddress' },
  { name: 'RevHodl',   address: 'revhodl@minibits.cash', splitWeight: 33, type: 'lnaddress' },
  { name: 'aquafox30', address: 'aquafox30@primal.net',  splitWeight: 34, type: 'lnaddress' },
])
const SHOW_SPLITS = {
  recipients: _SHOW_RECIPIENTS,
  // Recompute from the post-override list — applyRecipientOverrides
  // can merge legs together, in which case the original totalWeight
  // (sum of pre-merge weights) would no longer match.
  totalWeight: _SHOW_RECIPIENTS.reduce((acc, r) => acc + (r.splitWeight || 0), 0),
  source: 'show',
}

export default function BoostModal({ user, onClose }) {
  const { visible, requestClose } = useModalTransition(onClose)

  // Cancellation flag for the presign step. Set true when the modal
  // begins to close so a slow signer prompt that resolves after the
  // X click doesn't queue a boost the user already aborted. Ref so
  // async closures see the latest value across awaits.
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])
  const handleClose = useCallback(() => {
    cancelledRef.current = true
    requestClose()
  }, [requestClose])

  const donorNpub = user?.npub || ''
  const profile = user?.profile

  // Live wallet status — if the wallet drops between gate-pass and
  // modal open (rare race), surface a notice rather than letting the
  // Boost click fail silently.
  const [walletStatus, setWalletStatus] = useState(() => wallet.getStatus())
  useEffect(() => wallet.onChange(setWalletStatus), [])

  const [amount, setAmount] = useState('1000')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [error, setError] = useState('')

  // Optional kind 1 share-to-feed — only useful with a real signer,
  // so hidden in anon mode.
  const [shareToFeed, setShareToFeed] = useState(false)
  const canShareToFeed = !anonymous && !!donorNpub
  useEffect(() => {
    if (anonymous && shareToFeed) setShareToFeed(false)
  }, [anonymous, shareToFeed])

  // Pre-sign progress label. Same UX hook the episode modal uses —
  // distinguishes "waiting on the signer" from "waiting on the
  // network" so a slow Amber prompt doesn't look like a stuck modal.
  const [prepareLabel, setPrepareLabel] = useState('')

  // Count of allowlisted recipients in the show splits — used to
  // tell the user how many signer prompts to expect.
  const allowlistedCount = SHOW_SPLITS.recipients
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

    // Pre-sign step: anything that needs a signer round-trip (kind
    // 30078s for allowlisted legs + optional kind 1 share-to-feed) is
    // collected here while the modal is open, so a remote-signer user
    // (Amber/bunker) doesn't get a surprise prompt after the modal
    // closes. Anonymous boosts skip both branches.
    let presigned = null
    let signedKindOne = null
    try {
      if (senderNpub && allowlistedCount > 0) {
        setPrepareLabel(allowlistedCount === 1
          ? 'Approve the boost receipt in your signer…'
          : `Approve ${allowlistedCount} boost receipts in your signer…`)
        presigned = await presignAllowlistedLegs({
          recipients: SHOW_SPLITS.recipients,
          totalWeight: SHOW_SPLITS.totalWeight,
          totalMsats: sats * 1000,
          message: trimmedMessage,
          donorNpub: senderNpub,
          pageUrl: SITE_URL,
          episodeMeta: null,   // show-level boost — no episode context
          lnurlCache: {},
        })
        if (cancelledRef.current) return
      }

      if (shareToFeed && canShareToFeed) {
        setPrepareLabel('Approve the share post in your signer…')
        try {
          // buildEpisodeBoostShareTemplate gracefully handles missing
          // episode fields — the kind 1 reads "Just boosted ⚡ X sats
          // to nostr:..." with no episode suffix, plus the donor's
          // message and a link back to the site. No need for a
          // separate show-level share template.
          const template = buildEpisodeBoostShareTemplate({
            amountSats: sats,
            message: trimmedMessage,
            episode: null,
            pageUrl: SITE_URL,
          })
          signedKindOne = await signKindOneShareWithUser(template)
        } catch (e) {
          // Don't kill the boost — the user wanted to share, but if
          // their signer rejected/timed out we just skip the share
          // quietly. The boost itself still goes through.
          console.warn('[lb] show-boost share-to-feed sign failed', e?.message || e)
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
      console.warn('[lb] show-boost presign threw unexpectedly', e?.message || e)
      setError('Something went wrong preparing your boost — try again in a moment.')
      return
    } finally {
      setPrepareLabel('')
    }

    // Fire and forget. Episode meta is a stub — payAllLegs's
    // buildLegExtraTags writes empty string for every episode-related
    // tag, which the bot can use to distinguish a show-level boost
    // from an episode boost (the LNURL comment is also "LocalBitcoinersShow"
    // rather than "LocalBitcoinersEpNNN" — see formatEpisodeComment).
    submitBoost({
      // `kind: 'show'` is read by the IdentityDropdown to render
      // "Show" instead of the "Episode" fallback while the boost is
      // in flight. The other episode fields stay empty — payAllLegs's
      // tag builder writes them through as empty strings, which is
      // exactly the show-level signal the bot needs (paired with the
      // "LocalBitcoinersShow" LNURL comment).
      episode: { number: null, title: '', guid: '', kind: 'show' },
      splits: SHOW_SPLITS,
      totalSats: sats,
      message: trimmedMessage,
      donorNpub: senderNpub,
      lnurlCache: {},
      wallet: wallet.getActiveWallet(),
      presigned,
      signedKindOne,
    })

    handleClose()
  }

  // Scroll lock + Esc-to-close intentionally NOT bound (X is the
  // only close path so a misclick doesn't lose typed input).
  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  const splitsCount = SHOW_SPLITS.recipients.length
  const walletGone = !walletStatus.connected

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/70 z-[70] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-[71] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label="Boost the Show"
      >
        <div className={`bg-neutral-900 border border-neutral-700 rounded-lg w-full max-w-sm flex flex-col shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] my-4 sm:my-8 transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Boost the Show</h2>
            <button
              onClick={handleClose}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1">

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
                  <div className="flex gap-1.5 mb-2">
                    {PRESETS.map(p => (
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
                  <input
                    type="number"
                    min={MIN_SATS}
                    max={MAX_SATS}
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
                    placeholder={`${MIN_SATS} minimum`}
                  />
                  <p className="mt-1 text-[10px] text-neutral-600">
                    {MIN_SATS} sat minimum (covers splits + fees).
                    Splits across {splitsCount} recipients.
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
                        Posts a kind 1 note to your followers — your
                        message + a link back here.
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
                  {prepareLabel ? 'Preparing boost…' : 'Boost the Show'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
