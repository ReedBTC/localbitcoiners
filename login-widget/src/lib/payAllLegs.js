/**
 * Multi-leg episode boost orchestrator.
 *
 * Given the recipients pulled from an RSS <podcast:value> block plus a
 * total amount, run N legs sequentially:
 *   1. Compute weight-proportional msats for each recipient.
 *   2. For each leg in order:
 *      a. Resolve the recipient's lud16 → LNURL endpoint (.well-known/lnurlp)
 *         (or skip if the modal pre-fetched the invoice during presign).
 *      b. Request a bolt11 invoice with comment = LocalBitcoinersEpNNN
 *         (skipped for pre-fetched legs).
 *      c. Extract payment_hash from the bolt11.
 *      d. Maybe publish a kind 30078 metadata event:
 *           - Pre-signed event provided → publish that.
 *           - Recipient is in the META_PUBLISH_ALLOWLIST → build + sign
 *             with a single-use burner key, then publish.
 *           - Otherwise → skip the publish entirely. Recipients outside
 *             the allowlist (Fountain, guest personal addresses, etc.)
 *             don't run a bot that watches our boost relays, so the
 *             event would just be relay noise.
 *      e. Pay the invoice via the active wallet (NWC or WebLN). Wait
 *         for completion before starting the next leg.
 *   3. Per-leg status callback fires after each transition (resolving →
 *      requesting → publishing → paying → paid|failed) so the modal can
 *      render live progress dots.
 *
 * Why sequential: NWC sends one encrypted request per payInvoice over
 * the wallet relay. Five parallel requests created contention in
 * production — a wallet processing a slow leg (e.g. minibits Cashu
 * mint) caused later legs' reply events to time out at the SDK's 60s
 * default. Serializing trades a few seconds of total latency for
 * meaningfully higher reliability. The SDK's `multi_pay_invoice` is
 * not used because the SDK currently fails the whole batch if any
 * single payment fails (per a TODO in the SDK source), which is
 * strictly worse than per-leg error handling.
 *
 * Best-effort semantics:
 *   - Splits aren't atomic in Lightning. If one leg fails (lud16 down,
 *     wallet rejects, relay error), subsequent legs still run. Caller
 *     reports per-leg outcomes and decides whether to surface a retry.
 *   - The whole orchestrator never throws on partial failure; it returns
 *     an array of per-leg results. Throwing would abort the modal and
 *     leave the donor wondering whether anything was paid.
 *
 * Key reuse:
 *   - One burner secret key signs the burner-signed legs of a single
 *     boost session (anonymous boosts, or attributed boosts where the
 *     user-signer fallback fired). This intentionally lets the recipient
 *     bot enumerate "all burner-signed legs of the same boost" by author
 *     pubkey — useful for analytics — without leaking donor identity.
 *   - One UUID4 in boost_session ties legs together for the boost wall's
 *     session-level dedup. Generated here, or injected by the modal's
 *     presign step so a pre-signed event and the eventual payment carry
 *     a matching boost_session tag.
 */

import { generateBurnerKeypair } from './boostagram.js'
import {
  fetchLnurlMeta,
  fetchLnurlInvoice,
  bolt11PaymentHash,
  buildDonationBoostagramTemplate,
  signDonationBoostagramWithUser,
  signDonationBoostagramWithBurner,
  publishSignedBoostagram,
} from './boostagram.js'
import { formatEpisodeComment } from './episodeData.js'
import { shouldPublishMetadata } from './recipientOverrides.js'

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

/** Build the per-leg extraTags shared between the presign step and the
 *  inline burner-signed publish. Centralized so the two paths stay in
 *  sync; if the bot ever cares about a new tag, add it here once. */
function buildLegExtraTags({ episodeMeta, boostSession, legIndex, legCount }) {
  return [
    ['episode', String(episodeMeta?.number ?? '')],
    ['episode_title', episodeMeta?.title || ''],
    ['item_guid', episodeMeta?.guid || ''],
    ['show', 'Local Bitcoiners'],
    ['boost_session', boostSession],
    ['leg', `${legIndex + 1}/${legCount}`],
  ]
}

