/**
 * External-episode boost orchestrator.
 *
 * DELIBERATELY SEPARATE from lib/payAllLegs.js (the LB boost path, the site's
 * #1 feature — untouched). This runs a Podcasting-2.0 V4V boost to another
 * podcast's value-block recipients:
 *   - lnaddress legs → LNURL-pay (reusing boostagram.js's stable leaf helpers)
 *   - node legs      → keysend (NWC pay_keysend / WebLN keysend) carrying the
 *                      boostagram as TLV 7629169 + the recipient's customKey/
 *                      customValue for shared-node routing.
 *
 * ⚠️ AND AN LNADDRESS LEG MAY BECOME A NODE LEG BEFORE IT IS PAID. Where the
 * address publishes `/.well-known/keysend/<name>` and the wallet can keysend,
 * `resolveKeysendUpgrade` swaps in the node the document names, so the
 * boostagram rides in the HTLC and reaches Helipad's first tier rather than
 * its third. See `keysendLookup.js` for what the upgrade is worth and for the
 * two rules that keep it from ever costing a payment: the wallet is asked
 * before the address, and `fountain.fm` is excluded despite qualifying. A
 * third rule lives in the leg loop below: a keysend the wallet cleanly
 * declines is re-paid as an invoice on the same leg.
 *
 * The probe adds one bounded round trip per distinct address, inside the leg
 * and therefore inside the wait. Prefetching it on mount beside the modal's
 * LNURL metadata is the follow-up if that ever shows; it is in the leg for now
 * because that is one place to get it wrong rather than two.
 *
 * Same best-effort model as payAllLegs: legs run sequentially (NWC reliability),
 * each in its own try/catch, and one failing leg never aborts the others — so a
 * wallet that can't keysend still pays the lnaddress legs (exactly how Boost Me
 * Bitch behaves). Never throws on partial failure; returns per-leg results.
 *
 * Wallet access is READ-ONLY against the existing facade: wallet.js for
 * status/payInvoice, nwc.getClient() for keysend, window.webln for WebLN
 * keysend. No wallet file is modified.
 */

import {
  fetchLnurlMeta,
  fetchLnurlInvoice,
  bolt11PaymentHash,
  confirmInvoiceSettled,
} from './boostagram.js'
import { withTimeout, isCleanPaymentDecline } from './utils.js'
import * as wallet from './wallet.js'
import * as nwc from './nwc.js'
import {
  lookupKeysendTarget,
  walletCanKeysend,
  noteKeysendUnsupported,
} from './keysendLookup.js'
import {
  buildBoostagram,
  buildLnurlComment,
  toTlvHex,
  toWeblnRecords,
  randomPreimageHex,
  MAX_MESSAGE_CHARS,
} from './externalBoostagram.js'

export const STATUS = {
  PENDING: 'pending',
  PAYING: 'paying',
  PAID: 'paid',
  FAILED: 'failed',
  SKIPPED: 'skipped',     // leg's proportional share rounded to 0 sats
  UNCERTAIN: 'uncertain', // paid attempt gave no clean preimage and we can't confirm
}

// Leave-page guard. LB boosts get this from boostQueue's beforeunload
// handler, but external boosts run outside that queue — without their own
// counter, navigating away mid-boost silently interrupts unpaid legs.
// Same standard incantation as boostQueue's.
let activeBoosts = 0
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (activeBoosts === 0) return
    e.preventDefault()
    e.returnValue = ''
    return ''
  })
}

/**
 * Per-leg phase timing.
 *
 * A boost that churns gives no account of itself: the modal shows one spinner
 * per leg and the console shows nothing, so a slow leg is indistinguishable
 * from a slow LNURL host, a slow wallet relay and a slow wallet. Splitting the
 * leg into its phases is the difference between reasoning about which one it
 * was and reading it. `pay` is the NWC round trip — the request event out to
 * the wallet's relay and the wallet's reply back — and the wallet does not
 * reply until the payment has settled, so a large number there is the wallet
 * or the route, never this file.
 *
 * Unconditional console.info rather than a debug flag: a boost is a handful of
 * lines, it only runs on an explicit click, and the one time anyone wants
 * these is a boost that already happened.
 */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function legTimer() {
  const start = now()
  let last = start
  const phases = []
  return {
    mark(name) {
      const t = now()
      phases.push(`${name} ${Math.round(t - last)}ms`)
      last = t
    },
    summary() {
      return { totalMs: Math.round(now() - start), phases: phases.join(', ') }
    },
  }
}

