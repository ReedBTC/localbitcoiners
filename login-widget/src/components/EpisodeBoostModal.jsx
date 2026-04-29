/**
 * EpisodeBoostModal — per-episode multi-leg boost via NWC.
 *
 * The modal walks through three logical states:
 *
 *   1. Gate state — what's missing before we can boost?
 *      - Not signed in with Nostr     → show LoginModal (NWC requires
 *                                        a signer to encrypt the URI to).
 *      - Signed in, no NWC connected  → show NWC connect form
 *                                        (paste URI; alternatives: Alby
 *                                        Hub, Primal NWC, etc.).
 *      - Signed in + NWC ready        → show boost form.
 *
 *   2. Form state — amount, message, anon toggle, recipient list, boost.
 *
 *   3. Progress state — per-leg dots, then a paid summary.
 *
 * Anonymous mode notes:
 *   - The kind 30078 events are *always* burner-signed regardless of
 *     anon toggle (per spec design — burners give donors a UX-free
 *     channel for metadata signing).
 *   - The `sender` tag carries the donor's npub when attributed, and is
 *     empty string when anonymous. That's the only behavioural difference
 *     between the two modes for episode boosts.
 */

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import LoginModal from './LoginModal.jsx'
import { isSafeUrl } from '../lib/utils.js'
import { SITE_URL } from '../lib/boostagram.js'
import { payAllLegs, LEG_STATUS } from '../lib/payAllLegs.js'
import * as nwc from '../lib/nwc.js'

const MIN_SATS = 100

const STATUS_COPY = {
  [LEG_STATUS.PENDING]:    'Queued',
  [LEG_STATUS.RESOLVING]:  'Resolving lightning address…',
  [LEG_STATUS.REQUESTING]: 'Requesting invoice…',
  [LEG_STATUS.PUBLISHING]: 'Publishing receipt…',
  [LEG_STATUS.PAYING]:     'Paying…',
  [LEG_STATUS.PAID]:       'Paid',
  [LEG_STATUS.FAILED]:     'Failed',
}

