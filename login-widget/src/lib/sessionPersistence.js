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

// Restore a saved session. Returns the hydrated user object on success,
// null on failure (caller falls back to anonymous mode).
export async function restoreSession(record) {
  if (!record?.method || !isHex64(record.pubkey)) return null

  resetNDK()
  const ndk = getNDK()

  if (record.method === 'extension') {
    const ok = await waitForExtension(2000)
    if (!ok) return null
    try {
      const signer = new NDKNip07Signer()
      ndk.signer = signer
      await withTimeout(signer.blockUntilReady(), 10000, '__timeout__')
      const ndkUser = await signer.user()
      // Extension account may have changed since we saved — bail so the user
      // sees the login button again as whoever the extension is now set to.
      if (ndkUser.pubkey !== record.pubkey) return null
      await connectAndWait(ndk)
      await ensureUserWriteRelays(ndk, ndkUser.pubkey)
      return await fetchUserProfile(ndk, ndkUser.pubkey)
    } catch {
      return null
    }
  }

  if (record.method === 'nip46') {
    const { clientSecret, bunkerPointer, userPubkey } = record
    if (!isHex64(userPubkey)) return null
    if (typeof clientSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(clientSecret)) return null
    if (!bunkerPointer || !isHex64(bunkerPointer.pubkey)) return null
    const safeRelays = sanitizeRelayUrls(bunkerPointer.relays)
    if (safeRelays.length === 0) return null
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
      return await fetchUserProfile(ndk, userPubkey)
    } catch {
      return null
    }
  }

  return null
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
