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

// Relays used for kind 30078 publishing.
//
// This is a publish set that has to stay READABLE: these receipts are what the
// per-leg forensics for a "my boost didn't work" report are reconstructed from,
// so retention is the requirement, not just reach. Measured against the show's
// own 30078s on 2026-08-12: nos.lol held 5, relay.ditto.pub 3, nostr.mom 3,
// and relay.damus.io 4 on the runs where it answered at all.
//
// ⚠️ purplepag.es was in this list and could NEVER have stored a single one of
// these. It accepts kinds 0, 3 and 10002 only, so every kind-30078 publish to
// it has been silently discarded for as long as the list has looked like this.
// A relay has to accept the kind at all before anything else about it matters.
// relay.damus.io is out for intermittently answering a connect with HTTP 503,
// which on a publish is a lost receipt rather than a slow query.
//
// relay.primal.net stays on the reach asymmetry rather than on evidence, and
// the distinction is worth keeping straight: it retained none of the receipts
// measured above and holds none of this author's kind-1s either. It is one
// socket on an explicit action against a delivery story that cannot be measured
// from outside. Don't cite it as grounds for keeping a low-scoring relay in a
// READ set, where the same reasoning does not hold.
const BOOSTAGRAM_RELAYS = [
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://nostr.mom',
  'wss://relay.primal.net',
]

// Core relay set for the donor's OWN kind 1 boost note, published alongside
// their NDK outbox rather than in place of it. A donor whose write relays
// aren't ones a global boost indexer scans can leave a note undiscovered for
// up to a day; downstream that reads as "no donor note exists", which is the
// one path that can produce a duplicate note published on their behalf. The
// wider fanout is also what makes a donor's boost visible outside their own
// follower graph. relay.fountain.fm carries kind 1 only, which is exactly
// what a share note is.
const SHARE_NOTE_RELAYS = [
  'wss://relay.fountain.fm',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
  'wss://relay.mostr.pub',
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
 *
 * One automatic retry with a short backoff: LNURL providers behind CDNs
 * intermittently fail *browser* requests (challenge page / 5xx without
 * CORS headers surfaces as a hard fetch error) while being otherwise
 * healthy — the 2026-07-17 getalby wobble failed every getalby leg of a
 * boost this way. A single retry papers over the transient case without
 * meaningfully delaying a genuinely-down endpoint (~1.2s added, inside
 * the leg's existing resolving state). A served LNURL ERROR response is
 * NOT retried — that's a definitive answer, parsed by the callers.
 */
// Bound on an LNURL error body and on the message pulled out of it. Small:
// this is third-party text headed for a one-line row under a leg.
const LNURL_ERROR_BODY_CAP = 2048
const LNURL_ERROR_MSG_CHARS = 180

/**
 * ⚠️ AN LNURL ERROR BODY IS OFTEN THE ONLY EXPLANATION THE DONOR WILL EVER
 * GET, so it is read rather than discarded.
 *
 * Measured against a real leg on 2026-08-19: `intuitiveocelot66@zeuspay.com`
 * answered the invoice request with HTTP 400 and the body
 * `{"success":false,"error":"Zaplocker payments are temporarily disabled.
 * Check back later."}`. The donor was shown `Request failed (400)` and pressed
 * Retry four times against a server that had already explained itself.
 *
 * Three shapes, because LUD-06's `reason` is not what everyone sends:
 * `{status:'ERROR',reason}`, `{error}`, `{message}`. Read through the same
 * bounded reader as any other third-party body, then stripped of control
 * characters and truncated. React escapes it at render; the cap is what stops
 * a hostile endpoint filling the modal.
 */
async function readErrorReason(res) {
  try {
    const cl = parseInt(res.headers.get('content-length') || '', 10)
    if (Number.isFinite(cl) && cl > LNURL_ERROR_BODY_CAP) return ''
    let text = ''
    if (!res.body || typeof res.body.getReader !== 'function') {
      text = await res.text()
      if (text.length > LNURL_ERROR_BODY_CAP) return ''
    } else {
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > LNURL_ERROR_BODY_CAP) { try { await reader.cancel() } catch {} ; return '' }
        chunks.push(value)
      }
      const buf = new Uint8Array(total)
      let at = 0
      for (const c of chunks) { buf.set(c, at); at += c.byteLength }
      text = new TextDecoder().decode(buf)
    }
    let data = null
    try { data = JSON.parse(text) } catch { return '' }
    const raw = data?.reason || data?.error || data?.message || ''
    if (typeof raw !== 'string' || !raw) return ''
    return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LNURL_ERROR_MSG_CHARS)
  } catch { return '' }
}

