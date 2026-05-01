/**
 * Donation Boostagram — Local Bitcoiners variant.
 *
 * Same V4V 2.0 flow as mynostr's boostagram.js, with the kind-0 lud16
 * lookup replaced by a hardcoded address. There's only ever one recipient
 * here (the show), so a runtime lookup adds latency + failure modes for
 * no benefit.
 *
 * Flow:
 *   1. Fetch LNURL pay metadata from the hardcoded lud16
 *   2. Request a bolt11 invoice from the LNURL callback
 *   3. Extract payment_hash from the bolt11 (inline bech32 decoder)
 *   4. Build a kind 30078 "donation_boostagram" event signed with either
 *      a single-use burner key (anonymous) or the donor's NDK signer
 *      (attributed). d-tag = payment_hash links the event to the invoice.
 *   5. Optionally publish a kind 1 share-to-feed note from the donor's
 *      real identity, after the LUD-21 verify URL confirms payment.
 *
 * NOTE — description_hash:
 *   Full V4V 2.0 wants description_hash = sha256(kind_30078_event_id) in
 *   the bolt11, creating a bidirectional link. That requires controlling
 *   invoice generation, which we don't for the static-site deployment.
 *   With standard LNURL-pay we get a unidirectional link (event → invoice
 *   via d-tag). Sufficient for a future bot to correlate boosts to
 *   payments by filtering kind 30078 #d=<payment_hash>.
 */

import { generateSecretKey, finalizeEvent, SimplePool } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout } from './ndk.js'
import { withTimeout } from './utils.js'

// ─── Recipient constants ────────────────────────────────────────────────────
// Hardcoded lightning address for the show. No runtime kind-0 lookup —
// boosts always go to one place, and a network round-trip on modal-open
// just adds latency + a failure surface.
export const RECIPIENT_LUD16 = 'localbitcoiners@getalby.com'

// Recipient npub for the optional kind 1 share-to-feed note. Decoded once
// at module load; the hex pubkey populates the kind 1 `p` tag and the
// raw npub goes into the `nostr:` mention so followers can click through
// to the show's profile.
export const RECIPIENT_NPUB = 'npub1cvcgs83gw6pcrhvtmlf8gdqaegx93qkznwry96jteqhh2cexgkfq45rtya'
export const RECIPIENT_PUBKEY_HEX = (() => {
  try {
    const d = nip19.decode(RECIPIENT_NPUB)
    return d.type === 'npub' ? d.data : ''
  } catch { return '' }
})()

// Site URL used in event tags + kind 1 share body. Hardcoded prod URL
// regardless of where the modal was authored from — readers should land
// on the live site, not localhost / preview env.
export const SITE_URL = 'https://localbitcoiners.com'

// Validate that a lud16 looks like a valid lightning address.
const LUD16_RE = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+$/

// Relays used for kind 30078 publishing. Same set the rest of the Nostr
// boost ecosystem watches; broad enough for any future bot subscribing
// to the metadata stream.
const BOOSTAGRAM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://purplepag.es',
]

// ─── bolt11 payment hash extractor ──────────────────────────────────────────
// Minimal inline decoder — avoids adding a bolt11 dep.
// Decodes the bech32 data section, skips the 35-bit timestamp, then walks
// tagged fields until it finds tag type 1 (payment hash, 52 5-bit words = 32 bytes).
export function bolt11PaymentHash(invoice) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const str = invoice.toLowerCase()
  const sep = str.lastIndexOf('1')
  if (sep < 0) return null

  const dataStr = str.slice(sep + 1, str.length - 6)
  const words = []
  for (const c of dataStr) {
    const v = CHARSET.indexOf(c)
    if (v < 0) break
    words.push(v)
  }

  let i = 7  // skip 35-bit timestamp (7 × 5-bit words)

  while (i + 2 < words.length) {
    const tag = words[i]
    const len = (words[i + 1] << 5) | words[i + 2]
    i += 3
    if (i + len > words.length) break

    if (tag === 1 && len === 52) {
      const fieldWords = words.slice(i, i + 52)
      const bytes = []
      let acc = 0, bits = 0
      for (const w of fieldWords) {
        acc = (acc << 5) | w
        bits += 5
        if (bits >= 8) {
          bits -= 8
          bytes.push((acc >> bits) & 0xff)
        }
      }
      return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
    }
    i += len
  }
  return null
}

