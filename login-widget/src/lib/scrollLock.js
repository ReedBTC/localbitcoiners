/**
 * Mobile-safe scroll lock for full-screen modals.
 *
 * `document.body.style.overflow = 'hidden'` works on desktop but iOS
 * Safari (and parts of Android Chrome) ignore it once the soft keyboard
 * is open — typing in a field inside a modal makes the page behind
 * scroll up/down on every keystroke as the visual viewport changes.
 *
 * The reliable fix is to take the body out of the document flow:
 *   body.position = 'fixed'
 *   body.top      = '-<scrollY>px'
 *   body.width    = '100%'
 *
 * This pins the visible page exactly where it was when the modal
 * opened. On unlock, restore the previous styles and scroll the
 * window back to the saved position.
 *
 * Idempotent ref-counting: nested modals (login on top of boost)
 * share a single lock — the count only releases when the last modal
 * unmounts, so closing an inner modal doesn't accidentally unfreeze
 * the page underneath the outer modal.
 */

let lockCount = 0
let saved = null

export function lockBodyScroll() {
  lockCount += 1
  if (lockCount > 1) return
  const body = document.body
  saved = {
    position: body.style.position,
    top: body.style.top,
    width: body.style.width,
    overflow: body.style.overflow,
    scrollY: window.scrollY,
  }
  body.style.position = 'fixed'
  body.style.top = `-${saved.scrollY}px`
  body.style.width = '100%'
  body.style.overflow = 'hidden'
}

export function unlockBodyScroll() {
  if (lockCount <= 0) return
  lockCount -= 1
  if (lockCount > 0) return
  if (!saved) return
  const body = document.body
  body.style.position = saved.position
  body.style.top = saved.top
  body.style.width = saved.width
  body.style.overflow = saved.overflow
  // Restore scroll synchronously so the page doesn't blink to top
  // before snapping back. window.scrollTo is reliable on every browser
  // we care about; behavior:'instant' avoids the smooth-scroll easing
  // some browsers default to.
  window.scrollTo({ top: saved.scrollY, left: 0, behavior: 'instant' })
  saved = null
}
