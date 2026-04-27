/**
 * LoginModal — overlay wrapper around LoginScreen.
 *
 * Desktop: centered dialog with dark backdrop, Esc / click-outside to close.
 * Mobile:  full-viewport slide-up sheet with an X in the top-right.
 *
 * Reuses LoginScreen with `embedded={true}` so we share one implementation
 * of every auth flow instead of maintaining a slimmer modal variant.
 */
import { useEffect } from 'react'
import LoginScreen from './LoginScreen.jsx'
import { useIsMobile } from '../hooks/useIsMobile.js'

export default function LoginModal({ onLogin, onClose }) {
  const isMobile = useIsMobile()

  // Escape to close.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Lock page scroll while open so the underlying page doesn't scroll
  // when the user swipes inside the modal on mobile.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Bridge LoginScreen's onLogin → set session at parent level, then close.
  // Order matters: set the session first so any session listener fires
  // before the modal unmounts.
  function handleLogin(user) {
    onLogin(user)
    onClose()
  }

  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 bg-black/70 z-[70]"
          onClick={onClose}
        />
        <div
          className="fixed inset-0 bg-neutral-950 z-[71] overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Login"
        >
          <button
            type="button"
            onClick={onClose}
            className="fixed top-3 right-3 z-[72] text-neutral-400 hover:text-neutral-100 p-2 rounded transition-colors"
            aria-label="Close login"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
          <div className="py-8">
            <LoginScreen onLogin={handleLogin} embedded />
          </div>
        </div>
      </>
    )
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4 overflow-y-auto"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Login"
    >
      <div
        className="relative bg-neutral-950 border border-neutral-800 rounded-lg shadow-2xl w-full max-w-md my-8"
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
