import NDK from '@nostr-dev-kit/ndk'
import { withTimeout } from './utils.js'

// NDK's explicit pool. Two jobs: IDENTITY READS (the signed-in user's kind 0
// and kind 10002) and, because a bare `ev.publish()` goes to the pool, the base
// set that user-authored notes publish to alongside the user's own write relays
// that ensureUserWriteRelays adds below.
//
// Measured 2026-08-12 over the 92 distinct booster pubkeys behind the boost
// megathread — kind 0 / kind 10002:
//     nos.lol            92% / 84%
//     relay.ditto.pub    89% / 50%
//     nostr.mom          79% / 62%
//     relay.damus.io     71% / 45%
//     purplepag.es       41% / 35%
//     relay.primal.net   12% /  7%
//
// relay.primal.net is out at 12% / 7%. That is the RELAY; cache1.primal.net is
// a different service, is what the Primal client actually reads, and is queried
// elsewhere in the site untouched by this list. relay.fountain.fm is
// deliberately absent despite being the best relay we have for kind 1: it
// answered 0% for both kinds this pool reads.
export const FALLBACK_RELAYS = [
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://nostr.mom',
]

// NDK's outbox pool — a SECOND pool, separate from explicitRelayUrls, that it
// opens on its own to resolve a user's kind-10002 before publishing to their
// write relays.
//
// ⚠️ Left unset this falls back to NDK's own hardcoded
// `DEFAULT_OUTBOX_RELAYS = ["wss://purplepag.es/", "wss://nos.lol/"]`
// (@nostr-dev-kit/ndk 2.18.1), and the outbox model is ON unless
// `enableOutboxModel: false` is passed. That is why removing a relay from the
// lists in this repo is not on its own enough to stop the browser dialing it:
// purplepag.es survives the sweep inside the library rather than in our source.
// Naming the pair here is what actually retires it. Keep this a profile /
// relay-list set; resolving a kind-10002 is its only job.
const OUTBOX_RELAYS = [
  'wss://nos.lol',
  'wss://relay.ditto.pub',
]

let ndkInstance = null

export function getNDK() {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: FALLBACK_RELAYS,
      outboxRelayUrls: OUTBOX_RELAYS,
    })
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
