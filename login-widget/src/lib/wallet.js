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
 * ⚠️ A WALLET CONNECTED WITH NO NOSTR LOGIN IS SESSION-ONLY, and that is
 * structural rather than a limitation waiting to be lifted: both at-rest
 * schemes above are keyed to an identity, and there isn't one. So the
 * connection lives in memory and dies with the page. `getStatus()`
 * reports it as `sessionOnly` so the UI can say so before the user finds
 * out by reloading.
 *
 * On logout we soft-lock both (drop in-memory live clients) but leave
 * persisted state at rest, so the same user signing back in resumes
 * where they left off.
 */

import { NDKNip07Signer } from '@nostr-dev-kit/ndk'
import * as nwc from './nwc.js'
import * as webln from './webln.js'
import { getNDK } from './ndk.js'

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

// Who's signed in, as far as the wallet facade is concerned. The WebLN
// at-rest flag is per-pubkey, so getStatus() needs a pubkey to answer
// "does this user have a remembered extension wallet?" — and getStatus()
// is called from notify() with no arguments. Keeping the pubkey here is
// what lets the snapshot carry `remembered` without every call site
// having to thread a user through.
let currentPubkey = null
let currentNpub = null

/** Tell the facade which user is signed in (null on logout). Fires a
 *  status notification so the identity dot re-evaluates `remembered`
 *  against the new pubkey. */
export function setUserContext(user) {
  const pk = user?.pubkey || null
  const np = user?.npub || null
  if (pk === currentPubkey && np === currentNpub) return
  currentPubkey = pk
  currentNpub = np
  notify()
}

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
 *   { connected: true,  kind: 'nwc'|'webln', alias?, ownerNpub?, sessionOnly }
 *   { connected: false, kind: null, remembered, hasStoredBlob, ownerNpub? }
 *
 * `sessionOnly` is true when the connection was made with no Nostr
 * identity behind it, so nothing was persisted and it dies with the
 * page. Never true on a disconnected snapshot: there is no such thing
 * as a remembered session wallet.
 *
 * Connected NWC takes precedence over connected WebLN per the
 * selection rule above.
 *
 * `remembered` means "this user enabled a browser extension here before
 * and it's still installed" — i.e. the next boost will engage it with a
 * single tap and no paste. It is deliberately NOT the same as connected:
 * enable() hasn't run, so isReady() stays false and payment paths still
 * route through ensureReady(). It exists purely so the identity dot can
 * keep showing a wallet without us prodding the extension on page load
 * (see the prewarm() note).
 */
