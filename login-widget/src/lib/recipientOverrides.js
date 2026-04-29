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
 * array; original is unmodified. Recipients with no matching override
 * pass through verbatim.
 */
export function applyRecipientOverrides(recipients) {
  if (!Array.isArray(recipients)) return recipients
  return recipients.map((r) => {
    const override = r && r.address ? LNADDRESS_OVERRIDES[r.address] : null
    if (!override) return r
    return { ...r, ...override }
  })
}
