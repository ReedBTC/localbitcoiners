/**
 * gamma-compliance.js — single source of truth for grading a marketplace
 * listing against the Gamma Markets spec
 * (https://github.com/GammaMarkets/market-spec).
 *
 * PORTED VERBATIM from MyNostr's src/lib/gammaCompliance.js so the two stay
 * in lockstep — the ONLY local change is inlining KIND_PRODUCT /
 * KIND_SHIPPING_OPTION below instead of importing them from gamma.js (which
 * we don't vendor here). To refresh: re-copy the mynostr file and re-apply
 * that one edit. Callers pass listings in this repo's merch.js shape via a
 * thin adapter in feeds.js (content ← description, shippingOptionRefs ←
 * shippingRefs), so the grader body needs no other changes.
 *
 * Spec quotes pinned in mynostr's docs/gamma-spec-snapshot.md; refresh that
 * file before changing the rules below.
 *
 * Two graders:
 *   - gradeListing(parsedProduct, sellerShippingOptions)
 *   - gradeProfile(kind0Event)
 *
 * Each returns:
 *   {
 *     ready: boolean,                   // no warning/error gaps present
 *     score: number,                    // 0-100, for header summaries
 *     gaps: Array<{
 *       code: string,                   // GAP_*
 *       severity: 'error'|'warning'|'info',
 *       label: string,                  // human-readable summary for UI
 *       fix: string,                    // imperative one-liner ("Add a
 *                                       // shipping option") for the action button
 *     }>,
 *   }
 *
 * Severity → score deduction:
 *   error   → -50 (listing breaks in third-party checkout flows)
 *   warning → -20 (works as manual checkout but loses automation)
 *   info    → 0   (optional improvements, surfaced for visibility only)
 *
 * Gaps are intentionally additive — UIs can render them as a flat list,
 * group by severity, or filter to error+warning for the score-affecting
 * subset.
 */

// Inlined from mynostr's gamma.js (the only local change vs. the upstream
// file). NIP-99 addressable product + Gamma shipping-option kinds.
const KIND_PRODUCT         = 30402
const KIND_SHIPPING_OPTION = 30406

// ── Gap codes ────────────────────────────────────────────────────────────────
// Exposed as constants so consumers can match without typo-prone string
// literals. Names mirror the user-facing problem, not the technical rule.

export const GAP_NO_SHIPPING_OPTION             = 'NO_SHIPPING_OPTION'
export const GAP_FREE_TEXT_ONLY_SHIPPING        = 'FREE_TEXT_ONLY_SHIPPING'
export const GAP_SHIPPING_REF_UNRESOLVED        = 'SHIPPING_REF_UNRESOLVED'
export const GAP_SHIPPING_OPTION_INVALID_SERVICE = 'SHIPPING_OPTION_INVALID_SERVICE'
export const GAP_SHIPPING_OPTION_MISSING_COUNTRY = 'SHIPPING_OPTION_MISSING_COUNTRY'
export const GAP_NO_PAYMENT_PREFERENCE          = 'NO_PAYMENT_PREFERENCE'
export const GAP_INVALID_PAYMENT_PREFERENCE     = 'INVALID_PAYMENT_PREFERENCE'
export const GAP_NO_CHECKOUT_APP_RECOMMENDATION = 'NO_CHECKOUT_APP_RECOMMENDATION'
export const GAP_NO_DM_RELAYS                   = 'NO_DM_RELAYS'

// ── Intent-aware rendering helpers ───────────────────────────────────────────
// The grader stays spec-faithful — it reports every gap regardless of whether
// the seller cares about Gamma checkout. UI components use these helpers to
// soften the *visual* presentation when the seller hasn't opted in: classified-
// style listings ("DM me to buy") are a perfectly valid NIP-99 use case and
// shouldn't be flagged as broken.

// Codes that always represent broken or contradictory state — not just
// "you haven't opted in." Surfaced in warning chrome regardless of intent.
//   - FREE_TEXT_ONLY_SHIPPING: seller wrote shipping prose, signaled intent,
//     but didn't structure it (the original "fix this" case the migrator solves)
//   - SHIPPING_REF_UNRESOLVED: listing references a 30406 that doesn't exist
//     anymore (deleted, foreign, never published) — really broken
//   - INVALID_PAYMENT_PREFERENCE: published value isn't in the spec enum —
//     typo in committed data, not absence
//   - SHIPPING_OPTION_*: a published 30406 has bad data (per-option grader)
const ALWAYS_HARD_GAP_CODES = new Set([
  GAP_FREE_TEXT_ONLY_SHIPPING,
  GAP_SHIPPING_REF_UNRESOLVED,
  GAP_INVALID_PAYMENT_PREFERENCE,
  GAP_SHIPPING_OPTION_INVALID_SERVICE,
  GAP_SHIPPING_OPTION_MISSING_COUNTRY,
])

