/**
 * Unified wallet facade.
 *
 * Sits in front of nwc.js + webln.js so the rest of the codebase can
 * ask "is a wallet connected" / "pay this invoice" without caring
 * which kind of wallet is on the other end. Everything that used to
 * `import * as nwc from './nwc.js'` should `import * as wallet from
 * './wallet.js'` instead — the surface shape is the same plus a
 * `kind` field on getStatus and a couple of new connect helpers.
 *
 * Selection rule: at any moment exactly one wallet is "active". NWC
 * wins if both are configured because connecting NWC took explicit
 * effort (paste a URI) — implicitly downgrading to the extension
 * after the user set up cross-device pay would be a surprise. In
 * practice the user picks one in the connect modal and that's the
 * one we use.
 *
 * Persistence (both per-pubkey to prevent cross-user leakage on a
 * shared browser):
 *   - NWC stores an encrypted blob keyed to the user's npub. Cannot
 *     be decrypted by a different signer.
 *   - WebLN stores a per-pubkey "previously enabled" bit. A different
 *     user signing in on the same browser sees the bit as unset and
 *     does not silently inherit the prior user's wallet.
 *
 * On logout we soft-lock both (drop in-memory live clients) but leave
 * persisted state at rest, so the same user signing back in resumes
 * where they left off.
 */

import * as nwc from './nwc.js'
import * as webln from './webln.js'

// One-shot migration of legacy globals from before the shared-browser
// leak fix. Runs at module load.
//   - lb_webln_active           → replaced by per-pubkey lb_webln_active_${pubkey}
//   - lb_wallet_picker_seen     → removed entirely (auto-engage path was the
//                                 only consumer and is gone)
try {
  localStorage.removeItem('lb_wallet_picker_seen')
  // lb_webln_active is migrated inside webln.js; both removals happen
  // independently so neither file has to know the other's storage shape.
} catch {}

const listeners = new Set()
let unsubNwc = null
let unsubWebln = null

function ensureWiring() {
  if (!unsubNwc) unsubNwc = nwc.onChange(notify)
  if (!unsubWebln) unsubWebln = webln.onChange(notify)
}

function notify() {
  const status = getStatus()
  for (const fn of listeners) {
    try { fn(status) } catch {}
  }
}

/** Subscribe to wallet status changes (either backend). Returns
 *  unsubscribe fn. Safe to call before any wallet has been touched. */
