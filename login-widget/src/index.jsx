import './styles.css'
import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import BoostButton from './components/BoostButton.jsx'
import { loadSession, restoreSession } from './lib/sessionPersistence.js'
import { getNDK } from './lib/ndk.js'

// Module-level subscriber list and current user — separated from React
// state so callers outside the widget (boost button, future features)
// can read getUser() / onChange() without touching React.
const listeners = new Set()
let currentUser = null

function setUser(u) {
  currentUser = u
  for (const fn of listeners) {
    try { fn(u) } catch {}
  }
}

// Restore-cancellation flag. Set by abortRestore() when the user takes
// an action that should win over the silent background restore (manual
// login, manual logout). The restore promise still completes its work
// asynchronously; we just discard its result.
let restoreCancelled = false
function abortRestore() { restoreCancelled = true }

// Tiny hook every internal component uses to track the shared user.
// Avoids duplicating the subscription logic across LoginButton + BoostButton.
function useSharedUser() {
  const [user, setLocal] = useState(currentUser)
  useEffect(() => {
    const fn = (u) => setLocal(u)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return user
}

function BoostApp() {
  const user = useSharedUser()
  // The boost modal hosts the login UI inline (sign-in button replaces
  // the "Boost as me" half of the attribution toggle when logged out),
  // so onUserChange has to propagate to the same module-level setUser
  // the login-from-the-nav button used to. abortRestore() stops a
  // background session restore from racing the user's manual action.
  return (
    <BoostButton
      user={user}
      onUserChange={(u) => { abortRestore(); setUser(u) }}
    />
  )
}

let mounted = false

const api = {
  /**
   * Mount the boost button into its slot. Login UI is now inline inside
   * the boost modal, so there's no separate nav slot for it.
   * Idempotent — safe to call once on page load.
   */
  mount() {
    if (mounted) return
    mounted = true
    const boostEl = document.getElementById('lb-boost-slot')

    if (boostEl) {
      createRoot(boostEl).render(<BoostApp />)
    }

    // Kick off async session restore in the background — the buttons
    // render immediately in their logged-out state, and flip to the
    // logged-in view when (and if) restore succeeds. If the user
    // clicks Login before restore completes, abortRestore() flips
    // restoreCancelled and we discard the result.
    const saved = loadSession()
    if (saved) {
      restoreSession(saved)
        .then((u) => { if (!restoreCancelled) setUser(u || null) })
        .catch(() => { if (!restoreCancelled) setUser(null) })
    }
  },

  /** Currently logged-in NDKUser, or null. */
  getUser() { return currentUser },

  /** Subscribe to login/logout. Returns an unsubscribe fn. */
  onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  /** The shared NDK instance. */
  getNDK() { return getNDK() },
}

if (typeof window !== 'undefined') {
  window.LBLogin = api
  document.addEventListener('DOMContentLoaded', () => api.mount())
  if (document.readyState !== 'loading') api.mount()
}

export default api
