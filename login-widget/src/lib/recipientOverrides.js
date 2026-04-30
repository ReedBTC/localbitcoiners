/**
 * Per-host substitutions applied to RSS-derived split recipients before
 * any LNURL fetch, payment, or kind 30078 publish.
 *
 * Why this exists: the Local Bitcoiners show is self-hosting boost
 * infrastructure rather than depending on Fountain's tooling, so the
 * 2% leg the RSS feed attributes to Fountain's boostbot is rerouted to
 * aquafox30@primal.net before payment. The RSS feed itself stays
 * untouched (Fountain still generates it from the show config).
 *
 * Keyed by source lud16; values replace the matching recipient's
 * `name` and `address` while preserving the original split weight.
 *
 * Merge semantics:
 *   When the override target address is *already* a recipient in the
 *   current splits — e.g. the channel-level fallback splits include
 *   aquafox30@primal.net at 32% AND Fountain at 2%, both of which
 *   route to aquafox30 after the override — the two legs are merged
 *   into one with combined weight (34%). Avoids paying the same
 *   address twice in one boost (extra LN fees, two kind 30078 events
 *   for the same recipient).
 *
 * Audit note: any address listed here is a *redirect at the donor's
 * client*. The kind 30078 `recipient` tag will reflect the redirected
 * address, so a recipient bot watching the override target sees a
 * normal leg with no special signaling. The original RSS recipient
 * never sees the payment.
 */
export const LNADDRESS_OVERRIDES = {
  'boostbot@fountain.fm': {
    name: 'aquafox30@primal.net',
    address: 'aquafox30@primal.net',
  },
}

/**
 * Apply the override map to a recipient list. Pure — returns a new
 * array; original is unmodified.
 *
 * Two passes implicit in one loop:
 *   1. Apply the address/name override (or pass through if none).
 *   2. If the post-override address is already in `out`, merge weights
 *      into the existing entry rather than appending a duplicate.
 */
export function applyRecipientOverrides(recipients) {
  if (!Array.isArray(recipients)) return recipients
  const out = []
  const indexByAddress = new Map()  // post-override address → index in `out`

  for (const r of recipients) {
    if (!r || !r.address) {
      out.push(r)
      continue
    }
    const override = LNADDRESS_OVERRIDES[r.address] || null
    const next = override ? { ...r, ...override } : r

    const existingIdx = indexByAddress.get(next.address)
    if (existingIdx !== undefined) {
      // Merge into the existing entry. Preserve its name/address so
      // display doesn't flip to whatever-came-second's name. Sum the
      // weights — total stays correct, recipient gets one combined leg.
      const existing = out[existingIdx]
      out[existingIdx] = {
        ...existing,
        splitWeight: existing.splitWeight + (next.splitWeight || 0),
      }
      continue
    }

    indexByAddress.set(next.address, out.length)
    out.push(next)
  }
  return out
}