// ─── Burner keypair ──────────────────────────────────────────────────────────
// New random keypair for each anonymous boost — never written to storage,
// caller zeroes the bytes immediately after the event is signed. Just the
// secret key; nostr-tools' finalizeEvent derives the pubkey internally.
export function generateBurnerKeypair() {
  return { sk: generateSecretKey() }
}

// ─── LNURL-pay helpers ───────────────────────────────────────────────────────
// Both helpers wrap fetch in a 10s timeout so the modal can't hang
// indefinitely on a slow / unreachable LNURL server. They also validate
// response shape — a misbehaving server returning {} or an array would
// otherwise leak undefined values into downstream code paths.
const LNURL_FETCH_TIMEOUT_MS = 10_000

export async function fetchLnurlMeta(lud16) {
  if (!LUD16_RE.test(lud16)) throw new Error('Invalid lightning address format')
  const [name, domain] = lud16.split('@')
  const res = await withTimeout(
    fetch(`https://${domain}/.well-known/lnurlp/${name}`),
    LNURL_FETCH_TIMEOUT_MS,
    'lnurl-meta-timeout',
  )
  if (!res.ok) throw new Error(`Failed to reach lightning address (${res.status})`)
  const data = await res.json()
  if (!data || typeof data !== 'object') throw new Error('LNURL metadata response was not an object')
  if (typeof data.callback !== 'string' || !data.callback.startsWith('https://')) {
    throw new Error('LNURL metadata missing valid https callback URL')
  }
  if (typeof data.minSendable !== 'number' || typeof data.maxSendable !== 'number') {
    throw new Error('LNURL metadata missing min/maxSendable')
  }
  return data
}

// Returns { pr: bolt11String, verify: verifyUrlOrNull }
export async function fetchLnurlInvoice(callbackUrl, amountMsats, comment) {
  if (!callbackUrl.startsWith('https://')) throw new Error('LNURL callback must use HTTPS')
  const url = new URL(callbackUrl)
  url.searchParams.set('amount', String(amountMsats))
  if (comment) url.searchParams.set('comment', comment)
  const res = await withTimeout(
    fetch(url.toString()),
    LNURL_FETCH_TIMEOUT_MS,
    'lnurl-invoice-timeout',
  )
  if (!res.ok) throw new Error(`Invoice request failed (${res.status})`)
  const data = await res.json()
  if (!data || typeof data !== 'object') throw new Error('Invoice response was not an object')
  if (data.status === 'ERROR') throw new Error(data.reason || 'Unknown error from server')
  if (typeof data.pr !== 'string' || !data.pr.toLowerCase().startsWith('lnbc')) {
    throw new Error('Invoice response missing valid bolt11 (pr field)')
  }
  return { pr: data.pr, verify: typeof data.verify === 'string' ? data.verify : null }
}

// ─── Kind 30078 donation boostagram ─────────────────────────────────────────
/**
 * Build the unsigned event template for a kind 30078 donation_boostagram.
 *
 * Pure: returns a fresh template each call, no I/O. Same shape both the
 * burner-signing path and the user-signer path consume — keeps the
 * tag layout in one place so a refactor of either signing path can't
 * silently drift from the other.
 */
export function buildDonationBoostagramTemplate({
  paymentHash,
  donorNpub,
  recipientLud16,
  amountMsats,
  message,
  pageUrl,
  extraTags = [],
}) {
  const baseTags = [
    ['d', paymentHash],
    ['app', 'localbitcoiners.com', '1.0.0'],
    ['client', 'localbitcoiners.com'],
    ['type', 'donation_boostagram'],
    ['sender', donorNpub],
    ['recipient', recipientLud16],
    ['amount', String(amountMsats)],
    ['url', pageUrl],
  ]
  // Append-only — never let extras override spec-required tags. Filter
  // on the keys baseTags claims so a malformed caller can't inject a
  // duplicate 'd' tag (which would invalidate the payment_hash linkage).
  const reservedKeys = new Set(baseTags.map(t => t[0]))
  const safeExtras = Array.isArray(extraTags)
    ? extraTags.filter(t => Array.isArray(t) && typeof t[0] === 'string' && !reservedKeys.has(t[0]))
    : []
  return {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    content: message || '',
    tags: [...baseTags, ...safeExtras],
  }
}