/**
 * Run a single leg end-to-end. Reports status via `onStatus(legIndex, patch)`.
 * Returns the leg result (resolved or failed) — never throws.
 *
 * `prefetched`, when supplied, lets the caller skip the LNURL+invoice
 * round-trip and the metadata sign: the modal already did both during
 * its presign step. Shape: `{ invoice, signedEvent }`.
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
  walletClient,
  message,
  lnurlCache,
  onStatus,
  prefetched,   // optional { invoice, signedEvent }
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

    let invoice = prefetched?.invoice || null

    if (!invoice) {
      // Prefer the modal's prefetched LNURL meta over a fresh fetch. The
      // modal kicks off all resolves in parallel on mount, so by boost
      // time most legs already have their metadata in hand. Cache miss
      // (or null = previous fetch failed) falls through to a live fetch.
      let meta = lnurlCache?.[leg.recipient.address] || null
      if (!meta) {
        meta = await fetchLnurlMeta(leg.recipient.address)
      }

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
      invoice = pr
    }

    const paymentHash = bolt11PaymentHash(invoice)
    if (!paymentHash) {
      // V4V 2.0 spec requirement: don't publish a kind 30078 with a
      // placeholder d-tag. If we can't decode the payment_hash, we have
      // to abort this leg — the metadata event would be orphaned and no
      // recipient bot could ever match it.
      throw new Error('Couldn\'t parse the invoice — leg aborted to avoid an orphan boost record.')
    }
    update({ paymentHash })

    // ── kind 30078 publish step ──
    // Three branches:
    //   1. Pre-signed event from presign → publish it as-is.
    //   2. No pre-signed event but recipient is in the LB bot allowlist
    //      → build + burner-sign + publish (the anon-mode path, or the
    //      attributed-mode-with-no-presign edge).
    //   3. Recipient outside the allowlist → skip publish entirely. The
    //      payment still happens; we just don't litter relays with a
    //      metadata event no bot will read.
    if (prefetched?.signedEvent) {
      update({ status: STATUSES.PUBLISHING })
      const { eventId, published } = await publishSignedBoostagram(prefetched.signedEvent)
      update({ eventId, metadataPublished: !!published })
    } else if (shouldPublishMetadata(leg.recipient.address)) {
      update({ status: STATUSES.PUBLISHING })
      const extraTags = buildLegExtraTags({
        episodeMeta, boostSession, legIndex: leg.index, legCount,
      })
      // Burner-signed → strip the donor's npub from the `sender` tag.
      // Same rationale as the presign fallback: a burner key can't
      // cryptographically vouch for any user identity, so claiming one
      // would let any client publish receipts under arbitrary npubs.
      // Anon mode already passes donorNpub='' here; this also covers
      // the attributed-mode-but-presign-skipped edge (e.g. LNURL fetch
      // failed during presign so this leg fell through to legacy).
      const template = buildDonationBoostagramTemplate({
        paymentHash,
        donorNpub: '',
        recipientLud16: leg.recipient.address,
        amountMsats: leg.msats,
        message: message || '',
        pageUrl,
        extraTags,
      })
      const signed = signDonationBoostagramWithBurner(template, burnerSk)
      const { eventId, published } = await publishSignedBoostagram(signed)
      update({ eventId, metadataPublished: !!published })
    }
    // else: deliberately no metadata publish — leg pays without a 30078.

    update({ status: STATUSES.PAYING })
    // Wallet client's payInvoice. NWC: wallet relay round-trip (encrypted
    // request, wallet attempts payment, returns response — anywhere from
    // a few hundred ms on a warm Alby Hub to ~10s on a cold mobile
    // wallet, with an internal 60s reply timeout). WebLN: direct
    // extension RPC, typically sub-second once the user approves.
    //
    // Translate the NWC SDK's terse "reply timeout: event <hex>" error
    // into something actionable — a 60s timeout almost always means
    // either the wallet was slow under contention or the payment
    // actually settled but the reply event got lost. Either way, the
    // user should check their wallet before retrying.
    let payRes
    try {
      payRes = await walletClient.payInvoice({ invoice })
    } catch (e) {
      const msg = String(e?.message || e)
      if (/reply timeout|publish timeout|timeout/i.test(msg)) {
        throw new Error('Wallet didn\'t reply in time — the payment may have actually gone through. Check your wallet before retrying.')
      }
      throw e
    }
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
 * Pre-resolve LNURL + fetch invoice + sign kind 30078 for every
 * recipient in the META_PUBLISH_ALLOWLIST. Called by the boost modal
 * before submitBoost so the user-signer prompts happen while the modal
 * is still open (rather than as a surprise after it closes).
 *
 * If the user's signer rejects or times out for any leg, that leg
 * falls back to a burner-signed event so the boost still goes through.
 * If LNURL or invoice fetch fails for a leg, the leg is omitted from
 * the presigned map — payAllLegs will fall through to its legacy
 * resolve+invoice path and either succeed or fail loudly there.
 *
 * Anon mode (donorNpub === '') skips presign entirely; the legacy
 * burner path inside payAllLegs handles allowlisted legs in that case.
 *
 * Returns:
 *   {
 *     boostSession: string,                  // shared by every event in the boost
 *     byAddress: { [address]: { invoice, signedEvent } },
 *   }
 *
 * Never throws — best-effort. A return value of `{ boostSession,
 * byAddress: {} }` is valid (e.g. anon mode, or all presign attempts
 * fell through) and instructs payAllLegs to handle every leg via the
 * legacy path.
 */
