import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AvatarPill from './AvatarPill.jsx'
import LoginButton from './LoginButton.jsx'
import { getInFlight, onInFlightChange } from '../lib/boostQueue.js'

/**
 * Dropdown menu anchored to the IdentityWidget trigger button.
 *
 * Rendered via portal to document.body so it can escape the nav's
 * overflow-clip.
 *
 * ⚠️ ITS z-INDEX IS SET AGAINST THE SITE'S NAV, NOT AGAINST THE WIDGET'S OWN
 * LADDER. `#top-nav` in assets/css/nav.css is `position: sticky; z-index: 100`,
 * and this menu portals to document.body, so the two compete directly at body
 * level. It sat at z-[90] and lost, which put the menu behind the very bar it
 * hangs from — the one overlay on this site where that is guaranteed to show,
 * because the trigger is *in* the nav. 120 clears the nav and also the boost
 * progress banner's z-[110], which has to stay true: clicking that banner is
 * what opens this menu. Position is computed from the trigger's bounding box
 * each time the dropdown opens; on resize the host re-renders and
 * recomputes. Right-edge clamp keeps the menu on-screen on phones.
 *
 * Closes on:
 *   - outside click
 *   - Escape key
 *   - any menu item click (handled by the click handlers themselves)
 */

const MENU_WIDTH = 280
const EDGE_PADDING = 12

