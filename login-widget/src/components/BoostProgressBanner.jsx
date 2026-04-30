import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { onInFlightChange, getInFlight } from '../lib/boostQueue.js'
import { requestIdentityOpen } from '../lib/identitySignal.js'

/**
 * Top-of-page banner shown while any boost is actively processing.
 *
 * The boost flow is otherwise silent (modal closes immediately, send-and-
 * forget) — without this, a casual donor has no signal that they should
 * stay on the page until their multi-leg payment finishes. The banner
 * appears as soon as a boost is queued and clears once every entry has
 * settled (paid, partial, or failed).
 *
 * z-index sits above the sticky nav (which is z:100 on both pages) so
 * the banner stays visible at every scroll position; the small centered
 * pill briefly overlaps a center-nav link during a boost, which we
 * accept since the banner is short-lived and visually ties into the
 * "do not navigate yet" message.
 *
 * Click → opens the IdentityWidget dropdown so the user can watch the
 * per-leg status until the entry fades out.
 *
 * Visibility is gated on entries with status === 'in-flight'. Settled
 * entries linger inside boostQueue for a few more seconds so the
 * dropdown can show a paid/partial/failed badge — but the banner itself
 * is "still working", and once nothing's still working we let it fade.
 */
export default function BoostProgressBanner() {
  const [list, setList] = useState(() => getInFlight())
  // Decoupled `visible` from the active count so we can run a fade-out
  // animation after the last in-flight entry settles instead of
  // snapping the banner away.
  const [visible, setVisible] = useState(false)

  useEffect(() => onInFlightChange(setList), [])

  const activeCount = useMemo(
    () => list.reduce((n, e) => n + (e.status === 'in-flight' ? 1 : 0), 0),
    [list],
  )

  useEffect(() => {
    if (activeCount > 0) {
      setVisible(true)
      return
    }
    // Nothing still processing — fade out, then unmount the DOM. 250ms
    // matches the modal-transition timing used elsewhere so the visual
    // rhythm reads consistent across surfaces.
    const t = setTimeout(() => setVisible(false), 250)
    return () => clearTimeout(t)
  }, [activeCount])

  if (activeCount === 0 && !visible) return null

  const label = activeCount === 0
    ? 'Boost delivered'
    : activeCount === 1
      ? 'Stay on this page — payment processing'
      : `Stay on this page — ${activeCount} payments processing`

  function onPillClick() {
    requestIdentityOpen()
  }

  return createPortal(
    <div
      className="fixed top-0 inset-x-0 z-[110] flex justify-center pointer-events-none px-3 pt-3"
      role="status"
      aria-live="polite"
    >
      {/* lb-boost-banner-glow is the slow 2.4s glow keyframe injected
          via styles.css — Tailwind's animate-pulse reads as a status
          spinner, which is wrong for "subtle background hum". */}
      <button
        type="button"
        onClick={onPillClick}
        aria-label="Open account menu to view boost status"
        // pointer-events flipped off during fade so an invisible
        // button in the fading region can't catch a stray click and
        // pop the dropdown after a boost has fully settled.
        className={`inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-orange-400/70 bg-gradient-to-r from-orange-500/95 to-orange-600/95 hover:from-orange-500 hover:to-orange-600 text-white text-xs sm:text-sm font-medium shadow-[0_8px_30px_-4px_rgba(247,147,26,0.55),0_0_0_1px_rgba(255,255,255,0.06)] transition-[opacity,transform] duration-200 cursor-pointer ${
          activeCount > 0 ? 'pointer-events-auto opacity-100 translate-y-0 lb-boost-banner-glow' : 'pointer-events-none opacity-0 -translate-y-1'
        }`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="flex-shrink-0 animate-pulse"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z"
            clipRule="evenodd"
          />
        </svg>
        <span className="leading-none">{label}</span>
      </button>
    </div>,
    document.body,
  )
}
