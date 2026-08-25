/**
 * MeetupModalChrome — shared modal frame for the meetup-flow modals.
 *
 * The four meetup flows (My Meetups, Search, Paste naddr, Create) all
 * use the LB cream-card design system internally. This chrome supplies:
 *   - the dark backdrop + enter/exit transition
 *   - a centered, scrollable container that handles tall content
 *   - the close X (top-right) — no backdrop/Esc close per the project
 *     convention for boost-style modals (see feedback memory)
 *   - body-scroll lock
 *
 * The actual modal body is whatever the caller passes as children —
 * typically an `<div className="lb-card">…</div>` so the content reads
 * like the rest of the cream-themed pages.
 */
import { useEffect } from 'react'
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition } from '../lib/useModalTransition.js'

export default function MeetupModalChrome({
  title,
  ariaLabel,
  onClose,
  maxWidth = '34rem',
  children,
}) {
  const { visible, requestClose } = useModalTransition(onClose)

  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  return (
    <>
      {/* z must clear the sticky page nav (z-index: 100 on every LB page)
          so tall modals don't tuck behind the nav bar. */}
      <div
        className={`fixed inset-0 bg-[var(--scrim,rgba(45,32,16,0.62))] z-[200] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden="true"
      />
      {/* Outer container does NOT scroll (overflow-hidden). The modal
          shell is capped at ~viewport height and the lb-card inside it
          scrolls. This way the modal frame stays anchored in viewport
          center, the close X stays at the modal's top corner, and the
          form just scrolls internally — no part of the modal ever ends
          up above the visible area (which would push the close X under
          the browser's bookmark bar / chrome). */}
      <div
        className="fixed inset-0 z-[201] flex items-center justify-center p-3 sm:p-4 overflow-hidden"
        role="dialog"
        aria-label={ariaLabel || title || 'Meetup dialog'}
      >
        <div
          className={`lb-modal-shell w-full transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
          style={{ maxWidth }}
        >
          <button
            type="button"
            onClick={requestClose}
            className="lb-modal-close"
            aria-label="Close"
          >
            ✕
          </button>
          {children}
        </div>
      </div>
    </>
  )
}
