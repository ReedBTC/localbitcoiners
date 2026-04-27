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
