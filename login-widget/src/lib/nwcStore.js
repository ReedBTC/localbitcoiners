/**
 * Persistence + lifecycle for the user's Nostr Wallet Connect (NIP-47)
 * connection URI.
 *
 * The URI itself (nostr+walletconnect://<wallet-pubkey>?relay=...&secret=...)
 * is a bearer credential — anyone holding it can spend up to the budget
 * the user authorized when issuing the connection. So we never write the
 * raw URI to localStorage. Instead we encrypt it *to the user themselves*
 * via NIP-44 (NIP-04 fallback) using whatever signer they're logged in
 * with, and store only the ciphertext + the npub it was encrypted to.
 *
 * Properties of this scheme:
 *   - Encrypted blob is useless without the signer. A malicious browser
 *     extension that exfiltrates localStorage gets ciphertext only.
 *   - When the user logs out the signer drops; the blob becomes inert
 *     until they log back in as the same npub.
 *   - When the user logs in as a different npub, the old blob can't be
 *     decrypted (different key); the connect UI surfaces a "reconnect"
 *     prompt and the blob is overwritten.
 *
 * Storage shape:
 *   localStorage["lb_nwc_v1"] = JSON.stringify({
 *     ciphertext: "<scheme-prefixed encrypted NWC URI>",
 *     ownerNpub: "npub1...",
 *     savedAt: 1714329600000,
 *   })
 */

import { pushToast } from './toast.js'

const STORAGE_KEY = 'lb_nwc_v1'

/**
 * Read the encrypted NWC record from localStorage, or null if none.
 * Caller is responsible for decryption — this just returns the at-rest
 * envelope plus the owner npub so the UI can decide whether to attempt
 * decrypt or prompt for re-connect.
 */
export function loadEncrypted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.ciphertext !== 'string' || typeof parsed?.ownerNpub !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist an already-encrypted NWC URI alongside the npub it was
 * encrypted to. ownerNpub is needed because (a) the UI can show "this
 * NWC is connected to <npub>" without decrypting, and (b) on login as a
 * different account we can detect and clear the stale blob.
 */
export function saveEncrypted({ ciphertext, ownerNpub }) {
  if (typeof ciphertext !== 'string' || !ciphertext) return
  if (typeof ownerNpub !== 'string' || !ownerNpub.startsWith('npub1')) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ciphertext,
      ownerNpub,
      savedAt: Date.now(),
    }))
  } catch (e) {
    // Surface storage failures to the user — silent quota-exceeded
    // would let them think their wallet is connected when it isn't,
    // and they'd find out next page load when the unlock prompt
    // never appears. Common in Safari Private Mode and embedded
    // webviews with tiny quota.
    if (e?.name === 'QuotaExceededError' || /quota/i.test(String(e?.message || ''))) {
      try {
        pushToast({
          kind: 'error',
          message: 'Browser storage is full — wallet won\'t persist across reloads. Free up storage and reconnect to fix.',
        })
      } catch {}
    }
  }
}

/** Wipe the at-rest NWC blob. Called on disconnect or wrong-account. */
export function clearEncrypted() {
  try { localStorage.removeItem(STORAGE_KEY) } catch {}
}
