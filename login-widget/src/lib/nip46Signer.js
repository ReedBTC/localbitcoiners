import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { decrypt as nip04Decrypt } from 'nostr-tools/nip04'
import { decrypt as nip44Decrypt, getConversationKey } from 'nostr-tools/nip44'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

// Diagnostic logger. Always-on info-level logs prefixed with [lb-nostr]
// so when a user reports "login stuck on mobile" we can ask them to
// paste DevTools console output and see exactly which step failed.
// `console.info` is verbose enough to not clutter the default console
// view but visible when filtering by "info" or paste-debugging.
function dlog(...args) {
  try { console.info('[lb-nostr]', ...args) } catch {}
}

// Thin NDK-compatible wrapper around nostr-tools' BunkerSigner. NDK's own
// NIP-46 implementation (v2.18) diverges from the spec in enough places
// (missing `authors` filter, nip04/nip44 auto-flip, silent encryption choice,
// no `switch_relays`, hex-pubkey constructor routing through nip05Init,
// blockUntilReady promise that can never resolve) that reference clients
// like Coracle/welshman and nostr-login have each written their own. We do
// the same but stand on nostr-tools so the correctness of the underlying
// handshake comes from the library every other canonical Nostr app already
// shares.
//
// Contract NDK's event.sign() relies on (index.d.ts NDKSigner):
//   - get pubkey(): synchronous hex string
//   - blockUntilReady(): Promise<NDKUser>
//   - user(): Promise<NDKUser>
//   - get userSync(): NDKUser
//   - sign(nostrEvent): Promise<string>  — returns the sig
//   - encrypt(recipient, value, scheme): Promise<string>
//   - decrypt(sender, value, scheme): Promise<string>
//   - toPayload(): string
// We provide all of them.

export class Nip46BunkerSigner {
  // clientSecretKey is Uint8Array; bunkerSigner is a nostr-tools BunkerSigner
  // already wired to the bunker (fromBunker or fromURI). userPubkey is the
  // *authoritative* hex pubkey the bunker signs with — it MUST match, or
  // NDK will compute event.id with a different pubkey than the bunker used
  // and the sig will fail to verify.
  constructor({ ndk, bunkerSigner, clientSecretKey, userPubkey, bunkerPointer }) {
    this._ndk = ndk
    this._bs = bunkerSigner
    this._clientSecretKey = clientSecretKey
    this._userPubkey = userPubkey
    this._bp = bunkerPointer
    this._user = ndk.getUser({ pubkey: userPubkey })
  }

  get pubkey() { return this._userPubkey }

  get userSync() { return this._user }

  get bunkerPointer() { return this._bp }

  async user() { return this._user }

  // The user is already connected by the time this wrapper is constructed
  // (LoginScreen awaits connect()/getPublicKey()), so blockUntilReady just
  // returns the user. Keeping the method for NDK interface compatibility.
  async blockUntilReady() { return this._user }

  // NDK's flow: toNostrEvent() sets event.pubkey = this._userPubkey, then
  // calls signer.sign(event). We hand the full event template to the bunker.
  // The bunker signs it and returns {id, pubkey, sig, ...}. We verify the
  // bunker signed as whom we expected (defence against a bunker that silently
  // switched accounts) and return just the sig.
  async sign(nostrEvent) {
    const signed = await this._bs.signEvent({
      kind: nostrEvent.kind,
      content: nostrEvent.content ?? '',
      tags: nostrEvent.tags ?? [],
      created_at: nostrEvent.created_at ?? Math.floor(Date.now() / 1000),
    })
    if (signed.pubkey !== this._userPubkey) {
      throw new Error(
        `bunker signed as ${signed.pubkey.slice(0, 8)}… but session expects ${this._userPubkey.slice(0, 8)}… — re-login`
      )
    }
    return signed.sig
  }

  async encryptionEnabled(scheme) {
    if (!scheme) return ['nip04', 'nip44']
    return [scheme]
  }

  async encrypt(recipient, value, scheme = 'nip04') {
    const pk = recipient?.pubkey || recipient
    if (scheme === 'nip44') return this._bs.nip44Encrypt(pk, value)
    return this._bs.nip04Encrypt(pk, value)
  }

  async decrypt(sender, value, scheme = 'nip04') {
    const pk = sender?.pubkey || sender
    if (scheme === 'nip44') return this._bs.nip44Decrypt(pk, value)
    return this._bs.nip04Decrypt(pk, value)
  }

