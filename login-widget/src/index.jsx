import './styles.css'
import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import BoostButton from './components/BoostButton.jsx'
import LoginModal from './components/LoginModal.jsx'
import EpisodeBoostModal from './components/EpisodeBoostModal.jsx'
import BoostModal from './components/BoostModal.jsx'
import IdentityWidget from './components/IdentityWidget.jsx'
import WalletConnectModal from './components/WalletConnectModal.jsx'
import ToastHost from './components/ToastHost.jsx'
import BoostProgressBanner from './components/BoostProgressBanner.jsx'
import {
  loadSession, restoreSession, clearSession,
  saveProfile, loadCachedProfile, clearProfile,
  verifySignerMatches,
} from './lib/sessionPersistence.js'
import { markStubUser, isStubUser } from './lib/stubUser.js'
import { getNDK, resetNDK, connectAndWait } from './lib/ndk.js'
import * as nwc from './lib/nwc.js'
import { applyRecipientOverrides } from './lib/recipientOverrides.js'
import { pushToast } from './lib/toast.js'
// Side-effect import: installs a same-origin click interceptor that
// briefly holds nav (≤2s) when a boost is in flight, so a user who
// clicks Boost and immediately clicks a nav link doesn't reload the
// page before the NWC relay acks the publish.
import './lib/navigationGuard.js'

// ── Shared user state ────────────────────────────────────────────────────
// Tri-state:
//   undefined — restore in flight on initial page load (only set when a
//               saved session record exists but no cached profile).
//               The IdentityWidget renders a shimmering placeholder.
//   null      — logged out. Default when no saved session, or after a
//               failed restore, or after explicit logout.
//   {object}  — Either a stub built from the localStorage profile cache
//               (rendered immediately at page boot for fast cross-page
//               navigation) or a real NDKUser after restoreSession
//               finishes. Stub membership is tracked via the WeakSet
//               below + the isStubUser() helper so consumers that
//               need the real signer can wait or fail gracefully.
//
// Why the stub: every page navigation re-mounts NDK from scratch,
// which means a fresh handshake to relays + a kind 0 fetch — that's
// the ~1-2s lag the user used to see. Caching the profile fields lets
// us render the avatar instantly while the real restore runs async.

const listeners = new Set()

function buildStubUser(cachedProfile) {
  if (!cachedProfile?.pubkey) return null
  return markStubUser({
    pubkey: cachedProfile.pubkey,
    npub: cachedProfile.npub,
    profile: {
      displayName: cachedProfile.displayName,
      name: cachedProfile.name,
      image: cachedProfile.image,
    },
  })
}

function initialUser() {
  const session = loadSession()
  if (!session) return null
  const cached = loadCachedProfile()
  // Cache is only valid if it matches the session's pubkey. A mismatch
  // means the user logged in as someone else from another tab — drop
  // the cache and fall through to the session-only stub.
  if (cached && cached.pubkey === session.pubkey) {
    return buildStubUser(cached)
  }
  // No matching profile cache — fall back to a session-only stub
  // (pubkey + npub, no display name yet). The IdentityWidget shows a
  // generic avatar instead of a perpetual shimmer. fetchUserProfile in
  // the background restore will fill in the name/image when it lands.
  if (session.pubkey) {
    return buildStubUser({ pubkey: session.pubkey, npub: session.npub })
  }
  return null
}

let currentUser = initialUser()

function setUser(u) {
  // Coerce any falsy non-undefined value to null so consumers can
  // discriminate "restoring" (undefined) from "logged out" (null).
  currentUser = (u === undefined) ? undefined : (u || null)
  for (const fn of listeners) {
    try { fn(currentUser) } catch {}
  }
  // Refresh the cached profile snapshot whenever a real user lands —
  // keeps next page boot's stub data current with relay state. Skip
  // stubs (they came from the cache to begin with) and clear on
  // explicit logout.
  if (u && !isStubUser(u)) {
    saveProfile({
      pubkey: u.pubkey,
      npub: u.npub,
      displayName: u.profile?.displayName || '',
      name: u.profile?.name || '',
      image: u.profile?.image || '',
    })
  } else if (u === null) {
    clearProfile()
  }
}

