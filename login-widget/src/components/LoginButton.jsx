import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import LoginModal from './LoginModal.jsx'
import { clearSession } from '../lib/sessionPersistence.js'
import { resetNDK } from '../lib/ndk.js'

// Truncate a Nostr npub for display: "npub1abc...xyz4". Unchanged from
// mynostr's helper — kept inline here to avoid pulling all of utils.
function truncateNpub(npub) {
  if (!npub || npub.length < 12) return npub
  return `${npub.slice(0, 8)}...${npub.slice(-4)}`
}

export default function LoginButton({ user, onUserChange }) {
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    function onDoc(e) {
      const root = document.getElementById('lb-login-root')
      if (!root || !root.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  function handleLogout() {
    setMenuOpen(false)
    clearSession()
    resetNDK()
    onUserChange(null)
  }

  // Don't gate the button on session restoration. If a saved session is
  // valid, the user prop will flip from null → user a moment later and
  // we'll re-render into the logged-in view. If it isn't (or the
  // extension is slow to respond), the user can interact with the
  // login button right away.

  if (user) {
    const name = user.profile?.displayName || user.profile?.name || truncateNpub(user.npub)
    const picture = user.profile?.picture || user.profile?.image
    return (
      <div className="relative" id="lb-login-root">
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          // Explicit bg/border/font: with preflight disabled, the browser's
          // default <button> chrome (buttonface bg, buttontext color, 2px
          // outset border) leaks through. Reset it here.
          style={{
            background: 'transparent',
            border: '1px solid rgba(247,147,26,0.55)',
            cursor: 'pointer',
            font: 'inherit',
          }}
          className="inline-flex items-center gap-2 px-2 py-1 rounded-md transition-colors hover:!bg-[rgba(247,147,26,0.18)]"
          aria-label="Account menu"
        >
          {picture ? (
            <img
              src={picture}
              alt=""
              className="w-7 h-7 rounded-full object-cover"
              style={{ border: '1px solid #f7931a' }}
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <span
              className="w-7 h-7 rounded-full text-xs flex items-center justify-center font-bold"
              style={{ background: '#f7931a', color: '#fffdf7' }}
            >
              {(name || '?').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span
            className="text-sm max-w-[140px] truncate"
            style={{ color: 'var(--cream-d, #ede3c8)' }}
          >
            {name}
          </span>
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 mt-1 w-44 rounded-md shadow-lg py-1 z-[60]"
            style={{
              background: 'var(--cream, #f5eedc)',
              border: '1px solid var(--border, #d4c4a0)',
            }}
          >
            <button
              type="button"
              onClick={handleLogout}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                font: 'inherit',
                color: 'var(--navy, #1e3a5f)',
              }}
              className="w-full text-left px-3 py-2 text-sm transition-colors hover:!bg-[rgba(247,147,26,0.18)]"
            >
              Log out
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold text-white bg-orange-500 hover:bg-orange-600 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <polyline points="10 17 15 12 10 7" />
          <line x1="15" y1="12" x2="3" y2="12" />
        </svg>
        Sign in with Nostr
      </button>
      {open && createPortal(
        <LoginModal
          onLogin={(u) => onUserChange(u)}
          onClose={() => setOpen(false)}
        />,
        document.body
      )}
    </>
  )
}
