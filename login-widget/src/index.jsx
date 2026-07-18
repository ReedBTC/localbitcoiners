import './styles.css'
import { createRoot } from 'react-dom/client'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import BoostButton from './components/BoostButton.jsx'
import LoginModal from './components/LoginModal.jsx'
import EpisodeBoostModal from './components/EpisodeBoostModal.jsx'
import ExternalBoostModal from './components/ExternalBoostModal.jsx'
import BoostModal from './components/BoostModal.jsx'
import IdentityWidget from './components/IdentityWidget.jsx'
import WalletConnectModal from './components/WalletConnectModal.jsx'
import ToastHost from './components/ToastHost.jsx'
import BoostProgressBanner from './components/BoostProgressBanner.jsx'
import MyMeetupsModal from './components/MyMeetupsModal.jsx'
import SearchMeetupsModal from './components/SearchMeetupsModal.jsx'
import BoostExistingMeetupModal from './components/BoostExistingMeetupModal.jsx'
import CreateMeetupModal from './components/CreateMeetupModal.jsx'
import BugReportModal from './components/BugReportModal.jsx'
import {
  loadSession, restoreSession, clearSession,
  saveProfile, loadCachedProfile, clearProfile,
  verifySignerMatches,
} from './lib/sessionPersistence.js'
import { markStubUser, isStubUser } from './lib/stubUser.js'
import { getNDK, resetNDK, connectAndWait, signWithTimeout } from './lib/ndk.js'
import * as wallet from './lib/wallet.js'
import { bolt11PaymentHash, confirmInvoiceSettled } from './lib/boostagram.js'
import { isCleanPaymentDecline } from './lib/utils.js'
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
// initialUser() bypasses setUser(), so seed the facade here as well —
// otherwise the identity dot can't see a remembered wallet until the
// background restore finishes.
wallet.setUserContext(currentUser || null)

