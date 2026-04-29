/**
 * Multi-leg episode boost orchestrator.
 *
 * Given the recipients pulled from an RSS <podcast:value> block plus a
 * total amount, fan out N parallel LNURL+pay legs:
 *   1. Compute weight-proportional msats for each recipient.
 *   2. For each leg in parallel:
 *      a. Resolve the recipient's lud16 → LNURL endpoint (.well-known/lnurlp).
 *      b. Request a bolt11 invoice with comment = LocalBitcoinersEpNNN.
 *      c. Extract payment_hash from the bolt11.
 *      d. Build + sign a kind 30078 with the burner key, including the
 *         per-leg tags (recipient, amount, leg N/total) plus the shared
 *         episode + boost_session context tags. Publish to the V4V 2.0
 *         relay set.
 *      e. Pay the invoice via NWC.
 *   3. Per-leg status callback fires after each transition (resolving →
 *      requesting → publishing → paying → paid|failed) so the modal can
 *      render live progress dots.
 *
 * Best-effort semantics:
 *   - Splits aren't atomic in Lightning. If one leg fails (lud16 down,
 *     wallet rejects, relay error), other legs still proceed. Caller
 *     reports per-leg outcomes and decides whether to surface a retry.
 *   - The whole orchestrator never throws on partial failure; it returns
 *     an array of per-leg results. Throwing would abort the modal and
 *     leave the donor wondering whether anything was paid.
 *
 * Key reuse:
 *   - One burner secret key signs all legs of a single boost session.
 *     This intentionally lets a recipient bot enumerate "all legs of
 *     the same boost" by author pubkey — useful for analytics — without
 *     leaking donor identity (the pubkey is throwaway and never resaved).
 *   - One UUID4 in boost_session ties legs together for the boost wall's
 *     session-level dedup.
 */

import { generateBurnerKeypair } from './boostagram.js'
import {
  fetchLnurlMeta,
  fetchLnurlInvoice,
  bolt11PaymentHash,
  publishDonationBoostagram,
} from './boostagram.js'
import { formatEpisodeComment } from './episodeData.js'

/**
 * Compute weight-proportional msats for each recipient.
 *
 * Splits in the Podcasting 2.0 spec are weights, not percentages. They
 * usually sum to 100 (the LB feed does), but the spec doesn't require
 * it. We sum the actual weights and apportion proportionally.
 *
 * Each leg's msats is floored to a whole sat (1000-msat boundary). Some
 * LNURL endpoints — Fountain in particular — reject sub-sat amounts
 * with "please specify a valid amount in millisats" even though the
 * amount is technically valid as msats. Whole-sat amounts are
 * universally accepted, so we round at the source.
 *
 * The rounding-loss remainder (also rounded to whole sats) is added to
 * the leg with the largest base share, so smallest-leg recipients
 * (often near LNURL minSendable) aren't squeezed below their floor.
 */
function distributeMsats(totalMsats, recipients, totalWeight) {
  const legs = recipients.map((r, i) => {
    const share = (totalMsats * r.splitWeight) / totalWeight
    return {
      recipient: r,
      index: i,
      msats: Math.floor(share / 1000) * 1000,
    }
  })
  const distributed = legs.reduce((acc, l) => acc + l.msats, 0)
  const remainder = Math.floor((totalMsats - distributed) / 1000) * 1000
  if (remainder > 0 && legs.length > 0) {
    let maxIdx = 0
    for (let i = 1; i < legs.length; i++) {
      if (legs[i].msats > legs[maxIdx].msats) maxIdx = i
    }
    legs[maxIdx].msats += remainder
  }
  return legs
}

/** Generate a UUID4 we can use for the boost_session tag. */
function uuid4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for ancient environments — not worth the bytes for production
  // but the dev server might run somewhere that doesn't have it.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

const STATUSES = {
  PENDING: 'pending',
  RESOLVING: 'resolving',     // fetching lnurl metadata
  REQUESTING: 'requesting',   // requesting invoice
  PUBLISHING: 'publishing',   // publishing kind 30078
  PAYING: 'paying',           // payInvoice in flight
  PAID: 'paid',
  FAILED: 'failed',
}

/**
 * Run a single leg end-to-end. Reports status via `onStatus(legIndex, patch)`.
 * Returns the leg result (resolved or failed) — never throws.
 */
