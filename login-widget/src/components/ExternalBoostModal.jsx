/**
 * ExternalBoostModal — boost another podcast's episode (Podcasting 2.0 V4V).
 *
 * DELIBERATELY SEPARATE from EpisodeBoostModal / MultiLegBoostForm (the LB
 * boost path, untouched). This runs the external orchestrator (lib/
 * externalBoost.js): pays the episode's value-block recipients via LNURL
 * (lnaddress) and keysend (node), publishes NO kind 30078, and — only when the
 * booster is signed in and opts in — posts a kind-1 note tagged to the external
 * show's guid + Boost Me Bitch URL. Nothing here touches LB stats/bots.
 *
 * Progress UI is self-contained (not the LB BoostProgressView) so the external
 * leg shape / skipped legs / keysend-uncertain retry rules stay independent.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import { isSafeUrl } from '../lib/utils.js'
import * as wallet from '../lib/wallet.js'
import { payExternalBoost, STATUS } from '../lib/externalBoost.js'
import { buildExternalNoteTemplate, MAX_MESSAGE_CHARS } from '../lib/externalBoostagram.js'
import { signKindOneShareWithUser, publishSignedKindOne, confirmInvoiceSettled } from '../lib/boostagram.js'
import { setBoostModalProgressVisible } from '../lib/boostModalSignal.js'
import { fireConfetti } from '../lib/confetti.js'
import ConfirmLeaveOverlay from './ConfirmLeaveOverlay.jsx'

const MIN_SATS = 21
const MAX_SATS = 5_000_000
const WORKING = STATUS.PAYING

function fmtSats(n) { return Number(n || 0).toLocaleString() }

// One per-recipient row in the progress list.
function LegRow({ recipient, leg, onRetry }) {
  const status = leg?.status || STATUS.PENDING
  const sats = leg?.sats
  const canRetry = (status === STATUS.FAILED || status === STATUS.UNCERTAIN) && onRetry
  let icon = <span className="inline-block w-3.5 h-3.5 rounded-full border border-neutral-600" aria-hidden="true" />
  if (status === STATUS.PAID) icon = <span className="text-green-400" aria-hidden="true">✓</span>
  else if (status === STATUS.FAILED) icon = <span className="text-red-400" aria-hidden="true">✕</span>
  else if (status === STATUS.UNCERTAIN) icon = <span className="text-amber-400" aria-hidden="true">!</span>
  else if (status === WORKING) icon = (
    <svg className="animate-spin w-3.5 h-3.5 text-orange-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
  return (
    <li className="flex items-center gap-2 py-1.5 text-xs">
      <span className="w-4 flex justify-center shrink-0">{icon}</span>
      <span className="flex-1 min-w-0 truncate text-neutral-300">{recipient?.name || recipient?.address || 'Recipient'}</span>
      {sats != null && <span className="shrink-0 tabular-nums text-neutral-500">{fmtSats(sats)} sats</span>}
      {canRetry && (
        <button onClick={onRetry} className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-neutral-700 text-neutral-300 hover:border-orange-500 hover:text-orange-300 transition-colors">
          Retry
        </button>
      )}
      {(status === STATUS.FAILED || status === STATUS.UNCERTAIN) && leg?.error && (
        <span className="sr-only">{leg.error}</span>
      )}
    </li>
  )
}

export default function ExternalBoostModal({ user, onClose, episode, recipientsBundle }) {
  const { visible, requestClose } = useModalTransition(onClose)
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  const donorNpub = user?.npub || ''
  const signedIn = !!donorNpub
  const profile = user?.profile

  const recipients = recipientsBundle?.recipients || []
  const totalWeight = recipientsBundle?.totalWeight || 0
  const hasValue = recipients.length > 0 && totalWeight > 0

  const [amount, setAmount] = useState('1000')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [shareToFeed, setShareToFeed] = useState(false)
  const [error, setError] = useState('')
  const canShareToFeed = !anonymous && signedIn
  useEffect(() => { if (anonymous && shareToFeed) setShareToFeed(false) }, [anonymous, shareToFeed])

  const [phase, setPhase] = useState('form')       // 'form' | 'sending' | 'done'
  const [legs, setLegs] = useState([])             // per-recipient live state (aligned to recipients)
  const [confirmLeave, setConfirmLeave] = useState(false)

  useEffect(() => { lockBodyScroll(); return () => unlockBodyScroll() }, [])

  const progressActive = phase === 'sending'
  useEffect(() => {
    setBoostModalProgressVisible(phase !== 'form')
    return () => setBoostModalProgressVisible(false)
  }, [phase])

  const [walletStatus, setWalletStatus] = useState(() => wallet.getStatus())
  useEffect(() => wallet.onChange(setWalletStatus), [])

  const guardedClose = () => {
    if (progressActive) setConfirmLeave(true)
    else requestClose()
  }

  const updateLeg = useCallback((index, patch) => {
    if (cancelledRef.current) return
    setLegs((prev) => { const next = prev.slice(); next[index] = { ...next[index], ...patch }; return next })
  }, [])

  async function maybeShareNote(totalSats) {
    if (!canShareToFeed || !shareToFeed) return
    try {
      const template = buildExternalNoteTemplate({
        amountSats: totalSats,
        message: message.trim(),
        showTitle: episode?.showTitle,
        episodeTitle: episode?.episodeTitle,
        podcastGuid: episode?.podcastGuid,
        itemGuid: episode?.itemGuid,
        bmbUrl: episode?.bmbUrl,
      })
      const signed = await signKindOneShareWithUser(template)
      await publishSignedKindOne(signed)
    } catch (e) {
      console.warn('[lb] external boost share note failed', e?.message || e)
    }
  }

  async function handleBoost() {
    setError('')
    const sats = parseInt(amount, 10)
    if (!Number.isFinite(sats) || sats < MIN_SATS) { setError(`Minimum boost is ${MIN_SATS} sats.`); return }
    if (sats > MAX_SATS) { setError(`Max ${MAX_SATS.toLocaleString()} sats per boost.`); return }
    if (!wallet.isReady()) { setError('Connect a Lightning wallet from your account menu first.'); return }

    // Seed one pending row per recipient so the list renders immediately.
    setLegs(recipients.map(() => ({ status: STATUS.PENDING })))
    setPhase('sending')

    let result
    try {
      result = await payExternalBoost({
        recipients,
        totalWeight,
        totalSats: sats,
        message: message.trim(),
        senderName: anonymous ? '' : (profile?.displayName || profile?.name || ''),
        senderPubkey: anonymous ? '' : (user?.pubkey || ''),
        meta: {
          showTitle: episode?.showTitle,
          episodeTitle: episode?.episodeTitle,
          podcastGuid: episode?.podcastGuid,
          itemGuid: episode?.itemGuid,
          url: episode?.bmbUrl,
        },
        onLeg: (i, legState) => updateLeg(i, legState),
      })
    } catch (e) {
      setError(e?.message || 'Boost failed to start')
      setPhase('form')
      return
    }
    if (cancelledRef.current) return
    setPhase('done')
    if (result.anyPaid) {
      fireConfetti()
      maybeShareNote(sats)
    }
  }

  // Retry a single leg in place. Double-spend guard: an 'uncertain' lnaddress
  // leg is confirmed via LUD-21 before any re-pay; an 'uncertain' keysend leg
  // (no verify URL) is never auto-retried.
  async function handleRetry(index) {
    const recipient = recipients[index]
    const leg = legs[index]
    if (!recipient || !leg) return
    if (leg.status === STATUS.UNCERTAIN) {
      if (recipient.type === 'lnaddress' && leg.verifyUrl && leg.paymentHash) {
        updateLeg(index, { status: STATUS.PAYING, error: null })
        const settled = await confirmInvoiceSettled(leg.verifyUrl, leg.paymentHash)
        if (settled === 'settled') { updateLeg(index, { status: STATUS.PAID, error: null }); return }
        if (settled !== 'unsettled') {
          updateLeg(index, { status: STATUS.UNCERTAIN, error: 'Still can’t confirm — check your wallet before retrying.' })
          return
        }
        // 'unsettled' → safe to re-pay, fall through.
      } else {
        updateLeg(index, { status: STATUS.UNCERTAIN, error: 'Can’t auto-confirm a keysend — check your wallet directly.' })
        return
      }
    }
    if (!wallet.isReady()) { updateLeg(index, { status: STATUS.FAILED, error: 'Wallet not connected' }); return }
    updateLeg(index, { status: STATUS.PAYING, error: null })
    try {
      const res = await payExternalBoost({
        recipients: [recipient],
        totalWeight: recipient.splitWeight || 1,
        totalSats: leg.sats || 0,
        message: message.trim(),
        senderName: anonymous ? '' : (profile?.displayName || profile?.name || ''),
        senderPubkey: anonymous ? '' : (user?.pubkey || ''),
        meta: {
          showTitle: episode?.showTitle, episodeTitle: episode?.episodeTitle,
          podcastGuid: episode?.podcastGuid, itemGuid: episode?.itemGuid, url: episode?.bmbUrl,
        },
        onLeg: (_i, ls) => updateLeg(index, { ...ls, sats: leg.sats }),
      })
      if (res?.anyPaid) fireConfetti()
    } catch (e) {
      updateLeg(index, { status: STATUS.FAILED, error: e?.message || 'Retry failed' })
    }
  }

  const headerTitle = '⚡ Boost episode'
  const visibleLegs = phase !== 'form' ? recipients.map((r, i) => ({ r, leg: legs[i] })).filter(({ leg }) => leg && leg.status !== STATUS.SKIPPED) : []
  const paidCount = legs.filter((l) => l?.status === STATUS.PAID).length
  const activeCount = visibleLegs.length
  const allPaid = phase === 'done' && activeCount > 0 && paidCount === activeCount

  return (
    <>
      <div className={`fixed inset-0 bg-black/70 z-[70] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-3 sm:p-4 overflow-hidden" role="dialog" aria-label={headerTitle}>
        <div className={`relative bg-neutral-900 border border-neutral-700 rounded-lg w-full max-w-lg max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800 shrink-0">
            <h2 className="text-sm font-semibold text-neutral-200">{headerTitle}</h2>
            <button onClick={guardedClose} className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none" aria-label="Close">✕</button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1 min-h-0 overflow-y-auto">
            {episode?.showTitle && (
              <div className="text-xs text-neutral-400 leading-snug">
                <span className="font-semibold text-neutral-300">{episode.showTitle}</span>
                {episode?.episodeTitle && <span className="block italic mt-0.5">"{episode.episodeTitle}"</span>}
              </div>
            )}

            {!hasValue && (
              <div className="space-y-3 text-center py-2">
                <p className="text-sm text-neutral-400">This episode doesn't have a Podcasting 2.0 value block, so there's no split to boost to.</p>
                <button onClick={requestClose} className="px-4 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-sm text-neutral-200 transition-colors">Close</button>
              </div>
            )}

            {hasValue && phase === 'form' && (
              <>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Amount (sats)</label>
                  <input type="number" min={MIN_SATS} max={MAX_SATS} value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30"
                    placeholder={`${MIN_SATS} minimum`} />
                  <p className="mt-1 text-[10px] text-neutral-600">Splits across {recipients.length} {recipients.length === 1 ? 'recipient' : 'recipients'} per the show's value block.</p>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Boost as</label>
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => setAnonymous(false)} aria-pressed={!anonymous}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-3 px-3 rounded-md border transition-colors ${!anonymous ? 'bg-orange-500/15 border-orange-500 text-orange-200 font-semibold' : 'bg-neutral-800 border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'}`}>
                      {profile?.image && isSafeUrl(profile.image) && <img src={profile.image} alt="" className="w-4 h-4 rounded-full object-cover" onError={(e) => { e.target.style.display = 'none' }} />}
                      <span className="truncate max-w-[140px]">{profile?.displayName || profile?.name || (signedIn ? 'Your npub' : 'You')}</span>
                    </button>
                    <button onClick={() => setAnonymous(true)} aria-pressed={anonymous}
                      className={`flex-1 py-3 px-3 rounded-md border transition-colors ${anonymous ? 'bg-orange-500/15 border-orange-500 text-orange-200 font-semibold' : 'bg-neutral-800 border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600'}`}>Anon</button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Message (optional)</label>
                  <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_CHARS))} rows={3} maxLength={MAX_MESSAGE_CHARS}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/30 resize-none leading-relaxed"
                    placeholder="Say something to the show (rides along with the boost)" />
                  <p className="mt-1 text-[10px] text-neutral-600 text-right">{message.length}/{MAX_MESSAGE_CHARS}</p>
                </div>

                {canShareToFeed && (
                  <label className="flex items-start gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                    <input type="checkbox" checked={shareToFeed} onChange={(e) => setShareToFeed(e.target.checked)} className="accent-orange-500 mt-0.5" />
                    <span className="leading-snug">Share to my feed
                      <span className="block text-[10px] text-neutral-600 mt-0.5">Posts a kind-1 note tagged to this episode with a link back.</span>
                    </span>
                  </label>
                )}

                {error && <p className="text-xs text-red-400">{error}</p>}

                <button onClick={handleBoost}
                  className="w-full inline-flex items-center justify-center gap-2 py-3 rounded bg-orange-500 hover:bg-orange-600 text-sm font-medium text-white transition-colors">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/></svg>
                  Boost episode
                </button>
              </>
            )}

            {hasValue && phase !== 'form' && (
              <div className="flex flex-col gap-3 min-h-[280px]">
                {phase === 'sending' && (
                  <p className="text-sm font-semibold text-orange-300">Sending your boost — keep this window open</p>
                )}
                {allPaid && <p className="text-base font-semibold text-green-400">⚡ Boost delivered!</p>}
                {phase === 'done' && !allPaid && (
                  <p className="text-sm font-semibold text-amber-400">
                    {paidCount > 0 ? `${paidCount} of ${activeCount} legs sent — retry any that didn't.` : 'Boost didn’t go through — check your wallet and retry.'}
                  </p>
                )}
                <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-neutral-800">
                  {visibleLegs.map(({ r, leg }) => {
                    const realIndex = recipients.indexOf(r)
                    return <LegRow key={`${r.address}-${realIndex}`} recipient={r} leg={leg} onRetry={phase === 'done' ? () => handleRetry(realIndex) : null} />
                  })}
                </ul>
                {phase === 'done' && (
                  <button onClick={requestClose} className="mt-1 w-full py-2.5 rounded bg-neutral-700 hover:bg-neutral-600 text-sm text-neutral-200 transition-colors">Done</button>
                )}
              </div>
            )}
          </div>

          {confirmLeave && progressActive && (
            <ConfirmLeaveOverlay paid={paidCount} total={activeCount || recipients.length} onStay={() => setConfirmLeave(false)} onLeave={requestClose} />
          )}
        </div>
      </div>
    </>
  )
}