  // Serialization format is our own — sessionPersistence writes/reads its
  // own record shape, not this one. Kept so NDK introspection doesn't crash.
  toPayload() {
    return JSON.stringify({
      type: 'nip46',
      payload: JSON.stringify({
        clientSecret: bytesToHex(this._clientSecretKey),
        bunkerPointer: this._bp,
        userPubkey: this._userPubkey,
      }),
    })
  }

  // resetNDK() calls signer.stop() if present — mirror that convention so
  // logout tears down the bunker's relay subscription promptly.
  stop() {
    try { this._bs.close() } catch {}
  }

  async close() {
    try { await this._bs.close() } catch {}
  }
}

// ── Factories ─────────────────────────────────────────────────────────────

// bunker:// paste path. Client generates a fresh local secret (or reuses
// one the caller passes in, to keep saved-session identity consistent),
// parses the pointer out of the URL, and drives connect(). onAuthUrl is
// called when the bunker responds with `result: "auth_url"` — the UI shows
// the URL so the user can tap to approve.
//
// `onStage` (optional) reports flow position to the caller so the UI can
// show a stage label that distinguishes "waiting on connect approval"
// from "waiting on get_public_key approval" — Amber on Android often
// prompts for both separately, and a "Connecting…" generic spinner
// hides the second prompt from the user.
export async function connectViaBunkerUrl({ ndk, bunkerUrl, clientSecretKey, onAuthUrl, onStage, timeoutMs = 30000 }) {
  dlog('connectViaBunkerUrl: parsing input')
  const bp = await parseBunkerInput(bunkerUrl)
  if (!bp) throw new Error('Invalid bunker:// URL.')
  if (!bp.relays?.length) throw new Error('bunker:// URL has no relays.')
  dlog('parsed bunker pointer', { pubkey: bp.pubkey.slice(0, 8) + '…', relays: bp.relays })

  const csk = clientSecretKey || generateSecretKey()
  const bs = BunkerSigner.fromBunker(csk, bp, {
    onauth: (url) => {
      dlog('onauth fired (bunker requested approval URL)')
      try { onAuthUrl?.(url) } catch {}
    },
  })

  // Drive the handshake with our own timeout so a silent bunker doesn't
  // hang the login screen forever. auth_url is fired via onauth mid-wait;
  // the UI is free to extend its own grace period based on that signal.
  try { onStage?.('connect') } catch {}
  dlog('calling bs.connect()…')
  await withTimeout(bs.connect(), timeoutMs, 'Bunker did not acknowledge connect.')
  dlog('bs.connect() resolved (ack received)')

  // No switch_relays call: the URL's relays are authoritative, and Primal's
  // bunker has been observed to ignore/stall the RPC. Matches the
  // nostrconnect path for consistency.

  // get_public_key is authoritative. The bunker's own signing pubkey
  // (bp.pubkey) may differ from the user's pubkey (Amber / nsec.app).
  // Bumped to 60s minimum here — even with caller-supplied longer
  // timeouts (180s for mobile-fumble headroom) we want a clear stage
  // signal to the UI so the user knows we're past connect and onto a
  // potentially-second prompt for read-pubkey permission.
  try { onStage?.('get_public_key') } catch {}
  dlog('calling bs.getPublicKey()… (Amber may prompt a second time for read-pubkey permission)')
  const userPubkey = await withTimeout(
    bs.getPublicKey(),
    timeoutMs,
    'Bunker did not return the user pubkey.'
  )
  dlog('bs.getPublicKey() resolved', { userPubkey: userPubkey.slice(0, 8) + '…' })

  return new Nip46BunkerSigner({
    ndk,
    bunkerSigner: bs,
    clientSecretKey: csk,
    userPubkey,
    bunkerPointer: { pubkey: bp.pubkey, relays: bp.relays, secret: bp.secret },
  })
}

// Restore path. Re-use the saved clientSecret + bunkerPointer so the bunker
// recognizes us without the user re-approving. Skip connect() — if the
// bunker has since expired the session it will say so on the first sign()
// call, which is the right place to surface that failure anyway (every
// reference client does it this way; replaying connect on restore is what
// was causing our prior hangs).
export function restoreFromSession({ ndk, clientSecret, bunkerPointer, userPubkey, onAuthUrl }) {
  const clientSecretKey = hexToBytes(clientSecret)
  const bs = BunkerSigner.fromBunker(clientSecretKey, bunkerPointer, {
    onauth: (url) => { try { onAuthUrl?.(url) } catch {} },
  })
  return new Nip46BunkerSigner({
    ndk,
    bunkerSigner: bs,
    clientSecretKey,
    userPubkey,
    bunkerPointer,
  })
}

