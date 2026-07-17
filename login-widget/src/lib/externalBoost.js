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
  buildBoostagram,
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
function distributeSats(totalSats, recipients, totalWeight) {
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

function friendlyError(msg) {
  const s = String(msg || '')
  if (/not_implemented|not implemented|unsupported|method not found/i.test(s)) {
    return 'Your wallet doesn\'t support keysend payments. Try connecting Alby or Mutiny.'
  }
  if (/rejected|denied|declined/i.test(s)) return 'Payment declined in your wallet.'
  if (/insufficient|not enough|no funds|balance too low/i.test(s)) return 'Not enough balance in your wallet.'
  if (/expired/i.test(s)) return 'The invoice expired before it could be paid.'
  if (/no route|route not found|unable to find route/i.test(s)) return 'No payment route to this recipient.'
  return s.length > 140 ? s.slice(0, 140) + '…' : (s || 'Payment failed.')
}

// A clean decline means the payment definitively never left the wallet → safe
// to FAIL without a settlement round-trip. Anything else is ambiguous. On top
// of the shared classifier: keysend-capability errors (wallet can't keysend at
// all), which also mean nothing was sent.
function isCleanDecline(msg) {
  return isCleanPaymentDecline(msg) ||
    /not_implemented|not implemented|unsupported|method not found/i.test(String(msg || ''))
}

async function payLnaddressLeg(leg, ctx, update) {
  const meta = await fetchLnurlMeta(leg.recipient.address)
  const msats = leg.sats * 1000
  if (typeof meta.minSendable === 'number' && msats < meta.minSendable) {
    throw new Error(`This leg needs at least ${Math.ceil(meta.minSendable / 1000).toLocaleString()} sats — bump the boost.`)
  }
  if (typeof meta.maxSendable === 'number' && msats > meta.maxSendable) {
    throw new Error(`This leg accepts at most ${Math.floor(meta.maxSendable / 1000).toLocaleString()} sats.`)
  }
  const allowed = meta.commentAllowed || 0
  const comment = allowed > 0 ? (ctx.message || '').slice(0, Math.min(allowed, MAX_MESSAGE_CHARS)) : ''
  const { pr, verify } = await fetchLnurlInvoice(meta.callback, msats, comment)
  const paymentHash = bolt11PaymentHash(pr)
  update({ verifyUrl: verify || null, paymentHash })

  update({ status: STATUS.PAYING })
  let preimage = null
  let payError = null
  try {
    const res = await ctx.wal.payInvoice({ invoice: pr })
    preimage = res?.preimage || null
  } catch (e) { payError = e }

  if (preimage) return { status: STATUS.PAID }

  const msg = String(payError?.message || payError || '')
  if (isCleanDecline(msg)) return { status: STATUS.FAILED, error: friendlyError(msg) }

  // Ambiguous — never blind-fail an NWC leg (the reply can be lost while the
  // payment settles). Confirm via LUD-21 before deciding.
  const settled = await confirmInvoiceSettled(verify, paymentHash)
  if (settled === 'settled') return { status: STATUS.PAID }
  if (settled === 'unsettled') return { status: STATUS.FAILED, error: friendlyError(msg) || 'Payment did not settle.' }
  return { status: STATUS.UNCERTAIN, error: 'Couldn’t confirm this payment — check your wallet before retrying.' }
}

async function payKeysendLeg(leg, ctx, update) {
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

  update({ status: STATUS.PAYING })
  try {
    if (ctx.kind === 'nwc') {
      const client = nwc.getClient()
      const res = await client.payKeysend({
        amount: leg.sats * 1000,           // msats
        pubkey: leg.recipient.address,     // node pubkey
        preimage: randomPreimageHex(),
        tlv_records: toTlvHex(boostagram, leg.recipient),
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
        destination: leg.recipient.address,
        amount: leg.sats,
        customRecords: toWeblnRecords(boostagram, leg.recipient),
      })),
      90000,
      'Your wallet extension didn\'t respond to the keysend in time. It may still be going through — check your wallet before retrying.',
    )
    if (res?.preimage) return { status: STATUS.PAID }
    return { status: STATUS.UNCERTAIN, error: 'Couldn’t confirm this keysend — check your wallet.' }
  } catch (e) {
    const msg = String(e?.message || e)
    if (isCleanDecline(msg)) return { status: STATUS.FAILED, error: friendlyError(msg) }
    return { status: STATUS.UNCERTAIN, error: friendlyError(msg) }
  }
}

/**
 * Run an external boost.
 *
 * @param {object} p
 * @param {Array}  p.recipients   - [{ name, type:'node'|'lnaddress', address, splitWeight, customKey?, customValue? }]
 * @param {number} p.totalWeight
 * @param {number} p.totalSats
 * @param {string} [p.message]
 * @param {string} [p.senderName]
 * @param {string} [p.senderPubkey] - hex pubkey when signed in
 * @param {object} p.meta          - { showTitle, episodeTitle, podcastGuid, itemGuid, url }
 * @param {(index:number, patch:object)=>void} [p.onLeg]
 * @returns {Promise<{legs:Array, anyPaid:boolean, paidSats:number}>}
 */
export async function payExternalBoost({
  recipients, totalWeight, totalSats, message, senderName, senderPubkey, meta, onLeg,
}) {
  if (!wallet.isReady()) throw new Error('Connect a wallet first')
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('No recipients to pay')
  if (!(totalSats > 0)) throw new Error('Enter a boost amount')

  const kind = wallet.getStatus().kind
  const wal = wallet.getActiveWallet()
  const boostUuid = uuid4()
  const ctx = { kind, wal, message, senderName, senderPubkey, totalSats, boostUuid, meta }

  const legs = distributeSats(totalSats, recipients, totalWeight).map((l) => ({
    ...l, status: STATUS.PENDING, error: null, paymentHash: null, verifyUrl: null,
  }))

  activeBoosts++
  try {
    for (const leg of legs) {
      const update = (patch) => { Object.assign(leg, patch); onLeg?.(leg.index, { ...leg }) }

      if (leg.sats <= 0) { update({ status: STATUS.SKIPPED }); continue }

      try {
        const result = leg.recipient.type === 'lnaddress'
          ? await payLnaddressLeg(leg, ctx, update)
          : await payKeysendLeg(leg, ctx, update)
        update(result)
      } catch (e) {
        // Pre-payment failures (LNURL resolve, below-min, invoice fetch) — these
        // are definitively not-paid.
        update({ status: STATUS.FAILED, error: friendlyError(e?.message || e) })
      }
    }
  } finally {
    activeBoosts--
  }

  const paidLegs = legs.filter((l) => l.status === STATUS.PAID)
  return {
    legs,
    anyPaid: paidLegs.length > 0,
    paidSats: paidLegs.reduce((a, l) => a + l.sats, 0),
  }
}