/** UUID4 tying every leg of one boost together (boostagram `uuid`). */
function uuid4() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Distribute whole sats across recipients by weight. Floors each share to a
 * whole sat (LNURL endpoints reject sub-sat amounts), then hands the leftover
 * sats out one at a time to the largest-weight legs so rounding never starves
 * the biggest recipient.
 */
/**
 * The split, computed with no network and no wallet. Exported because the modal
 * needs to know **before paying** how many legs will actually be attempted, so
 * it can pre-sign a note whose figures are right for the clean case.
 *
 * ⚠️ THE REMAINDER LOOP IS WHAT MAKES THAT SOUND. Every leg floors, then the
 * shortfall is handed back a sat at a time, so the legs sum to `totalSats`
 * exactly. A leg allocated zero is SKIPPED and contributes zero. Therefore **if
 * every attempted leg pays, `paidSats === totalSats`** — which is the identity a
 * pre-signed note stakes itself on. Change the rounding here and that note
 * silently starts overstating; the caller re-checks the equality before
 * publishing, and that check is the guard, not this comment.
 */
export function distributeSats(totalSats, recipients, totalWeight) {
  const legs = recipients.map((r, index) => ({
    recipient: r,
    index,
    sats: Math.floor((totalSats * r.splitWeight) / totalWeight),
  }))
  let remainder = totalSats - legs.reduce((a, l) => a + l.sats, 0)
  const byWeight = [...legs].sort((a, b) => b.recipient.splitWeight - a.recipient.splitWeight)
  let i = 0
  while (remainder > 0 && byWeight.length) { byWeight[i % byWeight.length].sats += 1; remainder--; i++ }
  return legs
}

// The signature of a wallet saying it cannot keysend at all, as opposed to
// declining this particular payment. Three readers now — the friendly message,
// the clean-decline test, and the capability latch that stops later legs being
// upgraded — so it is one expression rather than three copies that drift.
const KEYSEND_UNSUPPORTED_RE = /not_implemented|not implemented|unsupported|method not found/i

function friendlyError(msg) {
  const s = String(msg || '')
  if (KEYSEND_UNSUPPORTED_RE.test(s)) {
    return 'Your wallet doesn\'t support keysend payments. Try connecting Alby or Mutiny.'
  }
  if (/rejected|denied|declined/i.test(s)) return 'Payment declined in your wallet.'
  if (/insufficient|not enough|no funds|balance too low/i.test(s)) return 'Not enough balance in your wallet.'
  if (/expired/i.test(s)) return 'The invoice expired before it could be paid.'
  if (/no route|route not found|unable to find route/i.test(s)) return 'No payment route to this recipient.'
  return s.length > 140 ? s.slice(0, 140) + '…' : (s || 'Payment failed.')
}

/**
 * ⚠️ THE WALLET'S OWN FAILURE CODES, WHICH THE SHARED CLASSIFIER MISSES ON A
 * TECHNICALITY: IT LOOKS FOR `no route` AND NIP-47 SAYS `NO_ROUTE`.
 *
 * Observed on a real boost, 2026-08-22. An upgraded keysend leg to
 * `podcastindex@getalby.com` came back `Nip47WalletError:
 * FAILURE_REASON_NO_ROUTE` — the node the address names has no public channel
 * record, which is the exact case the invoice fallback was built for. The
 * underscore meant `isCleanPaymentDecline` did not match, so the leg was
 * classified UNCERTAIN instead of FAILED, and UNCERTAIN is the one status with
 * no way out: the fallback is gated on FAILED, Retry is gated on FAILED, and
 * "Check again" needs a verify URL a keysend has never had. **The donor was
 * left looking at a leg with no action available at all.** Reed reported it as
 * a leg that failed and offered no retry, which is precisely what it was.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT IN THIS LIST IS THE WHOLE OF ITS SAFETY.
 * `FAILURE_REASON_TIMEOUT` means the attempt ran out of time, and an HTLC in
 * flight when the clock expired can still settle — treating it as a clean
 * decline would offer a re-pay on a payment that may land, which is the
 * 2026-08-19 double payment. `FAILURE_REASON_ERROR` is a catch-all and says
 * nothing about settlement. Both stay ambiguous, and so does anything not
 * named here. **Only add a code whose meaning is that no HTLC survived.**
 */