function setUser(u) {
  // Coerce any falsy non-undefined value to null so consumers can
  // discriminate "restoring" (undefined) from "logged out" (null).
  currentUser = (u === undefined) ? undefined : (u || null)
  // The WebLN at-rest flag is per-pubkey, so the wallet facade needs to
  // know who's signed in before it can report a remembered extension.
  wallet.setUserContext(currentUser || null)
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
  // HARD disconnect — not lockOnLogout. lockOnLogout is the "user
  // clicked Sign Out and might log back in as the same npub" path,
  // which deliberately preserves at-rest credentials. forceLogout
  // is "the saved session is BROKEN" (account mismatch, structural
  // failure) — the credentials encrypted to the now-defunct pubkey
  // must be wiped, not preserved for whoever signs in next on this
  // browser. Same shape as the WebLN cross-user leak fixed earlier.
  const userBeforeWipe = currentUser || null
  clearSession()
  clearProfile()
  resetNDK()
  try { wallet.disconnect(userBeforeWipe) } catch {}
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
        // Pre-warm wallet: NWC opens its relay socket + handshake; WebLN
        // re-enables silently against the browser extension. Either
        // path makes the next boost publish instantly instead of
        // paying the unlock cost on the click. ensureReady is
        // idempotent and short-circuits when nothing is configured.
        wallet.prewarm(result.user).catch(() => {})
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

// A failed wallet unlock at a boost gate is ambiguous: "no wallet
// configured" (route to the connect modal) vs "wallet configured but
// the unlock stalled" — a remembered extension or saved NWC blob that
// didn't answer in time. The second case used to fall into the first
// branch, so a slow extension turned into a connect modal telling a
// connected user they had no wallet. Surface a retryable error toast
// instead; the user's next tap re-runs the unlock behind a fresh
// gesture. Deliberately does NOT queue the action — there's no gate
// completion coming to consume it, and a queued boost popping open
// minutes later would be a surprise.
function handleWalletGateFailure(retryAction) {
  const status = wallet.getStatus()
  if (status.remembered) {
    const msg = status.rememberedKind === 'nwc'
      ? 'Couldn\'t unlock your saved wallet connection — tap Boost to try again.'
      : 'Your wallet extension didn\'t respond — check that it\'s unlocked, then tap Boost to try again.'
    try { pushToast({ kind: 'error', message: msg }) } catch {}
    return
  }
  setPendingAction(retryAction)
  api.openWalletConnect()
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
// Tri-state: null (closed) | { prefillMessage?: string } (open).
// Wrapping the open flag in a state object lets callers pass a
// prefilled boostagram message — used by the /newevent composer to
// open the boost modal with the announcement text already filled in.
const showBoostOpenListeners = new Set()
let showBoostState = null
function setShowBoostState(v) {
  showBoostState = v || null
  for (const fn of showBoostOpenListeners) {
    try { fn(showBoostState) } catch {}
  }
}

function BoostApp() {
  // Route through the gated api wrapper rather than flipping the
  // signal directly, so the show-boost flow honours the same
  // login → wallet gates the episode-boost flow does.
  return <BoostButton onOpen={() => api.openShowBoost()} />
}

function ShowBoostHost() {
  const user = useSharedUser()
  const [state, setLocalState] = useState(showBoostState)
  useEffect(() => {
    const fn = (v) => setLocalState(v)
    showBoostOpenListeners.add(fn)
    return () => { showBoostOpenListeners.delete(fn) }
  }, [])
  if (!state) return null
  return createPortal(
    <BoostModal
      user={user || null}
      prefillMessage={state.prefillMessage || ''}
      onClose={() => setShowBoostState(null)}
      onSettled={(r) => {
        // Let the community-status chip (community-status.js) know this npub
        // just boosted the show, so it can flip to its "pending member" state
        // while the bot adds them to the follow pack. Show boost only.
        try {
          window.dispatchEvent(new CustomEvent('lb:show-boost-settled', { detail: r }))
        } catch {}
      }}
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
        // Pre-warm wallet: NWC may have a stored blob for this npub;
        // WebLN re-enables silently if the user previously enabled it
        // here. No-op for fresh accounts that haven't connected
        // either.
        wallet.prewarm(u).catch(() => {})
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

// ── External-episode boost host (other podcasts, via /feeds) ─────────────
// Separate signal + host from EpisodeBoostHost so the LB episode-boost path
// is untouched. State: { episode, recipientsBundle } or null when closed.
const externalBoostListeners = new Set()
let externalBoostState = null
function setExternalBoostState(v) {
  externalBoostState = v || null
  for (const fn of externalBoostListeners) {
    try { fn(externalBoostState) } catch {}
  }
}

function ExternalBoostHost() {
  const user = useSharedUser()
  const [state, setLocalState] = useState(externalBoostState)
  useEffect(() => {
    const fn = (v) => setLocalState(v)
    externalBoostListeners.add(fn)
    return () => { externalBoostListeners.delete(fn) }
  }, [])
  if (!state) return null
  return createPortal(
    <ExternalBoostModal
      user={user || null}
      onClose={() => setExternalBoostState(null)}
      episode={state.episode}
      recipientsBundle={state.recipientsBundle}
    />,
    document.body,
  )
}

// ── Meetup-flow modal host ───────────────────────────────────────────────
// One signal, one host. The four entry points on the meetups page —
// "My meetups", "Search Nostr", "Paste naddr", "+ Create new" — set the
// same module-level state with a discriminator, and this host renders
// whichever modal is open. Only one is ever open at a time.
const meetupModalListeners = new Set()
let meetupModalState = null   // { kind: 'my'|'search'|'paste'|'create' } or null
function setMeetupModalState(v) {
  meetupModalState = v || null
  for (const fn of meetupModalListeners) {
    try { fn(meetupModalState) } catch {}
  }
}

function MeetupModalHost() {
  const user = useSharedUser()
  const [state, setLocalState] = useState(meetupModalState)
  useEffect(() => {
    const fn = (v) => setLocalState(v)
    meetupModalListeners.add(fn)
    return () => { meetupModalListeners.delete(fn) }
  }, [])
  if (!state) return null

  const close = () => setMeetupModalState(null)
  const openShowBoostWithMessage = (msg) => api.openShowBoost({ prefillMessage: msg })

  // Pass the stub-inclusive user so the modals render their real content
  // (event list / composer form) during the brief background-restore
  // window instead of flashing a sign-in gate. A stub carries the pubkey
  // these flows need; the actual sign is gated downstream (openShowBoost
  // for boosts, ensureSignerOk for the create publish).
  let body = null
  if (state.kind === 'my') {
    body = (
      <MyMeetupsModal
        user={user}
        onClose={close}
        onBoostMeetup={openShowBoostWithMessage}
        onRequestSignIn={() => api.requestLogin()}
      />
    )
  } else if (state.kind === 'search') {
    body = (
      <SearchMeetupsModal
        onClose={close}
        onBoostMeetup={openShowBoostWithMessage}
      />
    )
  } else if (state.kind === 'paste') {
    body = (
      <BoostExistingMeetupModal
        user={user}
        onClose={close}
        onRequestSignIn={() => api.requestLogin()}
        onOpenShowBoostWithMessage={openShowBoostWithMessage}
      />
    )
  } else if (state.kind === 'create') {
    body = (
      <CreateMeetupModal
        user={user}
        onClose={close}
        onRequestSignIn={() => api.requestLogin()}
        onOpenShowBoostWithMessage={openShowBoostWithMessage}
        ensureSignerOk={ensureSignerVerified}
      />
    )
  }

  if (!body) return null
  return createPortal(body, document.body)
}

// ── Bug-report modal host ────────────────────────────────────────────────
const bugReportListeners = new Set()
let bugReportState = null   // {} when open, null when closed
function setBugReportState(v) {
  bugReportState = v || null
  for (const fn of bugReportListeners) {
    try { fn(bugReportState) } catch {}
  }
}

function BugReportHost() {
  const user = useSharedUser()
  const realUser = (user && !isStubUser(user)) ? user : null
  const [state, setLocalState] = useState(bugReportState)
  useEffect(() => {
    const fn = (v) => setLocalState(v)
    bugReportListeners.add(fn)
    return () => { bugReportListeners.delete(fn) }
  }, [])
  if (!state) return null
  return createPortal(
    <BugReportModal user={realUser} onClose={() => setBugReportState(null)} />,
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
  const [walletStatus, setWalletStatus] = useState(() => wallet.getStatus())
  useEffect(() => wallet.onChange(setWalletStatus), [])

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
    createRoot(makeHost('lb-external-boost-host')).render(<ExternalBoostHost />)
    createRoot(makeHost('lb-show-boost-host')).render(<ShowBoostHost />)
    createRoot(makeHost('lb-wallet-connect-host')).render(<WalletConnectHost />)
    createRoot(makeHost('lb-meetup-modal-host')).render(<MeetupModalHost />)
    createRoot(makeHost('lb-bug-report-host')).render(<BugReportHost />)
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
            // Pre-warm wallet — see the equivalent call in
            // ensureRealRestore for the rationale.
            wallet.prewarm(result.user).catch(() => {})
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

  /** Disconnect whichever wallet is active — NWC wipes the encrypted
   *  blob, WebLN clears its per-pubkey enabled-flag (extension's
   *  per-domain permission grant is outside our control). Passes the
   *  current user so the WebLN flag is wiped under the right scope
   *  on a shared browser. */
  disconnectWallet() {
    wallet.disconnect(currentUser || null)
  },

  /**
   * Sign the current user out. Clears persisted session, drops the
   * NDK instance, soft-locks the wallet (NWC's encrypted blob and
   * WebLN's enabled-flag both stay at rest, ready to silently
   * resume when the same user signs back in).
   */
  logout() {
    if (!currentUser || currentUser === undefined) return
    clearSession()
    resetNDK()
    wallet.lockOnLogout()
    cancelPendingAction()
    signerVerified = false
    stubRestoreAttempts = 0
    setUser(null)
  },

  /**
   * Open the show-boost modal. Mirrors openEpisodeBoost's gate chain
   * because the show boost uses the same multi-leg payment flow:
   * needs login (allowlisted leg metadata is donor-signed), needs the
   * real signer (not a stub), needs the signer to match the saved
   * pubkey, and needs a wallet connected (NWC or WebLN).
   *
   * No auto-engage — a user without a wallet is routed through the
   * connect modal, which surfaces both the WebLN extension button
   * and the NWC paste field. Auto-engage was removed because Alby's
   * per-domain permission can silently re-grant on a shared browser,
   * leaking one user's wallet to another's first boost click.
   */
  async openShowBoost(opts = {}) {
    const prefillMessage = typeof opts?.prefillMessage === 'string' ? opts.prefillMessage : ''

    // Gate 1: signed in?
    if (!currentUser || currentUser === undefined) {
      setPendingAction(() => api.openShowBoost({ prefillMessage }))
      api.requestLogin()
      return
    }

    // Gate 1.5: real user (not a stub)?
    if (isStubUser(currentUser)) {
      setPendingAction(() => api.openShowBoost({ prefillMessage }))
      ensureRealRestore()
      return
    }

    // Gate 1.75: signer-account match.
    if (!await ensureSignerVerified()) return

    // Gate 2: wallet connected? Try the at-rest restore (NWC blob or
    // per-pubkey WebLN flag); if neither lands, route through the
    // connect modal where the user picks a wallet explicitly.
    if (!wallet.isReady()) {
      wallet.ensureReady(currentUser)
        .then((ok) => {
          if (ok) {
            api.openShowBoost({ prefillMessage })
          } else {
            handleWalletGateFailure(() => api.openShowBoost({ prefillMessage }))
          }
        })
        .catch(() => {
          handleWalletGateFailure(() => api.openShowBoost({ prefillMessage }))
        })
      return
    }

    setShowBoostState({ prefillMessage })
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

    // Gate 2: wallet connected?
    if (!wallet.isReady()) {
      // Try to restore from at-rest state (NWC encrypted blob, or
      // per-pubkey WebLN flag + still-installed extension). If that
      // succeeds, fall straight through. Otherwise open the connect
      // modal — auto-engage was removed, see wallet.ensureReady.
      wallet.ensureReady(currentUser)
        .then((ok) => {
          if (ok) {
            // Re-call openEpisodeBoost — Gate 2 will pass now.
            api.openEpisodeBoost(args)
          } else {
            handleWalletGateFailure(() => api.openEpisodeBoost(args))
          }
        })
        .catch(() => {
          handleWalletGateFailure(() => api.openEpisodeBoost(args))
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

  /**
   * Open the EXTERNAL-episode boost modal (another podcast's episode, from
   * /feeds). Same login → real-user → signer → wallet gate chain as
   * openEpisodeBoost, but renders ExternalBoostModal and applies NO LB
   * recipient overrides — external recipients + the Fountain→aquafox
   * redirect are already resolved by the caller (value-block.js).
   *
   * @param {object} args
   * @param {object} args.episode          - { showTitle, episodeTitle, podcastGuid, itemGuid, bmbUrl }
   * @param {object} args.recipientsBundle - { recipients, totalWeight }
   */
  async openExternalBoost({ episode, recipientsBundle }) {
    if (!episode || !recipientsBundle || !Array.isArray(recipientsBundle.recipients) || recipientsBundle.recipients.length === 0) {
      console.warn('[LBLogin] openExternalBoost: missing episode/recipients payload')
      return
    }
    const args = { episode, recipientsBundle }

    // Gate 1: signed in?
    if (!currentUser || currentUser === undefined) {
      setPendingAction(() => api.openExternalBoost(args))
      api.requestLogin()
      return
    }
    // Gate 1.5: stub user — wait for real restore (NWC unlock needs the real signer).
    if (isStubUser(currentUser)) {
      setPendingAction(() => api.openExternalBoost(args))
      ensureRealRestore()
      return
    }
    // Gate 1.75: signer-account match (the boostagram embeds the sender pubkey).
    if (!await ensureSignerVerified()) return

    // Gate 2: wallet connected?
    if (!wallet.isReady()) {
      wallet.ensureReady(currentUser)
        .then((ok) => {
          if (ok) api.openExternalBoost(args)
          else handleWalletGateFailure(() => api.openExternalBoost(args))
        })
        .catch(() => handleWalletGateFailure(() => api.openExternalBoost(args)))
      return
    }

    setExternalBoostState({ episode, recipientsBundle })
  },

  /**
   * Open one of the meetup-flow modals on the /meetups page. All four
   * entry points share a single gate chain: login → real-user → signer
   * verified. The actual boost handoff inside each modal calls back
   * into api.openShowBoost which applies the wallet gate, so there's
   * no need to pre-engage the wallet here.
   *
   * Same pending-action pattern as openShowBoost: a click while the
   * user is logged out (or restoring) saves the call, opens the login
   * modal, and replays after login lands.
   *
   * @param {'my'|'search'|'paste'|'create'} kind
   */
  async openMeetupModal(kind) {
    if (!['my', 'search', 'paste', 'create'].includes(kind)) return
    // Open IMMEDIATELY — logged in or not, stub or real. None of these four
    // flows sign on open, so there's no reason to block on login or a full
    // session restore (which used to make even the inert ones feel broken):
    //   - search/paste are read-only/inert inputs, fully usable logged out;
    //   - 'my' and create render an in-modal sign-in prompt when there's no
    //     identity yet, instead of bouncing the user to the login modal.
    // The actual sign is gated at the point of ACTION, which carries its own
    // gates: boosts route through openShowBoost (login prompt with the boost
    // message preserved + ensureSignerVerified), and the create publish runs
    // ensureSignerOk (see MeetupModalHost). If we already have a stub user
    // (returning visitor mid-restore), warm the real restore in the
    // BACKGROUND so the signer is ready by the time they act — without making
    // them wait for it just to see the modal.
    if (currentUser && isStubUser(currentUser)) ensureRealRestore()
    setMeetupModalState({ kind })
  },

  /**
   * Open the bug-report modal. NOT login-gated on purpose — a user who
   * can't log in (e.g. the bug IS the login) still needs to report it.
   * The modal signs with the user's key if logged in (attributed), else
   * with a throwaway key (anonymous) + an optional npub for follow-up.
   */
  openBugReport() {
    setBugReportState({})
  },

  /** Wallet status snapshot for consumers that want to render wallet
   *  state. Now includes a `kind` field ('nwc' | 'webln' | null). */
  getNwcStatus() { return wallet.getStatus() },

  /** Subscribe to wallet connect/disconnect events (either backend).
   *  Returns unsubscribe. */
  onNwcChange(fn) { return wallet.onChange(fn) },

  /**
   * Pay a bolt11 invoice with the user's connected wallet (NWC or
   * WebLN), the same facade the boost flow uses. Attempts an at-rest
   * wallet restore first; if no wallet is connectable, opens the
   * wallet-connect modal and throws a `NO_WALLET` error so the caller
   * can prompt and retry. Returns `{ preimage, kind }` — preimage may
   * be null on backends that don't surface it.
   *
   * The merch checkout (Gamma/NIP-99) is the first external consumer;
   * boosts pay through payAllLegs internally rather than this method.
   */
  async payInvoice(invoice) {
    const active = await this._ensureWalletForPay(invoice)
    const res = await active.payInvoice({ invoice })
    return { preimage: res?.preimage || null, kind: active.kind }
  },

  /**
   * Shared login + wallet gating for the pay methods. Restores an
   * at-rest wallet, and on failure throws the same coded errors both
   * callers translate: NO_WALLET (opens connect modal), WALLET_UNRESPONSIVE
   * (remembered wallet whose unlock stalled — retryable, do NOT reconnect).
   * Returns the active wallet adapter on success.
   */
  async _ensureWalletForPay(invoice) {
    if (typeof invoice !== 'string' || !invoice) throw new Error('Missing invoice')
    if (!currentUser || currentUser === undefined) {
      this.requestLogin()
      throw new Error('Sign in with Nostr first')
    }
    if (isStubUser(currentUser)) throw new Error('Session still restoring — try again in a moment')
    await wallet.ensureReady(currentUser).catch(() => {})
    if (!wallet.isReady()) {
      // Same ambiguity as handleWalletGateFailure: a remembered wallet
      // whose unlock stalled is not "no wallet" — throw a retryable
      // error for the caller's UI instead of opening the connect modal
      // over a checkout that already has a wallet.
      const status = wallet.getStatus()
      if (status.remembered) {
        const err = new Error(status.rememberedKind === 'nwc'
          ? 'Couldn\'t unlock your saved wallet connection. Try again.'
          : 'Your wallet extension didn\'t respond. Check that it\'s unlocked, then try again.')
        err.code = 'WALLET_UNRESPONSIVE'
        throw err
      }
      this.openWalletConnect()
      const err = new Error('Connect a Lightning wallet to pay')
      err.code = 'NO_WALLET'
      throw err
    }
    return wallet.getActiveWallet()
  },

  /**
   * Settlement-verified pay. The safe primitive for one-shot payments
   * like the merch checkout, where a naive `await payInvoice` is a
   * double-spend hazard: over a flaky NWC link the payment can settle
   * on Lightning while the wallet's reply (preimage) is lost, so
   * payInvoice throws even though money moved. A caller that treats
   * that throw as "failed, safe to retry" re-pays a fresh invoice and
   * charges the recipient twice (or four times — see the merch bug).
   *
   * This mirrors what payAllLegs does for boosts: a missing preimage is
   * NEVER assumed to be a failure. We classify the outcome instead of
   * throwing, so the caller can decide whether a retry is safe:
   *   { status: 'paid',      preimage } — settled (preimage or LUD-21 verify)
   *   { status: 'unsettled', error }    — definitively NOT paid, safe to retry
   *   { status: 'uncertain', error }    — unknown; may have paid. Do NOT
   *                                       silently re-pay; warn + confirm first.
   *
   * NO_WALLET / WALLET_UNRESPONSIVE still throw (the caller handles the
   * wallet-connect prompt); only genuine pay-time outcomes are returned.
   *
   * @param {string} invoice  bolt11 to pay
   * @param {{verify?: string}} [opts]  LUD-21 verify URL for this invoice,
   *        if the LNURL endpoint provided one — used to confirm settlement
   *        after an ambiguous pay attempt.
   */
  async payInvoiceVerified(invoice, opts = {}) {
    const active = await this._ensureWalletForPay(invoice)
    const verify = opts?.verify || null
    const paymentHash = bolt11PaymentHash(invoice)

    let preimage = null
    let payError = null
    try {
      const res = await active.payInvoice({ invoice })
      preimage = res?.preimage || null
    } catch (e) {
      payError = e
    }
    if (preimage) return { status: 'paid', preimage, kind: active.kind }

    // No clean preimage. A clean decline (user rejected the prompt,
    // insufficient balance, expired invoice, no route) means the payment
    // definitively never left the wallet → safe to report unsettled
    // without a verify round-trip.
    const payMsg = String(payError?.message || payError || '')
    if (isCleanPaymentDecline(payMsg)) return { status: 'unsettled', preimage: null, kind: active.kind, error: payMsg }

    // Ambiguous (timeout, lost reply, no preimage). Confirm out-of-band
    // via LUD-21 before deciding anything.
    const settlement = await confirmInvoiceSettled(verify, paymentHash)
    if (settlement === 'settled') return { status: 'paid', preimage: null, kind: active.kind }
    if (settlement === 'unsettled') return { status: 'unsettled', preimage: null, kind: active.kind, error: payMsg }
    // 'unknown' — verify URL missing/unreachable. We genuinely can't tell.
    return { status: 'uncertain', preimage: null, kind: active.kind, error: payMsg }
  },

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
    // Bounded like every internal sign path — a wedged extension pipe or
    // backgrounded remote signer otherwise hangs the caller's UI forever
    // (this API serves the zap/reply/repost/like bars and merch checkout).
    await signWithTimeout(ev)
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
  // Guard against a second bundle injection (e.g. one loader injects it for
  // a boost while the nav's bug-report trigger injects it again): the first
  // execution wins, so we never double-mount the React hosts.
  if (!window.LBLogin) {
    window.LBLogin = api
    document.addEventListener('DOMContentLoaded', () => api.mount())
    if (document.readyState !== 'loading') api.mount()
  }
}

export default api
