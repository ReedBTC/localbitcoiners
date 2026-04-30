import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AvatarPill from './AvatarPill.jsx'
import { getInFlight, onInFlightChange } from '../lib/boostQueue.js'

/**
 * Dropdown menu anchored to the IdentityWidget trigger button.
 *
 * Rendered via portal to document.body so it can escape the nav's
 * overflow-clip. Position is computed from the trigger's bounding box
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
  user,
  walletStatus,         // { connected, alias }
  onConnectWallet,
  onDisconnectWallet,
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
  }, [onClose])

  // Compute position. Anchor below the trigger, right-aligned. Clamp to
  // the viewport with edge padding so the menu never clips on mobile.
  const position = computePosition(triggerRect)

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Account menu"
      className="fixed z-[90] bg-neutral-900 border border-neutral-700 rounded-lg shadow-[0_25px_60px_-12px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.04)] text-sm text-neutral-200 overflow-hidden"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: `${MENU_WIDTH}px`,
      }}
    >
      {/* User pill */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
        <AvatarPill profile={profile} npub={npub} size={36} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-neutral-100 truncate">{displayName}</p>
          <p className="text-[11px] text-neutral-500 font-mono truncate">{truncatedNpub}</p>
        </div>
      </div>

      {/* Wallet section */}
      <div className="px-4 py-3 border-b border-neutral-800 space-y-2">
        <p className="text-[11px] text-neutral-500 uppercase tracking-wide">⚡ Lightning Wallet</p>
        {walletStatus.connected ? (
          <>
            <p className="text-xs text-neutral-300 truncate">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 align-middle" />
              Connected{walletStatus.alias ? ` · ${walletStatus.alias}` : ''}
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); onDisconnectWallet() }}
              className="w-full px-3 py-2 rounded border border-neutral-700 bg-transparent text-xs font-medium text-neutral-300 hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-300 transition-colors"
            >
              Disconnect wallet
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-neutral-500">Not connected</p>
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); onConnectWallet() }}
              className="w-full px-3 py-2 rounded bg-orange-500 hover:bg-orange-600 text-xs font-medium text-white transition-colors"
            >
              Connect Lightning Wallet
            </button>
          </>
        )}
      </div>

      {/* In-flight boosts — appears only while a boost is sending,
          disappears once it settles. Hidden entirely otherwise. We
          don't track completed boosts; the casual user has the same
          opacity Podcasting 2.0 ships with — click and trust. */}
      {pending.length > 0 && (
        <div className="px-4 py-3 border-b border-neutral-800 space-y-2">
          <p className="text-[11px] text-neutral-500 uppercase tracking-wide">In Progress</p>
          <ul className="space-y-1.5">
            {pending.map((p) => {
              const epLabel = p.episode?.number
                ? `Ep. ${String(p.episode.number).padStart(3, '0')}`
                : 'Episode'
              return (
                <li key={p.sessionId} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-neutral-300 truncate">
                      {epLabel} · {p.totalSats.toLocaleString()} sats
                    </span>
                    <span className="text-orange-400 text-[10px] flex-shrink-0 inline-flex items-center gap-1">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" aria-hidden="true" />
                      Sending…
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Sign out — outlined button styling marks this as a real
          action surface, not just a text link. Red-tinted hover
          signals the destructive nature without screaming when idle. */}
      <div className="px-4 py-3">
        <button
          type="button"
          role="menuitem"
          onClick={() => { onClose(); onSignOut() }}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded border border-neutral-700 bg-transparent text-xs font-medium text-neutral-300 hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-300 transition-colors"
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
    </div>,
    document.body,
  )
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
