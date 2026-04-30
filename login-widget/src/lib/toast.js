/**
 * Lightweight transient-toast system for surface-level user feedback.
 *
 * Used sparingly — most flows should be silent (per Reed's send-and-
 * forget design). Currently the only producer is boostQueue when an
 * all-failed boost lands; that's the one case where the casual user
 * needs a heads-up that something didn't work.
 *
 * Auto-expires after AUTO_DISMISS_MS so the toast never sticks around
 * past relevance. Multiple in-flight toasts stack vertically.
 */

const DEFAULT_DURATION_MS = 5000

let nextId = 0
const toasts = []
const listeners = new Set()

function notify() {
  for (const fn of listeners) {
    try { fn(toasts.slice()) } catch {}
  }
}

/** Subscribe to the toast list. Returns unsubscribe fn. */
export function onToastChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot of currently-visible toasts. */
export function getToasts() {
  return toasts.slice()
}

/**
 * Push a toast. Returns the toast id so callers can dismiss early
 * via dismissToast(id) if needed (rare).
 *
 * @param {object} opts
 * @param {string} opts.message     — the body text
 * @param {'info'|'error'|'success'} [opts.kind] — visual variant
 * @param {number} [opts.durationMs] — auto-dismiss delay
 */
export function pushToast({ message, kind = 'info', durationMs = DEFAULT_DURATION_MS }) {
  const id = ++nextId
  const toast = { id, message: String(message || ''), kind }
  toasts.push(toast)
  notify()
  if (durationMs > 0) {
    setTimeout(() => dismissToast(id), durationMs)
  }
  return id
}

export function dismissToast(id) {
  const idx = toasts.findIndex(t => t.id === id)
  if (idx === -1) return
  toasts.splice(idx, 1)
  notify()
}