// nostrconnect:// path. Client publishes the URI (QR/deeplink), bunker
// initiates by sending a kind 24133 event to our client pubkey.
//
// We implement our own subscribe-and-wait instead of nostr-tools'
// BunkerSigner.fromURI because fromURI only handles NIP-44 decryption and
// only accepts `result === secret`. Real bunkers in the wild also send
// NIP-04 (Primal/Amber historically) and also reply with `result === "ack"`
// (older spec, still widely emitted) — both of which would be silently
// ignored. nostr-login solves this the same way we do (see reference
// implementation /tmp/nl-nip46.ts `parseNostrConnectReply` and `listen`).
export async function connectViaNostrConnectUri({ ndk, connectionUri, clientSecretKey, onAuthUrl, signal, resubscribeBus, timeoutMs = 300000 }) {
  const uri = new URL(connectionUri)
  const relays = uri.searchParams.getAll('relay')
  const secret = uri.searchParams.get('secret')
  if (!relays.length) throw new Error('nostrconnect URI missing relay.')
  if (!secret) throw new Error('nostrconnect URI missing secret.')
  const clientPubkey = getPublicKey(clientSecretKey)
  dlog('connectViaNostrConnectUri: waiting for bunker reply', { relays, clientPubkey: clientPubkey.slice(0, 8) + '…' })

  // Wait for the bunker's first valid reply. It comes as a kind 24133 event
  // addressed to #p=clientPubkey. Bunkers use any of three patterns:
  //   1. RESPONSE with `result === secret`  (newer spec)
  //   2. RESPONSE with `result === "ack"`   (older spec, Amber/nsec.app)
  //   3. REQUEST  with method === "connect" and secret somewhere in params
  //      (Primal has historically used this — bunker "initiates" by sending
  //       a connect RPC call TO the client with the secret).
  // Also handle `result === "auth_url"` as a mid-handshake approval prompt
  // that does NOT complete the handshake — the real ack comes after.
  //
  // `resubscribeBus` (optional EventTarget) lets the caller force a fresh
  // pool + subscription on demand — used on mobile when the tab returns
  // from the background and the WebSocket may have been killed by the OS.
  // NIP-46 uses kind 24133 which is ephemeral (relays MUST NOT retain it),
  // so a missed reply during a backgrounded tab is irrecoverable from the
  // relay side; we can only ensure that when the user comes back, our
  // subscription is fresh and ready for any retry the bunker might do.
  let pool
  let sub
  const filter = { kinds: [24133], '#p': [clientPubkey] }

  const bunkerPubkey = await new Promise((resolve, reject) => {
    let settled = false
    function teardownPoolAndSub() {
      try { sub?.close() } catch {}
      try { pool?.close(relays) } catch {}
      sub = null
      pool = null
    }
    const cleanup = () => {
      teardownPoolAndSub()
      if (signal) signal.removeEventListener('abort', onAbort)
      if (resubscribeBus) resubscribeBus.removeEventListener('resubscribe', onResubscribe)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Signer did not respond to nostrconnect request.'))
    }, timeoutMs)

    function onevent(event) {
      if (settled) return
      dlog('got event', { from: event.pubkey.slice(0, 8) + '…', kind: event.kind })
      const plaintext = decryptNip46Content(clientSecretKey, event.pubkey, event.content)
      if (!plaintext) {
        dlog('decrypt failed for event from', event.pubkey.slice(0, 8) + '…')
        return
      }
      let parsed
      try { parsed = JSON.parse(plaintext) } catch { dlog('json parse failed'); return }
      const { method, params, result, error } = parsed
      dlog('decrypted', { method, result, hasError: !!error })

      if (result === 'auth_url') {
        try { onAuthUrl?.(error) } catch {}
        return
      }

      if (result === secret || result === 'ack') {
        dlog('handshake matched (result)', { resultKind: result === 'ack' ? 'ack' : 'secret' })
        settled = true
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (resubscribeBus) resubscribeBus.removeEventListener('resubscribe', onResubscribe)
        try { sub?.close() } catch {}
        resolve(event.pubkey)
        return
      }

      if (method === 'connect' && Array.isArray(params)) {
        if (params.includes(secret)) {
          dlog('handshake matched (connect-method with secret in params)')
          settled = true
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          if (resubscribeBus) resubscribeBus.removeEventListener('resubscribe', onResubscribe)
          try { sub?.close() } catch {}
          resolve(event.pubkey)
          return
        }
      }

      if (error && !result) {
        dlog('bunker refused', { error })
        settled = true
        clearTimeout(timer)
        cleanup()
        reject(new Error(`Bunker refused: ${error}`))
      }
    }

    function buildPoolAndSub() {
      pool = new SimplePool()
      sub = pool.subscribeMany(relays, filter, { onevent })
      dlog('subscription open', { relays })
    }

    // Resubscribe handler — called when the caller signals that the
    // existing connection may be stale (e.g. tab returned from background
    // on mobile). Tear down the current pool/sub completely and rebuild
    // from scratch. Doesn't reset the timeout — the user's overall
    // patience window stays intact.
    function onResubscribe() {
      if (settled) return
      dlog('resubscribing (tab returned from background)')
      teardownPoolAndSub()
      buildPoolAndSub()
    }

    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort)
    }
    if (resubscribeBus) {
      resubscribeBus.addEventListener('resubscribe', onResubscribe)
    }

    buildPoolAndSub()
  })

  // The wait-for-reply pool is only for the handshake; BunkerSigner below
  // opens its own. Close ours to release the relay sockets.
  try { pool?.close(relays) } catch {}

  // Now construct the real bunker signer with the handshake pubkey we just
  // learned, and drive get_public_key per spec.
  const bp = { pubkey: bunkerPubkey, relays, secret }
  const bs = BunkerSigner.fromBunker(clientSecretKey, bp, {
    onauth: (url) => { try { onAuthUrl?.(url) } catch {} },
  })

  // Skip switch_relays on the nostrconnect path: Primal's bunker has been
  // observed to ignore it entirely, and a silent 3-second stall before the
  // get_public_key RPC compounded with `authors`-filtered subscription
  // latency has been making login feel stuck. The original relays work fine.

  // 30s ceiling (was 15) for the get_public_key round-trip. After the
  // connect handshake completes, BunkerSigner opens a *fresh* pool and
  // sends a get_public_key RPC. On mobile this can be slow for two
  // reasons: (1) the new pool's WebSockets need to handshake from
  // scratch, and (2) some bunkers (notably Amber on Android) require
  // a second approval for the get_public_key permission scope —
  // which means another tab switch and another user gesture before
  // the response is published. 15s was tight; 30s gives the user
  // headroom without making well-behaved bunkers feel slow.
  dlog('handshake done; calling get_public_key')
  const userPubkey = await withTimeout(
    bs.getPublicKey(),
    30000,
    'Bunker did not return the user pubkey.'
  )
  dlog('get_public_key returned', { userPubkey: userPubkey.slice(0, 8) + '…' })

  return new Nip46BunkerSigner({
    ndk,
    bunkerSigner: bs,
    clientSecretKey,
    userPubkey,
    bunkerPointer: { pubkey: bs.bp.pubkey, relays: bs.bp.relays, secret: bs.bp.secret },
  })
}