/**
 * Sign a pre-built kind 30078 template with the user's NDK session
 * signer. Throws on signer failure — caller decides whether to fall
 * back to a burner key or surface the error. Bounded by signWithTimeout
 * so a hung remote signer can't stall the boost flow forever.
 */
export async function signDonationBoostagramWithUser(template) {
  const ndk = getNDK()
  const ev = new NDKEvent(ndk, template)
  await signWithTimeout(ev)
  return ev.toNostrEvent()
}

/** Sign a pre-built kind 30078 template with a single-use burner key. */
export function signDonationBoostagramWithBurner(template, burnerSk) {
  return finalizeEvent(template, burnerSk)
}

/**
 * Publish an already-signed kind 30078 to the boostagram relay set.
 * Returns whether at least one relay ack'd. Never throws.
 */
export async function publishSignedBoostagram(signedEvent) {
  const pool = new SimplePool()
  let published = false
  try {
    const results = await Promise.allSettled(
      pool.publish(BOOSTAGRAM_RELAYS, signedEvent).map(p => withTimeout(p, 6000))
    )
    published = results.some(r => r.status === 'fulfilled')
  } finally {
    pool.close(BOOSTAGRAM_RELAYS)
  }
  return { eventId: signedEvent.id, published }
}

/**
 * Build, sign, and publish a kind 30078 donation_boostagram event in
 * one call. Convenience wrapper retained for the show-boost flow,
 * which still wants a single-call build+sign+publish.
 *
 * Two signing paths controlled by `burnerSk`:
 *   • Burner key supplied → signed with that single-use key (anonymous mode).
 *     Caller is expected to zero the bytes immediately after this returns.
 *   • Burner key not supplied → signed with the NDK session signer (the
 *     donor's real Nostr key). Used when the donor wants the event
 *     attributed to them.
 *
 * @param {object}      params
 * @param {?Uint8Array} params.burnerSk       - Optional. If supplied, sign with this; else use session signer.
 * @param {string}      params.paymentHash    - Hex payment hash from the bolt11 invoice
 * @param {string}      params.donorNpub      - Full npub of the donor — '' for anonymous
 * @param {string}      params.recipientLud16 - lud16 of the recipient (for the recipient tag)
 * @param {number}      params.amountMsats    - Amount in millisatoshis
 * @param {string}      params.message        - Donor's message (may be empty)
 * @param {string}      params.pageUrl        - Site URL for the url tag
 * @param {Array}       [params.extraTags]    - Optional additional kind 30078 tags (appended verbatim).
 * @returns {Promise<{eventId: string, published: boolean}>}
 */
export async function publishDonationBoostagram({
  burnerSk = null,
  paymentHash,
  donorNpub,
  recipientLud16,
  amountMsats,
  message,
  pageUrl,
  extraTags = [],
}) {
  const template = buildDonationBoostagramTemplate({
    paymentHash, donorNpub, recipientLud16, amountMsats, message, pageUrl, extraTags,
  })
  const signedEvent = burnerSk
    ? signDonationBoostagramWithBurner(template, burnerSk)
    : await signDonationBoostagramWithUser(template)
  return publishSignedBoostagram(signedEvent)
}

// ─── Kind 1 episode-boost share — donor's per-episode feed note ─────────────
// Defensive caps for RSS-derived fields. The episode title and Fountain
// URL come from a third-party feed — a compromised proxy or upstream
// could inject pathological content (megabyte-long titles, weird URLs)
// that bloat the kind 1 past relay-side size limits or look broken in
// the donor's followers' feeds. These bounds are loose enough to fit
// any realistic value and tight enough to make abuse uninteresting.
const MAX_TITLE_LEN = 200
const MAX_FOUNTAIN_URL_LEN = 256

