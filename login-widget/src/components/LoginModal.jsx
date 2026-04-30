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
import { lockBodyScroll, unlockBodyScroll } from '../lib/scrollLock.js'
import { useModalTransition, EXIT_DURATION_MS } from '../lib/useModalTransition.js'

export default function LoginModal({ onLogin, onClose }) {
  const { visible, requestClose } = useModalTransition(onClose)

  // Escape to close.
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') requestClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose])

  // Lock page scroll while open. Ref-counted so nesting (LoginModal on
  // top of BoostModal) doesn't release the lock when only the inner
  // modal closes.
  useEffect(() => {
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [])

  function handleLogin(user) {
    // Run the exit animation in parallel with the parent learning about
    // the new user. The parent (BoostModal) still re-renders with the
    // updated user prop while we fade out, so the underlying view shows
    // the new state by the time the login modal is gone.
    onLogin(user)
    setTimeout(() => onClose(), EXIT_DURATION_MS)
  }

  return (
    // z-[80] so the login modal stacks unambiguously above the boost
    // modal (z-[70/71]) when launched from inside it via the inline
    // Sign-in button. Standalone use is unaffected.
    <div
      className={`fixed inset-0 bg-black/70 flex items-start sm:items-center justify-center z-[80] p-3 sm:p-4 overflow-y-auto overflow-x-hidden transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
      onMouseDown={requestClose}
      role="dialog"
      aria-modal="true"
      aria-label="Login"
    >
      <div
        className={`relative bg-neutral-950 border border-neutral-700 rounded-lg shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] w-full max-w-md my-4 sm:my-8 transition-[opacity,transform] duration-200 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={requestClose}
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