export default function IdentityDropdown({
  triggerRect,
  triggerRef,           // ref to the trigger button, so a click on it
                        // is recognized as the toggle (not "outside")
  user,
  walletStatus,         // { connected, kind, alias, sessionOnly }
  onConnectWallet,
  onDisconnectWallet,
  onSignIn,             // only used on the signed-out branch
  onSignOut,
  onClose,
}) {
  const menuRef = useRef(null)
  const profile = user?.profile
  const npub = user?.npub || ''
  const displayName = profile?.displayName || profile?.name || 'Anonymous'
  const truncatedNpub = npub
    ? `${npub.slice(0, 10)}…${npub.slice(-6)}`
    : ''
  // A signed-out visitor reaches this menu only by connecting a wallet
  // without a Nostr account. There is no identity to head the menu with
  // and nothing to sign out of, so the pill and the sign-out button are
  // replaced rather than emptied.
  const signedOut = !user

  // In-flight boosts. submitBoost fires-and-forgets; the modal closes
  // immediately and these entries appear here while payAllLegs is
  // running, then disappear when settled. We deliberately don't keep
  // a history of completed boosts — same opacity as Podcasting 2.0
  // boostagrams, where a sender never sees per-leg outcomes either.
  const [pending, setPending] = useState(() => getInFlight())
  useEffect(() => onInFlightChange(setPending), [])

  // Close on outside click + Escape.
  useEffect(() => {
    function onDocClick(e) {
      if (!menuRef.current) return
      if (menuRef.current.contains(e.target)) return
      // Click on the trigger itself is the toggle path — let the
      // trigger's onClick run and flip `open` to false. Without this
      // guard, mousedown closes here, then the trigger's onClick reads
      // the freshly-closed state and re-opens it.
      if (triggerRef?.current?.contains(e.target)) return
      onClose()
    }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    // Use mousedown so the close fires before any inner click handler
    // re-opens the dropdown (e.g. clicking the trigger again).
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // Compute position. Anchor below the trigger, right-aligned. Clamp to
  // the viewport with edge padding so the menu never clips on mobile.
  const position = computePosition(triggerRect)

  return createPortal(
    <div className="lb-w"><div
      ref={menuRef}
      role="menu"
      aria-label="Account menu"
      className="fixed z-[120] bg-[var(--modal-bg,#fbf6ea)] border border-[var(--modal-line,#d4c4a0)] rounded-lg shadow-[0_24px_60px_-12px_rgba(11,58,82,0.28),0_0_0_1px_rgba(11,58,82,0.06)] text-sm text-[var(--ink,#2d2010)] overflow-hidden"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${MENU_WIDTH}px`,
      }}
    >
      {/* User pill */}
      {signedOut ? (
        <div className="px-4 py-3 border-b border-[var(--modal-line,#d4c4a0)]">
          <p className="font-semibold text-[var(--ink,#2d2010)]">Not logged in</p>
          {/* ⚠️ THIS SAID "none of them post to Nostr" AND PHASE 2 MADE THAT
              FALSE. A signed-out boost with the Private Boost box left
              unchecked is published under the show's own account —
              that is the whole point, since an anonymous booster still counts
              in the feeds and the totals. The old line told a visitor their
              boost left no public record, which is the one claim about their
              own data they must not be misled on. */}
          <p className="text-[11px] text-[var(--muted,#6b5a3e)] leading-snug mt-0.5">
            Boosts you send carry no account. Local Bitcoiners posts them for you
            unless you mark one private.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--modal-line,#d4c4a0)]">
          <AvatarPill profile={profile} npub={npub} size={36} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-[var(--ink,#2d2010)] truncate">{displayName}</p>
            <p className="text-[11px] text-[var(--muted,#6b5a3e)] font-mono truncate">{truncatedNpub}</p>
          </div>
        </div>
      )}

      {/* Wallet section */}
      <div className="px-4 py-3 border-b border-[var(--modal-line,#d4c4a0)] space-y-2">
        <p className="text-[11px] text-[var(--muted,#6b5a3e)] uppercase tracking-wide">⚡ Lightning Wallet</p>
        {/* `remembered` = a browser extension this user already enabled here,
            still installed, not yet engaged this page load (we no longer prod
            it before the user asks — see wallet.prewarm). It engages on the
            first boost tap, so present it as connected rather than making the
            user re-connect something they never disconnected. */}
        {walletStatus.connected || walletStatus.remembered ? (
          <>
            <p className="text-xs text-[var(--ink,#2d2010)] truncate">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--ok,#2f7a3a)] mr-1.5 align-middle" />
              {walletKindLabel(walletStatus)}
            </p>
            {/* Said once, here, where the user can act on it. A saved
                connection is encrypted to the user's own Nostr key, so
                without an account there is nothing to encrypt to and the
                honest answer is a wallet that lasts one tab.
                ⚠️ A session wallet can outlive the sign-in that follows it
                — signing in does not retroactively save a URI we no longer
                hold — so the second string is not a copy of the first with
                the sign-in cut off; it names a different next step. */}
            {walletStatus.sessionOnly && (
              <p className="text-[11px] text-[var(--warn,#7a5c00)] leading-snug">
                {signedOut
                  ? 'This tab only — log in to save it.'
                  : 'This tab only — reconnect now to save it to your account.'}
              </p>
            )}
            {/* The route out of session-only for a user who has since
                signed in. It re-opens the connect modal rather than
                promising a one-click save: the URI itself was never kept
                — only the live client was — so saving it means pasting
                it again, and a button that said otherwise would fail
                silently. */}
            {walletStatus.sessionOnly && !signedOut && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { onClose(); onConnectWallet() }}
                className="w-full px-3 py-2 rounded-lg bg-[var(--brand-dd,#a85500)] hover:bg-[var(--brand-ddd,#8a4500)] text-xs font-medium text-white transition-colors"
              >
                Reconnect to save it
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); onDisconnectWallet() }}
              className="w-full px-3 py-2 rounded-lg border border-[var(--modal-line,#d4c4a0)] bg-transparent text-xs font-medium text-[var(--ink,#2d2010)] hover:bg-[rgba(179,38,30,0.08)] hover:border-[var(--danger,#b3261e)] hover:text-[var(--danger,#b3261e)] transition-colors"
            >
              Disconnect wallet
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-[var(--muted,#6b5a3e)]">Not connected</p>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); onConnectWallet() }}
              className="w-full px-3 py-2 rounded-lg bg-[var(--brand-dd,#a85500)] hover:bg-[var(--brand-ddd,#8a4500)] text-xs font-medium text-white transition-colors"
            >
              Connect Lightning Wallet
            </button>
          </>
        )}
      </div>

      {/* Boosts in progress + recently-settled. Appears while any
          boost is sending and lingers a few seconds after settle so
          the user can register a paid / partial / failed badge before
          the row disappears. We don't track completed boosts beyond
          that window — the casual user has the same opacity
          Podcasting 2.0 ships with: click and trust. */}
      {pending.length > 0 && (
        <div className="px-4 py-3 border-b border-[var(--modal-line,#d4c4a0)] space-y-2">
          <p className="text-[11px] text-[var(--muted,#6b5a3e)] uppercase tracking-wide">In Progress</p>
          <ul className="space-y-1.5">
            {pending.map((p) => {
              // `kind: 'show'` is set by BoostModal so a site-wide
              // boost reads "Show" here instead of falling through to
              // the "Episode" defensive default. Per-episode boosts
              // don't set the kind and always have a number.
              const epLabel = p.episode?.kind === 'show'
                ? 'Show'
                : p.episode?.number
                  ? `Ep. ${String(p.episode.number).padStart(3, '0')}`
                  : 'Episode'
              return (
                <li key={p.sessionId} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--ink,#2d2010)] truncate">
                      {epLabel} · {p.totalSats.toLocaleString()} sats
                    </span>
                    <BoostStatusBadge status={p.status} />
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Sign in / sign out. Signed out, this is the way back to an
          identity — the pill that normally offers it was replaced by the
          wallet pill, so the offer moves in here rather than vanishing. */}
      {signedOut ? (
        <div className="px-4 py-3">
          {/* ⚠️ THE SAME CONTROL THE NAV AND THE BOOST MODAL OFFER, in its
              checkout skin, so a visitor who has met it twice already meets it
              a third time rather than something new. It said "Sign in with
              Nostr" in white on `--brand` until 2026-08-21, which is a
              contrast ratio of 2.5:1 — the label only became readable on
              hover, where `--brand-d` takes it to 3.8:1. The checkout skin
              carries its text in `--brand-dd` on white, 5.5:1, and it is a
              shape that was already approved rather than a fourth colour
              decision. See LoginButton's own header for the vocabulary rule. */}
          <LoginButton
            variant="checkout"
            role="menuitem"
            className="w-full"
            onClick={() => { onClose(); onSignIn?.() }}
          />
          <p className="mt-2 text-[11px] text-[var(--muted,#6b5a3e)] leading-snug">
            Logging in posts your boosts under your own name, and a wallet you
            connect after that is remembered.
          </p>
        </div>
      ) : (
      <div className="px-4 py-3">
        <button
          type="button"
          role="menuitem"
          onClick={() => { onClose(); onSignOut() }}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[var(--modal-line,#d4c4a0)] bg-transparent text-xs font-medium text-[var(--ink,#2d2010)] hover:bg-[rgba(179,38,30,0.08)] hover:border-[var(--danger,#b3261e)] hover:text-[var(--danger,#b3261e)] transition-colors"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15" />
            <path d="M12 9l-3 3 3 3" />
            <path d="M9 12h12.75" />
          </svg>
          Sign out
        </button>
      </div>
      )}
    </div></div>,
    document.body,
  )
}

// Surface which wallet backend is active. WebLN connections come from
// a browser extension and rarely report a useful alias, so we use a
// generic "Browser extension" label rather than risk an empty trailing
// "Connected · ". NWC almost always has an alias when the wallet
// implements get_info; if not, fall through to a plain "Connected".
function walletKindLabel(status) {
  const alias = sanitizeAlias(status.alias)
  // A remembered-but-not-yet-engaged wallet has no live `kind` (nothing is
  // active) — fall back to what we remember it was.
  const kind = status.kind || (status.remembered ? status.rememberedKind : null)
  if (kind === 'webln') {
    return alias ? `Browser extension · ${alias}` : 'Browser extension'
  }
  if (alias) return `Connected · ${alias}`
  return 'Connected'
}

// Strip Unicode bidi-override and isolate marks before rendering an
// alias the wallet sent us. React already escapes HTML, but bidi
// controls can flip the visible character order — a hostile or
// misconfigured wallet could ship `"‮…"` and reorder the entire
// dropdown line. The wallet is technically inside our trust boundary
// (NWC URI was user-pasted; WebLN extension was user-installed) but
// the cost of cleaning is one regex and the failure mode is real.
//
// Range covers U+202A..U+202E (LRE/RLE/PDF/LRO/RLO) and U+2066..U+2069
// (LRI/RLI/FSI/PDI). Escaped via \u so the source stays grep-friendly.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g
function sanitizeAlias(s) {
  if (typeof s !== 'string' || !s) return ''
  return s.replace(BIDI_CONTROLS, '')
}

function BoostStatusBadge({ status }) {
  // Known statuses get a distinct color + label so a glance at the
  // dropdown tells the user the outcome without reading. The pulsing
  // orange dot is reserved for the active state to match the banner
  // above.
  if (status === 'in-flight') {
    return (
      <span className="text-[var(--brand-d,#d97b0e)] text-[10px] flex-shrink-0 inline-flex items-center gap-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--brand,#f7931a)] animate-pulse" aria-hidden="true" />
        Sending…
      </span>
    )
  }
  if (status === 'paid') {
    return (
      <span className="text-[var(--ok,#2f7a3a)] text-[10px] flex-shrink-0 inline-flex items-center gap-1">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 8.5l3.5 3.5L13 5" />
        </svg>
        Paid
      </span>
    )
  }
  if (status === 'partial') {
    return (
      <span className="text-[var(--warn,#7a5c00)] text-[10px] flex-shrink-0 inline-flex items-center gap-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--warn,#7a5c00)]" aria-hidden="true" />
        Partial
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="text-[var(--danger,#b3261e)] text-[10px] flex-shrink-0 inline-flex items-center gap-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--danger,#b3261e)]" aria-hidden="true" />
        Failed
      </span>
    )
  }
  // Unknown / future status — render nothing rather than fall through
  // to a misleading "Sending…" label that would lie about the entry's
  // real state.
  return null
}

function computePosition(triggerRect) {
  if (!triggerRect) return { top: 0, left: 0 }
  const top = triggerRect.bottom + 8
  // Right-align with the trigger, but clamp to viewport.
  let left = triggerRect.right - MENU_WIDTH
  const maxLeft = window.innerWidth - MENU_WIDTH - EDGE_PADDING
  if (left > maxLeft) left = maxLeft
  if (left < EDGE_PADDING) left = EDGE_PADDING
  return { top, left }
}