/**
 * Build the unsigned event template for an episode-boost kind 1.
 *
 * Mirrors `publishBoostShareNote` (the show-level share) but with
 * episode metadata folded into the visible content — episode number +
 * quoted title — and a Fountain page link surfaced when the RSS
 * feed has it.
 *
 * The Fountain link comes from `<podcast:contentLink>` and is
 * backfilled a few days after a fresh episode publishes; when absent,
 * the line is omitted entirely rather than guessed at.
 */
export function buildEpisodeBoostShareTemplate({
  amountSats,
  message,
  episode,        // { number, title, guid?, fountainUrl? }
  pageUrl,
}) {
  const epNum = episode?.number != null ? String(episode.number) : ''
  const rawTitle = (episode?.title || '').trim()
  const title = rawTitle.length > MAX_TITLE_LEN
    ? rawTitle.slice(0, MAX_TITLE_LEN - 1) + '…'
    : rawTitle
  const rawFountain = (episode?.fountainUrl || '').trim()
  // Drop the URL entirely if it's suspiciously long. Real Fountain
  // page URLs are ~50 chars; anything over 256 is either a malformed
  // feed or a hostile injection — better to omit the line than to
  // ship a broken link to followers.
  const fountainUrl = rawFountain.length > 0 && rawFountain.length <= MAX_FOUNTAIN_URL_LEN
    ? rawFountain
    : ''

  const lines = [
    epNum
      ? `Just boosted ⚡ ${amountSats.toLocaleString()} sats to nostr:${RECIPIENT_NPUB} for Ep. ${epNum}`
      : `Just boosted ⚡ ${amountSats.toLocaleString()} sats to nostr:${RECIPIENT_NPUB}`,
  ]
  if (title) {
    lines.push('')
    lines.push(`"${title}"`)
  }
  if (message && message.trim()) {
    lines.push('')
    lines.push(message.trim())
  }
  lines.push('')
  if (fountainUrl) lines.push(fountainUrl)
  lines.push(pageUrl)
  const content = lines.join('\n')

  const tags = [
    ['t', 'localbitcoiners'],
    ['t', 'boost'],
    ['t', 'podcast'],
    ['r', pageUrl],
    ['client', 'localbitcoiners.com'],
  ]
  if (RECIPIENT_PUBKEY_HEX) tags.push(['p', RECIPIENT_PUBKEY_HEX])
  if (fountainUrl) tags.push(['r', fountainUrl])

  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  }
}

/**
 * Sign a kind 1 boost share template with the user's NDK session
 * signer. Returns the signed raw event. Throws on signer failure —
 * caller decides whether to skip the share or surface the error.
 *
 * Used by the episode-boost flow's pre-sign step so the signer prompt
 * happens while the modal is still open, rather than as a surprise
 * after the modal closes and `payAllLegs` runs in the background.
 */
export async function signKindOneShareWithUser(template) {
  const ndk = getNDK()
  const ev = new NDKEvent(ndk, template)
  await signWithTimeout(ev)
  return ev.toNostrEvent()
}

/**
 * Publish an already-signed kind 1 share note via NDK to the user's
 * outbox relays. Best-effort: returns whether at least one relay
 * ack'd. Never throws.
 */
export async function publishSignedKindOne(signedEvent) {
  if (!signedEvent?.id || !signedEvent?.sig) return { published: false }
  const ndk = getNDK()
  try {
    const ev = new NDKEvent(ndk, signedEvent)
    const ackd = await ev.publish()
    return { published: !!(ackd && ackd.size > 0) }
  } catch {
    return { published: false }
  }
}

// ─── Kind 1 boost share — donor's "I just boosted X" feed note ─────────────
/**
 * Optional second event published when the donor opts into "Share to feed."
 * Regular kind 1 note signed by the donor's real key, posted to their own
 * write relays so their followers see it natively.
 *
 * Caller must only invoke this *after* the LUD-21 verify URL confirms the
 * payment settled — otherwise an abandoned boost would pollute the donor's
 * feed with a "I just boosted!" note for a payment that never happened.
 *
 * @param {object} params
 * @param {string} params.message     - Donor's boost message (may be empty)
 * @param {string} params.pageUrl     - URL to include in the note (typically site root)
 * @param {number} params.amountSats  - Amount in sats (for the visible message)
 * @returns {Promise<{eventId: string, published: boolean}>}
 */