// Per-attempt cancellation token. Each call to mount() creates a fresh
// token; abortRestore() flips the *current* token's cancelled flag. The
// token-object pattern means a stale cancellation can't suppress future
// restore attempts.
let activeRestore = null
function abortRestore() {
  if (activeRestore) activeRestore.cancelled = true
}

// Cap on-demand restore retries per page load. Without this, a session
// that can't be restored (extension uninstalled, bunker unreachable,
// etc.) drives an infinite loop: queued action fires → still a stub →
// queues again → triggers another restore → fails → repeat. Two attempts
// is enough to cover a one-off relay flake; beyond that we treat the
// session as broken and force re-auth so the user gets a clear next
// step instead of a silently-stuck UI.
const MAX_STUB_RESTORE_ATTEMPTS = 2
let stubRestoreAttempts = 0

// One-shot signer verification per in-memory session. Set true once we
// confirm the attached signer reports the same pubkey our saved record
// claims (either via verifySignerMatches before an action, or implicitly
// via a fresh login flow that produced the pubkey from the signer).
// Reset on logout / force-logout / each new restore attempt — anywhere
// the signer instance changes.
let signerVerified = false

// Force a clean logout from any code path that detects the saved session
// can no longer be honored (permanent restore failure, signer/account
// mismatch). Mirrors api.logout()'s teardown plus a user-facing toast
// and re-opens the login modal so the next step is obvious.
function forceLogoutWithMessage(message) {
  clearSession()
  clearProfile()
  resetNDK()
  try { nwc.lockOnLogout() } catch {}
  cancelPendingAction()
  signerVerified = false
  setUser(null)
  if (message) {
    try { pushToast({ kind: 'error', message }) } catch {}
  }
  setLoginOpen(true)
}

// On-demand restore. Called when a user-initiated action (boost, wallet
// unlock) discovers we're still on a stub — the ambient page-load
// restore may have failed silently or never completed. Idempotent: if a
// restore is already in flight, just lets it resolve. If we already have
// a real user, no-op. The pending-action queue will flush when this
// resolves, so the action that triggered the retry runs once we land.
function ensureRealRestore() {
  if (activeRestore) return
  if (currentUser && !isStubUser(currentUser)) return
  const saved = loadSession()
  if (!saved) return
  if (stubRestoreAttempts >= MAX_STUB_RESTORE_ATTEMPTS) {
    forceLogoutWithMessage('Session expired — please sign in again.')
    return
  }
  const token = { cancelled: false }
  activeRestore = token
  stubRestoreAttempts += 1
  signerVerified = false   // fresh signer instance after resetNDK in restoreSession
  restoreSession(saved)
    .then((result) => {
      if (token.cancelled) return
      if (result?.kind === 'ok' && result.user) {
        stubRestoreAttempts = 0
        setUser(result.user)
        // Pre-warm NWC: opens the relay socket + handshake now so the
        // next boost publishes instantly instead of paying the unlock
        // cost on the click. ensureReady is idempotent and short-
        // circuits when there's no stored blob, so this is a safe
        // fire-and-forget.
        nwc.ensureReady(result.user).catch(() => {})
        consumePendingAction()
      } else if (result?.kind === 'permanent') {
        forceLogoutWithMessage('Session expired — please sign in again.')
      } else {
        // transient — keep the stub. Next user action that re-queues
        // will increment the attempt counter; once it caps, the branch
        // above force-logs out instead of looping.
        consumePendingAction()
      }
    })
    .catch(() => {
      if (token.cancelled) return
      consumePendingAction()
    })
    .finally(() => { if (activeRestore === token) activeRestore = null })
}

