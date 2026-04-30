/**
 * Nostr Wallet Connect (NIP-47) client lifecycle for the widget.
 *
 * Responsibilities:
 *   - Hold a single NWCClient instance per session, lazily decrypted
 *     from the localStorage blob on first use.
 *   - Validate a freshly-pasted URI before persisting (round-trip
 *     getInfo/getBalance so we don't save an unreachable connection).
 *   - Encrypt-to-self before persisting; never write the raw URI to
 *     storage.
 *   - Surface a small subscriber API so the widget UI can react to
 *     connect / disconnect events without polling.
 *
 * Public functions are async because every operation either touches the
 * signer (encrypt/decrypt) or the wallet relay (getInfo/payInvoice).
 */

import { NWCClient } from '@getalby/sdk'
import { nip19 } from 'nostr-tools'
import { encryptForSelf, decryptFromSelf } from './selfEncrypt.js'
import {
  loadEncrypted,
  saveEncrypted,
  clearEncrypted,
} from './nwcStore.js'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'

// In-memory client + the npub it belongs to. Reset on logout or wrong
// account. We hold the NWCClient instead of the URI so once it's open
// we don't keep round-tripping through the signer for every payment.
let activeClient = null
let activeOwnerNpub = null
let activeWalletAlias = null  // optional, from getInfo()

const listeners = new Set()
function notify() {
  const status = getStatus()
  for (const fn of listeners) {
    try { fn(status) } catch {}
  }
}

/** Subscribe to connect/disconnect events. Returns an unsubscribe fn. */
export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Snapshot of NWC state. Three shapes:
 *   { connected: false, hasStoredBlob: false }                          // never connected
 *   { connected: false, hasStoredBlob: true, ownerNpub }                // blob exists but not unlocked yet
 *   { connected: true, ownerNpub, alias? }                              // ready to pay
 */
export function getStatus() {
  if (activeClient && activeOwnerNpub) {
    return { connected: true, ownerNpub: activeOwnerNpub, alias: activeWalletAlias || null }
  }
  const blob = loadEncrypted()
  if (!blob) return { connected: false, hasStoredBlob: false }
  return { connected: false, hasStoredBlob: true, ownerNpub: blob.ownerNpub }
}

/** Quick sync check used by the boost button to decide whether to
 *  show "boost" vs "connect wallet first". */
export function isReady() {
  return !!(activeClient && activeOwnerNpub)
}

/** The unwrapped client. Throws if not unlocked — call ensureReady() first. */
export function getClient() {
  if (!activeClient) throw new Error('NWC not connected')
  return activeClient
}

/**
 * Validate a freshly-pasted NWC URI by opening a client and round-tripping
 * a getBalance call. Returns the ready client + alias on success; throws
 * on any failure (relay unreachable, bad secret, wallet rejects, timeout).
 *
 * Caller MUST close the resulting client if they don't intend to use it
 * (e.g. user clicked Cancel after validation succeeded). Otherwise pass
 * to commitConnection() to persist + activate.
 */
async function probe(nwcUri) {
  const client = new NWCClient({ nostrWalletConnectUrl: nwcUri })
  // getBalance is the cheapest method that covers connectivity + auth.
  // 12s budget — wallet relay handshake plus signer round-trip on the
  // wallet's side; mobile wallets in the background can take a moment.
  try {
    await withTimeout(
      client.getBalance(),
      12000,
      'Wallet didn\'t respond within 12 seconds. Is your wallet online?',
    )
  } catch (e) {
    try { client.close() } catch {}
    throw e
  }
  // Best-effort alias lookup (some wallets don't implement get_info).
  let alias = null
  try {
    const info = await withTimeout(client.getInfo(), 6000, 'info-timeout')
    if (info && typeof info.alias === 'string') alias = info.alias
  } catch {}
  return { client, alias }
}

/**
 * Connect a fresh NWC URI.
 *   1. Probe the URI to confirm it works.
 *   2. Encrypt it to the current logged-in user via the NDK signer.
 *   3. Persist the ciphertext + activate the in-memory client.
 *
 * Throws if no Nostr session is active (NWC requires a signer to
 * encrypt to). Throws if the URI is malformed or unreachable.
 */
export async function connect(nwcUri, currentUser) {
  if (!currentUser?.pubkey) {
    throw new Error('Sign in with Nostr first — your wallet connection is encrypted with your account.')
  }
  if (typeof nwcUri !== 'string' || !nwcUri.startsWith('nostr+walletconnect://')) {
    throw new Error('That doesn\'t look like a NWC connection string. It should start with nostr+walletconnect://')
  }

  const { client, alias } = await probe(nwcUri)

  const ndk = getNDK()
  if (!ndk?.signer) {
    try { client.close() } catch {}
    throw new Error('Signer unavailable — please re-log-in.')
  }

  // Same 8 s bound as ensureReady's decrypt path. Remote signers can
  // hang on NIP-44 encrypt the same way they hang on decrypt; a fresh
  // connect shouldn't trap the user any longer than a re-unlock would.
  let ciphertext
  try {
    ciphertext = await withTimeout(
      encryptForSelf(ndk.signer, ndk.getUser({ pubkey: currentUser.pubkey }), nwcUri),
      8000,
      'Your signer didn\'t respond. If you use a remote signer (bunker/Amber), check that it\'s online and try again.',
    )
  } catch (e) {
    // Log full error for debugging; surface a generic message to the
    // user. SDK / bunker errors can include relay URLs and internal
    // event ids that aren't useful in a UI string.
    console.warn('[lb-nwc] encrypt failed', e?.message || e)
    try { client.close() } catch {}
    if (/timeout/i.test(String(e?.message || ''))) {
      throw new Error('Your signer didn\'t respond. Check that your bunker / signer app is online and try again.')
    }
    throw new Error('Couldn\'t secure your wallet connection. Check that your signer is responsive and try again.')
  }

  const ownerNpub = currentUser.npub || nip19.npubEncode(currentUser.pubkey)
  saveEncrypted({ ciphertext, ownerNpub })

  activeClient = client
  activeOwnerNpub = ownerNpub
  activeWalletAlias = alias
  notify()
  return { alias }
}