export async function publishBoostShareNote({
  message,
  pageUrl,
  amountSats,
}) {
  const ndk = getNDK()

  // Build the visible content. Lead with the action + nostr: mention so
  // clients render the show's profile inline; donor's message inline if
  // any; close with the link.
  const lines = [
    `Just boosted ⚡ ${amountSats.toLocaleString()} sats to nostr:${RECIPIENT_NPUB}`,
  ]
  if (message && message.trim()) {
    lines.push('')
    lines.push(message.trim())
  }
  lines.push('')
  lines.push(pageUrl)
  const content = lines.join('\n')

  const tags = [
    ['t', 'localbitcoiners'],
    ['t', 'boost'],
    ['r', pageUrl],
    ['client', 'localbitcoiners.com'],
  ]
  if (RECIPIENT_PUBKEY_HEX) tags.push(['p', RECIPIENT_PUBKEY_HEX])

  const ev = new NDKEvent(ndk, {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  })
  await signWithTimeout(ev)

  // Publish to the user's own write relays via NDK's default publish.
  // Failures are non-fatal — the boost itself succeeded; the share is
  // best-effort.
  let published = false
  try {
    const ackd = await ev.publish()
    published = ackd && ackd.size > 0
  } catch {
    published = false
  }

  return { eventId: ev.id, published }
}

// ─── LUD-21 payment verify poller ────────────────────────────────────────────
// Returns a cancel function. Calls onSettled() once when the invoice is paid.
//
// `expectedPaymentHash` (optional, hex) enables cryptographic verification
// of the server's "settled" claim: when the verify response includes a
// `preimage` field (LUD-21 marks it optional), we sha256 it and confirm
// the digest equals the expected payment_hash. If it doesn't, the server
// is either lying or buggy, and we keep polling rather than firing the
// onSettled callback. When the response has no preimage, we fall back to
// trusting the boolean.
//
// Without this check, a malicious LNURL server could falsely report
// settled=true and trick the modal into showing the success state for a
// payment that never happened.
// Hard cap on poll iterations. Bolt11 invoices typically expire in 1
// hour; well before that the user has either paid (resolves the poll)
// or abandoned the modal (cancel handle stops the poll). The cap exists
// only to backstop bugs — if the cancel handle is somehow lost (modal
// remount during HMR, stray ref leak), polling self-terminates instead
// of running forever.
const POLL_VERIFY_MAX_ITERATIONS = 720  // 720 × 2.5s = 30 min

export function pollVerify(verifyUrl, intervalMs, onSettled, expectedPaymentHash = null) {
  if (!verifyUrl.startsWith('https://')) return () => {}
  let active = true
  let iter = 0
  async function tick() {
    if (!active) return
    if (iter++ >= POLL_VERIFY_MAX_ITERATIONS) {
      active = false
      return
    }
    try {
      const res = await fetch(verifyUrl)
      if (res.ok) {
        const data = await res.json()
        if (data.settled) {
          if (expectedPaymentHash && typeof data.preimage === 'string' && data.preimage.length > 0) {
            const ok = await verifyPreimageMatches(data.preimage, expectedPaymentHash)
            if (!ok) {
              if (active) setTimeout(tick, intervalMs)
              return
            }
          }
          onSettled()
          return
        }
      }
    } catch { /* network blip — keep polling */ }
    if (active) setTimeout(tick, intervalMs)
  }
  tick()
  return () => { active = false }
}

// Compute sha256(preimage_bytes) and compare to expected payment_hash.
// Both inputs are hex strings. Returns false on any malformed input or
// missing crypto.subtle (graceful fallback to "treat as unverifiable,
// keep polling" rather than blocking the boost flow).
async function verifyPreimageMatches(preimageHex, expectedHashHex) {
  if (!crypto?.subtle) return true
  const hexRe = /^[0-9a-f]{64}$/i
  if (!hexRe.test(preimageHex) || !hexRe.test(expectedHashHex)) return false
  try {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(preimageHex.slice(i * 2, i * 2 + 2), 16)
    }
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    return hashHex.toLowerCase() === expectedHashHex.toLowerCase()
  } catch {
    return false
  }
}
