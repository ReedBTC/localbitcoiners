import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { onInFlightChange, getInFlight } from '../lib/boostQueue.js'

/**
 * Top-of-page banner shown while any boost is mid-flight.
 *
 * The boost flow is otherwise silent (modal closes immediately, send-and-
 * forget) — without this, a casual donor has no signal that they should
 * stay on the page until their multi-leg payment finishes. The banner
 * appears as soon as a boost is queued and clears as soon as the in-flight
 * set drains.
 *
 * Stays out of layout flow (fixed-positioned at the very top) and never
 * touches the page underneath. The user can navigate normally; the
 * beforeunload guard in boostQueue handles "are you sure?" if they try
 * to close the tab mid-flight, and the banner reminds them why.
 */
export default function BoostProgressBanner() {
  const [list, setList] = useState(() => getInFlight())
  // Decoupled `visible` from the list so we can run a fade-out animation
  // after the queue empties instead of snapping the banner away.
  const [visible, setVisible] = useState(false)

  useEffect(() => onInFlightChange(setList), [])

  useEffect(() => {
    if (list.length > 0) {
      setVisible(true)
      return
    }
    // Queue drained — fade out, then unmount the DOM. 250ms matches the
    // modal-transition timing used elsewhere so the visual rhythm reads
    // consistent across surfaces.
    const t = setTimeout(() => setVisible(false), 250)
    return () => clearTimeout(t)
  }, [list.length])

  if (list.length === 0 && !visible) return null

  const count = list.length
  const label = count === 0
    ? 'Boost delivered'
    : count === 1
      ? 'Stay on this page — payment processing'
      : `Stay on this page — ${count} payments processing`

  return createPortal(
    <div
      className="fixed top-0 inset-x-0 z-[90] flex justify-center pointer-events-none px-3 pt-3"
      role="status"
      aria-live="polite"
    >
      {/* lb-boost-banner-glow is the slow 2.4s glow keyframe injected
          via styles.css — Tailwind's animate-pulse reads as a status
          spinner, which is wrong for "subtle background hum". */}
      <div
        className={`pointer-events-auto inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-orange-400/70 bg-gradient-to-r from-orange-500/95 to-orange-600/95 text-white text-xs sm:text-sm font-medium shadow-[0_8px_30px_-4px_rgba(247,147,26,0.55),0_0_0_1px_rgba(255,255,255,0.06)] transition-[opacity,transform] duration-200 ${
          list.length > 0 ? 'opacity-100 translate-y-0 lb-boost-banner-glow' : 'opacity-0 -translate-y-1'
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
      </div>
    </div>,
    document.body,
  )
}
