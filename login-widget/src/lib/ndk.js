import NDK from '@nostr-dev-kit/ndk'
import { withTimeout } from './utils.js'

export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://purplepag.es',
]

let ndkInstance = null

export function getNDK() {
  if (!ndkInstance) {
    ndkInstance = new NDK({ explicitRelayUrls: FALLBACK_RELAYS })
  }
  return ndkInstance
}

// Kick off NDK's relay connections and wait for at least one to be ready.
// Prevents races where login completes before any relay handshake finishes —
// the next fetchEvent/publish would otherwise fail silently on mobile where
// WSS handshakes can take 1–3s each.
export async function connectAndWait(ndk, timeoutMs = 5000) {
  ndk.connect().catch(() => {})
  const start = Date.now()
  while (!ndk.pool.connectedRelays().length && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100))
  }
}

export const SIGN_TIMEOUT_MS = 20000

// Remote signers (NIP-46 / bunker) round-trip the sign request through a
// relay, and the promise can hang indefinitely if the signer app is
// backgrounded or the connection died. Bound every sign call so the UI
// always reaches a terminal state — caller surfaces the message to the user.
export async function signWithTimeout(event, timeoutMs = SIGN_TIMEOUT_MS) {
  let timer
  try {
    await Promise.race([
      event.sign(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          'Signer timed out after 20s. If you\'re using a remote signer (bunker), check the signer app — the request may be waiting for approval, or the connection may have dropped.'
        )), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Add the signed-in user's kind-10002 write relays to NDK's explicit pool.
// This is the outbox model (NIP-65): future kind 1 boost messages should
// publish to relays the user's followers actually read from.
//
// Safe to call multiple times; addExplicitRelay dedupes by URL. No-op if
// the user has no 10002 or the lookup times out.
export async function ensureUserWriteRelays(ndk, pubkey, { timeoutMs = 4000 } = {}) {
  if (!ndk || !pubkey) return []
  try {
    const relayListEvent = await withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      timeoutMs,
    )
    if (!relayListEvent) return []
    const writeRelays = (relayListEvent.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
      // Cap at 16 to bound pool size. A user's 10002 with hundreds of
      // entries (poisoned or pathological) would otherwise flood the
      // pool with sockets we never close. NIP-65 reference implementations
      // typically cap around this number too.
      .slice(0, 16)
      // Reject userinfo-bearing URLs — same hygiene as
      // sessionPersistence.sanitizeRelayUrls.
      .filter(u => {
        try {
          const parsed = new URL(u)
          return !parsed.username && !parsed.password
        } catch { return false }
      })
    for (const url of writeRelays) {
      try { ndk.addExplicitRelay(url) } catch {}
    }
    return writeRelays
  } catch {
    return []
  }
}

// Tear down relays + signer and force a fresh NDK on next login.
export function resetNDK() {
  if (ndkInstance) {
    try {
      if (ndkInstance.signer?.stop) ndkInstance.signer.stop()
      ndkInstance.signer = undefined
      for (const relay of ndkInstance.pool?.relays?.values() || []) {
        relay.disconnect()
      }
    } catch {}
  }
  ndkInstance = null
}