export function onChange(fn) {
  ensureWiring()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Snapshot of the active wallet:
 *   { connected: true, kind: 'nwc'|'webln', alias?, ownerNpub? }
 *   { connected: false, kind: null, hasStoredBlob, ownerNpub? }
 *
 * Connected NWC takes precedence over connected WebLN per the
 * selection rule above. The disconnected branch deliberately omits
 * any "stored WebLN" hint — that would need a per-pubkey lookup
 * the snapshot doesn't have context for, and no consumer reads it.
 */
export function getStatus() {
  if (nwc.isReady()) {
    const s = nwc.getStatus()
    return {
      connected: true,
      kind: 'nwc',
      alias: s.alias || null,
      ownerNpub: s.ownerNpub || null,
    }
  }
  if (webln.isReady()) {
    const s = webln.getStatus()
    return {
      connected: true,
      kind: 'webln',
      alias: s.alias || null,
    }
  }
  const nwcSnap = nwc.getStatus()
  return {
    connected: false,
    kind: null,
    hasStoredBlob: !!nwcSnap.hasStoredBlob,
    // hasStoredWebln intentionally omitted — would need a pubkey
    // arg to compute correctly under per-pubkey scoping, and no
    // consumer reads it.
    ownerNpub: nwcSnap.ownerNpub || null,
  }
}

/** Quick check used by the boost button + payAllLegs to decide whether
 *  to show "boost" vs "connect wallet first". */
export function isReady() {
  return nwc.isReady() || webln.isReady()
}

/**
 * The active wallet adapter. Both backends expose a uniform shape:
 *   { kind, payInvoice({ invoice }) → { preimage } }
 * payAllLegs receives this and stays oblivious to which one it got.
 *
 * Throws if no wallet is active — callers should gate on isReady() first.
 */
export function getActiveWallet() {
  if (nwc.isReady()) {
    const client = nwc.getClient()
    return {
      kind: 'nwc',
      payInvoice: (args) => client.payInvoice(args),
    }
  }
  if (webln.isReady()) {
    return {
      kind: 'webln',
      payInvoice: (args) => webln.payInvoice(args),
    }
  }
  throw new Error('No wallet connected')
}

// ── Connect helpers ──────────────────────────────────────────────────────

/** Paste-NWC connect path. On success, wipes any existing WebLN state
 *  for this user so they have exactly one wallet at a time — otherwise
 *  the selection rule (NWC over WebLN) would silently demote a
 *  working WebLN connection without telling them. Rejection bubbles. */
export async function connectNwc(uri, currentUser) {
  const result = await nwc.connect(uri, currentUser)
  if (webln.isReady() || webln.hasStoredFlag(currentUser?.pubkey)) {
    webln.disconnect(currentUser?.pubkey)
  }
  return result
}

/** WebLN enable path. Requires `currentUser` so the at-rest flag can
 *  be written under the right per-pubkey scope (see webln.js header
 *  for the shared-browser-leak rationale). On success, wipes any
 *  existing NWC state for the same one-wallet-at-a-time reason.
 *  Rejection bubbles. */
export async function connectWebln(currentUser) {
  if (!currentUser?.pubkey) {
    throw new Error('Sign in before connecting your browser extension.')
  }
  const result = await webln.enable({ pubkey: currentUser.pubkey })
  if (nwc.isReady() || nwc.getStatus().hasStoredBlob) {
    nwc.disconnect()
  }
  return result
}

/** True iff window.webln is present — used by the connect modal to
 *  decide whether to render the "Use browser extension" button. */
export function isWeblnAvailable() {
  return webln.isAvailable()
}

/**
 * Restore from at-rest persistence. Tries NWC first (an encrypted
 * blob keyed to this user's npub takes priority), falls through to
 * per-pubkey WebLN (re-enable silently if *this* user previously
 * enabled it on this site and the extension is still present).
 *
 * Idempotent. Returns true iff a wallet ended up active. Errors from
 * either backend are caught and logged — a transient signer hang
 * shouldn't gate the second try, and a missing extension shouldn't
 * surface as an exception when the page is just probing.
 *
 * Auto-engage was removed: previously this would prompt the extension
 * for permission when no wallet was configured. On a shared browser
 * with a per-domain Alby grant from a different user, that prompt
 * silently completed and routed the new user's payments to the old
 * user's wallet. The connect modal is the single intentional entry
 * point now — its WebLN button is one tap and produces the same
 * end-state without the silent-leak path.
 */
export async function ensureReady(currentUser) {
  if (isReady()) return true

  // NWC first (explicit setup wins over the implicit extension path).
  try {
    if (await nwc.ensureReady(currentUser)) return true
  } catch (e) {
    console.warn('[lb-wallet] nwc ensureReady failed', e?.message || e)
  }

  // WebLN at-rest restore. enable() will silently re-grant if the
  // extension already has per-domain permission; the per-pubkey
  // stored flag is what gates this branch, so a different user
  // signing in on the same browser won't trigger a surprise restore.
  if (currentUser?.pubkey && webln.hasStoredFlag(currentUser.pubkey) && webln.isAvailable()) {
    try {
      await webln.enable({ pubkey: currentUser.pubkey })
      return true
    } catch (e) {
      console.warn('[lb-wallet] webln re-enable failed', e?.message || e)
    }
  }

  return false
}

/** Disconnect whichever wallet is active. NWC wipes the encrypted
 *  blob; WebLN clears the per-pubkey flag for the given user (the
 *  extension's per-domain permission grant is outside our control).
 *
 *  Only the active backend is disconnected — the one-wallet-at-a-time
 *  rule guarantees there's at most one. If neither is active but
 *  orphan at-rest state lingers (rare — e.g. a prior session crashed
 *  before the connect handshake completed), wipe it defensively so
 *  the next ensureReady doesn't pick up a stale config. */
export function disconnect(currentUser) {
  if (nwc.isReady()) { nwc.disconnect(); return }
  if (webln.isReady()) { webln.disconnect(currentUser?.pubkey); return }
  // Defensive cleanup for orphaned at-rest state.
  if (nwc.getStatus().hasStoredBlob) nwc.disconnect()
  if (currentUser?.pubkey && webln.hasStoredFlag(currentUser.pubkey)) {
    webln.disconnect(currentUser.pubkey)
  }
}

/** Soft-lock both backends on logout. At-rest state stays so the same
 *  user signing back in can resume without re-pasting / re-prompting. */
export function lockOnLogout() {
  try { nwc.lockOnLogout() } catch {}
  try { webln.lockOnLogout() } catch {}
}