async function runLeg({
  leg,
  comment,
  donorNpub,
  pageUrl,
  episodeMeta,
  boostSession,
  legCount,
  burnerSk,
  nwcClient,
  message,
  onStatus,
}) {
  const baseResult = {
    index: leg.index,
    recipient: leg.recipient,
    msats: leg.msats,
    status: STATUSES.PENDING,
    error: null,
    paymentHash: null,
    eventId: null,
    metadataPublished: false,
  }

  function update(patch) {
    Object.assign(baseResult, patch)
    onStatus?.(leg.index, { ...baseResult })
  }

  try {
    update({ status: STATUSES.RESOLVING })
    const meta = await fetchLnurlMeta(leg.recipient.address)

    // Per-leg minSendable check. If our weighted msats fall below this
    // recipient's minimum, we have to fail this leg early — no graceful
    // recovery available without changing the total amount, which is
    // the donor's call. Surface a clear message so the modal can show
    // "this leg's minimum is X sats; bump your boost".
    if (typeof meta.minSendable === 'number' && leg.msats < meta.minSendable) {
      const minSats = Math.ceil(meta.minSendable / 1000)
      throw new Error(`This leg requires at least ${minSats.toLocaleString()} sats — bump the boost amount.`)
    }
    if (typeof meta.maxSendable === 'number' && leg.msats > meta.maxSendable) {
      const maxSats = Math.floor(meta.maxSendable / 1000)
      throw new Error(`This leg accepts at most ${maxSats.toLocaleString()} sats per payment.`)
    }

    // Trim comment if the LNURL endpoint advertises a shorter limit.
    // commentAllowed=0 means comments are not supported; we skip rather
    // than send a comment the endpoint will refuse on. The bot can still
    // pick this boost up via the kind 30078 lookup keyed on payment_hash;
    // it just won't have the LocalBitcoinersEp prefix as a fast filter.
    const allowed = meta.commentAllowed || 0
    const sendComment = allowed > 0 ? comment.slice(0, allowed) : ''

    update({ status: STATUSES.REQUESTING })
    const { pr } = await fetchLnurlInvoice(meta.callback, leg.msats, sendComment)

    const paymentHash = bolt11PaymentHash(pr)
    if (!paymentHash) {
      // V4V 2.0 spec requirement: don't publish a kind 30078 with a
      // placeholder d-tag. If we can't decode the payment_hash, we have
      // to abort this leg — the metadata event would be orphaned and no
      // recipient bot could ever match it.
      throw new Error('Couldn\'t parse the invoice — leg aborted to avoid an orphan boost record.')
    }
    update({ paymentHash })

    update({ status: STATUSES.PUBLISHING })
    const extraTags = [
      ['episode', String(episodeMeta.number)],
      ['episode_title', episodeMeta.title],
      ['item_guid', episodeMeta.guid],
      ['show', 'Local Bitcoiners'],
      ['boost_session', boostSession],
      ['leg', `${leg.index + 1}/${legCount}`],
    ]
    const { eventId, published } = await publishDonationBoostagram({
      burnerSk,
      paymentHash,
      donorNpub,
      recipientLud16: leg.recipient.address,
      amountMsats: leg.msats,
      message: message || '',
      pageUrl,
      extraTags,
    })
    update({ eventId, metadataPublished: !!published })

    update({ status: STATUSES.PAYING })
    // NWC's payInvoice. Wallet relay round-trip: wallet receives
    // encrypted request, attempts payment, returns response. Anywhere
    // from a few hundred ms (warm Alby Hub) to ~10s (cold mobile
    // wallet). The SDK enforces its own timeout internally; we don't
    // wrap further here since adding a second timeout layer can race
    // with the SDK's response decoding.
    const payRes = await nwcClient.payInvoice({ invoice: pr })
    if (!payRes || !payRes.preimage) {
      throw new Error('Wallet didn\'t return a preimage — payment may not have settled.')
    }

    update({ status: STATUSES.PAID })
    return { ...baseResult }
  } catch (e) {
    update({ status: STATUSES.FAILED, error: e?.message || String(e) })
    return { ...baseResult }
  }
}

/**
 * Run a full multi-leg boost. Returns an array of per-leg results in
 * input order — same length as `recipients`. Never throws.
 *
 * @param {object} params
 * @param {Array<{name:string,address:string,splitWeight:number}>} params.recipients
 * @param {number} params.totalWeight
 * @param {number} params.totalMsats           Total amount in millisats; floored
 *                                             into per-leg shares by weight.
 * @param {string} params.message              Donor's message; copied verbatim
 *                                             into every leg's kind 30078 content.
 * @param {string} params.donorNpub            Donor's npub for the sender tag,
 *                                             or '' for anonymous.
 * @param {string} params.pageUrl              Site root URL for the url tag.
 * @param {{number:number,title:string,guid:string}} params.episodeMeta
 * @param {object} params.nwcClient            Live @getalby/sdk NWCClient.
 * @param {function} [params.onStatus]         (legIndex, legState) — fires
 *                                             on every per-leg state change.
 * @returns {Promise<{
 *   boostSession: string,
 *   legs: Array<{
 *     index: number,
 *     recipient: object,
 *     msats: number,
 *     status: string,
 *     error: ?string,
 *     paymentHash: ?string,
 *     eventId: ?string,
 *     metadataPublished: boolean,
 *   }>,
 *   anySucceeded: boolean,
 *   allSucceeded: boolean,
 * }>}
 */
export async function payAllLegs({
  recipients,
  totalWeight,
  totalMsats,
  message,
  donorNpub,
  pageUrl,
  episodeMeta,
  nwcClient,
  onStatus,
}) {
  const boostSession = uuid4()
  const burnerSk = generateBurnerKeypair().sk
  const legs = distributeMsats(totalMsats, recipients, totalWeight)
  const comment = formatEpisodeComment(episodeMeta?.number)

  let results
  try {
    results = await Promise.all(legs.map((leg) => runLeg({
      leg,
      comment,
      donorNpub,
      pageUrl,
      episodeMeta,
      boostSession,
      legCount: legs.length,
      burnerSk,
      nwcClient,
      message,
      onStatus,
    })))
  } finally {
    // Burner key never leaves this function. Zero before returning so
    // memory dumps post-boost don't reveal it.
    if (burnerSk) burnerSk.fill(0)
  }

  const anySucceeded = results.some(r => r.status === STATUSES.PAID)
  const allSucceeded = results.every(r => r.status === STATUSES.PAID)

  return { boostSession, legs: results, anySucceeded, allSucceeded }
}

// Re-export so the modal can render status names as labels without
// duplicating the constants.
export const LEG_STATUS = STATUSES
