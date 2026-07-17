// Race a promise against a timeout. Rejects with the given label if the
// inner promise hasn't settled in `ms` milliseconds. Used for relay fetches
// and signer round-trips that can otherwise hang indefinitely.
export function withTimeout(promise, ms, label = 'timeout') {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// Checks if a URL uses a safe protocol (http/https only).
// Blocks javascript:, data:, vbscript:, etc. — used as a guard before
// rendering user-supplied URLs as <img src> or <a href>.
export function isSafeUrl(url) {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

// True when a wallet error message means the payment definitively never
// left the wallet — the user hit Reject in their extension, no balance,
// expired invoice, no route. Safe to report as failed/unsettled without a
// settlement round-trip. Anything else (timeout, lost reply, generic
// error) is ambiguous and must go through LUD-21 verification instead.
// Shared by payAllLegs, payInvoiceVerified, and the external boost path
// so the three classifiers can't drift.
//
// Deliberately does NOT match bare "cancel"/"cancelled": some wallets use
// it for requests that may already be in flight, which is exactly the
// ambiguous case the verify path exists for.
export function isCleanPaymentDecline(msg) {
  return /rejected|denied|declined|insufficient|not enough|no funds|balance too low|expired|no route|unable to find route|route not found/i.test(String(msg || ''))
}

// Strip NWC connection strings (and any bare `secret=...` query
// values) from a string before logging it. @getalby/sdk and other
// wallet libs occasionally embed the offending input verbatim in
// `Error.message`, which then lands in the browser console — visible
// to any extension with `tabs` permission and included in user-pasted
// bug reports. The NWC URI is a bearer credential; one leak is enough.
//
// Intentionally aggressive: matches `nostr+walletconnect://...` and
// any standalone `secret=<hex>` substring, even outside a full URI.
export function scrubSecrets(s) {
  if (typeof s !== 'string' || !s) return s
  return s
    .replace(/nostr\+walletconnect:\/\/[^\s"'`]+/gi, 'nostr+walletconnect://[REDACTED]')
    .replace(/secret=[A-Za-z0-9+/=_-]+/gi, 'secret=[REDACTED]')
}