async function fetchJsonCapped(url, errLabel) {
  try {
    return await fetchJsonCappedOnce(url, errLabel)
  } catch (e) {
    // ⚠️ Never retry a 4xx. The server understood the request and refused it;
    // asking again 1.2 seconds later gets the same answer and only delays the
    // donor's first sight of the reason. 5xx and network faults still retry.
    if (e?.lnurlStatus >= 400 && e.lnurlStatus < 500) throw e
    await new Promise(r => setTimeout(r, 1200))
    return fetchJsonCappedOnce(url, errLabel)
  }
}

async function fetchJsonCappedOnce(url, errLabel) {
  const ctrl = new AbortController()
  const res = await withTimeout(
    fetch(url, { signal: ctrl.signal }),
    LNURL_FETCH_TIMEOUT_MS,
    errLabel,
  )
  if (!res.ok) {
    const reason = await readErrorReason(res)
    const err = new Error(reason || `Request failed (${res.status})`)
    err.lnurlStatus = res.status
    if (reason) err.lnurlReason = reason
    throw err
  }
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

/**
 * ⚠️ A LIGHTNING ADDRESS WHOSE SERVER SENDS NO CORS HEADERS CANNOT BE PAID FROM
 * A BROWSER AT ALL, AND THE FAILURE LOOKS LIKE THE HOST BEING DOWN.
 *
 * Both LNURL hops run here in the page. A cross-origin response with no
 * `Access-Control-Allow-Origin` is unreadable to JavaScript however healthy the
 * server is, so the leg dies before an invoice is ever requested. Every
 * provider we had measured sends `*` (getalby.com, fountain.fm), which is why
 * this went unnoticed; a SELF-HOSTED address generally sends nothing. Measured
 * 2026-08-21 on `spencer@bowlafterbowl.com`, 44% of that show's value block:
 * metadata, keysend document and invoice callback all 200, no CORS on any.
 *
 * `functions/api/lnurl.js` is the way out, and it is a FALLBACK rather than the
 * route. Every leg still tries the recipient's own server first, so a host that
 * works today does not touch our edge and a Pages outage cannot take down a
 * boost path that never needed us.
 *
 * ⚠️ THE PROXY TAKES THE ADDRESS, NEVER A URL — see the Function's header.
 */
const lnurlProxyUrl = (params) => `/api/lnurl?${new URLSearchParams(params)}`

/**
 * Hosts whose direct fetch has already failed this session.
 *
 * Not an optimisation. The metadata hop is prefetched on modal mount, off the
 * critical path, but the invoice hop happens with the donor watching a
 * spinner — and `fetchJsonCapped` retries once with a 1.2s backoff before
 * giving up, so a doomed direct attempt costs a visible ~2.5s per leg. Once one
 * hop has proved the host unreadable, the rest go straight to the proxy.
 *
 * Never persisted: a provider adding the header should recover on a reload,
 * not stay routed through us until a cache expires.
 */
const corsBlockedHosts = new Set()

/**
 * The amount an invoice actually demands, in msats, or null if it cannot be
 * read. Parses the bolt11 human-readable part (`lnbc<value><multiplier>`).
 *
 * ⚠️ AN UNPARSEABLE AMOUNT IS ALLOWED THROUGH, DELIBERATELY. The check exists
 * to catch an invoice for the wrong figure; treating "I could not read this"
 * as a failure would break a working payment on an encoding nobody anticipated,
 * and the behaviour it replaces is no check at all. Refusing a MISMATCH is the
 * whole value, and that is what the caller does.
 */
export function bolt11AmountMsats(invoice) {
  const m = /^lnbc(\d+)([munp])?1/i.exec(String(invoice || '').toLowerCase())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isSafeInteger(value) || value <= 0) return null
  // 1 BTC = 1e11 msat. The multiplier scales the value down from whole bitcoin.
  switch (m[2]) {
    case 'm': return value * 1e8
    case 'u': return value * 1e5
    case 'n': return value * 100
    // pico-bitcoin is the only unit finer than a msat, so it must be a
    // multiple of 10 to name a whole number of them.
    case 'p': return value % 10 === 0 ? value / 10 : null
    case undefined: return value * 1e11
    default: return null
  }
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
  let data
  if (corsBlockedHosts.has(domain.toLowerCase())) {
    data = await fetchJsonCapped(lnurlProxyUrl({ addr: lud16 }), 'lnurl-meta-timeout')
  } else {
    try {
      data = await fetchJsonCapped(metaUrl.toString(), 'lnurl-meta-timeout')
    } catch (e) {
      // ⚠️ A CORS BLOCK AND A DEAD HOST ARE THE SAME TypeError HERE, and the
      // browser will not tell us which. So the proxy is tried after ANY
      // failure that isn't the server's own considered answer: a served 4xx or
      // 5xx means we reached them and they refused, and asking again through
      // our edge would get the same refusal a second later.
      if (e?.lnurlStatus) throw e
      data = await fetchJsonCapped(lnurlProxyUrl({ addr: lud16 }), 'lnurl-meta-timeout')
      corsBlockedHosts.add(domain.toLowerCase())
    }
  }
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

/**
 * Returns { pr: bolt11String, verify: verifyUrlOrNull }
 *
 * `lud16` is optional and is only the key the proxy fallback needs; a caller
 * that omits it keeps exactly the behaviour this function has always had.
 */
export async function fetchLnurlInvoice(callbackUrl, amountMsats, comment, lud16) {
  if (!callbackUrl.startsWith('https://')) throw new Error('LNURL callback must use HTTPS')
  const url = new URL(callbackUrl)
  url.searchParams.set('amount', String(amountMsats))
  if (comment) url.searchParams.set('comment', comment)

  const proxyable = typeof lud16 === 'string' && lud16.includes('@')
  const host = proxyable ? lud16.split('@')[1].toLowerCase() : ''
  const viaProxy = () => fetchJsonCapped(
    lnurlProxyUrl(comment
      ? { addr: lud16, amount: String(amountMsats), comment }
      : { addr: lud16, amount: String(amountMsats) }),
    'lnurl-invoice-timeout',
  )

  let data
  if (proxyable && corsBlockedHosts.has(host)) {
    data = await viaProxy()
  } else {
    try {
      data = await fetchJsonCapped(url.toString(), 'lnurl-invoice-timeout')
    } catch (e) {
      if (!proxyable || e?.lnurlStatus) throw e
      data = await viaProxy()
      corsBlockedHosts.add(host)
    }
  }
  if (!data || typeof data !== 'object') throw new Error('Invoice response was not an object')
  if (data.status === 'ERROR') throw new Error(data.reason || 'Unknown error from server')
  if (typeof data.pr !== 'string' || !data.pr.toLowerCase().startsWith('lnbc')) {
    throw new Error('Invoice response missing valid bolt11 (pr field)')
  }
  // ⚠️ THE INVOICE MUST DEMAND WHAT WE ASKED FOR. Nothing checked this before,
  // on either path: the split decides a leg's share, and the wallet pays
  // whatever the bolt11 says, so a server answering with a larger figure spends
  // the donor's sats without anything on this site noticing. It is not a threat
  // the proxy introduces, but the proxy is the path where being able to state
  // the amount matters most. An unreadable amount is allowed through; see
  // bolt11AmountMsats.
  const invoiceMsats = bolt11AmountMsats(data.pr)
  if (invoiceMsats !== null && invoiceMsats !== amountMsats) {
    throw new Error(
      `Invoice is for ${Math.round(invoiceMsats / 1000).toLocaleString()} sats, not the ${Math.round(amountMsats / 1000).toLocaleString()} this leg asked for.`,
    )
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
 *
 * The pool is shared across calls: a multi-leg boost publishes one event
 * per leg plus the session receipt, and a per-call SimplePool opened and
 * closed 4 relay sockets for each of them. SimplePool reconnects lazily,
 * so keeping it open costs nothing when no boost is running.
 */
let boostagramPool = null
function getPool() {
  if (!boostagramPool) boostagramPool = new SimplePool()
  return boostagramPool
}

export async function publishSignedBoostagram(signedEvent) {
  let published = false
  try {
    const results = await Promise.allSettled(
      getPool().publish(BOOSTAGRAM_RELAYS, signedEvent).map(p => withTimeout(p, 6000))
    )
    published = results.some(r => r.status === 'fulfilled')
  } catch {
    // publish() itself threw (e.g. relay bookkeeping) — treat as not-acked.
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

// Terminal states for the donor's kind 1 share note, in receipt-tag form:
//   published   — at least one relay ack'd it
//   failed      — it exists (or was intended) but no relay took it
//   declined    — a signed-in donor opted out of sharing
//   unavailable — no signer, or the signer dropped out before signing
//   anon        — the boost was anonymous, so there was never a note to post
const SHARE_STATUSES = new Set(['published', 'failed', 'declined', 'unavailable', 'anon'])

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
  shareNoteId = '',
  shareStatus = '',
  senderName = '',  // typed display name when no npub is on the boost (Anon /
                    // signed out). Prose for the bots' 👤 line, never identity.
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
    ['sender_name', donorNpub ? '' : sanitizeShowSender(senderName)],
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
    // Outcome of the donor's own kind 1 share note. The episode flow signs
    // that note BEFORE payment, so its id is known even when the publish
    // later fails — stamp it whenever a signature exists. An unrecognized or
    // absent status is left off the receipt entirely rather than guessed at;
    // downstream that reads as "unknown" and costs a delayed note, where a
    // wrong value would cost a duplicate one.
    ['share_note', typeof shareNoteId === 'string' ? shareNoteId : ''],
  ]
  if (SHARE_STATUSES.has(shareStatus)) tags.push(['share_status', shareStatus])
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
/**
 * The kind 1 a boost gets when THE SHOW signs it: a signed-out booster, or a
 * signed-in one who pressed Anon, left Private Boost unchecked, and so asked
 * the site to post for them. Signed by `/api/sign-boost` under the show key
 * (not a bot npub; Reed's call 2026-08-23) and published from the browser.
 *
 * ⚠️ THIS IS THE BOTS' STANDALONE NOTE, LINE FOR LINE. The show npub already
 * publishes one of these for every boost that lands on the node
 * (`bots/shared/boost_formatter.py#format_note_from_info`), so a note the site
 * signs must be indistinguishable from one the bot would have written: same
 * headline, same 💰 / 👤 / 💬 / 🎙️ / 🔗 lines, same tags as
 * `build_boost_claim_tags`. Change one and change the other.
 *
 * ⚠️ THE TYPED NAME IS PROSE AND NOTHING ELSE. It becomes the 👤 line and
 * never a `p`, an uppercase `P` or any author claim: nothing can verify that
 * the person named authorised a note signed by a key they do not hold. A
 * signed-in donor who pressed Anon gets the same treatment — Anon means no
 * pubkey on the note, not a pubkey on a note somebody else signed.
 *
 * ⚠️ NO `p` TAG, where the donor template carries one. The donor's note
 * mentions the show; this note IS the show, and the oracle refuses `p`
 * outright (a mention blast from an identity carrying our NIP-05 is the abuse
 * it exists to prevent).
 *
 * `functions/api/sign-boost.js#validateShowBoostTemplate` restates the
 * headline, the 💰 line and the tag allowlist; `scripts/test-sign-boost.mjs`
 * feeds it from this builder so a drift fails there.
 */
export const SHOW_NOTE_HEADLINE = '⚡ New boost on Local Bitcoiners!'
export const SHOW_NOTE_MAX_MESSAGE = 1500

export function buildShowSiteNoteTemplate({
  paidSats,
  message,
  senderName,     // typed name, or '' → the form's DEFAULT_SENDER_NAME
  episode,        // { number, title, guid?, fountainUrl? } — same as the donor template
  pageUrl,
  boostSession,
}) {
  const sats = Math.max(0, Math.round(Number(paidSats) || 0))
  const rawTitle = (episode?.title || '').trim()
  const title = rawTitle.length > MAX_TITLE_LEN
    ? rawTitle.slice(0, MAX_TITLE_LEN - 1) + '…'
    : rawTitle
  const from = sanitizeShowSender(senderName) || 'A Local Bitcoiner'
  const msg = String(message || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, SHOW_NOTE_MAX_MESSAGE)
  const epNum = episode?.number != null ? String(episode.number) : ''
  const episodeUrl = epNum ? `${SITE_URL}/ep${epNum.padStart(3, '0')}` : pageUrl

  const lines = [
    SHOW_NOTE_HEADLINE,
    `💰 ${sats.toLocaleString('en-US')} sats 📱 via localbitcoiners.com`,
    `👤 ${from}`,
  ]
  if (msg) lines.push(`💬 ${msg}`)
  if (title) lines.push(`🎙️ ${title}`)
  lines.push(`🔗 ${episodeUrl}`)
  lines.push('')
  lines.push('#LocalBitcoiners')

  const tags = [
    ['t', 'localbitcoiners'],
    ['t', 'boost'],
    ['t', 'podcast'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
    ['r', episodeUrl],
    ['client', 'localbitcoiners.com'],
    ['amount', String(sats * 1000)],
    ['i', `podcast:guid:${FEED_GUID}`],
    ['k', 'podcast:guid'],
  ]
  const epGuid = (episode?.guid || '').trim()
  if (epGuid) {
    tags.push(['i', `podcast:item:guid:${epGuid}`])
    tags.push(['k', 'podcast:item:guid'])
  }
  if (boostSession) tags.push(['boost_session', String(boostSession)])

  return { kind: 1, created_at: Math.floor(Date.now() / 1000), content: lines.join('\n'), tags }
}

/** Same bounds as `sanitizeSenderName` in externalBoostagram.js: no control
 *  characters (the body is read line by line), no 📱 (the `via` line is what
 *  `clients.py#_VIA_RE` parses), 40 characters. Restated rather than imported
 *  so this module keeps no dependency on the external-boost one. */
export const SHOW_SENDER_NAME_CHARS = 40
export function sanitizeShowSender(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\u{1F4F1}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SHOW_SENDER_NAME_CHARS)
    .trim()
}

export function buildEpisodeBoostShareTemplate({
  amountSats,
  message,
  episode,        // { number, title, guid?, fountainUrl? }
  pageUrl,
  boostSession,   // same uuid as the boost receipt's d tag
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
    // Topic tags NIP-73 boost consumers (OnlyBoosts, the community-feed
    // detectors) key on to tell a boost note from any other kind 1.
    ['t', 'boostagram'],
    ['t', 'value4value'],
    ['r', pageUrl],
    ['client', 'localbitcoiners.com'],
  ]
  if (RECIPIENT_PUBKEY_HEX) tags.push(['p', RECIPIENT_PUBKEY_HEX])
  if (fountainUrl) tags.push(['r', fountainUrl])
  // Machine-readable boost amount in millisats (NIP-57 convention). Without
  // it the amount lives only in the free-text content and consumers can't
  // parse it, so the note gets dropped as a boost. Total sent, not per-leg.
  tags.push(['amount', String(Math.round((Number(amountSats) || 0) * 1000))])
  // NIP-73 external-content tags: feed GUID always, episode item GUID when known.
  tags.push(['i', `podcast:guid:${FEED_GUID}`])
  tags.push(['k', 'podcast:guid'])
  const epGuid = (episode?.guid || '').trim()
  if (epGuid) {
    tags.push(['i', `podcast:item:guid:${epGuid}`])
    tags.push(['k', 'podcast:item:guid'])
  }
  // Ties this note to the boost's kind 30078 receipt (its d tag). If a note
  // published on the donor's behalf ever coexists with this one for the same
  // payment, this tag is the exact key the pair collapses on.
  if (boostSession) tags.push(['boost_session', String(boostSession)])

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
 * Publish an already-signed kind 1 share note to the donor's NDK outbox
 * relays AND to SHARE_NOTE_RELAYS, in parallel. Best-effort: resolves
 * `published: true` as soon as ANY relay on either side acks (the other
 * side keeps publishing in the background), and `false` only once both
 * sides have finished without an ack. Never throws.
 *
 * Resolving on first ack matters because the boost receipt waits on this
 * result: one fast relay should decide the outcome, not the slowest one.
 */
export async function publishSignedKindOne(signedEvent) {
  if (!signedEvent?.id || !signedEvent?.sig) return { published: false }
  const sides = [publishToOutbox(signedEvent), publishToShareRelays(signedEvent)]
  const published = await new Promise((resolve) => {
    let pending = sides.length
    for (const p of sides) {
      p.then((ok) => {
        if (ok) resolve(true)
        else if (--pending === 0) resolve(false)
      })
    }
  })
  return { published }
}

// The donor's own write relays, via NDK. Their followers read here.
async function publishToOutbox(signedEvent) {
  try {
    const ev = new NDKEvent(getNDK(), signedEvent)
    const ackd = await ev.publish()
    return !!(ackd && ackd.size > 0)
  } catch {
    return false
  }
}

// The boost-dense core set. Global indexers read here, so this is what
// makes a boost note discoverable within seconds rather than within a day.
async function publishToShareRelays(signedEvent) {
  try {
    const results = await Promise.allSettled(
      getPool().publish(SHARE_NOTE_RELAYS, signedEvent).map(p => withTimeout(p, 6000))
    )
    return results.some(r => r.status === 'fulfilled')
  } catch {
    return false
  }
}

// ─── Kind 1 boost share — donor's "I just boosted X" feed note ─────────────
/**
 * Optional second event published when the donor opts into "Share to feed."
 * Regular kind 1 note signed by the donor's real key, posted to their own
 * write relays so their followers see it natively, and to the core relays
 * global boost indexers scan.
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
  boostSession,   // same uuid as the boost receipt's d tag
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
    ['t', 'boostagram'],
    ['t', 'value4value'],
    ['r', pageUrl],
    ['client', 'localbitcoiners.com'],
  ]
  if (RECIPIENT_PUBKEY_HEX) tags.push(['p', RECIPIENT_PUBKEY_HEX])
  // Machine-readable boost amount in millisats (NIP-57 convention).
  tags.push(['amount', String(Math.round((Number(amountSats) || 0) * 1000))])
  // NIP-73 external-content tags. Show-level share: feed GUID only.
  tags.push(['i', `podcast:guid:${FEED_GUID}`])
  tags.push(['k', 'podcast:guid'])
  // Dedup key shared with the boost receipt — see buildEpisodeBoostShareTemplate.
  if (boostSession) tags.push(['boost_session', String(boostSession)])

  const ev = new NDKEvent(ndk, {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  })
  await signWithTimeout(ev)

  // Donor outbox plus the core relays, same as the pre-signed episode path.
  // Failures are non-fatal — the boost itself succeeded; the share is
  // best-effort.
  const { published } = await publishSignedKindOne(await ev.toNostrEvent())

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
/*
 * ⚠️ THIS FUNCTION NEVER REPORTS A PAYMENT AS FAILED, AND THAT IS THE WHOLE
 * POINT OF IT. It returns 'settled' or 'unknown', nothing else.
 *
 * LUD-21 has no negative signal. `settled: false` means "not settled AT THE
 * MOMENT I ASKED"; an invoice still in flight and an invoice that will never
 * land answer byte-identically. This used to return 'unsettled' whenever the
 * endpoint answered at least once, and both callers mapped that to a definitive
 * FAILED — which is the status with no re-pay guard on it. Measured against a
 * real boost on 2026-08-19: a leg to `chadf@getalby.com` settled after the
 * 4.5-second poll window closed, was reported "your wallet wasn't charged",
 * was re-paid by the donor on that advice, and the recipient received the
 * money TWICE.
 *
 * So the only honest answers are "I saw it settle" and "I don't know", and a
 * caller holding 'unknown' must never re-pay on the strength of it.
 *
 * (The one true negative signal is bolt11 expiry: an expired invoice provably
 * cannot settle. LNURL invoices are typically good for an hour, which is far
 * too long to hold a modal open for, so it is not used here.)
 *
 * `deadlineMs` runs the poll to a wall-clock budget instead of a fixed attempt
 * count, for the background watcher that keeps checking after the run ends.
 * `signal` aborts it when the modal unmounts.
 */
export async function confirmInvoiceSettled(verifyUrl, paymentHash, {
  attempts = 4, intervalMs = 1500, deadlineMs = null, signal = null,
} = {}) {
  if (typeof verifyUrl !== 'string' || !verifyUrl.startsWith('https://')) return 'unknown'
  const until = deadlineMs ? Date.now() + deadlineMs : null
  for (let i = 0; (i < attempts) || (until && Date.now() < until); i++) {
    if (signal?.aborted) return 'unknown'
    try {
      // Bounded per poll. The verify URL comes from the LNURL response
      // (third-party, only https-checked), and this function sits on every
      // ambiguous-payment path — an endpoint that accepts the connection
      // but never answers would otherwise stall settlement checks for
      // minutes on the browser's default fetch timeout.
      const res = await withTimeout(fetch(verifyUrl), 6000, 'verify-timeout')
      if (res.ok) {
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
    if (until && Date.now() + intervalMs >= until) break
    if (!until && i >= attempts - 1) break
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return 'unknown'
}