export function getStatus() {
  if (nwc.isReady()) {
    const s = nwc.getStatus()
    return {
      connected: true,
      kind: 'nwc',
      alias: s.alias || null,
      ownerNpub: s.ownerNpub || null,
      sessionOnly: !!s.sessionOnly,
    }
  }
  if (webln.isReady()) {
    const s = webln.getStatus()
    return {
      connected: true,
      kind: 'webln',
      alias: s.alias || null,
      sessionOnly: !!s.sessionOnly,
    }
  }
  const nwcSnap = nwc.getStatus()
  // `remembered` covers both at-rest shapes: a WebLN extension this user
  // enabled here before (still installed), or an NWC blob saved under
  // this user's npub that prewarm deliberately didn't unlock (NIP-07
  // sessions defer the extension decrypt to the first tap — see
  // prewarm()). Either engages on the next boost tap without a re-connect.
  const weblnRemembered = !!(currentPubkey && webln.hasStoredFlag(currentPubkey) && webln.isAvailable())
  const nwcRemembered = !!(nwcSnap.hasStoredBlob && currentNpub && nwcSnap.ownerNpub === currentNpub)
  return {
    connected: false,
    kind: null,
    remembered: weblnRemembered || nwcRemembered,
    rememberedKind: weblnRemembered ? 'webln' : (nwcRemembered ? 'nwc' : 'webln'),
    hasStoredBlob: !!nwcSnap.hasStoredBlob,
    ownerNpub: nwcSnap.ownerNpub || null,
    sessionOnly: false,
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
 *  working WebLN connection without telling them. Rejection bubbles.
 *
 *  `currentUser` may be null: nwc.connect then takes its session-only
 *  path. `hasStoredFlag(null)` is false by contract, so a signed-out
 *  connect clears only the live extension, never another account's
 *  stored flag. */
export async function connectNwc(uri, currentUser) {
  const pubkey = currentUser?.pubkey || null
  const result = await nwc.connect(uri, currentUser)
  if (webln.isReady() || webln.hasStoredFlag(pubkey)) {
    webln.disconnect(pubkey)
  }
  return result
}

/** WebLN enable path. `currentUser` scopes the at-rest flag to the right
 *  pubkey (see webln.js header for the shared-browser-leak rationale);
 *  with no user the enable is session-only and writes nothing. On
 *  success, wipes any existing NWC state for the same one-wallet-at-a-
 *  time reason. Rejection bubbles.
 *
 *  ⚠️ The signed-out branch clears only a LIVE nwc client, never the
 *  stored blob. That blob belongs to an account that is not signed in,
 *  and a visitor picking a wallet for themselves must not delete it. */
export async function connectWebln(currentUser) {
  const pubkey = currentUser?.pubkey || null
  const result = await webln.enable(
    pubkey ? { pubkey } : { pubkey: null, sessionOnly: true },
  )
  if (pubkey) {
    if (nwc.isReady() || nwc.getStatus().hasStoredBlob) nwc.disconnect()
  } else if (nwc.isReady()) {
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

/**
 * Page-load warm-up. Unlike ensureReady(), this NEVER calls into the
 * browser extension.
 *
 * We used to run the full ensureReady() here, which fired a WebLN
 * enable() with no user gesture behind it while the page was still
 * hydrating. On a busy page (/feeds opening its relay sockets and
 * batching profile fetches) an extension can be slow to answer that
 * call, and extensions serve a page from a single request pipe: the
 * stalled enable() then sat in front of everything the user actually
 * asked for. The visible result was a wallet that looked disconnected,
 * a connect modal that took seconds to open (the signer check was stuck
 * behind the same pipe), and a "your wallet extension didn't respond"
 * timeout on a wallet that was working fine.
 *
 * So: NWC still warms up (its unlock is a relay socket + a decrypt, all
 * our own I/O and worth doing early), while WebLN just reports itself as
 * `remembered` in getStatus() and waits for the user's first tap — which
 * is a real gesture, the moment extensions are reliable. The only thing
 * lost is a few hundred ms on the first boost of a session.
 */
export async function prewarm(currentUser) {
  if (isReady()) return true
  // NWC's unlock decrypts the stored URI *via the signer*. For a NIP-07
  // session that decrypt is a window.nostr.nip04/44 call — an extension
  // round-trip with no user gesture behind it, the exact page-load
  // anti-pattern this function exists to avoid (a stalled call occupies
  // the extension's single request pipe and the first real tap queues
  // behind it). Defer it: getStatus() reports the blob as `remembered`
  // so the identity dot stays lit, and the first boost tap runs the
  // unlock through ensureReady() with a real gesture behind it. Other
  // signer kinds (nsec, NIP-46 bunker) don't touch the extension, so
  // they still warm eagerly.
  if (getNDK()?.signer instanceof NDKNip07Signer) return false
  try {
    if (await nwc.ensureReady(currentUser)) return true
  } catch (e) {
    console.warn('[lb-wallet] nwc prewarm failed', e?.message || e)
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
  // Defensive cleanup for orphaned at-rest state — but only state that
  // belongs to THIS user. An NWC blob saved under a different npub (shared
  // browser, other account) is inert without that user's signer; wiping it
  // here would silently delete their saved wallet. It gets cleared on that
  // account's own next ensureReady/disconnect instead.
  const nwcSnap = nwc.getStatus()
  if (nwcSnap.hasStoredBlob && currentUser?.npub && nwcSnap.ownerNpub === currentUser.npub) {
    nwc.disconnect()
  }
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
