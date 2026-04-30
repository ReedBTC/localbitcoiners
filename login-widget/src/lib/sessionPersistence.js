import { NDKNip07Signer } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, resetNDK, connectAndWait, ensureUserWriteRelays } from './ndk.js'
import { withTimeout } from './utils.js'
import { restoreFromSession } from './nip46Signer.js'

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)
}

// Persists "who is logged in and how" across reloads. Matches the convention
// every major Nostr client uses: save the handshake material for each login
// method and silently re-auth on page load. The actual credential authority
// (extension, remote signer) enforces session TTL, not us.
//
// Record shape by method:
//   extension — { method, pubkey, npub }
//   nip46     — { method, pubkey, npub, clientSecret, bunkerPointer, userPubkey }
//
// nsec logins are deliberately NOT persisted — the LoginScreen warns the key
// is in-memory only. The site's "no npub-only mode" choice means there is no
// read-only flow: you're either logged in with a usable signer or anonymous.

const SESSION_KEY = 'lb_nostr_session'
// Cached profile snapshot — separate key from the session record so the
// shape of the session can change without invalidating profile cache.
// Used to render the IdentityWidget avatar/name *synchronously* on page
// boot while the real session restore runs in the background, avoiding
// the 1-2s flash of "Sign in" / shimmer on every cross-page navigation.
const PROFILE_KEY = 'lb_nostr_profile_v1'

export function saveSession(record) {
  if (!record?.method || !record?.pubkey) return
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(record)) } catch {}
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.method || !parsed?.pubkey) return null
    return parsed
  } catch {
    return null
  }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch {}
}

/**
 * Persist a snapshot of the user's display profile so the next page
 * load can render the identity widget instantly. Caller passes a
 * plain object — we don't store NDKUser instances or signer state,
 * just the bits the UI reads.
 *
 * Refreshed every time setUser is called with a real user, so it
 * stays current with whatever the relays last returned.
 */
export function saveProfile({ pubkey, npub, displayName, name, image }) {
  if (typeof pubkey !== 'string' || !pubkey) return
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      pubkey,
      npub: typeof npub === 'string' ? npub : '',
      displayName: typeof displayName === 'string' ? displayName : '',
      name: typeof name === 'string' ? name : '',
      image: typeof image === 'string' ? image : '',
      savedAt: Date.now(),
    }))
  } catch {}
}

export function loadCachedProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.pubkey !== 'string' || !parsed.pubkey) return null
    return parsed
  } catch {
    return null
  }
}

export function clearProfile() {
  try { localStorage.removeItem(PROFILE_KEY) } catch {}
}

// Drop nonsense relay URLs before handing them to NDK on restore. wss:// only,
// no whitespace, no userinfo. Same intent as mynostr's sanitizeRelayUrls.
export function sanitizeRelayUrls(urls) {
  if (!Array.isArray(urls)) return []
  const out = []
  for (const u of urls) {
    if (typeof u !== 'string') continue
    const trimmed = u.trim()
    if (!/^wss:\/\//i.test(trimmed)) continue
    if (/\s/.test(trimmed)) continue
    try {
      const parsed = new URL(trimmed)
      if (parsed.username || parsed.password) continue
      out.push(trimmed)
    } catch { continue }
  }
  return out
}

// Hydrate the profile for a user record using NDK's own fetchProfile. The
// header badge displays whatever name + avatar comes back; failure just leaves
// the profile null and the UI falls back to a truncated npub.
export async function fetchUserProfile(ndk, pubkey) {
  const user = ndk.getUser({ pubkey })
  try { await withTimeout(user.fetchProfile(), 5000) } catch {}
  return user
}

async function waitForExtension(maxMs = 2000) {
  if (typeof window === 'undefined') return false
  if (window.nostr) return true
  const start = Date.now()
  while (!window.nostr && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 100))
  }
  return !!window.nostr
}