export default function EpisodeBoostModal({
  user,
  onUserChange,
  onClose,
  episode,        // { number, title, guid }
  splitsBundle,   // { recipients, totalWeight, source }
}) {
  const donorNpub = user?.npub || ''
  const profile = user?.profile

  // ── Gate state ─────────────────────────────────────────────────────
  const [loginOpen, setLoginOpen] = useState(false)
  // NWC status. Snapshotted into local state so subscribing to nwc
  // change notifications re-renders the modal even when the parent's
  // user prop didn't change.
  const [nwcStatus, setNwcStatus] = useState(() => nwc.getStatus())

  useEffect(() => {
    return nwc.onChange(setNwcStatus)
  }, [])

  // Auto-attempt unlock when the user is signed in and a stored blob
  // exists for them. Single-shot per (user, hasStoredBlob) transition —
  // we don't keep retrying if unlock fails (e.g. wrong account); the
  // user can reconnect manually.
  const unlockAttemptedRef = useRef(false)
  useEffect(() => {
    if (!user) return
    if (nwcStatus.connected) return
    if (!nwcStatus.hasStoredBlob) return
    if (unlockAttemptedRef.current) return
    unlockAttemptedRef.current = true
    nwc.ensureReady(user).catch((e) => {
      setNwcConnectError(e?.message || 'Couldn\'t unlock saved wallet.')
    })
  }, [user, nwcStatus])

  // ── NWC connect form ──────────────────────────────────────────────
  const [nwcUriInput, setNwcUriInput] = useState('')
  const [nwcConnecting, setNwcConnecting] = useState(false)
  const [nwcConnectError, setNwcConnectError] = useState('')

  async function handleConnectNwc() {
    setNwcConnectError('')
    if (!user) {
      setLoginOpen(true)
      return
    }
    const uri = nwcUriInput.trim()
    if (!uri) { setNwcConnectError('Paste your NWC connection string above.'); return }
    setNwcConnecting(true)
    try {
      await nwc.connect(uri, user)
      setNwcUriInput('')
    } catch (e) {
      setNwcConnectError(e?.message || 'Connection failed.')
    } finally {
      setNwcConnecting(false)
    }
  }

  function handleDisconnectNwc() {
    // Destructive — wipes the encrypted NWC blob from localStorage,
    // forcing a re-paste on next use. Confirm so a stray click doesn't
    // cost the user a round-trip back to their wallet for the URI.
    const ok = window.confirm(
      'Disconnect this Lightning wallet? You\'ll need to paste your NWC connection string again to boost.',
    )
    if (!ok) return
    nwc.disconnect()
    unlockAttemptedRef.current = false
  }

  // ── Boost form ────────────────────────────────────────────────────
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  // Default attributed when logged in, anon when not. Toggle lives in
  // the form regardless — even logged-in users can opt out of attribution.
  const [anonymous, setAnonymous] = useState(!donorNpub)
  // When the user signs in mid-modal (gate → form transition), default
  // their attribution to attributed. Same pattern as BoostModal.
  const prevDonorRef = useRef(donorNpub)
  useEffect(() => {
    if (!prevDonorRef.current && donorNpub) setAnonymous(false)
    prevDonorRef.current = donorNpub
  }, [donorNpub])

  // ── Progress state ────────────────────────────────────────────────
  // null = haven't started; array = per-leg state mid-flight or done.
  const [legStates, setLegStates] = useState(null)
  const [boostError, setBoostError] = useState('')
  const [boosting, setBoosting] = useState(false)
  const [doneSummary, setDoneSummary] = useState(null)

  function handleLegUpdate(legIndex, legState) {
    setLegStates((prev) => {
      if (!prev) return prev
      const next = prev.slice()
      next[legIndex] = legState
      return next
    })
  }

  async function handleBoost() {
    setBoostError('')
    const sats = parseInt(amount, 10)
    if (!Number.isFinite(sats) || sats < MIN_SATS) {
      setBoostError(`Minimum boost is ${MIN_SATS} sats (covers splits + fees).`)
      return
    }
    if (!nwc.isReady()) {
      setBoostError('Wallet not connected — connect a Lightning wallet to boost the episode.')
      return
    }

    // Initialize per-leg state in input order so the dots show in the
    // same order as the recipient list above.
    const initial = splitsBundle.recipients.map((r, i) => ({
      index: i,
      recipient: r,
      msats: 0,
      status: LEG_STATUS.PENDING,
      error: null,
    }))
    setLegStates(initial)
    setBoosting(true)
    setDoneSummary(null)

    try {
      const result = await payAllLegs({
        recipients: splitsBundle.recipients,
        totalWeight: splitsBundle.totalWeight,
        totalMsats: sats * 1000,
        message: message.trim(),
        donorNpub: anonymous ? '' : donorNpub,
        pageUrl: SITE_URL,
        episodeMeta: episode,
        nwcClient: nwc.getClient(),
        onStatus: handleLegUpdate,
      })
      setDoneSummary(result)
    } catch (e) {
      // payAllLegs is supposed to never throw — this is just belt+braces.
      setBoostError(e?.message || 'Unexpected error during boost.')
    } finally {
      setBoosting(false)
    }
  }

  // ── Modal scaffolding (Esc to close, scroll lock) ────────────────
  useEffect(() => {
    function onKey(e) {
      if (loginOpen) return
      if (boosting) return  // don't let Esc abandon a flight in progress
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, loginOpen, boosting])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // ── Render helpers ────────────────────────────────────────────────
  const epLabel = episode?.number ? `Ep. ${String(episode.number).padStart(3, '0')}` : 'Episode'
  const headerTitle = `⚡ Boost ${epLabel}`
  const splitsCount = splitsBundle?.recipients?.length || 0

  // Decide gate vs form vs progress.
  const showLoginPrompt = !user
  const showNwcConnect = !!user && !nwcStatus.connected
  const showProgress = !!legStates
  const showForm = !showLoginPrompt && !showNwcConnect && !showProgress

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-[70]" onClick={boosting ? undefined : onClose} aria-hidden="true" />

      <div
        className="fixed inset-0 z-[71] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
        role="dialog"
        aria-label={headerTitle}
        onClick={(e) => { if (e.target === e.currentTarget && !boosting) onClose() }}
      >
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-sm flex flex-col shadow-2xl my-4 sm:my-8">

          {/* Header */}
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">{headerTitle}</h2>
            <button
              onClick={onClose}
              disabled={boosting}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none disabled:opacity-30"
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

            {/* ── Gate: not signed in ─────────────────────────────── */}
            {showLoginPrompt && (
              <div className="space-y-3">
                <p className="text-xs text-neutral-400 leading-relaxed">
                  Episode boosts split your sats across the show + guests
                  per the value-for-value splits in the RSS feed. Sign in
                  with Nostr first — we use your account to securely store
                  your wallet connection.
                </p>
                <button
                  onClick={() => setLoginOpen(true)}
                  className="w-full py-3 rounded bg-orange-500 hover:bg-orange-600 text-sm font-medium text-white transition-colors"
                >
                  Sign in with Nostr
                </button>
                <p className="text-[10px] text-neutral-600 leading-snug">
                  Already have a regular Lightning wallet but no Nostr?
                  You can still boost the show as a single payment via the
                  ⚡ Boost the Show button.
                </p>
              </div>
            )}

            {/* ── Gate: NWC connect ────────────────────────────────── */}
            {showNwcConnect && (
              <div className="space-y-3">
                <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2.5 space-y-1">
                  <p className="text-[11px] text-neutral-500 uppercase tracking-wide">Connect a Lightning wallet</p>
                  <p className="text-xs text-neutral-400 leading-snug">
                    Episode boosts make multiple payments at once (one per
                    recipient in the split). This needs a NWC-capable
                    wallet so all legs settle without prompting you N times.
                  </p>
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">NWC connection string</label>
                  <textarea
                    value={nwcUriInput}
                    onChange={e => setNwcUriInput(e.target.value)}
                    rows={3}
                    placeholder="nostr+walletconnect://…"
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-xs text-neutral-100 font-mono focus:outline-none focus:border-orange-500"
                  />
                  <p className="mt-1.5 text-[10px] text-neutral-600 leading-snug">
                    Get a connection string from Alby Hub, Primal,
                    Mutiny, Coinos, or any wallet that supports NIP-47.
                    Encrypted with your Nostr key before saving — useless
                    to anyone without your account.
                  </p>
                </div>
                {nwcConnectError && (
                  <p className="text-xs text-red-400">{nwcConnectError}</p>
                )}
                <button
                  onClick={handleConnectNwc}
                  disabled={nwcConnecting}
                  className="w-full py-3 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {nwcConnecting ? 'Connecting…' : 'Connect Wallet'}
                </button>
              </div>
            )}

            {/* ── Form ─────────────────────────────────────────────── */}
            {showForm && (
              <>
                <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" aria-hidden="true" />
                      <span className="text-xs text-neutral-300 truncate">
                        {nwcStatus.alias || 'Lightning wallet'}
                      </span>
                    </div>
                    <button
                      onClick={handleDisconnectNwc}
                      className="text-[10px] text-neutral-600 hover:text-red-400 transition-colors flex-shrink-0 underline-offset-2 hover:underline"
                      aria-label="Disconnect Lightning wallet"
                    >
                      Disconnect
                    </button>
                  </div>
                  <p className="text-[10px] text-neutral-600 mt-1">Wallet connected and ready to boost.</p>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Amount (sats)</label>
                  <input
                    type="number"
                    min={MIN_SATS}
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500"
                    placeholder={`${MIN_SATS} minimum`}
                  />
                  <p className="mt-1 text-[10px] text-neutral-600">
                    {MIN_SATS} sat minimum (covers splits + fees).
                    Splits across {splitsCount} {splitsCount === 1 ? 'recipient' : 'recipients'}.
                  </p>
                </div>

                {/* Boost as toggle. Same shape as BoostModal: avatar +
                    name on the attributed side, "Anon" on the other. No
                    inline sign-in here — by this point the user is
                    already signed in (the gate guards above). */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Boost as</label>
                  <div className="flex rounded-md overflow-hidden border border-neutral-700 text-xs">
                    <button
                      onClick={() => setAnonymous(false)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-3 px-3 transition-colors ${
                        !anonymous ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
                      }`}
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
                      className={`flex-1 py-3 px-3 border-l border-neutral-700 transition-colors ${
                        anonymous ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
                      }`}
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
                      // Auto-grow: reset to auto first so the height
                      // shrinks on backspace, then size to fit content.
                      // rows={4} keeps the minimum visual size when empty.
                      const el = e.target
                      el.style.height = 'auto'
                      el.style.height = el.scrollHeight + 'px'
                    }}
                    rows={4}
                    maxLength={10000}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 resize-none overflow-hidden leading-relaxed"
                    placeholder="Leave a note for the show + guests"
                  />
                </div>

                {boostError && <p className="text-xs text-red-400">{boostError}</p>}

                <button
                  onClick={handleBoost}
                  disabled={boosting}
                  className="w-full py-3 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  Boost Episode ⚡
                </button>
              </>
            )}

            {/* ── Progress / done ─────────────────────────────────── */}
            {showProgress && (
              <div className="space-y-3">
                <ul className="space-y-1.5">
                  {legStates.map((leg) => (
                    <li
                      key={leg.index}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          leg.status === LEG_STATUS.PAID ? 'bg-green-500' :
                          leg.status === LEG_STATUS.FAILED ? 'bg-red-500' :
                          leg.status === LEG_STATUS.PENDING ? 'bg-neutral-700' :
                          'bg-orange-500 animate-pulse'
                        }`}
                      />
                      <span className="flex-1 text-neutral-400 truncate">
                        {leg.recipient.name || leg.recipient.address}
                      </span>
                      <span className={`text-[10px] ${
                        leg.status === LEG_STATUS.FAILED ? 'text-red-400' :
                        leg.status === LEG_STATUS.PAID ? 'text-green-400' :
                        'text-neutral-500'
                      }`}>
                        {STATUS_COPY[leg.status] || leg.status}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* Per-leg failure detail. Collapses by default but
                    shows error messages inline so users can decide
                    whether to top up the boost amount or move on. */}
                {legStates.some(l => l.status === LEG_STATUS.FAILED) && (
                  <ul className="space-y-1 text-[10px] text-red-400">
                    {legStates.filter(l => l.status === LEG_STATUS.FAILED).map(l => (
                      <li key={l.index} className="leading-snug">
                        <span className="text-neutral-500">{l.recipient.name || l.recipient.address}: </span>
                        {l.error || 'Failed'}
                      </li>
                    ))}
                  </ul>
                )}

                {doneSummary && (
                  <div className="border-t border-neutral-800 pt-3 space-y-2 text-center">
                    {doneSummary.allSucceeded ? (
                      <>
                        <p className="text-base font-semibold text-green-400">All legs paid ⚡</p>
                        <p className="text-xs text-neutral-500">
                          Thanks for the boost — split across the show + guests.
                        </p>
                      </>
                    ) : doneSummary.anySucceeded ? (
                      <>
                        <p className="text-base font-semibold text-orange-400">Partial boost</p>
                        <p className="text-xs text-neutral-500">
                          Some legs paid, some didn't. Recipients on a
                          working address will see your message.
                        </p>
                      </>
                    ) : (
                      <p className="text-base font-semibold text-red-400">No legs paid</p>
                    )}
                    <button
                      onClick={onClose}
                      className="mt-1 px-6 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-sm text-neutral-200 transition-colors"
                    >
                      Close
                    </button>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>

      {loginOpen && createPortal(
        <LoginModal
          onLogin={(u) => onUserChange?.(u)}
          onClose={() => setLoginOpen(false)}
        />,
        document.body
      )}
    </>
  )
}
