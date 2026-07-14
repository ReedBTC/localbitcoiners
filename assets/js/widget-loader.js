/* Shared lazy-loader for the login-widget bundle.
 *
 * The bundle is ~1MB and every page loads it on demand, but several
 * independent triggers can want it at once — on /feeds alone the nav
 * Boost button, a Podcast Boosts boost, an Articles action, and the
 * nav's bug-report item can each be the first to ask. Each trigger used
 * to own a private loader whose only guard was `window.LBLogin`, which
 * is undefined for the whole download. Two triggers in that window (a
 * podcast boost that first awaits /api/value, then a nav Boost click)
 * therefore appended a second <script> for a bundle already in flight.
 *
 * Measured, that costs one extra full parse+execute of the 1MB bundle —
 * not a second download: the HTTP cache serves the duplicate tag
 * (transferSize 0, one resource-timing entry), so the wasted work is CPU,
 * on exactly the click where the user is already waiting. The bundle's own
 * `!window.LBLogin` guard keeps the second execution from double-mounting,
 * so this was never a correctness bug — just a slow one.
 *
 * One promise on `window.__lbWidgetLoad`, shared by every caller
 * (including nav.js and the inline loaders in the page <head>, which
 * can't import a module and so reuse the same global by convention).
 * Resolves once window.LBLogin exists.
 */

const SRC = '/assets/widgets/login-widget.js'
const LOAD_TIMEOUT_MS = 15000

export function ensureLoginWidget() {
  if (window.LBLogin) return Promise.resolve()
  if (window.__lbWidgetLoad) return window.__lbWidgetLoad

  window.__lbWidgetLoad = new Promise((resolve, reject) => {
    // Another loader (or an inline one that ran before this module was
    // even fetched) may already have a tag in flight. Wait on it rather
    // than injecting a second <script> for it.
    const existing = document.querySelector('script[src*="login-widget.js"]')
    if (existing) {
      const started = Date.now()
      const iv = setInterval(() => {
        if (window.LBLogin) { clearInterval(iv); resolve(); return }
        if (Date.now() - started > LOAD_TIMEOUT_MS) {
          clearInterval(iv)
          window.__lbWidgetLoad = null
          reject(new Error('login widget load timed out'))
        }
      }, 60)
      return
    }

    const s = document.createElement('script')
    s.src = SRC
    s.async = true
    // The bundle sets window.LBLogin synchronously on evaluation; one
    // microtask after onload is enough for it to be visible.
    s.onload = () => { Promise.resolve().then(resolve) }
    s.onerror = () => {
      window.__lbWidgetLoad = null
      reject(new Error('login widget failed to load'))
    }
    document.head.appendChild(s)
  })

  return window.__lbWidgetLoad
}
