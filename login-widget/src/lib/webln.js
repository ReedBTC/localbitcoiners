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
 * marks "this pubkey previously enabled WebLN on this site". The flag
 * is keyed per-pubkey so a shared browser can't leak User A's enabled
 * state to User B. On next page load the wallet facade re-checks both
 * `window.webln` and the flag (for the currently signed-in pubkey)
 * and silently re-enables only if both are present.
 *
 * Why per-pubkey: an Alby (or Mutiny) extension grants a per-domain
 * permission that survives any in-page logout. Without per-pubkey
 * scoping, User A enables WebLN here, logs out, User B logs in, and
 * the silent restore quietly connects User B to User A's Alby — a
 * payment that B initiates would debit A. Per-pubkey storage closes
 * that path: B's flag is unset, so nothing auto-restores. (B can
 * still explicitly connect via the connect modal — but that's an
 * informed user choice, not a silent leak.)
 */

import { withTimeout } from './utils.js'

// One-shot migration: clear the legacy global flag from before the
// per-pubkey rewrite. Existing users get bumped to "connect once" the
// next time they boost, which is the safe direction. Cheap; runs once
// at module load.
try { localStorage.removeItem('lb_webln_active') } catch {}

function keyFor(pubkey) {
  return `lb_webln_active_${pubkey}`
}

let activeAlias = null
let isActive = false
// True when this extension was enabled with no Nostr identity behind it.
// Nothing was written to localStorage, so the connection dies with the
// page — see the session-only note on enable().
let activeSessionOnly = false

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
    sessionOnly: isActive ? activeSessionOnly : false,
  }
}

/** True if the given pubkey previously enabled WebLN on this site.
 *  Returns false when called without a pubkey (logged-out branch). */
export function hasStoredFlag(pubkey) {
  if (!pubkey) return false
  try { return localStorage.getItem(keyFor(pubkey)) === '1' } catch { return false }
}

function setStoredFlag(on, pubkey) {
  if (!pubkey) return
  try {
    if (on) localStorage.setItem(keyFor(pubkey), '1')
    else localStorage.removeItem(keyFor(pubkey))
  } catch {}
}

/**
 * Drive window.webln.enable() and (best-effort) fetch the wallet alias
 * via getInfo. Bounded by `timeoutMs` so a misbehaving extension that
 * never resolves doesn't lock the connect modal forever.
 *
 * Requires `pubkey` so the success flag can be written under the
 * current user's storage scope (see file header). Without it we'd
 * regress the cross-user leak the per-pubkey rewrite was meant to
 * fix, so this throws rather than silently writing nothing.
 *
 * `sessionOnly: true` is the one way to enable without a pubkey: a
 * visitor with no Nostr identity at all. Nothing is stored, so the
 * per-pubkey scoping the header describes has nothing to scope and
 * nothing to leak — the connection lives in this page's memory and
 * dies with it. The flag is EXPLICIT rather than inferred from a
 * missing pubkey, so a caller that simply loses the pubkey still
 * throws instead of silently downgrading a signed-in user's wallet
 * to one that won't survive a reload.
 *
 * Single-flight: extensions serve every request from a page through one
 * pipe, so a second enable() issued while the first is still outstanding
 * doesn't race it — it queues behind it. If the first one is wedged (an
 * unrendered permission prompt, a busy extension worker), the second
 * inherits the stall and dies on the same timeout, turning a slow
 * extension into a hard error for a user who did nothing wrong. Callers
 * with an outstanding call in flight get that call's result instead.
 *
 * Throws on missing pubkey / unavailable / refused / timeout. The
 * caller (wallet facade or WalletConnectModal) translates these into
 * UI-level messages.
 */
let inFlight = null   // { pubkey, promise } — see single-flight note above

export async function enable({ pubkey, sessionOnly = false, timeoutMs = 15000 } = {}) {
  if (!pubkey && !sessionOnly) {
    throw new Error('Sign in before connecting your browser extension.')
  }
  if (!isAvailable()) {
    throw new Error('No WebLN provider detected — install a browser extension like Alby first.')
  }
  // Same user, call already outstanding → hand back the in-flight one.
  // A different pubkey can't share the result (the flag is per-pubkey),
  // so let that one settle first rather than piling on the extension.
  // Session-only calls share one key of their own: there is no pubkey to
  // compare and no per-pubkey flag to write, so two of them are genuinely
  // the same request.
  const flightKey = pubkey || '@session'
  if (inFlight) {
    if (inFlight.pubkey === flightKey) return inFlight.promise
    await inFlight.promise.catch(() => {})
  }
  const promise = (async () => {
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
    activeSessionOnly = !pubkey
    setStoredFlag(true, pubkey)
    notify()
    return { alias }
  })()
  inFlight = { pubkey: flightKey, promise }
  try {
    return await promise
  } finally {
    if (inFlight?.promise === promise) inFlight = null
  }
}

/**
 * Pay a bolt11 invoice. Normalised return shape `{ preimage }` matches
 * @getalby/sdk's NWCClient.payInvoice so payAllLegs can swap adapters
 * with no awareness of which one is in play.
 *
 * Errors propagate; callers (payAllLegs / BoostModal) translate them
 * the same way they handle NWC errors.
 */
export async function payInvoice({ invoice, timeoutMs = 90000 }) {
  if (!isActive) {
    // Belt-and-braces: shouldn't happen because the wallet facade
    // gates this on isReady(), but fail loud if someone routes
    // around it.
    throw new Error('Browser-extension wallet not enabled.')
  }
  // Bound the call. Unlike NWC (whose SDK enforces a ~60s reply-timeout
  // ceiling), window.webln.sendPayment can hang indefinitely when the
  // extension is wedged — a broken worker (Alby's "client was not
  // initialized"), an un-rendered approval popup, or an extension that
  // doesn't fully implement WebLN (Sidecar). Without a bound the leg
  // sits in PAYING forever and payAllLegs never resolves, so the whole
  // boost modal spins on "Paying…" with no Retry/Done exit.
  //
  // The timeout is generous (90s) because sendPayment can legitimately
  // block on a human approving a popup. On timeout we throw a message
  // that deliberately does NOT match payAllLegs's clean-decline regex,
  // so the leg is treated as AMBIGUOUS, not failed: it runs settlement
  // verification (LUD-21) and lands PAID or UNCERTAIN — never a blind
  // "wallet wasn't charged" that could invite a double-paying retry.
  const res = await withTimeout(
    Promise.resolve(window.webln.sendPayment(invoice)),
    timeoutMs,
    'Your wallet extension didn\'t respond to the payment in time. It may still be going through — check your wallet before retrying.',
  )
  if (!res || typeof res.preimage !== 'string') {
    throw new Error('Wallet didn\'t return a preimage — payment may not have settled.')
  }
  return { preimage: res.preimage }
}

/** Forget the WebLN connection for a specific user. Clears the
 *  pubkey-scoped flag so it won't silently re-enable on next page
 *  load for that user. Other users on the same browser are
 *  unaffected. The browser extension itself retains its per-domain
 *  permission grant (we have no API to revoke that). */
export function disconnect(pubkey) {
  isActive = false
  activeAlias = null
  activeSessionOnly = false
  setStoredFlag(false, pubkey)
  notify()
}

/** Soft-reset on logout: drop in-memory state but keep the flag so the
 *  next session restore can re-enable silently. Mirrors nwc.lockOnLogout's
 *  contract. */
export function lockOnLogout() {
  isActive = false
  activeAlias = null
  activeSessionOnly = false
  notify()
}