// Lazy account-change check. Run once per page load just before the
// first sign-gated action so we catch "extension is now signed in as
// someone else" before we sign / encrypt under the wrong pubkey. No-op
// after the first success. Treats transient failures as "probably fine,
// let the action proceed" — the action's own sign call will surface
// real errors.
async function ensureSignerVerified() {
  if (signerVerified) return true
  const saved = loadSession()
  if (!saved) return true
  if (!currentUser || isStubUser(currentUser)) return true
  const result = await verifySignerMatches(getNDK(), saved)
  if (result.kind === 'ok') {
    signerVerified = true
    return true
  }
  if (result.kind === 'permanent') {
    forceLogoutWithMessage('Your signer is set to a different account. Please sign in again.')
    return false
  }
  return true
}

// Tiny hook every internal component uses to track the shared user.
function useSharedUser() {
  const [user, setLocal] = useState(currentUser)
  useEffect(() => {
    const fn = (u) => setLocal(u)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return user
}

// ── Pending-action queue ─────────────────────────────────────────────────
// FIFO queue of actions deferred until the next gate completes.
// Multiple slots so a user clicking "Boost Episode" then "Connect
// Wallet" in quick succession during the stub window doesn't lose
// the first click. Each action runs in order on consume.
const pendingActions = []
function setPendingAction(fn) {
  if (typeof fn !== 'function') return
  pendingActions.push(fn)
}
function consumePendingAction() {
  if (pendingActions.length === 0) return
  // Drain into a local copy so callbacks that re-enqueue (e.g. an
  // openEpisodeBoost that re-hits another gate) don't race with this
  // loop. Defer one tick so React state from the gate completion has
  // a chance to settle before each action checks currentUser / nwc.
  const drained = pendingActions.splice(0, pendingActions.length)
  setTimeout(() => {
    for (const fn of drained) {
      try { fn() } catch (e) { console.warn('[lb] pendingAction failed', e) }
    }
  }, 0)
}
function cancelPendingAction() {
  pendingActions.length = 0
}

// ── Show-boost modal signal ──────────────────────────────────────────────
const showBoostOpenListeners = new Set()
let showBoostIsOpen = false
function setShowBoostOpen(v) {
  showBoostIsOpen = !!v
  for (const fn of showBoostOpenListeners) {
    try { fn(showBoostIsOpen) } catch {}
  }
}

function BoostApp() {
  return <BoostButton onOpen={() => setShowBoostOpen(true)} />
}

function ShowBoostHost() {
  const user = useSharedUser()
  const [open, setOpenLocal] = useState(showBoostIsOpen)
  useEffect(() => {
    const fn = (v) => setOpenLocal(v)
    showBoostOpenListeners.add(fn)
    return () => { showBoostOpenListeners.delete(fn) }
  }, [])
  if (!open) return null
  return createPortal(
    <BoostModal
      user={user || null}
      onUserChange={(u) => { abortRestore(); setUser(u) }}
      onClose={() => setShowBoostOpen(false)}
    />,
    document.body,
  )
}

// ── Standalone login prompt ──────────────────────────────────────────────
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
        abortRestore()
        // Fresh login — pubkey came from the signer itself, so we can
        // skip the ensureSignerVerified prompt on the first sign-gated
        // action this session.
        signerVerified = true
        stubRestoreAttempts = 0
        setUser(u)
        setLoginOpen(false)
        // Pre-warm NWC in case this account already has a stored blob
        // from a previous session (logged out then back in as same npub).
        // No-op for fresh accounts that haven't connected a wallet yet.
        nwc.ensureReady(u).catch(() => {})
        // If a boost or wallet-connect was waiting on login, run it now.
        consumePendingAction()
      }}
      onClose={() => {
        setLoginOpen(false)
        // User dismissed the login modal — abandon any pending action
        // so they're not surprised by a modal opening minutes later.
        cancelPendingAction()
      }}
    />,
    document.body,
  )
}

// ── Wallet connect host ──────────────────────────────────────────────────
const walletConnectOpenListeners = new Set()
let walletConnectIsOpen = false
function setWalletConnectOpen(v) {
  walletConnectIsOpen = !!v
  for (const fn of walletConnectOpenListeners) {
    try { fn(walletConnectIsOpen) } catch {}
  }
}

