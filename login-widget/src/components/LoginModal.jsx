/**
 * LoginModal — overlay wrapper around LoginScreen.
 *
 * Centered-card layout at all viewport sizes. Uses w-full + max-w-md so
 * the card fills available width on phones (with the outer p-3 leaving
 * 12px margins on each side) and caps at 28rem on desktop.
 *
 * Reuses LoginScreen with `embedded={true}` so we share one implementation
 * of every auth flow instead of maintaining a slimmer modal variant.
 */
import { useEffect } from 'react'
import LoginScreen from './LoginScreen.jsx'

export default function LoginModal({ onLogin, onClose }) {
  // Escape to close.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock page scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  function handleLogin(user) {
    onLogin(user)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-start sm:items-center justify-center z-[70] p-3 sm:p-4 overflow-y-auto overflow-x-hidden"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Login"
    >
      <div
        className="relative bg-neutral-950 border border-neutral-800 rounded-lg shadow-2xl w-full max-w-md my-4 sm:my-8"
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-2 right-2 z-10 text-neutral-400 hover:text-neutral-100 p-2 rounded transition-colors"
          aria-label="Close login"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
        <div className="py-6">
          <LoginScreen onLogin={handleLogin} embedded />
        </div>
      </div>
    </div>
  )
}