const WALLET_CLEAN_FAILURE_RE =
  /FAILURE_REASON_(NO_ROUTE|INSUFFICIENT_BALANCE|INCORRECT_PAYMENT_DETAILS)/i

// A clean decline means the payment definitively never left the wallet → safe
// to FAIL without a settlement round-trip. Anything else is ambiguous. On top
// of the shared classifier: keysend-capability errors (wallet can't keysend at
// all) and the wallet failure codes above, both of which mean nothing was sent.
//
// ⚠️ The same gap exists in `payAllLegs.js`, which reads the shared classifier
// directly. It is not patched here because nothing on this fork calls that path
// (see the dead-code note in CLAUDE.md) and the direction of its error is the
// safe one: a missed clean decline reports UNCERTAIN, which offers no re-pay.
function isCleanDecline(msg) {
  const s = String(msg || '')
  return isCleanPaymentDecline(s) ||
    KEYSEND_UNSUPPORTED_RE.test(s) ||
    WALLET_CLEAN_FAILURE_RE.test(s)
}

/** Exported for `scripts/test-keysend-upgrade.mjs`, which pins the real
 *  `FAILURE_REASON_NO_ROUTE` string observed in production. */
export { isCleanDecline as _isCleanDeclineForTests }

/**
 * Store this leg's boostagram with BoostBox and return the URL a podcaster's
 * Helipad can read it back from, or `''` if anything at all went wrong.
 *
 * ⚠️ IT NEVER THROWS AND NEVER REJECTS, AND THAT IS THE WHOLE CONTRACT. It runs
 * inside a leg the donor is watching pay, one leg at a time, so a hang here is
 * a hang in the boost. Every outcome — unconfigured key, rate limit, upstream
 * refusal, timeout, a body that will not parse — resolves to the empty string,
 * and the comment falls back to the bare message. **Metadata is a courtesy to
 * the recipient; the payment is the point.**
 *
 * ⚠️ IT IS SKIPPED ON A SITE DONATION. The descriptor exists so a PODCASTER can
 * resolve who boosted them; on a donation Local Bitcoiners is the recipient, so the
 * record would be metadata about ourselves.
 *
 * ⚠️ AND IT GOES THROUGH OUR OWN EDGE, NOT STRAIGHT TO TARDBOX. Not for CORS —
 * tardbox sends `access-control-allow-origin: *` and would answer the browser
 * fine — but because the API key is ours by name and a key in a public bundle
 * is a key anyone can write records with. See `functions/api/boostbox.js`.
 */
/** A leg's share as the value block declares it, or null when the weights are
 *  not knowable. Never computed from the paid sats; see the call site. */
function legSplitPercent(leg, ctx) {
  const weight = Number(leg.recipient?.splitWeight)
  const total = Number(ctx.totalWeight)
  if (!Number.isFinite(weight) || !Number.isFinite(total) || total <= 0) return null
  const pct = Math.round((weight / total) * 100)
  return pct > 0 && pct <= 100 ? pct : null
}

const DESCRIPTOR_TIMEOUT_MS = 7_000

