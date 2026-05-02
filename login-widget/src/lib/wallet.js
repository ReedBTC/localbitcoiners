/**
 * Wallet manager — picks between WebLN and NWC adapters and re-exports
 * the unified surface that the rest of the widget consumes.
 *
 * Why a manager instead of importing both directly:
 *   - Consumers (`index.jsx`, BoostModal, EpisodeBoostModal, payAllLegs)
 *     don't need to care which wallet is active. They call
 *     `wallet.isReady()`, `wallet.getClient().payInvoice(...)` and the
 *     active adapter answers.
 *   - Adding a third adapter later (LNC, NIP-47v2, whatever) is a one-
 *     file change here, not a sweep across every modal.
 *
 * Active-adapter selection:
 *   - `lb_wallet_kind` in localStorage holds 'webln' | 'nwc' | (absent).
 *     It's set when the user successfully connects either wallet, and
 *     cleared when they explicitly disconnect.
 *   - "Last connected wins" — if the user has a stale NWC blob from
 *     last week and connects WebLN today, kind flips to 'webln' and
 *     boosts route there. NWC's blob is preserved at rest; the user
 *     can switch back by reconnecting NWC.
 *
 * Notifications:
 *   - Both adapters fire their own `onChange` events. The manager
 *     subscribes to both and re-fans-out to its own subscriber pool
 *     with the *active* adapter's status. UI components only listen
 *     to the manager.
 */

import * as nwc from './nwc.js'
import * as webln from './webln.js'

const KIND_KEY = 'lb_wallet_kind'

function readKind() {
  try {
    const v = localStorage.getItem(KIND_KEY)
    if (v === 'webln' || v === 'nwc') return v
  } catch {}
  return null
}

function writeKind(kind) {
  try {
    if (kind === 'webln' || kind === 'nwc') {
      localStorage.setItem(KIND_KEY, kind)
    } else {
      localStorage.removeItem(KIND_KEY)
    }
  } catch {}
  // Active-adapter selection just changed, so any cached status held by
  // subscribers is stale. The wired adapter notify that ran during
  // connect() fired BEFORE this write, with the old kind, so on its own
  // it produces a "disconnected" emit. Re-emit here so subscribers see
  // the post-write state. Same applies on disconnect (kind cleared).
  notify()
}

function activeAdapter() {
  const kind = readKind()
  if (kind === 'webln') return webln
  if (kind === 'nwc') return nwc
  return null
}

const listeners = new Set()
function notify() {
  const status = getStatus()
  for (const fn of listeners) {
    try { fn(status) } catch {}
  }
}

// Wire fan-out: any state change in either adapter triggers a manager
// notification. Listeners installed once at module load — both adapters'
// listener sets live for the page lifetime, so unsubscribing here is
// unnecessary and would just complicate teardown.
nwc.onChange(notify)
webln.onChange(notify)

/** Subscribe to wallet state changes. Returns an unsubscribe fn. */
export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Active adapter's status, with a guaranteed `kind` field. When no
 * adapter is active, returns `{ connected: false, kind: null }` — the
 * shape IdentityDropdown's wallet section expects to render its
 * "Not connected" branch.
 */
export function getStatus() {
  const adapter = activeAdapter()
  if (!adapter) return { connected: false, kind: null }
  return adapter.getStatus()
}

/** Sync ready check. False when no adapter is active. */
export function isReady() {
  const adapter = activeAdapter()
  return !!adapter && adapter.isReady()
}

/**
 * Returns the active adapter's payment client. Throws if no adapter
 * active or active adapter is not ready. Same shape both adapters
 * already implement: `{ payInvoice: async ({invoice}) => {preimage} }`.
 */
export function getClient() {
  const adapter = activeAdapter()
  if (!adapter) throw new Error('No wallet connected')
  return adapter.getClient()
}

/**
 * Re-establish the active adapter's session. WebLN: silent enable for
 * authorized origins. NWC: decrypts the stored blob and probes
 * getBalance. Returns boolean — true if the adapter is ready after
 * the call.
 *
 * Called on login/restore/page-load to pre-warm the wallet so the next
 * boost click pays without paying handshake cost.
 */
export async function ensureReady(currentUser) {
  const kind = readKind()
  if (kind === 'webln') {
    return webln.ensureReady()
  }
  if (kind === 'nwc') {
    return nwc.ensureReady(currentUser)
  }
  return false
}

/**
 * Connect a fresh NWC URI. Same params as `nwc.connect`. On success,
 * sets the active kind to 'nwc'. Throws on validation/network failures
 * — caller (WalletConnectModal) surfaces the message.
 */
export async function connectNwc(uri, currentUser) {
  const result = await nwc.connect(uri, currentUser)
  writeKind('nwc')
  // nwc.connect already fired its own notify; the manager's wired
  // listener picks that up and re-fans-out. No explicit notify here.
  return result
}

/**
 * Connect WebLN — pops the extension permission prompt on first use,
 * silent on previously-authorized origins. On success, sets active kind
 * to 'webln'. Caller must invoke from a user-gesture handler so the
 * permission prompt is allowed.
 */
export async function connectWebln() {
  const result = await webln.connect()
  writeKind('webln')
  return result
}

/**
 * Whether the WebLN UI should render at all. The connect modal hides
 * the WebLN button entirely when this returns false — no disabled state,
 * no install nudge.
 */
export function isWeblnAvailable() {
  return webln.isAvailable()
}

/**
 * Disconnect the active wallet. WebLN: drops in-memory enabled state
 * (extension grant itself stays — only the user's extension settings
 * can fully revoke). NWC: closes the client and wipes the encrypted
 * blob.
 *
 * Clears `lb_wallet_kind` either way. Next boost click will route to
 * "no wallet connected" until the user picks one again.
 */
export function disconnect() {
  const adapter = activeAdapter()
  if (adapter) adapter.disconnect()
  writeKind(null)
  // Each adapter's disconnect already fired notify; manager fan-out
  // picks that up. notify() here would just double-emit.
}

/**
 * Logout teardown. NWC's `lockOnLogout` preserves the encrypted blob
 * for the next sign-in as the same npub; WebLN drops in-memory state
 * (no equivalent persistent grant under the user's Nostr identity).
 *
 * We deliberately DON'T clear `lb_wallet_kind`: a user who logs back
 * in as the same npub gets their previously-active wallet back, which
 * matches today's NWC-only behavior of "blob unlocks again on the
 * matching account."
 */
export function lockOnLogout() {
  nwc.lockOnLogout()
  webln.lockOnLogout()
}

/** The currently-selected wallet kind, or null if none. Useful for
 *  consumers (e.g. the LBLogin API) that want to expose this to host
 *  pages without leaking the manager internals. */
export function getKind() {
  return readKind()
}
