import { useState } from 'react'
import { createPortal } from 'react-dom'
import BoostModal from './BoostModal.jsx'

// `user` is passed in from the widget entry, kept in sync via the
// module-level listener set. `onUserChange` lets the modal's inline
// login + logout actions propagate up to the shared user state.
export default function BoostButton({ user, onUserChange }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Inline styles for the props preflight: false leaves at the
        // browser defaults (background, border, font, cursor).
        style={{
          background: '#f7931a',
          border: 'none',
          cursor: 'pointer',
          font: 'inherit',
          color: '#ffffff',
        }}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 rounded-md text-sm font-semibold transition-colors hover:!bg-[#d97b0e]"
        aria-label="Boost the Show"
        title="Boost the Show"
      >
        <span aria-hidden="true">⚡</span>
        {/* Hide the long label below the sm breakpoint (640px) so the nav
            doesn't wrap to multiple rows on phones. The aria-label + title
            still announce the full action for screen readers + tooltips. */}
        <span className="hidden sm:inline">Boost the Show</span>
        <span className="sm:hidden">Boost</span>
      </button>
      {open && createPortal(
        <BoostModal
          user={user}
          onUserChange={onUserChange}
          onClose={() => setOpen(false)}
        />,
        document.body
      )}
    </>
  )
}
