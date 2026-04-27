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

// Per-attempt cancellation token. Each call to mount() creates a fresh
// token; abortRestore() flips the *current* token's cancelled flag. The
// token-object pattern (vs. a module-level boolean) means future restore
// re-attempts each get a clean slate, and a stale `cancelled = true`
// from a prior attempt can't accidentally suppress the next one.
let activeRestore = null
function abortRestore() {
  if (activeRestore) activeRestore.cancelled = true
}

// Tiny hook every internal component uses to track the shared user.
// Lets BoostButton (and any future consumer) subscribe to login/logout
// without each one wiring up its own listener.
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
    // this attempt's cancellation token and we discard the result.
    const saved = loadSession()
    if (saved) {
      const token = { cancelled: false }
      activeRestore = token
      restoreSession(saved)
        .then((u) => { if (!token.cancelled) setUser(u || null) })
        .catch(() => { if (!token.cancelled) setUser(null) })
        .finally(() => { if (activeRestore === token) activeRestore = null })
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
