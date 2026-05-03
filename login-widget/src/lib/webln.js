/**
 * WebLN (browser-extension wallet) adapter.
 *
 * Companion to nwc.js — a second concrete wallet implementation behind
 * the unified wallet facade in lib/wallet.js. The facade owns the
 * "which wallet is active" state; this module only knows how to drive
 * `window.webln`.
 *
 * Why WebLN as a peer to NWC and not a replacement: NWC works across
 * devices once a connection string is pasted in, but it requires the
 * user to obtain that string from their wallet's UI. Browser-extension
 * users (Alby, Mutiny) already have a one-tap pay path via WebLN that
 * skips the copy/paste step entirely. This module gives them that path
 * without forcing the rest of the codebase to know which kind of wallet
 * is on the other end.
 *
 * Lifecycle:
 *   - isAvailable()  → cheap sync check; window.webln is present
 *   - enable()       → user-permission gate; returns { alias } on success.
 *                      Most extensions cache the per-domain permission
 *                      after the first prompt, so subsequent enable()
 *                      calls are silent.
 *   - payInvoice()   → wraps window.webln.sendPayment; normalises the
 *                      return shape to match the NWC adapter's
 *                      ({ preimage }) so payAllLegs is wallet-agnostic.
 *
 * Persistence is intentionally minimal — a single flag in localStorage
 * marks "user previously enabled WebLN on this site". On next page
 * load the wallet facade re-checks both `window.webln` and the flag
 * and silently re-enables if both are present. No URI to encrypt, no
 * signer round-trip, no per-account binding (the extension manages
 * that itself).
 */

import { withTimeout } from './utils.js'

const STORAGE_KEY = 'lb_webln_active'

let activeAlias = null
let isActive = false

const listeners = new Set()
function notify() {
  const status = getStatus()
  for (const fn of listeners) {
    try { fn(status) } catch {}
  }
}

/** Subscribe to enable/disable events. Returns an unsubscribe fn. */
export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** True iff window.webln is present right now. Cheap sync check;
 *  callers can render the "Use browser extension" option conditionally. */
export function isAvailable() {
  return typeof window !== 'undefined' && !!window.webln
}

/** True once enable() has succeeded this session. */
export function isReady() {
  return isActive
}

/** Snapshot for the wallet facade. */
export function getStatus() {
  return {
    connected: isActive,
    alias: activeAlias,
  }
}

/** True if the user previously enabled WebLN on this site. */
export function hasStoredFlag() {
  try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
}

function setStoredFlag(on) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

/**
 * Drive window.webln.enable() and (best-effort) fetch the wallet alias
 * via getInfo. Bounded by `timeoutMs` so a misbehaving extension that
 * never resolves doesn't lock the connect modal forever.
 *
 * Throws on unavailable / refused / timeout. The caller (wallet
 * facade or WalletConnectModal) translates these into UI-level
 * messages.
 */
export async function enable({ timeoutMs = 15000 } = {}) {
  if (!isAvailable()) {
    throw new Error('No WebLN provider detected — install a browser extension like Alby first.')
  }
  await withTimeout(
    Promise.resolve(window.webln.enable()),
    timeoutMs,
    'Your wallet extension didn\'t respond. Try again, or check that it\'s unlocked.',
  )
  // Best-effort alias. Some providers don't implement getInfo at all
  // (or implement it only inside a paywalled tier). Treat any failure
  // as "alias unknown" — the connection still works.
  let alias = null
  try {
    const info = await withTimeout(
      Promise.resolve(window.webln.getInfo()),
      5000,
      'info-timeout',
    )
    alias = info?.node?.alias || info?.alias || null
  } catch {}
  isActive = true
  activeAlias = alias
  setStoredFlag(true)
  notify()
  return { alias }
}

/**
 * Pay a bolt11 invoice. Normalised return shape `{ preimage }` matches
 * @getalby/sdk's NWCClient.payInvoice so payAllLegs can swap adapters
 * with no awareness of which one is in play.
 *
 * Errors propagate; callers (payAllLegs / BoostModal) translate them
 * the same way they handle NWC errors.
 */
export async function payInvoice({ invoice }) {
  if (!isActive) {
    // Belt-and-braces: shouldn't happen because the wallet facade
    // gates this on isReady(), but fail loud if someone routes
    // around it.
    throw new Error('Browser-extension wallet not enabled.')
  }
  const res = await window.webln.sendPayment(invoice)
  if (!res || typeof res.preimage !== 'string') {
    throw new Error('Wallet didn\'t return a preimage — payment may not have settled.')
  }
  return { preimage: res.preimage }
}

/** Forget the WebLN connection. Clears the stored flag so it won't
 *  silently re-enable on next page load. The browser extension itself
 *  retains its per-domain permission grant (we have no API to revoke
 *  that). */
export function disconnect() {
  isActive = false
  activeAlias = null
  setStoredFlag(false)
  notify()
}

/** Soft-reset on logout: drop in-memory state but keep the flag so the
 *  next session restore can re-enable silently. Mirrors nwc.lockOnLogout's
 *  contract. */
export function lockOnLogout() {
  isActive = false
  activeAlias = null
  notify()
}