/**
 * Has the shop signaled commerce intent? Two opt-in actions count:
 *   1. Has at least one published kind 30406 (shipping option) — they
 *      set up structured shipping
 *   2. Has `payment_preference` tag set on kind 0 (any value, even
 *      `manual`) — they explicitly told buyers' clients how to pay
 *
 * Either action means "I'm doing commerce." Neither action means
 * "classified-style is fine for me." Used by UI components to decide
 * whether soft gaps render as warnings ("fix this") or info ("here's
 * how to opt in if you want to").
 *
 * Note: kind 10050 (DM relays) deliberately doesn't count as opt-in —
 * a seller might publish DM relays for general personal use without
 * intending to do commerce, and we don't want their classified-style
 * marketplace listings to escalate to "needs attention" because of an
 * unrelated profile setting.
 *
 * @param {object} args
 * @param {object|null} args.profile — kind 0 NDKEvent or POJO with `tags`
 * @param {Array} [args.shippingOptions=[]] — any non-empty array of the
 *   seller's shipping options. Shape doesn't matter (decoded or wrapped);
 *   non-empty length is the signal.
 */
export function hasOptedIntoGamma({ profile, shippingOptions = [] } = {}) {
  if (Array.isArray(shippingOptions) && shippingOptions.length > 0) return true
  const tags = Array.isArray(profile?.tags) ? profile.tags : []
  const pref = tags.find(t => Array.isArray(t) && t[0] === 'payment_preference')
  return Boolean(pref && typeof pref[1] === 'string' && pref[1].trim())
}

/**
 * Render-time severity for a gap given shop-level intent. Soft gaps —
 * `NO_SHIPPING_OPTION`, `NO_PAYMENT_PREFERENCE` — are rendered as info
 * ("opt in if you want") on shops that haven't opted in. Once the shop
 * opts in via either signal, those same gaps escalate to warnings
 * (the seller has shown intent and now the OTHER half of the setup
 * is missing). Always-hard codes (broken data, free-text shipping)
 * keep their severity regardless of intent.
 */
export function effectiveSeverity(gap, hasOptedIn) {
  if (!gap) return 'info'
  if (ALWAYS_HARD_GAP_CODES.has(gap.code)) return gap.severity
  if (
    gap.code === GAP_NO_SHIPPING_OPTION ||
    gap.code === GAP_NO_PAYMENT_PREFERENCE ||
    gap.code === GAP_NO_DM_RELAYS
  ) {
    return hasOptedIn ? 'warning' : 'info'
  }
  return gap.severity
}

// Per-severity score weight. Centralised so future tuning is one place.
const WEIGHT = { error: 50, warning: 20, info: 0 }

// Spec-mandated enum for kind 30406 `service` (docs/gamma-spec-snapshot.md §3).
export const SERVICE_VALUES = ['standard', 'express', 'overnight', 'pickup']
const SERVICE_SET = new Set(SERVICE_VALUES)

// Spec-mandated enum for kind-0 `payment_preference` (docs/gamma-spec-snapshot.md §1).
export const PAYMENT_PREFERENCE_VALUES = ['manual', 'lud16', 'ecash']
const PAYMENT_PREFERENCE_SET = new Set(PAYMENT_PREFERENCE_VALUES)

// Heading the Sell composer appends when a seller types free-text shipping
// notes — see sellForm.js where this exact marker is written and re-parsed.
// Detecting it lets us tell "no shipping info at all" apart from "shipping
// info present, but only as prose."
const FREE_TEXT_SHIPPING_MARKER = '\n## Shipping\n\n'

// ── Helpers ──────────────────────────────────────────────────────────────────

function summarize(gaps) {
  let score = 100
  for (const g of gaps) score -= WEIGHT[g.severity] ?? 0
  if (score < 0) score = 0
  // Ready = nothing worse than info. Errors and warnings both block the
  // "checkout-ready" label so a "manual checkout only" listing doesn't
  // get a green check.
  const ready = gaps.every(g => g.severity === 'info')
  return { ready, score, gaps }
}

// ── gradeListing ─────────────────────────────────────────────────────────────

