/**
 * BoostModal — site-wide "Boost the Show" form.
 *
 * Thin wrapper around <MultiLegBoostForm>: just owns the modal chrome
 * (backdrop, transitions, scroll lock, header + close X) and supplies
 * the show-level inputs:
 *   - hardcoded splitsBundle (channel-level value block from the RSS,
 *     baked into the bundle so the home-page boost button has no
 *     dependency on the RSS proxy at click time)
 *   - episodeMeta with `kind: 'show'` so the in-flight dropdown reads
 *     "Show" and the bot can distinguish show-level boosts from
 *     episode boosts via empty episode/title/guid tags
 *   - sat presets (100/420/3333/21000)
 *   - "Boost the Show" button label
 *
 * applyRecipientOverrides runs at module init for symmetry with the
 * episode flow — today the override map only redirects fountain.fm
 * addresses (not in the show splits), but pre-applying means a future
 * override that targets one of these addresses won't silently skip
 * the show-boost path. It is called with a null episode number, so
 * per-episode override layers never apply to a show boost.
 *
 * `authorSplit` reassigns the third leg. A Feature boost from the
 * Articles tab pays the featured article's author out of that leg, so
 * the sats follow the thing being promoted; the two host legs are
 * untouched. The host callers may only pass a name (no address) when
 * the author has no Lightning address on their profile, in which case
 * the splits stay as-is and the modal says why.
 */

import { useEffect, useMemo, useState } from 'react'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import { applyRecipientOverrides } from '../lib/recipientOverrides.js'
import MultiLegBoostForm from './MultiLegBoostForm.jsx'
import ConfirmLeaveOverlay from './ConfirmLeaveOverlay.jsx'

const SHOW_RECIPIENTS_RAW = [
  { name: 'Reed',      address: 'reed@getalby.com',      splitWeight: 33, type: 'lnaddress' },
  { name: 'RevHodl',   address: 'revhodl@minibits.cash', splitWeight: 33, type: 'lnaddress' },
  { name: 'aquafox30', address: 'aquafox30@primal.net',  splitWeight: 34, type: 'lnaddress' },
]
// The leg an authorSplit takes over. Named rather than indexed so a future
// reorder of the list above can't silently redirect a host's sats.
const REASSIGNABLE_ADDRESS = 'aquafox30@primal.net'

function buildSplits(recipients) {
  // `null` episode number: a show boost belongs to no episode, so only the
  // global override map applies. Passed explicitly so the show path can't
  // silently pick up a per-episode redirect.
  const applied = applyRecipientOverrides(recipients, null)
  return {
    recipients: applied,
    totalWeight: applied.reduce((acc, r) => acc + (r.splitWeight || 0), 0),
    source: 'show',
  }
}

const SHOW_SPLITS = buildSplits(SHOW_RECIPIENTS_RAW)

// A Lightning address, loosely — the LNURL fetch is the real validator. This
// only has to reject the empty/garbage values a kind-0 profile can carry.
function isLightningAddress(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

/**
 * Show splits with the reassignable leg pointed at the article's author.
 * No usable address (many long-form authors publish through RSS bridges
 * and have no lud16) → the standard splits are returned untouched, so
 * that 34% stays with aquafox30 rather than being spread across the
 * other two legs. applyRecipientOverrides deduplicates by address, so an
 * author who is already a host gets one merged leg rather than being
 * paid twice.
 */
function splitsForAuthor(authorSplit) {
  const address = authorSplit?.address?.trim?.() || ''
  if (!isLightningAddress(address)) return SHOW_SPLITS
  return buildSplits(SHOW_RECIPIENTS_RAW.map((r) => (
    r.address === REASSIGNABLE_ADDRESS
      ? { ...r, name: authorSplit.name || address, address: address.toLowerCase() }
      : r
  )))
}

// `kind: 'show'` is read by the IdentityDropdown to render "Show"
// instead of falling through to the "Episode" defensive default. The
// other episode fields stay empty — payAllLegs's tag builder writes
// them through as empty strings, which is exactly the show-level
// signal the bot needs (paired with the "LocalBitcoinersShow" LNURL
// comment from formatEpisodeComment(null)).
const SHOW_EPISODE_META = { number: null, title: '', guid: '', kind: 'show' }
const SHOW_PRESETS = [420, 2100, 3333, 6969]
const SHOW_SHARE_TAGLINE = 'Posts a kind 1 note to your followers — your message + a link back here.'

export default function BoostModal({ user, onClose, prefillMessage = '', authorSplit = null, onSettled, onRequestSignIn, onRequestWallet }) {
  const { visible, requestClose } = useModalTransition(onClose)

  const splits = useMemo(() => splitsForAuthor(authorSplit), [authorSplit])
  const authorPaid = splits !== SHOW_SPLITS
  const authorName = authorSplit?.name || 'the author'

  // Close guard: while legs are in flight, intercept the ✕ with a
  // confirm step instead of closing outright. boostState is reported up
  // from the form; null once the boost settles.
  const [boostState, setBoostState] = useState(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  useEffect(() => {
    if (!boostState?.active) setConfirmLeave(false)
  }, [boostState])
  const guardedClose = () => {
    if (boostState?.active) setConfirmLeave(true)
    else requestClose()
  }

  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  return (
    <>
      <div
        className={`fixed inset-0 bg-[var(--scrim,rgba(45,32,16,0.62))] z-[70] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-[71] flex items-center justify-center p-3 sm:p-4 overflow-hidden"
        role="dialog"
        aria-label="Boost the Show"
      >
        <div className={`relative bg-[var(--modal-bg,#fbf6ea)] border border-[var(--modal-line,#d4c4a0)] rounded-lg w-full max-w-lg max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] flex flex-col shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28),0_0_0_1px_rgba(11,58,82,0.06)] transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}>
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[var(--modal-line,#d4c4a0)] shrink-0">
            <h2 className="text-base font-semibold text-[var(--ink,#2d2010)] font-[family-name:var(--font-display,'Playfair_Display',Georgia,serif)]">⚡ Boost the Show</h2>
            <button
              onClick={guardedClose}
              className="text-[var(--muted,#6b5a3e)] hover:text-[var(--ink,#2d2010)] transition-colors text-lg leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1 min-h-0 overflow-y-auto">
            {authorSplit && (
              <p className="text-[11px] text-neutral-400 leading-snug rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
                {authorPaid ? (
                  <>
                    <span className="text-orange-400 font-semibold">34% of this boost</span>{' '}
                    goes to{' '}
                    <span className="text-neutral-300 font-semibold">{authorName}</span>, the
                    author of the article you're featuring. The rest splits between the hosts.
                  </>
                ) : (
                  <>
                    This article's author has no Lightning address on their Nostr profile, so
                    there's nowhere to route their share; this boost uses the show's standard
                    splits instead.
                  </>
                )}
              </p>
            )}

            <MultiLegBoostForm
              user={user}
              splitsBundle={splits}
              episodeMeta={SHOW_EPISODE_META}
              presets={SHOW_PRESETS}
              shareTagline={SHOW_SHARE_TAGLINE}
              buttonLabel="Boost the Show"
              defaultMessage={prefillMessage}
              onCancelled={requestClose}
              onBoostState={setBoostState}
              onSettled={onSettled}
              onRequestSignIn={onRequestSignIn}
              onRequestWallet={onRequestWallet}
            />
          </div>

          {confirmLeave && boostState?.active && (
            <ConfirmLeaveOverlay
              paid={boostState.paid}
              total={boostState.total}
              onStay={() => setConfirmLeave(false)}
              onLeave={requestClose}
            />
          )}
        </div>
      </div>
    </>
  )
}
