/**
 * EpisodeBoostModal — per-episode multi-leg boost form.
 *
 * Thin wrapper around <MultiLegBoostForm>: owns the modal chrome
 * + the per-episode LNURL prefetch (resolves every recipient's
 * .well-known/lnurlp endpoint in parallel as soon as the modal
 * mounts so payAllLegs can skip its own resolve step at boost time).
 *
 * Per-episode inputs supplied to the shared form:
 *   - splitsBundle from the RSS value block (parsed by index.html
 *     and handed in via the openEpisodeBoost API)
 *   - episodeMeta with the real episode number, title, guid
 *   - no presets (just the custom-amount input)
 *   - share-to-feed copy that mentions the episode
 *   - "Boost Episode" button label
 */

import { useState, useEffect } from 'react'
import { fetchLnurlMeta } from '../lib/boostagram.js'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'
import MultiLegBoostForm from './MultiLegBoostForm.jsx'

const EPISODE_SHARE_TAGLINE = 'Posts a kind 1 note to your followers — the episode + your message + a link back here.'

export default function EpisodeBoostModal({
  user,
  onClose,
  episode,        // { number, title, guid }
  splitsBundle,   // { recipients, totalWeight, source }
}) {
  const { visible, requestClose } = useModalTransition(onClose)

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

  // Scroll lock + Esc-to-close intentionally NOT bound (X is the
  // only close path so a misclick doesn't lose typed input).
  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  const epLabel = episode?.number ? `Ep. ${String(episode.number).padStart(3, '0')}` : 'Episode'
  const headerTitle = `⚡ Boost ${epLabel}`

  return (
    <>
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
            <MultiLegBoostForm
              user={user}
              splitsBundle={splitsBundle}
              episodeMeta={episode}
              shareTagline={EPISODE_SHARE_TAGLINE}
              buttonLabel="Boost Episode"
              lnurlCache={lnurlCache}
              subtitle={episode?.title || null}
              onCancelled={requestClose}
            />
          </div>
        </div>
      </div>
    </>
  )
}