export async function presignAllowlistedLegs({
  recipients,
  totalWeight,
  totalMsats,
  message,
  donorNpub,
  pageUrl,
  episodeMeta,
  lnurlCache,
}) {
  const boostSession = uuid4()
  const byAddress = {}

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { boostSession, byAddress }
  }
  if (!donorNpub) {
    // No signer to attribute to — payAllLegs handles allowlisted legs
    // with its inline burner path.
    return { boostSession, byAddress }
  }

  const legs = distributeMsats(totalMsats, recipients, totalWeight)
  const comment = formatEpisodeComment(episodeMeta?.number)
  // Lazy-init: only allocated on the first user-sign failure that
  // needs a burner-fallback receipt. The happy path (every legacy
  // signer round-trip succeeds) skips the allocation + the zero-out
  // entirely. Captured in the `finally` via closure so the cleanup
  // path doesn't have to know whether allocation happened.
  let burnerSk = null

  try {
    for (const leg of legs) {
      const r = leg.recipient
      if (!r?.address) continue
      if (!shouldPublishMetadata(r.address)) continue

      try {
        let meta = lnurlCache?.[r.address] || null
        if (!meta) meta = await fetchLnurlMeta(r.address)
        if (typeof meta.minSendable === 'number' && leg.msats < meta.minSendable) continue
        if (typeof meta.maxSendable === 'number' && leg.msats > meta.maxSendable) continue
        const allowed = meta.commentAllowed || 0
        const sendComment = allowed > 0 ? comment.slice(0, allowed) : ''

        const { pr } = await fetchLnurlInvoice(meta.callback, leg.msats, sendComment)
        const paymentHash = bolt11PaymentHash(pr)
        if (!paymentHash) continue

        const extraTags = buildLegExtraTags({
          episodeMeta, boostSession, legIndex: leg.index, legCount: legs.length,
        })
        const userTemplate = buildDonationBoostagramTemplate({
          paymentHash,
          donorNpub,
          recipientLud16: r.address,
          amountMsats: leg.msats,
          message: message || '',
          pageUrl,
          extraTags,
        })

        let signedEvent = null
        try {
          signedEvent = await signDonationBoostagramWithUser(userTemplate)
        } catch (e) {
          // Burner fallback: signer rejected/timed out. The receipt
          // becomes effectively anonymous — we strip the donor's npub
          // from the `sender` tag because a burner key can't
          // cryptographically vouch for it, and keeping the npub here
          // would let any client with a hostile signer publish events
          // claiming arbitrary identities. The boost itself still goes
          // through; the bot just sees an anon receipt.
          console.warn('[lb] presign user-sign failed for', r.address, e?.message || e)
          if (!burnerSk) burnerSk = generateBurnerKeypair().sk
          const burnerTemplate = buildDonationBoostagramTemplate({
            paymentHash,
            donorNpub: '',
            recipientLud16: r.address,
            amountMsats: leg.msats,
            message: message || '',
            pageUrl,
            extraTags,
          })
          signedEvent = signDonationBoostagramWithBurner(burnerTemplate, burnerSk)
        }

        byAddress[r.address] = { invoice: pr, signedEvent }
      } catch (e) {
        // LNURL or invoice fetch failed for this leg. Skip the presign
        // entry and let payAllLegs's legacy path retry the network
        // round-trip — it'll either succeed or fail with the same
        // kind of error visible to the donor.
        console.warn('[lb] presign skipped for', r.address, e?.message || e)
      }
    }
  } finally {
    if (burnerSk) burnerSk.fill(0)
  }

  return { boostSession, byAddress }
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
 * @param {object} params.walletClient         Live wallet client — either
 *                                             a @getalby/sdk NWCClient or a
 *                                             WebLN wrapper. Must expose
 *                                             `payInvoice({invoice})` →
 *                                             `{preimage}`.
 * @param {function} [params.onStatus]         (legIndex, legState) — fires
 *                                             on every per-leg state change.
 * @param {{boostSession:string, byAddress:object}} [params.presigned]
 *        Optional pre-signed events + pre-fetched invoices, produced by
 *        `presignAllowlistedLegs`. Each entry's invoice replaces the
 *        per-leg LNURL+invoice round-trip; each signedEvent replaces
 *        the burner-signed metadata publish.
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
  walletClient,
  lnurlCache,
  onStatus,
  presigned,
}) {
  const boostSession = presigned?.boostSession || uuid4()
  const burnerSk = generateBurnerKeypair().sk
  const legs = distributeMsats(totalMsats, recipients, totalWeight)
  const comment = formatEpisodeComment(episodeMeta?.number)
  const presignByAddress = presigned?.byAddress || {}

  const results = []
  try {
    for (const leg of legs) {
      // eslint-disable-next-line no-await-in-loop -- intentional serialization
      const r = await runLeg({
        leg,
        comment,
        donorNpub,
        pageUrl,
        episodeMeta,
        boostSession,
        legCount: legs.length,
        burnerSk,
        walletClient,
        message,
        lnurlCache,
        onStatus,
        prefetched: presignByAddress[leg.recipient?.address] || null,
      })
      results.push(r)
    }
  } finally {
    // Burner key never leaves this function. Zero before returning so
    // memory dumps post-boost don't reveal it.
    if (burnerSk) burnerSk.fill(0)
  }

  const anySucceeded = results.some(r => r.status === STATUSES.PAID)
  const allSucceeded = results.every(r => r.status === STATUSES.PAID)

  return { boostSession, legs: results, anySucceeded, allSucceeded }
}
