/**
 * Tiny pub/sub used to ask the IdentityWidget to open its dropdown
 * from outside the component. Today the only caller is the boost
 * progress banner — clicking it pops the dropdown open so the user
 * can watch the per-leg status.
 *
 * If no IdentityWidget is mounted (e.g. user is logged out and the
 * trigger button isn't rendered), the request fires harmlessly into
 * an empty listener set.
 */

const listeners = new Set()

export function requestIdentityOpen() {
  for (const fn of listeners) {
    try { fn() } catch {}
  }
}

export function onIdentityOpenRequest(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
