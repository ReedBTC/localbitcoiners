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
 *   - sat presets (100/210/2100/21000)
 *   - "Boost the Show" button label
 *
 * applyRecipientOverrides runs at module init for symmetry with the
 * episode flow — today the override map only redirects fountain.fm
 * addresses (not in the show splits), but pre-applying means a future
 * override that targets one of these addresses won't silently skip
 * the show-boost path.
 */

import { useEffect } from 'react'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import { applyRecipientOverrides } from '../lib/recipientOverrides.js'
import MultiLegBoostForm from './MultiLegBoostForm.jsx'

const _SHOW_RECIPIENTS = applyRecipientOverrides([
  { name: 'Reed',      address: 'reed@getalby.com',      splitWeight: 33, type: 'lnaddress' },
  { name: 'RevHodl',   address: 'revhodl@minibits.cash', splitWeight: 33, type: 'lnaddress' },
  { name: 'aquafox30', address: 'aquafox30@primal.net',  splitWeight: 34, type: 'lnaddress' },
])
const SHOW_SPLITS = {
  recipients: _SHOW_RECIPIENTS,
  totalWeight: _SHOW_RECIPIENTS.reduce((acc, r) => acc + (r.splitWeight || 0), 0),
  source: 'show',
}

// `kind: 'show'` is read by the IdentityDropdown to render "Show"
// instead of falling through to the "Episode" defensive default. The
// other episode fields stay empty — payAllLegs's tag builder writes
// them through as empty strings, which is exactly the show-level
// signal the bot needs (paired with the "LocalBitcoinersShow" LNURL
// comment from formatEpisodeComment(null)).
const SHOW_EPISODE_META = { number: null, title: '', guid: '', kind: 'show' }
const SHOW_PRESETS = [100, 210, 2100, 21000]
const SHOW_SHARE_TAGLINE = 'Posts a kind 1 note to your followers — your message + a link back here.'

export default function BoostModal({ user, onClose }) {
  const { visible, requestClose } = useModalTransition(onClose)

  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

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
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Boost the Show</h2>
            <button
              onClick={requestClose}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 sm:px-6 py-5 space-y-4 flex-1">
            <MultiLegBoostForm
              user={user}
              splitsBundle={SHOW_SPLITS}
              episodeMeta={SHOW_EPISODE_META}
              presets={SHOW_PRESETS}
              shareTagline={SHOW_SHARE_TAGLINE}
              buttonLabel="Boost the Show"
              onCancelled={requestClose}
            />
          </div>
        </div>
      </div>
    </>
  )
}
