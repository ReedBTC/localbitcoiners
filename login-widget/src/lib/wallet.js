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
 * Persistence:
 *   - NWC stores an encrypted blob keyed to the user's npub. Survives
 *     across npubs only if the same user signs back in.
 *   - WebLN stores a single bit ("user enabled this on the site").
 *     Not user-keyed — the browser extension itself binds to whatever
 *     account it's pointing at, and that's outside our trust boundary.
 *
 * On logout we soft-lock both (drop in-memory live clients) but leave
 * persisted state at rest, so the same user signing back in resumes
 * where they left off.
 */

import * as nwc from './nwc.js'
import * as webln from './webln.js'

// Sticky "user has interacted with the wallet picker on this site"
// flag. Set once a user has explicitly chosen a wallet (NWC paste,
// WebLN button) OR explicitly walked away from one (disconnect from
// the dropdown) OR been offered the auto-engage prompt (success or
// failure). Once set, never cleared.
//
// Why: the auto-engage path inside ensureReady is supposed to be a
// one-time convenience for users who have Alby installed but have
// never interacted with our wallet UI. Without this flag, an
// explicit disconnect would silently re-engage WebLN on the next
// boost click — Alby retains the per-domain permission grant, so
// `webln.enable()` returns true silently, and the user's intent to
// disconnect is invisibly ignored.
const PICKER_SEEN_KEY = 'lb_wallet_picker_seen'

function markPickerSeen() {
  try { localStorage.setItem(PICKER_SEEN_KEY, '1') } catch {}
}

function hasPickerBeenSeen() {
  try { return localStorage.getItem(PICKER_SEEN_KEY) === '1' } catch { return false }
}

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
 *   { connected: false, hasStoredBlob, hasStoredWebln }
 *
 * Connected NWC takes precedence over connected WebLN per the
 * selection rule above.
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
    hasStoredWebln: webln.hasStoredFlag(),
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
 *  so the user has exactly one wallet at a time — otherwise the
 *  selection rule (NWC over WebLN) would silently demote a working
 *  WebLN connection without telling them. Rejection bubbles. */
export async function connectNwc(uri, currentUser) {
  const result = await nwc.connect(uri, currentUser)
  if (webln.isReady() || webln.hasStoredFlag()) {
    webln.disconnect()
  }
  markPickerSeen()
  return result
}

/** WebLN enable path. On success, wipes any existing NWC state for
 *  the same one-wallet-at-a-time reason. Rejection bubbles. */
export async function connectWebln() {
  const result = await webln.enable()
  if (nwc.isReady() || nwc.getStatus().hasStoredBlob) {
    nwc.disconnect()
  }
  markPickerSeen()
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
 * WebLN (re-enable silently if the user previously enabled it on
 * this site and the extension is still present).
 *
 * Idempotent. Returns true iff a wallet ended up active. Errors from
 * either backend are caught and logged — a transient signer hang
 * shouldn't gate the second try, and a missing extension shouldn't
 * surface as an exception when the page is just probing.
 *
 * `attemptWeblnEnable: true` (default false) escalates: when no
 * wallet is configured at rest but `window.webln` is present, this
 * will *prompt* the extension for permission. Reserved for
 * user-initiated boost paths — page-load restore must never trigger
 * a permission prompt out of nowhere.
 */
export async function ensureReady(currentUser, { attemptWeblnEnable = false } = {}) {
  if (isReady()) return true

  // NWC first (explicit setup wins over the implicit extension path).
  try {
    if (await nwc.ensureReady(currentUser)) return true
  } catch (e) {
    console.warn('[lb-wallet] nwc ensureReady failed', e?.message || e)
  }

  // WebLN at-rest restore. enable() will silently re-grant if the
  // extension already has per-domain permission; the previous
  // explicit opt-in (stored flag) is what gates this branch so it's
  // never a surprise prompt.
  if (webln.hasStoredFlag() && webln.isAvailable()) {
    try {
      await webln.enable()
      return true
    } catch (e) {
      console.warn('[lb-wallet] webln re-enable failed', e?.message || e)
    }
  }

  // Final escalation: opportunistic WebLN engage. Fired from boost
  // click paths so a user who has Alby/Mutiny installed gets a
  // one-tap boost without ever visiting the connect modal.
  //
  // Gated on `hasPickerBeenSeen()` so this only fires for users who
  // have never interacted with our wallet picker. Any prior connect
  // (NWC paste, explicit WebLN button) or disconnect counts as
  // interaction — once they've made an active choice we honour it
  // and route them through the connect modal instead, even if Alby
  // would silently grant the per-domain permission again. Without
  // this gate, an explicit disconnect would invisibly re-engage on
  // the next boost click.
  if (attemptWeblnEnable && webln.isAvailable() && !webln.hasStoredFlag() && !hasPickerBeenSeen()) {
    markPickerSeen()  // mark BEFORE the prompt so a rejection still counts
    try {
      await webln.enable()
      return true
    } catch (e) {
      console.warn('[lb-wallet] webln auto-engage rejected', e?.message || e)
    }
  }

  return false
}

/** Disconnect whichever wallet is active. NWC wipes the encrypted
 *  blob; WebLN clears the active-flag (the extension's per-domain
 *  permission grant is outside our control).
 *
 *  Only the active backend is disconnected — the one-wallet-at-a-time
 *  rule guarantees there's at most one. If neither is active but
 *  orphan at-rest state lingers (rare — e.g. a prior session crashed
 *  before the connect handshake completed), wipe it defensively so
 *  the next ensureReady doesn't pick up a stale config. */
export function disconnect() {
  // An explicit disconnect counts as an active wallet-picker choice
  // and suppresses any future auto-engage — see the picker-seen
  // comment near the top of this file.
  markPickerSeen()
  if (nwc.isReady()) { nwc.disconnect(); return }
  if (webln.isReady()) { webln.disconnect(); return }
  // Defensive cleanup for orphaned at-rest state.
  if (nwc.getStatus().hasStoredBlob) nwc.disconnect()
  if (webln.hasStoredFlag()) webln.disconnect()
}

/** Soft-lock both backends on logout. At-rest state stays so the same
 *  user signing back in can resume without re-pasting / re-prompting. */
export function lockOnLogout() {
  try { nwc.lockOnLogout() } catch {}
  try { webln.lockOnLogout() } catch {}
}
