/**
 * WebLN browser-extension adapter (Alby and compatibles).
 *
 * Mirrors the export shape of `nwc.js` so the wallet manager
 * (`wallet.js`) can delegate to either adapter without consumers
 * caring which is active.
 *
 * Key differences from NWC:
 *   - No persistence layer. The extension owns the credential —
 *     authorization is per-origin, persists across reloads, and can
 *     only be fully revoked from the extension's UI.
 *   - No Nostr-account binding. WebLN doesn't know about npubs;
 *     `lockOnLogout` is a no-op because there's nothing to lock.
 *   - No relay round-trip. `enable()` and `sendPayment()` are direct
 *     RPC calls into the extension.
 *
 * The `payInvoice({invoice})` shape returned by `getClient()` matches
 * what `payAllLegs.js` and `BoostModal.jsx` already consume from NWC,
 * so no orchestrator changes are needed.
 */

import { withTimeout } from './utils.js'

// In-memory state. Set true once `enable()` has resolved this session.
// We don't try to detect previously-authorized origins synchronously —
// the WebLN spec doesn't expose that — so a fresh page load always
// starts with `enabled=false` and `ensureReady()` re-calls `enable()`.
// Authorized origins get a silent re-enable; unauthorized ones reject.
let enabled = false
let alias = null

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

/** True when window.webln exists. The connect-modal and IdentityDropdown
 *  call this synchronously to decide whether to render WebLN UI at all. */
export function isAvailable() {
  return typeof window !== 'undefined' && !!window.webln
}

/**
 * Snapshot of WebLN state. Three shapes mirror NWC for symmetry:
 *   { connected: false, kind: 'webln', extensionMissing: true }   // no provider
 *   { connected: false, kind: 'webln' }                            // provider present, not enabled yet
 *   { connected: true, kind: 'webln', alias? }                     // ready to pay
 */
export function getStatus() {
  if (!isAvailable()) {
    return { connected: false, kind: 'webln', extensionMissing: true }
  }
  if (enabled) {
    return { connected: true, kind: 'webln', alias: alias || null }
  }
  return { connected: false, kind: 'webln' }
}

/** Quick sync check — same shape as nwc.isReady(). */
export function isReady() {
  return enabled && isAvailable()
}

/**
 * Returns a thin client object that exposes `payInvoice({invoice})` →
 * `{ preimage }`. Same contract `payAllLegs.runLeg` already calls; same
 * shape `BoostModal.handleGenerate` reads. Wrapping here keeps the
 * orchestrator generic — it doesn't need to know whether the underlying
 * call was NWC over a relay or WebLN over a content-script bridge.
 *
 * Throws if not enabled — call `ensureReady()` first.
 */
export function getClient() {
  if (!enabled || !isAvailable()) {
    throw new Error('WebLN not enabled')
  }
  return {
    payInvoice: async ({ invoice }) => {
      const res = await window.webln.sendPayment(invoice)
      // Some providers return `payment_preimage` (Alby legacy) instead of
      // `preimage` — accept either so the orchestrator's preimage check
      // doesn't false-fail on a successful payment.
      const preimage = res?.preimage || res?.payment_preimage || ''
      return { preimage }
    },
  }
}

/**
 * Connect WebLN. Requires a user gesture for the *first* call (the
 * extension opens a permission prompt); subsequent calls in already-
 * authorized origins resolve silently. Caller must invoke this from a
 * click handler.
 *
 * Returns `{ alias }` on success. Throws on:
 *   - extension missing
 *   - user denies permission
 *   - extension hangs (10s)
 */
export async function connect() {
  if (!isAvailable()) {
    throw new Error('No Lightning extension found. Install Alby or another WebLN provider, then try again.')
  }
  // 10s budget — extensions usually return in <100ms, but a hung
  // extension worker (Alby has had this on extension updates) can sit
  // forever. Bound it so the modal can surface a clean error instead of
  // spinning indefinitely.
  try {
    await withTimeout(
      window.webln.enable(),
      10000,
      'Your wallet extension didn\'t respond. Make sure it\'s enabled and try again.',
    )
  } catch (e) {
    enabled = false
    throw e
  }
  enabled = true

  // Best-effort alias lookup. Some providers don't implement getInfo or
  // expose a node alias — we just leave it null in that case.
  try {
    const info = await withTimeout(window.webln.getInfo(), 5000, 'info-timeout')
    alias = info?.node?.alias || info?.alias || null
  } catch {
    alias = null
  }

  notify()
  return { alias }
}

/**
 * Re-enable an already-authorized origin without prompting. Returns
 * boolean: true if WebLN is ready after the call, false otherwise.
 *
 * The WebLN spec doesn't expose "is this origin already authorized"
 * synchronously, so the only way to know is to call `enable()` and see
 * whether it resolves silently or pops a prompt. Per Alby's docs
 * (and verified behavior), authorized origins get a silent resolve and
 * unauthorized ones reject — no user gesture is consumed in either case.
 *
 * Used by the wallet manager's `ensureReady` so a returning visitor
 * picks up wallet state on page load without any click.
 */
export async function ensureReady() {
  if (enabled) return true
  if (!isAvailable()) return false
  try {
    await withTimeout(window.webln.enable(), 5000, 'enable-timeout')
    enabled = true
    // Refresh alias quietly. If getInfo also takes long, skip — the
    // alias is cosmetic; the connected state is what matters.
    try {
      const info = await withTimeout(window.webln.getInfo(), 3000, 'info-timeout')
      alias = info?.node?.alias || info?.alias || null
    } catch {
      alias = null
    }
    notify()
    return true
  } catch {
    enabled = false
    return false
  }
}

/**
 * Disconnect WebLN locally. WebLN doesn't expose a `disable()` API —
 * the per-origin grant lives in the extension's settings and only the
 * user can fully revoke it there. So this is a soft local
 * disconnect: drop our session flag, fire the change notification.
 * Next call to `connect()` will re-enable silently for authorized
 * origins, or pop a fresh prompt for revoked ones.
 */
export function disconnect() {
  enabled = false
  alias = null
  notify()
}

/**
 * Logout teardown. WebLN authorization isn't tied to the user's Nostr
 * identity, so unlike NWC there's nothing to "lock for next sign-in".
 * Drop in-memory state so the post-logout UI shows "not connected"
 * until the user reconnects on next session.
 */
export function lockOnLogout() {
  enabled = false
  alias = null
  notify()
}