// NIP-04 ciphertext is `<base64>?iv=<base64>`; NIP-44 is plain base64 whose
// first decoded byte is version 2. Detection by suffix match is cheap and
// matches the convention in nostr-login's own dispatcher.
function decryptNip46Content(clientSecretKey, remotePubkey, content) {
  if (!content) return null
  const looksNip04 = isNip04Ciphertext(content)
  // Try the detected scheme first, fall through to the other if it fails —
  // some bunkers flip halfway through sessions and the `?iv=` heuristic is
  // not perfect (e.g. some NIP-44 ciphertexts could coincidentally end that
  // way, though very rare).
  const order = looksNip04 ? ['nip04', 'nip44'] : ['nip44', 'nip04']
  for (const scheme of order) {
    try {
      if (scheme === 'nip04') {
        return nip04Decrypt(clientSecretKey, remotePubkey, content)
      } else {
        const convKey = getConversationKey(clientSecretKey, remotePubkey)
        return nip44Decrypt(content, convKey)
      }
    } catch (err) {
      // try the other scheme
    }
  }
  return null
}

function isNip04Ciphertext(s) {
  const n = s.length
  if (n < 28) return false
  return s[n - 28] === '?' && s[n - 27] === 'i' && s[n - 26] === 'v' && s[n - 25] === '='
}

// Helpers re-exported so callers don't need to reach into nostr-tools.
export { generateSecretKey, getPublicKey, parseBunkerInput }
export { bytesToHex, hexToBytes }

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `timeout after ${ms}ms`)), ms)
    }),
  ])
}
