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

// RSS <podcast:guid> for the Local Bitcoiners feed. Used for NIP-73
// external-content identity tags (i/k) on the kind 1 boost share notes so
// GUID-aware podcast clients (Fountain, Primal, BoostMeBitch) can associate
// the note with the show / episode.
export const FEED_GUID = '56fbb1aa-da79-5e4b-bebc-3b934ab8914c'

// Validate that a lud16 looks like a valid lightning address. Tightened
// from `[a-zA-Z0-9.-]+` for the host to a real(ish) hostname rule —
// rejects leading dot, trailing dot, double-dot, and bare TLDs. The
// local part is also URL-safe (no slashes) so direct interpolation
// into the .well-known path won't escape it; encodeURIComponent in
// fetchLnurlMeta is belt-and-braces.
const LUD16_RE = /^[a-zA-Z0-9_.+-]+@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/

// Hard cap on LNURL response bodies. Real LNURL meta + callback
// payloads are <2 KB; 64 KB is generous headroom for a wallet that
// returns a verbose `metadata` JSON-string. A hostile lud16 host
// could otherwise stream multi-MB JSON to OOM the donor's tab,
// especially under episode boosts which fan out to N recipients in
// parallel from EpisodeBoostModal's mount-time prefetch.
const LNURL_BODY_BYTE_CAP = 64 * 1024

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
      const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('')
      // Belt-and-braces: even though len === 52 above implies 32
      // bytes implies 64 hex chars, validate explicitly so a
      // future refactor of the loop can't slip a malformed string
      // out into the kind 30078 `d` tag where a hostile lnurl
      // server could pollute downstream dedup.
      return /^[0-9a-f]{64}$/.test(hex) ? hex : null
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

/**
 * fetch + read + JSON parse with a hard byte cap. Read the body
 * incrementally via the response stream and abort once cumulative
 * bytes exceed the cap. The 10s `withTimeout` doesn't bound bytes —
 * a slow trickle of 1 MB/s for 9.9 s passes cleanly — so this guard
 * is the actual DoS defence.
 */
async function fetchJsonCapped(url, errLabel) {
  const ctrl = new AbortController()
  const res = await withTimeout(
    fetch(url, { signal: ctrl.signal }),
    LNURL_FETCH_TIMEOUT_MS,
    errLabel,
  )
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  // Pre-flight check on Content-Length when present. Hostile servers
  // can lie or omit this; the streamed read below is the real guard.
  const cl = parseInt(res.headers.get('content-length') || '', 10)
  if (Number.isFinite(cl) && cl > LNURL_BODY_BYTE_CAP) {
    ctrl.abort()
    throw new Error('Response too large')
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    // Older runtimes without streaming bodies — fall back to text()
    // which has no per-call size knob, but the timeout still applies.
    const text = await res.text()
    if (text.length > LNURL_BODY_BYTE_CAP) throw new Error('Response too large')
    try { return JSON.parse(text) } catch { throw new Error('Response was not valid JSON') }
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > LNURL_BODY_BYTE_CAP) {
      try { ctrl.abort() } catch {}
      try { reader.cancel() } catch {}
      throw new Error('Response too large')
    }
    chunks.push(value)
  }
  // Reassemble + decode + parse. Small enough at the cap that one
  // more allocation is negligible.
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  const text = new TextDecoder('utf-8').decode(buf)
  try { return JSON.parse(text) } catch { throw new Error('Response was not valid JSON') }
}

// Cross-domain LNURL callbacks we've explicitly decided to trust, keyed by
// lud16 domain. Some custodial wallets serve `.well-known/lnurlp` from their
// brand domain but issue invoices from a separate API domain. LUD-06 treats
// `callback` as opaque and does not require it to share the lud16 host, so a
// strict same-domain rule is stricter than spec — it aborts the leg before an
// invoice is ever requested, and the recipient's wallet is never contacted.
// Every website boost to a walletofsatoshi.com guest split failed this way.
//
// Keep this narrow and exact-match: the guard exists so a compromised lud16
// server can't redirect the callback to an arbitrary host, and each entry
// gives up that protection for one domain. Verify a provider genuinely uses
// the host before adding it.
const CALLBACK_HOST_ALLOWLIST = {
  // Wallet of Satoshi serves lud16 from walletofsatoshi.com, invoices from
  // livingroomofsatoshi.com (its long-standing API domain).
  'walletofsatoshi.com': ['livingroomofsatoshi.com'],
}

