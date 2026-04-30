import { useState, useRef, useEffect } from 'react'
import AvatarPill from './AvatarPill.jsx'
import IdentityDropdown from './IdentityDropdown.jsx'

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

  // ── Restoring state ──────────────────────────────────────────────
  if (user === undefined) {
    return (
      <div
        className="inline-block w-7 h-7 rounded-full bg-neutral-700 animate-pulse"
        aria-label="Loading account"
      />
    )
  }

  // ── Logged out ───────────────────────────────────────────────────
  // Translucent-white on navy — matches the static placeholder so the
  // swap to the React button is invisible. Defers visually to the
  // orange "Boost the Show" CTA next to it.
  if (user === null) {
    return (
      <button
        type="button"
        onClick={onSignInClick}
        className="inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium border border-white/20 bg-white/[0.08] hover:bg-white/[0.16] hover:border-white/[0.34] transition-colors"
        style={{ color: '#f5eedc' }}
        aria-label="Sign in with Nostr"
      >
        Sign in
      </button>
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
          walletDot={!!walletStatus?.connected}
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
