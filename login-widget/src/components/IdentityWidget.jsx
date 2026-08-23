import { useState, useRef, useEffect } from 'react'
import AvatarPill from './AvatarPill.jsx'
import LoginButton from './LoginButton.jsx'
import IdentityDropdown from './IdentityDropdown.jsx'
import { onIdentityOpenRequest } from '../lib/identitySignal.js'

/**
 * The persistent identity slot in the nav.
 *
 * Three render branches keyed off the user prop:
 *   - null       → 'Sign in' pill (neutral colored, no icon per Reed's call)
 *   - undefined  → restoring state, shimmering circle (caller passes
 *                  undefined while session restore is in flight)
 *   - {pubkey}   → avatar + display name + chevron, opens dropdown
 *
 * Wallet state is read live from props so the green dot on the avatar
 * updates as soon as the user connects/disconnects via the dropdown.
 *
 * ⚠️ The logged-out branch has a second form: a visitor who connected a
 * wallet without signing in. That wallet is real, spendable and theirs
 * to disconnect, so it gets the dropdown rather than a 'Sign in' pill
 * that hides it. A signed-out visitor with no wallet is unchanged.
 */
export default function IdentityWidget({
  user,                 // null = logged out, undefined = restoring, object = logged in
  walletStatus,         // { connected, alias }
  onSignInClick,
  onConnectWallet,
  onDisconnectWallet,
  onSignOut,
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const [triggerRect, setTriggerRect] = useState(null)

  // Each time the dropdown opens, capture the trigger's current rect so
  // the dropdown positions correctly even if the page has scrolled.
  function toggleOpen() {
    if (!open && triggerRef.current) {
      setTriggerRect(triggerRef.current.getBoundingClientRect())
    }
    setOpen((v) => !v)
  }

  // Recompute position on viewport resize while open.
  useEffect(() => {
    if (!open) return
    function onResize() {
      if (triggerRef.current) {
        setTriggerRect(triggerRef.current.getBoundingClientRect())
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // Outside-the-component requests to open the dropdown — currently
  // fired by the boost progress banner so the user can click it to
  // see the in-flight leg status. Captures the trigger rect first so
  // the menu anchors correctly. No-op when the trigger isn't rendered
  // (logged-out / restoring branches return early below).
  useEffect(() => onIdentityOpenRequest(() => {
    if (!triggerRef.current) return
    setTriggerRect(triggerRef.current.getBoundingClientRect())
    setOpen(true)
  }), [])

  // ── Restoring state ──────────────────────────────────────────────
  if (user === undefined) {
    return (
      <div
        className="inline-block w-7 h-7 rounded-full bg-white/20 animate-pulse"
        aria-label="Loading account"
      />
    )
  }

  // ── Logged out ───────────────────────────────────────────────────
  // Translucent-white on navy — matches the static placeholder so the
  // swap to the React button is invisible. Defers visually to the
  // orange "Boost the Show" CTA next to it.
  if (user === null && !walletStatus?.connected) {
    // ⚠️ THE SAME CONTROL THE BOOST MODAL OFFERS, in its nav skin. A visitor
    // meets it here and then again inside the boost modal, and if those read as
    // two different things the second one is a stranger asking for an account
    // at the moment they are about to spend money. `LoginButton` owns both
    // skins; the word is "Log in" and the mark is the site's own favicon,
    // because this is logging into Local Bitcoiners as far as the reader is
    // concerned. What it opens is unchanged.
    return <LoginButton variant="nav" onClick={onSignInClick} />
  }

  // ── Logged out, wallet connected ─────────────────────────────────
  // Same pill and same dropdown as a signed-in account, with a bolt in
  // place of the avatar and the wallet's own word in place of a name.
  // The dropdown carries the disconnect control and the sign-in route;
  // see the null-user branches in IdentityDropdown.
  if (user === null) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={toggleOpen}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Wallet menu"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white/[0.08] hover:bg-white/[0.16] border border-white/20 hover:border-white/[0.34] transition-colors"
          style={{ color: '#f5eedc' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .913-.143Z" clipRule="evenodd"/>
          </svg>
          <span className="hidden sm:inline text-sm font-medium">Wallet</span>
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: '#22c55e' }}
            aria-hidden="true"
          />
        </button>

        {open && (
          <IdentityDropdown
            triggerRect={triggerRect}
            triggerRef={triggerRef}
            user={null}
            walletStatus={walletStatus || { connected: false }}
            onConnectWallet={onConnectWallet}
            onDisconnectWallet={onDisconnectWallet}
            onSignIn={onSignInClick}
            onSignOut={onSignOut}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    )
  }

  // ── Logged in ────────────────────────────────────────────────────
  const profile = user.profile
  const npub = user.npub || ''
  const displayName = profile?.displayName || profile?.name || ''
  // Mobile-safe label: avatar always visible; name hidden under a small
  // breakpoint so the nav stays single-row on phones. Light translucent
  // background gives the button presence on the navy nav without
  // competing with the orange boost CTA.
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="inline-flex items-center gap-2 pl-1 pr-2 py-1 rounded-full bg-white/[0.08] hover:bg-white/[0.16] border border-white/20 hover:border-white/[0.34] transition-colors"
      >
        <AvatarPill
          profile={profile}
          npub={npub}
          size={26}
          walletDot={!!(walletStatus?.connected || walletStatus?.remembered)}
        />
        <span
          className="hidden sm:inline text-sm font-medium max-w-[120px] truncate"
          style={{ color: '#f5eedc' }}
        >
          {displayName || 'Account'}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="hidden sm:inline"
          style={{ color: 'rgba(245, 238, 220, 0.7)' }}
          aria-hidden="true"
        >
          <path d="M2 4 l3 3 l3 -3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <IdentityDropdown
          triggerRect={triggerRect}
          triggerRef={triggerRef}
          user={user}
          walletStatus={walletStatus || { connected: false }}
          onConnectWallet={onConnectWallet}
          onDisconnectWallet={onDisconnectWallet}
          onSignOut={onSignOut}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
