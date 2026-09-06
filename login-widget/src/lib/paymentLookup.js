/**
 * Asking the WALLET whether a payment settled.
 *
 * WHY. A NIP-47 pay call answers only when the wallet is done, and Alby Hub
 * over LND is done when the payment settles — so an outbound HTLC that takes
 * longer than the SDK's 60-second reply window produces a reply timeout while
 * the sats still go through. Measured on a real OnlyBoosts boost, 2026-09-04:
 * two legs timed out at 60.0s, the third paid in 0.97s over the same
 * connection, and the node showed all three settled. Before this file the
 * widget had no second source of truth for such a leg: LUD-21 needs a verify
 * URL the provider may not return (Primal returns none), and a keysend has no
 * recipient-side check at all. So both legs rested on UNCERTAIN, the note
 * reported one of three splits, and nothing could ever correct it.
 *
 * The wallet itself is that second source. NIP-47 `lookup_invoice` takes a
 * payment hash and answers for outgoing payments too, and the widget holds
 * the hash for every leg it pays: the invoice's own, and for a keysend the
 * hash of the preimage IT generated. This module is the pure half — the
 * classification of an answer and the polling loop over one — with the
 * wallet call injected, so `scripts/test-payment-lookup.mjs` drives it with
 * no SDK and no relay.
 *
 * Ported from OnlyBoosts (18d0febb) on 2026-09-04. Here it sits under BOTH
 * boost paths: the external one (externalBoost.js) and the show's own
 * (payAllLegs.js, the retry in MultiLegBoostForm, payInvoiceVerified).
 *
 * ⚠️ THE ONLY CONSEQUENTIAL ANSWER IS `failed`, AND IT IS TRUSTED ONLY WHEN
 * THE WALLET SAYS IT IN SO MANY WORDS. `settled` flips a leg to PAID, which
 * is free to be wrong in the cheap direction (the donor is told they paid
 * and they did). `failed` hands the donor a Retry that re-pays, so it is the
 * double-payment surface: it is read only from an explicit `state: "failed"`,
 * never inferred from a missing field, a NOT_FOUND, or an error. Everything
 * short of the two definite answers is `pending` or `unknown`, both of which
 * mean "keep the leg where it is".
 *
 * `unsupported` is the wallet saying it has no such method (NOT_IMPLEMENTED,
 * or the SDK rejecting the response shape); the caller stops asking.
 */

/** @typedef {'settled'|'pending'|'failed'|'unknown'|'unsupported'} LookupState */

/**
 * One NIP-47 lookup_invoice result → a LookupState.
 * @param {object|null} result  The transaction object the wallet answered with.
 */
export function classifyLookup(result) {
  if (!result || typeof result !== 'object') return 'unknown'
  const state = typeof result.state === 'string' ? result.state.toLowerCase() : ''
  if (state === 'settled') return 'settled'
  if (state === 'failed') return 'failed'
  if (state === 'pending' || state === 'accepted') return 'pending'
  // Pre-`state` wallets: settled_at (or a preimage) is the settlement.
  if (Number(result.settled_at) > 0) return 'settled'
  if (typeof result.preimage === 'string' && /^[0-9a-f]{64}$/i.test(result.preimage)) return 'settled'
  return 'pending'
}

/**
 * What a rejected lookup means. A wallet without the method, or one whose
 * answer the SDK could not validate, is `unsupported`; anything else —
 * NOT_FOUND included — is `unknown`, because a payment the wallet cannot find
 * is not a payment the wallet has proved it never made.
 */
export function classifyLookupError(err) {
  const code = String(err?.code || '').toUpperCase()
  const name = String(err?.name || '')
  const msg = String(err?.message || err || '')
  if (code === 'NOT_IMPLEMENTED' || code === 'RESTRICTED' || code === 'UNAUTHORIZED') return 'unsupported'
  if (name === 'Nip47ResponseValidationError' || /failed validation/i.test(msg)) return 'unsupported'
  if (/not implemented|unsupported method|unknown method/i.test(msg)) return 'unsupported'
  return 'unknown'
}

/**
 * The payment hash of a keysend, from the preimage the widget chose for it.
 * Hex in, hex out; WebCrypto on both the browser and Node.
 */
export async function keysendPaymentHash(preimageHex) {
  const hex = String(preimageHex || '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Poll the wallet about one payment hash until it gives a definite answer or
 * the deadline passes.
 *
 * @param {object} p
 * @param {(paymentHash: string) => Promise<LookupState>} p.lookup  One wallet
 *        call, already classified (nwc.js#lookupPayment). It must not throw;
 *        a throw is treated as `unknown` for that poll.
 * @param {string} p.paymentHash
 * @param {number} [p.deadlineMs]   Total time to keep asking. 0 = ask once.
 * @param {number} [p.intervalMs]   Gap between polls.
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<LookupState>}  `settled` / `failed` are final; `unsupported`
 *          ends the loop at once; `unknown` is the deadline passing (or an
 *          abort) with nothing definite.
 */
export async function confirmViaWallet({ lookup, paymentHash, deadlineMs = 0, intervalMs = 3000, signal = null } = {}) {
  if (typeof lookup !== 'function' || !paymentHash) return 'unknown'
  const until = Date.now() + Math.max(0, deadlineMs)
  while (true) {
    if (signal?.aborted) return 'unknown'
    let state = 'unknown'
    try { state = await lookup(paymentHash) } catch { state = 'unknown' }
    if (state === 'settled' || state === 'failed' || state === 'unsupported') return state
    if (Date.now() + intervalMs > until) return 'unknown'
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