/**
 * Grade a single 30402 listing for Gamma compliance.
 *
 * @param {object} parsed — decoded product (from gamma.decodeProduct).
 * @param {Array<object>} [sellerShippingOptions] — decoded 30406s the
 *   seller owns. Pass an empty array if not loaded yet — grader degrades
 *   gracefully and just skips ref-resolution checks.
 *
 * @returns {{ ready: boolean, score: number, gaps: Array<object> }}
 */
export function gradeListing(parsed, sellerShippingOptions = []) {
  if (!parsed || typeof parsed !== 'object') {
    return summarize([{
      code: GAP_NO_SHIPPING_OPTION,
      severity: 'error',
      label: 'Listing data unavailable',
      fix: 'Reload the listing',
    }])
  }

  const gaps = []
  const refs = Array.isArray(parsed.shippingOptionRefs) ? parsed.shippingOptionRefs : []
  const hasFreeTextShipping = typeof parsed.content === 'string'
    && parsed.content.includes(FREE_TEXT_SHIPPING_MARKER)

  if (refs.length === 0) {
    // No structured shipping at all — the load-bearing gap. Distinguish
    // "seller wrote prose but never structured it" from "no shipping
    // info anywhere" so the migration UI can offer the smarter fix
    // (parse the prose into a 30406) when applicable.
    if (hasFreeTextShipping) {
      gaps.push({
        code: GAP_FREE_TEXT_ONLY_SHIPPING,
        severity: 'warning',
        label: 'Shipping is described in prose only',
        fix: 'Convert your shipping notes into a structured shipping option',
      })
    } else {
      gaps.push({
        code: GAP_NO_SHIPPING_OPTION,
        severity: 'warning',
        label: 'No shipping option attached',
        fix: 'Add a shipping option so checkout apps can compute a quote',
      })
    }
  } else if (sellerShippingOptions.length > 0) {
    // We have refs AND we know what the seller's 30406s look like — verify
    // each ref resolves to one of the seller's own options. A foreign or
    // archived option is a soft warning, not a hard error: the listing
    // still works in apps that already cached the referenced 30406, just
    // not in apps fetching cold.
    const ownCoords = new Set(
      sellerShippingOptions
        .filter(s => s?.dTag && s?.pubkey)
        .map(s => `${KIND_SHIPPING_OPTION}:${s.pubkey}:${s.dTag}`)
    )
    const unresolved = refs
      .map(r => r?.ref || '')
      .filter(ref => ref && !ownCoords.has(ref))
    if (unresolved.length > 0) {
      gaps.push({
        code: GAP_SHIPPING_REF_UNRESOLVED,
        severity: 'warning',
        label: `${unresolved.length} shipping option ref${unresolved.length === 1 ? '' : 's'} can't be resolved`,
        fix: 'Re-attach a current shipping option',
      })
    }
  }

  return summarize(gaps)
}

// ── gradeProfile ─────────────────────────────────────────────────────────────

/**
 * Grade a kind-0 profile event for the merchant-side Gamma signals.
 * Currently checks:
 *   - `payment_preference` tag (kind 0)
 *   - kind 10050 NIP-17 DM relay list — at least one declared inbox
 *
 * `payment_preference` absence is info-level because the spec defaults
 * missing values to `manual`. `dmRelays` absence defaults to warning
 * because a manual-pay listing without an inbox means buyers' DMs may
 * silently disappear; effectiveSeverity softens it to info for shops
 * that haven't opted into Gamma at all.
 *
 * @param {object|null} kind0Event — raw NDKEvent or POJO with `tags`.
 * @param {string[]} [dmRelays=[]] — flat list of NIP-17 inbox URLs
 *   from the user's kind 10050. Empty/missing → warning gap.
 */
