import './styles.css'
import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import BoostButton from './components/BoostButton.jsx'
import LoginModal from './components/LoginModal.jsx'
import { loadSession, restoreSession, clearSession } from './lib/sessionPersistence.js'
import { getNDK, resetNDK, connectAndWait } from './lib/ndk.js'

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

// ── Standalone login prompt ────────────────────────────────────────────────
// Module-level open/close signal so any consumer (e.g. the boosts page
// banner) can call api.requestLogin() to surface the login UI without
// going through the boost modal. The host below is mounted once at
// startup; the modal renders via portal directly to document.body.
const loginOpenListeners = new Set()
let loginIsOpen = false
function setLoginOpen(v) {
  loginIsOpen = !!v
  for (const fn of loginOpenListeners) {
    try { fn(loginIsOpen) } catch {}
  }
}

function LoginPromptHost() {
  const [open, setOpenLocal] = useState(loginIsOpen)
  useEffect(() => {
    const fn = (v) => setOpenLocal(v)
    loginOpenListeners.add(fn)
    return () => { loginOpenListeners.delete(fn) }
  }, [])
  if (!open) return null
  return createPortal(
    <LoginModal
      onLogin={(u) => {
        // Same propagation contract as BoostModal's inline login.
        abortRestore()
        setUser(u)
        setLoginOpen(false)
      }}
      onClose={() => setLoginOpen(false)}
    />,
    document.body,
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

    // Always-mounted host for the standalone login modal. We attach a
    // hidden div to the body so requestLogin() works even on pages that
    // don't have an #lb-boost-slot.
    const promptHost = document.createElement('div')
    promptHost.id = 'lb-login-prompt-host'
    promptHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;'
    document.body.appendChild(promptHost)
    createRoot(promptHost).render(<LoginPromptHost />)

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

  /**
   * Open the standalone login modal. No-op if already logged in — the
   * banner on consumer pages should hide its sign-in CTA in that case
   * anyway, but we guard here too.
   */
  requestLogin() {
    if (currentUser) return
    abortRestore()
    setLoginOpen(true)
  },

  /**
   * Sign the current user out. Mirrors BoostModal's handleLogout: clear
   * persisted session, reset the NDK instance (drops the signer + relay
   * pool), then notify listeners so consumers re-render as logged-out.
   */
  logout() {
    if (!currentUser) return
    clearSession()
    resetNDK()
    setUser(null)
  },

  /**
   * Sign a raw event template using the current user's signer. Returns a
   * complete signed event (id, pubkey, sig, created_at) suitable for
   * publishing to relays OR for sending to a non-relay endpoint (e.g.
   * a NIP-57 LNURL callback).
   *
   * Throws if no user is logged in. Caller is responsible for catching
   * signer-cancelled errors (e.g. the user denied the prompt).
   */
  async signEvent(template) {
    if (!currentUser) throw new Error('Not signed in')
    const ndk = getNDK()
    if (!ndk.signer) throw new Error('No signer available')
    const ev = new NDKEvent(ndk)
    ev.kind        = template.kind
    ev.content     = template.content || ''
    ev.tags        = Array.isArray(template.tags) ? template.tags : []
    ev.created_at  = template.created_at || Math.floor(Date.now() / 1000)
    await ev.sign()
    return ev.rawEvent()
  },

  /**
   * Publish a pre-signed event to the user's outbox. The signedEvent
   * object must already have id + sig populated (i.e. came from
   * signEvent above, or another signer).
   *
   * Returns a Set of relays that ack'd the event. May be empty if no
   * relay confirmed within NDK's internal timeout — callers usually
   * ignore the return and treat the publish as best-effort.
   */
  async publishEvent(signedEvent) {
    if (!signedEvent?.id || !signedEvent?.sig) {
      throw new Error('Event is not signed')
    }
    const ndk = getNDK()
    // Make sure relays are connected before we try to broadcast — on
    // pages where signEvent was called immediately after login the pool
    // can still be mid-handshake.
    await connectAndWait(ndk).catch(() => {})
    const ev = new NDKEvent(ndk, signedEvent)
    return ev.publish()
  },

  /**
   * Convenience: sign + publish in one call. Returns the signed raw
   * event so callers can render the result optimistically (e.g. insert
   * into a feed).
   */
  async signAndPublish(template) {
    const signed = await this.signEvent(template)
    await this.publishEvent(signed)
    return signed
  },
}

if (typeof window !== 'undefined') {
  window.LBLogin = api
  document.addEventListener('DOMContentLoaded', () => api.mount())
  if (document.readyState !== 'loading') api.mount()
}

export default api