// Restore a saved session. Tagged result so the caller can tell apart:
//   { kind: 'ok', user }   — success; user is the hydrated NDKUser
//   { kind: 'transient' }  — recoverable hiccup (extension still loading,
//                            relay flake, network); keep the cached stub
//                            and let a later retry escalate
//   { kind: 'permanent' }  — the saved record is unusable as-is (malformed
//                            fields); caller should clearSession + drop
//                            to logged-out
export async function restoreSession(record) {
  if (!record?.method || !isHex64(record?.pubkey)) return { kind: 'permanent' }

  resetNDK()
  const ndk = getNDK()

  if (record.method === 'extension') {
    const ok = await waitForExtension(2000)
    if (!ok) return { kind: 'transient' }
    try {
      // Wire up the signer but DO NOT call blockUntilReady() here.
      // blockUntilReady invokes window.nostr.getPublicKey(), which on most
      // extensions (nos2x, keys.band, Alby with strict mode) triggers a
      // permission prompt — and doing that on every page load both spams
      // the user with prompts and creates a "shimmer until 10s timeout
      // then flip to Sign-in" race when the prompt isn't approved
      // immediately (e.g. cross-page navigation, prompt dismissed, etc).
      //
      // The signer being attached is enough — NDKEvent.sign() will trigger
      // blockUntilReady internally on the first actual sign call, which is
      // the right moment to ask the user to approve. Identity / profile
      // rendering only needs the saved pubkey, not a live signer.
      //
      // Account-change detection moved to verifySignerMatches() — the
      // caller invokes it lazily before the first sign-gated action so
      // we still catch "extension is now signed in as someone else"
      // before signing under the wrong pubkey.
      const signer = new NDKNip07Signer()
      ndk.signer = signer
      await connectAndWait(ndk)
      await ensureUserWriteRelays(ndk, record.pubkey)
      const user = await fetchUserProfile(ndk, record.pubkey)
      return { kind: 'ok', user }
    } catch {
      return { kind: 'transient' }
    }
  }

  if (record.method === 'nip46') {
    const { clientSecret, bunkerPointer, userPubkey } = record
    if (!isHex64(userPubkey)) return { kind: 'permanent' }
    if (typeof clientSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(clientSecret)) return { kind: 'permanent' }
    if (!bunkerPointer || !isHex64(bunkerPointer.pubkey)) return { kind: 'permanent' }
    const safeRelays = sanitizeRelayUrls(bunkerPointer.relays)
    if (safeRelays.length === 0) return { kind: 'permanent' }
    try {
      const signer = restoreFromSession({
        ndk,
        clientSecret,
        bunkerPointer: { ...bunkerPointer, relays: safeRelays },
        userPubkey,
        onAuthUrl: (url) => {
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
            if (typeof window !== 'undefined') {
              window.open(url, '_blank', 'noopener,noreferrer')
            }
          } catch {}
        },
      })
      ndk.signer = signer
      await connectAndWait(ndk)
      await ensureUserWriteRelays(ndk, userPubkey)
      const user = await fetchUserProfile(ndk, userPubkey)
      return { kind: 'ok', user }
    } catch {
      return { kind: 'transient' }
    }
  }

  return { kind: 'permanent' }
}

// Verify the attached signer actually controls the saved record's pubkey.
// Calls signer.user(), which on NIP-07 may trigger a permission prompt and
// on NIP-46 round-trips the bunker — call this lazily right before the
// first sign-gated action, NOT on page load.
//
// Returns:
//   { kind: 'ok' }
//   { kind: 'transient' }   — signer not ready / call timed out; treat
//                             as "probably fine, let the action proceed
//                             and surface any sign error there"
//   { kind: 'permanent' }   — signer reports a different pubkey from the
//                             saved record; caller should force logout
export async function verifySignerMatches(ndk, record) {
  if (!ndk?.signer) return { kind: 'transient' }
  if (!isHex64(record?.pubkey)) return { kind: 'transient' }
  try {
    const signerUser = await withTimeout(ndk.signer.user(), 10000, '__timeout__')
    const reported = signerUser?.pubkey
    if (typeof reported !== 'string' || !isHex64(reported)) return { kind: 'transient' }
    if (reported !== record.pubkey) return { kind: 'permanent' }
    return { kind: 'ok' }
  } catch {
    return { kind: 'transient' }
  }
}

// ── Helpers for the LoginScreen save path ──────────────────────────────────

export function buildExtensionRecord(pubkey) {
  return { method: 'extension', pubkey, npub: nip19.npubEncode(pubkey) }
}

export function buildNip46Record({ clientSecret, bunkerPointer, userPubkey }) {
  if (!clientSecret || !userPubkey || !bunkerPointer?.pubkey || !bunkerPointer?.relays?.length) {
    return null
  }
  return {
    method: 'nip46',
    pubkey: userPubkey,
    npub: nip19.npubEncode(userPubkey),
    clientSecret,
    bunkerPointer: {
      pubkey: bunkerPointer.pubkey,
      relays: bunkerPointer.relays,
      secret: bunkerPointer.secret ?? null,
    },
    userPubkey,
  }
}