export async function fetchLnurlMeta(lud16) {
  if (!LUD16_RE.test(lud16)) throw new Error('Invalid lightning address format')
  const [name, domain] = lud16.split('@')
  // encodeURIComponent the local part so a future relaxed regex (or
  // a payload someone forgot to validate) can't smuggle path traversal
  // into the .well-known/lnurlp/ URL. Also reject any domain whose
  // URL-parse normalises differently — defends against bare-IP /
  // unicode-confusable hosts even if they slip past LUD16_RE.
  let metaUrl
  try {
    metaUrl = new URL(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`)
    if (metaUrl.hostname !== domain.toLowerCase()) {
      throw new Error('hostname mismatch')
    }
  } catch {
    throw new Error('Invalid lightning address host')
  }
  const data = await fetchJsonCapped(metaUrl.toString(), 'lnurl-meta-timeout')
  if (!data || typeof data !== 'object') throw new Error('LNURL metadata response was not an object')
  if (typeof data.callback !== 'string' || !data.callback.startsWith('https://')) {
    throw new Error('LNURL metadata missing valid https callback URL')
  }
  // Constrain the callback host to the lud16 domain (or a subdomain
  // of it), plus the explicit cross-domain exceptions above. Without
  // this, a compromised lud16 server can return a `callback` pointing
  // at any HTTPS URL — internal corp endpoints, attacker logging
  // endpoints, hangs — and we'd happily issue the request from the
  // donor's origin.
  try {
    const cbHost = new URL(data.callback).hostname.toLowerCase()
    const lud16Host = domain.toLowerCase()
    const allowed = CALLBACK_HOST_ALLOWLIST[lud16Host] || []
    if (
      cbHost !== lud16Host &&
      !cbHost.endsWith('.' + lud16Host) &&
      !allowed.includes(cbHost)
    ) {
      throw new Error(`callback host ${cbHost} does not belong to ${lud16Host}`)
    }
  } catch (e) {
    throw new Error(`LNURL callback host check failed: ${e.message}`)
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
  const data = await fetchJsonCapped(url.toString(), 'lnurl-invoice-timeout')
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
// Hard cap on `content` length at the trust boundary. The textarea's
// maxLength is the only guard today — DOM tampering or a future
// caller bypassing the modal could push multi-MB into a kind 30078,
// causing relays to drop the event and rate-limit the burner key.
const MAX_BOOSTAGRAM_MESSAGE_CHARS = 10_000

export function buildDonationBoostagramTemplate({
  paymentHash,
  donorNpub,
  recipientLud16,
  amountMsats,
  message,
  pageUrl,
  extraTags = [],
}) {
  const safeMessage = typeof message === 'string'
    ? message.slice(0, MAX_BOOSTAGRAM_MESSAGE_CHARS)
    : ''
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
    content: safeMessage,
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

/**
 * Sign with the user's signer, retrying transient failures before giving
 * up. Rapid back-to-back boosts can make a NIP-07 extension (or NDK's
 * signer queue) reject a sign request that would succeed a moment later;
 * a single attempt then drops the boost to an anonymous burner and
 * silently loses the donor's attribution (the "logged-in but published
 * as Anon" bug). Retrying with a short backoff lets a momentary signer
 * hiccup recover.
 *
 * Only *fast* failures are retried. A failure slower than `fastFailMs` is
 * a real timeout or a remote signer (bunker) waiting on approval —
 * retrying there just multiplies the wait, so we surface it to the
 * caller's burner fallback immediately. Worst case for the common
 * fast-reject path is ~`backoffMs`×(attempts-1) of added latency.
 */
export async function signDonationBoostagramWithUserResilient(template, {
  attempts = 3,
  backoffMs = 500,
  fastFailMs = 4000,
} = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const startedAt = Date.now()
    try {
      return await signDonationBoostagramWithUser(template)
    } catch (e) {
      lastErr = e
      const elapsed = Date.now() - startedAt
      if (i >= attempts - 1 || elapsed >= fastFailMs) break
      await new Promise(r => setTimeout(r, backoffMs * (i + 1)))
    }
  }
  throw lastErr
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

// ─── Kind 30078 boost receipt — one per boost session ───────────────────────
// Published AFTER payAllLegs, ALWAYS (even on full failure), as a superset
// of the per-leg donation_boostagram events plus the outcome layer. Lets
// the bots (a) credit only sats ACTUALLY sent and (b) treat a boost whose
// per-leg 30078s exist but whose receipt is MISSING as "user closed
// mid-boost". Burner-signed so there's no post-payment signer prompt — the
// donor npub rides as a CLAIMED `sender` tag, not cryptographic proof.

/**
 * Build the unsigned kind 30078 boost_receipt template.
 *
 * @param {object} params
 * @param {string} params.boostSession        UUID shared with the per-leg events.
 * @param {string} params.donorNpub           '' for anonymous.
 * @param {string} params.message             Donor's message, verbatim (content).
 * @param {{number,title,guid}} params.episodeMeta
 * @param {string} params.pageUrl
 * @param {string} params.walletKind          'nwc' | 'webln'.
 * @param {string} params.walletProvider      Normalized best-effort label (never the raw alias).
 * @param {string} params.browser             Coarse browser/OS label.
 * @param {number} params.totalMsatsRequested Intended total (sats×1000).
 * @param {Array<{recipient:{address:string},msats:number,status:string,paymentHash:?string}>} params.legs
 */
export function buildBoostReceiptTemplate({
  boostSession,
  donorNpub,
  message,
  episodeMeta,
  pageUrl,
  walletKind,
  walletProvider,
  browser,
  totalMsatsRequested,
  legs = [],
}) {
  const safeMessage = typeof message === 'string'
    ? message.slice(0, MAX_BOOSTAGRAM_MESSAGE_CHARS)
    : ''
  const paidLegs = legs.filter(l => l?.status === 'paid')
  const failedCount = legs.filter(l => l?.status === 'failed').length
  const uncertainCount = legs.filter(l => l?.status === 'uncertain').length
  const amountPaid = paidLegs.reduce((acc, l) => acc + (l?.msats || 0), 0)
  // Sats on legs whose settlement we couldn't confirm. Kept SEPARATE from
  // amount_paid (the authoritative "confirmed landed" figure) so the bot can
  // reconcile these against the recipient nodes rather than the headline
  // silently over- or under-counting them.
  const amountUncertain = legs
    .filter(l => l?.status === 'uncertain')
    .reduce((acc, l) => acc + (l?.msats || 0), 0)
  // 'uncertain' = paid-status unknown (e.g. NWC reply lost). Surfaced to the
  // bots so they can reconcile against the recipients' nodes rather than
  // assuming nothing was sent.
  const outcome = legs.length > 0 && paidLegs.length === legs.length
    ? 'paid'
    : paidLegs.length > 0 ? 'partial'
      : uncertainCount > 0 ? 'uncertain' : 'failed'

  const tags = [
    ['d', boostSession],
    ['app', 'localbitcoiners.com', '1.0.0'],
    ['client', 'localbitcoiners.com'],
    ['type', 'boost_receipt'],
    ['boost_session', boostSession],
    ['sender', donorNpub || ''],
    ['wallet', walletKind || ''],
    ['wallet_provider', walletProvider || 'unknown'],
    ['browser', browser || 'unknown'],
    ['url', pageUrl],
    ['episode', String(episodeMeta?.number ?? '')],
    ['episode_title', episodeMeta?.title || ''],
    ['item_guid', episodeMeta?.guid || ''],
    ['show', 'Local Bitcoiners'],
    ['amount', String(totalMsatsRequested || 0)],
    ['amount_paid', String(amountPaid)],
    ['amount_uncertain', String(amountUncertain)],
    ['legs', String(legs.length)],
    ['legs_paid', String(paidLegs.length)],
    ['legs_failed', String(failedCount)],
    ['legs_uncertain', String(uncertainCount)],
    ['outcome', outcome],
  ]
  // One per recipient: [lud16, amount_msats, status, payment_hash("" if unpaid)].
  for (const l of legs) {
    tags.push([
      'leg_result',
      l?.recipient?.address || '',
      String(l?.msats || 0),
      l?.status || 'failed',
      l?.paymentHash || '',
    ])
  }

  return {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    content: safeMessage,
    tags,
  }
}

/**
 * Build, burner-sign, and publish a boost receipt. Fire-and-forget from
 * the queue; never throws (publishSignedBoostagram swallows relay errors).
 * Uses its own single-use burner key (independent of the legs' key) and
 * zeroes it immediately after signing.
 */
export async function publishBoostReceipt(params) {
  const template = buildBoostReceiptTemplate(params)
  const { sk } = generateBurnerKeypair()
  try {
    const signed = signDonationBoostagramWithBurner(template, sk)
    return await publishSignedBoostagram(signed)
  } finally {
    if (sk) sk.fill(0)
  }
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
  // NIP-73 external-content tags: feed GUID always, episode item GUID when known.
  tags.push(['i', `podcast:guid:${FEED_GUID}`])
  tags.push(['k', 'podcast:guid'])
  const epGuid = (episode?.guid || '').trim()
  if (epGuid) {
    tags.push(['i', `podcast:item:guid:${epGuid}`])
    tags.push(['k', 'podcast:item:guid'])
  }

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
  // NIP-73 external-content tags. Show-level share: feed GUID only.
  tags.push(['i', `podcast:guid:${FEED_GUID}`])
  tags.push(['k', 'podcast:guid'])

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

// ─── LUD-21 settlement confirmation ─────────────────────────────────────────
// Re-added (was removed in the multi-leg rewrite) because relying solely on
// payInvoice()'s preimage produces FALSE failures: with NWC the payment can
// settle on Lightning while the wallet's reply event (carrying the preimage)
// times out or is lost over the relay. The LNURL endpoint's LUD-21 verify URL
// is an authoritative, out-of-band "did this invoice actually get paid?" check.

// Compute sha256(preimage_bytes) and compare to the expected payment_hash.
// Both hex strings. When crypto.subtle is unavailable we can't check, so we
// return true (fall back to trusting the endpoint's `settled` boolean) — only
// ever reached when settled===true already, and our LNURL endpoints aren't
// adversarial.
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

/**
 * Bounded settlement check against an LNURL LUD-21 verify URL. Called AFTER a
 * payInvoice attempt that didn't cleanly return a preimage, to decide whether
 * the payment actually settled.
 *
 * Returns:
 *   'settled'   — the invoice was paid (verified preimage if one was provided)
 *   'unsettled' — the endpoint answered and consistently reports NOT paid
 *   'unknown'   — no verify URL, endpoint unreachable, or a suspicious
 *                 settled-claim with a mismatched preimage (don't trust)
 *
 * A handful of quick polls covers the case where the payment settled a beat
 * after our pay attempt returned/timed out. Never throws.
 */
export async function confirmInvoiceSettled(verifyUrl, paymentHash, { attempts = 4, intervalMs = 1500 } = {}) {
  if (typeof verifyUrl !== 'string' || !verifyUrl.startsWith('https://')) return 'unknown'
  let sawResponse = false
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(verifyUrl)
      if (res.ok) {
        sawResponse = true
        const data = await res.json().catch(() => null)
        if (data && data.settled) {
          if (paymentHash && typeof data.preimage === 'string' && data.preimage.length > 0) {
            const ok = await verifyPreimageMatches(data.preimage, paymentHash)
            if (!ok) return 'unknown'   // claims paid but preimage doesn't match — suspicious
          }
          return 'settled'
        }
      }
    } catch { /* network blip — try again */ }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs))
  }
  // If the endpoint answered at least once (always settled:false) we trust it
  // as unpaid; if it never answered we genuinely don't know.
  return sawResponse ? 'unsettled' : 'unknown'
}