export function gradeProfile(kind0Event, dmRelays = []) {
  const tags = Array.isArray(kind0Event?.tags) ? kind0Event.tags : []
  const prefTag = tags.find(t => Array.isArray(t) && t[0] === 'payment_preference')

  const gaps = []

  if (!prefTag) {
    // Spec: missing tag = "manual" by default. Surface as info so the
    // seller knows they *could* opt into automation, but don't penalise
    // their score for accepting the default.
    gaps.push({
      code: GAP_NO_PAYMENT_PREFERENCE,
      severity: 'info',
      label: 'No payment preference set (defaults to manual)',
      fix: 'Pick how buyers should pay you',
    })
  } else {
    const value = String(prefTag[1] || '').toLowerCase()
    if (!PAYMENT_PREFERENCE_SET.has(value)) {
      // Tag exists but the value is outside the spec enum — treat as a
      // warning since third-party apps will likely fall back to manual
      // anyway, but the seller probably *intended* to opt in.
      gaps.push({
        code: GAP_INVALID_PAYMENT_PREFERENCE,
        severity: 'warning',
        label: `Payment preference "${value}" is not a recognised value`,
        fix: `Set payment preference to one of: ${PAYMENT_PREFERENCE_VALUES.join(', ')}`,
      })
    }
  }

  // NIP-17 inbox relays. Manual checkout (the spec default) is literally
  // "buyers DM you," so without a kind 10050 the messages have nowhere
  // to land — buyers' clients gift-wrap to the seller's declared inboxes,
  // and if there are none they silently fall back to write relays that
  // may not accept gift-wraps. Warning at the grader level; UI softens
  // to info for shops that haven't opted into Gamma so a non-commerce
  // profile doesn't get nagged.
  if (!Array.isArray(dmRelays) || dmRelays.length === 0) {
    gaps.push({
      code: GAP_NO_DM_RELAYS,
      severity: 'warning',
      label: 'No NIP-17 DM inbox relays published',
      fix: 'Publish a DM relay list so buyers\' messages reach you',
    })
  }

  return summarize(gaps)
}

// ── gradeShippingOption ──────────────────────────────────────────────────────

/**
 * Grade a single 30406 shipping option for Gamma compliance. Used by the
 * Shipping Options tab to flag options that won't be picked up cleanly by
 * checkout apps. Required tags per the spec snapshot are d/title/price/
 * country/service; gamma.encodeShippingOption already enforces d+title,
 * so this grader focuses on the spec-mandated *values* and the runtime
 * fields the encoder doesn't validate.
 */
export function gradeShippingOption(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return summarize([{
      code: GAP_SHIPPING_REF_UNRESOLVED,
      severity: 'error',
      label: 'Shipping option data unavailable',
      fix: 'Reload the shipping option',
    }])
  }

  const gaps = []

  const countries = Array.isArray(parsed.countries) ? parsed.countries.filter(Boolean) : []
  if (countries.length === 0) {
    gaps.push({
      code: GAP_SHIPPING_OPTION_MISSING_COUNTRY,
      severity: 'warning',
      label: 'No countries listed',
      fix: 'Pick at least one country this option ships to',
    })
  }

  const service = String(parsed.service || '').toLowerCase()
  // Empty service is a missing-required-tag case, distinct from invalid:
  // surface both with the same code so the UI's fix flow is one button.
  if (!SERVICE_SET.has(service)) {
    gaps.push({
      code: GAP_SHIPPING_OPTION_INVALID_SERVICE,
      severity: 'warning',
      label: service
        ? `Service "${service}" isn't one of the standard values`
        : 'Service type missing',
      fix: `Pick a service type: ${SERVICE_VALUES.join(', ')}`,
    })
  }

  return summarize(gaps)
}

// ── gradeMerchant ────────────────────────────────────────────────────────────

/**
 * Roll up profile + every listing + every shipping option into a single
 * verdict for header summaries ("Compliance: 8/10 ready"). The score
 * here is the average of per-listing scores combined with the profile
 * score — weighting profile and listings equally feels right because
 * profile gaps affect *every* listing in practice.
 *
 * Returns the same shape as the per-item graders, plus:
 *   - listingCount, listingReadyCount: for "8/10 ready" UI copy
 */
export function gradeMerchant({ profile, listings = [], shippingOptions = [], dmRelays = [] }) {
  const profileResult = gradeProfile(profile, dmRelays)
  const listingResults = listings.map(p => gradeListing(p, shippingOptions))

  const allGaps = [
    ...profileResult.gaps.map(g => ({ ...g, scope: 'profile' })),
    ...listingResults.flatMap((r, i) =>
      r.gaps.map(g => ({ ...g, scope: 'listing', listingIndex: i }))
    ),
  ]

  const listingReadyCount = listingResults.filter(r => r.ready).length
  const listingScoreAvg = listingResults.length > 0
    ? Math.round(listingResults.reduce((sum, r) => sum + r.score, 0) / listingResults.length)
    : 100

  // Merchant-level score: average of profile and listing-average. Profile
  // gaps are info-only by design, so this typically tracks the listing
  // score closely — but a future error-severity profile gap would pull
  // the whole shop's score down, which is what we want.
  const score = Math.round((profileResult.score + listingScoreAvg) / 2)
  const ready = profileResult.ready && listingResults.every(r => r.ready)

  return {
    ready,
    score,
    gaps: allGaps,
    listingCount: listingResults.length,
    listingReadyCount,
  }
}

export { KIND_PRODUCT, KIND_SHIPPING_OPTION }
