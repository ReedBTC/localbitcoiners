/**
 * EpisodeBoostModal — per-episode multi-leg boost form.
 *
 * Now stripped down to validation + form-and-fire. After the user hits
 * Boost the modal closes immediately; the actual orchestration runs
 * in the background via boostQueue. Results show up in the identity
 * dropdown's "Recent Boosts" section. Reed's call: a casual user
 * shouldn't have to babysit a 5-20s payment fan-out.
 *
 * Anonymous mode notes:
 *   - The kind 30078 events are *always* burner-signed regardless of
 *     anon toggle (per spec design — burners give donors a UX-free
 *     channel for metadata signing).
 *   - The `sender` tag carries the donor's npub when attributed, and
 *     is empty string when anonymous.
 */

import { useState, useEffect } from 'react'
import { isSafeUrl } from '../lib/utils.js'
import { fetchLnurlMeta } from '../lib/boostagram.js'
import * as nwc from '../lib/nwc.js'
import { submitBoost } from '../lib/boostQueue.js'
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

  function handleBoost() {
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

    // Fire and forget. The boostQueue tracks in-flight + persists the
    // outcome to history when payAllLegs completes; the dropdown
    // surfaces both states.
    submitBoost({
      episode,
      splits: splitsBundle,
      totalSats: sats,
      message: message.trim(),
      donorNpub: anonymous ? '' : donorNpub,
      lnurlCache,
      nwcClient: nwc.getClient(),
    })

    // Close immediately — user gets back to browsing.
    requestClose()
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
              onClick={requestClose}
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
                  onClick={requestClose}
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

                {error && <p className="text-xs text-red-400">{error}</p>}

                <button
                  onClick={handleBoost}
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded bg-orange-500 hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
                  </svg>
                  Boost Episode
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
