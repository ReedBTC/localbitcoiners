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
//   nip46     — { method, pubkey, npub, bunkerPointer, userPubkey }   (in localStorage)
//             + { clientSecret }                                      (in sessionStorage only)
//
// Why split: clientSecret is the local NIP-46 client identity's hex private
// key — a bearer credential that, combined with bunkerPointer, lets anyone
// reconnect to the user's bunker and request signatures forever. Putting
// it in localStorage made it readable by any same-origin script (XSS, hostile
// extension, supply-chain compromise of any vendor JS). Moving it to
// sessionStorage means an exfiltrated localStorage dump is useless on its
// own, and the secret only persists for the lifetime of the browser tab.
// Cost: closing the browser forces a NIP-46 re-handshake on next visit
// (same UX as most NIP-46 clients ship by default).
//
// NB: this can't be fixed by encrypting clientSecret with selfEncrypt —
// for nip46 sessions the signer IS the bunker, which requires clientSecret
// to talk to. Chicken-and-egg. WebCrypto-wrapped non-extractable keys in
// IndexedDB would buy back persistence but only defend against offline
// dumps, not active XSS — the asymmetric improvement isn't worth the
// complexity until we have a concrete need.
//
// nsec logins are deliberately NOT persisted — the LoginScreen warns the key
// is in-memory only. The site's "no npub-only mode" choice means there is no
// read-only flow: you're either logged in with a usable signer or anonymous.

const SESSION_KEY = 'lb_nostr_session'
const NIP46_SECRET_KEY = 'lb_nostr_nip46_clientsecret'
// Cached profile snapshot — separate key from the session record so the
// shape of the session can change without invalidating profile cache.
// Used to render the IdentityWidget avatar/name *synchronously* on page
// boot while the real session restore runs in the background, avoiding
// the 1-2s flash of "Sign in" / shimmer on every cross-page navigation.
const PROFILE_KEY = 'lb_nostr_profile_v1'

// One-shot migration: any pre-split records still carry clientSecret in
// localStorage. Move it to sessionStorage on first read, then strip it
// from the localStorage record so reloads don't keep healing the leak.
function migrateInlineClientSecret(parsed) {
  if (parsed?.method !== 'nip46') return parsed
  if (typeof parsed.clientSecret !== 'string') return parsed
  try { sessionStorage.setItem(NIP46_SECRET_KEY, parsed.clientSecret) } catch {}
  const { clientSecret: _drop, ...stripped } = parsed
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(stripped)) } catch {}
  return stripped
}

export function saveSession(record) {
  if (!record?.method || !record?.pubkey) return
  // For nip46, peel clientSecret off into sessionStorage and persist
  // only the long-lived bits to localStorage. Other methods pass through.
  if (record.method === 'nip46' && typeof record.clientSecret === 'string') {
    const { clientSecret, ...stripped } = record
    try { sessionStorage.setItem(NIP46_SECRET_KEY, clientSecret) } catch {}
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(stripped)) } catch {}
    return
  }
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(record)) } catch {}
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.method || !parsed?.pubkey) return null
    const migrated = migrateInlineClientSecret(parsed)
    if (migrated.method === 'nip46') {
      // Re-attach clientSecret from sessionStorage if present so the
      // returned record shape is unchanged for callers. Missing is OK
      // — restoreSession surfaces a clean 'permanent' result and the
      // user re-handshakes through the LoginModal.
      try {
        const cs = sessionStorage.getItem(NIP46_SECRET_KEY)
        if (typeof cs === 'string' && cs) migrated.clientSecret = cs
      } catch {}
    }
    return migrated
  } catch {
    return null
  }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch {}
  try { sessionStorage.removeItem(NIP46_SECRET_KEY) } catch {}
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
//
// Strips Unicode bidi-override characters from displayName / name BEFORE
// the profile fans out to every UI consumer (IdentityWidget, dropdown,
// boost modal, etc.). Without this, a hostile profile (`displayName:
// "‮kingadmin"`) could visually re-order the rendered name and
// impersonate someone else in the nav. React escapes HTML but not bidi
// controls. Centralising the strip here means we don't have to remember
// at every render call site — same chokepoint pattern as the wallet
// alias sanitization.
const PROFILE_BIDI = /[‪-‮⁦-⁩]/g
function stripBidi(s) {
  return typeof s === 'string' ? s.replace(PROFILE_BIDI, '') : s
}
export async function fetchUserProfile(ndk, pubkey) {
  const user = ndk.getUser({ pubkey })
  try { await withTimeout(user.fetchProfile(), 5000) } catch {}
  if (user.profile) {
    if (typeof user.profile.displayName === 'string') user.profile.displayName = stripBidi(user.profile.displayName)
    if (typeof user.profile.name === 'string')        user.profile.name        = stripBidi(user.profile.name)
    if (typeof user.profile.about === 'string')       user.profile.about       = stripBidi(user.profile.about)
  }
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
      // Coerce to string-or-null; a corrupted record carrying an
      // object would otherwise propagate downstream into nostr-tools
      // and surface as a confusing decode error far from the source.
      secret: typeof bunkerPointer.secret === 'string' ? bunkerPointer.secret : null,
    },
    userPubkey,
  }
}