/**
 * If a stored blob exists and matches the current user, decrypt + open
 * the client. Idempotent — if already connected, no-op. If the blob is
 * for a different account, clears it and returns false so the UI can
 * prompt re-connect.
 *
 * Returns true on success, false on "not connected and not unlockable".
 * Throws only on transient errors the user can retry (signer rejected,
 * relay unreachable).
 */
export async function ensureReady(currentUser) {
  if (activeClient) return true
  if (!currentUser?.pubkey) return false

  const blob = loadEncrypted()
  if (!blob) return false

  const currentNpub = currentUser.npub || nip19.npubEncode(currentUser.pubkey)
  if (blob.ownerNpub !== currentNpub) {
    // Different account than the one this NWC was saved under. Clear it
    // and force a re-connect — they may have used a different wallet
    // last time, or this is a shared browser.
    clearEncrypted()
    return false
  }

  const ndk = getNDK()
  if (!ndk?.signer) return false

  // Some signers (notably remote bunkers with broken relay sets and
  // older extension builds) silently hang on NIP-44 / NIP-04 decrypt
  // instead of surfacing a rejection. Bound the call so the modal
  // can't get stuck on "Unlocking wallet…" forever. 8 s is plenty for
  // a healthy signer round-trip; anything longer and the signer is
  // effectively broken and we shouldn't wait further.
  //
  // On timeout we wipe the encrypted blob — keeping it would just
  // make the next modal open hit the same wall. The user falls
  // through to the connect form and can paste a fresh URI; if their
  // signer is still broken, encrypt-self will hit a similar timeout
  // there with the same clear error.
  console.info('[lb-nwc] ensureReady: decrypting blob…')
  let nwcUri
  try {
    nwcUri = await withTimeout(
      decryptFromSelf(
        ndk.signer,
        ndk.getUser({ pubkey: currentUser.pubkey }),
        blob.ciphertext,
      ),
      8000,
      'Your signer didn\'t respond. If you use a remote signer (bunker/Amber), check that it\'s online and try again.',
    )
    console.info('[lb-nwc] ensureReady: decrypt ok')
  } catch (e) {
    console.warn('[lb-nwc] ensureReady: decrypt failed', e?.message || e)
    // Don't auto-clear the blob — the failure may be transient (signer
    // app momentarily backgrounded, relay blip). The modal surfaces a
    // generic error and shows a "Reset saved wallet" option if the
    // user wants to wipe and start fresh. Original error logged above.
    if (/timeout/i.test(String(e?.message || ''))) {
      throw new Error('Your signer didn\'t respond. Check that your bunker / signer app is online and try again.')
    }
    throw new Error('Couldn\'t unlock your wallet connection. Reconnect to keep boosting.')
  }

  const client = new NWCClient({ nostrWalletConnectUrl: nwcUri })
  // Verify the connection is still alive — wallet may have revoked the
  // budget, the relay may have rotated, etc. Cheap getBalance round-trip.
  console.info('[lb-nwc] ensureReady: probing getBalance…')
  try {
    await withTimeout(client.getBalance(), 8000, 'wallet-unreachable')
    console.info('[lb-nwc] ensureReady: getBalance ok')
  } catch (e) {
    console.warn('[lb-nwc] ensureReady: getBalance failed', e?.message || e)
    try { client.close() } catch {}
    throw new Error('Saved wallet connection is no longer reachable. Reconnect to keep boosting.')
  }

  activeClient = client
  activeOwnerNpub = currentNpub
  // Best-effort alias refresh.
  try {
    const info = await withTimeout(client.getInfo(), 5000, 'info-timeout')
    activeWalletAlias = info?.alias || null
  } catch {
    activeWalletAlias = null
  }
  console.info('[lb-nwc] ensureReady: connected')
  notify()
  return true
}

/** Tear down the live client and clear the at-rest blob. */
export function disconnect() {
  if (activeClient) {
    try { activeClient.close() } catch {}
  }
  activeClient = null
  activeOwnerNpub = null
  activeWalletAlias = null
  clearEncrypted()
  notify()
}

/**
 * Soft-reset on logout: drop the in-memory client without wiping the
 * stored blob. Next login as the same npub will unlock it again.
 */
export function lockOnLogout() {
  if (activeClient) {
    try { activeClient.close() } catch {}
  }
  activeClient = null
  activeOwnerNpub = null
  activeWalletAlias = null
  notify()
}