function WalletConnectHost() {
  const user = useSharedUser()
  const [open, setOpenLocal] = useState(walletConnectIsOpen)
  useEffect(() => {
    const fn = (v) => setOpenLocal(v)
    walletConnectOpenListeners.add(fn)
    return () => { walletConnectOpenListeners.delete(fn) }
  }, [])
  if (!open) return null
  return createPortal(
    <WalletConnectModal
      user={user || null}
      onConnected={() => {
        // NWC successfully connected. Run any pending action that was
        // gated on having a wallet (e.g. an episode boost the user
        // initiated before connecting).
        consumePendingAction()
      }}
      onClose={() => {
        setWalletConnectOpen(false)
        // If user dismissed the wallet modal mid-pending, drop the
        // queued action so a stray click later doesn't surprise them.
        cancelPendingAction()
      }}
    />,
    document.body,
  )
}

// ── Episode boost host ───────────────────────────────────────────────────
const episodeBoostListeners = new Set()
let episodeBoostState = null   // { episode, splits } or null when closed
function setEpisodeBoostState(v) {
  episodeBoostState = v
  for (const fn of episodeBoostListeners) {
    try { fn(episodeBoostState) } catch {}
  }
}

function EpisodeBoostHost() {
  const user = useSharedUser()
  const [state, setLocalState] = useState(episodeBoostState)
  useEffect(() => {
    const fn = (v) => setLocalState(v)
    episodeBoostListeners.add(fn)
    return () => { episodeBoostListeners.delete(fn) }
  }, [])
  if (!state) return null
  return createPortal(
    <EpisodeBoostModal
      user={user || null}
      onUserChange={(u) => { abortRestore(); setUser(u) }}
      onClose={() => setEpisodeBoostState(null)}
      episode={state.episode}
      splitsBundle={state.splits}
    />,
    document.body,
  )
}

// ── Identity slot host ───────────────────────────────────────────────────
// Mounted into #lb-identity-slot. Reads user state + NWC state and
// renders the persistent identity widget. All actions wired through the
// API (sign in / connect wallet / disconnect / sign out) so the widget
// itself doesn't need to know about module-level signals.
function IdentityHost() {
  const user = useSharedUser()
  const [walletStatus, setWalletStatus] = useState(() => nwc.getStatus())
  useEffect(() => nwc.onChange(setWalletStatus), [])

  return (
    <IdentityWidget
      user={user}
      walletStatus={walletStatus}
      onSignInClick={() => api.requestLogin()}
      onConnectWallet={() => api.openWalletConnect()}
      onDisconnectWallet={() => api.disconnectWallet()}
      onSignOut={() => api.logout()}
    />
  )
}

let mounted = false