async function fetchBoostDescriptor(leg, ctx) {
  if (ctx.donation) return ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DESCRIPTOR_TIMEOUT_MS)
  try {
    const res = await fetch('/api/boostbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        value_msat: leg.sats * 1000,
        // ⚠️ THE FIGURE THAT WAS MISSING. Without it Helipad computes the split
        // against the leg's own amount and renders every boost as "(100% split)",
        // so a podcaster is shown one leg's sats as the whole thing.
        value_msat_total: (ctx.totalSats || leg.sats) * 1000,
        // ⚠️ THE DECLARED SPLIT, NOT THE REALISED ONE. `distributeSats` floors
        // each leg, so a 33% leg of 111 sats is 36 and reads back as 32.4% —
        // and the edge, deriving from the two amounts, published `32` where the
        // show's own value block says `33`. Every other app reports the number
        // the publisher declared, which is what makes rows comparable across
        // apps, so that is the number that travels. The edge still bounds it and
        // still derives one when it is absent.
        split: legSplitPercent(leg, ctx),
        message: ctx.message || '',
        sender_name: ctx.senderName || '',
        recipient_name: leg.recipient?.name || '',
        recipient_address: leg.recipient?.address || '',
        // ⚠️ `feed_title` / `item_title`, NEVER `podcast` / `episode`. Those are
        // the BOOSTAGRAM TLV's names for the same two facts, and this document
        // is not a boostagram — Helipad deserializes an `RssPayment` with nine
        // fields and maps `feed_title` onto its own `podcast` and `item_title`
        // onto its own `episode` (src/metadata.rs). Sending the TLV names put
        // both strings in the record, where BoostBox stored them faithfully and
        // Helipad ignored them, so the row rendered with a sender and a total
        // and no show. Verified live 2026-08-22.
        feed_title: ctx.meta?.showTitle || '',
        item_title: ctx.meta?.episodeTitle || '',
        // ⚠️ THE GUIDS GO IN TWICE ON PURPOSE. `feed_guid` / `item_guid` are
        // BoostBox's own documented fields and are what its web page shows;
        // `remote_feed_guid` / `remote_item_guid` are the only two guid fields
        // in Helipad's struct, and are what it resolves against Podcast Index
        // to turn the show and episode into a link. BMB sends exactly this
        // duplication, and it is the reference implementation the podcaster on
        // the other end of this is already running.
        feed_guid: ctx.meta?.podcastGuid || '',
        item_guid: ctx.meta?.itemGuid || '',
        remote_feed_guid: ctx.meta?.podcastGuid || '',
        remote_item_guid: ctx.meta?.itemGuid || '',
        // Groups the legs of one boost, so a podcaster reading four payments
        // can see they were one press rather than four boosts.
        group: ctx.boostUuid || '',
        url: ctx.meta?.url || '',
      }),
    })
    if (!res.ok) {
      // ⚠️ THE FAILURE IS ANNOUNCED, BECAUSE ITS SYMPTOM IS INVISIBLE. A missing
      // descriptor is deliberately not fatal: the leg pays, the message still
      // arrives, and the only trace is a row in someone else's Helipad reading
      // "Lightning Invoice" instead of a name. Nothing on this side looks
      // wrong, so without this line the next person debugging it is back to
      // reasoning about a payment that already happened.
      console.warn('[lb] boost descriptor refused', res.status, await res.text().catch(() => ''))
      return ''
    }
    const body = await res.json()
    const url = typeof body?.url === 'string' ? body.url : ''
    if (!url) console.warn('[lb] boost descriptor returned no url', body)
    return url
  } catch (e) {
    console.warn('[lb] boost descriptor unavailable', e?.name === 'AbortError' ? 'timed out' : (e?.message || e))
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Can this lnaddress leg be paid as a keysend instead, and to what?
 *
 * ⚠️ THE DECISION IS MADE BEFORE THE PAYMENT, AND AFTERWARDS IT IS REVISITED
 * IN EXACTLY ONE CASE: a CLEAN DECLINE, which is this file's definition of the
 * payment never having left the wallet. Anything else — above all an
 * `UNCERTAIN` leg — is never re-paid on any rail, because there is no
 * observation proving a keysend did not go out. See the fallback in the leg
 * loop for the whole argument. So the questions below are still asked up
 * front, and the pubkey is still validated strictly in `keysendLookup.js`:
 * the fallback is a safety net for a routing failure, not a licence to be
 * careless about what gets attempted.
 *
 * ⚠️ AND THE ORDER OF THE TWO IS DELIBERATE. The wallet is asked FIRST because
 * its answer is cached for the session and disqualifies every leg at once,
 * where the address probe is per-recipient. On a wallet that cannot keysend
 * this costs one lookup for the whole boost rather than one per leg.
 *
 * Returns a node-shaped recipient, or null to stay on LNURL.
 */
async function resolveKeysendUpgrade(leg, timer) {
  let target = null
  try {
    if (await walletCanKeysend()) target = await lookupKeysendTarget(leg.recipient.address)
  } catch {
    // Neither helper is supposed to throw. If one ever does, the leg is
    // unaffected: this is an upgrade with a working fallback, and the fallback
    // is what shipped before the upgrade existed.
    target = null
  }
  timer?.mark('keysend-probe')
  if (!target) return null
  // ⚠️ BUILT FIELD BY FIELD, NEVER SPREAD FROM THE ORIGINAL. A value block may
  // name a `customKey` / `customValue` of its own, and that pair routes to a
  // sub-account on the node the value block named — which is not the node this
  // document names. Carrying it across would address a stranger's account on
  // the provider's node. The document's pair is the only routing record that
  // means anything at this destination, and `firstCustomPair` guarantees it
  // was taken whole.
  return {
    name: leg.recipient.name,
    type: 'node',
    address: target.pubkey,
    customKey: target.customKey,
    customValue: target.customValue,
  }
}

async function payLnaddressLeg(leg, ctx, update, timer) {
  // Prefer the modal's prefetched metadata over a fresh fetch. The modal
  // resolves every lnaddress recipient in parallel on mount, so by boost time
  // most legs already have theirs. A cache miss — or a null, which is what the
  // modal stores when its own fetch failed — falls through to a live fetch, so
  // this is a saving and never a dependency. Same arrangement as payAllLegs.
  let meta = ctx.lnurlCache?.[leg.recipient.address] || null
  if (!meta) meta = await fetchLnurlMeta(leg.recipient.address)
  timer?.mark('meta')
  const msats = leg.sats * 1000
  if (typeof meta.minSendable === 'number' && msats < meta.minSendable) {
    throw new Error(`This leg needs at least ${Math.ceil(meta.minSendable / 1000).toLocaleString()} sats — bump the boost.`)
  }
  if (typeof meta.maxSendable === 'number' && msats > meta.maxSendable) {
    throw new Error(`This leg accepts at most ${Math.floor(meta.maxSendable / 1000).toLocaleString()} sats.`)
  }
  // ⚠️ THE ONLY CHANNEL THIS LEG HAS. A keysend carries its boostagram inline in
  // the TLV and reaches Helipad's first tier; an lnaddress leg has nothing but
  // the LNURL comment, which lands in Helipad's third tier as
  // `sender = "Lightning Invoice"` with the split reading 100% because the
  // total never travelled. A BoostBox descriptor in the comment is what closes
  // that: Helipad HEADs the URL and reads the whole boostagram back.
  //
  // ⚠️ IT IS FETCHED BEFORE THE INVOICE AND IS NEVER ALLOWED TO STOP ONE. Every
  // failure path resolves to an empty string, and `buildLnurlComment` then
  // sends the bare message — which is exactly what shipped before this existed.
  const allowed = meta.commentAllowed || 0
  const descriptorUrl = allowed > 0 ? await fetchBoostDescriptor(leg, ctx) : ''
  timer?.mark('descriptor')
  const comment = buildLnurlComment({ descriptorUrl, message: ctx.message, commentAllowed: allowed })
  // Says which of the three outcomes this leg got, since the difference is only
  // ever visible at the recipient's end: no comment allowed, a bare message, or
  // a message behind a descriptor.
  console.debug('[lb] leg comment', leg.recipient?.address, { commentAllowed: allowed, descriptor: descriptorUrl || null, comment })
  const { pr, verify } = await fetchLnurlInvoice(meta.callback, msats, comment, leg.recipient.address)
  timer?.mark('invoice')
  const paymentHash = bolt11PaymentHash(pr)
  update({ verifyUrl: verify || null, paymentHash })

  // ⚠️ `startedAt` is stamped where the WAIT actually is: the moment the wallet
  // is handed the invoice. Measured on a real boost, 2026-08-19, one leg spent
  // **45.5 seconds inside `sendPayment`** while its two siblings took 2.3s and
  // 0.4s through the same extension. Nothing here can hurry that or observe
  // progress inside it, so the only honest thing to do is say how long it has
  // been going. See PAY_STAGES in ExternalBoostModal.
  update({ status: STATUS.PAYING, startedAt: Date.now() })
  let preimage = null
  let payError = null
  try {
    const res = await ctx.wal.payInvoice({ invoice: pr })
    preimage = res?.preimage || null
  } catch (e) { payError = e }
  timer?.mark('pay')

  if (preimage) return { status: STATUS.PAID }

  const msg = String(payError?.message || payError || '')
  if (isCleanDecline(msg)) return { status: STATUS.FAILED, error: friendlyError(msg) }

  // Ambiguous — never blind-fail an NWC leg (the reply can be lost while the
  // payment settles). Confirm via LUD-21 before deciding.
  //
  // ⚠️ A NON-SETTLEMENT IS NOT A FAILURE. Once the wallet has been handed this
  // invoice there is no observation that proves it did not pay, so the only
  // outcomes here are PAID and UNCERTAIN. The modal keeps polling this leg in
  // the background and flips it to PAID if it lands late; until then it offers
  // "Check again" and NOT a re-pay. See confirmInvoiceSettled.
  const settled = await confirmInvoiceSettled(verify, paymentHash)
  timer?.mark('verify')
  if (settled === 'settled') return { status: STATUS.PAID }
  // ⚠️ This is the leg's RESTING message, not its waiting message. The modal
  // starts a background watch on every checkable leg and suppresses this text
  // for as long as that runs (see CHECK_STAGES in ExternalBoostModal), so what
  // this string has to serve is the leg nothing is watching: a keysend, or a
  // provider that returned no verify URL. It must therefore not claim that
  // checking is under way, which the previous wording did.
  return { status: STATUS.UNCERTAIN, error: 'Not confirmed yet. Don’t re-send it — it may already be on its way.' }
}

/**
 * @param {object} [upgraded] - the synthetic node recipient an upgraded
 *   lnaddress leg pays to. Absent for a leg the value block already declared
 *   as `type: 'node'`.
 */
async function payKeysendLeg(leg, ctx, update, timer, upgraded) {
  // ⚠️ THE DESTINATION MAY NOT BE THE RECIPIENT THE MODAL IS SHOWING, and only
  // this variable knows it. `leg.recipient` stays exactly as the value block
  // published it — the lightning address is what the donor sees, what a retry
  // is issued against, and what the boostagram credits — while `dest` is where
  // the sats are actually addressed.
  const dest = upgraded || leg.recipient
  const boostagram = buildBoostagram({
    legMsats: leg.sats * 1000,
    totalMsats: ctx.totalSats * 1000,
    message: ctx.message,
    senderName: ctx.senderName,
    senderPubkey: ctx.senderPubkey,
    recipientName: leg.recipient.name,
    boostUuid: ctx.boostUuid,
    ...ctx.meta,
  })

  update({ status: STATUS.PAYING, startedAt: Date.now() })
  try {
    if (ctx.kind === 'nwc') {
      const client = nwc.getClient()
      const res = await client.payKeysend({
        amount: leg.sats * 1000,           // msats
        pubkey: dest.address,              // node pubkey
        preimage: randomPreimageHex(),
        tlv_records: toTlvHex(boostagram, dest),
      })
      if (res?.preimage) return { status: STATUS.PAID }
      // No preimage but no throw — we supplied one, so it likely settled, but
      // there's no verify URL for keysend. Don't claim success we can't prove.
      return { status: STATUS.UNCERTAIN, error: 'Couldn’t confirm this keysend — check your wallet.' }
    }
    // WebLN keysend — amount in SATS, plain-string custom records.
    // Bounded like webln.payInvoice: a wedged extension (broken worker,
    // unrendered approval popup) otherwise hangs this promise forever and
    // the external boost modal spins on "paying" with no exit. Generous
    // 90s because keysend can legitimately block on a human approving a
    // popup. On timeout we land in the catch below, where a non-clean-
    // decline message maps to UNCERTAIN — never a "wasn't charged" claim.
    if (!window.webln) throw new Error('No WebLN provider')
    const res = await withTimeout(
      Promise.resolve(window.webln.keysend({
        destination: dest.address,
        amount: leg.sats,
        customRecords: toWeblnRecords(boostagram, dest),
      })),
      90000,
      'Your wallet extension didn\'t respond to the keysend in time. It may still be going through — check your wallet before retrying.',
    )
    if (res?.preimage) return { status: STATUS.PAID }
    return { status: STATUS.UNCERTAIN, error: 'Couldn’t confirm this keysend — check your wallet.' }
  } catch (e) {
    const msg = String(e?.message || e)
    // ⚠️ WHAT THE WALLET ITSELF SAID OUTRANKS WHAT IT ADVERTISED. A capability
    // error is the one measurement about keysend support that cannot be wrong,
    // so it is latched here and no later leg of this boost is upgraded. It
    // matters most for the leg it just cost: that leg is FAILED, so it carries
    // a Retry, and the retry re-enters with the latch set and pays over LNURL.
    if (KEYSEND_UNSUPPORTED_RE.test(msg)) noteKeysendUnsupported()
    if (isCleanDecline(msg)) return { status: STATUS.FAILED, error: friendlyError(msg) }
    return { status: STATUS.UNCERTAIN, error: friendlyError(msg) }
  } finally {
    // finally, not a mark per return: the try/catch has six of them, and a
    // keysend has no phase before the payment to separate out anyway.
    timer?.mark('pay')
  }
}

/**
 * Run an external boost.
 *
 * @param {object} p
 * @param {Array}  p.recipients   - [{ name, type:'node'|'lnaddress', address, splitWeight, customKey?, customValue? }]
 *                                   Passed through untouched: an upgraded leg
 *                                   builds its own destination and never
 *                                   rewrites the recipient the modal shows.
 * @param {number} p.totalWeight
 * @param {number} p.totalSats
 * @param {string} [p.message]
 * @param {string} [p.senderName]
 * @param {string} [p.senderPubkey] - hex pubkey when signed in
 * @param {object} p.meta          - { showTitle, episodeTitle, podcastGuid, itemGuid, url }
 * @param {object} [p.lnurlCache]  - { [lnaddress]: lnurlMeta|null } prefetched by
 *                                   the modal on mount. Optional in both
 *                                   directions: a missing entry, a null entry
 *                                   and no cache at all all fall through to a
 *                                   live fetch inside the leg.
 * @param {(index:number, patch:object)=>void} [p.onLeg]
 * @returns {Promise<{legs:Array, anyPaid:boolean, paidSats:number}>}
 */
export async function payExternalBoost({
  recipients, totalWeight, totalSats, message, senderName, senderPubkey, meta, donation, lnurlCache, onLeg,
}) {
  if (!wallet.isReady()) throw new Error('Connect a wallet first')
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('No recipients to pay')
  if (!(totalSats > 0)) throw new Error('Enter a boost amount')

  const kind = wallet.getStatus().kind
  const wal = wallet.getActiveWallet()
  const boostUuid = uuid4()
  // ⚠️ `donation` AND `totalWeight` BOTH RIDE THE CONTEXT, and both were missing
  // from the first version of the descriptor work. A parameter that is accepted
  // by the caller but never destructured here is silently `undefined` in every
  // leg: the donation skip never fired, and the declared split was unavailable
  // so it had to be re-derived from already-rounded sats.
  const ctx = { kind, wal, message, senderName, senderPubkey, totalSats, totalWeight, boostUuid, meta, donation, lnurlCache }

  const legs = distributeSats(totalSats, recipients, totalWeight).map((l) => ({
    ...l, status: STATUS.PENDING, error: null, paymentHash: null, verifyUrl: null,
  }))

  activeBoosts++
  const startedAt = now()
  try {
    for (const leg of legs) {
      const update = (patch) => { Object.assign(leg, patch); onLeg?.(leg.index, { ...leg }) }

      if (leg.sats <= 0) {
        update({ status: STATUS.SKIPPED })
        // Logged despite having nothing to time, so the console carries one
        // line per leg and a missing number never has to be accounted for.
        console.info(`[lb-boost] leg ${leg.index + 1}/${legs.length} ${leg.recipient.address} → skipped (0 sats)`)
        continue
      }

      const timer = legTimer()
      try {
        // ⚠️ AN UPGRADED LEG IS A KEYSEND LEG IN EVERY RESPECT AFTER THIS
        // LINE. It runs the branch the value block's own node recipients have
        // always run, so the boostagram builder, the TLV encoding, the WebLN
        // and NWC calls and the UNCERTAIN rules are all untouched by this
        // feature — the whole of the change is which destination it is handed.
        const upgraded = leg.recipient.type === 'lnaddress'
          ? await resolveKeysendUpgrade(leg, timer)
          : null
        if (upgraded) leg.keysendUpgrade = true
        let result = (leg.recipient.type === 'lnaddress' && !upgraded)
          ? await payLnaddressLeg(leg, ctx, update, timer)
          : await payKeysendLeg(leg, ctx, update, timer, upgraded)

        // ⚠️ AN UPGRADED LEG THAT WAS CLEANLY DECLINED GOES BACK TO THE
        // INVOICE, AND THE `FAILED` TEST IS THE WHOLE SAFETY ARGUMENT.
        //
        // An invoice carries route hints and reaches a node behind
        // unannounced channels; a keysend to a bare pubkey has none and can be
        // refused where the invoice would have paid. Measured 2026-08-22, one
        // address in the top-30 corpus (`podcastindex@getalby.com`) names a
        // node with no public channel record at all, which is exactly that
        // shape. Without this the upgrade trades that leg's payment for
        // metadata, which is the wrong way round.
        //
        // ⚠️ `FAILED` HERE CAN ONLY HAVE COME FROM `isCleanDecline`, which is
        // this file's standing definition of "the payment never left the
        // wallet" — and the site already bets on it: a clean decline is what
        // puts a **Retry that re-pays** in front of the donor. So paying the
        // invoice here is exactly as safe as the button that already ships.
        // The one thing that is new is that nobody had to press it.
        //
        // ⚠️ AND `UNCERTAIN` MUST NEVER REACH THIS BRANCH. That status means an
        // attempt was made and nothing observable came back, so re-paying it is
        // the 2026-08-19 double payment. There is no re-pay out of UNCERTAIN
        // anywhere on this site and this is not the exception.
        if (upgraded && result.status === STATUS.FAILED) {
          console.info(
            `[lb-boost] leg ${leg.index + 1}/${legs.length} keysend declined ` +
            `(${result.error || 'no reason given'}) → paying the invoice instead`,
          )
          leg.keysendFellBack = true
          // The descriptor runs on this path, so the leg still reaches
          // Helipad's second tier rather than dropping to the bare message.
          result = await payLnaddressLeg(leg, ctx, update, timer)
        }
        update(result)
      } catch (e) {
        // Pre-payment failures (LNURL resolve, below-min, invoice fetch) are
        // definitively not-paid, and today that is everything that reaches
        // here — nothing throws out of the leg helpers once they have asked a
        // wallet to pay.
        //
        // ⚠️ BUT THAT IS AN ARGUMENT ABOUT TODAY'S CALL GRAPH, AND THE COST OF
        // IT BECOMING UNTRUE IS A RECIPIENT PAID TWICE. `paymentHash` is set
        // the moment an invoice exists, so it is the structural test for
        // "something may be in flight": past that point an exception is
        // ignorance, not evidence, and the leg is UNCERTAIN — which carries no
        // re-pay button. Same rule as confirmInvoiceSettled.
        // ⚠️ A REASON FROM THE RECIPIENT'S OWN SERVER IS USED VERBATIM AND
        // ATTRIBUTED, never run through friendlyError. That function rewrites
        // on keywords — a provider whose message happens to contain "declined"
        // or "expired" would be reported to the donor as *their wallet*
        // declining, which is a lie about whose fault it is and sends them to
        // check the wrong thing.
        const detail = e?.lnurlReason
          ? `Their Lightning provider said: ${e.lnurlReason}`
          : friendlyError(e?.message || e)
        update(leg.paymentHash
          ? { status: STATUS.UNCERTAIN, error: detail }
          : { status: STATUS.FAILED, error: detail })
      }
      const { totalMs, phases } = timer.summary()
      // Address rather than name: `name` is empty on most value blocks (the
      // show's own leg usually carries none), and the address is public data
      // straight out of the feed either way.
      console.info(
        `[lb-boost] leg ${leg.index + 1}/${legs.length} ${leg.recipient.type}` +
        // Says which of the two rails this leg actually took. Without it an
        // upgraded leg is indistinguishable from an LNURL one in the log, and
        // whether the upgrade fired is the first thing anyone debugging a
        // podcaster's missing Helipad row needs to know.
        `${leg.keysendUpgrade ? (leg.keysendFellBack ? '→keysend→invoice' : '→keysend') : ''} ` +
        `${leg.recipient.address} ${leg.sats} sats → ${leg.status} in ${totalMs}ms` +
        (phases ? ` (${phases})` : ''),
      )
    }
  } finally {
    activeBoosts--
  }

  const paidLegs = legs.filter((l) => l.status === STATUS.PAID)
  console.info(
    `[lb-boost] ${legs.length} legs via ${kind} in ${Math.round(now() - startedAt)}ms: ` +
    `${paidLegs.length} paid, ${paidLegs.reduce((a, l) => a + l.sats, 0)} of ${totalSats} sats`,
  )
  return {
    legs,
    anyPaid: paidLegs.length > 0,
    paidSats: paidLegs.reduce((a, l) => a + l.sats, 0),
  }
}