const api = {
  /**
   * Mount the React surfaces into their slots. Idempotent — safe to
   * call multiple times. Triggered automatically on module load via
   * DOMContentLoaded or immediately when imported after the page is
   * already interactive (the lazy-load path).
   */
  mount() {
    if (mounted) return
    mounted = true

    // Boost-the-show button
    const boostEl = document.getElementById('lb-boost-slot')
    if (boostEl) {
      // Wipe any static placeholder before rendering the React tree.
      boostEl.replaceChildren()
      createRoot(boostEl).render(<BoostApp />)
    }

    // Identity widget
    const identityEl = document.getElementById('lb-identity-slot')
    if (identityEl) {
      identityEl.replaceChildren()
      createRoot(identityEl).render(<IdentityHost />)
    }

    // Always-mounted hosts for portal modals. We attach hidden divs
    // to the body so they work even on pages that don't have the
    // boost slot or identity slot.
    function makeHost(id) {
      const el = document.createElement('div')
      el.id = id
      el.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;'
      document.body.appendChild(el)
      return el
    }
    createRoot(makeHost('lb-login-prompt-host')).render(<LoginPromptHost />)
    createRoot(makeHost('lb-episode-boost-host')).render(<EpisodeBoostHost />)
    createRoot(makeHost('lb-show-boost-host')).render(<ShowBoostHost />)
    createRoot(makeHost('lb-wallet-connect-host')).render(<WalletConnectHost />)
    createRoot(makeHost('lb-toast-host')).render(<ToastHost />)
    createRoot(makeHost('lb-boost-progress-host')).render(<BoostProgressBanner />)

    // Kick off async session restore in the background. The identity
    // widget already renders the cached avatar/name as a stub at this
    // point (see initialUser()), so this just refreshes signer state
    // + relay pool + latest profile data. When it completes we fire
    // any pendingAction queued during the stub window — e.g. a user
    // who clicked "Boost Episode" before the signer was ready.
    const saved = loadSession()
    if (saved) {
      const token = { cancelled: false }
      activeRestore = token
      signerVerified = false
      restoreSession(saved)
        .then((result) => {
          if (token.cancelled) return
          // 'ok'        → upgrade stub to real user
          // 'transient' → keep the stub; a later action will retry via
          //               ensureRealRestore (capped to avoid loops) and
          //               eventually force re-auth if it never lands
          // 'permanent' → saved record is structurally bad; clear it
          //               and surface the login modal so the user
          //               isn't stuck staring at a phantom identity
          if (result?.kind === 'ok' && result.user) {
            setUser(result.user)
            // Pre-warm NWC — see the equivalent call in
            // ensureRealRestore for the rationale.
            nwc.ensureReady(result.user).catch(() => {})
          } else if (result?.kind === 'permanent') {
            forceLogoutWithMessage('Saved session was invalid — please sign in again.')
          }
          consumePendingAction()
        })
        .catch(() => {
          if (token.cancelled) return
          // Treat as transient — keep the stub.
          consumePendingAction()
        })
        .finally(() => { if (activeRestore === token) activeRestore = null })
    }
  },

  /** Currently logged-in NDKUser, or null. */
  getUser() { return currentUser || null },

  /** Subscribe to login/logout. Returns an unsubscribe fn. */
  onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  /** The shared NDK instance. */
  getNDK() { return getNDK() },

  /**
   * Open the standalone login modal. No-op if already logged in.
   */
  requestLogin() {
    if (currentUser && currentUser !== undefined) return
    abortRestore()
    setLoginOpen(true)
  },

  /** Open the wallet-connect modal. No-op if not signed in (the
   *  identity dropdown should hide the option in that case). */
  async openWalletConnect() {
    if (!currentUser || currentUser === undefined) {
      // Pending action so connecting requires login first.
      setPendingAction(() => api.openWalletConnect())
      api.requestLogin()
      return
    }
    if (isStubUser(currentUser)) {
      // Restore still running — encrypting the URI needs the real
      // signer. Queue the action; consumePendingAction fires when
      // restoreSession completes. ensureRealRestore guards against
      // the case where the ambient restore failed silently and we'd
      // otherwise be stuck waiting forever.
      setPendingAction(() => api.openWalletConnect())
      ensureRealRestore()
      return
    }
    // Catches "extension is now signed in as someone else" before we
    // encrypt an NWC URI under the wrong pubkey. No-op after first ok.
    if (!await ensureSignerVerified()) return
    setWalletConnectOpen(true)
  },

  /** Disconnect the user's NWC wallet — wipes the encrypted blob
   *  and tears down the in-memory client. */
  disconnectWallet() {
    nwc.disconnect()
  },

  /**
   * Sign the current user out. Clears persisted session, drops the
   * NDK instance, locks the in-memory NWC client (the encrypted blob
   * stays at rest, ready to unlock when they sign back in as the
   * same npub).
   */
  logout() {
    if (!currentUser || currentUser === undefined) return
    clearSession()
    resetNDK()
    nwc.lockOnLogout()
    cancelPendingAction()
    signerVerified = false
    stubRestoreAttempts = 0
    setUser(null)
  },

  /** Open the show-boost modal directly. */
  async openShowBoost() {
    if (currentUser && !isStubUser(currentUser)) {
      if (!await ensureSignerVerified()) return
    }
    setShowBoostOpen(true)
  },

  /**
   * Open the episode boost modal for a given RSS item. Walks the
   * gating chain — if the user isn't logged in we save the call and
   * open the login modal first; if they are logged in but have no
   * NWC connected we open the wallet-connect modal first. Either
   * gate completing fires the saved action and the boost modal
   * eventually opens.
   *
   * @param {object}  args
   * @param {object}  args.episode  - { number, title, guid }
   * @param {object}  args.splits   - { recipients, totalWeight, source }
   */
  async openEpisodeBoost({ episode, splits }) {
    if (!episode || !splits || !Array.isArray(splits.recipients)) {
      console.warn('[LBLogin] openEpisodeBoost: missing episode/splits payload')
      return
    }
    const args = { episode, splits }

    // Gate 1: signed in?
    if (!currentUser || currentUser === undefined) {
      setPendingAction(() => api.openEpisodeBoost(args))
      api.requestLogin()
      return
    }

    // Gate 1.5: signed in but only as a stub — wait for real restore
    // to land before reaching the NWC gate, since unlocking the NWC
    // blob needs the real signer. ensureRealRestore covers the case
    // where the ambient page-load restore quietly failed.
    if (isStubUser(currentUser)) {
      setPendingAction(() => api.openEpisodeBoost(args))
      ensureRealRestore()
      return
    }

    // Gate 1.75: signer-account match. Boostagram payloads embed the
    // sender's pubkey from currentUser; if the extension's active
    // account changed under us, we'd publish a payload claiming
    // currentUser.pubkey while the signature came from a different
    // key. Force re-auth before that can happen. No-op after first ok.
    if (!await ensureSignerVerified()) return

    // Gate 2: NWC connected?
    if (!nwc.isReady()) {
      // Try to unlock from a saved blob. If that succeeds, fall
      // straight through. If it fails (no blob, wrong account, signer
      // hung, etc.) we open the connect modal.
      nwc.ensureReady(currentUser)
        .then((ok) => {
          if (ok) {
            // Re-call openEpisodeBoost — Gate 2 will pass now.
            api.openEpisodeBoost(args)
          } else {
            setPendingAction(() => api.openEpisodeBoost(args))
            api.openWalletConnect()
          }
        })
        .catch(() => {
          setPendingAction(() => api.openEpisodeBoost(args))
          api.openWalletConnect()
        })
      return
    }

    // Both gates pass — open the form. Apply LB's per-host substitutions
    // before the modal sees the recipient list.
    const normalizedRecipients = applyRecipientOverrides(splits.recipients)
    setEpisodeBoostState({
      episode,
      splits: { ...splits, recipients: normalizedRecipients },
    })
  },

  /** NWC status snapshot for consumers that want to render wallet state. */
  getNwcStatus() { return nwc.getStatus() },

  /** Subscribe to NWC connect/disconnect events. Returns unsubscribe. */
  onNwcChange(fn) { return nwc.onChange(fn) },

  /**
   * Sign a raw event template using the current user's signer.
   * Throws if no user is logged in.
   */
  async signEvent(template) {
    if (!currentUser || currentUser === undefined) throw new Error('Not signed in')
    if (isStubUser(currentUser)) throw new Error('Session still restoring')
    if (!await ensureSignerVerified()) throw new Error('Signer account mismatch')
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
   * Publish a pre-signed event to the user's outbox. Returns a Set of
   * relays that ack'd the event.
   */
  async publishEvent(signedEvent) {
    if (!signedEvent?.id || !signedEvent?.sig) {
      throw new Error('Event is not signed')
    }
    const ndk = getNDK()
    await connectAndWait(ndk).catch(() => {})
    const ev = new NDKEvent(ndk, signedEvent)
    return ev.publish()
  },

  /** Convenience: sign + publish in one call. */
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
